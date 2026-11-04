//! Which `session/request_permission` requests yaah answers without asking, and
//! which MCP server a request is for (`docs/research/permissions.md`).
//!
//! yaah answers a request itself in these cases only, and then always with the
//! request's `allow_once` option (never `allow_always`: some adapters write that
//! into the user's own settings files):
//! - **trusted server**: the user trusted the MCP server the tool belongs to, in
//!   this chat, its project, quick chats (all chats without a project in a scratch
//!   folder share one scope) or all chats. That covers all of the server's tools,
//!   ones that change things too: an adapter doesn't tell yaah which are read-only.
//! - **read-only**: the tool call's kind is `read` or `search`, it names at least
//!   one path, and every path resolves (symlinks and `..` followed) inside the
//!   chat's folders. On unless Settings → Chat says otherwise.
//! - **saved tool results**: the same, for paths inside the agent's own folder of
//!   this chat's saved tool results ([`own_dirs`]; Claude Code only so far), under
//!   the same setting.
//! - **web search**: Settings → Chat, "Allow web searches without asking" (off by
//!   default), and the request is a web search ([`is_web_search`]). Fetches ask.
//!
//! Everything else asks: edits, commands, fetches, deletes, moves, unknown kinds,
//! anything outside the folders, and anything whose paths can't all be checked.
//! [`decide`] is the rule, with no state of its own; `session/trust.rs` asks it.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Component, Path, PathBuf};

/// Why yaah answered a request without the user clicking (the tool card's chip).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Auto {
    /// [`READ_ONLY`], [`TRUSTED_SERVER`], [`TRUSTED_EVERYWHERE`], [`REMEMBERED`],
    /// [`TOOL_RESULTS`] or [`WEB_SEARCH`].
    pub reason: String,
    /// The same in words, for the chip: "read-only in this chat's folders".
    pub why: String,
}

pub const READ_ONLY: &str = "readOnly";
/// Trusted in this chat, its project or quick chats ([`Scope`] says which, in `why`).
pub const TRUSTED_SERVER: &str = "trustedServer";
/// Trusted in all chats (Settings → Chat lists them).
pub const TRUSTED_EVERYWHERE: &str = "trustedEverywhere";
pub const REMEMBERED: &str = "remembered";
pub const TOOL_RESULTS: &str = "toolResults";
pub const WEB_SEARCH: &str = "webSearch";

impl Auto {
    pub fn read_only() -> Self {
        Self { reason: READ_ONLY.into(), why: "read-only in this chat's folders".into() }
    }

    pub fn trusted(server: &McpServer, scope: Scope) -> Self {
        let reason = if scope == Scope::Everywhere { TRUSTED_EVERYWHERE } else { TRUSTED_SERVER };
        Self { reason: reason.into(), why: format!("trusted {}: {}", scope.words(), server.label) }
    }

    /// A "don't ask again" replay, kept in this chat or (a quick chat) in quick chats.
    pub fn remembered_in(scope: Scope) -> Self {
        Self { reason: REMEMBERED.into(), why: format!("you said don't ask again {}", scope.words()) }
    }

    pub fn remembered() -> Self {
        Self::remembered_in(Scope::Chat)
    }

    pub fn tool_results(agent: &str) -> Self {
        Self { reason: TOOL_RESULTS.into(), why: format!("{agent}'s saved tool result from this chat") }
    }

    pub fn web_search() -> Self {
        Self { reason: WEB_SEARCH.into(), why: "web search allowed in Settings".into() }
    }
}

/// Where a trusted server or a "don't ask again" applies.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    /// This chat only (a chat in a folder of its own, or one chat of a project).
    Chat,
    /// Every chat of the chat's project.
    Project,
    /// Every quick chat: chats without a project, in a scratch folder of their own.
    QuickChats,
    /// Every chat.
    Everywhere,
}

impl Scope {
    /// "in this chat", "in this project", "in quick chats", "in all chats".
    pub fn words(self) -> &'static str {
        match self {
            Self::Chat => "in this chat",
            Self::Project => "in this project",
            Self::QuickChats => "in quick chats",
            Self::Everywhere => "in all chats",
        }
    }
}

/// The MCP server a request's tool belongs to.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    /// As the agent names it, and as it is trusted: `claude_ai_Linear`, `linear`.
    pub id: String,
    /// For people: `Linear`.
    pub label: String,
}

impl McpServer {
    pub fn new(id: &str) -> Option<Self> {
        let ok = !id.is_empty() && id.len() <= 128 && id.chars().all(|c| c.is_ascii_alphanumeric() || "_-.".contains(c));
        // Claude Code's names for claude.ai connectors (`claude.ai Linear` → `claude_ai_Linear`).
        let label = id.strip_prefix("claude_ai_").filter(|l| !l.is_empty()).unwrap_or(id);
        ok.then(|| Self { id: id.to_owned(), label: label.to_owned() })
    }
}

/// A request as [`decide`] sees it: the tool call (as yaah has it once the
/// request's own fields are merged in) and the server it is for, if known.
pub struct Request<'a> {
    pub kind: Option<&'a str>,
    pub locations: &'a Value,
    pub raw_input: &'a Value,
    pub server: Option<&'a McpServer>,
    /// The agent's own name for the tool, when it sends one ([`tool_name`]): `WebSearch`, `Bash`.
    pub tool_name: Option<&'a str>,
}

/// What the user allowed for this chat.
#[derive(Default)]
pub struct Policy<'a> {
    /// Settings → Chat, "Allow reads in the chat's folders".
    pub read_only: bool,
    /// The chat's folders: its cwd, its other folders, its project's repos.
    pub roots: &'a [PathBuf],
    /// The agent's own folders for this chat ([`own_dirs`]): read like the chat's folders.
    pub own: Option<&'a OwnDirs>,
    /// Trusted MCP server ids by scope, narrowest first: the first that has the
    /// request's server names it on the chip.
    pub trusted: &'a [(Scope, Vec<String>)],
    /// Settings → Chat, "Allow web searches without asking".
    pub web_search: bool,
}

