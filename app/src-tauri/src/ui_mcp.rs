//! The MCP server agents use to show UI in the chat and grow the library.
//!
//! Served over MCP's streamable HTTP transport (JSON responses only) on
//! 127.0.0.1. Each chat gets its own URL, `/mcp/<token>`, passed to the agent
//! in `session/new`; the unguessable token both routes renders to the right
//! chat and keeps other local processes out. A deleted chat's tokens stop
//! working ([`UiHost::revoke`], called by the hub that owns the chat).
//!
//! Local pages shown in `browser` are served per chat, each chat on a port
//! (an origin) of its own, opened when the chat first previews a page and
//! closed with the chat: pages previewed in different chats never share
//! storage, cookies or service workers.

use crate::agent_guide;
use crate::session::{Entry, FormRef, Hub};
use crate::ui_library::{Library, Prepared, SaveRequest};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use tiny_http::{Header, Method, Request, Response, Server};

pub const SERVER_NAME: &str = "yaah-ui";
/// How long `ui_ask` waits for the user before giving up.
pub const ASK_TIMEOUT: std::time::Duration = std::time::Duration::from_hours(1);
const PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

/// Every tool the server has, by its own (bare) name.
pub const TOOL_NAMES: &[&str] =
    &["ui_catalog", "ui_guide", "ui_get_component", "ui_render", "source_read", "ui_ask", "ui_get_values", "ui_set_values", "ui_save_component"];

/// A tool's name as agents that prefix MCP tools by server see it (Claude Code): `mcp__yaah-ui__ui_catalog`.
pub fn full_tool_name(tool: &str) -> String {
    format!("mcp__{SERVER_NAME}__{tool}")
}

const INSTRUCTIONS: &str = "\
You are running inside yaah, a desktop app that renders UI inline in this chat. Whenever you would show, \
compare, review, present, play, chart, tabulate, ask for structured input or build something interactive, \
answer with UI through these tools rather than prose, terminal output or files. Never run `open` and never \
write a standalone HTML file just to show the user something: render it here. A local HTML page you built \
goes in the `browser` primitive (its absolute path), a screenshot in `image`. If these tools are deferred or \
loaded on demand, load them first (with ToolSearch, search for \"yaah-ui\"). Keep prose short when UI carries the content.

Tool names: where MCP tools are prefixed by server (Claude Code) they are mcp__yaah-ui__ui_catalog, \
mcp__yaah-ui__ui_render, mcp__yaah-ui__ui_ask and so on; where they aren't, the bare ui_catalog, ui_render, ui_ask. \
Call them by the exact name your tool list shows.

The full how-to (patterns, forms, live data, fixing errors, saving components) is the ui_guide tool, \
also served as the resources yaah://skills/yaah-ui and yaah://skills/yaah-components and as prompts of the same names.

1. Call ui_catalog first: it lists the primitives, the binding syntax and every library component.
2. Prefer an existing component; render it with ui_render { component, props }. Components with \
source \"yaah\" ship with the app and are the supported way to show common things: test results \
(test-report), tree/ls output (file-tree), JSON and jq output (json-view), a file you cat (file-view), \
wc (word-count), git log --graph (git-graph), git status (git-status), --stat (diff-stat), and live \
system, Docker and database views. After running one of those commands, pass its output to the \
component as printed instead of restating it in prose. To show the user where something is \
(a file in a tree, a line in a file, a field in JSON, rows in a table, a test), fill the view's `find`; \
re-render with the same id and a new `find` to point somewhere else. They are read-only: compose them, don't copy them. \
Components from component libraries the user installed have qualified names, `library/name` (their `source` is the library), \
and are used the same way; they are read-only too.
3. If none fits and the shape will come up again, build one with ui_save_component, composing \
primitives and existing components. Give it a precise description (what it shows, when to use it), \
a props schema and at least one example. It goes into the user's own collection (unqualified names only), shared by every chat, \
so improve an existing component there (ui_get_component, then save with expectedVersion) instead of making a near-duplicate.
4. For a one-off, pass an ad-hoc `tree` to ui_render instead of saving a component. Give it an `id` to update it \
in place later (progress, status panels): rendering again with the same id replaces it.
5. To get information from the user (preferences, choices, priorities, numbers, short text), ask with \
ui_ask and a `form` of inputs rather than in prose: it waits for their answer and returns it to you as JSON, \
so you can carry on in the same turn. Offer options you can act on, sensible defaults, and a free-text \
field for anything you didn't anticipate. A form shown with ui_render (no waiting) sends its answer as their next message. \
To fill something in together (a bug report, a config, a plan), render the form with an `id`, fill in \
what you know with ui_set_values (the user sees it marked as yours and can change it), and read what they \
have typed so far with ui_get_values; the last change to a field wins.
6. For data the app can read itself (this machine's CPU/memory/disks, Docker containers, stats and logs, \
GitHub pull requests and Linear issues, boards and cycles, the user's databases), don't paste it into props: use a yaah component for it, or wrap your UI in a \
`live` node with that `source` (and `every` for refreshing). The app fetches it and keeps it current \
after your turn ends; you never see credentials. Look at the data first with source_read.

Validation errors say exactly what to fix; fix and call again.";

/// Tools Claude Code may call without a permission prompt: the ones that only
/// show UI in this chat or read and grow the component library. `source_read`
/// isn't one: it reads the user's databases, Docker logs and integrations, so
/// the user approves it like any other tool.
const NO_PROMPT_TOOLS: &[&str] =
    &["ui_catalog", "ui_guide", "ui_get_component", "ui_render", "ui_ask", "ui_get_values", "ui_set_values", "ui_save_component"];

/// Claude Code's `allowedTools` for this server: each tool by its full name,
/// never the whole server (`mcp__yaah-ui`), so a tool added later asks first.
pub fn allowed_tools() -> Vec<String> {
    NO_PROMPT_TOOLS.iter().map(|t| full_tool_name(t)).collect()
}

/// The largest request body read: a render's tree and props. Files never come
/// this way (they are inlined from paths), so this is generous.
const MAX_BODY: usize = 8 << 20;
/// How much of a `source_read` result goes back to the agent.
const MAX_SOURCE_TEXT: usize = 40_000;

/// What the server needs from the app.
pub struct UiHost {
    pub hub: Arc<Hub>,
    pub library: Arc<Library>,
    pub sources: Arc<crate::sources::Sources>,
    /// Each chat's preview origin, by session id.
    previews: Mutex<HashMap<String, PreviewSite>>,
    /// Deleted chats: their URL tokens are refused even if something still holds them.
    revoked: Mutex<HashSet<String>>,
    port: OnceLock<u16>,
    /// Chats tests register directly (the app's come from the hub): token → session id.
    #[cfg(test)]
    test_tokens: Mutex<HashMap<String, String>>,
}

/// One chat's preview origin: a listener on 127.0.0.1 of its own, serving the
/// folders of the pages that chat previewed (random id → folder).
struct PreviewSite {
    port: u16,
    server: Arc<Server>,
    folders: Arc<Mutex<HashMap<String, PathBuf>>>,
}

