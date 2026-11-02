//! Services yaah reads for the user: GitHub and Linear.
//!
//! How they connect:
//! - OAuth with public client IDs and **no client secret**: GitHub's Device
//!   Flow (RFC 8628, no redirect) and PKCE (RFC 7636) for Linear, with the
//!   provider calling back on the literal loopback `127.0.0.1:43117` (fixed:
//!   redirect URIs are registered ahead of time).
//! - Tokens in `~/.config/yaah/integrations.json` (0600), stamped with
//!   `expires_at` and refreshed a couple of minutes early. Linear's last 24
//!   hours; without refresh it worked one day and 401'd the next.
//! - A personal API key or an env var (`LINEAR_API_KEY`, `GITHUB_TOKEN`) as the
//!   fallback for people who'd rather not use OAuth.
//! - Public client IDs ship in the app (they aren't secrets);
//!   `YAAH_<SERVICE>_CLIENT_ID` points at another registered OAuth app.
//!
//! GitHub needs no `gh` CLI: its sources call GitHub's API with this token.
//!
//! Agents never see a token: they read through sources (`sources.rs`), which
//! call in here. Tokens never go into errors, logs or what Settings is sent.

use crate::accounts::home;
use crate::json_file::JsonFile;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use reqwest::Url;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const PORT: u16 = 43_117;
const REFRESH_SKEW_SECS: u64 = 120;
const SIGN_IN_WINDOW: Duration = Duration::from_secs(600);
const API_TIMEOUT: Duration = Duration::from_secs(20);
const GITHUB_API: &str = "https://api.github.com";
const LINEAR_API: &str = "https://api.linear.app/graphql";
/// The largest answer read from GitHub or Linear (a diff, a base64 blob).
const MAX_RESPONSE: usize = 64 << 20;
const CANCELLED: &str = "a newer sign-in replaced this one";

#[derive(Clone, Copy, PartialEq, Debug)]
enum Flow {
    Device,
    Pkce,
}

struct Service {
    id: &'static str,
    label: &'static str,
    flow: Flow,
    client_id: &'static str,
    client_id_env: &'static str,
    auth_url: &'static str,
    token_url: &'static str,
    device_code_url: &'static str,
    scopes: &'static str,
    key_env: &'static str,
    key_url: &'static str,
    /// What the service gives agents, for the settings screen.
    about: &'static str,
}

const SERVICES: &[Service] = &[
    Service {
        id: "github",
        label: "GitHub",
        flow: Flow::Device,
        client_id: "Ov23lifrU89AdlZ0GOih",
        client_id_env: "YAAH_GITHUB_CLIENT_ID",
        auth_url: "",
        token_url: "https://github.com/login/oauth/access_token",
        device_code_url: "https://github.com/login/device/code",
        scopes: "repo read:org",
        key_env: "GITHUB_TOKEN",
        key_url: "https://github.com/settings/tokens",
        about: "Pull requests, checks, diffs and reviews (pr-view, pr-list), read through GitHub's API with this connection.",
    },
    Service {
        id: "linear",
        label: "Linear",
        flow: Flow::Pkce,
        client_id: "17a8b9b39ebdd14c9c2e600f1ac51141",
        client_id_env: "YAAH_LINEAR_CLIENT_ID",
        auth_url: "https://linear.app/oauth/authorize",
        token_url: "https://api.linear.app/oauth/token",
        device_code_url: "",
        scopes: "read",
        key_env: "LINEAR_API_KEY",
        key_url: "https://linear.app/settings/api",
        about: "Issues, team boards and cycles (linear-issue, linear-issues, linear-board, linear-cycle). Read-only.",
    },
];

fn service(id: &str) -> Result<&'static Service, String> {
    SERVICES.iter().find(|s| s.id == id).ok_or_else(|| format!("unknown integration `{id}`"))
}

fn client_id(s: &Service) -> String {
    std::env::var(s.client_id_env).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| s.client_id.to_owned())
}

/// Told when a connection changes: `{ service, ok, error? }`.
pub type Notify = Arc<dyn Fn(Value) + Send + Sync>;

// ── HTTP ────────────────────────────────────────────────────────────────────

/// The app's one HTTP client (one connection pool and TLS setup). Requests set
/// their own overall timeout.
pub(crate) fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().connect_timeout(Duration::from_secs(10)).user_agent("yaah").build().unwrap_or_default())
}

