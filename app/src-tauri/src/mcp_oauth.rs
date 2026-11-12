//! Logging in to HTTP MCP servers that want OAuth (what `/mcp` → Authenticate does in the CLI).
//!
//! The MCP authorization flow (<https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization>):
//! the server answers 401, naming its protected-resource metadata; that names the authorization
//! server; its metadata gives the endpoints; yaah registers itself there (RFC 7591), sends the user
//! to the browser with a PKCE challenge, catches the redirect on a loopback port, and trades the
//! code for tokens. The tokens live in `~/.config/yaah/mcp-oauth.json` (0600), next to `mcp.json`,
//! never in it, and never reach the interface. A saved HTTP server without its own `Authorization`
//! header is given its token when agents start ([`bearer`], used by `Server::acp`); a background
//! task refreshes tokens before they run out ([`keep_fresh`]).

use crate::json_file::JsonFile;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::sync::OnceLock;
use std::time::Duration;

/// How long the browser has to come back.
const LOGIN_WINDOW: Duration = Duration::from_secs(180);
/// A token this close to its end is refreshed.
const REFRESH_MARGIN: u64 = 120;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Tokens {
    pub access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// Unix seconds; 0 when the server didn't say.
    #[serde(default)]
    pub expires_at: u64,
    pub client_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
    pub token_endpoint: String,
    /// The server's URL when it was logged in: a server moved to another URL needs a new login.
    pub resource: String,
}

type File = BTreeMap<String, Tokens>;

static STORE: OnceLock<JsonFile> = OnceLock::new();

fn store() -> &'static JsonFile {
    // Tests never touch the real file.
    #[cfg(test)]
    let path = std::env::temp_dir().join(format!("yaah-mcp-oauth-{}.json", std::process::id()));
    #[cfg(not(test))]
    let path = crate::accounts::home().join(".config/yaah/mcp-oauth.json");
    STORE.get_or_init(|| JsonFile::new(path, true))
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// Whether `name` (at `url`) has a login on file.
pub fn logged_in(name: &str, url: &str) -> bool {
    store().read::<File>().get(name).is_some_and(|t| t.resource == url)
}

/// The access token to send to server `name` at `url`, while it is still good.
pub fn bearer(name: &str, url: &str) -> Option<String> {
    let t = store().read::<File>().remove(name)?;
    (t.resource == url && (t.expires_at == 0 || t.expires_at > now())).then_some(t.access_token)
}

/// Forget the login of `name`.
pub fn logout(name: &str) -> Result<(), String> {
    store().update(|f: &mut File| {
        f.remove(name);
        Ok(())
    })
}

fn save(name: &str, tokens: Tokens) -> Result<(), String> {
    store().update(|f: &mut File| {
        f.insert(name.to_owned(), tokens);
        Ok(())
    })
}

/// What a server's login needs, found by asking it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoints {
    pub authorization: String,
    pub token: String,
    pub registration: Option<String>,
    pub scopes: Option<String>,
}

fn client() -> &'static reqwest::Client {
    crate::integrations::http()
}

fn origin(url: &str) -> Result<String, String> {
    let u = reqwest::Url::parse(url).map_err(|e| format!("`{url}` isn't a URL: {e}"))?;
    let host = u.host_str().ok_or("the URL has no host")?;
    Ok(match u.port() {
        Some(p) => format!("{}://{host}:{p}", u.scheme()),
        None => format!("{}://{host}", u.scheme()),
    })
}

async fn get_json(url: &str) -> Option<Value> {
    let resp = client().get(url).header("MCP-Protocol-Version", "2025-06-18").send().await.ok()?;
    resp.status().is_success().then_some(())?;
    resp.json().await.ok()
}

/// `resource_metadata="…"` from a `WWW-Authenticate` header.
fn resource_metadata_url(header: &str) -> Option<String> {
    let rest = header.split("resource_metadata=").nth(1)?;
    let rest = rest.trim_start();
    Some(match rest.strip_prefix('"') {
        Some(q) => q.split('"').next()?.to_owned(),
        None => rest.split([',', ' ']).next()?.to_owned(),
    })
}

/// What [`discover`] says when the server answered without asking for a login.
pub const NO_LOGIN_WANTED: &str = "the server didn't ask for a login";