impl PreviewSite {
    fn open() -> Result<Self, String> {
        let server = Arc::new(Server::http("127.0.0.1:0").map_err(|e| format!("preview server: {e}"))?);
        let port = server.server_addr().to_ip().map(|a| a.port()).ok_or("preview server has no TCP port")?;
        let folders: Arc<Mutex<HashMap<String, PathBuf>>> = Arc::default();
        let (srv, dirs) = (server.clone(), folders.clone());
        std::thread::Builder::new()
            .name("yaah-ui-preview".into())
            .spawn(move || {
                // Ends when the site is closed (`unblock`); the listener goes with the last handle.
                for req in srv.incoming_requests() {
                    let dirs = dirs.clone();
                    std::thread::spawn(move || serve_preview(&dirs, req));
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(Self { port, server, folders })
    }
}

impl Drop for PreviewSite {
    fn drop(&mut self) {
        self.server.unblock();
    }
}

impl UiHost {
    pub fn new(hub: Arc<Hub>, library: Arc<Library>, sources: Arc<crate::sources::Sources>) -> Self {
        Self {
            hub,
            library,
            sources,
            previews: Mutex::default(),
            revoked: Mutex::default(),
            port: OnceLock::new(),
            #[cfg(test)]
            test_tokens: Mutex::default(),
        }
    }

    /// The chat a URL token belongs to: `Some(None)` while its `session/new` is still running.
    #[allow(clippy::option_option, reason = "the hub's answer: unknown token, or known before its chat exists")]
    fn session_for(&self, token: &str) -> Option<Option<String>> {
        #[cfg(test)]
        let known = self.test_tokens.lock().unwrap_or_else(PoisonError::into_inner).get(token).map(|s| Some(s.clone()));
        #[cfg(not(test))]
        let known = None;
        let session = known.or_else(|| self.hub.ui_session(token))?;
        if session.as_ref().is_some_and(|id| self.revoked.lock().unwrap_or_else(PoisonError::into_inner).contains(id)) {
            return None;
        }
        Some(session)
    }

    /// A URL serving `file`'s folder, so the page's own CSS/JS/images load.
    /// It is on the chat's own preview origin, never the app's or another
    /// chat's, so the page can't reach either. A page directly in a shared temp
    /// folder is refused: that would serve everything other programs leave there.
    fn preview_url(&self, session_id: &str, file: &Path) -> Result<String, String> {
        let dir = file.parent().unwrap_or(Path::new("/")).to_path_buf();
        if crate::ui_files::shared_temp_dir(&dir) {
            return Err(format!(
                "a page directly in {} can't be previewed (its whole folder would be served); put it in a folder of its own, with its assets",
                dir.display()
            ));
        }
        if self.revoked.lock().unwrap_or_else(PoisonError::into_inner).contains(session_id) {
            return Err("this chat was deleted".into());
        }
        let mut previews = self.previews.lock().unwrap_or_else(PoisonError::into_inner);
        let site = match previews.entry(session_id.to_owned()) {
            std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
            std::collections::hash_map::Entry::Vacant(e) => e.insert(PreviewSite::open()?),
        };
        let mut folders = site.folders.lock().unwrap_or_else(PoisonError::into_inner);
        let id = if let Some((id, _)) = folders.iter().find(|(_, d)| **d == dir) {
            id.clone()
        } else {
            let id = crate::session::random_token();
            folders.insert(id.clone(), dir);
            id
        };
        let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        Ok(format!("http://127.0.0.1:{}/preview/{id}/{}", site.port, encode_path(&name)))
    }

    /// Stop serving a chat's previews: its origin's listener is closed. The
    /// next preview in that chat opens a new one.
    pub fn close_previews(&self, session_id: &str) {
        let site = self.previews.lock().unwrap_or_else(PoisonError::into_inner).remove(session_id);
        drop(site);
    }

    /// A deleted chat: its UI MCP tokens are refused from now on (even ones an
    /// agent process still holds) and its preview origin closes. Only this
    /// server's chats: the hub that owns the chat calls it (`Hub::delete_session`).
    pub fn revoke(&self, session_id: &str) {
        self.revoked.lock().unwrap_or_else(PoisonError::into_inner).insert(session_id.to_owned());
        self.close_previews(session_id);
    }
}

pub fn start(host: Arc<UiHost>) -> Result<u16, String> {
    let server = Server::http("127.0.0.1:0").map_err(|e| format!("ui server: {e}"))?;
    let port = server.server_addr().to_ip().map(|a| a.port()).ok_or("ui server has no TCP port")?;
    let _ = host.port.set(port);
    host.hub.set_ui_host(Arc::downgrade(&host));
    std::thread::Builder::new()
        .name("yaah-ui-mcp".into())
        .spawn(move || {
            // A thread per request: `ui_ask` holds its request open until the user answers.
            for req in server.incoming_requests() {
                let host = host.clone();
                std::thread::spawn(move || handle(&host, req));
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(port)
}

fn header_value<'a>(req: &'a Request, name: &'static str) -> Option<&'a str> {
    req.headers().iter().find(|h| h.field.equiv(name)).map(|h| h.value.as_str())
}

/// Whether the request was addressed to this machine by a loopback name. A page
/// that rebinds its own hostname to 127.0.0.1 still sends its own name here.
fn loopback_host(req: &Request) -> bool {
    header_value(req, "host").is_some_and(|h| {
        let name = match h.rsplit_once(':') {
            Some((name, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => name,
            _ => h,
        };
        matches!(name, "127.0.0.1" | "localhost" | "[::1]")
    })
}

fn handle(host: &UiHost, mut req: Request) {
    // Browsers send Origin and MCP clients don't: no web page (a preview served
    // here, or a site rebinding its name to 127.0.0.1) gets to call tools.
    if header_value(&req, "origin").is_some() {
        let _ = req.respond(Response::from_string("no browser requests").with_status_code(403));
        return;
    }
    let token = req.url().strip_prefix("/mcp/").map(str::to_owned);
    let Some(session_id) = token.as_deref().and_then(|t| host.session_for(t)) else {
        let _ = req.respond(Response::empty(404));
        return;
    };
    if *req.method() != Method::Post {
        // No server-initiated stream; clients fall back to plain POST.
        let _ = req.respond(Response::empty(405).with_header(header("Allow", "POST")));
        return;
    }
    if req.body_length().is_some_and(|n| n > MAX_BODY) {
        let _ = req.respond(json_response(&rpc_error(&Value::Null, -32600, "request too large")).with_status_code(413));
        return;
    }
    let mut body = Vec::new();
    if req.as_reader().take(MAX_BODY as u64 + 1).read_to_end(&mut body).is_err() {
        let _ = req.respond(Response::empty(400));
        return;
    }
    if body.len() > MAX_BODY {
        let _ = req.respond(json_response(&rpc_error(&Value::Null, -32600, "request too large")).with_status_code(413));
        return;
    }
    let Ok(msg) = serde_json::from_slice::<Value>(&body) else {
        let _ = req.respond(json_response(&rpc_error(&Value::Null, -32700, "parse error")));
        return;
    };

    let reply = match msg {
        Value::Array(batch) => {
            let out: Vec<Value> = batch.iter().filter_map(|m| dispatch(host, session_id.as_deref(), m)).collect();
            (!out.is_empty()).then_some(Value::Array(out))
        }
        m => dispatch(host, session_id.as_deref(), &m),
    };
    let _ = match reply {
        Some(v) => req.respond(json_response(&v)),
        None => req.respond(Response::empty(202)),
    };
}

/// Handle one JSON-RPC message; `None` for notifications.
fn dispatch(host: &UiHost, session_id: Option<&str>, msg: &Value) -> Option<Value> {
    let id = msg.get("id").cloned()?;
    let method = msg["method"].as_str().unwrap_or_default();
    let params = &msg["params"];
    let result = match method {
        "initialize" => {
            let asked = params["protocolVersion"].as_str().unwrap_or_default();
            let version = PROTOCOL_VERSIONS.iter().find(|v| **v == asked).unwrap_or(&PROTOCOL_VERSIONS[0]);
            Ok(json!({
                "protocolVersion": version,
                "capabilities": { "tools": {}, "resources": {}, "prompts": {} },
                "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
                "instructions": INSTRUCTIONS,
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools() })),
        "tools/call" => Ok(call_tool(host, session_id, params["name"].as_str().unwrap_or_default(), &params["arguments"])),
        // yaah's skills (agent_guide.rs) for clients that read resources or prompts.
        "resources/list" => Ok(json!({ "resources": skill_resources() })),
        "resources/templates/list" => Ok(json!({ "resourceTemplates": [] })),
        "resources/read" => {
            let uri = params["uri"].as_str().unwrap_or_default();
            match uri.strip_prefix(SKILL_URI).and_then(agent_guide::skill) {
                Some(skill) => Ok(json!({ "contents": [{
                    "uri": uri, "mimeType": "text/markdown", "text": agent_guide::skill_text_cached(skill, &host.library.component_names()).as_str(),
                }] })),
                None => Err((-32002, format!("resource not found: {uri}"))),
            }
        }
        "prompts/list" => Ok(
            json!({ "prompts": agent_guide::SKILLS.iter().map(|s| json!({ "name": s.name, "description": agent_guide::skill_description(s) })).collect::<Vec<_>>() }),
        ),
        "prompts/get" => {
            let name = params["name"].as_str().unwrap_or_default();
            match agent_guide::skill(name) {
                Some(skill) => Ok(json!({
                    "description": agent_guide::skill_description(skill),
                    "messages": [{ "role": "user", "content": { "type": "text", "text": agent_guide::skill_text_cached(skill, &host.library.component_names()).as_str() } }],
                })),
                None => Err((-32602, format!("no prompt named {name}"))),
            }
        }
        _ => Err((-32601, format!("method not found: {method}"))),
    };
    Some(match result {
        Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
        Err((code, m)) => rpc_error(&id, code, &m),
    })
}

/// Where yaah's skills are served as MCP resources: `yaah://skills/<name>`.
const SKILL_URI: &str = "yaah://skills/";

fn skill_resources() -> Vec<Value> {
    agent_guide::SKILLS
        .iter()
        .map(|s| json!({ "uri": format!("{SKILL_URI}{}", s.name), "name": s.name, "description": agent_guide::skill_description(s), "mimeType": "text/markdown" }))
        .collect()
}

/// `ui_guide`: one of yaah's skills, or the short guide, with the components available now.
fn guide_topic(lib: &Library, topic: &str) -> Result<String, Vec<String>> {
    let names = lib.component_names();
    if topic == "guide" {
        return Ok(agent_guide::guide_text(&names));
    }
    agent_guide::skill(topic).map(|s| agent_guide::skill_text_cached(s, &names).as_str().to_owned()).ok_or_else(|| {
        let topics = agent_guide::SKILLS.iter().map(|s| s.topic).collect::<Vec<_>>().join(", ");
        vec![format!("no topic `{topic}`; topics are {topics}, and guide (the short version)")]
    })
}

/// An ad-hoc tree from tool arguments. Some clients send nested objects as JSON strings.
fn tree_arg(v: &Value) -> Option<Value> {
    match v {
        Value::Null => None,
        t => Some(decoded(t)),
    }
}

/// A value some clients send JSON-encoded (`"{\"type\":…}"`): decoded when it is
/// a JSON object or array, else as sent.
fn decoded(v: &Value) -> Value {
    match v {
        Value::String(s) if s.trim_start().starts_with(['{', '[']) => serde_json::from_str(s).unwrap_or_else(|_| v.clone()),
        other => other.clone(),
    }
}

/// A required string argument, or what's wrong with it.
fn text_field(obj: &serde_json::Map<String, Value>, k: &str, hint: &str, errs: &mut Vec<String>) -> String {
    match obj.get(k) {
        None | Some(Value::Null) => {
            errs.push(format!("{k} is required: {hint}"));
            String::new()
        }
        Some(Value::String(s)) => s.clone(),
        Some(v) => {
            errs.push(format!("{k} must be a string, got {}", crate::ui_library::shown(v)));
            String::new()
        }
    }
}

/// One of `ui_save_component`'s examples, or what's wrong with it.
fn example_arg(at: &str, ex: &Value, errs: &mut Vec<String>) -> Option<crate::ui_library::Example> {
    use crate::ui_library::shown;
    let Some(ex) = ex.as_object() else {
        errs.push(format!("{at} must be an object {{ title, props }}, got {}", shown(ex)));
        return None;
    };
    let title = match ex.get("title") {
        None | Some(Value::Null) => {
            errs.push(format!("{at}.title is required: a short name for the example"));
            String::new()
        }
        Some(Value::String(t)) => t.clone(),
        Some(t) => {
            errs.push(format!("{at}.title must be a string, got {}", shown(t)));
            String::new()
        }
    };
    let props = match ex.get("props").map(decoded) {
        None | Some(Value::Null) => {
            errs.push(format!("{at}.props is required: the props to render the example with (an object)"));
            Value::Null
        }
        Some(p @ Value::Object(_)) => p,
        Some(p) => {
            errs.push(format!("{at}.props must be an object, got {}", shown(&p)));
            Value::Null
        }
    };
    Some(crate::ui_library::Example { title, props })
}

/// `ui_save_component`'s arguments, checked field by field so every problem
/// comes back with its path and in plain words (`examples[0].title is required`),
/// not as a serde message. `tree`, `props` and `examples` may come JSON-encoded.
fn save_request(args: &Value) -> Result<SaveRequest, Vec<String>> {
    use crate::ui_library::shown;
    let Some(obj) = args.as_object() else {
        return Err(vec![format!("the arguments must be an object {{ name, description, props, tree, examples }}, got {}", shown(args))]);
    };
    let field = |k: &str| obj.get(k).filter(|v| !v.is_null());
    // Saving into an installed library is refused first, whatever else is wrong.
    if let Some(e) = obj.get("name").and_then(Value::as_str).and_then(crate::ui_library::qualified_save_error) {
        return Err(vec![e]);
    }
    let mut errs = vec![];
    let name = text_field(obj, "name", "a kebab-case name like `deploy-status`", &mut errs);
    let description = text_field(obj, "description", "what the component shows and when to use it", &mut errs);
    let props = match field("props").map(decoded) {
        None => json!({ "type": "object", "properties": {} }),
        Some(p @ Value::Object(_)) => p,
        Some(p) => {
            errs.push(format!("props must be a JSON Schema object like {{ \"type\": \"object\", \"properties\": {{…}} }}, got {}", shown(&p)));
            Value::Null
        }
    };
    let tree = match field("tree").map(decoded) {
        None => {
            errs.push("tree is required: the component's node tree, like { \"type\": \"card\", \"children\": [...] }".into());
            Value::Null
        }
        Some(Value::String(_)) => {
            errs.push(
                "tree must be a node object like { \"type\": \"card\", \"children\": [...] }, not a string: a component's tree can't be \
                 plain text, and a tree sent as a string must be valid JSON"
                    .into(),
            );
            Value::Null
        }
        Some(t) => t,
    };
    let examples = match field("examples").map(decoded) {
        None => vec![],
        Some(Value::Array(items)) => items.iter().enumerate().filter_map(|(i, ex)| example_arg(&format!("examples[{i}]"), ex, &mut errs)).collect(),
        Some(other) => {
            errs.push(format!("examples must be an array of {{ title, props }}, got {}", shown(&other)));
            vec![]
        }
    };
    let change_note = match field("changeNote") {
        None => None,
        Some(Value::String(n)) => Some(n.clone()),
        Some(v) => {
            errs.push(format!("changeNote must be a string, got {}", shown(v)));
            None
        }
    };
    let expected_version = field("expectedVersion").and_then(|v| {
        let n = v.as_u64().or_else(|| v.as_str().and_then(|s| s.trim().trim_start_matches('v').parse().ok())).and_then(|n| u32::try_from(n).ok());
        if n.is_none() {
            errs.push(format!("expectedVersion must be the version number you read (an integer), got {}", shown(v)));
        }
        n
    });
    if !errs.is_empty() {
        return Err(errs);
    }
    Ok(SaveRequest { name, description, props, tree, examples, change_note, expected_version })
}

/// An error as `{ path, message }`: the path is the leading `tree.children[0]`
/// (or the field an error starts with), empty when it is about the whole call.
fn error_parts(err: &str) -> Value {
    const FIELDS: &[&str] = &["name", "description", "props", "tree", "examples", "changeNote", "expectedVersion", "component", "id", "title"];
    let path_like = |p: &str| {
        let head = p.split(['.', '[']).next().unwrap_or_default();
        FIELDS.contains(&head) && p.chars().all(|c| c.is_ascii_alphanumeric() || "_.[]-".contains(c))
    };
    if let Some((path, message)) = err.split_once(": ")
        && path_like(path)
    {
        return json!({ "path": path, "message": message });
    }
    if let Some((path, _)) = err.split_once(' ')
        && path_like(path)
    {
        return json!({ "path": path, "message": err });
    }
    json!({ "path": "", "message": err })
}

/// A UI transcript entry for a prepared render.
fn ui_entry(p: Prepared, ui_id: Option<String>, ask_id: Option<String>, title: Option<String>) -> Entry {
    Entry::Ui {
        ui_id,
        ask_id,
        answer: None,
        draft: None,
        draft_by: None,
        title,
        component: p.component,
        version: p.version,
        tree: p.tree,
        props: p.props,
    }
}

/// At most `max` bytes of `text`, cut on a character boundary, saying how much there was.
fn clip(text: String, max: usize) -> String {
    if text.len() <= max {
        return text;
    }
    format!("{}… (truncated; {} bytes in full)", &text[..text.floor_char_boundary(max)], text.len())
}

fn call_tool(host: &UiHost, session_id: Option<&str>, name: &str, args: &Value) -> Value {
    // Only reachable before session/new returns, which no agent should render during.
    let session_id = session_id.unwrap_or_default();
    let lib = &host.library;
    let str_arg = |k: &str| args[k].as_str().map(str::to_owned);
    let outcome: Result<String, Vec<String>> = match name {
        "ui_catalog" => lib
            .catalog_json()
            .map(|c| {
                // The library's part is built once per change; this app's connections (by name only) go on the end.
                let connections = serde_json::to_string(&host.sources.connections()).unwrap_or_else(|_| "[]".into());
                let library = c.trim_end().strip_suffix('}').unwrap_or("{");
                format!("{library},\"connections\":{connections}}}")
            })
            .map_err(|e| vec![e]),
        // This runs on the request's own thread (not an async worker), so blocking on it is fine.
        "source_read" => tauri::async_runtime::block_on(host.sources.read(&args["source"]))
            // Enough to design UI from; the live UI reads the full data itself.
            .map(|v| clip(v.to_string(), MAX_SOURCE_TEXT))
            .map_err(|e| vec![e]),
        "ui_guide" => guide_topic(lib, args["topic"].as_str().unwrap_or("ui")),
        "ui_get_component" => match lib.get(args["name"].as_str().unwrap_or_default()) {
            Ok(Some(c)) => Ok(serde_json::to_string(&c).unwrap_or_default()),
            Ok(None) => Err(vec![format!("no component named `{}`; call ui_catalog", args["name"])]),
            Err(e) => Err(vec![e]),
        },
        "ui_render" => lib.prepare(args["component"].as_str(), decoded(&args["props"]), tree_arg(&args["tree"])).map(|mut p| {
            let what = p.component.clone().map_or("ad-hoc UI".to_owned(), |c| format!("`{c}` v{}", p.version.unwrap_or(0)));
            let refused = inline_files(host, session_id, &mut p.tree, &mut p.props);
            let updated = host.hub.push_ui(session_id, ui_entry(p, str_arg("id"), None, str_arg("title")));
            let mut msg = if updated {
                format!("Updated {what} in place (id {}).", args["id"])
            } else {
                format!("Rendered {what} in the chat. The user can see it now; don't repeat its content in prose.")
            };
            if !refused.is_empty() {
                let _ = write!(msg, "\nThese file paths were not inlined:\n- {}", refused.join("\n- "));
            }
            msg
        }),
        "ui_ask" => match lib.prepare(args["component"].as_str(), decoded(&args["props"]), tree_arg(&args["tree"])) {
            Err(e) => Err(e),
            Ok(p) if !p.tree.to_string().contains(r#""type":"form""#) => {
                Err(vec!["ui_ask needs a `form` (with inputs) in the UI; use ui_render to only show something".into()])
            }
            Ok(mut p) => {
                inline_files(host, session_id, &mut p.tree, &mut p.props);
                let (ask_id, answers) = host.hub.register_ask(session_id);
                host.hub.push_ui(session_id, ui_entry(p, str_arg("id"), Some(ask_id.clone()), str_arg("title")));
                match answers.recv_timeout(ASK_TIMEOUT) {
                    Ok(Some(values)) => Ok(format!(
                        "The user answered:\n{}\nContinue with this; the form now shows their answer, so don't repeat it back.",
                        serde_json::to_string_pretty(&values).unwrap_or_default()
                    )),
                    Ok(None) => Ok("The user cancelled instead of answering. Stop and wait for their next message.".into()),
                    Err(_) => {
                        host.hub.drop_ask(&ask_id);
                        Ok("No answer within an hour. The form stays open in the chat; ask in prose or carry on with sensible defaults.".into())
                    }
                }
            }
        },
        "ui_get_values" => {
            host.hub.form(session_id, FormRef::UiId(args["id"].as_str().unwrap_or_default())).map(|s| s.to_string()).map_err(|e| vec![e])
        }
        "ui_set_values" => host
            .hub
            .edit_form(session_id, FormRef::UiId(args["id"].as_str().unwrap_or_default()), &args["values"], "agent")
            .map(|s| format!("Set. The user sees your values in the form, marked as yours, and can change them.\n{s}"))
            .map_err(|e| vec![e]),
        "ui_save_component" => match save_request(args) {
            Err(errs) => Err(errs),
            Ok(req) => {
                let preview = args["preview"].as_bool().unwrap_or(true);
                lib.save(req).map(|c| {
                    if preview
                        && let Some(ex) = c.examples.first()
                        && let Ok(mut p) = lib.prepare(Some(&c.name), ex.props.clone(), None)
                    {
                        inline_files(host, session_id, &mut p.tree, &mut p.props);
                        let title = format!("{} v{} · {}", c.name, c.version, ex.title);
                        host.hub.push_ui(session_id, ui_entry(p, None, None, Some(title)));
                    }
                    // The skills agents get list the components available.
                    if let Some(guide) = host.hub.guide() {
                        guide.sync_in_background();
                    }
                    format!(
                        "Saved `{}` v{} to the library{}.",
                        c.name,
                        c.version,
                        if preview && !c.examples.is_empty() { " and rendered its first example as a preview" } else { "" }
                    )
                })
            }
        },
        other => Err(vec![format!("unknown tool {other}")]),
    };
    match outcome {
        Ok(text) => json!({ "content": [{ "type": "text", "text": text }] }),
        Err(errs) => json!({
            "content": [{ "type": "text", "text": format!("Fix these and call again:\n- {}", errs.join("\n- ")) }],
            // The same, for clients that read structured results: where, and what to fix.
            "structuredContent": { "errors": errs.iter().map(|e| error_parts(e)).collect::<Vec<_>>() },
            "isError": true,
        }),
    }
}

fn tools() -> Value {
    json!([
        {
            "name": "ui_catalog",
            "description": "List the UI primitives (with their props), the tree/binding syntax, and every component in the shared library. Call before rendering or building UI.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "ui_guide",
            "description": "How to build UI in yaah: when to use it, the patterns (update in place by id, forms that wait for the user, filling a form in together, pointing with find, live data), fixing validation errors, and an index of every primitive and component. Read it before your first render if you haven't used yaah's UI in this chat. topic: `ui` (default), `components` (saving reusable components: props schema, examples, versions, libraries) or `guide` (the short version).",
            "inputSchema": { "type": "object", "properties": { "topic": { "type": "string", "enum": ["ui", "components", "guide"] } } },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "ui_get_component",
            "description": "Get one library component in full: its tree, props schema, examples and version. Read it before improving it.",
            "inputSchema": { "type": "object", "properties": { "name": { "type": "string" } }, "required": ["name"] },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "ui_render",
            "description": "Show UI inline in the chat: either a library `component` with `props`, or an ad-hoc `tree` for a one-off.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "component": { "type": "string", "description": "Component name (`library/name` for an installed library's)." },
                    "props": { "type": "object", "description": "Props for the component (checked against its schema)." },
                    "tree": { "type": "object", "description": "Ad-hoc node tree, for one-offs. See ui_catalog for the syntax." },
                    "title": { "type": "string", "description": "Optional caption shown above the UI." },
                    "id": { "type": "string", "description": "Your id for this UI. Rendering again with the same id updates it in place instead of adding a new one: use it for live status (sub-agents, long jobs) and progress." }
                }
            }
        },
        {
            "name": "source_read",
            "description": "Read a data source the app can fetch itself: this machine (`system`), Docker (`docker.containers`, `docker.stats`, `docker.logs`) or a database the user connected (`postgres.schema`, `postgres.query`, read-only). Use it to see the data before designing UI, then show it with a `live` node bound to the same source so it stays fresh without you. ui_catalog lists the sources and the connection names.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "source": { "type": "object", "description": "e.g. { \"kind\": \"postgres.query\", \"connection\": \"shop\", \"sql\": \"select …\" }" }
                },
                "required": ["source"]
            },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "ui_ask",
            "description": "Ask the user for structured input with a form and WAIT for their answer, which comes back as JSON so you can continue in the same turn. Use instead of asking in prose whenever the answer is a choice, several choices, a ranking, a number or a few short fields. Same arguments as ui_render; the UI must contain a `form`.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "component": { "type": "string", "description": "Library component (containing a form)." },
                    "props": { "type": "object" },
                    "tree": { "type": "object", "description": "Ad-hoc tree with a `form` of inputs (textfield, choice, select, slider, rank, toggle)." },
                    "title": { "type": "string", "description": "What you are asking, shown above the form." },
                    "id": { "type": "string" }
                }
            }
        },
        {
            "name": "ui_get_values",
            "description": "Read a form you rendered (ui_render with an `id`) as it stands now: every field's current value, which ones the user or you changed last (`editedBy`), and whether it was sent. Use it to see what the user has filled in so far, without waiting for them to send it.",
            "inputSchema": { "type": "object", "properties": { "id": { "type": "string", "description": "The id you rendered the form with." } }, "required": ["id"] },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "ui_set_values",
            "description": "Fill in or change fields of a form you rendered (ui_render with an `id`) while the user works on it too: they see your values appear, marked as yours, and can change them; the last change to a field wins. Use it to draft answers, suggest values, or correct something, so you and the user fill one form together. Sent forms are locked.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "The id you rendered the form with." },
                    "values": { "type": "object", "description": "Field name → value: a string for textfield and select, the option value (or list of values with multiple) for choice, a number for slider, true/false for toggle, the ordered list for rank." }
                },
                "required": ["id", "values"]
            }
        },
        {
            "name": "ui_save_component",
            "description": "Create a component in the user's own collection, or improve one there (pass expectedVersion = the version you read). Names are unqualified: installed libraries' `library/name` components are read-only. Saved components are shared by every chat. By default renders its first example as a preview.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "kebab-case, e.g. deploy-status" },
                    "description": { "type": "string", "description": "What it shows and when to use it." },
                    "props": { "type": "object", "description": "JSON Schema for the props: { type: 'object', properties, required }." },
                    "tree": { "type": "object", "description": "Node tree using primitives, existing components and {{bindings}} to props." },
                    "examples": { "type": "array", "description": "[{ title, props }] — at least one.", "items": { "type": "object" } },
                    "changeNote": { "type": "string", "description": "What changed and why (for updates)." },
                    "expectedVersion": { "type": "integer", "description": "Required when updating: the version you read." },
                    "preview": { "type": "boolean", "description": "Render the first example in the chat. Default true." }
                },
                "required": ["name", "description", "tree"]
            }
        }
    ])
}