/// A response body, refusing one larger than `max` bytes instead of holding it.
pub(crate) async fn read_capped(mut resp: reqwest::Response, max: usize) -> Result<Vec<u8>, String> {
    let too_big = || format!("the answer is larger than {} MB", max >> 20);
    if resp.content_length().is_some_and(|n| n > max as u64) {
        return Err(too_big());
    }
    let mut out = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        if out.len() + chunk.len() > max {
            return Err(too_big());
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

/// A JSON body whatever the status: OAuth endpoints put their errors in it.
async fn json_reply(label: &str, resp: reqwest::Response) -> Result<Value, String> {
    let status = resp.status();
    let body = read_capped(resp, MAX_RESPONSE).await.map_err(|e| format!("{label}: {e}"))?;
    serde_json::from_slice(&body).map_err(|_| format!("{label}: HTTP {status}, and the answer wasn't JSON"))
}

fn oauth_error(r: &Value, fallback: &str) -> String {
    r["error_description"].as_str().or(r["error"].as_str()).unwrap_or(fallback).to_owned()
}

// ── tokens ──────────────────────────────────────────────────────────────────

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

/// Turn `expires_in` (seconds, number or string) into an absolute `expires_at`.
fn stamp(mut t: Value) -> Value {
    let secs = t["expires_in"].as_u64().or_else(|| t["expires_in"].as_str().and_then(|s| s.parse().ok()));
    if let Some(s) = secs.filter(|s| *s > 0) {
        t["expires_at"] = json!(now() + s);
    }
    t
}

fn fresh(t: &Value) -> bool {
    t["expires_at"].as_u64().is_none_or(|at| now() + REFRESH_SKEW_SECS < at)
}

fn refreshable(t: &Value) -> bool {
    t["refresh_token"].as_str().is_some_and(|s| !s.is_empty())
}

fn secure_random(n: usize) -> Vec<u8> {
    crate::random::bytes(n)
}

/// How to authenticate a request to a service.
#[derive(Debug, PartialEq)]
pub enum Auth {
    /// An OAuth access token: `Authorization: Bearer …`.
    Bearer(String),
    /// A personal API key. Linear takes it as the raw header value.
    Key(String),
}

impl Auth {
    fn header(&self, svc: &str) -> String {
        match (self, svc) {
            (Auth::Bearer(t), _) | (Auth::Key(t), "github") => format!("Bearer {t}"),
            (Auth::Key(k), _) => k.clone(),
        }
    }
}

// ── the store, and where requests go ────────────────────────────────────────

struct Integrations {
    store: JsonFile,
    /// Send `https://<host>/…` to `<base>/<host>/…` instead (tests' local server).
    base: Option<String>,
    /// Loopback port for the browser sign-in; fixed in the app because the
    /// provider checks the redirect URI.
    port: u16,
    /// One second of the device flow's polling interval.
    tick: Duration,
    /// Whether `LINEAR_API_KEY` / `GITHUB_TOKEN` count as a connection.
    env_keys: bool,
    /// One refresh at a time: Linear rotates refresh tokens, so two concurrent
    /// reads refreshing at once would spend the same one twice.
    refreshing: tokio::sync::Mutex<()>,
    /// The browser sign-in waiting on the port, by its cancel flag. Starting
    /// another (the user closed the tab and clicked Connect again) cancels it.
    pending: Mutex<Option<Arc<AtomicBool>>>,
}

impl Integrations {
    fn user() -> &'static Self {
        static USER: OnceLock<Integrations> = OnceLock::new();
        USER.get_or_init(|| Self {
            store: JsonFile::new(home().join(".config/yaah/integrations.json"), true),
            base: None,
            port: PORT,
            tick: Duration::from_secs(1),
            env_keys: true,
            refreshing: tokio::sync::Mutex::const_new(()),
            pending: Mutex::new(None),
        })
    }

    fn url(&self, real: &str) -> String {
        match &self.base {
            Some(base) => format!("{base}/{}", real.trim_start_matches("https://")),
            None => real.to_owned(),
        }
    }

    fn token(&self, id: &str) -> Option<Value> {
        self.store.read::<Map<String, Value>>().remove(id)
    }

    fn put(&self, id: &str, token: Value) -> Result<(), String> {
        self.store.update(|all: &mut Map<String, Value>| {
            all.insert(id.to_owned(), token);
            Ok(())
        })
    }

    fn env_key(&self, svc: &Service) -> Option<String> {
        self.env_keys.then(|| std::env::var(svc.key_env).ok()).flatten().filter(|k| !k.is_empty())
    }

    async fn post_form(&self, svc: &Service, url: &str, form: &[(&str, &str)]) -> Result<Value, String> {
        let resp = http()
            .post(self.url(url))
            .timeout(API_TIMEOUT)
            .header("accept", "application/json")
            .form(form)
            .send()
            .await
            .map_err(|e| format!("{}: {e}", svc.label))?;
        json_reply(svc.label, resp).await
    }

    // ── using a connection ──

    /// A credential good to use right now: the stored one (refreshed if it is
    /// about to expire), else the env var. Errors say what the user can do.
    async fn auth(&self, id: &str) -> Result<Auth, String> {
        let svc = service(id)?;
        let stored = self.token(id);
        if let Some(t) = &stored {
            if let Some(k) = t["api_key"].as_str() {
                return Ok(Auth::Key(k.to_owned()));
            }
            if let Some(a) = t["access_token"].as_str() {
                if fresh(t) {
                    return Ok(Auth::Bearer(a.to_owned()));
                }
                if let Some(token) = self.refreshed(svc).await {
                    return Ok(Auth::Bearer(token));
                }
            }
        }
        if let Some(k) = self.env_key(svc) {
            return Ok(Auth::Key(k));
        }
        Err(if stored.is_some() {
            format!("{} needs reconnecting: open Settings → Integrations", svc.label)
        } else {
            format!("{} isn't connected: open Settings → Integrations (or set {})", svc.label, svc.key_env)
        })
    }

    /// The access token after a refresh, unless another call refreshed it while this one waited.
    async fn refreshed(&self, svc: &Service) -> Option<String> {
        let _one_at_a_time = self.refreshing.lock().await;
        let t = self.token(svc.id)?;
        let access = t["access_token"].as_str()?.to_owned();
        if fresh(&t) {
            return Some(access);
        }
        self.refresh(svc, t).await.inspect_err(|e| eprintln!("[integrations] {} refresh failed: {e}", svc.label)).ok()
    }

    /// Trade the refresh token for a new pair and save it.
    async fn refresh(&self, svc: &Service, mut token: Value) -> Result<String, String> {
        let Some(refresh_token) = token["refresh_token"].as_str().filter(|s| !s.is_empty()).map(str::to_owned) else {
            return Err("no refresh token".into());
        };
        let cid = client_id(svc);
        let r =
            self.post_form(svc, svc.token_url, &[("grant_type", "refresh_token"), ("refresh_token", &refresh_token), ("client_id", &cid)]).await?;
        let Some(access) = r["access_token"].as_str().map(str::to_owned) else {
            // A refresh token the provider no longer honours won't work later either:
            // drop it, so Settings asks to reconnect instead of showing "connected".
            if r["error"] == "invalid_grant"
                && let Some(old) = token.as_object_mut()
            {
                old.remove("refresh_token");
                self.put(svc.id, token)?;
            }
            return Err(format!("refresh refused: {}", oauth_error(&r, "no access token")));
        };
        if let (Some(old), Some(fields)) = (token.as_object_mut(), r.as_object()) {
            // The new expiry replaces the old one (or there is none).
            old.remove("expires_at");
            old.extend(fields.clone());
        }
        self.put(svc.id, stamp(token))?;
        Ok(access)
    }

    // ── status ──

    fn status(&self) -> Vec<Value> {
        let stored: Map<String, Value> = self.store.read();
        SERVICES
            .iter()
            .map(|s| {
                let t = stored.get(s.id);
                let (connected, via, needs_reauth) = match t {
                    Some(t) if t["api_key"].is_string() => (true, "key", false),
                    Some(t) => (true, "oauth", !fresh(t) && !refreshable(t)),
                    None if self.env_key(s).is_some() => (true, "env", false),
                    None => (false, "", false),
                };
                let account = t.and_then(|t| t["account"].as_str().map(str::to_owned));
                json!({
                    "id": s.id, "label": s.label, "about": s.about,
                    "flow": if s.flow == Flow::Device { "device" } else { "browser" },
                    "connected": connected, "via": via, "account": account, "needsReauth": needs_reauth,
                    "keyEnv": s.key_env, "keyUrl": s.key_url,
                })
            })
            .collect()
    }

    fn disconnect(&self, id: &str) -> Result<(), String> {
        service(id)?;
        self.store.update(|all: &mut Map<String, Value>| {
            all.remove(id);
            Ok(())
        })
    }

    /// Who the credential belongs to; also proves it works.
    async fn account(&self, svc: &Service, auth: &Auth) -> Result<String, String> {
        if svc.id == "github" {
            let me: Value = serde_json::from_str(&self.github_request(Some(auth), "/user", "application/vnd.github+json").await?)
                .map_err(|_| "GitHub: the answer wasn't JSON".to_owned())?;
            return me["login"].as_str().map(str::to_owned).ok_or_else(|| "GitHub didn't say who this is".into());
        }
        let data = self.graphql(svc, LINEAR_API, auth, "query { viewer { name email } }", json!({})).await?;
        Ok(data["viewer"]["email"].as_str().or(data["viewer"]["name"].as_str()).unwrap_or("connected").to_owned())
    }

    async fn set_key(&self, id: &str, key: &str) -> Result<Value, String> {
        let svc = service(id)?;
        let key = key.trim();
        if key.is_empty() {
            return Err("paste a key".into());
        }
        let who = self.account(svc, &Auth::Key(key.to_owned())).await.map_err(|e| format!("that key didn't work: {e}"))?;
        self.put(id, json!({ "api_key": key, "account": who }))?;
        Ok(json!({ "account": who }))
    }

    // ── connecting ──

    async fn connect(&'static self, id: &str, notify: Notify) -> Result<Value, String> {
        let svc = service(id)?;
        match svc.flow {
            Flow::Device => self.start_device(svc, notify).await,
            Flow::Pkce => self.start_pkce(svc, notify).await,
        }
    }

    fn ticks(&self, n: u64) -> Duration {
        self.tick.saturating_mul(u32::try_from(n).unwrap_or(u32::MAX))
    }

    async fn start_device(&'static self, svc: &'static Service, notify: Notify) -> Result<Value, String> {
        let cid = client_id(svc);
        let r = self.post_form(svc, svc.device_code_url, &[("client_id", cid.as_str()), ("scope", svc.scopes)]).await?;
        let device_code = r["device_code"].as_str().ok_or_else(|| format!("{}: {}", svc.label, oauth_error(&r, "no device code")))?.to_owned();
        let interval = r["interval"].as_u64().unwrap_or(5);
        let deadline = Instant::now() + self.ticks(r["expires_in"].as_u64().unwrap_or(900));
        tauri::async_runtime::spawn(async move {
            let outcome = self.poll_device(svc, &cid, &device_code, interval, deadline).await;
            notify(json!({ "service": svc.id, "ok": outcome.is_ok(), "error": outcome.err() }));
        });
        Ok(json!({
            "flow": "device",
            "userCode": r["user_code"],
            "verificationUri": r["verification_uri"].as_str().unwrap_or("https://github.com/login/device"),
            "expiresIn": r["expires_in"],
        }))
    }

    /// Poll until the user approves the code (RFC 8628 §3.4–3.5), declines it, or it expires.
    async fn poll_device(&self, svc: &Service, cid: &str, device_code: &str, mut interval: u64, deadline: Instant) -> Result<(), String> {
        let form = [("client_id", cid), ("device_code", device_code), ("grant_type", "urn:ietf:params:oauth:grant-type:device_code")];
        loop {
            tokio::time::sleep(self.ticks(interval)).await;
            if Instant::now() >= deadline {
                return Err("the code expired; start again".into());
            }
            // A network blip isn't an answer: keep polling.
            let Ok(t) = self.post_form(svc, svc.token_url, &form).await else { continue };
            if let Some(access) = t["access_token"].as_str().map(str::to_owned) {
                let mut t = stamp(t);
                t["account"] = self.account(svc, &Auth::Bearer(access)).await.map_or(Value::Null, Value::from);
                return self.put(svc.id, t);
            }
            match t["error"].as_str() {
                None | Some("authorization_pending") => {}
                Some("slow_down") => interval += 5,
                Some(e) => return Err(t["error_description"].as_str().unwrap_or(e).to_owned()),
            }
        }
    }

    async fn start_pkce(&'static self, svc: &'static Service, notify: Notify) -> Result<Value, String> {
        let verifier = URL_SAFE_NO_PAD.encode(secure_random(48));
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let state = URL_SAFE_NO_PAD.encode(secure_random(24));
        let cancel = Arc::new(AtomicBool::new(false));
        if let Some(older) = self.pending.lock().unwrap_or_else(PoisonError::into_inner).replace(cancel.clone()) {
            older.store(true, Ordering::SeqCst);
        }
        let server = self.listen().await?;
        let port = server.server_addr().to_ip().map_or(self.port, |a| a.port());
        let redirect = format!("http://127.0.0.1:{port}/oauth/callback/{}", svc.id);
        let url = Url::parse_with_params(
            &self.url(svc.auth_url),
            &[
                ("client_id", client_id(svc).as_str()),
                ("redirect_uri", redirect.as_str()),
                ("response_type", "code"),
                ("state", state.as_str()),
                ("code_challenge", challenge.as_str()),
                ("code_challenge_method", "S256"),
                ("scope", svc.scopes),
            ],
        )
        .map_err(|e| e.to_string())?;
        std::thread::spawn(move || {
            let code = wait_for_callback(&server, svc, &state, &cancel, SIGN_IN_WINDOW);
            drop(server);
            if cancel.load(Ordering::SeqCst) {
                return;
            }
            let outcome = code.and_then(|code| tauri::async_runtime::block_on(self.exchange(svc, &code, &verifier, &redirect)));
            let mut pending = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
            if pending.as_ref().is_some_and(|p| Arc::ptr_eq(p, &cancel)) {
                *pending = None;
            }
            drop(pending);
            notify(json!({ "service": svc.id, "ok": outcome.is_ok(), "error": outcome.err() }));
        });
        Ok(json!({ "flow": "browser", "authUrl": url.as_str() }))
    }

    /// Bind the callback port. A sign-in this one replaced lets go of it within a poll.
    async fn listen(&self) -> Result<tiny_http::Server, String> {
        let mut attempts = 0;
        loop {
            match tiny_http::Server::http(("127.0.0.1", self.port)) {
                Ok(server) => return Ok(server),
                Err(_) if attempts < 30 => {
                    attempts += 1;
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                Err(e) => {
                    return Err(format!(
                        "couldn't listen on 127.0.0.1:{} for the sign-in callback ({e}). Another app is using it: quit that app, or use an API key instead",
                        self.port
                    ));
                }
            }
        }
    }

    async fn exchange(&self, svc: &Service, code: &str, verifier: &str, redirect: &str) -> Result<(), String> {
        let cid = client_id(svc);
        let form = [
            ("client_id", cid.as_str()),
            ("code", code),
            ("redirect_uri", redirect),
            ("grant_type", "authorization_code"),
            ("code_verifier", verifier),
        ];
        let t = self.post_form(svc, svc.token_url, &form).await?;
        let access = t["access_token"].as_str().ok_or_else(|| format!("{} refused the code: {}", svc.label, oauth_error(&t, "?")))?.to_owned();
        let mut t = stamp(t);
        t["account"] = self.account(svc, &Auth::Bearer(access)).await.map_or(Value::Null, Value::from);
        self.put(svc.id, t)
    }

    // ── API calls ──

    /// A GraphQL query; the first GraphQL error wins over the HTTP status.
    async fn graphql(&self, svc: &Service, url: &str, auth: &Auth, query: &str, vars: Value) -> Result<Value, String> {
        let label = svc.label;
        let resp = http()
            .post(self.url(url))
            .timeout(API_TIMEOUT)
            .header("authorization", auth.header(svc.id))
            .json(&json!({ "query": query, "variables": vars }))
            .send()
            .await
            .map_err(|e| format!("{label}: {e}"))?;
        let status = resp.status();
        let body = read_capped(resp, MAX_RESPONSE).await.map_err(|e| format!("{label}: {e}"))?;
        let r: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        if let Some(e) = r["errors"].as_array().and_then(|a| a.first()) {
            return Err(format!("{label}: {}", e["message"].as_str().unwrap_or("error")));
        }
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(format!("{label} refused the credential (HTTP 401): reconnect in Settings → Integrations"));
        }
        if !status.is_success() {
            return Err(format!("{label}: HTTP {status}{}", r["message"].as_str().map(|m| format!(": {m}")).unwrap_or_default()));
        }
        if !r.is_object() {
            return Err(format!("{label}: the answer wasn't JSON"));
        }
        Ok(r["data"].clone())
    }

    /// A GitHub REST GET with `auth`, or unauthenticated (public repos, 60 an hour).
    async fn github_request(&self, auth: Option<&Auth>, path: &str, accept: &str) -> Result<String, String> {
        let mut req = http()
            .get(self.url(&format!("{GITHUB_API}{path}")))
            .timeout(API_TIMEOUT)
            .header("accept", accept)
            .header("x-github-api-version", "2022-11-28");
        if let Some(a) = auth {
            req = req.header("authorization", a.header("github"));
        }
        let resp = req.send().await.map_err(|e| format!("GitHub: {e}"))?;
        let status = resp.status().as_u16();
        let body = read_capped(resp, MAX_RESPONSE).await.map_err(|e| format!("GitHub: {e}"))?;
        let text = String::from_utf8_lossy(&body).into_owned();
        let note = if auth.is_some() {
            ""
        } else {
            " (unauthenticated: public repos only, 60 requests an hour; connect GitHub in Settings → Integrations)"
        };
        match status {
            200..=299 => Ok(text),
            401 => Err("GitHub refused the credential (HTTP 401): reconnect in Settings → Integrations".into()),
            403 | 429 if text.contains("rate limit") => Err(format!("GitHub: rate limit reached{note}")),
            404 => Err(format!("GitHub: not found{note}")),
            _ => Err(format!("GitHub: HTTP {status}: {}{note}", text.chars().take(200).collect::<String>())),
        }
    }

    async fn github_get(&self, path: &str, accept: &str, require_auth: bool) -> Result<String, String> {
        let auth = if require_auth { Some(self.auth("github").await?) } else { self.auth("github").await.ok() };
        self.github_request(auth.as_ref(), path, accept).await
    }

    async fn github_graphql(&self, query: &str, vars: Value) -> Result<Value, String> {
        let auth = self.auth("github").await?;
        self.graphql(service("github")?, &format!("{GITHUB_API}/graphql"), &auth, query, vars).await
    }

    async fn linear(&self, query: &str, vars: Value) -> Result<Value, String> {
        let auth = self.auth("linear").await?;
        self.graphql(service("linear")?, LINEAR_API, &auth, query, vars).await
    }

    async fn linear_source(&self, kind: &str, source: &Value) -> Result<Value, String> {
        match kind {
            "linear.issue" => {
                let id = linear_key(&source["id"], "issue id")?;
                Ok(shape_issue(&self.linear(ISSUE_QUERY, json!({ "id": id })).await?["issue"]))
            }
            "linear.issues" => self.linear_issues(source).await,
            "linear.board" => self.linear_board(source).await,
            "linear.cycle" => {
                let key = linear_key(&source["team"], "team key")?;
                let team = self.linear_team(CYCLE_QUERY, &key).await?;
                if team["activeCycle"].is_null() {
                    return Err(format!("{} has no active cycle", team["name"].as_str().unwrap_or(&key)));
                }
                Ok(shape_cycle(&team, i64::try_from(now() / 86_400).unwrap_or_default()))
            }
            other => Err(format!("unknown Linear source `{other}`")),
        }
    }

    async fn linear_team(&self, query: &str, key: &str) -> Result<Value, String> {
        let team = self.linear(query, json!({ "key": key })).await?["teams"]["nodes"][0].clone();
        if team.is_null() { Err(format!("no Linear team with key `{key}`")) } else { Ok(team) }
    }

    async fn linear_issues(&self, source: &Value) -> Result<Value, String> {
        let mut filter = json!({});
        if !source["team"].is_null() {
            filter["team"] = json!({ "key": { "eq": linear_key(&source["team"], "team key")? } });
        }
        if source["assignee"] == "me" {
            filter["assignee"] = json!({ "isMe": { "eq": true } });
        }
        if source["state"].as_str().unwrap_or("open") == "open" {
            filter["state"] = json!({ "type": { "nin": ["completed", "canceled"] } });
        }
        let first = source["limit"].as_u64().unwrap_or(50).min(250);
        let q = format!(
            "query($filter: IssueFilter, $first: Int) {{ issues(filter: $filter, first: $first, orderBy: updatedAt) {{ nodes {{ {ISSUE_ROW} }} }} }}"
        );
        let data = self.linear(&q, json!({ "filter": filter, "first": first })).await?;
        Ok(Value::Array(data["issues"]["nodes"].as_array().into_iter().flatten().map(issue_row).collect()))
    }

    async fn linear_board(&self, source: &Value) -> Result<Value, String> {
        let key = linear_key(&source["team"], "team key")?;
        let team = self.linear_team(BOARD_TEAM_QUERY, &key).await?;
        // The active cycle's issues when there is one; otherwise everything open.
        let mut filter = json!({ "team": { "key": { "eq": key } }, "state": { "type": { "neq": "canceled" } } });
        if team["activeCycle"].is_null() {
            filter["state"] = json!({ "type": { "nin": ["completed", "canceled"] } });
        } else {
            filter["cycle"] = json!({ "isActive": { "eq": true } });
        }
        let q = format!("query($filter: IssueFilter) {{ issues(filter: $filter, first: 150, orderBy: updatedAt) {{ nodes {{ {ISSUE_ROW} }} }} }}");
        let issues = self.linear(&q, json!({ "filter": filter })).await?;
        Ok(shape_board(&team, &issues["issues"]["nodes"]))
    }
}

// ── the API the rest of the app uses ────────────────────────────────────────

/// A credential for `id` good to use right now.
pub async fn auth(id: &str) -> Result<Auth, String> {
    Integrations::user().auth(id).await
}

/// Every service as the settings screen shows it. Never includes a token.
pub fn status() -> Vec<Value> {
    Integrations::user().status()
}

pub fn disconnect(id: &str) -> Result<(), String> {
    Integrations::user().disconnect(id)
}

/// Save a personal API key after checking it works.
pub async fn set_key(id: &str, key: &str) -> Result<Value, String> {
    Integrations::user().set_key(id, key).await
}

/// Start signing in. Device flow returns the code to show; the browser flow
/// returns the URL to open and listens for the callback. Either way `notify`
/// hears how it ended (a browser sign-in replaced by a newer one says nothing).
pub async fn connect(id: &str, notify: Notify) -> Result<Value, String> {
    Integrations::user().connect(id, notify).await
}

/// A GitHub GraphQL query with the connected account (or `GITHUB_TOKEN`).
pub async fn github_graphql(query: &str, vars: Value) -> Result<Value, String> {
    Integrations::user().github_graphql(query, vars).await
}

/// A GitHub REST GET returning text (`accept` picks JSON, a diff, a bare sha…).
/// Without `require_auth` and without a connection it goes unauthenticated
/// (public repos only, 60 requests an hour) instead of failing.
pub async fn github_get(path: &str, accept: &str, require_auth: bool) -> Result<String, String> {
    Integrations::user().github_get(path, accept, require_auth).await
}

/// A `linear.*` source.
pub async fn linear(kind: &str, source: &Value) -> Result<Value, String> {
    Integrations::user().linear_source(kind, source).await
}

// ── the loopback callback ───────────────────────────────────────────────────

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn page(msg: &str, status: u16) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    let body = format!(
        "<!doctype html><meta charset=utf-8><title>yaah</title><body style=\"font:15px system-ui;margin:4rem auto;max-width:28rem\"><p>{}</p>",
        escape_html(msg)
    );
    let html = tiny_http::Header::from_bytes(&b"content-type"[..], &b"text/html; charset=utf-8"[..]).expect("static header");
    tiny_http::Response::from_string(body).with_status_code(status).with_header(html)
}

