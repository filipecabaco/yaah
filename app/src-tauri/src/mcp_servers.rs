//! The user's own MCP servers, handed to every agent yaah starts.
//!
//! Stored in `~/.config/yaah/mcp.json` (mode 0600: env and headers may hold
//! secrets). `session.rs` appends the enabled ones to ACP `session/new` and
//! `session/load` `mcpServers`, after yaah's own `yaah-ui` server, in the ACP
//! `McpServer` shape (<https://agentclientprotocol.com/protocol/schema#mcpserver>,
//! <https://agentclientprotocol.com/protocol/session-setup#mcp-servers>):
//!
//! - stdio: `{ name, command, args, env: [{ name, value }] }`, no `type`.
//!   `command` must be an absolute path. Every ACP agent supports it.
//! - http / sse: `{ type: "http" | "sse", name, url, headers: [{ name, value }] }`,
//!   only for agents whose `initialize` advertised `mcpCapabilities.http` / `.sse`.
//!
//! Also here: a minimal MCP client behind "Test" (initialize, then tools/list)
//! and import from Claude Code, Claude Desktop and Cursor configs. Secret values
//! (env, headers) are never logged, and never sent to the interface: Settings
//! gets them masked (`••••1234`, see [`mask`]) and sends a masked value back
//! unchanged when it wasn't edited, which keeps the stored one ([`Store::unmask`]).

use crate::json_file::JsonFile;
use crate::{accounts, agents};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

/// yaah's own server; no user server may take its name.
pub const BUILTIN: &str = crate::ui_mcp::SERVER_NAME;
/// The MCP revision the test client asks for; servers answer with what they speak.
const MCP_VERSION: &str = "2025-06-18";
pub const TEST_TIMEOUT: Duration = Duration::from_secs(20);

// ── Servers ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Transport {
    #[default]
    Stdio,
    /// Streamable HTTP.
    Http,
    /// Legacy HTTP+SSE (deprecated by MCP, still in ACP).
    Sse,
}

impl Transport {
    fn as_str(self) -> &'static str {
        match self {
            Transport::Stdio => "stdio",
            Transport::Http => "http",
            Transport::Sse => "sse",
        }
    }
}

fn yes() -> bool {
    true
}

// ── Secrets ─────────────────────────────────────────────────────────────────

/// How a hidden value starts. The interface shows it as is and sends it back unchanged when not edited.
pub const MASK: &str = "••••";

/// A secret as the interface sees it: `••••` and, for a long one, its last 4
/// characters (enough to tell two keys apart, too few to matter).
pub fn mask(value: &str) -> String {
    let n = value.chars().count();
    if n >= 12 { format!("{MASK}{}", value.chars().skip(n - 4).collect::<String>()) } else { MASK.to_owned() }
}

/// Headers whose values aren't credentials, shown as they are. Every other header is masked.
const PLAIN_HEADERS: &[&str] = &["accept", "accept-language", "content-type", "user-agent", "mcp-protocol-version", "x-request-id"];

/// Whether an env var's value is masked: by its name (`*_KEY`, `*TOKEN*`, a
/// password…), or because the value looks like a credential (a long token, a
/// URL with a password in it).
pub fn secret_env(name: &str, value: &str) -> bool {
    const WORDS: &[&str] = &[
        "KEY",
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "PASSWD",
        "PASS",
        "PWD",
        "AUTH",
        "CREDENTIAL",
        "CREDENTIALS",
        "COOKIE",
        "SESSION",
        "PRIVATE",
        "BEARER",
        "DSN",
    ];
    let upper = name.to_ascii_uppercase();
    // `GITHUB_TOKEN`, `APIKEY`, `DB-PASSWORD`, `X_AUTH`: a part that is, or ends in, one of the words.
    let by_name = upper.split(['_', '-']).any(|part| WORDS.iter().any(|w| part.ends_with(w)));
    let url_with_password =
        value.split_once("://").is_some_and(|(_, rest)| rest.split('/').next().is_some_and(|auth| auth.contains(':') && auth.contains('@')));
    // A long run of letters and digits with no spaces, no path and no URL: shaped like a key.
    let tokenish = value.len() >= 20
        && !value.contains("://")
        && !value.starts_with(['/', '~', '.', '@'])
        && !value.contains(char::is_whitespace)
        && value.chars().any(|c| c.is_ascii_digit())
        && value.chars().any(|c| c.is_ascii_alphabetic());
    by_name || url_with_password || tokenish
}

pub fn secret_header(name: &str) -> bool {
    !PLAIN_HEADERS.contains(&name.to_ascii_lowercase().as_str())
}

/// `server` as the interface may see it: secret env and header values masked.
/// Returns the masked keys.
fn masked(server: &mut Server) -> (Vec<String>, Vec<String>) {
    let mut env_keys = vec![];
    for (k, v) in &mut server.env {
        if secret_env(k, v) {
            *v = mask(v);
            env_keys.push(k.clone());
        }
    }
    let mut header_keys = vec![];
    for (k, v) in &mut server.headers {
        if secret_header(k) {
            *v = mask(v);
            header_keys.push(k.clone());
        }
    }
    (env_keys, header_keys)
}

/// Put back the stored values the interface sent masked and unchanged. A
/// masked value with nothing stored behind it (a renamed key, say) is refused.
fn unmask_values(sent: &mut BTreeMap<String, String>, stored: Option<&BTreeMap<String, String>>, what: &str) -> Result<(), String> {
    for (k, v) in sent.iter_mut() {
        if !v.starts_with(MASK) {
            continue;
        }
        match stored.and_then(|s| s.get(k.trim())).filter(|old| mask(old) == *v) {
            Some(old) => old.clone_into(v),
            None => return Err(format!("the {what} `{}` was hidden; type its value again", k.trim())),
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    /// kebab-case, unique, never `yaah-ui`. Agents prefix its tools with it.
    pub name: String,
    pub transport: Transport,
    /// stdio: the executable, as typed (resolved to an absolute path when sent).
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// http / sse.
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Agent profiles that get it; empty means every agent. Per-agent servers carry that
    /// agent's own credentials (e.g. claude-work vs claude-personal).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<String>,
}

impl Server {
    /// Whether the agent profile `id` gets this server.
    pub fn for_profile(&self, id: &str) -> bool {
        self.agents.is_empty() || self.agents.iter().any(|a| a == id)
    }

    pub fn command_line(&self) -> String {
        if self.command.is_empty() { String::new() } else { agents::join_args(std::iter::once(&self.command).chain(&self.args)) }
    }

    /// The ACP `McpServer` for this server. Stdio commands are resolved on PATH
    /// because ACP wants an absolute path.
    pub fn acp(&self) -> Result<Value, String> {
        let pairs = |m: &BTreeMap<String, String>| m.iter().map(|(k, v)| json!({ "name": k, "value": v })).collect::<Vec<_>>();
        match self.transport {
            Transport::Stdio => {
                let command = agents::which(&self.command).ok_or_else(|| format!("`{}` isn't on your PATH", self.command))?;
                Ok(json!({ "name": self.name, "command": command, "args": self.args, "env": pairs(&self.env) }))
            }
            t => Ok(json!({ "type": t.as_str(), "name": self.name, "url": self.url, "headers": pairs(&self.headers) })),
        }
    }
}

/// What the editor sends to save or test a server.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    /// The name it is saved under, when editing (so it can be renamed).
    #[serde(default)]
    pub original: Option<String>,
    pub name: String,
    pub transport: Transport,
    /// stdio: command and arguments, shell-style.
    #[serde(default)]
    pub command_line: String,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Agent profiles that get it; empty means every agent.
    #[serde(default)]
    pub agents: Vec<String>,
}

impl Draft {
    /// Validate everything but uniqueness.
    pub fn to_server(&self) -> Result<Server, String> {
        let name = self.name.trim();
        check_name(name)?;
        let mut agents: Vec<String> = self.agents.iter().map(|a| a.trim().to_owned()).filter(|a| !a.is_empty()).collect();
        agents.sort();
        agents.dedup();
        let mut s = Server {
            name: name.to_owned(),
            transport: self.transport,
            command: String::new(),
            args: vec![],
            env: BTreeMap::new(),
            url: String::new(),
            headers: BTreeMap::new(),
            enabled: self.enabled,
            agents,
        };
        match self.transport {
            Transport::Stdio => {
                let mut words = agents::split_args(&self.command_line)?.into_iter();
                s.command = words.next().filter(|c| !c.is_empty()).ok_or("enter the command that starts the server")?;
                s.args = words.collect();
                for (k, v) in self.env.iter().filter(|(k, _)| !k.trim().is_empty()) {
                    let k = k.trim();
                    if !valid_env_name(k) {
                        return Err(format!("`{k}` isn't a valid environment variable name"));
                    }
                    s.env.insert(k.to_owned(), v.clone());
                }
            }
            Transport::Http | Transport::Sse => {
                let url = self.url.trim();
                let parsed = reqwest::Url::parse(url).map_err(|e| format!("that URL doesn't parse: {e}"))?;
                if !matches!(parsed.scheme(), "http" | "https") {
                    return Err("the URL must start with http:// or https://".into());
                }
                url.clone_into(&mut s.url);
                for (k, v) in self.headers.iter().filter(|(k, _)| !k.trim().is_empty()) {
                    let k = k.trim();
                    if reqwest::header::HeaderName::from_bytes(k.as_bytes()).is_err() {
                        return Err(format!("`{k}` isn't a valid header name"));
                    }
                    if reqwest::header::HeaderValue::from_str(v).is_err() {
                        return Err(format!("the value of header `{k}` has characters headers can't carry"));
                    }
                    s.headers.insert(k.to_owned(), v.clone());
                }
            }
        }
        Ok(s)
    }
}

fn check_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("give the server a name".into());
    }
    let kebab =
        name.len() <= 64 && name.split('-').all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()));
    if !kebab {
        return Err("names are kebab-case: lowercase letters and digits joined by single dashes, like `github-issues`".into());
    }
    if name == BUILTIN {
        return Err(format!("`{BUILTIN}` is yaah's own server; pick another name"));
    }
    Ok(())
}