/// Whether yaah answers `req` itself, and why. `None`: ask the user.
pub fn decide(req: &Request, policy: &Policy) -> Option<Auto> {
    if let Some(server) = req.server
        && let Some((scope, _)) = policy.trusted.iter().find(|(_, ids)| ids.contains(&server.id))
    {
        return Some(Auto::trusted(server, *scope));
    }
    if policy.read_only
        && let Some(paths) = read_paths(req)
    {
        if paths.iter().all(|p| inside(policy.roots, p)) {
            return Some(Auto::read_only());
        }
        if let Some(own) = policy.own
            && paths.iter().all(|p| inside(policy.roots, p) || inside(&own.dirs, p))
        {
            return Some(Auto::tool_results(own.agent));
        }
    }
    (policy.web_search && is_web_search(req)).then(Auto::web_search)
}

/// A `read` or `search`'s paths, when it has at least one and all can be checked.
fn read_paths(req: &Request) -> Option<Vec<String>> {
    if !matches!(req.kind, Some("read" | "search")) {
        return None;
    }
    paths(req.locations, req.raw_input).filter(|p| !p.is_empty())
}

/// Whether `path` is absolute (`~` is the home folder) and resolves inside one of `roots`.
fn inside(roots: &[PathBuf], path: &str) -> bool {
    resolved(path).is_some_and(|real| crate::acp_terminals::inside(roots, &real).is_some())
}

/// Whether `req` is a web search, and nothing else:
/// - Claude Code (claude-agent-acp 0.99.1, 0.100.0) names the tool `WebSearch`; it
///   comes as kind `fetch`, titled `Search "<query>"`, `rawInput { query, allowed_domains?, blocked_domains? }`.
///   When the agent names its tool, only that name counts: `WebFetch`, `mcp__fetch__fetch` aren't searches.
/// - Another agent: kind `search` with no paths at all, and a `query` in its input but no `url`.
fn is_web_search(req: &Request) -> bool {
    if let Some(name) = req.tool_name {
        return name == "WebSearch";
    }
    req.kind == Some("search")
        && req.raw_input["query"].is_string()
        && req.raw_input.get("url").is_none()
        && paths(req.locations, req.raw_input).is_some_and(|p| p.is_empty())
}

/// `path` as an absolute path (`~` is the home folder), or `None` for a relative one.
fn resolved(path: &str) -> Option<PathBuf> {
    let p = crate::sources::git::expand_home(path);
    p.is_absolute().then_some(p)
}

/// `rawInput` keys that hold a path (or a list of them) in the shapes yaah knows:
/// Claude Code's Read (`file_path`), Glob and Grep (`path`, or `file_path`), `NotebookRead`
/// (`notebook_path`), and the usual spellings of other agents.
const PATH_KEYS: &[&str] =
    &["path", "paths", "file_path", "filePath", "filepath", "notebook_path", "abs_path", "absolute_path", "absolutePath", "dir", "directory", "cwd"];

/// Every path a tool call names: its `locations` and the path fields of its input.
/// `None` when that can't be told: a malformed field, or a path-like string
/// anywhere else in the input (a glob such as `/etc/*` or `../**`, an unknown key),
/// which could reach outside what the known fields say.
fn paths(locations: &Value, raw_input: &Value) -> Option<Vec<String>> {
    let mut out = vec![];
    match locations {
        Value::Null => {}
        Value::Array(list) => {
            for l in list {
                out.push(l.get("path")?.as_str()?.to_owned());
            }
        }
        _ => return None,
    }
    match raw_input {
        Value::Null => {}
        Value::Object(fields) => {
            for (key, value) in fields {
                if PATH_KEYS.contains(&key.as_str()) {
                    match value {
                        Value::Null => {}
                        Value::String(s) => out.push(s.clone()),
                        Value::Array(items) => {
                            for i in items {
                                out.push(i.as_str()?.to_owned());
                            }
                        }
                        _ => return None,
                    }
                } else if mentions_path(value) {
                    return None;
                }
            }
        }
        _ => return None,
    }
    Some(out)
}

/// Whether any string in `v` could name a place: absolute, from home, or climbing with `..`.
fn mentions_path(v: &Value) -> bool {
    match v {
        Value::String(s) => s.starts_with('/') || s.starts_with('~') || s.split(['/', '\\']).any(|seg| seg == ".."),
        Value::Array(items) => items.iter().any(mentions_path),
        Value::Object(fields) => fields.values().any(mentions_path),
        _ => false,
    }
}

// ── the agent's own folders ─────────────────────────────────────────────────

/// Folders an agent keeps for one chat's own output and reads back (its saved
/// tool results): reads there are the chat's own, like reads in its folders.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnDirs {
    /// The agent, for people: "Claude".
    pub agent: &'static str,
    /// Each resolved (symlinks followed), and checked to be where the agent keeps them.
    pub dirs: Vec<PathBuf>,
}

/// What [`own_dirs`] needs to know about the chat's agent.
pub struct AgentDirs<'a> {
    /// The profile's preset (`agents::CLAUDE`, `codex`, …).
    pub preset: &'a str,
    /// The `CLAUDE_CONFIG_DIR` the agent runs with, if any (the profile's, else
    /// its env's, else yaah's own environment's).
    pub claude_config_dir: Option<&'a str>,
    pub home: &'a Path,
    /// The chat's folder, as the agent was started in it.
    pub cwd: &'a str,
    /// The chat's ACP session id at its current agent.
    pub session: &'a str,
}

/// The agent's own folders for this chat, per adapter. Only Claude Code's is
/// known so far; another adapter adds its arm here.
pub fn own_dirs(a: &AgentDirs) -> Option<OwnDirs> {
    match a.preset {
        crate::agents::CLAUDE => {
            let dir = claude_tool_results(a.claude_config_dir, a.home, a.cwd, a.session)?;
            Some(OwnDirs { agent: "Claude", dirs: vec![dir] })
        }
        _ => None,
    }
}

/// Claude Code's folder of one session's saved tool results (an MCP result too
/// large to return inline is written there, and the model reads it back):
/// `<config dir>/projects/<slug of the cwd>/<session id>/tool-results`. The config
/// dir is `CLAUDE_CONFIG_DIR`, `~/.claude` when unset; an empty or relative one
/// gives none. Only that one folder, never the config dir, another session or
/// another project; and only when it exists and resolves to that very place (no
/// symlink anywhere below the config dir).
pub fn claude_tool_results(config_dir: Option<&str>, home: &Path, cwd: &str, session: &str) -> Option<PathBuf> {
    let plain = |s: &str| !s.is_empty() && s.len() <= 128 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !plain(session) {
        return None;
    }
    let config = match config_dir {
        None => home.join(".claude"),
        Some("~") => home.to_owned(),
        Some(d) => match d.strip_prefix("~/") {
            Some(rest) => home.join(rest),
            None => PathBuf::from(d),
        },
    };
    if !config.is_absolute() || config.components().any(|c| c == Component::ParentDir) {
        return None;
    }
    // Claude Code names the project after its real cwd (`/tmp` is `/private/tmp` on macOS).
    let cwd = Path::new(cwd).canonicalize().ok()?;
    let expected = config.canonicalize().ok()?.join("projects").join(claude_slug(&cwd.to_string_lossy())).join(session).join("tool-results");
    let real = expected.canonicalize().ok()?;
    (real == expected && real.is_dir()).then_some(real)
}