/// Serve the loopback callback: check `state`, answer the browser, return the
/// code. A callback with another `state` is answered 400 and the wait goes on:
/// any web page can send the browser here, and it mustn't end the sign-in.
/// Gives up after `window`, or when `cancel` is set.
fn wait_for_callback(server: &tiny_http::Server, svc: &Service, state: &str, cancel: &AtomicBool, window: Duration) -> Result<String, String> {
    let until = Instant::now() + window;
    let callback = format!("/oauth/callback/{}", svc.id);
    while Instant::now() < until {
        if cancel.load(Ordering::SeqCst) {
            return Err(CANCELLED.into());
        }
        let Ok(Some(req)) = server.recv_timeout(Duration::from_millis(200)) else { continue };
        let url = Url::parse(&format!("http://127.0.0.1{}", req.url())).ok().filter(|u| u.path() == callback);
        let Some(url) = url else {
            let _ = req.respond(page("Not found.", 404));
            continue;
        };
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        if q.get("state").map(String::as_str) != Some(state) {
            let _ = req.respond(page("This sign-in link is stale. Start again from yaah.", 400));
            continue;
        }
        if let Some(e) = q.get("error") {
            let _ = req.respond(page(&format!("{} said: {e}. You can close this tab.", svc.label), 200));
            return Err(q.get("error_description").cloned().unwrap_or_else(|| e.clone()));
        }
        let Some(code) = q.get("code") else {
            let _ = req.respond(page("No code came back. Start again from yaah.", 400));
            return Err("no code in the callback".into());
        };
        let _ = req.respond(page(&format!("Connected to {}. You can close this tab and go back to yaah.", svc.label), 200));
        return Ok(code.clone());
    }
    Err(format!("sign-in timed out after {} minutes", window.as_secs() / 60))
}