fn valid_env_name(k: &str) -> bool {
    let mut chars = k.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Any name → a kebab-case one (for imports).
fn kebab(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-');
    let out = if out.len() > 60 { out[..60].trim_end_matches('-') } else { out };
    if out.is_empty() { "server".into() } else { out.to_owned() }
}

/// `base`, else `base-2`, `base-3`…: the first that isn't taken. One of the first
/// `taken.len() + 2` is free (only `taken` and the built-in name can clash).
fn unique_name(base: &str, taken: &[String]) -> String {
    let candidate = |n: usize| if n == 1 { base.to_owned() } else { format!("{base}-{n}") };
    (1..=taken.len() + 2).map(candidate).find(|n| n != BUILTIN && !taken.contains(n)).unwrap_or_else(|| candidate(taken.len() + 2))
}

// ── Store ───────────────────────────────────────────────────────────────────

#[derive(Debug, Default, Serialize, Deserialize)]
struct McpFile {
    #[serde(default)]
    servers: Vec<Server>,
}

/// `mcp.json`: 0600 (env and headers may hold secrets), written atomically.
pub struct Store {
    file: JsonFile,
}

static USER: std::sync::OnceLock<Store> = std::sync::OnceLock::new();

impl Store {
    pub fn at(path: PathBuf) -> Self {
        Self { file: JsonFile::new(path, true) }
    }

    /// `~/.config/yaah/mcp.json`.
    pub fn user() -> &'static Store {
        USER.get_or_init(|| Store::at(accounts::home().join(".config/yaah/mcp.json")))
    }

    pub fn path(&self) -> &Path {
        self.file.path()
    }

    fn update<T>(&self, f: impl FnOnce(&mut McpFile) -> Result<T, String>) -> Result<T, String> {
        self.file.update(|file: &mut McpFile| {
            dedupe(&mut file.servers);
            f(file)
        })
    }

    pub fn list(&self) -> Vec<Server> {
        let mut servers = self.file.read::<McpFile>().servers;
        dedupe(&mut servers);
        servers
    }

    /// `draft` with the masked values Settings sent back unchanged replaced by the
    /// stored ones (from the server it edits: `original`, else its name).
    pub fn unmask(&self, draft: &Draft) -> Result<Draft, String> {
        let servers = self.list();
        Self::unmask_in(&servers, draft)
    }

    fn unmask_in(servers: &[Server], draft: &Draft) -> Result<Draft, String> {
        let name = draft.original.as_deref().unwrap_or(draft.name.trim());
        let stored = servers.iter().find(|s| s.name == name);
        let mut out = draft.clone();
        unmask_values(&mut out.env, stored.map(|s| &s.env), "environment variable")?;
        unmask_values(&mut out.headers, stored.map(|s| &s.headers), "header")?;
        Ok(out)
    }

    /// Create, replace, or rename (with `draft.original`) a server. Masked values
    /// sent back unchanged keep what is stored.
    pub fn save(&self, draft: &Draft) -> Result<Server, String> {
        self.update(|file| {
            let draft = &Self::unmask_in(&file.servers, draft)?;
            let server = draft.to_server()?;
            let original = draft.original.as_deref();
            if file.servers.iter().any(|s| s.name == server.name && Some(s.name.as_str()) != original) {
                return Err(format!("there's already a server named `{}`", server.name));
            }
            match original.and_then(|o| file.servers.iter().position(|s| s.name == o)) {
                Some(i) => file.servers[i] = server.clone(),
                None if original.is_some() => return Err(format!("no server named `{}`", original.unwrap_or_default())),
                None => file.servers.push(server.clone()),
            }
            Ok(server)
        })
    }

    pub fn remove(&self, name: &str) -> Result<(), String> {
        self.update(|file| {
            let before = file.servers.len();
            file.servers.retain(|s| s.name != name);
            if file.servers.len() == before { Err(format!("no server named `{name}`")) } else { Ok(()) }
        })
    }

    pub fn set_enabled(&self, name: &str, enabled: bool) -> Result<Server, String> {
        self.update(|file| {
            let s = file.servers.iter_mut().find(|s| s.name == name).ok_or_else(|| format!("no server named `{name}`"))?;
            s.enabled = enabled;
            Ok(s.clone())
        })
    }

    /// Add imported servers, renaming any whose name is taken. Returns them as saved.
    fn add_all(&self, servers: Vec<Server>) -> Result<Vec<Server>, String> {
        self.update(|file| {
            let mut added = vec![];
            for mut s in servers {
                // The same server (and credentials) from another source is one entry, for both agents.
                if let Some(e) = file.servers.iter_mut().find(|e| same_server(e, &s)) {
                    merge_agents(e, &s);
                    added.push(e.clone());
                    continue;
                }
                let taken: Vec<String> = file.servers.iter().map(|s| s.name.clone()).collect();
                s.name = unique_name(&s.name, &taken);
                file.servers.push(s.clone());
                added.push(s);
            }
            Ok(added)
        })
    }
}

// ── Into ACP sessions ───────────────────────────────────────────────────────

/// ACP `McpServer` entries for the enabled servers an agent with these MCP
/// capabilities can use, and a note for each enabled one it can't.
pub fn for_agent(servers: &[Server], http: bool, sse: bool) -> (Vec<Value>, Vec<String>) {
    let mut out = vec![];
    let mut skipped = vec![];
    for s in servers.iter().filter(|s| s.enabled) {
        let supported = match s.transport {
            Transport::Stdio => true,
            Transport::Http => http,
            Transport::Sse => sse,
        };
        if !supported {
            skipped.push(format!(
                "`{}`: the agent can't connect to {} MCP servers (mcpCapabilities.{} is off)",
                s.name,
                s.transport.as_str(),
                s.transport.as_str()
            ));
            continue;
        }
        match s.acp() {
            Ok(v) => out.push(v),
            Err(e) => skipped.push(format!("`{}`: {e}", s.name)),
        }
    }
    (out, skipped)
}

/// Append the user's servers to `params.mcpServers` (session/new, session/load).
/// What an agent can't take is logged (names only) and shown in Settings.
pub fn inject(params: &mut Value, http: bool, sse: bool, agent: &agents::Profile) {
    // A Claude agent already loads the servers in its own .claude.json: passing them again
    // starts each twice (and reports each failure twice).
    let own: Vec<Server> = if agent.preset == "claude" {
        let dir = agent.config_dir.as_ref().map_or_else(accounts::home, PathBuf::from);
        read_source(&dir.join(".claude.json")).into_iter().map(|(_, s)| s).collect()
    } else {
        vec![]
    };
    let mine: Vec<Server> = Store::user().list().into_iter().filter(|s| s.for_profile(&agent.id) && !own.iter().any(|o| same_target(o, s))).collect();
    let (servers, skipped) = for_agent(&mine, http, sse);
    for note in skipped {
        eprintln!("[mcp] not given to {}: {note}", agent.label);
    }
    append(params, servers);
}

fn append(params: &mut Value, servers: Vec<Value>) {
    if servers.is_empty() {
        return;
    }
    match params["mcpServers"].as_array_mut() {
        Some(list) => list.extend(servers),
        None => params["mcpServers"] = Value::Array(servers),
    }
}

// ── What Settings shows ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    #[serde(flatten)]
    pub server: Server,
    pub command_line: String,
    /// Why no agent gets it right now (a stdio command that isn't on PATH).
    pub problem: Option<String>,
    /// Saved agents whose last `initialize` said they can't use this transport.
    pub unsupported_by: Vec<String>,
    /// Env vars and headers whose value is masked (`••••1234`): send it back
    /// unchanged to keep the stored value, or a new one to replace it.
    pub secret_env: Vec<String>,
    pub secret_headers: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Builtin {
    pub name: &'static str,
    pub transport: Transport,
    pub about: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpList {
    pub servers: Vec<ServerInfo>,
    pub builtin: Builtin,
    /// Where they're stored, for display.
    pub path: String,
}

pub fn info(mut server: Server, profiles: &[agents::Profile]) -> ServerInfo {
    let problem = (server.transport == Transport::Stdio && agents::which(&server.command).is_none())
        .then(|| format!("`{}` isn't on your PATH, so agents won't get this server", server.command));
    let unsupported_by = profiles
        .iter()
        .filter(|p| {
            p.report.as_ref().is_some_and(|r| match server.transport {
                Transport::Stdio => false,
                Transport::Http => !r.mcp_http,
                Transport::Sse => !r.mcp_sse,
            })
        })
        .map(|p| p.label.clone())
        .collect();
    let (secret_env, secret_headers) = masked(&mut server);
    ServerInfo { command_line: server.command_line(), problem, unsupported_by, secret_env, secret_headers, server }
}

pub fn list() -> McpList {
    let profiles = agents::Store::user().load().profiles;
    let store = Store::user();
    McpList {
        servers: store.list().into_iter().map(|s| info(s, &profiles)).collect(),
        builtin: Builtin {
            name: BUILTIN,
            transport: Transport::Http,
            about: "yaah's UI tools (forms, tables, charts in the chat). Added for agents that support HTTP MCP.",
        },
        path: store.path().to_string_lossy().into_owned(),
    }
}

pub fn info_now(server: Server) -> ServerInfo {
    info(server, &agents::Store::user().load().profiles)
}

// ── Test: a minimal MCP client ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestReport {
    pub server_name: Option<String>,
    pub server_version: Option<String>,
    pub protocol_version: Option<String>,
    pub tools: Vec<Tool>,
}