/// Claude Code's folder name for a project (its `sanitizePath`): every UTF-16 unit
/// outside `[a-zA-Z0-9]` becomes `-`; past 200 units it is cut there and the path's
/// hash added (`-<base 36>`). `/Users/me/.yaah/scratch/x` → `-Users-me--yaah-scratch-x`.
pub fn claude_slug(path: &str) -> String {
    const MAX: usize = 200;
    let slug: String = path.encode_utf16().map(|u| u8::try_from(u).ok().filter(u8::is_ascii_alphanumeric).map_or('-', char::from)).collect();
    if slug.len() <= MAX {
        return slug;
    }
    // `(h << 5) - h + unit | 0` over the UTF-16 units: a wrapping 32-bit `h * 31 + unit`.
    let hash = path.encode_utf16().fold(0i32, |h, u| h.wrapping_mul(31).wrapping_add(i32::from(u)));
    format!("{}-{}", &slug[..MAX], base36(i64::from(hash).unsigned_abs()))
}

fn base36(mut n: u64) -> String {
    let mut digits = vec![];
    loop {
        digits.push(char::from_digit(u32::try_from(n % 36).unwrap_or(0), 36).unwrap_or('0'));
        n /= 36;
        if n == 0 {
            break;
        }
    }
    digits.iter().rev().collect()
}

/// "Claude is reading a saved tool result": said on an `execute` request whose
/// command names absolute paths only inside the agent's own folders (and at least
/// one), with no redirect. Words only: the request still asks. A command that
/// merely contains the folder's name in a longer word, or names any other path, gets none.
pub fn command_note(kind: Option<&str>, raw_input: &Value, own: &OwnDirs) -> Option<String> {
    if kind != Some("execute") {
        return None;
    }
    let command = raw_input["command"].as_str()?;
    if command.contains('>') {
        return None;
    }
    let words = command.split(|c: char| c.is_whitespace() || ";|&()<'\"`=".contains(c)).filter(|w| !w.is_empty());
    let mut named = 0;
    for w in words {
        if !(w.starts_with('/') || w.starts_with('~')) {
            continue;
        }
        if !inside_or_glob(&own.dirs, w) {
            return None;
        }
        named += 1;
    }
    (named > 0).then(|| format!("{} is reading a saved tool result", own.agent))
}

/// `word` (a path, maybe ending in a glob) is inside one of `roots`: the path, or
/// its longest part that exists, resolves inside, and the rest doesn't climb.
fn inside_or_glob(roots: &[PathBuf], word: &str) -> bool {
    let Some(path) = resolved(word) else { return false };
    if path.components().any(|c| c == Component::ParentDir) {
        return false;
    }
    let mut at = path.as_path();
    loop {
        if at.exists() {
            return crate::acp_terminals::inside(roots, at).is_some();
        }
        match at.parent() {
            Some(p) => at = p,
            None => return false,
        }
    }
}

/// The agent's own name for the tool, when the request carries one: Claude Code
/// sends it as `toolCall.name` (and `_meta.claudeCode.toolName` in some requests).
pub fn tool_name(tool_call: &Value) -> Option<&str> {
    tool_call["_meta"]["claudeCode"]["toolName"].as_str().or_else(|| tool_call["name"].as_str())
}

/// The MCP server a request is for, when yaah can tell. `params` is the whole
/// request; `title`, `kind` and `raw_input` are the tool call as yaah has it (a
/// request may name only its `toolCallId`, the rest came with the tool call).
///
/// - Claude Code (claude-agent-acp): the tool's name, `mcp__<server>__<tool>`, in
///   `toolCall.name` or `toolCall._meta.claudeCode.toolName`. When either is sent
///   it decides (`Bash` is no server's, whatever its title). Without them the title,
///   which is the tool's name for an MCP tool (kind `other`).
/// - Codex (codex-acp): MCP tool calls are titled `mcp.<server>.<tool>`, kind
///   `execute`, with `rawInput` `{ server, tool, arguments }`; the approval request
///   names only the tool call. One it can't tie to a tool call is marked
///   `_meta.is_mcp_tool_approval` with `rawInput.serverName`.
///
/// Any other shape: `None`, and the user isn't offered to trust a server.
pub fn mcp_server(params: &Value, tool_call: &Value, title: &str, kind: Option<&str>, raw_input: &Value) -> Option<McpServer> {
    if let Some(name) = tool_name(tool_call) {
        return claude_server(name);
    }
    if matches!(kind, None | Some("other"))
        && let Some(s) = claude_server(title)
    {
        return Some(s);
    }
    if let (Some(server), Some(tool)) = (raw_input["server"].as_str(), raw_input["tool"].as_str())
        && title == format!("mcp.{server}.{tool}")
    {
        return McpServer::new(server);
    }
    if params["_meta"]["is_mcp_tool_approval"] == true {
        return McpServer::new(raw_input["serverName"].as_str()?);
    }
    None
}

/// `mcp__<server>__<tool>`, split as Claude Code does: the server runs to the next `__`.
fn claude_server(name: &str) -> Option<McpServer> {
    let rest = name.strip_prefix("mcp__")?;
    let (server, tool) = rest.split_once("__")?;
    if tool.is_empty() {
        return None;
    }
    McpServer::new(server)
}

/// The request's `allow_once` option: its id and name.
pub fn allow_once(options: &Value) -> Option<(String, String)> {
    let o = options.as_array()?.iter().find(|o| o["kind"] == "allow_once")?;
    Some((o["optionId"].as_str()?.to_owned(), o["name"].as_str().unwrap_or("Allow").to_owned()))
}