fn rpc_error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn json_response(v: &Value) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_string(v.to_string()).with_header(header("Content-Type", "application/json"))
}

fn header(k: &str, v: &str) -> Header {
    Header::from_bytes(k.as_bytes(), v.as_bytes()).expect("static header")
}

/// Turn the local screenshot and page paths `image` and `browser` nodes show
/// into data URLs and preview URLs, limited to the chat's folders.
fn inline_files(host: &UiHost, session_id: &str, tree: &mut Value, props: &mut Value) -> Vec<String> {
    let roots = host.hub.session_roots(session_id);
    crate::ui_files::inline(tree, props, &roots, &|p: &Path| host.preview_url(session_id, p))
}

/// A previewed page may load what it likes from the web (CDN scripts, styles,
/// fonts, images) but only talk to its own folder: no fetch, XHR or WebSocket
/// elsewhere, no form posts, no popups or top-level navigation (`sandbox`
/// without `allow-popups`/`allow-top-navigation`; the same flags as the iframe in the chat).
const PREVIEW_CSP: &str = "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https:; connect-src 'self'; form-action 'none'; \
    frame-ancestors *; sandbox allow-scripts allow-forms allow-modals allow-same-origin";

/// The file `rest` names inside the preview folder `dir`: never outside it (no
/// `../`, no symlink out), and never a hidden file or folder (`.env`, `.git`).
fn preview_file(dir: &Path, rest: &str) -> Option<PathBuf> {
    let root = dir.canonicalize().ok()?;
    let mut path = root.join(rest).canonicalize().ok()?;
    if path.is_dir() {
        path = path.join("index.html").canonicalize().ok()?;
    }
    let inside = path.strip_prefix(&root).ok()?;
    let hidden = inside.components().any(|c| c.as_os_str().to_string_lossy().starts_with('.'));
    (!hidden && path.is_file() && web_asset(&path)).then_some(path)
}