// ── Linear shapes ───────────────────────────────────────────────────────────

/// `ENG`-style team keys and `ENG-123`-style ids only.
fn linear_key(v: &Value, what: &str) -> Result<String, String> {
    let s = v.as_str().ok_or_else(|| format!("needs `{what}`"))?.trim();
    let ok = !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_".contains(c));
    if ok { Ok(s.to_owned()) } else { Err(format!("`{s}` isn't a Linear {what}")) }
}

const PRIORITY_VARIANT: [&str; 5] = ["outline", "destructive", "default", "secondary", "outline"];

fn priority(issue: &Value) -> (Value, &'static str) {
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss, reason = "Linear priorities are 0–4, clamped first")]
    let p = issue["priority"].as_f64().unwrap_or(0.0).clamp(0.0, 4.0) as usize;
    (issue["priorityLabel"].clone(), PRIORITY_VARIANT[p])
}

fn names(nodes: &Value, field: &str) -> Vec<Value> {
    nodes["nodes"].as_array().into_iter().flatten().map(|n| n[field].clone()).collect()
}

fn done_type(t: &str) -> bool {
    t == "completed" || t == "canceled"
}

fn cycle_name(c: &Value) -> Option<String> {
    c["name"].as_str().map(str::to_owned).or_else(|| c["number"].as_f64().map(|n| format!("Cycle {n}")))
}

const ISSUE_ROW: &str = "identifier title url priority priorityLabel estimate updatedAt state { name type } assignee { name }";

const ISSUE_QUERY: &str = "query($id: String!) { issue(id: $id) { identifier title description url priority priorityLabel estimate dueDate createdAt updatedAt \
    state { name type } assignee { name } creator { name } team { key name } cycle { number name } project { name } \
    labels { nodes { name } } children { nodes { identifier title state { name type } } } \
    attachments { nodes { title url } } comments(first: 30) { nodes { body createdAt user { name } } } } }";

const BOARD_TEAM_QUERY: &str = "query($key: String!) { teams(filter: { key: { eq: $key } }, first: 1) { nodes { key name activeCycle { number name } states { nodes { name type position } } } } }";

const CYCLE_QUERY: &str = "query($key: String!) { teams(filter: { key: { eq: $key } }, first: 1) { nodes { key name activeCycle { \
    number name startsAt endsAt progress scopeHistory completedScopeHistory issueCountHistory completedIssueCountHistory } } } }";