/// Connect, `initialize`, `notifications/initialized`, `tools/list`, disconnect.
/// Gives up after [`TEST_TIMEOUT`]; a stdio server is always killed.
pub async fn test(server: &Server) -> Result<TestReport, String> {
    test_within(server, TEST_TIMEOUT).await
}

async fn test_within(server: &Server, limit: Duration) -> Result<TestReport, String> {
    let run = async {
        match server.transport {
            Transport::Stdio => test_stdio(server).await,
            Transport::Http => handshake(&mut Http::new(server)?).await,
            Transport::Sse => handshake(&mut Sse::connect(server).await?).await,
        }
    };
    // Dropping the future on timeout drops the child, which is spawned with kill_on_drop.
    tokio::time::timeout(limit, run).await.unwrap_or_else(|_| Err(format!("the server didn't answer within {}s", limit.as_secs())))
}

/// One JSON-RPC exchange over some MCP transport.
trait Rpc {
    async fn send(&mut self, msg: &Value, id: Option<u64>) -> Result<Option<Value>, String>;
}

async fn request(t: &mut impl Rpc, id: u64, method: &str, params: Value) -> Result<Value, String> {
    let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    let reply = t.send(&msg, Some(id)).await?.ok_or_else(|| format!("no reply to {method}"))?;
    if let Some(err) = reply.get("error") {
        return Err(format!("{method} failed: {} ({})", err["message"].as_str().unwrap_or("error"), err["code"]));
    }
    Ok(reply.get("result").cloned().unwrap_or(Value::Null))
}

async fn handshake(t: &mut impl Rpc) -> Result<TestReport, String> {
    let init = request(
        t,
        1,
        "initialize",
        json!({ "protocolVersion": MCP_VERSION, "capabilities": {}, "clientInfo": { "name": "yaah", "version": env!("CARGO_PKG_VERSION") } }),
    )
    .await?;
    t.send(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }), None).await?;
    let s = |p: &str| init.pointer(p).and_then(Value::as_str).map(str::to_owned);
    let mut report = TestReport {
        server_name: s("/serverInfo/name"),
        server_version: s("/serverInfo/version"),
        protocol_version: s("/protocolVersion"),
        tools: vec![],
    };
    if init.pointer("/capabilities/tools").is_none() {
        return Ok(report);
    }
    let mut cursor: Option<String> = None;
    for page in 0..50u64 {
        let params = cursor.as_ref().map_or_else(|| json!({}), |c| json!({ "cursor": c }));
        let res = request(t, 2 + page, "tools/list", params).await?;
        report.tools.extend(res["tools"].as_array().into_iter().flatten().filter_map(|t| {
            Some(Tool {
                name: t["name"].as_str()?.to_owned(),
                description: t["description"].as_str().map(|d| d.trim().to_owned()).filter(|d| !d.is_empty()),
            })
        }));
        cursor = res["nextCursor"].as_str().filter(|c| !c.is_empty()).map(str::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    Ok(report)
}

/// A reply to request `id`, from one message or a batch.
fn reply_to(msg: Value, id: u64) -> Option<Value> {
    match msg {
        Value::Array(items) => items.into_iter().find_map(|m| reply_to(m, id)),
        m if m.get("method").is_none() && m["id"].as_u64() == Some(id) => Some(m),
        _ => None,
    }
}

fn short(text: &str) -> String {
    let t = text.trim();
    if t.chars().count() > 300 { format!("{}…", t.chars().take(300).collect::<String>()) } else { t.to_owned() }
}

// stdio ──

struct Stdio {
    stdin: tokio::process::ChildStdin,
    lines: tokio::io::Lines<tokio::io::BufReader<tokio::process::ChildStdout>>,
}

impl Rpc for Stdio {
    async fn send(&mut self, msg: &Value, id: Option<u64>) -> Result<Option<Value>, String> {
        use tokio::io::AsyncWriteExt;
        let mut line = msg.to_string();
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).await.map_err(|e| format!("the server closed its input: {e}"))?;
        self.stdin.flush().await.map_err(|e| e.to_string())?;
        let Some(id) = id else { return Ok(None) };
        loop {
            let line = self.lines.next_line().await.map_err(|e| e.to_string())?.ok_or("the server exited")?;
            // Stray output on stdout isn't JSON-RPC; skip it.
            let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
            // A request from the server: we offer no capabilities, so refuse it.
            if let (Some(rid), Some(method)) = (msg.get("id"), msg["method"].as_str()) {
                let no = json!({ "jsonrpc": "2.0", "id": rid, "error": { "code": -32601, "message": format!("{method} isn't supported") } });
                let _ = self.stdin.write_all(format!("{no}\n").as_bytes()).await;
                continue;
            }
            if let Some(reply) = reply_to(msg, id) {
                return Ok(Some(reply));
            }
        }
    }
}

async fn test_stdio(server: &Server) -> Result<TestReport, String> {
    use std::process::Stdio as Pipe;
    use tokio::io::{AsyncBufReadExt, BufReader};
    let command = agents::which(&server.command).ok_or_else(|| format!("`{}` isn't on your PATH", server.command))?;
    let mut child = crate::path_env::tokio_command(&command)
        .args(&server.args)
        .envs(&server.env)
        .stdin(Pipe::piped())
        .stdout(Pipe::piped())
        .stderr(Pipe::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("couldn't start `{}`: {e}", server.command))?;
    // Keep the end of stderr for error messages.
    let tail = std::sync::Arc::new(Mutex::new(std::collections::VecDeque::<String>::new()));
    let mut stderr_done = None;
    if let Some(err) = child.stderr.take() {
        let tail = tail.clone();
        stderr_done = Some(tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                let mut t = tail.lock().unwrap();
                t.push_back(l);
                if t.len() > 12 {
                    t.pop_front();
                }
            }
        }));
    }
    let mut io = Stdio { stdin: child.stdin.take().ok_or("no stdin")?, lines: BufReader::new(child.stdout.take().ok_or("no stdout")?).lines() };
    let res = handshake(&mut io).await;
    // Closing stdin is how MCP stdio servers are told to stop, and lets
    // wrappers like npx take their node child down with them; then kill.
    drop(io);
    if tokio::time::timeout(Duration::from_millis(500), child.wait()).await.is_err() {
        let _ = child.kill().await;
    }
    let Err(e) = res else { return res };
    // The server has exited: let the reader drain what it said on stderr.
    if let Some(done) = stderr_done {
        let _ = tokio::time::timeout(Duration::from_secs(1), done).await;
    }
    let t: Vec<String> = tail.lock().unwrap().iter().cloned().collect();
    Err(if t.is_empty() { e } else { format!("{e}\n{}", t.join("\n")) })
}

// SSE framing (both HTTP transports) ──

/// Splits a byte stream into server-sent events: (event name, data).
#[derive(Default)]
struct SseParser {
    buf: Vec<u8>,
    event: String,
    data: Vec<String>,
}

impl SseParser {
    fn feed(&mut self, bytes: &[u8]) -> Vec<(String, String)> {
        self.buf.extend_from_slice(bytes);
        let mut out = vec![];
        while let Some(nl) = self.buf.iter().position(|&b| b == b'\n') {
            let raw: Vec<u8> = self.buf.drain(..=nl).collect();
            let line = String::from_utf8_lossy(&raw);
            let line = line.trim_end_matches(['\n', '\r']);
            if line.is_empty() {
                if !self.data.is_empty() {
                    let event = if self.event.is_empty() { "message".to_owned() } else { std::mem::take(&mut self.event) };
                    out.push((event, self.data.join("\n")));
                }
                self.data.clear();
                self.event.clear();
            } else if line.starts_with(':') {
                // comment / keep-alive
            } else {
                let (field, value) = line.split_once(':').unwrap_or((line, ""));
                let value = value.strip_prefix(' ').unwrap_or(value);
                match field {
                    "data" => self.data.push(value.to_owned()),
                    "event" => value.clone_into(&mut self.event),
                    _ => {}
                }
            }
        }
        out
    }
}