/// GET /preview/<id>/<path>: a file from one of the chat's preview folders.
fn serve_preview(folders: &Mutex<HashMap<String, PathBuf>>, req: Request) {
    if *req.method() != Method::Get {
        let _ = req.respond(Response::empty(405).with_header(header("Allow", "GET")));
        return;
    }
    if !loopback_host(&req) {
        let _ = req.respond(Response::from_string("not found").with_status_code(404));
        return;
    }
    let url = req.url().split(['?', '#']).next().unwrap_or_default().to_owned();
    let mut parts = url.trim_start_matches("/preview/").splitn(2, '/');
    let (id, rest) = (parts.next().unwrap_or_default(), decode_path(parts.next().unwrap_or_default()));
    let dir = url.starts_with("/preview/").then(|| folders.lock().unwrap_or_else(PoisonError::into_inner).get(id).cloned()).flatten();
    let file = dir.and_then(|dir| preview_file(&dir, &rest)).and_then(|path| std::fs::File::open(&path).ok().map(|f| (path, f)));
    let _ = match file {
        // Streamed, not read whole.
        Some((path, f)) => req.respond(
            Response::from_file(f)
                .with_header(header("Content-Type", content_type(&path)))
                .with_header(header("Cache-Control", "no-store"))
                .with_header(header("Content-Security-Policy", PREVIEW_CSP))
                .with_header(header("X-Content-Type-Options", "nosniff")),
        ),
        None => req.respond(Response::from_string("not found").with_status_code(404)),
    };
}