fn issue_row(i: &Value) -> Value {
    let (label, variant) = priority(i);
    json!({
        "id": i["identifier"], "title": i["title"], "url": i["url"],
        "state": i["state"]["name"], "stateType": i["state"]["type"],
        "priority": label, "priorityVariant": variant, "estimate": i["estimate"],
        "assignee": i["assignee"]["name"].as_str().unwrap_or("Unassigned"), "updatedAt": i["updatedAt"],
    })
}

fn shape_issue(i: &Value) -> Value {
    let (label, variant) = priority(i);
    let subs: Vec<Value> = i["children"]["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| json!({ "id": c["identifier"], "title": c["title"], "state": c["state"]["name"], "done": done_type(c["state"]["type"].as_str().unwrap_or("")) }))
        .collect();
    let sub_done = subs.iter().filter(|s| s["done"] == true).count();
    json!({
        "id": i["identifier"], "title": i["title"], "url": i["url"], "description": i["description"],
        "state": i["state"]["name"], "stateType": i["state"]["type"],
        "priority": label, "priorityVariant": variant,
        "estimate": i["estimate"], "due": i["dueDate"], "createdAt": i["createdAt"], "updatedAt": i["updatedAt"],
        "assignee": i["assignee"]["name"].as_str().unwrap_or("Unassigned"), "creator": i["creator"]["name"],
        "team": i["team"]["name"], "teamKey": i["team"]["key"],
        "cycle": cycle_name(&i["cycle"]),
        "project": i["project"]["name"],
        "labels": names(&i["labels"], "name"),
        "subTotal": subs.len(), "subDone": sub_done, "subIssues": subs,
        "links": i["attachments"]["nodes"].as_array().into_iter().flatten().map(|a| json!({ "title": a["title"], "url": a["url"] })).collect::<Vec<_>>(),
        "comments": i["comments"]["nodes"].as_array().into_iter().flatten().map(|c| json!({ "author": c["user"]["name"].as_str().unwrap_or("Linear"), "body": c["body"], "at": c["createdAt"] })).collect::<Vec<_>>(),
    })
}

/// Order of workflow state types across a board.
fn type_rank(t: &str) -> usize {
    ["triage", "backlog", "unstarted", "started", "completed", "canceled"].iter().position(|x| *x == t).unwrap_or(6)
}

fn shape_board(team: &Value, issues: &Value) -> Value {
    let mut states: Vec<&Value> = team["states"]["nodes"].as_array().map(|a| a.iter().collect()).unwrap_or_default();
    states.sort_by(|a, b| {
        type_rank(a["type"].as_str().unwrap_or(""))
            .cmp(&type_rank(b["type"].as_str().unwrap_or("")))
            .then(a["position"].as_f64().unwrap_or(0.0).total_cmp(&b["position"].as_f64().unwrap_or(0.0)))
    });
    let rows: Vec<Value> = issues.as_array().into_iter().flatten().map(issue_row).collect();
    let columns: Vec<Value> = states
        .iter()
        .filter(|s| s["type"] != "canceled")
        .map(|s| {
            let cards: Vec<Value> = rows.iter().filter(|r| r["state"] == s["name"]).cloned().collect();
            json!({ "state": s["name"], "type": s["type"], "count": cards.len(), "issues": cards })
        })
        // Keep the working states even when empty; drop empty triage/backlog/done noise.
        .filter(|c| c["count"].as_u64() > Some(0) || matches!(c["type"].as_str(), Some("unstarted" | "started")))
        .collect();
    json!({
        "team": team["name"], "teamKey": team["key"],
        "cycle": cycle_name(&team["activeCycle"]),
        "columns": columns, "columnCount": columns.len().clamp(1, 6),
    })
}

fn shape_cycle(team: &Value, today: i64) -> Value {
    let c = &team["activeCycle"];
    let nums = |k: &str| c[k].as_array().map(|a| a.iter().filter_map(Value::as_f64).collect::<Vec<_>>()).unwrap_or_default();
    let (scope, done, issues, issues_done) =
        (nums("scopeHistory"), nums("completedScopeHistory"), nums("issueCountHistory"), nums("completedIssueCountHistory"));
    let start = day_number(c["startsAt"].as_str().unwrap_or(""));
    let end = day_number(c["endsAt"].as_str().unwrap_or(""));
    let history: Vec<Value> = scope
        .iter()
        .enumerate()
        .zip(0i64..)
        .map(|((i, s), day)| {
            let day = start.map_or_else(|| format!("day {}", i + 1), |d| short_date(d + day));
            json!({ "day": day, "scope": s, "completed": done.get(i) })
        })
        .collect();
    let last = |v: &[f64]| v.last().copied().unwrap_or(0.0);
    json!({
        "team": team["name"], "number": c["number"],
        "name": cycle_name(c).unwrap_or_else(|| "Cycle".into()),
        "starts": start.map(short_date), "ends": end.map(short_date),
        "daysLeft": end.map(|e| (e - today).max(0)),
        "progressPct": (c["progress"].as_f64().unwrap_or(0.0) * 100.0).round(),
        "scope": last(&scope), "completed": last(&done), "scopeAdded": last(&scope) - scope.first().copied().unwrap_or(0.0),
        "issues": last(&issues), "issuesDone": last(&issues_done),
        "history": history,
    })
}

/// Days since 1970-01-01 for an ISO date's `YYYY-MM-DD` prefix.
fn day_number(iso: &str) -> Option<i64> {
    let (y, rest) = iso.get(..10)?.split_once('-')?;
    let (m, d) = rest.split_once('-')?;
    let (y, m, d): (i64, i64, i64) = (y.parse().ok()?, m.parse().ok()?, d.parse().ok()?);
    // Howard Hinnant's days_from_civil.
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

/// "Nov 3" for a day number.
fn short_date(days: i64) -> String {
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let month = usize::try_from(m - 1).ok().and_then(|i| MONTHS.get(i)).unwrap_or(&"?");
    format!("{month} {d}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::io::Read;
    use std::sync::atomic::AtomicUsize;

    /// One request to the stand-in server.
    struct Req {
        path: String,
        body: String,
        auth: Option<String>,
    }

    impl Req {
        fn form(&self) -> HashMap<String, String> {
            Url::parse(&format!("http://x/?{}", self.body)).unwrap().query_pairs().into_owned().collect()
        }

        fn graphql(&self) -> (String, Value) {
            let v: Value = serde_json::from_str(&self.body).unwrap_or_default();
            (v["query"].as_str().unwrap_or_default().to_owned(), v["variables"].clone())
        }
    }

    /// A local stand-in for GitHub and Linear: `https://<host>/<path>` arrives
    /// as `/<host>/<path>`. Returns the base URL and the bodies it was sent.
    fn mock(handler: impl Fn(&Req) -> (u16, Value) + Send + 'static) -> (String, Arc<Mutex<Vec<String>>>) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://127.0.0.1:{}", server.server_addr().to_ip().unwrap().port());
        let seen = Arc::new(Mutex::new(vec![]));
        let log = seen.clone();
        std::thread::spawn(move || {
            for mut req in server.incoming_requests() {
                let mut body = String::new();
                let _ = req.as_reader().read_to_string(&mut body);
                let auth = req.headers().iter().find(|h| h.field.equiv("authorization")).map(|h| h.value.to_string());
                let r = Req { path: req.url().split('?').next().unwrap_or_default().to_owned(), body, auth };
                log.lock().unwrap().push(format!("{} {}", r.path, r.body));
                let (status, reply) = handler(&r);
                let text = match reply {
                    Value::String(s) => s,
                    v => v.to_string(),
                };
                let _ = req.respond(tiny_http::Response::from_string(text).with_status_code(status));
            }
        });
        (base, seen)
    }

    /// Integrations with their own token file, talking to `base`.
    fn instance(base: &str, port: u16) -> &'static Integrations {
        let dir = std::env::temp_dir().join(format!("yaah-int-{}", crate::session::random_token()));
        Box::leak(Box::new(Integrations {
            store: JsonFile::new(dir.join("integrations.json"), true),
            base: Some(base.to_owned()),
            port,
            tick: Duration::from_millis(5),
            env_keys: false,
            refreshing: tokio::sync::Mutex::const_new(()),
            pending: Mutex::new(None),
        }))
    }

    fn notifier() -> (Notify, tokio::sync::mpsc::UnboundedReceiver<Value>) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        (
            Arc::new(move |v| {
                let _ = tx.send(v);
            }),
            rx,
        )
    }

    async fn outcome(rx: &mut tokio::sync::mpsc::UnboundedReceiver<Value>) -> Value {
        tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.expect("the flow ended").expect("a notification")
    }

    #[tokio::test]
    async fn device_flow_polls_until_approved_and_slows_down_when_told() {
        let polls = Arc::new(Mutex::new(Vec::<Instant>::new()));
        let p = polls.clone();
        let (base, _) = mock(move |r| match r.path.as_str() {
            "/github.com/login/device/code" => {
                assert_eq!(r.form()["scope"], "repo read:org");
                (
                    200,
                    json!({ "device_code": "dc", "user_code": "WDJB-MJHT", "verification_uri": "https://github.com/login/device", "expires_in": 900, "interval": 1 }),
                )
            }
            "/github.com/login/oauth/access_token" => {
                let f = r.form();
                assert_eq!((f["device_code"].as_str(), f["grant_type"].as_str()), ("dc", "urn:ietf:params:oauth:grant-type:device_code"));
                let mut p = p.lock().unwrap();
                p.push(Instant::now());
                match p.len() {
                    1 => (200, json!({ "error": "authorization_pending" })),
                    2 => (200, json!({ "error": "slow_down" })),
                    _ => (200, json!({ "access_token": "gho_new", "token_type": "bearer", "scope": "repo" })),
                }
            }
            "/api.github.com/user" if r.auth.as_deref() == Some("Bearer gho_new") => (200, json!({ "login": "ada" })),
            _ => (404, json!({})),
        });
        let i = instance(&base, 0);
        let (notify, mut rx) = notifier();
        let started = i.connect("github", notify).await.unwrap();
        assert_eq!((started["flow"].as_str(), started["userCode"].as_str()), (Some("device"), Some("WDJB-MJHT")));
        assert_eq!(outcome(&mut rx).await, json!({ "service": "github", "ok": true, "error": null }));

        let polls = polls.lock().unwrap().clone();
        assert_eq!(polls.len(), 3);
        assert!(polls[2] - polls[1] >= i.ticks(6), "slow_down adds 5s to the interval");
        assert_eq!(i.auth("github").await.unwrap(), Auth::Bearer("gho_new".into()));
        let status = i.status();
        assert_eq!((&status[0]["via"], &status[0]["account"], &status[0]["needsReauth"]), (&json!("oauth"), &json!("ada"), &json!(false)));
        assert!(!serde_json::to_string(&status).unwrap().contains("gho_new"), "Settings never sees a token");
    }

    #[tokio::test]
    async fn device_flow_reports_a_declined_or_expired_code() {
        let (base, _) = mock(|r| match r.path.as_str() {
            "/github.com/login/device/code" => (200, json!({ "device_code": "dc", "user_code": "U", "interval": 0, "expires_in": 900 })),
            _ => (200, json!({ "error": "access_denied", "error_description": "The user has denied your application access." })),
        });
        let (notify, mut rx) = notifier();
        instance(&base, 0).connect("github", notify).await.unwrap();
        assert_eq!(outcome(&mut rx).await["error"], "The user has denied your application access.");

        let (base, _) = mock(|r| match r.path.as_str() {
            "/github.com/login/device/code" => (200, json!({ "device_code": "dc", "user_code": "U", "interval": 1, "expires_in": 0 })),
            _ => (200, json!({ "error": "authorization_pending" })),
        });
        let (notify, mut rx) = notifier();
        instance(&base, 0).connect("github", notify).await.unwrap();
        assert_eq!(outcome(&mut rx).await["error"], "the code expired; start again");

        let (base, _) = mock(|_| (200, json!({ "error": "unauthorized_client", "error_description": "Device flow is disabled" })));
        let (notify, _rx) = notifier();
        assert_eq!(instance(&base, 0).connect("github", notify).await.unwrap_err(), "GitHub: Device flow is disabled");
    }

    fn free_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn browser_sign_in_sends_the_verifier_and_a_new_attempt_takes_over_the_port() {
        let challenge = Arc::new(Mutex::new(String::new()));
        let c = challenge.clone();
        let (base, _) = mock(move |r| match r.path.as_str() {
            "/api.linear.app/oauth/token" => {
                let f = r.form();
                let verified = URL_SAFE_NO_PAD.encode(Sha256::digest(f["code_verifier"].as_bytes())) == *c.lock().unwrap();
                if f["grant_type"] == "authorization_code" && f["code"] == "c0de" && verified {
                    (200, json!({ "access_token": "lin_oauth", "refresh_token": "r1", "expires_in": 86399, "token_type": "Bearer" }))
                } else {
                    (400, json!({ "error": "invalid_grant", "error_description": "bad code or verifier" }))
                }
            }
            "/api.linear.app/graphql" if r.auth.as_deref() == Some("Bearer lin_oauth") => {
                (200, json!({ "data": { "viewer": { "name": "Ada", "email": "ada@example.com" } } }))
            }
            _ => (404, json!({})),
        });
        let port = free_port();
        let i = instance(&base, port);
        // The user abandons a first attempt and clicks Connect again: the new one gets the port.
        let (first, mut first_rx) = notifier();
        i.connect("linear", first).await.unwrap();
        let (notify, mut rx) = notifier();
        let started = i.connect("linear", notify).await.unwrap();

        let url = Url::parse(started["authUrl"].as_str().unwrap()).unwrap();
        assert!(url.as_str().starts_with(&format!("{base}/linear.app/oauth/authorize?")), "{url}");
        let q: HashMap<String, String> = url.query_pairs().into_owned().collect();
        assert_eq!((q["code_challenge_method"].as_str(), q["response_type"].as_str(), q["scope"].as_str()), ("S256", "code", "read"));
        assert_eq!(q["redirect_uri"], format!("http://127.0.0.1:{port}/oauth/callback/linear"));
        *challenge.lock().unwrap() = q["code_challenge"].clone();

        let page = http().get(format!("{}?code=c0de&state={}", q["redirect_uri"], q["state"])).send().await.unwrap();
        assert_eq!(page.status(), 200);
        assert!(page.text().await.unwrap().contains("Connected to Linear"));
        assert_eq!(outcome(&mut rx).await, json!({ "service": "linear", "ok": true, "error": null }));
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(first_rx.try_recv().is_err(), "the replaced attempt ends quietly");

        let t = i.token("linear").unwrap();
        assert_eq!((t["refresh_token"].as_str(), t["account"].as_str()), (Some("r1"), Some("ada@example.com")));
        assert!(t["expires_at"].as_u64().unwrap() > now() + 86_000);
        assert_eq!(i.auth("linear").await.unwrap(), Auth::Bearer("lin_oauth".into()));
        assert!(i.pending.lock().unwrap().is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn refreshes_once_before_expiry_and_gives_up_on_a_dead_refresh_token() {
        let refreshes = Arc::new(AtomicUsize::new(0));
        let n = refreshes.clone();
        let (base, _) = mock(move |r| {
            let f = r.form();
            assert_eq!(f["grant_type"], "refresh_token");
            if f["refresh_token"] == "r1" {
                n.fetch_add(1, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(50));
                (200, json!({ "access_token": "new", "refresh_token": "r2", "expires_in": 86399 }))
            } else {
                (400, json!({ "error": "invalid_grant", "error_description": "refresh token expired" }))
            }
        });
        let i = instance(&base, 0);
        i.put("linear", json!({ "access_token": "old", "refresh_token": "r1", "expires_at": now() + 60, "account": "ada" })).unwrap();
        let reads: Vec<_> = (0..8).map(|_| tokio::spawn(i.auth("linear"))).collect();
        for r in reads {
            assert_eq!(r.await.unwrap().unwrap(), Auth::Bearer("new".into()));
        }
        assert_eq!(refreshes.load(Ordering::SeqCst), 1, "concurrent reads share one refresh");
        let t = i.token("linear").unwrap();
        assert_eq!((t["refresh_token"].as_str(), t["account"].as_str()), (Some("r2"), Some("ada")));
        assert!(t["expires_at"].as_u64().unwrap() > now() + 86_000);

        // Without a new expiry, the old one doesn't stick around to force a refresh every call.
        i.put("linear", json!({ "access_token": "old", "refresh_token": "r1", "expires_at": now() + 60 })).unwrap();
        let (base2, _) = mock(|_| (200, json!({ "access_token": "forever" })));
        let j = instance(&base2, 0);
        j.put("linear", json!({ "access_token": "old", "refresh_token": "x", "expires_at": now() + 60 })).unwrap();
        assert_eq!(j.auth("linear").await.unwrap(), Auth::Bearer("forever".into()));
        assert!(fresh(&j.token("linear").unwrap()));

        i.put("linear", json!({ "access_token": "old", "refresh_token": "r-dead", "expires_at": now() + 60 })).unwrap();
        assert!(i.status()[1]["needsReauth"] == false, "still refreshable as far as anyone knows");
        assert_eq!(i.auth("linear").await.unwrap_err(), "Linear needs reconnecting: open Settings → Integrations");
        assert_eq!(i.status()[1]["needsReauth"], true, "a refused refresh token is dropped, so Settings asks to reconnect");
    }

    #[tokio::test]
    async fn api_errors_say_what_went_wrong() {
        let (base, _) = mock(|r| {
            let (q, _) = r.graphql();
            match (r.path.as_str(), r.auth.as_deref()) {
                ("/api.linear.app/graphql", Some("lin_api_bad")) => (401, json!({ "errors": [] })),
                ("/api.linear.app/graphql", _) if q.contains("boom") => (200, json!({ "errors": [{ "message": "Cannot query field \"boom\"" }] })),
                ("/api.linear.app/graphql", _) if q.contains("teapot") => (418, json!("<html>no</html>")),
                ("/api.linear.app/graphql", _) => (200, json!({ "data": { "viewer": { "name": "Ada", "email": null } } })),
                ("/api.github.com/repos/o/private", None) => (404, json!({ "message": "Not Found" })),
                ("/api.github.com/rate", _) => (403, json!({ "message": "API rate limit exceeded for 1.2.3.4" })),
                ("/api.github.com/user", Some("Bearer ghp_ok")) => (200, json!({ "login": "ada" })),
                ("/api.github.com/user", _) => (401, json!({ "message": "Bad credentials" })),
                ("/api.github.com/graphql", _) => (502, json!("bad gateway")),
                ("/api.github.com/repos/o/r/pulls/1", Some("Bearer ghp_ok")) => (200, json!("diff --git a/x b/x")),
                _ => (500, json!("oops")),
            }
        });
        let i = instance(&base, 0);
        assert_eq!(
            i.linear("query { x }", json!({})).await.unwrap_err(),
            "Linear isn't connected: open Settings → Integrations (or set LINEAR_API_KEY)"
        );
        assert_eq!(
            i.set_key("linear", "lin_api_bad").await.unwrap_err(),
            "that key didn't work: Linear refused the credential (HTTP 401): reconnect in Settings → Integrations"
        );
        assert_eq!(i.set_key("linear", "  ").await.unwrap_err(), "paste a key");
        assert_eq!(i.set_key("linear", " lin_api_good ").await.unwrap(), json!({ "account": "Ada" }));
        assert_eq!(i.auth("linear").await.unwrap(), Auth::Key("lin_api_good".into()));
        assert_eq!(i.status()[1]["via"], "key");
        assert_eq!(i.linear("query { boom }", json!({})).await.unwrap_err(), "Linear: Cannot query field \"boom\"");
        assert_eq!(i.linear("query { teapot }", json!({})).await.unwrap_err(), "Linear: HTTP 418 I'm a teapot");

        // GitHub without a connection goes unauthenticated, and says so when it matters.
        let e = i.github_get("/repos/o/private", "application/json", false).await.unwrap_err();
        assert!(e.starts_with("GitHub: not found (unauthenticated: public repos only"), "{e}");
        assert!(i.github_get("/rate", "application/json", false).await.unwrap_err().starts_with("GitHub: rate limit reached"));
        assert!(i.github_get("/repos/o/r/pulls/1", "x", true).await.unwrap_err().starts_with("GitHub isn't connected"));
        assert!(i.set_key("github", "ghp_nope").await.unwrap_err().contains("GitHub refused the credential (HTTP 401)"));
        i.set_key("github", "ghp_ok").await.unwrap();
        assert_eq!(i.github_get("/repos/o/r/pulls/1", "application/vnd.github.diff", true).await.unwrap(), "diff --git a/x b/x");
        assert_eq!(i.github_get("/elsewhere", "x", true).await.unwrap_err(), "GitHub: HTTP 500: oops");
        assert_eq!(i.github_graphql("{ viewer { login } }", json!({})).await.unwrap_err(), "GitHub: HTTP 502 Bad Gateway");

        i.disconnect("linear").unwrap();
        assert!(i.token("linear").is_none() && i.token("github").is_some());
        assert_eq!(i.disconnect("jira").unwrap_err(), "unknown integration `jira`");
        assert_eq!(i.status()[1]["connected"], false);
    }

    fn team() -> Value {
        json!({
            "key": "ENG", "name": "Engineering", "activeCycle": { "number": 18.0, "name": null,
                "startsAt": "2026-10-27T00:00:00Z", "endsAt": "2026-11-07T00:00:00Z", "progress": 0.625,
                "scopeHistory": [21.0, 23.0, 24.0], "completedScopeHistory": [0.0, 5.0, 15.0],
                "issueCountHistory": [10.0, 11.0, 12.0], "completedIssueCountHistory": [0.0, 2.0, 6.0] },
            "states": { "nodes": [
                { "name": "Done", "type": "completed", "position": 0.0 },
                { "name": "In Progress", "type": "started", "position": 1.0 },
                { "name": "In Review", "type": "started", "position": 2.0 },
                { "name": "Todo", "type": "unstarted", "position": 0.0 },
                { "name": "Backlog", "type": "backlog", "position": 0.0 },
                { "name": "Canceled", "type": "canceled", "position": 0.0 } ] }
        })
    }

    fn issues() -> Value {
        json!([
            { "identifier": "ENG-142", "title": "Partial refunds", "priority": 1.0, "priorityLabel": "Urgent", "state": { "name": "In Progress", "type": "started" }, "assignee": { "name": "Grace" } },
            { "identifier": "ENG-131", "title": "Cents", "priority": 3.0, "priorityLabel": "Medium", "state": { "name": "Done", "type": "completed" }, "assignee": null }
        ])
    }

    #[tokio::test]
    async fn linear_sources_read_through_the_api() {
        let (base, seen) = mock(|r| {
            assert_eq!(r.auth.as_deref(), Some("lin_api_k"), "personal keys go bare");
            let (q, vars) = r.graphql();
            if q.contains("teams(") {
                let nodes = if vars["key"] == "ENG" { json!([team()]) } else { json!([]) };
                (200, json!({ "data": { "teams": { "nodes": nodes } } }))
            } else if q.contains("issues(") {
                (200, json!({ "data": { "issues": { "nodes": issues() } } }))
            } else {
                (
                    200,
                    json!({ "data": { "issue": { "identifier": vars["id"], "title": "Partial refunds", "priority": 2.0, "children": { "nodes": [] } } } }),
                )
            }
        });
        let i = instance(&base, 0);
        i.put("linear", json!({ "api_key": "lin_api_k" })).unwrap();

        let board = i.linear_source("linear.board", &json!({ "team": "ENG" })).await.unwrap();
        assert_eq!(board["columns"].as_array().unwrap().len(), 4);
        assert!(seen.lock().unwrap().last().unwrap().contains(r#""cycle":{"isActive":{"eq":true}}"#), "the active cycle's issues");

        let list = i.linear_source("linear.issues", &json!({ "team": "ENG", "assignee": "me", "limit": 999 })).await.unwrap();
        assert_eq!(list[0]["id"], "ENG-142");
        let sent = seen.lock().unwrap().last().unwrap().clone();
        assert!(
            sent.contains(r#""first":250"#) && sent.contains(r#""isMe":{"eq":true}"#) && sent.contains(r#""nin":["completed","canceled"]"#),
            "{sent}"
        );

        let issue = i.linear_source("linear.issue", &json!({ "id": "ENG-142" })).await.unwrap();
        assert_eq!(
            (issue["id"].as_str(), issue["priorityVariant"].as_str(), issue["subTotal"].as_u64()),
            (Some("ENG-142"), Some("default"), Some(0))
        );

        let cycle = i.linear_source("linear.cycle", &json!({ "team": "ENG" })).await.unwrap();
        assert_eq!(cycle["name"], "Cycle 18");

        let asked = seen.lock().unwrap().len();
        assert_eq!(i.linear_source("linear.board", &json!({ "team": "NOPE" })).await.unwrap_err(), "no Linear team with key `NOPE`");
        assert_eq!(i.linear_source("linear.issue", &json!({ "id": "../x" })).await.unwrap_err(), "`../x` isn't a Linear issue id");
        assert_eq!(i.linear_source("linear.cycle", &json!({})).await.unwrap_err(), "needs `team key`");
        assert_eq!(i.linear_source("linear.nope", &json!({})).await.unwrap_err(), "unknown Linear source `linear.nope`");
        assert_eq!(seen.lock().unwrap().len(), asked + 1, "bad input never reaches Linear");
    }

    /// The browser comes back to yaah's loopback server: other paths are ignored,
    /// a stale `state` is refused, and the right one hands over the code.
    #[test]
    fn the_sign_in_callback_checks_state() {
        let serve = |state: &'static str| {
            let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
            let port = server.server_addr().to_ip().unwrap().port();
            let done = std::thread::spawn(move || {
                wait_for_callback(&server, service("linear").unwrap(), state, &AtomicBool::new(false), Duration::from_secs(10))
            });
            (done, port)
        };
        let get = |port: u16, path: &str| {
            use std::io::Write;
            let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            write!(s, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").unwrap();
            let mut out = String::new();
            let _ = s.read_to_string(&mut out);
            out
        };
        let (done, port) = serve("s3cret");
        assert!(get(port, "/favicon.ico").starts_with("HTTP/1.1 404"));
        assert!(get(port, "/oauth/callback/linear?code=abc&state=s3cret").starts_with("HTTP/1.1 200"));
        assert_eq!(done.join().unwrap(), Ok("abc".to_owned()));

        // A wrong (or missing) state, from any page that sends the browser here, is refused
        // without ending the sign-in: the right callback still gets through.
        let (done, port) = serve("s3cret");
        assert!(get(port, "/oauth/callback/linear?code=abc&state=forged").starts_with("HTTP/1.1 400"));
        assert!(get(port, "/oauth/callback/linear?error=access_denied").starts_with("HTTP/1.1 400"));
        assert!(get(port, "/oauth/callback/linear?code=evil").starts_with("HTTP/1.1 400"));
        assert!(!done.is_finished(), "still waiting");
        assert!(get(port, "/oauth/callback/linear?code=right&state=s3cret").starts_with("HTTP/1.1 200"));
        assert_eq!(done.join().unwrap(), Ok("right".to_owned()));

        let (done, port) = serve("s3cret");
        let page = get(port, "/oauth/callback/linear?error=%3Cscript%3Ex%3C/script%3E&state=s3cret");
        assert!(page.contains("&lt;script&gt;") && !page.contains("<script>"), "what comes back is escaped: {page}");
        assert_eq!(done.join().unwrap(), Err("<script>x</script>".to_owned()));

        let (done, port) = serve("s3cret");
        assert!(get(port, "/oauth/callback/linear?state=s3cret").starts_with("HTTP/1.1 400"));
        assert_eq!(done.join().unwrap(), Err("no code in the callback".to_owned()));

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let linear = service("linear").unwrap();
        let err = wait_for_callback(&server, linear, "s", &AtomicBool::new(false), Duration::from_millis(50)).unwrap_err();
        assert_eq!(err, "sign-in timed out after 0 minutes");
        assert_eq!(wait_for_callback(&server, linear, "s", &AtomicBool::new(true), Duration::from_secs(5)).unwrap_err(), CANCELLED);
    }

    #[test]
    fn dates_round_trip() {
        let d = day_number("2026-10-27T00:00:00.000Z").unwrap();
        assert_eq!(short_date(d), "Oct 27");
        assert_eq!(short_date(d + 5), "Nov 1");
        assert_eq!(short_date(day_number("2024-02-28").unwrap() + 1), "Feb 29");
        assert_eq!(day_number("1970-01-01"), Some(0));
        assert_eq!(day_number("soon"), None);
    }

    #[test]
    fn tokens_expire_and_refresh_early() {
        let t = stamp(json!({ "access_token": "a", "expires_in": 86399, "refresh_token": "r" }));
        assert!(fresh(&t) && refreshable(&t));
        let soon = json!({ "access_token": "a", "expires_at": now() + 60 });
        assert!(!fresh(&soon), "refreshed a couple of minutes before it expires");
        assert!(fresh(&json!({ "access_token": "github tokens carry no expiry" })));
        assert_eq!(stamp(json!({ "expires_in": "3600" }))["expires_at"].as_u64().unwrap() / 10, (now() + 3600) / 10);
    }

    #[test]
    fn auth_headers() {
        assert_eq!(Auth::Bearer("t".into()).header("linear"), "Bearer t");
        assert_eq!(Auth::Key("lin_api_x".into()).header("linear"), "lin_api_x", "Linear takes personal keys bare");
        assert_eq!(Auth::Key("ghp_x".into()).header("github"), "Bearer ghp_x");
    }

    #[test]
    fn refuses_odd_linear_keys() {
        assert_eq!(linear_key(&json!("ENG-142"), "issue id").unwrap(), "ENG-142");
        for bad in ["", "ENG 1", "a\"}", "../x"] {
            assert!(linear_key(&json!(bad), "issue id").is_err(), "{bad}");
        }
    }

    #[test]
    fn pkce_challenge_is_s256_of_the_verifier() {
        // RFC 7636 appendix B.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
        assert_eq!(URL_SAFE_NO_PAD.encode(secure_random(48)).len(), 64);
    }

    #[test]
    fn shapes_board_and_cycle() {
        let b = shape_board(&team(), &issues());
        let cols: Vec<&str> = b["columns"].as_array().unwrap().iter().map(|c| c["state"].as_str().unwrap()).collect();
        assert_eq!(cols, ["Todo", "In Progress", "In Review", "Done"], "by type then position; empty backlog dropped; working states kept");
        assert_eq!(b["columns"][1]["issues"][0]["priorityVariant"], "destructive");
        assert_eq!(b["columns"][3]["issues"][0]["assignee"], "Unassigned");
        assert_eq!(b["cycle"], "Cycle 18");

        let c = shape_cycle(&team(), day_number("2026-11-03").unwrap());
        assert_eq!(c["name"], "Cycle 18");
        assert_eq!(c["daysLeft"], 4);
        assert_eq!(c["progressPct"], 63.0);
        assert_eq!(c["scopeAdded"], 3.0);
        assert_eq!(c["history"][2], json!({ "day": "Oct 29", "scope": 24.0, "completed": 15.0 }));
    }

    #[test]
    fn shapes_an_issue() {
        let i = json!({
            "identifier": "ENG-142", "title": "Partial refunds", "priority": 2.0, "priorityLabel": "High",
            "state": { "name": "In Progress", "type": "started" }, "assignee": { "name": "Grace" }, "team": { "key": "ENG", "name": "Engineering" },
            "cycle": { "number": 18.0, "name": null }, "labels": { "nodes": [{ "name": "bug" }] },
            "children": { "nodes": [{ "identifier": "ENG-143", "title": "a", "state": { "name": "Done", "type": "completed" } }, { "identifier": "ENG-144", "title": "b", "state": { "name": "Todo", "type": "unstarted" } }] },
            "attachments": { "nodes": [{ "title": "PR #48", "url": "https://github.com/x/y/pull/48" }] },
            "comments": { "nodes": [{ "body": "on it", "createdAt": "t", "user": null }] }
        });
        let v = shape_issue(&i);
        assert_eq!((v["subDone"].as_u64(), v["subTotal"].as_u64()), (Some(1), Some(2)));
        assert_eq!(v["cycle"], "Cycle 18");
        assert_eq!(v["priorityVariant"], "default");
        assert_eq!(v["labels"], json!(["bug"]));
        assert_eq!(v["comments"][0]["author"], "Linear");
        assert_eq!(priority(&json!({ "priority": 99.0 })).1, "outline", "out-of-range priorities don't panic");
    }
}