fn header_map(server: &Server) -> Result<reqwest::header::HeaderMap, String> {
    let mut map = reqwest::header::HeaderMap::new();
    for (k, v) in &server.headers {
        let name = reqwest::header::HeaderName::from_bytes(k.as_bytes()).map_err(|_| format!("`{k}` isn't a valid header name"))?;
        let value = reqwest::header::HeaderValue::from_str(v).map_err(|_| format!("header `{k}` has an invalid value"))?;
        map.insert(name, value);
    }
    Ok(map)
}

async fn http_error(resp: reqwest::Response) -> String {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let hint = if status.as_u16() == 401 { " (it wants authorization: the test can't do OAuth; add an Authorization header)" } else { "" };
    if body.trim().is_empty() { format!("HTTP {status}{hint}") } else { format!("HTTP {status}{hint}: {}", short(&body)) }
}

// Streamable HTTP ──

struct Http {
    client: reqwest::Client,
    url: String,
    headers: reqwest::header::HeaderMap,
    session: Option<String>,
    protocol: Option<String>,
}

impl Http {
    fn new(server: &Server) -> Result<Self, String> {
        Ok(Http { client: crate::integrations::http().clone(), url: server.url.clone(), headers: header_map(server)?, session: None, protocol: None })
    }
}

impl Rpc for Http {
    async fn send(&mut self, msg: &Value, id: Option<u64>) -> Result<Option<Value>, String> {
        let mut req = self
            .client
            .post(&self.url)
            .headers(self.headers.clone())
            .header(reqwest::header::ACCEPT, "application/json, text/event-stream")
            .json(msg);
        if let Some(s) = &self.session {
            req = req.header("Mcp-Session-Id", s);
        }
        if let Some(p) = &self.protocol {
            req = req.header("MCP-Protocol-Version", p);
        }
        let mut resp = req.send().await.map_err(|e| format!("couldn't reach the server: {e}"))?;
        if let Some(s) = resp.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()) {
            self.session = Some(s.to_owned());
        }
        if !resp.status().is_success() {
            return Err(http_error(resp).await);
        }
        let Some(id) = id else { return Ok(None) };
        let is_sse =
            resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|c| c.starts_with("text/event-stream"));
        let reply = if is_sse {
            // Read events until the reply; the server may keep the stream open after it.
            let mut parser = SseParser::default();
            let mut found = None;
            'read: while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
                for (_, data) in parser.feed(&chunk) {
                    if let Some(r) = serde_json::from_str(&data).ok().and_then(|m| reply_to(m, id)) {
                        found = Some(r);
                        break 'read;
                    }
                }
            }
            found.ok_or("the server's event stream ended without a reply")?
        } else {
            let text = resp.text().await.map_err(|e| e.to_string())?;
            let msg: Value = serde_json::from_str(&text).map_err(|_| format!("the server didn't answer with JSON-RPC: {}", short(&text)))?;
            reply_to(msg, id).ok_or("the server's answer wasn't a reply to the request")?
        };
        if id == 1
            && let Some(v) = reply.pointer("/result/protocolVersion").and_then(Value::as_str)
        {
            self.protocol = Some(v.to_owned());
        }
        Ok(Some(reply))
    }
}

impl Drop for Http {
    /// End the server's session (best effort, in the background).
    fn drop(&mut self) {
        let (Some(session), Ok(handle)) = (self.session.take(), tokio::runtime::Handle::try_current()) else { return };
        let req = self.client.delete(&self.url).headers(self.headers.clone()).header("Mcp-Session-Id", session);
        handle.spawn(async move {
            let _ = tokio::time::timeout(Duration::from_secs(3), req.send()).await;
        });
    }
}

// Legacy HTTP+SSE ──

enum SseMsg {
    Endpoint(String),
    Message(Value),
    Closed(String),
}

struct Sse {
    client: reqwest::Client,
    headers: reqwest::header::HeaderMap,
    post_url: String,
    events: tokio::sync::mpsc::UnboundedReceiver<SseMsg>,
    reader: tokio::task::JoinHandle<()>,
}