/// The type a preview serves a file as; `None` for anything that isn't a
/// static web asset (sources, data, keys…), which isn't served at all.
fn web_type(path: &Path) -> Option<&'static str> {
    Some(match path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase().as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "txt" => "text/plain; charset=utf-8",
        "wasm" => "application/wasm",
        _ => return None,
    })
}

fn web_asset(path: &Path) -> bool {
    web_type(path).is_some()
}

fn content_type(path: &Path) -> &'static str {
    web_type(path).unwrap_or("application/octet-stream")
}

fn encode_path(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn decode_path(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(b) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("zz"), 16)
        {
            out.push(b);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::SessionInfo;
    use crate::ui_library::{Bundled, LocalDir};
    use std::io::Write;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("yaah-uimcp-{tag}-{}", crate::session::random_token()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// One raw HTTP exchange; `head` is the request line and headers, without the blank line.
    /// Status 0: nothing listens there any more.
    fn exchange(port: u16, head: &str, body: &str) -> (u16, String) {
        let Ok(mut s) = std::net::TcpStream::connect(("127.0.0.1", port)) else { return (0, String::new()) };
        let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(5)));
        if write!(s, "{head}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).is_err() {
            return (0, String::new());
        }
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
        let status = out.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
        let (head, mut body) = out.split_once("\r\n\r\n").map(|(h, b)| (h.to_ascii_lowercase(), b.to_owned())).unwrap_or_default();
        if head.contains("transfer-encoding: chunked") {
            // Large answers come chunked: `<hex size>\r\n<data>\r\n`… until a zero.
            let mut plain = String::new();
            let mut rest = body.as_str();
            while let Some((size, after)) = rest.split_once("\r\n") {
                let n = usize::from_str_radix(size.trim(), 16).unwrap_or(0);
                if n == 0 {
                    break;
                }
                plain.push_str(&after[..n]);
                rest = &after[n + 2..];
            }
            body = plain;
        }
        (status, body)
    }

    fn get(port: u16, path: &str, host: &str) -> (u16, String) {
        exchange(port, &format!("GET {path} HTTP/1.1\r\nHost: {host}"), "")
    }

    fn rpc(port: u16, msg: &Value) -> (u16, Value) {
        rpc_as(port, "tok", msg)
    }

    fn rpc_as(port: u16, token: &str, msg: &Value) -> (u16, Value) {
        let (status, body) =
            exchange(port, &format!("POST /mcp/{token} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json"), &msg.to_string());
        (status, serde_json::from_str(&body).unwrap_or(Value::Null))
    }

    /// A tool's text, and whether it was an error.
    fn call(port: u16, name: &str, args: &Value) -> (String, bool) {
        let (text, err, _) = call_full(port, "tok", name, args);
        (text, err)
    }

    /// A tool's text, whether it was an error, and its structured content.
    fn call_full(port: u16, token: &str, name: &str, args: &Value) -> (String, bool, Value) {
        let (_, reply) =
            rpc_as(port, token, &json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { "name": name, "arguments": args } }));
        let result = &reply["result"];
        (result["content"][0]["text"].as_str().unwrap_or_default().to_owned(), result["isError"] == true, result["structuredContent"].clone())
    }

    /// The UI server with two chats in `cwd` (restored from disk, as at startup):
    /// `s1` at `/mcp/tok` and `s2` at `/mcp/tok2`.
    fn serve_chat(cwd: &Path) -> (Arc<Hub>, Arc<UiHost>, u16) {
        let dir = temp_dir("app");
        std::fs::create_dir_all(dir.join("sessions")).unwrap();
        for id in ["s1", "s2"] {
            let info = SessionInfo {
                session_id: id.into(),
                project_id: None,
                created_at: 0,
                account_id: "default".into(),
                cwd: cwd.to_string_lossy().into_owned(),
                additional_dirs: vec![],
                title: "t".into(),
                running: false,
                stop_reason: None,
                commands: vec![],
            };
            std::fs::write(dir.join(format!("sessions/{id}.json")), json!({ "info": info, "entries": [] }).to_string()).unwrap();
        }
        let hub = Arc::new(Hub::with_store(Arc::new(|_: &str, _: Value| {}), dir.join("sessions")));
        let library = Arc::new(Library::with_sources(vec![Box::new(Bundled::new()), Box::new(LocalDir::new(dir.join("components")))]));
        let sources = Arc::new(crate::sources::Sources::with_connections_file(dir.join("connections.json")));
        let host = Arc::new(UiHost::new(hub.clone(), library, sources));
        host.test_tokens.lock().unwrap().insert("tok".into(), "s1".into());
        host.test_tokens.lock().unwrap().insert("tok2".into(), "s2".into());
        let port = start(host.clone()).unwrap();
        hub.set_ui_port(port);
        (hub, host, port)
    }

    fn entries(hub: &Hub) -> Vec<Value> {
        hub.transcript("s1").unwrap().entries.iter().map(|e| serde_json::to_value(e).unwrap()).collect()
    }

    #[test]
    fn the_mcp_endpoint_checks_token_origin_method_and_size() {
        let (_, _, port) = serve_chat(&temp_dir("cwd"));
        let init = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26" } }).to_string();
        let send = |path: &str, extra: &str| exchange(port, &format!("POST {path} HTTP/1.1\r\nHost: 127.0.0.1{extra}"), &init).0;
        assert_eq!(send("/mcp/tok", ""), 200);
        assert_eq!(send("/mcp/wrong", ""), 404, "an unknown token gets nothing");
        assert_eq!(send("/elsewhere", ""), 404);
        assert_eq!(send("/mcp/tok", "\r\nOrigin: https://evil.example"), 403, "no web page calls tools");
        assert_eq!(send("/mcp/tok", &format!("\r\nOrigin: http://127.0.0.1:{port}")), 403, "not even a preview served here");
        assert_eq!(exchange(port, "GET /mcp/tok HTTP/1.1\r\nHost: 127.0.0.1", "").0, 405);

        // Too large: refused from the header, before anything is read.
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "POST /mcp/tok HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", MAX_BODY + 1).unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
        assert!(out.starts_with("HTTP/1.1 413"), "{out}");

        let (status, reply) = exchange(port, "POST /mcp/tok HTTP/1.1\r\nHost: 127.0.0.1", "{ not json");
        assert_eq!((status, serde_json::from_str::<Value>(&reply).unwrap()["error"]["code"].as_i64()), (200, Some(-32700)));
    }

    #[test]
    fn speaks_json_rpc() {
        let (_, _, port) = serve_chat(&temp_dir("cwd"));
        let (_, init) = rpc(port, &json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26" } }));
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(init["result"]["serverInfo"]["name"], SERVER_NAME);
        let (_, init) = rpc(port, &json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "1999-01-01" } }));
        assert_eq!(init["result"]["protocolVersion"], PROTOCOL_VERSIONS[0], "an unknown version gets the newest");
        let (_, list) = rpc(port, &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }));
        let names: Vec<&str> = list["result"]["tools"].as_array().unwrap().iter().filter_map(|t| t["name"].as_str()).collect();
        assert_eq!(names.len(), 9);
        assert!(names.contains(&"ui_ask") && names.contains(&"source_read") && names.contains(&"ui_guide"));
        let (_, nope) = rpc(port, &json!({ "jsonrpc": "2.0", "id": 3, "method": "sampling/createMessage" }));
        assert_eq!(nope["error"]["code"], -32601);
        let (status, _) = rpc(port, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
        assert_eq!(status, 202, "a notification gets no reply");
        let (_, batch) = rpc(
            port,
            &json!([{ "jsonrpc": "2.0", "id": 4, "method": "ping" }, { "jsonrpc": "2.0", "method": "notifications/x" }, { "jsonrpc": "2.0", "id": 5, "method": "ping" }]),
        );
        assert_eq!(batch.as_array().map(Vec::len), Some(2));
        assert_eq!(call(port, "ui_nope", &json!({})), ("Fix these and call again:\n- unknown tool ui_nope".into(), true));
    }

    /// The route every agent gets: the server's instructions point at the skills,
    /// served as a tool, as resources and as prompts.
    #[test]
    fn serves_yaahs_skills_to_every_agent() {
        let (_, _, port) = serve_chat(&temp_dir("cwd"));
        let (_, init) = rpc(port, &json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18" } }));
        let instructions = init["result"]["instructions"].as_str().unwrap();
        for must in ["running inside yaah", "Never run `open`", "standalone HTML", "`browser`", "ToolSearch", "ui_guide", "yaah://skills/yaah-ui"] {
            assert!(instructions.contains(must), "the instructions say {must}");
        }
        assert_eq!(init["result"]["capabilities"], json!({ "tools": {}, "resources": {}, "prompts": {} }));

        let (text, err) = call(port, "ui_guide", &json!({}));
        assert!(!err && text.starts_with("---\nname: yaah-ui\n"), "{text}");
        assert!(text.contains("test-report"), "the index lists the components available");
        let (text, _) = call(port, "ui_guide", &json!({ "topic": "components" }));
        assert!(text.contains("name: yaah-components") && text.contains("expectedVersion"));
        assert!(call(port, "ui_guide", &json!({ "topic": "guide" })).0.starts_with("# You are running inside yaah"));
        let (text, err) = call(port, "ui_guide", &json!({ "topic": "nope" }));
        assert!(err && text.contains("topics are ui, components"), "{text}");

        let (_, list) = rpc(port, &json!({ "jsonrpc": "2.0", "id": 2, "method": "resources/list" }));
        let uris: Vec<&str> = list["result"]["resources"].as_array().unwrap().iter().filter_map(|r| r["uri"].as_str()).collect();
        assert_eq!(uris, ["yaah://skills/yaah-ui", "yaah://skills/yaah-components"]);
        let (_, read) = rpc(port, &json!({ "jsonrpc": "2.0", "id": 3, "method": "resources/read", "params": { "uri": "yaah://skills/yaah-ui" } }));
        let content = &read["result"]["contents"][0];
        assert_eq!((content["uri"].as_str(), content["mimeType"].as_str()), (Some("yaah://skills/yaah-ui"), Some("text/markdown")));
        assert!(content["text"].as_str().unwrap().contains("## Primitives"));
        let (_, missing) = rpc(port, &json!({ "jsonrpc": "2.0", "id": 4, "method": "resources/read", "params": { "uri": "file:///etc/passwd" } }));
        assert_eq!(missing["error"]["code"], -32002);

        let (_, prompts) = rpc(port, &json!({ "jsonrpc": "2.0", "id": 5, "method": "prompts/list" }));
        assert_eq!(prompts["result"]["prompts"][1]["name"], "yaah-components");
        let (_, got) = rpc(port, &json!({ "jsonrpc": "2.0", "id": 6, "method": "prompts/get", "params": { "name": "yaah-ui" } }));
        assert!(got["result"]["messages"][0]["content"]["text"].as_str().unwrap().contains("name: yaah-ui"));
        let (_, missing) = rpc(port, &json!({ "jsonrpc": "2.0", "id": 7, "method": "prompts/get", "params": { "name": "x" } }));
        assert_eq!(missing["error"]["code"], -32602);
    }

    #[test]
    fn ui_render_explains_what_to_fix_and_renders_in_place() {
        let cwd = temp_dir("cwd");
        let (hub, _, port) = serve_chat(&cwd);

        let (text, err) = call(port, "ui_render", &json!({ "tree": { "type": "badge", "props": { "variant": "loud" } } }));
        assert!(err && text.contains("`badge` needs prop `text`") && text.contains("`loud` isn't one of"), "{text}");
        let mut deep = json!("leaf");
        for _ in 0..40 {
            deep = json!({ "type": "stack", "children": [deep] });
        }
        assert!(call(port, "ui_render", &json!({ "tree": deep })).0.contains("nested more than 30 deep"));
        let wide = json!({ "type": "stack", "children": vec![json!({ "type": "text", "props": { "text": "x" } }); 3_500] });
        let (text, _) = call(port, "ui_render", &json!({ "tree": wide }));
        assert_eq!(text.matches("more than 3000 nodes").count(), 1, "{text}");
        let (text, _) = call(port, "ui_render", &json!({ "tree": { "type": "badge", "props": { "text": vec!["long"; 500] } } }));
        assert!(text.len() < 400, "the agent's own huge value isn't echoed back: {} bytes", text.len());
        assert!(call(port, "ui_render", &json!({ "component": "json-view", "tree": { "type": "text" } })).0.contains("not both"));
        assert!(entries(&hub).is_empty(), "nothing invalid reaches the chat");

        // A tree sent as a JSON string, with an id: rendered, then updated in place.
        let tree = json!({ "type": "badge", "props": { "text": "deploying" } }).to_string();
        let (text, err) = call(port, "ui_render", &json!({ "tree": tree, "id": "deploy", "title": "Deploy" }));
        assert!(!err && text.starts_with("Rendered ad-hoc UI"), "{text}");
        let (text, _) = call(port, "ui_render", &json!({ "tree": { "type": "badge", "props": { "text": "done" } }, "id": "deploy" }));
        assert!(text.starts_with("Updated ad-hoc UI in place"), "{text}");
        let e = entries(&hub);
        assert_eq!(e.len(), 1);
        assert_eq!(e[0]["tree"]["props"]["text"], "done");

        // Screenshots inside the chat's folder are inlined; others are refused with a reason.
        std::fs::write(cwd.join("shot.png"), [137u8, 80, 78, 71]).unwrap();
        let shot = cwd.join("shot.png").canonicalize().unwrap();
        let (text, _) = call(port, "ui_render", &json!({ "tree": { "type": "image", "props": { "src": shot, "alt": "a" } } }));
        assert!(!text.contains("not inlined"), "{text}");
        assert!(entries(&hub)[1]["tree"]["props"]["src"].as_str().unwrap().starts_with("data:image/png;base64,"));
        let (text, _) = call(port, "ui_render", &json!({ "tree": { "type": "image", "props": { "src": "/etc/hosts.png", "alt": "a" } } }));
        assert!(text.contains("These file paths were not inlined:\n- /etc/hosts.png"), "{text}");
    }

    #[test]
    fn ui_ask_waits_for_the_answer_and_stop_releases_it() {
        let (hub, _, port) = serve_chat(&temp_dir("cwd"));
        let form = json!({ "type": "form", "children": [{ "type": "textfield", "props": { "name": "title", "label": "Title" } }] });
        assert!(call(port, "ui_ask", &json!({ "tree": { "type": "text", "props": { "text": "hi" } } })).0.contains("needs a `form`"));

        let asking = std::thread::spawn({
            let form = form.clone();
            move || call(port, "ui_ask", &json!({ "tree": form, "title": "Name it" }))
        });
        let index = wait_for_ask(&hub);
        assert!(!asking.is_finished(), "ui_ask waits for the user");
        tauri::async_runtime::block_on(hub.answer_ui("s1", index, json!({ "title": "Refunds" }))).unwrap();
        let (text, err) = asking.join().unwrap();
        assert!(!err && text.contains("The user answered") && text.contains("Refunds"), "{text}");

        let asking = std::thread::spawn(move || call(port, "ui_ask", &json!({ "tree": form })));
        wait_for_ask(&hub);
        hub.cancel("s1").unwrap();
        assert!(asking.join().unwrap().0.contains("cancelled"));
    }

    fn wait_for_ask(hub: &Hub) -> usize {
        for _ in 0..500 {
            if let Some(i) = entries(hub).iter().rposition(|e| e["askId"].is_string() && e["answer"].is_null()) {
                return i;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("the ask never reached the chat");
    }

    #[test]
    fn library_tools_and_sources() {
        let (hub, _, port) = serve_chat(&temp_dir("cwd"));
        let (catalog, _) = call(port, "ui_catalog", &json!({}));
        let catalog: Value = serde_json::from_str(&catalog).unwrap();
        assert_eq!(catalog["connections"], json!([]), "this app's connections, by name only");
        assert!(catalog["components"].as_array().unwrap().iter().any(|c| c["name"] == "json-view"));
        assert!(call(port, "ui_get_component", &json!({ "name": "json-view" })).0.contains("\"source\":\"yaah\""));
        assert!(call(port, "ui_get_component", &json!({ "name": "nope" })).1);

        let save = json!({ "name": "env-badge", "description": "Shows which environment a deploy targets",
            "props": { "type": "object", "properties": { "env": { "type": "string" } }, "required": ["env"] },
            "tree": { "type": "badge", "props": { "text": "{{env}}" } }, "examples": [{ "title": "prod", "props": { "env": "prod" } }] });
        let (text, err) = call(port, "ui_save_component", &save);
        assert!(!err && text.contains("Saved `env-badge` v1") && text.contains("preview"), "{text}");
        assert_eq!(entries(&hub)[0]["title"], "env-badge v1 · prod");
        let (text, err) = call(port, "ui_save_component", &json!({ "name": 3 }));
        assert!(err && text.contains("name must be a string, got 3") && text.contains("tree is required"), "{text}");
        let (text, err) = call(port, "ui_save_component", &json!({ "name": "acme/env-badge", "description": "x", "tree": "x" }));
        assert!(err && text.contains("Copy it to the collection first"), "{text}");

        let (text, err) = call(port, "source_read", &json!({ "source": { "kind": "system" } }));
        assert!(!err && text.contains("memTotalGb"), "{text}");
        assert!(
            call(port, "source_read", &json!({ "source": { "kind": "postgres.query", "connection": "prod", "sql": "select 1" } }))
                .0
                .contains("no connection named `prod`")
        );
    }

    #[test]
    fn only_ui_tools_skip_the_permission_prompt() {
        let allowed = allowed_tools();
        assert!(!allowed.iter().any(|t| t == "mcp__yaah-ui"), "never the whole server");
        assert!(!allowed.iter().any(|t| t.ends_with("source_read")), "reading data sources asks the user");
        let tools = tools();
        let names: Vec<&str> = tools.as_array().unwrap().iter().filter_map(|t| t["name"].as_str()).collect();
        for t in NO_PROMPT_TOOLS {
            assert!(names.contains(t), "`{t}` is a real tool: {names:?}");
        }
        assert_eq!(allowed.len(), names.len() - 1, "every tool but source_read: {allowed:?}");
        assert!(allowed.contains(&"mcp__yaah-ui__ui_render".to_owned()));
    }

    #[test]
    fn pages_directly_in_the_temp_folder_are_not_previewed() {
        let (_, host, _) = serve_chat(&temp_dir("cwd"));
        let loose = std::env::temp_dir().join(format!("yaah-loose-{}.html", crate::session::random_token()));
        std::fs::write(&loose, "<p>hi</p>").unwrap();
        let e = host.preview_url("s1", &loose).unwrap_err();
        assert!(e.contains("can't be previewed") && e.contains("folder of its own"), "{e}");
        assert!(host.preview_url("s1", Path::new("/tmp/page.html")).is_err());
        assert!(host.previews.lock().unwrap().is_empty(), "nothing registered, no origin opened");
        let own = temp_dir("own-folder");
        assert!(host.preview_url("s1", &own.join("index.html")).is_ok(), "a folder of its own in temp is fine");
        let _ = std::fs::remove_file(loose);
    }

    #[test]
    fn ui_get_values_never_returns_file_contents() {
        let cwd = temp_dir("cwd");
        let (_, _, port) = serve_chat(&cwd);
        let secret = cwd.join("secret.png");
        std::fs::write(&secret, b"top secret").unwrap();
        let secret = secret.canonicalize().unwrap().to_string_lossy().into_owned();
        let form = json!({ "type": "form", "children": [
            { "type": "textfield", "props": { "name": "where", "label": "Where", "default": secret } },
            { "type": "textfield", "props": { "name": "bound", "label": "Bound", "default": "{{p}}" } },
            { "type": "image", "props": { "src": secret, "alt": "shown" } }
        ] });
        let (text, err) = call(port, "ui_render", &json!({ "tree": form, "props": { "p": secret }, "id": "f" }));
        assert!(!err, "{text}");
        let (values, err) = call(port, "ui_get_values", &json!({ "id": "f" }));
        assert!(!err && values.contains(&secret), "the path comes back as a path: {values}");
        assert!(!values.contains("data:") && !values.contains("dG9wIHNlY3JldA"), "never the file: {values}");
    }

    #[test]
    fn clips_on_a_character_boundary() {
        let text = "é".repeat(10);
        assert_eq!(clip(text.clone(), 100), text);
        assert_eq!(clip(text, 5), "éé… (truncated; 20 bytes in full)");
    }

    #[test]
    fn serves_preview_folders_and_nothing_else() {
        let root = temp_dir("preview");
        let site = root.join("site");
        std::fs::create_dir_all(site.join(".git")).unwrap();
        std::fs::create_dir_all(site.join("escape")).unwrap();
        std::fs::write(site.join("index.html"), "<h1>todo</h1>").unwrap();
        std::fs::write(site.join("app.js"), "console.log(1)").unwrap();
        std::fs::write(site.join(".env"), "SECRET=1").unwrap();
        std::fs::write(site.join(".git/config"), "[core]").unwrap();
        std::fs::write(root.join("secret.txt"), "nope").unwrap();
        // A folder whose index.html is a link out of the preview folder.
        std::os::unix::fs::symlink(root.join("secret.txt"), site.join("escape/index.html")).unwrap();

        std::fs::write(site.join("style.css"), "h1{}").unwrap();
        std::fs::write(site.join("notes.md"), "private").unwrap();
        std::fs::write(site.join("db.sqlite"), "private").unwrap();
        std::fs::write(site.join("id_rsa"), "private").unwrap();
        std::fs::write(site.join("main.rs"), "private").unwrap();

        let (_, host, mcp_port) = serve_chat(&root);
        let url = host.preview_url("s1", &site.join("index.html")).unwrap();
        let port = preview_port(&url);
        assert_ne!(port, mcp_port, "previews are never on the MCP server's origin");
        let path = url.split_once(&format!("127.0.0.1:{port}")).unwrap().1.to_owned();
        assert_eq!(get(mcp_port, &path, &format!("127.0.0.1:{mcp_port}")).0, 404, "the MCP port serves no previews");
        let base = path.trim_end_matches("index.html");
        let local = format!("127.0.0.1:{port}");

        let (status, page) = get(port, &path, &local);
        assert_eq!((status, page.as_str()), (200, "<h1>todo</h1>"));
        assert_eq!(get(port, &format!("{base}app.js"), "localhost").0, 200);
        assert_eq!(get(port, &format!("{base}style.css"), &local).0, 200);
        for not_web in ["notes.md", "db.sqlite", "id_rsa", "main.rs"] {
            assert_eq!(get(port, &format!("{base}{not_web}"), &local).0, 404, "only static web assets are served: {not_web}");
        }
        assert_eq!(get(port, base, &local).1, "<h1>todo</h1>", "a folder serves its index.html");
        for hidden in [
            format!("{base}../secret.txt"),
            format!("{base}%2e%2e/secret.txt"),
            format!("{base}escape/"),
            format!("{base}.env"),
            format!("{base}.git/config"),
            "/preview/unknown/index.html".into(),
        ] {
            assert_eq!(get(port, &hidden, &local).0, 404, "{hidden}");
        }
        assert_eq!(get(port, &path, "evil.example:80").0, 404, "a rebound hostname gets nothing");

        // Every file comes with a policy that keeps what the page reads at home.
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "GET {path} HTTP/1.1\r\nHost: {local}\r\nConnection: close\r\n\r\n").unwrap();
        let mut head = String::new();
        let _ = s.read_to_string(&mut head);
        let csp = head.lines().find_map(|l| l.strip_prefix("Content-Security-Policy: ")).unwrap_or_default();
        for part in ["connect-src 'self'", "form-action 'none'", "frame-ancestors *", "https:"] {
            assert!(csp.contains(part), "{part} in {csp}");
        }
        assert!(csp.contains("sandbox ") && !csp.contains("allow-popups") && !csp.contains("allow-top-navigation"), "{csp}");
        assert_eq!(exchange(port, &format!("POST {path} HTTP/1.1\r\nHost: {local}"), "").0, 405);
        let _ = std::fs::remove_dir_all(root);
    }

    fn preview_port(url: &str) -> u16 {
        url.strip_prefix("http://127.0.0.1:").and_then(|r| r.split('/').next()).and_then(|p| p.parse().ok()).unwrap()
    }

    /// The CSP header of a preview response.
    fn preview_csp(port: u16, path: &str) -> String {
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n").unwrap();
        let mut head = String::new();
        let _ = s.read_to_string(&mut head);
        head.lines().find_map(|l| l.strip_prefix("Content-Security-Policy: ")).unwrap_or_default().to_owned()
    }

    /// Pages previewed in two chats are on two origins (storage isn't shared);
    /// a chat's origin is opened on its first preview and closed with the chat.
    #[test]
    fn each_chat_previews_on_its_own_origin_and_closing_it_stops_serving() {
        let root = temp_dir("origins");
        std::fs::create_dir_all(root.join("site")).unwrap();
        std::fs::write(root.join("site/index.html"), "<h1>shared</h1>").unwrap();
        std::fs::write(root.join("site/about.html"), "<h1>about</h1>").unwrap();
        let (_, host, _) = serve_chat(&root);
        assert!(host.previews.lock().unwrap().is_empty(), "no origin until a chat previews something");

        let one = host.preview_url("s1", &root.join("site/index.html")).unwrap();
        let two = host.preview_url("s2", &root.join("site/index.html")).unwrap();
        let (p1, p2) = (preview_port(&one), preview_port(&two));
        assert_ne!(p1, p2, "two chats, two origins: {one} {two}");
        assert_eq!(preview_port(&host.preview_url("s1", &root.join("site/about.html")).unwrap()), p1, "one origin per chat, reused");
        let path = |url: &str| url.strip_prefix("http://127.0.0.1:").and_then(|r| r.split_once('/')).map(|(_, p)| format!("/{p}")).unwrap();
        assert_eq!(get(p1, &path(&one), "127.0.0.1").1, "<h1>shared</h1>");
        assert_eq!(get(p2, &path(&two), "127.0.0.1").1, "<h1>shared</h1>");
        // A chat's folders aren't served on another chat's origin.
        assert_eq!(get(p2, &path(&one), "127.0.0.1").0, 404, "s1's preview id means nothing on s2's origin");
        // The per-preview policy still comes with every file.
        for csp in [preview_csp(p1, &path(&one)), preview_csp(p2, &path(&two))] {
            assert!(csp.contains("connect-src 'self'") && csp.contains("sandbox ") && !csp.contains("allow-popups"), "{csp}");
        }

        // Closing s1 (the chat closed): its origin stops serving, s2's goes on.
        host.close_previews("s1");
        for _ in 0..50 {
            if get(p1, &path(&one), "127.0.0.1").0 == 0 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(get(p1, &path(&one), "127.0.0.1").0, 0, "nothing listens on a closed chat's origin");
        assert_eq!(get(p2, &path(&two), "127.0.0.1").0, 200);
        // Previewing again in s1 opens a new origin.
        let again = host.preview_url("s1", &root.join("site/index.html")).unwrap();
        assert_eq!(get(preview_port(&again), &path(&again), "127.0.0.1").0, 200);
        let _ = std::fs::remove_dir_all(root);
    }

    /// Deleting a chat revokes its UI token (and closes its previews); other chats are untouched.
    #[test]
    fn a_deleted_chats_token_stops_working() {
        let root = temp_dir("revoke");
        std::fs::create_dir_all(root.join("site")).unwrap();
        std::fs::write(root.join("site/index.html"), "<p>x</p>").unwrap();
        let (hub, host, port) = serve_chat(&root);
        let ping = json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" });
        assert_eq!(rpc_as(port, "tok", &ping).0, 200);
        let url = host.preview_url("s1", &root.join("site/index.html")).unwrap();
        let p1 = preview_port(&url);

        // Deleted through the hub that owns it, which reaches this server (and no other).
        hub.delete_session("s1").unwrap();
        assert_eq!(rpc_as(port, "tok", &ping).0, 404, "the deleted chat's token is refused");
        assert_eq!(call_full(port, "tok", "ui_catalog", &json!({})).0, "", "no tools either");
        assert_eq!(rpc_as(port, "tok2", &ping).0, 200, "another chat's token still works");
        for _ in 0..50 {
            if exchange(p1, "GET / HTTP/1.1\r\nHost: 127.0.0.1", "").0 == 0 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(exchange(p1, "GET / HTTP/1.1\r\nHost: 127.0.0.1", "").0, 0, "its previews are closed");
        assert!(host.preview_url("s1", &root.join("site/index.html")).unwrap_err().contains("deleted"), "and none open again");
        let _ = std::fs::remove_dir_all(root);
    }

    /// Save errors name the field and say what to do, whatever shape the agent sent.
    #[test]
    fn save_component_errors_name_the_path() {
        let errs = |args: Value| save_request(&args).unwrap_err();
        let base = json!({ "name": "env-badge", "description": "Shows which environment a deploy targets",
            "tree": { "type": "badge", "props": { "text": "{{env}}" } } });
        let with = |k: &str, v: Value| {
            let mut a = base.clone();
            a[k] = v;
            a
        };
        assert_eq!(
            errs(json!({})),
            [
                "name is required: a kebab-case name like `deploy-status`",
                "description is required: what the component shows and when to use it",
                "tree is required: the component's node tree, like { \"type\": \"card\", \"children\": [...] }",
            ]
        );
        assert_eq!(errs(with("examples", json!([{ "props": {} }]))), ["examples[0].title is required: a short name for the example"]);
        assert_eq!(
            errs(with("examples", json!([{ "title": "x" }]))),
            ["examples[0].props is required: the props to render the example with (an object)"]
        );
        assert_eq!(
            errs(with("examples", json!([{ "title": "ok", "props": {} }, { "title": 4, "props": [1] }, "nope"]))),
            [
                "examples[1].title must be a string, got 4",
                "examples[1].props must be an object, got [1]",
                "examples[2] must be an object { title, props }, got \"nope\""
            ]
        );
        assert_eq!(errs(with("examples", json!({ "title": "x" }))), ["examples must be an array of { title, props }, got {\"title\":\"x\"}"]);
        assert!(errs(with("tree", json!("just text")))[0].starts_with("tree must be a node object"), "a string tree is refused for components");
        assert!(errs(with("tree", json!("{ not json")))[0].contains("not a string"));
        assert!(errs(with("props", json!([])))[0].starts_with("props must be a JSON Schema object"));
        assert!(errs(with("expectedVersion", json!("two")))[0].starts_with("expectedVersion must be the version number"));
        assert_eq!(errs(json!("x")).len(), 1);

        // JSON-encoded tree, props and examples are accepted, as ui_render accepts an encoded tree.
        let encoded = json!({ "name": "env-badge", "description": "Shows which environment a deploy targets",
            "props": json!({ "type": "object", "properties": { "env": { "type": "string" } } }).to_string(),
            "tree": json!({ "type": "badge", "props": { "text": "{{env}}" } }).to_string(),
            "examples": json!([{ "title": "prod", "props": { "env": "prod" } }]).to_string(),
            "expectedVersion": "3" });
        let req = save_request(&encoded).unwrap();
        assert_eq!((req.tree["type"].as_str(), req.examples[0].props["env"].as_str(), req.expected_version), (Some("badge"), Some("prod"), Some(3)));
        assert_eq!(req.props["properties"]["env"]["type"], "string");
    }

    /// Over MCP: the text says what to fix, `structuredContent` has each `{ path, message }`.
    #[test]
    fn errors_come_back_as_text_and_as_paths() {
        let (_, _, port) = serve_chat(&temp_dir("cwd"));
        let (text, err, structured) = call_full(
            port,
            "tok",
            "ui_save_component",
            &json!({ "name": "env-badge", "description": "Shows which environment a deploy targets",
            "tree": { "type": "badge" }, "examples": [{ "props": {} }] }),
        );
        assert!(err && text.contains("- examples[0].title is required"), "{text}");
        assert_eq!(
            structured["errors"][0],
            json!({ "path": "examples[0].title", "message": "examples[0].title is required: a short name for the example" })
        );

        let (text, _, structured) = call_full(
            port,
            "tok",
            "ui_render",
            &json!({ "tree": { "type": "stack", "children": [{ "type": "badge", "props": { "variant": "loud" } }] } }),
        );
        assert!(text.contains("`badge` needs prop `text`"), "{text}");
        let paths: Vec<&str> = structured["errors"].as_array().unwrap().iter().filter_map(|e| e["path"].as_str()).collect();
        assert!(paths.contains(&"tree.children[0].props.variant") && paths.contains(&"tree.children[0]"), "{structured}");
        assert_eq!(
            error_parts("no component named `x`; call ui_catalog"),
            json!({ "path": "", "message": "no component named `x`; call ui_catalog" })
        );

        // A component saved with an encoded tree works; a string tree doesn't.
        let save = json!({ "name": "env-badge", "description": "Shows which environment a deploy targets",
            "props": { "type": "object", "properties": { "env": { "type": "string" } }, "required": ["env"] },
            "tree": json!({ "type": "badge", "props": { "text": "{{env}}" } }).to_string(),
            "examples": [{ "title": "prod", "props": { "env": "prod" } }], "preview": false });
        let (text, err) = call(port, "ui_save_component", &save);
        assert!(!err && text.starts_with("Saved `env-badge` v1"), "{text}");
        let (text, err) =
            call(port, "ui_save_component", &json!({ "name": "plain", "description": "Some text only, for nothing at all", "tree": "hello" }));
        assert!(err && text.contains("tree must be a node object"), "{text}");
    }

    /// Whether the CSP source list `sources` lets a frame load `url` (the forms
    /// tauri.conf.json uses: `scheme://host:*` and a bare `scheme:`).
    fn frame_allowed(sources: &str, url: &str) -> bool {
        let (scheme, rest) = url.split_once("://").unwrap();
        let host = rest.split(['/', '?']).next().unwrap().rsplit_once(':').map_or(rest.split('/').next().unwrap(), |(h, _)| h);
        sources.split_whitespace().any(|src| match src.split_once("://") {
            None => src == format!("{scheme}:"),
            Some((s, h)) => s == scheme && h.strip_suffix(":*").is_some_and(|h| h == host),
        })
    }

    /// The release CSP lets the chat frame every chat's preview origin and local
    /// dev servers by either loopback name, and nothing else over plain http.
    #[test]
    fn the_release_csp_frames_previews_and_local_dev_servers() {
        let conf: Value = serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json")).unwrap()).unwrap();
        let frame_src = conf["app"]["security"]["csp"]["frame-src"].as_str().unwrap();
        let root = temp_dir("csp");
        std::fs::create_dir_all(root.join("site")).unwrap();
        std::fs::write(root.join("site/index.html"), "<p>x</p>").unwrap();
        let (_, host, _) = serve_chat(&root);
        for chat in ["s1", "s2"] {
            let url = host.preview_url(chat, &root.join("site/index.html")).unwrap();
            assert!(frame_allowed(frame_src, &url), "{url} in {frame_src}");
        }
        for ok in ["http://localhost:5173/", "http://127.0.0.1:3000/app", "https://example.com/"] {
            assert!(frame_allowed(frame_src, ok), "{ok}");
        }
        for no in ["http://example.com/", "http://192.168.1.2:8080/", "tauri://localhost/", "http://ipc.localhost/"] {
            assert!(!frame_allowed(frame_src, no), "{no}");
        }
        // Tauri would add a nonce to style-src, and a nonce makes 'unsafe-inline' ignored:
        // inline styles from the UI libraries would be blocked in release builds only.
        assert_eq!(conf["app"]["security"]["dangerousDisableAssetCspModification"], json!(["style-src"]));
        assert!(conf["app"]["security"]["csp"]["style-src"].as_str().unwrap().contains("'unsafe-inline'"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn every_tool_has_a_full_name() {
        let names: Vec<String> = tools().as_array().unwrap().iter().filter_map(|t| t["name"].as_str().map(str::to_owned)).collect();
        assert_eq!(names, TOOL_NAMES, "TOOL_NAMES lists every tool, in order");
        assert_eq!(full_tool_name("ui_catalog"), "mcp__yaah-ui__ui_catalog");
        for t in TOOL_NAMES {
            assert!(INSTRUCTIONS.contains("mcp__yaah-ui__ui_catalog") && INSTRUCTIONS.contains("bare ui_catalog"), "{t}");
        }
    }
}