/// Ask the server what it wants: its authorization server, and that server's endpoints.
pub async fn discover(url: &str) -> Result<Endpoints, String> {
    let host = origin(url)?;
    // An unauthenticated request: a server that wants OAuth answers 401 and says where its metadata is.
    let probe = client()
        .post(url)
        .header(reqwest::header::ACCEPT, "application/json, text/event-stream")
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "yaah", "version": env!("CARGO_PKG_VERSION") } } }))
        .send()
        .await
        .map_err(|e| format!("couldn't reach the server: {e}"))?;
    if probe.status().is_success() {
        return Err(NO_LOGIN_WANTED.into());
    }
    let from_header = probe.headers().get(reqwest::header::WWW_AUTHENTICATE).and_then(|v| v.to_str().ok()).and_then(resource_metadata_url);
    let path = reqwest::Url::parse(url).map(|u| u.path().trim_end_matches('/').to_owned()).unwrap_or_default();
    let mut candidates = from_header.into_iter().collect::<Vec<_>>();
    candidates.push(format!("{host}/.well-known/oauth-protected-resource{path}"));
    candidates.push(format!("{host}/.well-known/oauth-protected-resource"));
    let mut issuer = host.clone();
    for c in candidates {
        if let Some(meta) = get_json(&c).await {
            if let Some(a) = meta["authorization_servers"][0].as_str() {
                a.trim_end_matches('/').clone_into(&mut issuer);
            }
            break;
        }
    }
    let meta = {
        let mut found = None;
        for suffix in ["oauth-authorization-server", "openid-configuration"] {
            if let Some(m) = get_json(&format!("{}/.well-known/{suffix}", origin(&issuer)?)).await {
                found = Some(m);
                break;
            }
        }
        found.ok_or_else(|| format!("{issuer} doesn't describe its login endpoints (no OAuth metadata)"))?
    };
    let get = |k: &str| meta[k].as_str().map(str::to_owned);
    Ok(Endpoints {
        authorization: get("authorization_endpoint").ok_or("the authorization server has no authorization endpoint")?,
        token: get("token_endpoint").ok_or("the authorization server has no token endpoint")?,
        registration: get("registration_endpoint"),
        scopes: meta["scopes_supported"]
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" "))
            .filter(|s| !s.is_empty()),
    })
}