/// What a request saved before `answer` existed was answered with, from its
/// `chosen` text: the option kind (or `"cancelled"`), and whether it was a
/// "don't ask again" replay (its name ends with `remembered_mark`).
pub fn answer_of(options: &Value, chosen: &str, remembered_mark: &str) -> (Option<String>, bool) {
    if chosen.starts_with("cancelled") {
        return (Some("cancelled".into()), false);
    }
    let (name, remembered) = match chosen.strip_suffix(remembered_mark) {
        Some(name) => (name.trim_end(), true),
        None => (chosen, false),
    };
    let kind = options.as_array().and_then(|list| list.iter().find(|o| o["name"] == name)).and_then(|o| o["kind"].as_str()).map(str::to_owned);
    (kind, remembered)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A chat folder `repo` with a file in it, a sibling `repo-other`, and a folder outside.
    struct Dirs {
        base: PathBuf,
        repo: PathBuf,
    }

    impl Dirs {
        fn new() -> Self {
            let base = std::env::temp_dir().join(format!("yaah-perm-{}", crate::session::random_token()));
            let repo = base.join("repo");
            std::fs::create_dir_all(repo.join("src")).unwrap();
            std::fs::write(repo.join("src/main.rs"), "fn main() {}").unwrap();
            std::fs::create_dir_all(base.join("repo-other")).unwrap();
            std::fs::write(base.join("repo-other/secret.txt"), "x").unwrap();
            std::fs::create_dir_all(base.join("outside")).unwrap();
            std::fs::write(base.join("outside/notes.txt"), "x").unwrap();
            Self { base, repo }
        }
        fn p(&self, rel: &str) -> String {
            self.base.join(rel).to_string_lossy().into_owned()
        }
    }

    impl Drop for Dirs {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    fn ask(kind: Option<&str>, locations: &Value, raw_input: &Value, roots: &[PathBuf]) -> Option<Auto> {
        decide(&Request { kind, locations, raw_input, server: None, tool_name: None }, &Policy { read_only: true, roots, ..Policy::default() })
    }

    fn at(path: &str) -> Value {
        json!([{ "path": path }])
    }

    #[test]
    fn reads_and_searches_inside_the_chats_folders_are_allowed() {
        let d = Dirs::new();
        let roots = vec![d.repo.clone()];
        let file = d.p("repo/src/main.rs");
        // Claude Code's Read: the file in `locations` and in `rawInput.file_path`.
        assert_eq!(ask(Some("read"), &at(&file), &json!({ "file_path": file, "offset": 1 }), &roots), Some(Auto::read_only()));
        // Glob and Grep with a folder; a relative pattern stays inside it.
        assert!(ask(Some("search"), &at(&d.p("repo")), &json!({ "path": d.p("repo"), "pattern": "**/*.rs" }), &roots).is_some());
        assert!(ask(Some("search"), &Value::Null, &json!({ "path": d.p("repo/src"), "pattern": "fn main", "glob": "*.rs" }), &roots).is_some());
        // Any of the chat's folders, not only the first.
        let two = vec![d.base.join("outside"), d.repo.clone()];
        assert!(ask(Some("read"), &at(&file), &Value::Null, &two).is_some());
    }

    #[test]
    fn the_setting_off_asks() {
        let d = Dirs::new();
        let roots = vec![d.repo.clone()];
        let file = d.p("repo/src/main.rs");
        let req = Request { kind: Some("read"), locations: &at(&file), raw_input: &Value::Null, server: None, tool_name: None };
        assert!(decide(&req, &Policy { read_only: false, roots: &roots, ..Policy::default() }).is_none());
    }

    #[test]
    fn only_read_and_search_kinds_are_allowed() {
        let d = Dirs::new();
        let roots = vec![d.repo.clone()];
        let file = d.p("repo/src/main.rs");
        for kind in [Some("edit"), Some("execute"), Some("fetch"), Some("delete"), Some("move"), Some("other"), Some("think"), Some("READ"), None] {
            assert!(ask(kind, &at(&file), &json!({ "file_path": file }), &roots).is_none(), "{kind:?} must ask");
        }
        // A shell command inside the folder (a redirect is a write) is `execute`: it asks.
        assert!(ask(Some("execute"), &at(&d.p("repo")), &json!({ "command": "cat src/main.rs >> out.txt", "cwd": d.p("repo") }), &roots).is_none());
    }

    #[test]
    fn a_read_without_paths_asks() {
        let d = Dirs::new();
        let roots = vec![d.repo.clone()];
        assert!(ask(Some("read"), &Value::Null, &Value::Null, &roots).is_none());
        assert!(ask(Some("read"), &json!([]), &json!({ "offset": 3 }), &roots).is_none());
        // Grep without a path searches wherever the agent is: not something yaah can check.
        assert!(ask(Some("search"), &Value::Null, &json!({ "pattern": "TODO" }), &roots).is_none());
    }

    #[test]
    fn paths_outside_the_folders_ask() {
        let d = Dirs::new();
        let roots = vec![d.repo.clone()];
        let inside = d.p("repo/src/main.rs");
        let outside = d.p("outside/notes.txt");
        assert!(ask(Some("read"), &at(&outside), &Value::Null, &roots).is_none());
        // Every path must be inside, not just one.
        assert!(ask(Some("read"), &json!([{ "path": inside }, { "path": outside }]), &Value::Null, &roots).is_none());
        assert!(ask(Some("read"), &at(&inside), &json!({ "file_path": outside }), &roots).is_none());
        assert!(ask(Some("read"), &Value::Null, &json!({ "paths": [inside, outside] }), &roots).is_none());
        // The home folder or a file nowhere near.
        assert!(ask(Some("read"), &at("/etc/hosts"), &Value::Null, &roots).is_none());
        assert!(ask(Some("read"), &at("~/.ssh/id_ed25519"), &Value::Null, &roots).is_none());
    }

    #[test]
    fn a_dot_dot_path_is_judged_where_it_lands() {
        let d = Dirs::new();
        let roots = vec![d.repo.clone()];
        assert!(ask(Some("read"), &at(&d.p("repo/../outside/notes.txt")), &Value::Null, &roots).is_none());
        assert!(ask(Some("read"), &at(&d.p("repo/src/../../repo-other/secret.txt")), &Value::Null, &roots).is_none());
        // `..` that stays inside is fine.
        assert!(ask(Some("read"), &at(&d.p("repo/src/../src/main.rs")), &Value::Null, &roots).is_some());
    }

    #[test]
    fn a_symlink_out_of_the_folder_asks() {
        let d = Dirs::new();
        let roots = vec![d.repo.clone()];
        std::os::unix::fs::symlink(d.base.join("outside"), d.repo.join("link")).unwrap();
        std::os::unix::fs::symlink(d.base.join("outside/notes.txt"), d.repo.join("notes.txt")).unwrap();
        assert!(ask(Some("read"), &at(&d.p("repo/link/notes.txt")), &Value::Null, &roots).is_none());
        assert!(ask(Some("read"), &at(&d.p("repo/notes.txt")), &Value::Null, &roots).is_none());
        assert!(ask(Some("search"), &at(&d.p("repo/link")), &json!({ "path": d.p("repo/link") }), &roots).is_none());
    }

    #[test]
    fn a_sibling_folder_with_the_same_prefix_is_outside() {
        let d = Dirs::new();
        let roots = vec![d.repo.clone()];
        assert!(ask(Some("read"), &at(&d.p("repo-other/secret.txt")), &Value::Null, &roots).is_none());
        assert!(ask(Some("search"), &at(&d.p("repo-other")), &Value::Null, &roots).is_none());
    }

    #[test]
    fn paths_that_cant_be_checked_ask() {
        let d = Dirs::new();
        let roots = vec![d.repo.clone()];
        let dir = d.p("repo");
        // Relative, missing (nothing to resolve), or not a string.
        assert!(ask(Some("read"), &at("src/main.rs"), &Value::Null, &roots).is_none());
        assert!(ask(Some("read"), &at(&d.p("repo/nope.rs")), &Value::Null, &roots).is_none());
        assert!(ask(Some("read"), &json!([{ "path": 3 }]), &Value::Null, &roots).is_none());
        assert!(ask(Some("read"), &json!({ "path": dir }), &Value::Null, &roots).is_none());
        assert!(ask(Some("read"), &at(&dir), &json!("cat /etc/passwd"), &roots).is_none());
        assert!(ask(Some("read"), &at(&dir), &json!({ "file_path": { "p": dir } }), &roots).is_none());
        // A glob that reaches out, or a path under a key yaah doesn't know.
        assert!(ask(Some("search"), &at(&dir), &json!({ "path": dir, "pattern": "../**/*.env" }), &roots).is_none());
        assert!(ask(Some("search"), &at(&dir), &json!({ "path": dir, "pattern": "/etc/*" }), &roots).is_none());
        assert!(ask(Some("search"), &at(&dir), &json!({ "path": dir, "glob": "~/**" }), &roots).is_none());
        assert!(ask(Some("read"), &at(&dir), &json!({ "target": "/etc/passwd" }), &roots).is_none());
        assert!(ask(Some("read"), &at(&dir), &json!({ "options": { "also": ["../../x"] } }), &roots).is_none());
        // No folders at all.
        assert!(ask(Some("read"), &at(&dir), &Value::Null, &[]).is_none());
    }

    #[test]
    fn a_trusted_server_is_allowed_whatever_its_tool_does() {
        let linear = McpServer::new("claude_ai_Linear").unwrap();
        let trusted = vec![(Scope::Chat, vec!["claude_ai_Linear".to_owned()])];
        let req =
            Request { kind: Some("other"), locations: &Value::Null, raw_input: &json!({ "id": "ENG-1" }), server: Some(&linear), tool_name: None };
        let auto = decide(&req, &Policy { trusted: &trusted, ..Policy::default() }).unwrap();
        assert_eq!(auto, Auto { reason: TRUSTED_SERVER.into(), why: "trusted in this chat: Linear".into() });
        // Codex sends its MCP tools as `execute`: trust is by server, not kind.
        let req = Request { kind: Some("execute"), server: Some(&linear), ..req };
        assert!(decide(&req, &Policy { trusted: &trusted, ..Policy::default() }).is_some());
        // Not trusted, or no server known: it asks.
        assert!(decide(&req, &Policy { read_only: true, ..Policy::default() }).is_none());
        let req = Request { server: None, ..req };
        assert!(decide(&req, &Policy { read_only: true, trusted: &trusted, ..Policy::default() }).is_none());
    }

    #[test]
    fn the_narrowest_scope_that_trusts_a_server_names_it() {
        let linear = McpServer::new("claude_ai_Linear").unwrap();
        let req = Request { kind: Some("other"), locations: &Value::Null, raw_input: &Value::Null, server: Some(&linear), tool_name: None };
        let ids = || vec!["claude_ai_Linear".to_owned()];
        let why = |trusted: &[(Scope, Vec<String>)]| decide(&req, &Policy { trusted, ..Policy::default() }).map(|a| (a.reason, a.why));
        let s = |r: &str, w: &str| Some((r.to_owned(), w.to_owned()));
        assert_eq!(why(&[(Scope::Everywhere, ids())]), s(TRUSTED_EVERYWHERE, "trusted in all chats: Linear"));
        assert_eq!(why(&[(Scope::QuickChats, ids()), (Scope::Everywhere, ids())]), s(TRUSTED_SERVER, "trusted in quick chats: Linear"));
        assert_eq!(
            why(&[(Scope::Chat, vec![]), (Scope::Project, ids()), (Scope::Everywhere, ids())]),
            s(TRUSTED_SERVER, "trusted in this project: Linear")
        );
        assert_eq!(why(&[(Scope::Chat, ids()), (Scope::Project, ids())]), s(TRUSTED_SERVER, "trusted in this chat: Linear"));
        assert_eq!(why(&[(Scope::Chat, vec!["linear".into()]), (Scope::Everywhere, vec!["github".into()])]), None);
    }

    #[test]
    fn a_lookalike_server_name_is_not_trusted() {
        let ids = vec!["claude_ai_Linear".to_owned()];
        for name in
            ["mcp__claude_ai_Linear2__get_issue", "mcp__claude_ai__Linear__get_issue", "mcp__claude_ai_linear__get_issue", "mcp__Linear__get_issue"]
        {
            let server = mcp_server(&json!({}), &json!({ "name": name }), name, Some("other"), &Value::Null);
            let req =
                Request { kind: Some("other"), locations: &Value::Null, raw_input: &Value::Null, server: server.as_ref(), tool_name: Some(name) };
            for scope in [Scope::Chat, Scope::Project, Scope::QuickChats, Scope::Everywhere] {
                let trusted = [(scope, ids.clone())];
                assert!(decide(&req, &Policy { read_only: true, trusted: &trusted, ..Policy::default() }).is_none(), "{name} {scope:?}");
            }
        }
        // A shell command named like the tool is Bash's, no server's.
        let server =
            mcp_server(&json!({}), &json!({ "name": "Bash" }), "mcp__claude_ai_Linear__get_issue", Some("execute"), &json!({ "command": "x" }));
        assert_eq!(server, None);
        // Without a name, a title is only a tool name for a tool of kind `other`.
        assert_eq!(mcp_server(&json!({}), &json!({}), "mcp__claude_ai_Linear__get_issue", Some("execute"), &Value::Null), None);
    }

    fn web(kind: Option<&'static str>, raw_input: &Value, tool_name: Option<&'static str>, on: bool) -> Option<Auto> {
        let req = Request { kind, locations: &Value::Null, raw_input, server: None, tool_name };
        decide(&req, &Policy { read_only: true, web_search: on, ..Policy::default() })
    }

    #[test]
    fn web_searches_are_allowed_only_when_turned_on() {
        // Claude Code's WebSearch, as claude-agent-acp sends it: kind `fetch`, named `WebSearch`.
        let search = json!({ "query": "acp permission modes", "allowed_domains": ["agentclientprotocol.com"] });
        assert_eq!(web(Some("fetch"), &search, Some("WebSearch"), true), Some(Auto::web_search()));
        assert_eq!(web(Some("fetch"), &search, Some("WebSearch"), false), None, "off by default");
        // Another agent's: a `search` with a query and no paths.
        assert_eq!(web(Some("search"), &json!({ "query": "rust 2024 edition" }), None, true), Some(Auto::web_search()));
        assert_eq!(web(Some("search"), &json!({ "query": "rust 2024 edition" }), None, false), None);
    }

    #[test]
    fn fetches_and_other_searches_still_ask_with_web_search_on() {
        let url = json!({ "url": "https://example.com", "prompt": "summarise" });
        assert_eq!(web(Some("fetch"), &url, Some("WebFetch"), true), None);
        assert_eq!(web(Some("other"), &url, Some("mcp__fetch__fetch"), true), None);
        assert_eq!(web(Some("fetch"), &url, None, true), None);
        // A search that is named something else, or that has a url, a path or no query.
        assert_eq!(web(Some("search"), &json!({ "query": "x" }), Some("Grep"), true), None);
        assert_eq!(web(Some("search"), &json!({ "query": "x", "url": "https://example.com" }), None, true), None);
        assert_eq!(web(Some("search"), &json!({ "query": "x", "path": "/etc" }), None, true), None);
        assert_eq!(web(Some("search"), &json!({ "query": "/etc/passwd" }), None, true), None);
        assert_eq!(web(Some("search"), &json!({ "pattern": "TODO" }), None, true), None, "Grep without a path");
        assert_eq!(web(Some("fetch"), &json!({ "query": "x" }), None, true), None, "a fetch is no search");
        let located = Request {
            kind: Some("search"),
            locations: &json!([{ "path": "/etc" }]),
            raw_input: &json!({ "query": "x" }),
            server: None,
            tool_name: None,
        };
        assert_eq!(decide(&located, &Policy { web_search: true, ..Policy::default() }), None);
    }

    /// A Claude config dir with this chat's session folder, a sibling session, and a secret beside them.
    struct Claude {
        base: PathBuf,
        home: PathBuf,
        cwd: PathBuf,
    }

    const SESSION: &str = "44cfaa80-dd88-41f8-ba23-b6149982d632";
    const OTHER: &str = "0000aaaa-0000-0000-0000-000000000000";

    impl Claude {
        fn new() -> Self {
            let base = std::env::temp_dir().join(format!("yaah-tool-results-{}", crate::session::random_token()));
            std::fs::create_dir_all(&base).unwrap();
            // Resolved (`/var` is `/private/var` on macOS), as the paths an agent sends are.
            let base = base.canonicalize().unwrap();
            let home = base.join("home");
            let cwd = home.join(".yaah/scratch/be2cba80a028");
            std::fs::create_dir_all(&cwd).unwrap();
            let me = Self { base, home, cwd };
            for (cfg, session) in [(".claude-personal", SESSION), (".claude-personal", OTHER), (".claude", SESSION)] {
                let dir = me.project(cfg).join(session).join("tool-results");
                std::fs::create_dir_all(&dir).unwrap();
                std::fs::write(dir.join("mcp-fetch-fetch-1.txt"), "saved").unwrap();
            }
            std::fs::write(me.home.join(".claude-personal/.credentials.json"), "{}").unwrap();
            std::fs::write(me.project(".claude-personal").join("notes.txt"), "x").unwrap();
            me
        }
        fn project(&self, cfg: &str) -> PathBuf {
            self.home.join(cfg).join("projects").join(claude_slug(&self.cwd.to_string_lossy()))
        }
        fn results(&self, cfg: &str, session: &str) -> PathBuf {
            self.project(cfg).join(session).join("tool-results")
        }
        fn own(&self, config_dir: Option<&str>, session: &str) -> Option<OwnDirs> {
            let cwd = self.cwd.to_string_lossy();
            own_dirs(&AgentDirs { preset: crate::agents::CLAUDE, claude_config_dir: config_dir, home: &self.home, cwd: &cwd, session })
        }
    }

    impl Drop for Claude {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    fn read_own(own: Option<&OwnDirs>, kind: &'static str, path: &Path, raw_input: &Value) -> Option<Auto> {
        let at = json!([{ "path": path }]);
        let req = Request { kind: Some(kind), locations: &at, raw_input, server: None, tool_name: None };
        decide(&req, &Policy { read_only: true, roots: &[], own, ..Policy::default() })
    }

    #[test]
    fn claude_slugs_its_project_folders_as_claude_code_does() {
        // The real example: `.yaah` became `-yaah`.
        assert_eq!(claude_slug("/Users/filipecabaco/.yaah/scratch/be2cba80a028"), "-Users-filipecabaco--yaah-scratch-be2cba80a028");
        assert_eq!(claude_slug("/private/tmp/x_y z"), "-private-tmp-x-y-z");
        // Per UTF-16 unit, as JavaScript's `replace` sees it: `é` is one, the emoji two.
        assert_eq!(claude_slug("/tmp/café \u{1F600}"), "-tmp-caf----");
        // Past 200 units: cut, and the path's hash (checked against Claude Code's own function under Node).
        let long = format!("/Users/someone/{}repo", "deeply-nested-folder/".repeat(10));
        assert_eq!(
            claude_slug(&long),
            "-Users-someone-deeply-nested-folder-deeply-nested-folder-deeply-nested-folder-deeply-nested-folder-deeply-nested-folder-deeply-nested-folder-deeply-nested-folder-deeply-nested-folder-deeply-nested-fol-i7nbnp"
        );
    }

    #[test]
    fn the_sessions_tool_results_are_a_read_root() {
        let c = Claude::new();
        let own = c.own(Some("~/.claude-personal"), SESSION).unwrap();
        assert_eq!(own.dirs, [c.results(".claude-personal", SESSION).canonicalize().unwrap()]);
        let file = c.results(".claude-personal", SESSION).join("mcp-fetch-fetch-1.txt");
        let file_s = file.to_string_lossy().into_owned();
        assert_eq!(
            read_own(Some(&own), "read", &file, &json!({ "file_path": file_s, "offset": 1, "limit": 200 })),
            Some(Auto::tool_results("Claude"))
        );
        // Grep and Glob there.
        let dir = c.results(".claude-personal", SESSION);
        assert!(read_own(Some(&own), "search", &dir, &json!({ "path": dir, "pattern": "Wisconsin", "output_mode": "content" })).is_some());
        // With the setting off, or for another agent, it asks.
        let at = json!([{ "path": file }]);
        let req = Request { kind: Some("read"), locations: &at, raw_input: &Value::Null, server: None, tool_name: None };
        assert!(decide(&req, &Policy { read_only: false, own: Some(&own), ..Policy::default() }).is_none());
        let cwd = c.cwd.to_string_lossy();
        assert_eq!(own_dirs(&AgentDirs { preset: "codex", claude_config_dir: None, home: &c.home, cwd: &cwd, session: SESSION }), None);
        // Edits and commands there still ask.
        assert!(read_own(Some(&own), "edit", &file, &Value::Null).is_none());
        assert!(read_own(Some(&own), "execute", &file, &json!({ "command": format!("cat {file_s}") })).is_none());
    }

    #[test]
    fn only_that_one_folder_is_a_root() {
        let c = Claude::new();
        let own = c.own(Some("~/.claude-personal"), SESSION).unwrap();
        // The config dir, its credentials, the project folder, a sibling session.
        for path in [
            c.home.join(".claude-personal/.credentials.json"),
            c.project(".claude-personal").join("notes.txt"),
            c.results(".claude-personal", OTHER).join("mcp-fetch-fetch-1.txt"),
            c.results(".claude", SESSION).join("mcp-fetch-fetch-1.txt"),
        ] {
            assert!(read_own(Some(&own), "read", &path, &Value::Null).is_none(), "{}", path.display());
        }
        // `..` out, and a sibling with the same prefix.
        let up = c.results(".claude-personal", SESSION).join("../../").join(OTHER).join("tool-results/mcp-fetch-fetch-1.txt");
        assert!(read_own(Some(&own), "read", &up, &Value::Null).is_none());
        let evil = c.project(".claude-personal").join(SESSION).join("tool-results-evil");
        std::fs::create_dir_all(&evil).unwrap();
        std::fs::write(evil.join("x.txt"), "x").unwrap();
        assert!(read_own(Some(&own), "read", &evil.join("x.txt"), &Value::Null).is_none());
    }

    #[test]
    fn a_symlink_out_of_the_tool_results_asks() {
        let c = Claude::new();
        let own = c.own(Some("~/.claude-personal"), SESSION).unwrap();
        let dir = c.results(".claude-personal", SESSION);
        std::os::unix::fs::symlink(c.home.join(".claude-personal/.credentials.json"), dir.join("creds.txt")).unwrap();
        std::os::unix::fs::symlink(c.results(".claude-personal", OTHER), dir.join("other")).unwrap();
        assert!(read_own(Some(&own), "read", &dir.join("creds.txt"), &Value::Null).is_none());
        assert!(read_own(Some(&own), "read", &dir.join("other/mcp-fetch-fetch-1.txt"), &Value::Null).is_none());
        // The folder itself a link elsewhere: no root at all.
        let linked = c.project(".claude-personal").join("linked-session");
        std::fs::create_dir_all(&linked).unwrap();
        std::os::unix::fs::symlink(c.home.join(".claude-personal"), linked.join("tool-results")).unwrap();
        assert_eq!(c.own(Some("~/.claude-personal"), "linked-session"), None);
    }

    #[test]
    fn the_config_dir_comes_from_the_profile_or_defaults_to_dot_claude() {
        let c = Claude::new();
        let home_claude = c.results(".claude", SESSION).canonicalize().unwrap();
        assert_eq!(c.own(None, SESSION).unwrap().dirs, [home_claude]);
        let abs = c.home.join(".claude-personal").to_string_lossy().into_owned();
        assert_eq!(c.own(Some(&abs), SESSION).unwrap().dirs, [c.results(".claude-personal", SESSION).canonicalize().unwrap()]);
        // Empty or relative: none. A session id that isn't one, or a folder not made yet: none.
        for bad in ["", ".claude-personal", "~/../x"] {
            assert_eq!(c.own(Some(bad), SESSION), None, "{bad:?}");
        }
        for bad in ["", "../x", "a/b", ".."] {
            assert_eq!(c.own(Some("~/.claude-personal"), bad), None, "{bad:?}");
        }
        assert_eq!(c.own(Some("~/.claude-personal"), "aaaa-not-yet"), None);
        // A new session id (resume, fork) names another folder.
        assert_ne!(c.own(Some("~/.claude-personal"), OTHER).unwrap().dirs, c.own(Some("~/.claude-personal"), SESSION).unwrap().dirs);
    }

    #[test]
    fn a_command_reading_a_saved_result_is_explained_and_still_asks() {
        let c = Claude::new();
        let own = c.own(Some("~/.claude-personal"), SESSION).unwrap();
        let dir = c.results(".claude-personal", SESSION).to_string_lossy().into_owned();
        let note = |cmd: String| command_note(Some("execute"), &json!({ "command": cmd, "description": "x" }), &own);
        let said = Some("Claude is reading a saved tool result".to_owned());
        assert_eq!(note(format!("F={dir}/mcp-fetch-fetch-1.txt; grep -n Wisconsin $F | cut -c1-200")), said);
        assert_eq!(note(format!("cd {dir}/; f=mcp-fetch-fetch-1.txt; grep -c x $f")), said);
        assert_eq!(note(format!("sed -n '1,40p' \"{dir}/mcp-fetch-fetch-1.txt\"")), said);
        assert_eq!(note(format!("wc -l {dir}/mcp-*.txt")), said, "a glob inside");
        // Any other path, a redirect, none at all, a lookalike, or not a command: nothing said.
        assert_eq!(note(format!("cp {dir}/mcp-fetch-fetch-1.txt /tmp/tx/p1.txt")), None);
        assert_eq!(note(format!("grep x {dir}/mcp-fetch-fetch-1.txt > {dir}/out.txt")), None);
        assert_eq!(note(format!("cat {dir}/../../{OTHER}/tool-results/mcp-fetch-fetch-1.txt")), None);
        assert_eq!(note("grep -r x .".into()), None);
        assert_eq!(note(format!("echo x{dir}")), None, "merely contains it");
        assert_eq!(note(format!("cat {dir}-evil/x")), None);
        assert_eq!(command_note(Some("read"), &json!({ "command": format!("cat {dir}/x") }), &own), None);
        // The request itself still asks: commands are never answered for the user.
        let input = json!({ "command": format!("cat {dir}/mcp-fetch-fetch-1.txt") });
        let req = Request { kind: Some("execute"), locations: &json!([]), raw_input: &input, server: None, tool_name: Some("Bash") };
        assert!(decide(&req, &Policy { read_only: true, own: Some(&own), web_search: true, ..Policy::default() }).is_none());
    }

    #[test]
    fn claude_code_names_its_server_in_the_tool_name() {
        let server = |tool_call: Value, title: &str, kind: Option<&str>| mcp_server(&json!({}), &tool_call, title, kind, &Value::Null);
        let linear = Some(McpServer { id: "claude_ai_Linear".into(), label: "Linear".into() });
        // As claude-agent-acp sends a request: `name` beside the title, which is the tool's name.
        assert_eq!(server(json!({ "name": "mcp__claude_ai_Linear__get_issue" }), "mcp__claude_ai_Linear__get_issue", Some("other")), linear);
        assert_eq!(server(json!({ "_meta": { "claudeCode": { "toolName": "mcp__claude_ai_Linear__list_comments" } } }), "x", Some("other")), linear);
        // A request that names only the tool call: the title yaah already has.
        assert_eq!(server(json!({}), "mcp__claude_ai_Linear__get_issue", None), linear);
        // The tool's name may hold `__` of its own; the server is up to the first.
        assert_eq!(server(json!({ "name": "mcp__incident_io__list__incidents" }), "", None).unwrap().id, "incident_io");
        assert_eq!(server(json!({ "name": "mcp__fetch__fetch" }), "", None).unwrap().label, "fetch");
        for bad in ["Read", "mcp__", "mcp____tool", "mcp__server", "mcp__server__", "mcp__a b__tool", "mcp__a/b__tool"] {
            assert_eq!(server(json!({ "name": bad }), bad, Some("other")), None, "{bad}");
        }
    }

    #[test]
    fn codex_names_its_server_in_the_tool_call_input() {
        let input = json!({ "server": "linear", "tool": "get_issue", "arguments": { "id": "ENG-1" } });
        // The approval names only the tool call; its title and input came with `item/started`.
        let s = mcp_server(&json!({}), &json!({ "toolCallId": "c1", "kind": "execute" }), "mcp.linear.get_issue", Some("execute"), &input);
        assert_eq!(s, Some(McpServer { id: "linear".into(), label: "linear".into() }));
        // A server name with dots: the input says where it ends.
        let dotted = json!({ "server": "a.b", "tool": "c" });
        assert_eq!(mcp_server(&json!({}), &json!({}), "mcp.a.b.c", Some("execute"), &dotted).unwrap().id, "a.b");
        // The title and the input must agree.
        assert_eq!(mcp_server(&json!({}), &json!({}), "mcp.other.get_issue", Some("execute"), &input), None);
        assert_eq!(mcp_server(&json!({}), &json!({}), "rm -rf /", Some("execute"), &input), None);
        // An approval Codex couldn't tie to a tool call.
        let standalone = json!({ "sessionId": "s", "_meta": { "is_mcp_tool_approval": true } });
        let input = json!({ "serverName": "linear", "description": "Allow get_issue?" });
        assert_eq!(mcp_server(&standalone, &json!({}), "MCP tool call approval", Some("execute"), &input).unwrap().id, "linear");
        assert_eq!(mcp_server(&json!({}), &json!({}), "MCP tool call approval", Some("execute"), &input), None, "only when marked");
    }

    #[test]
    fn other_shapes_name_no_server() {
        for (title, kind, input) in [
            ("Run ls", Some("execute"), json!({ "command": "ls" })),
            ("linear/get_issue", Some("other"), json!({})),
            ("get_issue", None, json!({ "server": "linear" })),
        ] {
            assert_eq!(mcp_server(&json!({}), &json!({}), title, kind, &input), None, "{title}");
        }
    }

    #[test]
    fn allow_once_is_the_only_option_yaah_picks() {
        let options = json!([
            { "optionId": "always", "name": "Always allow", "kind": "allow_always" },
            { "optionId": "once", "name": "Allow", "kind": "allow_once" },
            { "optionId": "no", "name": "Reject", "kind": "reject_once" }
        ]);
        assert_eq!(allow_once(&options), Some(("once".into(), "Allow".into())));
        let no_once = json!([{ "optionId": "always", "name": "Always", "kind": "allow_always" }, { "optionId": "no", "kind": "reject_once" }]);
        assert_eq!(allow_once(&no_once), None);
        assert_eq!(allow_once(&json!("nope")), None);
    }

    #[test]
    fn old_answers_are_read_from_the_chosen_text() {
        let options = json!([
            { "optionId": "a", "name": "Always allow", "kind": "allow_always" },
            { "optionId": "o", "name": "Allow", "kind": "allow_once" },
            { "optionId": "n", "name": "Reject", "kind": "reject_once" }
        ]);
        let mark = "(you said don't ask again)";
        assert_eq!(answer_of(&options, "Allow", mark), (Some("allow_once".into()), false));
        assert_eq!(answer_of(&options, "Always allow", mark), (Some("allow_always".into()), false));
        assert_eq!(answer_of(&options, "Always allow (you said don't ask again)", mark), (Some("allow_always".into()), true));
        assert_eq!(answer_of(&options, "Reject", mark), (Some("reject_once".into()), false));
        assert_eq!(answer_of(&options, "cancelled (app restarted)", mark), (Some("cancelled".into()), false));
        assert_eq!(answer_of(&options, "Something else", mark), (None, false));
    }
}
