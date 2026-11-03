//! Which `session/request_permission` requests yaah answers without asking, and
//! which MCP server a request is for (`docs/research/permissions.md`).
//!
//! yaah answers a request itself in two cases only, and then always with the
//! request's `allow_once` option (never `allow_always`: some adapters write that
//! into the user's own settings files):
//! - **read-only**: the tool call's kind is `read` or `search`, it names at least
//!   one path, and every path resolves (symlinks and `..` followed) inside the
//!   chat's folders. On unless Settings → Chat says otherwise.
//! - **trusted server**: the user trusted the MCP server the tool belongs to, in
//!   the chat's project or in the chat. That covers all of the server's tools,
//!   ones that change things too: an adapter doesn't tell yaah which are read-only.
//!
//! Everything else asks: edits, commands, fetches, deletes, moves, unknown kinds,
//! anything outside the folders, and anything whose paths can't all be checked.
//! [`decide`] is the rule, with no state of its own; `session.rs` asks it.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

/// Why yaah answered a request without the user clicking (the tool card's chip).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Auto {
    /// `"readOnly"`, `"trustedServer"` or `"remembered"`.
    pub reason: String,
    /// The same in words, for the chip: "read-only in this chat's folders".
    pub why: String,
}

pub const READ_ONLY: &str = "readOnly";
pub const TRUSTED_SERVER: &str = "trustedServer";
pub const REMEMBERED: &str = "remembered";

impl Auto {
    pub fn read_only() -> Self {
        Self { reason: READ_ONLY.into(), why: "read-only in this chat's folders".into() }
    }

    pub fn trusted(server: &McpServer) -> Self {
        Self { reason: TRUSTED_SERVER.into(), why: format!("trusted server: {}", server.label) }
    }

    pub fn remembered() -> Self {
        Self { reason: REMEMBERED.into(), why: "you said don't ask again in this chat".into() }
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
    fn new(id: &str) -> Option<Self> {
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
}

/// What the user allowed for this chat.
pub struct Policy<'a> {
    /// Settings → Chat, "Allow reads in the chat's folders".
    pub read_only: bool,
    /// The chat's folders: its cwd, its other folders, its project's repos.
    pub roots: &'a [PathBuf],
    /// MCP servers trusted in the chat's project or in the chat, by id.
    pub trusted: &'a [String],
}

/// Whether yaah answers `req` itself, and why. `None`: ask the user.
pub fn decide(req: &Request, policy: &Policy) -> Option<Auto> {
    if let Some(server) = req.server
        && policy.trusted.contains(&server.id)
    {
        return Some(Auto::trusted(server));
    }
    (policy.read_only && reads_inside(req, policy.roots)).then(Auto::read_only)
}

/// A `read` or `search` whose every path is inside `roots`, and that has at least one.
fn reads_inside(req: &Request, roots: &[PathBuf]) -> bool {
    if !matches!(req.kind, Some("read" | "search")) {
        return false;
    }
    let Some(paths) = paths(req.locations, req.raw_input) else { return false };
    !paths.is_empty() && paths.iter().all(|p| resolved(p).is_some_and(|real| crate::acp_terminals::inside(roots, &real).is_some()))
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
    let named = tool_call["_meta"]["claudeCode"]["toolName"].as_str().or_else(|| tool_call["name"].as_str());
    if let Some(name) = named {
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
        decide(&Request { kind, locations, raw_input, server: None }, &Policy { read_only: true, roots, trusted: &[] })
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
        let req = Request { kind: Some("read"), locations: &at(&file), raw_input: &Value::Null, server: None };
        assert!(decide(&req, &Policy { read_only: false, roots: &roots, trusted: &[] }).is_none());
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
        let trusted = vec!["claude_ai_Linear".to_owned()];
        let req = Request { kind: Some("other"), locations: &Value::Null, raw_input: &json!({ "id": "ENG-1" }), server: Some(&linear) };
        let auto = decide(&req, &Policy { read_only: false, roots: &[], trusted: &trusted }).unwrap();
        assert_eq!(auto, Auto { reason: TRUSTED_SERVER.into(), why: "trusted server: Linear".into() });
        // Codex sends its MCP tools as `execute`: trust is by server, not kind.
        let req = Request { kind: Some("execute"), server: Some(&linear), ..req };
        assert!(decide(&req, &Policy { read_only: false, roots: &[], trusted: &trusted }).is_some());
        // Not trusted, or no server known: it asks.
        assert!(decide(&req, &Policy { read_only: true, roots: &[], trusted: &[] }).is_none());
        let req = Request { server: None, ..req };
        assert!(decide(&req, &Policy { read_only: true, roots: &[], trusted: &trusted }).is_none());
    }

    #[test]
    fn a_lookalike_server_name_is_not_trusted() {
        let trusted = vec!["claude_ai_Linear".to_owned()];
        for name in
            ["mcp__claude_ai_Linear2__get_issue", "mcp__claude_ai__Linear__get_issue", "mcp__claude_ai_linear__get_issue", "mcp__Linear__get_issue"]
        {
            let server = mcp_server(&json!({}), &json!({ "name": name }), name, Some("other"), &Value::Null);
            let req = Request { kind: Some("other"), locations: &Value::Null, raw_input: &Value::Null, server: server.as_ref() };
            assert!(decide(&req, &Policy { read_only: true, roots: &[], trusted: &trusted }).is_none(), "{name}");
        }
        // A shell command named like the tool is Bash's, no server's.
        let server =
            mcp_server(&json!({}), &json!({ "name": "Bash" }), "mcp__claude_ai_Linear__get_issue", Some("execute"), &json!({ "command": "x" }));
        assert_eq!(server, None);
        // Without a name, a title is only a tool name for a tool of kind `other`.
        assert_eq!(mcp_server(&json!({}), &json!({}), "mcp__claude_ai_Linear__get_issue", Some("execute"), &Value::Null), None);
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