/// Register yaah as a client of the authorization server (RFC 7591); a public client using PKCE.
async fn register(endpoint: &str, redirect: &str) -> Result<(String, Option<String>), String> {
    let resp = client()
        .post(endpoint)
        .json(&json!({
            "client_name": "yaah",
            "redirect_uris": [redirect],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
        }))
        .send()
        .await
        .map_err(|e| format!("couldn't register with the authorization server: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("the authorization server refused yaah's registration (HTTP {})", resp.status()));
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    let id = v["client_id"].as_str().ok_or("the registration came back without a client id")?.to_owned();
    Ok((id, v["client_secret"].as_str().map(str::to_owned)))
}

fn pkce() -> (String, String) {
    let verifier = URL_SAFE_NO_PAD.encode(crate::random::bytes(32));
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

fn authorization_url(e: &Endpoints, client_id: &str, redirect: &str, challenge: &str, state: &str, resource: &str) -> Result<String, String> {
    let mut u = reqwest::Url::parse(&e.authorization).map_err(|_| "the authorization endpoint isn't a URL")?;
    {
        let mut q = u.query_pairs_mut();
        q.append_pair("response_type", "code")
            .append_pair("client_id", client_id)
            .append_pair("redirect_uri", redirect)
            .append_pair("code_challenge", challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", state)
            .append_pair("resource", resource);
        if let Some(s) = &e.scopes {
            q.append_pair("scope", s);
        }
    }
    Ok(u.into())
}

/// Wait for the browser's redirect on `server`; the `code`, checked against `state`.
fn wait_for_code(server: &tiny_http::Server, state: &str) -> Result<String, String> {
    let deadline = std::time::Instant::now() + LOGIN_WINDOW;
    loop {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            return Err("the login wasn't finished in time".into());
        }
        let Some(req) = server.recv_timeout(left).map_err(|e| e.to_string())? else { continue };
        let url = reqwest::Url::parse(&format!("http://127.0.0.1{}", req.url())).map_err(|e| e.to_string())?;
        if url.path() != "/callback" {
            let _ = req.respond(tiny_http::Response::empty(404));
            continue;
        }
        let q: BTreeMap<_, _> = url.query_pairs().into_owned().collect();
        let page = |text: &str| {
            tiny_http::Response::from_string(format!(
                "<!doctype html><meta charset=utf-8><title>yaah</title><body style=\"font:16px system-ui;padding:3em\">{text}"
            ))
            .with_header(tiny_http::Header::from_bytes("Content-Type", "text/html; charset=utf-8").expect("static header"))
        };
        if q.get("state").map(String::as_str) != Some(state) {
            let _ = req.respond(page("This login link doesn't belong to yaah's request. You can close this tab.").with_status_code(400));
            continue;
        }
        if let Some(err) = q.get("error") {
            let _ = req.respond(page("Login refused. You can close this tab and go back to yaah."));
            return Err(format!("the login was refused: {err}{}", q.get("error_description").map(|d| format!(" ({d})")).unwrap_or_default()));
        }
        let Some(code) = q.get("code") else {
            let _ = req.respond(page("No login code came back.").with_status_code(400));
            continue;
        };
        let _ = req.respond(page("Logged in. You can close this tab and go back to yaah."));
        return Ok(code.clone());
    }
}

fn expiry(v: &Value) -> u64 {
    v["expires_in"].as_u64().map_or(0, |s| now() + s)
}

async fn token_request(endpoint: &str, form: &[(&str, &str)]) -> Result<Value, String> {
    let resp = client()
        .post(endpoint)
        .header(reqwest::header::ACCEPT, "application/json")
        .form(form)
        .send()
        .await
        .map_err(|e| format!("couldn't reach the token endpoint: {e}"))?;
    let ok = resp.status().is_success();
    let status = resp.status();
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    if !ok || v["access_token"].as_str().is_none() {
        let why = v["error_description"].as_str().or(v["error"].as_str()).unwrap_or("no access token");
        return Err(format!("the token endpoint refused (HTTP {status}): {why}"));
    }
    Ok(v)
}

/// Log in to server `name` at `url`: `open` shows the user the authorization page (their browser).
/// Resolves when the tokens are stored.
pub async fn login(name: &str, url: &str, open: impl FnOnce(&str) -> Result<(), String>) -> Result<(), String> {
    let endpoints = discover(url).await?;
    let listener = tiny_http::Server::http("127.0.0.1:0").map_err(|e| format!("couldn't listen for the login: {e}"))?;
    let port = listener.server_addr().to_ip().ok_or("the login listener has no port")?.port();
    let redirect = format!("http://127.0.0.1:{port}/callback");
    let registration = endpoints
        .registration
        .as_deref()
        .ok_or("this authorization server doesn't let yaah register itself (no registration endpoint); add an Authorization header instead")?;
    let (client_id, client_secret) = register(registration, &redirect).await?;
    let (verifier, challenge) = pkce();
    let state = crate::random::token();
    open(&authorization_url(&endpoints, &client_id, &redirect, &challenge, &state, url)?)?;
    let wanted = state.clone();
    let code = tokio::task::spawn_blocking(move || wait_for_code(&listener, &wanted)).await.map_err(|e| e.to_string())??;
    let mut form = vec![
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("redirect_uri", redirect.as_str()),
        ("client_id", client_id.as_str()),
        ("code_verifier", verifier.as_str()),
        ("resource", url),
    ];
    if let Some(s) = &client_secret {
        form.push(("client_secret", s));
    }
    let v = token_request(&endpoints.token, &form).await?;
    save(
        name,
        Tokens {
            access_token: v["access_token"].as_str().unwrap_or_default().to_owned(),
            refresh_token: v["refresh_token"].as_str().map(str::to_owned),
            expires_at: expiry(&v),
            client_id,
            client_secret,
            token_endpoint: endpoints.token,
            resource: url.to_owned(),
        },
    )
}

/// Trade the refresh token of `name` for a new access token. `Ok(false)`: nothing to refresh.
pub async fn refresh(name: &str) -> Result<bool, String> {
    let Some(t) = store().read::<File>().remove(name) else { return Ok(false) };
    let Some(refresh_token) = t.refresh_token.clone() else { return Ok(false) };
    let mut form = vec![("grant_type", "refresh_token"), ("refresh_token", refresh_token.as_str()), ("client_id", t.client_id.as_str())];
    if let Some(s) = &t.client_secret {
        form.push(("client_secret", s));
    }
    let v = token_request(&t.token_endpoint, &form).await?;
    save(
        name,
        Tokens {
            access_token: v["access_token"].as_str().unwrap_or_default().to_owned(),
            // A server may keep the same refresh token.
            refresh_token: v["refresh_token"].as_str().map(str::to_owned).or(t.refresh_token),
            expires_at: expiry(&v),
            ..t
        },
    )?;
    Ok(true)
}

/// Refresh every token that is about to run out; the ones that can't be refreshed are logged out by their expiry.
pub async fn refresh_due() {
    let due: Vec<String> =
        store().read::<File>().into_iter().filter(|(_, t)| t.expires_at != 0 && t.expires_at < now() + REFRESH_MARGIN * 5).map(|(n, _)| n).collect();
    for name in due {
        if let Err(e) = refresh(&name).await {
            eprintln!("[mcp-oauth] could not refresh the login of {name}: {e}");
        }
    }
}

/// Keep logins fresh while the app runs.
pub fn keep_fresh() {
    tauri::async_runtime::spawn(async {
        loop {
            refresh_due().await;
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}

#[cfg(test)]
mod tests;