impl Drop for Sse {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

impl Sse {
    /// GET the stream and wait for its `endpoint` event (where to POST messages).
    async fn connect(server: &Server) -> Result<Self, String> {
        let client = crate::integrations::http().clone();
        let headers = header_map(server)?;
        let base = reqwest::Url::parse(&server.url).map_err(|e| e.to_string())?;
        let resp = client
            .get(base.clone())
            .headers(headers.clone())
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .send()
            .await
            .map_err(|e| format!("couldn't reach the server: {e}"))?;
        if !resp.status().is_success() {
            return Err(http_error(resp).await);
        }
        let (tx, mut events) = tokio::sync::mpsc::unbounded_channel();
        let reader = tokio::spawn(async move {
            let mut resp = resp;
            let mut parser = SseParser::default();
            loop {
                match resp.chunk().await {
                    Ok(Some(chunk)) => {
                        for (event, data) in parser.feed(&chunk) {
                            let msg = match event.as_str() {
                                "endpoint" => SseMsg::Endpoint(data),
                                _ => match serde_json::from_str(&data) {
                                    Ok(v) => SseMsg::Message(v),
                                    Err(_) => continue,
                                },
                            };
                            if tx.send(msg).is_err() {
                                return;
                            }
                        }
                    }
                    Ok(None) => {
                        let _ = tx.send(SseMsg::Closed("the server closed the event stream".into()));
                        return;
                    }
                    Err(e) => {
                        let _ = tx.send(SseMsg::Closed(e.to_string()));
                        return;
                    }
                }
            }
        });
        let endpoint = loop {
            match events.recv().await {
                Some(SseMsg::Endpoint(e)) => break e,
                Some(SseMsg::Message(_)) => {}
                Some(SseMsg::Closed(why)) => return Err(format!("no endpoint event: {why}")),
                None => return Err("no endpoint event".into()),
            }
        };
        let post_url = base.join(endpoint.trim()).map_err(|e| format!("bad endpoint `{endpoint}`: {e}"))?.to_string();
        Ok(Sse { client, headers, post_url, events, reader })
    }
}

impl Rpc for Sse {
    async fn send(&mut self, msg: &Value, id: Option<u64>) -> Result<Option<Value>, String> {
        let resp = self
            .client
            .post(&self.post_url)
            .headers(self.headers.clone())
            .json(msg)
            .send()
            .await
            .map_err(|e| format!("couldn't reach the server: {e}"))?;
        if !resp.status().is_success() {
            return Err(http_error(resp).await);
        }
        let Some(id) = id else { return Ok(None) };
        loop {
            match self.events.recv().await {
                Some(SseMsg::Message(m)) => {
                    if let Some(r) = reply_to(m, id) {
                        return Ok(Some(r));
                    }
                }
                Some(SseMsg::Endpoint(_)) => {}
                Some(SseMsg::Closed(why)) => return Err(why),
                None => return Err("the event stream ended".into()),
            }
        }
    }
}

// ── Import from other tools ─────────────────────────────────────────────────

/// A config file other tools keep MCP servers in.
struct SourceFile {
    id: String,
    label: String,
    path: PathBuf,
}

fn source_files(home: &Path, claude_dirs: &[(String, String, PathBuf)]) -> Vec<SourceFile> {
    let mut out = vec![SourceFile { id: "claude-code".into(), label: "Claude Code".into(), path: home.join(".claude.json") }];
    for (id, label, dir) in claude_dirs {
        let path = dir.join(".claude.json");
        if !out.iter().any(|s| s.path == path) {
            out.push(SourceFile { id: format!("claude-code:{id}"), label: format!("Claude Code ({label})"), path });
        }
    }
    let desktop = if cfg!(target_os = "macos") {
        home.join("Library/Application Support/Claude/claude_desktop_config.json")
    } else {
        home.join(".config/Claude/claude_desktop_config.json")
    };
    out.push(SourceFile { id: "claude-desktop".into(), label: "Claude Desktop".into(), path: desktop });
    out.push(SourceFile { id: "cursor".into(), label: "Cursor".into(), path: home.join(".cursor/mcp.json") });
    out
}

/// Who an imported server is for, by where it was found: a Claude profile's own config is that
/// profile's; ~/.claude.json belongs to the Claude profiles without a config dir of their own;
/// Claude Desktop and Cursor servers go to every agent.
fn scope_of(source: &str, home_claude: &[String]) -> Vec<String> {
    if let Some(id) = source.strip_prefix("claude-code:") {
        return vec![id.to_owned()];
    }
    if source == "claude-code" {
        return home_claude.to_vec();
    }
    vec![]
}

/// Claude profiles that use ~/.claude (no config dir of their own).
fn home_claude_profiles() -> Vec<String> {
    agents::Store::user().load().profiles.into_iter().filter(|p| p.is_claude() && p.config_dir.is_none()).map(|p| p.id).collect()
}

/// Claude profiles with their own config dir: (profile id, label, dir).
fn claude_profile_dirs() -> Vec<(String, String, PathBuf)> {
    agents::Store::user()
        .load()
        .profiles
        .into_iter()
        .filter(agents::Profile::is_claude)
        .filter_map(|p| Some((p.id, p.label, PathBuf::from(p.config_dir?))))
        .collect()
}

/// One entry of an `mcpServers` object, in the shape Claude Code, Claude
/// Desktop and Cursor share (`type` optional; a `url` without one is http).
fn parse_entry(name: &str, v: &Value) -> Option<Server> {
    let url = v["url"].as_str().or(v["serverUrl"].as_str()).map(str::to_owned);
    let command = v["command"].as_str().map(str::to_owned);
    let transport = match (v["type"].as_str().or(v["transport"].as_str()), &command, &url) {
        (Some("stdio"), ..) | (None, Some(_), _) => Transport::Stdio,
        (Some("http" | "streamable-http" | "streamableHttp" | "streamable_http"), ..) | (None, None, Some(_)) => Transport::Http,
        (Some("sse"), ..) => Transport::Sse,
        _ => return None,
    };
    let strings = |m: &Value| -> BTreeMap<String, String> {
        m.as_object()
            .into_iter()
            .flatten()
            .filter(|(_, v)| !v.is_null())
            .map(|(k, v)| (k.clone(), v.as_str().map_or_else(|| v.to_string(), str::to_owned)))
            .collect()
    };
    let mut s = Server {
        name: kebab(name),
        transport,
        command: String::new(),
        args: vec![],
        env: BTreeMap::new(),
        url: String::new(),
        headers: BTreeMap::new(),
        enabled: !v["disabled"].as_bool().unwrap_or(false),
        agents: vec![],
    };
    if transport == Transport::Stdio {
        s.command = command?;
        s.args = v["args"].as_array().into_iter().flatten().filter_map(|a| a.as_str().map(str::to_owned)).collect();
        s.env = strings(&v["env"]);
    } else {
        s.url = url?;
        s.headers = strings(&v["headers"]);
    }
    Some(s)
}

/// (original name, server) for each server in a config file.
/// The servers in another tool's config file. Kept in memory while the file is
/// unchanged on disk: `~/.claude.json` (often megabytes of history) is read on
/// every Claude `session/new` and `session/load`.
pub(crate) fn read_source(path: &Path) -> Vec<(String, Server)> {
    type Parsed = std::collections::HashMap<PathBuf, (crate::json_file::Stamp, Vec<(String, Server)>)>;
    static CACHE: std::sync::LazyLock<std::sync::Mutex<Parsed>> = std::sync::LazyLock::new(Default::default);
    let Some(stamp) = crate::json_file::Stamp::of(path) else { return vec![] };
    if let Some((s, servers)) = CACHE.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(path)
        && *s == stamp
    {
        return servers.clone();
    }
    let servers = parse_source(path);
    // The stamp from before the read: a write during it is seen next time.
    CACHE.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(path.to_path_buf(), (stamp, servers.clone()));
    servers
}

fn parse_source(path: &Path) -> Vec<(String, Server)> {
    let Ok(raw) = std::fs::read_to_string(path) else { return vec![] };
    let Ok(json) = serde_json::from_str::<Value>(&raw) else {
        eprintln!("[mcp] {} isn't valid JSON; nothing imported from it", path.display());
        return vec![];
    };
    json["mcpServers"].as_object().into_iter().flatten().filter_map(|(name, v)| Some((name.clone(), parse_entry(name, v)?))).collect()
}

/// A server found in another tool's config. Carries no env or header values.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    /// Which file (pass back to import with `original`).
    pub source: String,
    pub source_label: String,
    pub path: String,
    /// Its name in that file.
    pub original: String,
    /// The name it gets here (a free one, kebab-case).
    pub name: String,
    pub transport: Transport,
    /// Command line, or the URL without its query string.
    pub target: String,
    pub env_keys: Vec<String>,
    pub header_keys: Vec<String>,
    /// A server with the same command or URL is already configured.
    pub already_added: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPick {
    pub source: String,
    pub original: String,
}

/// Fold servers that are the same server with the same credentials into the first, which
/// then goes to all their agents. Earlier imports added one copy per source they were found in.
fn dedupe(servers: &mut Vec<Server>) {
    let mut kept: Vec<Server> = Vec::with_capacity(servers.len());
    for s in servers.drain(..) {
        match kept.iter_mut().find(|k| same_server(k, &s)) {
            Some(k) => merge_agents(k, &s),
            None => kept.push(s),
        }
    }
    *servers = kept;
}

fn same_target(a: &Server, b: &Server) -> bool {
    a.transport == b.transport && a.command == b.command && a.args == b.args && a.url == b.url
}

/// The same server with the same credentials: one entry, whoever it is for.
fn same_server(a: &Server, b: &Server) -> bool {
    same_target(a, b) && a.env == b.env && a.headers == b.headers
}

/// Make `into` available to `from`'s agents too (everyone, if either is for everyone).
fn merge_agents(into: &mut Server, from: &Server) {
    if into.agents.is_empty() || from.agents.is_empty() {
        into.agents.clear();
    } else {
        for a in &from.agents {
            if !into.agents.contains(a) {
                into.agents.push(a.clone());
            }
        }
        into.agents.sort();
    }
}

fn display_url(url: &str) -> String {
    match url.split_once('?') {
        Some((base, _)) => format!("{base}?…"),
        None => url.to_owned(),
    }
}

fn candidates_in(home: &Path, claude_dirs: &[(String, String, PathBuf)], existing: &[Server]) -> Vec<Candidate> {
    let taken: Vec<String> = existing.iter().map(|s| s.name.clone()).collect();
    let mut out = vec![];
    for src in source_files(home, claude_dirs) {
        for (original, s) in read_source(&src.path) {
            out.push(Candidate {
                source: src.id.clone(),
                source_label: src.label.clone(),
                path: match src.path.strip_prefix(home) {
                    Ok(rest) => format!("~/{}", rest.display()),
                    Err(_) => src.path.display().to_string(),
                },
                original,
                name: unique_name(&s.name, &taken),
                transport: s.transport,
                target: if s.transport == Transport::Stdio { s.command_line() } else { display_url(&s.url) },
                env_keys: s.env.keys().cloned().collect(),
                header_keys: s.headers.keys().cloned().collect(),
                already_added: existing.iter().any(|e| same_server(e, &s)),
            });
        }
    }
    out
}

/// Servers configured for Claude Code (and each Claude profile), Claude Desktop and Cursor.
pub fn import_candidates() -> Vec<Candidate> {
    candidates_in(&accounts::home(), &claude_profile_dirs(), &Store::user().list())
}

fn import_in(
    store: &Store,
    home: &Path,
    claude_dirs: &[(String, String, PathBuf)],
    home_claude: &[String],
    picks: &[ImportPick],
) -> Result<Vec<Server>, String> {
    let sources = source_files(home, claude_dirs);
    let mut chosen = vec![];
    for pick in picks {
        let src = sources.iter().find(|s| s.id == pick.source).ok_or_else(|| format!("unknown source {}", pick.source))?;
        let (_, mut server) = read_source(&src.path)
            .into_iter()
            .find(|(n, _)| *n == pick.original)
            .ok_or_else(|| format!("`{}` is no longer in {}", pick.original, src.label))?;
        // A Claude profile's servers carry that profile's credentials: keep them to it.
        server.agents = scope_of(&src.id, home_claude);
        chosen.push(server);
    }
    store.add_all(chosen)
}

/// Copy the picked servers into yaah's own list.
pub fn import(picks: &[ImportPick]) -> Result<Vec<Server>, String> {
    import_in(Store::user(), &accounts::home(), &claude_profile_dirs(), &home_claude_profiles(), picks)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader as StdBufReader, Read, Write};

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("yaah-mcp-{}", crate::session::random_token()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn stdio_draft(name: &str, line: &str) -> Draft {
        Draft { name: name.into(), transport: Transport::Stdio, command_line: line.into(), enabled: true, ..Draft::default() }
    }

    fn http_draft(name: &str, url: &str) -> Draft {
        Draft { name: name.into(), transport: Transport::Http, url: url.into(), enabled: true, ..Draft::default() }
    }

    fn fixture() -> Server {
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mcp_stdio_server.sh");
        let mut d = stdio_draft("fixture", &agents::join_args(["sh", script.to_str().unwrap()]));
        d.env.insert("FIXTURE_VERSION".into(), "1.2.3".into());
        d.to_server().unwrap()
    }

    #[test]
    fn names_are_kebab_case_and_not_builtin() {
        for bad in ["", "Git", "a_b", "a--b", "-a", "a-", "yaah-ui", "a b"] {
            assert!(check_name(bad).is_err(), "{bad:?} should be refused");
        }
        for good in ["a", "github", "my-server-2"] {
            assert!(check_name(good).is_ok());
        }
        assert_eq!(kebab("My Server_v2!"), "my-server-v2");
        assert_eq!(kebab("!!"), "server");
        assert_eq!(unique_name("yaah-ui", &[]), "yaah-ui-2");
        assert_eq!(unique_name("x", &["x".into(), "x-2".into()]), "x-3");
    }

    #[test]
    fn drafts_are_validated_and_trimmed_per_transport() {
        let mut d = stdio_draft("fs", "npx -y '@scope/server fs' /tmp");
        d.env.insert("API_KEY".into(), "s3cret".into());
        d.headers.insert("X-Ignored".into(), "1".into());
        d.url = "http://ignored".into();
        let s = d.to_server().unwrap();
        assert_eq!((s.command.as_str(), s.args.as_slice()), ("npx", &["-y".to_owned(), "@scope/server fs".into(), "/tmp".into()][..]));
        assert!(s.url.is_empty() && s.headers.is_empty(), "stdio keeps only stdio fields");
        assert_eq!(s.command_line(), "npx -y '@scope/server fs' /tmp");

        assert!(stdio_draft("fs", "  ").to_server().is_err());
        let mut bad_env = stdio_draft("fs", "x");
        bad_env.env.insert("1X".into(), "v".into());
        assert!(bad_env.to_server().is_err());

        assert!(http_draft("h", "ftp://x").to_server().is_err());
        assert!(http_draft("h", "not a url").to_server().is_err());
        let mut h = http_draft("h", " https://mcp.example.com/mcp ");
        h.headers.insert("Bad Header".into(), "v".into());
        assert!(h.to_server().is_err());
        h.headers.clear();
        h.headers.insert("Authorization".into(), "Bearer t".into());
        h.command_line = "ignored".into();
        let s = h.to_server().unwrap();
        assert_eq!(s.url, "https://mcp.example.com/mcp");
        assert_eq!(s.command, "");
    }

    #[test]
    fn store_saves_renames_toggles_and_removes_with_private_permissions() {
        let dir = temp_dir();
        let store = Store::at(dir.join("mcp.json"));
        assert_eq!(store.list(), []);
        store.save(&stdio_draft("fs", "mcp-fs")).unwrap();
        store.save(&http_draft("web", "https://x.example/mcp")).unwrap();
        assert!(store.save(&stdio_draft("fs", "other")).is_err(), "names are unique");

        // Rename keeps the position.
        let renamed = Draft { original: Some("fs".into()), ..stdio_draft("files", "mcp-fs --root /") };
        store.save(&renamed).unwrap();
        let names: Vec<String> = store.list().into_iter().map(|s| s.name).collect();
        assert_eq!(names, ["files", "web"]);
        assert!(store.save(&Draft { original: Some("web".into()), ..stdio_draft("files", "x") }).is_err(), "can't rename onto another");
        assert!(store.save(&Draft { original: Some("gone".into()), ..stdio_draft("new", "x") }).is_err());

        assert!(!store.set_enabled("web", false).unwrap().enabled);
        assert!(!store.list()[1].enabled);
        assert!(store.set_enabled("nope", true).is_err());
        store.remove("files").unwrap();
        assert!(store.remove("files").is_err());
        assert_eq!(store.list().len(), 1);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(store.path()).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "env and headers may hold secrets");
        }
        assert!(!dir.join("mcp.json.tmp").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Settings gets secrets masked; saving with the masked value unchanged keeps
    /// the stored secret, a new value replaces it, and a masked value with nothing
    /// behind it is refused.
    #[test]
    fn secrets_go_to_settings_masked_and_come_back_unchanged() {
        let dir = temp_dir();
        let store = Store::at(dir.join("mcp.json"));
        let mut web = http_draft("web", "https://x.example/mcp");
        web.headers =
            BTreeMap::from([("Authorization".into(), "Bearer sk-live-0123456789abcd".into()), ("Accept".into(), "application/json".into())]);
        store.save(&web).unwrap();
        let mut fs = stdio_draft("fs", "mcp-fs");
        fs.env = BTreeMap::from([
            ("GITHUB_TOKEN".into(), "ghp_abcdefghijklmnop1234".into()),
            ("DB_PASSWORD".into(), "short".into()),
            ("DATABASE_URL".into(), "postgres://app:hunter2@db:5432/app".into()),
            ("LOG_LEVEL".into(), "debug".into()),
            ("ROOT".into(), "/Users/ada/projects/some-long-folder-1".into()),
        ]);
        store.save(&fs).unwrap();

        let shown: Vec<ServerInfo> = store.list().into_iter().map(|s| info(s, &[])).collect();
        let json = serde_json::to_string(&shown).unwrap();
        for secret in ["sk-live-0123456789abcd", "ghp_abcdefghijklmnop1234", "short", "hunter2"] {
            assert!(!json.contains(secret), "{secret} never reaches the interface");
        }
        let (web_info, fs_info) = (&shown[0], &shown[1]);
        assert_eq!(web_info.server.headers["Authorization"], "••••abcd", "the last 4 tell keys apart");
        assert_eq!(web_info.server.headers["Accept"], "application/json", "plain headers stay plain");
        assert_eq!(web_info.secret_headers, ["Authorization"]);
        assert_eq!(fs_info.server.env["DB_PASSWORD"], "••••", "a short secret shows nothing of itself");
        assert_eq!(fs_info.server.env["LOG_LEVEL"], "debug");
        assert_eq!(fs_info.server.env["ROOT"], "/Users/ada/projects/some-long-folder-1", "a path isn't a secret");
        assert_eq!(fs_info.secret_env, ["DATABASE_URL", "DB_PASSWORD", "GITHUB_TOKEN"]);
        assert_eq!(serde_json::to_value(web_info).unwrap()["secretHeaders"], json!(["Authorization"]));

        // Round trip: Settings sends back what it was shown, with one value edited.
        let edit = |i: &ServerInfo, transport| Draft {
            original: Some(i.server.name.clone()),
            name: i.server.name.clone(),
            transport,
            command_line: i.command_line.clone(),
            env: i.server.env.clone(),
            url: i.server.url.clone(),
            headers: i.server.headers.clone(),
            enabled: true,
            agents: vec![],
        };
        let mut back = edit(fs_info, Transport::Stdio);
        back.env.insert("LOG_LEVEL".into(), "info".into());
        back.env.insert("DB_PASSWORD".into(), "a-new-password".into());
        store.save(&back).unwrap();
        let saved = store.list().into_iter().find(|s| s.name == "fs").unwrap();
        assert_eq!(saved.env["GITHUB_TOKEN"], "ghp_abcdefghijklmnop1234", "unchanged mask: the stored secret is kept");
        assert_eq!(saved.env["DATABASE_URL"], "postgres://app:hunter2@db:5432/app");
        assert_eq!((saved.env["DB_PASSWORD"].as_str(), saved.env["LOG_LEVEL"].as_str()), ("a-new-password", "info"));
        // Headers too (masked values aren't valid header characters, so this must happen before checking them).
        store.save(&edit(web_info, Transport::Http)).unwrap();
        assert_eq!(store.list()[0].headers["Authorization"], "Bearer sk-live-0123456789abcd");
        // Renaming the server keeps its secrets (it's found by `original`).
        let mut renamed = edit(web_info, Transport::Http);
        renamed.name = "web-2".into();
        store.save(&renamed).unwrap();
        assert_eq!(store.list()[0].headers["Authorization"], "Bearer sk-live-0123456789abcd");
        // A masked value under a new key has nothing behind it.
        let mut moved = edit(&info(store.list()[0].clone(), &[]), Transport::Http);
        let token = moved.headers.remove("Authorization").unwrap();
        moved.headers.insert("X-Api-Key".into(), token);
        assert_eq!(store.save(&moved).unwrap_err(), "the header `X-Api-Key` was hidden; type its value again");
        // Testing an unsaved edit uses the stored secret too.
        let tested = store.unmask(&edit(&info(store.list()[0].clone(), &[]), Transport::Http)).unwrap();
        assert_eq!(tested.headers["Authorization"], "Bearer sk-live-0123456789abcd");
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// `~/.claude.json` is parsed once while it is unchanged on disk.
    #[test]
    fn other_tools_configs_are_read_again_only_when_they_change() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir();
        let path = dir.join(".claude.json");
        std::fs::write(&path, json!({ "mcpServers": { "a": { "command": "x" } } }).to_string()).unwrap();
        assert_eq!(read_source(&path).len(), 1);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        assert_eq!(read_source(&path).len(), 1, "unchanged: from memory");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::write(&path, json!({ "mcpServers": { "a": { "command": "x" }, "b": { "command": "y" } } }).to_string()).unwrap();
        assert_eq!(read_source(&path).len(), 2, "changed: read again");
        std::fs::remove_file(&path).unwrap();
        assert_eq!(read_source(&path), vec![]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn acp_entries_match_the_spec_and_respect_capabilities() {
        let mut stdio = stdio_draft("local", "sh -c 'echo hi'");
        stdio.env.insert("TOKEN".into(), "t".into());
        let stdio = stdio.to_server().unwrap();
        let mut http = http_draft("remote", "https://x.example/mcp");
        http.headers.insert("Authorization".into(), "Bearer t".into());
        let http = http.to_server().unwrap();
        let sse = Server { name: "legacy".into(), transport: Transport::Sse, url: "https://x.example/sse".into(), ..http.clone() };
        let off = Server { name: "off".into(), enabled: false, ..stdio.clone() };
        let missing = stdio_draft("missing", "definitely-not-a-real-binary-yaah").to_server().unwrap();
        let all = [stdio, http, sse, off, missing];

        let (entries, skipped) = for_agent(&all, false, false);
        assert_eq!(entries.len(), 1, "stdio always goes; http/sse need capabilities");
        let e = &entries[0];
        assert!(e.get("type").is_none(), "the stdio variant has no type");
        assert!(e["command"].as_str().unwrap().starts_with('/'), "ACP wants an absolute command path");
        assert_eq!(e["args"], json!(["-c", "echo hi"]));
        assert_eq!(e["env"], json!([{ "name": "TOKEN", "value": "t" }]));
        assert_eq!(skipped.len(), 3, "{skipped:?}");
        assert!(skipped.iter().any(|s| s.contains("remote") && s.contains("mcpCapabilities.http")));
        assert!(skipped.iter().any(|s| s.contains("missing") && s.contains("PATH")));
        assert!(!skipped.iter().any(|s| s.contains("`off`")), "disabled servers are just left out");
        assert!(skipped.iter().all(|s| !s.contains("Bearer")), "no secret values in notes");

        let (entries, skipped) = for_agent(&all, true, true);
        assert_eq!(entries.len(), 3);
        assert_eq!(
            entries[1],
            json!({ "type": "http", "name": "remote", "url": "https://x.example/mcp", "headers": [{ "name": "Authorization", "value": "Bearer t" }] })
        );
        assert_eq!(entries[2]["type"], "sse");
        assert_eq!(skipped.len(), 1);

        // Appended after yaah-ui, never replacing it.
        let mut params = json!({ "cwd": "/", "mcpServers": [{ "type": "http", "name": BUILTIN, "url": "u", "headers": [] }] });
        append(&mut params, entries.clone());
        let names: Vec<&str> = params["mcpServers"].as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap()).collect();
        assert_eq!(names, [BUILTIN, "local", "remote", "legacy"]);
        let mut bare = json!({ "cwd": "/" });
        append(&mut bare, entries);
        assert_eq!(bare["mcpServers"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn settings_flag_agents_that_cant_take_a_server() {
        let report = |http| agents::Report { mcp_http: http, ..agents::Report::default() };
        let profile = |label: &str, r: Option<agents::Report>| agents::Profile {
            id: label.into(),
            label: label.into(),
            preset: "custom".into(),
            command: "x".into(),
            args: vec![],
            env: BTreeMap::new(),
            config_dir: None,
            report: r,
            provider: None,
        };
        let profiles = [profile("Gemini", Some(report(true))), profile("Old", Some(report(false))), profile("Untested", None)];
        let http = http_draft("remote", "https://x.example/mcp").to_server().unwrap();
        assert_eq!(info(http, &profiles).unsupported_by, ["Old"]);
        let stdio = stdio_draft("local", "definitely-not-a-real-binary-yaah").to_server().unwrap();
        let i = info(stdio, &profiles);
        assert!(i.unsupported_by.is_empty() && i.problem.is_some());
    }

    #[test]
    fn sse_parser_handles_split_chunks_and_crlf() {
        let mut p = SseParser::default();
        assert_eq!(p.feed(b"event: endpoint\r\ndata: /messages?s"), []);
        let ev = p.feed(b"ession=1\r\n\r\n: ping\n\ndata: {\"a\":\ndata: 1}\n\n");
        assert_eq!(ev, [("endpoint".to_owned(), "/messages?session=1".to_owned()), ("message".to_owned(), "{\"a\":\n1}".to_owned())]);
    }

    #[tokio::test]
    async fn tests_a_stdio_server() {
        let r = test(&fixture()).await.unwrap();
        assert_eq!((r.server_name.as_deref(), r.server_version.as_deref()), (Some("fixture"), Some("1.2.3")), "env reaches the server");
        assert_eq!(r.protocol_version.as_deref(), Some("2025-06-18"));
        let tools: Vec<(&str, Option<&str>)> = r.tools.iter().map(|t| (t.name.as_str(), t.description.as_deref())).collect();
        assert_eq!(tools, [("echo", Some("Echo the input back")), ("add", None)], "both pages of tools/list");
    }

    #[tokio::test]
    async fn stdio_test_times_out_and_reports_stderr() {
        let hang = stdio_draft("hang", "sh -c 'echo starting >&2; exec sleep 30'").to_server().unwrap();
        let started = std::time::Instant::now();
        let err = test_within(&hang, Duration::from_millis(500)).await.unwrap_err();
        assert!(err.contains("didn't answer"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(5));

        let dies = stdio_draft("dies", "sh -c 'echo boom: missing API_KEY >&2; exit 1'").to_server().unwrap();
        let err = test(&dies).await.unwrap_err();
        assert!(err.contains("boom: missing API_KEY"), "stderr explains failures: {err}");
        assert!(test(&stdio_draft("nope", "definitely-not-a-real-binary-yaah").to_server().unwrap()).await.unwrap_err().contains("PATH"));
    }

    // A tiny HTTP server for the HTTP transports: each connection is handled
    // on its own thread by `handle(method, path, headers, body, stream)`.
    fn serve(handle: impl Fn(&str, &str, &[(String, String)], &str, &mut std::net::TcpStream) + Send + Sync + 'static) -> u16 {
        let handle = std::sync::Arc::new(handle);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let handle = handle.clone();
                std::thread::spawn(move || {
                    let mut stream = stream;
                    let mut reader = StdBufReader::new(stream.try_clone().unwrap());
                    let mut line = String::new();
                    if reader.read_line(&mut line).is_err() {
                        return;
                    }
                    let mut parts = line.split_whitespace();
                    let (method, path) = (parts.next().unwrap_or("").to_owned(), parts.next().unwrap_or("").to_owned());
                    let mut headers = vec![];
                    loop {
                        let mut h = String::new();
                        reader.read_line(&mut h).unwrap();
                        let h = h.trim_end();
                        if h.is_empty() {
                            break;
                        }
                        if let Some((k, v)) = h.split_once(':') {
                            headers.push((k.trim().to_ascii_lowercase(), v.trim().to_owned()));
                        }
                    }
                    let len = headers.iter().find(|(k, _)| k == "content-length").and_then(|(_, v)| v.parse().ok()).unwrap_or(0);
                    let mut body = vec![0; len];
                    reader.read_exact(&mut body).unwrap();
                    handle(&method, &path, &headers, &String::from_utf8_lossy(&body), &mut stream);
                });
            }
        });
        port
    }

    fn respond(stream: &mut std::net::TcpStream, status: &str, headers: &str, body: &str) {
        write!(stream, "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
    }

    fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
        headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    #[tokio::test]
    async fn tests_a_streamable_http_server_with_sse_replies_and_a_session() {
        let seen = std::sync::Arc::new(Mutex::new(Vec::<String>::new()));
        let log = seen.clone();
        let port = serve(move |method, _path, headers, body, stream| {
            let msg: Value = serde_json::from_str(body).unwrap_or(Value::Null);
            let m = msg["method"].as_str().unwrap_or(method).to_owned();
            log.lock().unwrap().push(format!(
                "{m} session={} auth={}",
                header(headers, "mcp-session-id").unwrap_or("-"),
                header(headers, "authorization").is_some()
            ));
            assert!(
                method == "DELETE" || header(headers, "accept").is_some_and(|a| a.contains("application/json") && a.contains("text/event-stream"))
            );
            match m.as_str() {
                "initialize" => {
                    let reply = json!({ "jsonrpc": "2.0", "id": msg["id"], "result": { "protocolVersion": "2025-03-26", "capabilities": { "tools": {} }, "serverInfo": { "name": "web", "version": "9" } } });
                    respond(
                        stream,
                        "200 OK",
                        "Content-Type: text/event-stream\r\nMcp-Session-Id: abc\r\n",
                        &format!(": hi\n\nevent: message\ndata: {reply}\n\n"),
                    );
                }
                "notifications/initialized" => respond(stream, "202 Accepted", "", ""),
                "tools/list" => {
                    let reply =
                        json!({ "jsonrpc": "2.0", "id": msg["id"], "result": { "tools": [{ "name": "search", "description": "Search the web" }] } });
                    respond(stream, "200 OK", "Content-Type: application/json\r\n", &reply.to_string());
                }
                _ => respond(stream, "200 OK", "", ""),
            }
        });
        let mut d = http_draft("web", &format!("http://127.0.0.1:{port}/mcp"));
        d.headers.insert("Authorization".into(), "Bearer t".into());
        let r = test(&d.to_server().unwrap()).await.unwrap();
        assert_eq!((r.server_name.as_deref(), r.protocol_version.as_deref()), (Some("web"), Some("2025-03-26")));
        assert_eq!(r.tools.len(), 1);
        assert_eq!(r.tools[0].description.as_deref(), Some("Search the web"));
        let seen = seen.lock().unwrap().clone();
        assert_eq!(
            &seen[..3],
            ["initialize session=- auth=true", "notifications/initialized session=abc auth=true", "tools/list session=abc auth=true"]
        );
    }

    #[tokio::test]
    async fn http_errors_say_what_happened() {
        let port = serve(|_, _, _, _, stream| respond(stream, "401 Unauthorized", "", ""));
        let err = test(&http_draft("web", &format!("http://127.0.0.1:{port}/mcp")).to_server().unwrap()).await.unwrap_err();
        assert!(err.contains("401") && err.contains("Authorization header"), "{err}");
    }

    async fn test_url(port: u16) -> Result<TestReport, String> {
        test(&http_draft("web", &format!("http://127.0.0.1:{port}/mcp")).to_server().unwrap()).await
    }

    #[tokio::test]
    async fn bad_answers_are_explained() {
        let json = "Content-Type: application/json\r\n";
        let refuses = serve(move |_, _, _, body, stream| {
            let msg: Value = serde_json::from_str(body).unwrap_or(Value::Null);
            let reply = json!({ "jsonrpc": "2.0", "id": msg["id"], "error": { "code": -32602, "message": "unsupported protocol version" } });
            respond(stream, "200 OK", json, &reply.to_string());
        });
        assert_eq!(test_url(refuses).await.unwrap_err(), "initialize failed: unsupported protocol version (-32602)");

        let html = serve(|_, _, _, _, stream| respond(stream, "200 OK", "Content-Type: text/html\r\n", "<html>Sign in</html>"));
        assert_eq!(test_url(html).await.unwrap_err(), "the server didn't answer with JSON-RPC: <html>Sign in</html>");

        let silent = serve(|_, _, _, _, stream| respond(stream, "200 OK", "Content-Type: text/event-stream\r\n", ": ping\n\n"));
        assert_eq!(test_url(silent).await.unwrap_err(), "the server's event stream ended without a reply");

        let other =
            serve(move |_, _, _, _, stream| respond(stream, "200 OK", json, &json!({ "jsonrpc": "2.0", "id": 99, "result": {} }).to_string()));
        assert_eq!(test_url(other).await.unwrap_err(), "the server's answer wasn't a reply to the request");

        let long = "x".repeat(1_000);
        let chatty = serve(move |_, _, _, _, stream| respond(stream, "500 Internal Server Error", "", &long));
        let err = test_url(chatty).await.unwrap_err();
        assert!(err.starts_with("HTTP 500 Internal Server Error: xxx") && err.ends_with('…') && err.len() < 400, "{err}");
    }

    #[tokio::test]
    async fn a_server_without_tools_and_its_session_is_ended() {
        let seen = std::sync::Arc::new(Mutex::new(Vec::<String>::new()));
        let log = seen.clone();
        let port = serve(move |method, _, headers, body, stream| {
            let msg: Value = serde_json::from_str(body).unwrap_or(Value::Null);
            log.lock().unwrap().push(format!("{method} {}", msg["method"].as_str().unwrap_or("-")));
            if msg["method"] == "initialize" {
                assert_eq!(header(headers, "mcp-protocol-version"), None, "not before the server said which");
                let reply = json!({ "jsonrpc": "2.0", "id": msg["id"], "result": { "protocolVersion": "2025-06-18", "capabilities": {}, "serverInfo": { "name": "bare" } } });
                respond(stream, "200 OK", "Content-Type: application/json\r\nMcp-Session-Id: s9\r\n", &reply.to_string());
            } else {
                assert_eq!(header(headers, "mcp-protocol-version"), Some("2025-06-18"));
                respond(stream, "202 Accepted", "", "");
            }
        });
        let r = test_url(port).await.unwrap();
        assert_eq!((r.server_name.as_deref(), r.tools.len()), (Some("bare"), 0), "no tools capability: tools/list isn't asked");
        for _ in 0..100 {
            if seen.lock().unwrap().iter().any(|s| s.starts_with("DELETE")) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(*seen.lock().unwrap(), ["POST initialize", "POST notifications/initialized", "DELETE -"]);
    }

    #[tokio::test]
    async fn tests_a_legacy_sse_server() {
        // The GET stream's writer; POSTed requests are answered on it.
        let events: std::sync::Arc<Mutex<Option<std::net::TcpStream>>> = std::sync::Arc::default();
        let ev = events.clone();
        let port = serve(move |method, path, _headers, body, stream| {
            if method == "GET" {
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\n\r\nevent: endpoint\ndata: /messages?sessionId=s1\n\n").unwrap();
                stream.flush().unwrap();
                *ev.lock().unwrap() = Some(stream.try_clone().unwrap());
                std::thread::sleep(Duration::from_secs(10));
                return;
            }
            assert_eq!(path, "/messages?sessionId=s1");
            respond(stream, "202 Accepted", "", "Accepted");
            let msg: Value = serde_json::from_str(body).unwrap();
            let result = match msg["method"].as_str() {
                Some("initialize") => {
                    json!({ "protocolVersion": "2024-11-05", "capabilities": { "tools": {} }, "serverInfo": { "name": "legacy", "version": "1" } })
                }
                Some("tools/list") => json!({ "tools": [{ "name": "ping" }] }),
                _ => return,
            };
            let reply = json!({ "jsonrpc": "2.0", "id": msg["id"], "result": result });
            let mut out = ev.lock().unwrap();
            let s = out.as_mut().unwrap();
            write!(s, "event: message\ndata: {reply}\n\n").unwrap();
            s.flush().unwrap();
        });
        let server = Server { transport: Transport::Sse, ..http_draft("legacy", &format!("http://127.0.0.1:{port}/sse")).to_server().unwrap() };
        let r = test(&server).await.unwrap();
        assert_eq!(r.server_name.as_deref(), Some("legacy"));
        assert_eq!(r.tools[0].name, "ping");
    }

    #[test]
    fn finds_and_imports_servers_from_other_tools() {
        let home = temp_dir();
        let work = home.join(".claude-work");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::create_dir_all(home.join(".cursor")).unwrap();
        std::fs::write(
            home.join(".claude.json"),
            json!({ "numStartups": 3, "mcpServers": {
                "GitHub": { "type": "http", "url": "https://api.example.com/mcp?key=s3cret", "headers": { "Authorization": "Bearer s3cret" } },
                "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"], "env": { "API_KEY": "s3cret" } },
                "weird": { "type": "websocket", "url": "ws://x" }
            }, "projects": { "/x": { "mcpServers": { "ignored": { "command": "x" } } } } })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            work.join(".claude.json"),
            json!({ "mcpServers": { "linear": { "type": "sse", "url": "https://mcp.linear.app/sse" } } }).to_string(),
        )
        .unwrap();
        std::fs::write(
            home.join(".cursor/mcp.json"),
            json!({ "mcpServers": { "fs": { "command": "npx", "args": ["other"] }, "yaah-ui": { "url": "http://x/mcp" } } }).to_string(),
        )
        .unwrap();
        let dirs = [("work".to_owned(), "work".to_owned(), work.clone()), ("dup".to_owned(), "dup".to_owned(), home.clone())];

        let existing = [stdio_draft("fs", "npx -y @modelcontextprotocol/server-filesystem /tmp").to_server().unwrap()];
        let found = candidates_in(&home, &dirs, &existing);
        let summary: Vec<(&str, &str, &str, bool)> =
            found.iter().map(|c| (c.source.as_str(), c.original.as_str(), c.name.as_str(), c.already_added)).collect();
        assert_eq!(
            summary,
            [
                ("claude-code", "GitHub", "github", false),
                // Not "already added": same command, different credentials (API_KEY) is another server.
                ("claude-code", "fs", "fs-2", false),
                ("claude-code:work", "linear", "linear", false),
                ("cursor", "fs", "fs-2", false),
                ("cursor", "yaah-ui", "yaah-ui-2", false),
            ],
            "the home config dir isn't listed twice; unknown transports and per-project servers are skipped"
        );
        let gh = &found[0];
        assert_eq!(
            (gh.transport, gh.target.as_str(), gh.header_keys.as_slice()),
            (Transport::Http, "https://api.example.com/mcp?…", &["Authorization".to_owned()][..])
        );
        assert_eq!(found[1].env_keys, ["API_KEY"]);
        assert!(!serde_json::to_string(&found).unwrap().contains("s3cret"), "candidates carry no secret values");

        let store = Store::at(home.join("yaah/mcp.json"));
        store.save(&stdio_draft("fs", "mine")).unwrap();
        let picks = [
            ImportPick { source: "claude-code".into(), original: "fs".into() },
            ImportPick { source: "claude-code".into(), original: "GitHub".into() },
            ImportPick { source: "cursor".into(), original: "fs".into() },
        ];
        let added = import_in(&store, &home, &dirs, &["personal".into()], &picks).unwrap();
        let names: Vec<&str> = added.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["fs-2", "github", "fs-3"]);
        assert_eq!(added[0].env.get("API_KEY").map(String::as_str), Some("s3cret"), "the import itself keeps the values");
        assert_eq!(added[1].headers.get("Authorization").map(String::as_str), Some("Bearer s3cret"));
        assert_eq!(store.list().len(), 4);
        assert!(import_in(&store, &home, &dirs, &[], &[ImportPick { source: "cursor".into(), original: "gone".into() }]).is_err());
        // Who each is for: ~/.claude.json's servers are the default Claude profile's, Cursor's everyone's.
        assert_eq!(added[0].agents, ["personal"]);
        assert_eq!(added[2].agents, Vec::<String>::new());
        // A Claude profile's own server stays with it, and importing it again adds nothing new.
        let linear = [ImportPick { source: "claude-code:work".into(), original: "linear".into() }];
        assert_eq!(import_in(&store, &home, &dirs, &[], &linear).unwrap()[0].agents, ["work"]);
        let before = store.list().len();
        import_in(&store, &home, &dirs, &[], &linear).unwrap();
        assert_eq!(store.list().len(), before, "the same server with the same credentials isn't added twice");
        assert!(store.list().iter().find(|s| s.name == "linear").unwrap().for_profile("work"));
        assert!(!store.list().iter().find(|s| s.name == "linear").unwrap().for_profile("personal"));
        std::fs::remove_dir_all(home).unwrap();
    }
}
