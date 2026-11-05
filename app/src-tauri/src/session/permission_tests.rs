//! Permission requests through the real handler (`handle_incoming`), with a chat
//! attached to agent generation 1 and the answers the agent would read.

use super::*;
use crate::acp::Responder;
use permissions::Scope;
use tokio::sync::mpsc::UnboundedReceiver;

const GEN: u64 = 1;

fn quiet() -> Emit {
    Arc::new(|_: &str, _: Value| {})
}

fn options() -> Value {
    json!([
        { "optionId": "a", "name": "Always allow", "kind": "allow_always" },
        { "optionId": "o", "name": "Allow", "kind": "allow_once" },
        { "optionId": "r", "name": "Reject", "kind": "reject_once" }
    ])
}

fn fetch_request(id: i64, title: &str) -> Entry {
    Entry::Permission {
        request_id: json!(id),
        tool_call_id: None,
        title: title.into(),
        options: json!([
            { "optionId": "a", "name": "Yes, and don't ask again for Fetch commands", "kind": "allow_always" },
            { "optionId": "o", "name": "Yes", "kind": "allow_once" },
            { "optionId": "r", "name": "No", "kind": "reject_once" }
        ]),
        chosen: None,
        answer: None,
        auto: None,
        mcp_server: None,
        note: None,
    }
}

/// A folder for a chat to work in, with a file, and one beside it that isn't the chat's.
struct Folders {
    base: PathBuf,
}

impl Folders {
    fn new() -> Self {
        let base = std::env::temp_dir().join(format!("yaah-perm-chat-{}", random_token()));
        std::fs::create_dir_all(base.join("repo/src")).unwrap();
        std::fs::write(base.join("repo/src/lib.rs"), "").unwrap();
        std::fs::create_dir_all(base.join("elsewhere")).unwrap();
        std::fs::write(base.join("elsewhere/notes.md"), "").unwrap();
        Self { base }
    }
    fn p(&self, rel: &str) -> String {
        self.base.join(rel).to_string_lossy().into_owned()
    }
}

impl Drop for Folders {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

/// A chat `id` working in `cwd`, attached to generation [`GEN`], saved under `store` when given.
fn attach(hub: &Hub, id: &str, cwd: &str, project: Option<&str>, store: Option<&Path>) {
    let mut info = test_info(id);
    info.cwd = cwd.to_owned();
    info.project_id = project.map(str::to_owned);
    let mut s = Session::new(info, vec![], store.map(|d| d.join(format!("{id}.json"))));
    s.attached = Some(GEN);
    hub.shared.insert(s);
}

/// The agent asks; returns the entry the request became.
fn ask(hub: &Hub, responder: &Responder, sid: &str, id: i64, tool_call: Value, options: Value) -> (usize, Entry) {
    let params = Value::Object(
        [("sessionId".to_owned(), json!(sid)), ("toolCall".to_owned(), tool_call), ("options".to_owned(), options)].into_iter().collect(),
    );
    handle_incoming(&hub.shared, GEN, Incoming::Request { id: json!(id), method: "session/request_permission".into(), params }, responder);
    let t = hub.transcript(sid).unwrap().entries;
    let i = t.iter().rposition(|e| matches!(e, Entry::Permission { .. })).unwrap();
    (i, t[i].clone())
}

/// The option ids the agent got back, by request id (`cancelled` for none).
fn answers(rx: &mut UnboundedReceiver<String>) -> Vec<(i64, String)> {
    let mut out = vec![];
    while let Ok(line) = rx.try_recv() {
        let v: Value = serde_json::from_str(&line).unwrap();
        let outcome = &v["result"]["outcome"];
        out.push((v["id"].as_i64().unwrap(), outcome["optionId"].as_str().or(outcome["outcome"].as_str()).unwrap().to_owned()));
    }
    out
}

fn auto_reason(e: &Entry) -> Option<&str> {
    match e {
        Entry::Permission { auto, .. } => auto.as_ref().map(|a| a.reason.as_str()),
        _ => None,
    }
}

fn waiting(e: &Entry) -> bool {
    matches!(e, Entry::Permission { chosen: None, answer: None, auto: None, .. })
}

/// "Don't ask again" answers the same request already waiting, leaves others alone,
/// and is remembered for this chat. The replays use the one-off option.
#[test]
fn dont_ask_again_answers_the_waiting_ones() {
    let hub = Hub::new(quiet());
    let info = test_info("p");
    let entries = vec![
        fetch_request(1, "mcp__fetch__fetch"),
        fetch_request(2, "mcp__fetch__fetch"),
        fetch_request(3, "rm -rf build"),
        fetch_request(4, "mcp__fetch__fetch"),
        fetch_request(5, UNNAMED_REQUEST),
        fetch_request(6, UNNAMED_REQUEST),
    ];
    hub.shared.insert(Session::new(info, entries, None));
    // No agent is running, so sending fails after the choice is recorded.
    assert!(hub.respond_permission("p", 0, Some("a")).is_err());
    assert!(hub.respond_permission("p", 0, Some("a")).unwrap_err().contains("already answered"));
    assert!(hub.respond_permission("p", 99, None).is_err());
    // A request the agent didn't name is too vague to remember.
    let _ = hub.respond_permission("p", 4, Some("a"));
    let t = hub.transcript("p").unwrap().entries;
    assert!(matches!(&t[5], Entry::Permission { chosen: None, .. }), "an unnamed request still asks");
    assert!(!hub.shared.chat("p").unwrap().lock().unwrap().info.remembered.contains_key(UNNAMED_REQUEST));
    let field = |i: usize| match &t[i] {
        Entry::Permission { chosen, answer, auto, .. } => (chosen.clone(), answer.clone(), auto.clone()),
        _ => unreachable!(),
    };
    assert_eq!(field(0), (Some("Yes, and don't ask again for Fetch commands".into()), Some("allow_always".into()), None));
    let (chosen, answer, auto) = field(1);
    assert!(chosen.unwrap().ends_with("(you said don't ask again)"));
    assert_eq!((answer.as_deref(), auto), (Some("allow_once"), Some(Auto::remembered())), "the replay is the one-off option");
    assert_eq!(field(2).0, None, "a different request still asks");
    assert!(field(3).0.unwrap().ends_with("(you said don't ask again)"));
    assert_eq!(hub.shared.chat("p").unwrap().lock().unwrap().info.remembered["mcp__fetch__fetch"], "allow_always");
}

#[test]
fn a_remembered_choice_is_replayed_with_the_one_off_option_only() {
    assert_eq!(
        remembered_option(&json!([{ "optionId": "x", "name": "Yes", "kind": "allow_once" }]), "allow_always"),
        Some(("x".into(), "Yes".into(), "allow_once"))
    );
    assert_eq!(remembered_option(&options(), "reject_always"), Some(("r".into(), "Reject".into(), "reject_once")));
    // Only an `always` option: yaah asks rather than send it for the user.
    let always_only =
        json!([{ "optionId": "a", "name": "Always", "kind": "allow_always" }, { "optionId": "r", "name": "No", "kind": "reject_always" }]);
    assert_eq!(remembered_option(&always_only, "allow_always"), None);
    assert_eq!(remembered_option(&always_only, "reject_always"), None);
}

#[test]
fn reads_inside_the_chats_folders_are_answered_allow_once_and_marked() {
    let f = Folders::new();
    let hub = Hub::new(quiet());
    let (responder, mut rx) = Responder::for_test();
    attach(&hub, "p", &f.p("repo"), None, None);
    let file = f.p("repo/src/lib.rs");
    // As claude-agent-acp asks for a Read: the whole tool call in the request.
    let read =
        json!({ "toolCallId": "t1", "title": "Read src/lib.rs", "kind": "read", "rawInput": { "file_path": file }, "locations": [{ "path": file }] });
    let (_, e) = ask(&hub, &responder, "p", 1, read, options());
    assert_eq!(auto_reason(&e), Some(permissions::READ_ONLY));
    assert!(matches!(&e, Entry::Permission { chosen: Some(c), answer: Some(a), .. } if c == "Allow" && a == "allow_once"));
    // A request that names only its tool call: the kind and paths come from the tool call yaah has.
    let update =
        json!({ "sessionUpdate": "tool_call", "toolCallId": "t2", "title": "Find", "kind": "search", "locations": [{ "path": f.p("repo") }] });
    hub.shared.with("p", |s| apply_update(&hub.shared, s, &update)).unwrap();
    let (_, e) = ask(&hub, &responder, "p", 2, json!({ "toolCallId": "t2" }), options());
    assert_eq!(auto_reason(&e), Some(permissions::READ_ONLY));
    assert_eq!(answers(&mut rx), [(1, "o".to_owned()), (2, "o".to_owned())], "never `a`, the always option");
    assert!(hub.shared.chat("p").unwrap().lock().unwrap().waiting.is_empty());
}

#[test]
fn everything_else_reaches_the_user() {
    let f = Folders::new();
    let hub = Hub::new(quiet());
    let (responder, mut rx) = Responder::for_test();
    attach(&hub, "p", &f.p("repo"), None, None);
    let inside = f.p("repo/src/lib.rs");
    let at = |path: &str| json!([{ "path": path }]);
    let cases = [
        ("an edit", json!({ "toolCallId": "e", "title": "Edit lib.rs", "kind": "edit", "locations": at(&inside) })),
        (
            "a command",
            json!({ "toolCallId": "x", "title": "cat src/lib.rs >> out", "kind": "execute", "rawInput": { "command": "cat src/lib.rs >> out" } }),
        ),
        ("a fetch", json!({ "toolCallId": "w", "title": "Fetch", "kind": "fetch", "rawInput": { "url": "https://example.com" } })),
        ("a delete", json!({ "toolCallId": "d", "title": "Delete", "kind": "delete", "locations": at(&inside) })),
        ("a move", json!({ "toolCallId": "m", "title": "Move", "kind": "move", "locations": at(&inside) })),
        ("an unknown kind", json!({ "toolCallId": "u", "title": "Read?", "kind": "peek", "locations": at(&inside) })),
        ("no kind", json!({ "toolCallId": "n", "title": "Read?", "locations": at(&inside) })),
        ("a read without paths", json!({ "toolCallId": "r0", "title": "Read", "kind": "read" })),
        ("a read outside", json!({ "toolCallId": "r1", "title": "Read notes", "kind": "read", "locations": at(&f.p("elsewhere/notes.md")) })),
        ("a `..` read", json!({ "toolCallId": "r2", "title": "Read", "kind": "read", "locations": at(&f.p("repo/../elsewhere/notes.md")) })),
        (
            "an MCP tool",
            json!({ "toolCallId": "mcp", "title": "mcp__claude_ai_Linear__get_issue", "kind": "other", "name": "mcp__claude_ai_Linear__get_issue" }),
        ),
    ];
    for (n, (what, tool_call)) in (10..).zip(cases) {
        let (_, e) = ask(&hub, &responder, "p", n, tool_call, options());
        assert!(waiting(&e), "{what} must ask: {e:?}");
    }
    // A read inside, but with no one-off option to answer with: it asks rather than pick `always`.
    let no_once = json!([{ "optionId": "a", "name": "Always", "kind": "allow_always" }, { "optionId": "r", "name": "No", "kind": "reject_once" }]);
    let (_, e) = ask(&hub, &responder, "p", 30, json!({ "toolCallId": "r3", "title": "Read", "kind": "read", "locations": at(&inside) }), no_once);
    assert!(waiting(&e), "{e:?}");
    assert_eq!(answers(&mut rx), [], "nothing was answered for the user");
    assert_eq!(hub.shared.chat("p").unwrap().lock().unwrap().waiting.len(), 12);
}

#[test]
fn trusting_reads_can_be_turned_off() {
    let f = Folders::new();
    let hub = Hub::new(quiet());
    let (responder, mut rx) = Responder::for_test();
    attach(&hub, "p", &f.p("repo"), None, None);
    hub.set_trust_read_only(false);
    let file = f.p("repo/src/lib.rs");
    let (_, e) =
        ask(&hub, &responder, "p", 1, json!({ "toolCallId": "t", "title": "Read", "kind": "read", "locations": [{ "path": file }] }), options());
    assert!(waiting(&e));
    assert_eq!(answers(&mut rx), []);
}

#[test]
fn a_server_trusted_in_a_chat_answers_its_waiting_and_later_requests() {
    let hub = Hub::new(quiet());
    let (responder, mut rx) = Responder::for_test();
    attach(&hub, "p", "/tmp", None, None);
    let linear = |id: &str, tool: &str| json!({ "toolCallId": id, "title": format!("mcp__claude_ai_Linear__{tool}"), "kind": "other", "name": format!("mcp__claude_ai_Linear__{tool}") });
    let (i, e) = ask(&hub, &responder, "p", 1, linear("a", "get_issue"), options());
    assert!(matches!(&e, Entry::Permission { mcp_server: Some(m), chosen: None, .. } if m.id == "claude_ai_Linear" && m.label == "Linear"));
    ask(&hub, &responder, "p", 2, linear("b", "list_comments"), options());
    let (_, other) = ask(
        &hub,
        &responder,
        "p",
        3,
        json!({ "toolCallId": "c", "title": "mcp__github__get_pr", "name": "mcp__github__get_pr", "kind": "other" }),
        options(),
    );
    assert!(matches!(&other, Entry::Permission { mcp_server: Some(m), .. } if m.id == "github"));

    hub.trust_server("p", i, Scope::Chat, |_, _| unreachable!("a chat keeps it itself")).unwrap();
    assert_eq!(answers(&mut rx), [(1, "o".to_owned()), (2, "o".to_owned())], "both of Linear's, with allow_once");
    let t = hub.transcript("p").unwrap();
    assert_eq!(t.info.trusted_mcp_servers, ["claude_ai_Linear"]);
    assert_eq!(auto_reason(&t.entries[i]), Some(permissions::TRUSTED_SERVER));
    assert!(waiting(t.entries.iter().rfind(|e| matches!(e, Entry::Permission { .. })).unwrap()), "GitHub still asks");

    // Later requests, a tool that changes things too.
    let (_, e) = ask(&hub, &responder, "p", 4, linear("d", "update_issue"), options());
    assert!(matches!(&e, Entry::Permission { auto: Some(a), .. } if a.why == "trusted in this chat: Linear"));
    assert_eq!(answers(&mut rx), [(4, "o".to_owned())]);
    // A lookalike server, or a shell command named like the tool, isn't covered.
    let (_, e) = ask(
        &hub,
        &responder,
        "p",
        5,
        json!({ "toolCallId": "e", "title": "x", "name": "mcp__claude_ai_Linear2__get_issue", "kind": "other" }),
        options(),
    );
    assert!(waiting(&e));
    let bash = json!({ "toolCallId": "f", "title": "mcp__claude_ai_Linear__get_issue", "name": "Bash", "kind": "execute", "rawInput": { "command": "mcp__claude_ai_Linear__get_issue" } });
    let (bash_at, e) = ask(&hub, &responder, "p", 6, bash, options());
    assert!(matches!(&e, Entry::Permission { mcp_server: None, chosen: None, .. }));
    assert_eq!(answers(&mut rx), []);
    assert!(hub.trust_server("p", bash_at, Scope::Chat, |_, _| unreachable!()).unwrap_err().contains("can't tell which MCP server"));

    // Untrusted again: it asks.
    assert_eq!(hub.untrust_chat_server("p", "claude_ai_Linear").unwrap().trusted_mcp_servers, Vec::<String>::new());
    let (_, e) = ask(&hub, &responder, "p", 7, linear("g", "get_issue"), options());
    assert!(waiting(&e));
}

#[test]
fn a_trusted_server_in_a_project_covers_its_chats() {
    let hub = Hub::new(quiet());
    let (responder, mut rx) = Responder::for_test();
    attach(&hub, "a", "/tmp", Some("proj"), None);
    attach(&hub, "b", "/tmp", Some("proj"), None);
    attach(&hub, "c", "/tmp", None, None);
    // Codex: the approval names only the tool call; its title and input came with the tool call.
    let codex = |id: &str| json!({ "sessionUpdate": "tool_call", "toolCallId": id, "title": "mcp.linear.get_issue", "kind": "execute", "rawInput": { "server": "linear", "tool": "get_issue", "arguments": {} } });
    for (sid, n) in [("a", 1), ("b", 2), ("c", 3)] {
        hub.shared.with(sid, |s| apply_update(&hub.shared, s, &codex(&format!("{sid}1")))).unwrap();
        let (_, e) = ask(&hub, &responder, sid, n, json!({ "toolCallId": format!("{sid}1"), "kind": "execute", "status": "pending" }), options());
        assert!(matches!(&e, Entry::Permission { mcp_server: Some(m), chosen: None, .. } if m.id == "linear"), "{e:?}");
    }
    let index = hub.transcript("a").unwrap().entries.iter().position(|e| matches!(e, Entry::Permission { .. })).unwrap();
    let mut stored = None;
    hub.trust_server("a", index, Scope::Project, |project, server| {
        stored = Some((project.to_owned(), server.to_owned()));
        Ok(Project { trusted_mcp_servers: vec![server.to_owned()], ..test_project(project) })
    })
    .unwrap();
    assert_eq!(stored, Some(("proj".into(), "linear".into())), "kept with the project, not the chat");
    assert_eq!(hub.transcript("a").unwrap().info.trusted_mcp_servers, Vec::<String>::new());
    let mut got = answers(&mut rx);
    got.sort();
    assert_eq!(got, [(1, "o".to_owned()), (2, "o".to_owned())], "the project's chats; not the quick chat");

    // Stopping: the project's list is what counts.
    hub.set_project_trust(&test_project("proj"));
    hub.shared.with("a", |s| apply_update(&hub.shared, s, &codex("a2"))).unwrap();
    let (_, e) = ask(&hub, &responder, "a", 4, json!({ "toolCallId": "a2", "kind": "execute" }), options());
    assert!(waiting(&e));
}

fn test_project(id: &str) -> Project {
    Project {
        id: id.into(),
        name: id.into(),
        dirs: vec![],
        status: crate::projects::Status::Ongoing,
        created_at: 0,
        context_dir: String::new(),
        link: None,
        agent_id: None,
        trusted_mcp_servers: vec![],
    }
}

/// "Don't ask again" and a quick chat's trusted servers are saved with the chat:
/// after a restart they still answer, with the one-off option.
#[test]
fn always_and_trusted_servers_survive_a_restart() {
    let dir = std::env::temp_dir().join(format!("yaah-perm-restart-{}", random_token()));
    std::fs::create_dir_all(&dir).unwrap();
    {
        let hub = Hub::open(quiet(), Some(dir.clone()), Store::user());
        let (responder, _rx) = Responder::for_test();
        attach(&hub, "p", "/tmp", None, Some(&dir));
        let (i, _) = ask(&hub, &responder, "p", 1, json!({ "toolCallId": "t", "title": "npm test", "kind": "execute" }), options());
        hub.respond_permission("p", i, Some("a")).unwrap();
        let (i, _) = ask(
            &hub,
            &responder,
            "p",
            2,
            json!({ "toolCallId": "m", "title": "mcp__fetch__fetch", "name": "mcp__fetch__fetch", "kind": "other" }),
            options(),
        );
        hub.trust_server("p", i, Scope::Chat, |_, _| unreachable!()).unwrap();
        hub.flush();
    }
    let saved: Value = serde_json::from_slice(&std::fs::read(dir.join("p.json")).unwrap()).unwrap();
    assert_eq!(saved["info"]["remembered"], json!({ "npm test": "allow_always" }));
    assert_eq!(saved["info"]["trustedMcpServers"], json!(["fetch"]));

    let hub = Hub::open(quiet(), Some(dir.clone()), Store::user());
    let info = hub.shared.with_info("p", Clone::clone).unwrap();
    assert_eq!((info.remembered.len(), info.trusted_mcp_servers.len()), (1, 1), "read with the info, before the entries");
    hub.shared.with("p", |s| s.attached = Some(GEN)).unwrap();
    let (responder, mut rx) = Responder::for_test();
    let (_, e) = ask(&hub, &responder, "p", 3, json!({ "toolCallId": "t2", "title": "npm test", "kind": "execute" }), options());
    assert_eq!(auto_reason(&e), Some(permissions::REMEMBERED));
    let (_, e) = ask(
        &hub,
        &responder,
        "p",
        4,
        json!({ "toolCallId": "m2", "title": "mcp__fetch__fetch", "name": "mcp__fetch__fetch", "kind": "other" }),
        options(),
    );
    assert_eq!(auto_reason(&e), Some(permissions::TRUSTED_SERVER));
    assert_eq!(answers(&mut rx), [(3, "o".to_owned()), (4, "o".to_owned())]);
    drop(hub);
    std::fs::remove_dir_all(dir).unwrap();
}

/// A chat saved before `answer` existed: its answers are read from the chosen text,
/// so the transcript folds the same way.
#[test]
fn old_transcripts_get_their_answers_when_read() {
    let dir = std::env::temp_dir().join(format!("yaah-perm-old-{}", random_token()));
    std::fs::create_dir_all(&dir).unwrap();
    let opts = options();
    let old =
        |chosen: Value| json!({ "type": "permission", "requestId": 1, "toolCallId": "t", "title": "Run ls", "options": opts, "chosen": chosen });
    let file = json!({
        "info": test_info("old"),
        "entries": [
            old(json!("Allow")),
            old(json!("Always allow")),
            old(json!("Always allow (you said don't ask again)")),
            old(json!("Reject")),
            old(json!("cancelled")),
            old(json!(null)),
            old(json!("An option renamed since")),
        ]
    });
    std::fs::write(dir.join("old.json"), file.to_string()).unwrap();
    let hub = Hub::open(quiet(), Some(dir.clone()), Store::user());
    let got: Vec<(Option<String>, Option<String>)> = hub
        .transcript("old")
        .unwrap()
        .entries
        .iter()
        .map(|e| match e {
            Entry::Permission { answer, auto, .. } => (answer.clone(), auto.as_ref().map(|a| a.reason.clone())),
            _ => unreachable!(),
        })
        .collect();
    let s = |v: &str| Some(v.to_owned());
    assert_eq!(
        got,
        [
            (s("allow_once"), None),
            (s("allow_always"), None),
            (s("allow_always"), s(permissions::REMEMBERED)),
            (s("reject_once"), None),
            (s("cancelled"), None),
            (s("cancelled"), None),
            (None, None),
        ]
    );
    drop(hub);
    std::fs::remove_dir_all(dir).unwrap();
}

// ── scopes: quick chats, all chats ──────────────────────────────────────────

/// A home with a scratch folder for quick chats, a folder elsewhere, and a `settings.json` path.
struct Home {
    base: PathBuf,
}

impl Home {
    fn new() -> Self {
        let base = std::env::temp_dir().join(format!("yaah-perm-scopes-{}", random_token()));
        for d in [".yaah/scratch/q1", ".yaah/scratch/q2", "work/repo", "sessions", ".config/yaah"] {
            std::fs::create_dir_all(base.join(d)).unwrap();
        }
        Self { base: base.canonicalize().unwrap() }
    }
    fn p(&self, rel: &str) -> String {
        self.base.join(rel).to_string_lossy().into_owned()
    }
    fn settings(&self) -> PathBuf {
        self.base.join(".config/yaah/settings.json")
    }
    fn saved(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.settings()).unwrap()).unwrap()
    }
    /// A hub over `sessions/`, with quick chats in `.yaah/scratch` and settings in `.config/yaah`.
    fn hub(&self) -> Hub {
        let hub = Hub::open(quiet(), Some(self.base.join("sessions")), Store::user());
        hub.set_scratch_root(self.base.join(".yaah/scratch"));
        hub.use_permission_file_at(self.settings());
        hub
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

fn linear(id: &str, tool: &str) -> Value {
    json!({ "toolCallId": id, "title": format!("mcp__claude_ai_Linear__{tool}"), "kind": "other", "name": format!("mcp__claude_ai_Linear__{tool}") })
}

fn auto_why(e: &Entry) -> Option<(String, String)> {
    match e {
        Entry::Permission { auto: Some(a), .. } => Some((a.reason.clone(), a.why.clone())),
        _ => None,
    }
}

/// Trusting a server in one quick chat covers every quick chat (waiting and later
/// requests), not a chat in a folder of its own, and is kept in `settings.json`.
#[test]
fn quick_chats_share_one_trust_scope() {
    let h = Home::new();
    let hub = h.hub();
    let (responder, mut rx) = Responder::for_test();
    attach(&hub, "q1", &h.p(".yaah/scratch/q1"), None, None);
    attach(&hub, "q2", &h.p(".yaah/scratch/q2"), None, None);
    attach(&hub, "c", &h.p("work/repo"), None, None);
    let view = hub.trust_scope("q1").unwrap();
    assert_eq!((view.here, view.offered.clone()), (Scope::QuickChats, vec![Scope::QuickChats, Scope::Everywhere]));
    assert_eq!(hub.trust_scope("c").unwrap().offered, [Scope::Chat, Scope::Everywhere]);

    let (i, _) = ask(&hub, &responder, "q1", 1, linear("a", "get_issue"), options());
    ask(&hub, &responder, "q2", 2, linear("b", "get_issue"), options());
    ask(&hub, &responder, "c", 3, linear("c", "get_issue"), options());
    // "This chat" isn't a scope of its own for a quick chat.
    assert!(hub.trust_server("q1", i, Scope::Chat, |_, _| unreachable!()).unwrap_err().contains("in this chat"));
    assert!(hub.trust_server("q1", i, Scope::Project, |_, _| unreachable!()).is_err());
    hub.trust_server("q1", i, Scope::QuickChats, |_, _| unreachable!()).unwrap();
    let mut got = answers(&mut rx);
    got.sort();
    assert_eq!(got, [(1, "o".to_owned()), (2, "o".to_owned())], "both quick chats, allow_once; not the other chat");
    assert!(waiting(&hub.transcript("c").unwrap().entries.last().cloned().unwrap()));
    assert_eq!(h.saved()["quickChats"]["trustedMcpServers"], json!(["claude_ai_Linear"]));
    assert_eq!(hub.transcript("q1").unwrap().info.trusted_mcp_servers, Vec::<String>::new(), "kept with quick chats, not the chat");

    // A later request in the other quick chat, and in a quick chat started since.
    attach(&hub, "q3", &h.p(".yaah/scratch/q3"), None, None);
    for (sid, n) in [("q2", 4), ("q3", 5)] {
        let (_, e) = ask(&hub, &responder, sid, n, linear(&format!("{sid}d"), "update_issue"), options());
        assert_eq!(auto_why(&e), Some((permissions::TRUSTED_SERVER.into(), "trusted in quick chats: Linear".into())));
    }
    assert_eq!(answers(&mut rx), [(4, "o".to_owned()), (5, "o".to_owned())]);
    let view = hub.trust_scope("q3").unwrap();
    assert_eq!(view.servers, [trust::TrustedServer { id: "claude_ai_Linear".into(), label: "Linear".into(), scope: Scope::QuickChats }]);

    // Removed from one quick chat's header: gone from all of them.
    hub.untrust_chat_server("q2", "claude_ai_Linear").unwrap();
    let (_, e) = ask(&hub, &responder, "q1", 6, linear("e", "get_issue"), options());
    assert!(waiting(&e));
    assert_eq!(h.saved()["quickChats"]["trustedMcpServers"], json!([]));
}

/// "Don't ask again" in a quick chat answers the same request in every quick chat.
#[test]
fn quick_chats_share_dont_ask_again() {
    let h = Home::new();
    let hub = h.hub();
    let (responder, mut rx) = Responder::for_test();
    attach(&hub, "q1", &h.p(".yaah/scratch/q1"), None, None);
    attach(&hub, "q2", &h.p(".yaah/scratch/q2"), None, None);
    attach(&hub, "c", &h.p("work/repo"), None, None);
    let npm = || json!({ "toolCallId": "n", "title": "npm test", "kind": "execute", "rawInput": { "command": "npm test" } });
    let (i, _) = ask(&hub, &responder, "q1", 1, npm(), options());
    ask(&hub, &responder, "q2", 2, npm(), options());
    ask(&hub, &responder, "c", 3, npm(), options());
    hub.respond_permission("q1", i, Some("a")).unwrap();
    let mut got = answers(&mut rx);
    got.sort();
    assert_eq!(got, [(1, "a".to_owned()), (2, "o".to_owned())], "the user's own pick, then the one-off option in the other quick chat");
    let q2 = hub.transcript("q2").unwrap().entries;
    assert_eq!(auto_why(q2.last().unwrap()), Some((permissions::REMEMBERED.into(), "you said don't ask again in quick chats".into())));
    assert!(waiting(hub.transcript("c").unwrap().entries.last().unwrap()), "not a chat of its own");
    assert_eq!(h.saved()["quickChats"]["remembered"], json!({ "npm test": "allow_always" }));
    assert!(hub.transcript("q1").unwrap().info.remembered.is_empty());

    // Later, and after a restart.
    drop(hub);
    let hub = h.hub();
    attach(&hub, "q4", &h.p(".yaah/scratch/q4"), None, None);
    let (_, e) = ask(&hub, &responder, "q4", 4, npm(), options());
    assert_eq!(auto_reason(&e), Some(permissions::REMEMBERED));
    assert_eq!(answers(&mut rx), [(4, "o".to_owned())]);
}

/// A quick chat's own trusted servers and choices (from before quick chats shared a
/// scope) move into the shared scope once: a union, a "don't ask" winning.
#[test]
fn quick_chats_own_choices_move_into_the_shared_scope_once() {
    let h = Home::new();
    let saved = |id: &str, cwd: &str, servers: &[&str], remembered: &[(&str, &str)]| {
        let mut info = test_info(id);
        info.cwd = h.p(cwd);
        info.running = false;
        info.trusted_mcp_servers = servers.iter().map(|s| (*s).to_owned()).collect();
        info.remembered = remembered.iter().map(|(t, k)| ((*t).to_owned(), (*k).to_owned())).collect();
        let entries = vec![json!({ "type": "agent", "text": "kept", "messageId": null })];
        std::fs::write(h.base.join(format!("sessions/{id}.json")), json!({ "info": info, "entries": entries }).to_string()).unwrap();
    };
    saved("q1", ".yaah/scratch/q1", &["fetch", "claude_ai_Linear"], &[("npm test", "allow_always"), ("rm -rf build", "allow_always")]);
    saved("q2", ".yaah/scratch/q2", &["fetch", "github"], &[("rm -rf build", "reject_always")]);
    saved("c", "work/repo", &["slack"], &[("ls", "allow_always")]);
    std::fs::write(h.settings(), json!({ "theme": { "light": "yaah" }, "quickChats": { "trustedMcpServers": ["sentry"] } }).to_string()).unwrap();

    let hub = h.hub();
    let quick = &h.saved()["quickChats"];
    let mut servers: Vec<&str> = quick["trustedMcpServers"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    assert_eq!(servers.remove(0), "sentry", "what was there stays first");
    servers.sort_unstable();
    assert_eq!(servers, ["claude_ai_Linear", "fetch", "github"], "a union, each once");
    assert_eq!(quick["remembered"], json!({ "npm test": "allow_always", "rm -rf build": "reject_always" }), "a \"don't ask\" wins");
    assert_eq!(h.saved()["theme"], json!({ "light": "yaah" }), "other settings are kept");
    for id in ["q1", "q2"] {
        let info = hub.shared.with_info(id, Clone::clone).unwrap();
        assert!(info.trusted_mcp_servers.is_empty() && info.remembered.is_empty(), "{id} moved");
    }
    let c = hub.shared.with_info("c", Clone::clone).unwrap();
    assert_eq!((c.trusted_mcp_servers.len(), c.remembered.len()), (1, 1), "a chat of its own keeps its own");
    hub.flush();
    let q1: Value = serde_json::from_slice(&std::fs::read(h.base.join("sessions/q1.json")).unwrap()).unwrap();
    assert_eq!((q1["info"].get("trustedMcpServers"), q1["info"].get("remembered")), (None, None), "written without them");
    assert_eq!(q1["entries"][0]["text"], "kept", "and with its entries");
    assert_eq!(hub.migrate_quick_chats(), 0, "once");

    // The moved choices answer in a quick chat.
    let (responder, mut rx) = Responder::for_test();
    hub.shared.with("q2", |s| s.attached = Some(GEN)).unwrap();
    let (_, e) = ask(&hub, &responder, "q2", 1, linear("x", "get_issue"), options());
    assert_eq!(auto_why(&e), Some((permissions::TRUSTED_SERVER.into(), "trusted in quick chats: Linear".into())));
    let (_, e) = ask(&hub, &responder, "q2", 2, json!({ "toolCallId": "rm", "title": "rm -rf build", "kind": "execute" }), options());
    assert_eq!(auto_reason(&e), Some(permissions::REMEMBERED));
    assert_eq!(answers(&mut rx), [(1, "o".to_owned()), (2, "r".to_owned())], "the one-off reject");
    drop(hub);
    // Restarted: nothing moves twice, and the shared scope is as it was.
    let hub = h.hub();
    assert_eq!(hub.trust_scope("q1").unwrap().servers.len(), 4);
}

/// Trusted in all chats: every chat follows, it is kept in `settings.json` across a
/// restart, the narrowest scope that trusts a server names it, and a lookalike asks.
#[test]
fn a_server_trusted_everywhere_covers_every_chat() {
    let h = Home::new();
    let hub = h.hub();
    let (responder, mut rx) = Responder::for_test();
    attach(&hub, "c", &h.p("work/repo"), None, None);
    attach(&hub, "q", &h.p(".yaah/scratch/q1"), None, None);
    attach(&hub, "p", &h.p("work/repo"), Some("proj"), None);
    let (i, _) = ask(&hub, &responder, "c", 1, linear("a", "get_issue"), options());
    ask(&hub, &responder, "q", 2, linear("b", "get_issue"), options());
    ask(&hub, &responder, "p", 3, linear("c", "get_issue"), options());
    hub.trust_server("c", i, Scope::Everywhere, |_, _| unreachable!()).unwrap();
    let mut got = answers(&mut rx);
    got.sort();
    assert_eq!(got, [(1, "o".to_owned()), (2, "o".to_owned()), (3, "o".to_owned())]);
    let e = hub.transcript("p").unwrap().entries.last().cloned().unwrap();
    assert_eq!(auto_why(&e), Some((permissions::TRUSTED_EVERYWHERE.into(), "trusted in all chats: Linear".into())));
    assert_eq!(h.saved()["trustedMcpServers"], json!(["claude_ai_Linear"]));
    assert_eq!(hub.permission_settings().trusted_everywhere, [McpServer { id: "claude_ai_Linear".into(), label: "Linear".into() }]);

    // The project trusts it too: the project names it.
    hub.set_project_trust(&Project { trusted_mcp_servers: vec!["claude_ai_Linear".into()], ..test_project("proj") });
    let (_, e) = ask(&hub, &responder, "p", 4, linear("d", "get_issue"), options());
    assert_eq!(auto_why(&e), Some((permissions::TRUSTED_SERVER.into(), "trusted in this project: Linear".into())));
    let view = hub.trust_scope("p").unwrap();
    assert_eq!(view.servers.iter().map(|s| s.scope).collect::<Vec<_>>(), [Scope::Project, Scope::Everywhere]);
    // A lookalike name is no one's.
    let (_, e) = ask(
        &hub,
        &responder,
        "c",
        5,
        json!({ "toolCallId": "e", "title": "x", "name": "mcp__claude_ai_Linear2__get_issue", "kind": "other" }),
        options(),
    );
    assert!(waiting(&e));
    let _ = answers(&mut rx);

    // After a restart, then removed in Settings.
    drop(hub);
    let hub = h.hub();
    attach(&hub, "c2", &h.p("work/repo"), None, None);
    let (_, e) = ask(&hub, &responder, "c2", 6, linear("f", "get_issue"), options());
    assert_eq!(auto_reason(&e), Some(permissions::TRUSTED_EVERYWHERE));
    assert_eq!(hub.untrust_everywhere("claude_ai_Linear").unwrap().trusted_everywhere, Vec::<McpServer>::new());
    let (_, e) = ask(&hub, &responder, "c2", 7, linear("g", "get_issue"), options());
    assert!(waiting(&e));
    assert_eq!(h.saved()["trustedMcpServers"], json!([]));
    assert_eq!(answers(&mut rx), [(6, "o".to_owned())]);
}

/// "Allow web searches without asking": off by default; on, a web search is answered
/// with `allow_once`; fetches keep asking.
#[test]
fn web_searches_are_answered_only_when_turned_on() {
    let h = Home::new();
    let hub = h.hub();
    let (responder, mut rx) = Responder::for_test();
    attach(&hub, "c", &h.p("work/repo"), None, None);
    // As claude-agent-acp sends Claude Code's WebSearch: kind `fetch`, named in `name`.
    let search = |id: &str| json!({ "toolCallId": id, "title": "Search \"acp permission modes\"", "kind": "fetch", "name": "WebSearch", "rawInput": { "query": "acp permission modes" } });
    let (_, e) = ask(&hub, &responder, "c", 1, search("s1"), options());
    assert!(waiting(&e), "off by default");
    assert!(!hub.permission_settings().allow_web_search);
    hub.set_allow_web_search(true).unwrap();
    assert_eq!(h.saved()["allowWebSearch"], true);
    let (_, e) = ask(&hub, &responder, "c", 2, search("s2"), options());
    assert_eq!(auto_why(&e), Some((permissions::WEB_SEARCH.into(), "web search allowed in Settings".into())));
    for (n, fetch) in [
        (
            3,
            json!({ "toolCallId": "f1", "title": "Fetch https://example.com", "kind": "fetch", "name": "WebFetch", "rawInput": { "url": "https://example.com", "prompt": "x" } }),
        ),
        (
            4,
            json!({ "toolCallId": "f2", "title": "mcp__fetch__fetch", "kind": "other", "name": "mcp__fetch__fetch", "rawInput": { "url": "https://example.com" } }),
        ),
    ] {
        let (_, e) = ask(&hub, &responder, "c", n, fetch, options());
        assert!(waiting(&e), "{n}: a fetch asks");
    }
    hub.set_allow_web_search(false).unwrap();
    let (_, e) = ask(&hub, &responder, "c", 5, search("s3"), options());
    assert!(waiting(&e));
    assert_eq!(answers(&mut rx), [(2, "o".to_owned())], "allow_once only");
    // Read back after a restart.
    hub.set_allow_web_search(true).unwrap();
    drop(hub);
    assert!(h.hub().permission_settings().allow_web_search);
}

/// A Claude chat's own saved tool results are a read root, through the handler and
/// the profile's config dir; a sibling session's asks; a command there says so and asks.
#[test]
fn a_claude_chats_saved_tool_results_are_read_without_asking() {
    let h = Home::new();
    let cfg = h.base.join(".claude-personal");
    let cwd = h.p(".yaah/scratch/q1");
    let project = cfg.join("projects").join(permissions::claude_slug(&cwd));
    for session in ["acp-1", "acp-2"] {
        std::fs::create_dir_all(project.join(session).join("tool-results")).unwrap();
        std::fs::write(project.join(session).join("tool-results/mcp-fetch-fetch-1.txt"), "saved").unwrap();
    }
    let agents = h.base.join(".config/yaah/agents.json");
    let profile =
        json!({ "id": "claude-personal", "label": "Claude (personal)", "preset": "claude", "command": "claude-agent-acp", "configDir": cfg });
    std::fs::write(&agents, json!({ "profiles": [profile] }).to_string()).unwrap();
    let store: &'static Store = Box::leak(Box::new(Store::at(agents)));
    let hub = Hub::open(quiet(), None, store);
    let (responder, mut rx) = Responder::for_test();
    let mut info = test_info("chat-1");
    info.cwd = cwd;
    info.account_id = "claude-personal".into();
    info.agent_session_id = Some("acp-1".into());
    let mut s = Session::new(info, vec![], None);
    s.attached = Some(GEN);
    hub.shared.insert(s);

    let read = |id: &str, session: &str| {
        let file = project.join(session).join("tool-results/mcp-fetch-fetch-1.txt").to_string_lossy().into_owned();
        json!({ "toolCallId": id, "title": "Read", "kind": "read", "name": "Read", "rawInput": { "file_path": file }, "locations": [{ "path": file }] })
    };
    let (_, e) = ask(&hub, &responder, "chat-1", 1, read("r1", "acp-1"), options());
    assert_eq!(auto_why(&e), Some((permissions::TOOL_RESULTS.into(), "Claude's saved tool result from this chat".into())));
    let (_, e) = ask(&hub, &responder, "chat-1", 2, read("r2", "acp-2"), options());
    assert!(waiting(&e), "another session's results ask");
    let dir = project.join("acp-1/tool-results").to_string_lossy().into_owned();
    let bash = json!({ "toolCallId": "b", "title": format!("grep -n x {dir}/mcp-fetch-fetch-1.txt"), "kind": "execute", "name": "Bash", "rawInput": { "command": format!("grep -n x {dir}/mcp-fetch-fetch-1.txt") } });
    let (_, e) = ask(&hub, &responder, "chat-1", 3, bash, options());
    assert!(matches!(&e, Entry::Permission { chosen: None, note: Some(n), .. } if n == "Claude is reading a saved tool result"), "{e:?}");
    assert_eq!(answers(&mut rx), [(1, "o".to_owned())]);
    // Reads off: it asks there too.
    hub.set_trust_read_only(false);
    let (_, e) = ask(&hub, &responder, "chat-1", 4, read("r3", "acp-1"), options());
    assert!(waiting(&e));
}

// ── built-in read-only commands, shared shell rules, ask rules ──────────────

fn bash(id: &str, command: &str) -> Value {
    json!({ "toolCallId": id, "title": command, "kind": "execute", "name": "Bash", "rawInput": { "command": command, "description": "d" } })
}

#[test]
fn built_in_read_only_commands_are_allowed_marked_and_the_rest_ask() {
    let h = Home::new();
    let hub = h.hub();
    let (responder, mut rx) = Responder::for_test();
    attach(&hub, "c", &h.p("work/repo"), None, None);
    std::fs::create_dir_all(h.base.join("work/repo/src")).unwrap();
    let safe = [
        "ls -la",
        "pwd",
        "cat src/lib.rs | head -20",
        "git status",
        "git diff --stat | tail -3",
        "cd src && ls; pwd",
        "git log -n 5 --oneline",
        "wc -l src/lib.rs 2>&1",
        "echo hi",
        "git branch --list",
    ];
    for (n, command) in (1..).zip(safe) {
        let (_, e) = ask(&hub, &responder, "c", n, bash(&format!("s{n}"), command), options());
        assert_eq!(auto_why(&e), Some((shell_rules::BUILTIN.into(), "built-in: read-only command".into())), "{command}");
    }
    assert_eq!(answers(&mut rx).len(), safe.len());
    let unsafe_ = [
        "rm -rf x",
        "find . -exec rm {} ;",
        "find . -name x",
        "sed -i s/a/b/ f",
        "awk 'BEGIN{system(\"id\")}'",
        "xargs ls",
        "env",
        "ls | xargs rm",
        "cat a > b",
        "cat a >> b",
        "ls $(pwd)",
        "ls `pwd`",
        "ls; rm x",
        "ls && git push",
        "cat /etc/passwd",
        "cat ../x",
        "cat ~/.ssh/id_rsa",
        "git -c core.pager=x status",
        "git diff --output=out",
        "git diff --ext-diff",
        "git log --textconv",
        "git branch newbranch",
        "git branch -D x",
        "git tag v1",
        "git checkout x",
        "git commit -m x",
        "git show --output=x",
        "sort -o out in",
        "grep -f pats x",
        "grep -rf pats x",
        "tail -f log",
        "date -s 2020-01-01",
        "hostname evil",
        "curl http://example.com",
        "python -c 1",
        "bash -c ls",
        "cp a b",
        "mkdir x",
        "touch x",
        "tee x",
    ];
    for (n, command) in (100..).zip(unsafe_) {
        let (_, e) = ask(&hub, &responder, "c", n, bash(&format!("u{n}"), command), options());
        assert!(waiting(&e), "{command} must ask: {e:?}");
    }
    assert_eq!(answers(&mut rx), [], "nothing else was answered for the user");
    // A symlink in the repository that points out of it.
    std::os::unix::fs::symlink(h.base.join(".config"), h.base.join("work/repo/link")).unwrap();
    let (_, e) = ask(&hub, &responder, "c", 300, bash("l1", "ls link"), options());
    assert!(waiting(&e), "{e:?}");
    // Not an `execute`, or other tool input beside the command: ask.
    let odd = json!({ "toolCallId": "o1", "title": "ls", "kind": "other", "rawInput": { "command": "ls" } });
    assert!(waiting(&ask(&hub, &responder, "c", 301, odd, options()).1));
    let extra = json!({ "toolCallId": "o2", "title": "ls", "kind": "execute", "rawInput": { "command": "ls", "dangerouslyDisableSandbox": true } });
    assert!(waiting(&ask(&hub, &responder, "c", 302, extra, options()).1));
}

/// A Claude Code request without a "don't ask again" option is one the CLI insisted on (a user's `ask`
/// rule, a risky action): yaah's own allows must not answer it. Other agents are not judged by it.
#[test]
fn an_ask_the_agent_insisted_on_is_never_answered_by_yaah() {
    let h = Home::new();
    let agents = h.base.join(".config/yaah/agents.json");
    let profile = json!({ "id": "claude-personal", "label": "Claude", "preset": "claude", "command": "claude-agent-acp" });
    let codex = json!({ "id": "codex", "label": "Codex", "preset": "codex", "command": "codex-acp" });
    std::fs::write(&agents, json!({ "profiles": [profile, codex] }).to_string()).unwrap();
    let store: &'static Store = Box::leak(Box::new(Store::at(agents)));
    let hub = Hub::open(quiet(), Some(h.base.join("sessions")), store);
    hub.use_permission_file_at(h.settings());
    let (responder, mut rx) = Responder::for_test();
    let mut info = test_info("cl");
    info.cwd = h.p("work/repo");
    info.account_id = "claude-personal".into();
    let mut s = Session::new(info, vec![], None);
    s.attached = Some(GEN);
    hub.shared.insert(s);
    attach(&hub, "other", &h.p("work/repo"), None, None);
    hub.shared.with("other", |s| s.info.account_id = "codex".into()).unwrap();
    let once_only = json!([{ "optionId": "o", "name": "Yes", "kind": "allow_once" }, { "optionId": "r", "name": "No", "kind": "reject_once" }]);
    let read = |id: &str| {
        let file = h.p("work/repo");
        json!({ "toolCallId": id, "title": "Read", "kind": "read", "name": "Read", "rawInput": { "file_path": file }, "locations": [{ "path": file }] })
    };
    // With the option: answered as before. Without it: asks, for every kind of allow yaah has.
    assert_eq!(auto_reason(&ask(&hub, &responder, "cl", 1, read("r1"), options()).1), Some(permissions::READ_ONLY));
    assert_eq!(auto_reason(&ask(&hub, &responder, "cl", 2, bash("b1", "git status"), options()).1), Some(shell_rules::BUILTIN));
    assert!(waiting(&ask(&hub, &responder, "cl", 3, read("r2"), once_only.clone()).1));
    assert!(waiting(&ask(&hub, &responder, "cl", 4, bash("b2", "git status"), once_only.clone()).1));
    assert!(waiting(&ask(&hub, &responder, "cl", 5, linear("l1", "get_issue"), once_only.clone()).1));
    hub.shared.with("cl", |s| s.info.shell_rules = vec!["pnpm vitest".into()]).unwrap();
    assert!(waiting(&ask(&hub, &responder, "cl", 6, bash("b3", "pnpm vitest run"), once_only.clone()).1), "a rule doesn't beat the agent's ask");
    let remembered = json!({ "toolCallId": "m", "title": "npm test", "kind": "execute" });
    hub.shared.with("cl", |s| s.info.remembered.insert("npm test".into(), "allow_always".into())).unwrap();
    assert!(waiting(&ask(&hub, &responder, "cl", 7, remembered, once_only.clone()).1));
    assert_eq!(answers(&mut rx), [(1, "o".to_owned()), (2, "o".to_owned())]);
    // Another agent (not Claude Code) has no such signal: unchanged.
    let (_, e) = ask(&hub, &responder, "other", 8, bash("b4", "git status"), once_only);
    assert_eq!(auto_reason(&e), Some(shell_rules::BUILTIN));
}

/// "Don't ask again" on a command in a project chat is kept for the project: another chat of it, and a
/// restart, are answered; a chat outside the project is not. It can be taken back, and only yaah's
/// `settings.json` is written.
#[test]
fn a_dont_ask_again_on_a_command_covers_the_whole_project() {
    let h = Home::new();
    let hub = h.hub();
    let (responder, mut rx) = Responder::for_test();
    for id in ["p1", "p2"] {
        attach(&hub, id, &h.p("work/repo"), Some("proj"), None);
    }
    attach(&hub, "solo", &h.p("work/repo"), None, None);
    let (i, e) = ask(&hub, &responder, "p1", 1, bash("t1", "cd . && pnpm vitest run a; pnpm tsc --noEmit | tail -3"), options());
    let Entry::Permission { options: shown, .. } = &e else { panic!() };
    assert_eq!(shown[3]["name"], "Allow pnpm vitest, pnpm tsc in this project (runs project code)");
    hub.respond_permission("p1", i, Some(shell_rules::RULE_OPTION)).unwrap();
    assert!(hub.transcript("p1").unwrap().info.shell_rules.is_empty(), "kept with the project, not the chat");
    assert_eq!(h.saved()["shellRules"], json!({ "project:proj": ["pnpm vitest", "pnpm tsc"] }));
    let (_, e) = ask(&hub, &responder, "p2", 2, bash("t2", "pnpm tsc --noEmit"), options());
    assert_eq!(auto_why(&e), Some((permissions::REMEMBERED.into(), "rule: pnpm tsc".into())));
    // One part without a rule asks; a chat outside the project asks.
    assert!(waiting(&ask(&hub, &responder, "p2", 3, bash("t3", "pnpm tsc; pnpm install"), options()).1));
    assert!(waiting(&ask(&hub, &responder, "solo", 4, bash("t4", "pnpm tsc"), options()).1));
    let view = hub.trust_scope("p2").unwrap();
    assert_eq!(
        view.shell_rules.iter().map(|r| (r.rule.as_str(), r.scope)).collect::<Vec<_>>(),
        [("pnpm vitest", Scope::Project), ("pnpm tsc", Scope::Project)]
    );
    assert_eq!(hub.trust_scope("solo").unwrap().shell_rules.len(), 0);

    drop(hub);
    let hub = h.hub();
    attach(&hub, "p3", &h.p("work/repo"), Some("proj"), None);
    assert_eq!(auto_reason(&ask(&hub, &responder, "p3", 5, bash("t5", "pnpm vitest run b"), options()).1), Some(permissions::REMEMBERED));
    hub.forget_shell_rule("p3", "pnpm vitest", Scope::Project).unwrap();
    assert_eq!(h.saved()["shellRules"], json!({ "project:proj": ["pnpm tsc"] }));
    assert!(waiting(&ask(&hub, &responder, "p3", 6, bash("t6", "pnpm vitest run b"), options()).1));
    assert!(hub.forget_shell_rule("p3", "pnpm tsc", Scope::QuickChats).is_err(), "not a scope this chat has");
    let got = answers(&mut rx);
    assert_eq!(got.iter().filter(|(_, o)| o == "o").count(), 3, "the agent got its one-off allow (p1, p2, p3): {got:?}");
    assert!(!got.iter().any(|(_, o)| o == "a" || o == shell_rules::RULE_OPTION), "never its own always: {got:?}");
}

#[test]
fn quick_chats_share_command_rules_and_a_lone_chat_keeps_its_own() {
    let h = Home::new();
    let hub = h.hub();
    let (responder, _rx) = Responder::for_test();
    attach(&hub, "q1", &h.p(".yaah/scratch/q1"), None, None);
    attach(&hub, "q2", &h.p(".yaah/scratch/q2"), None, None);
    attach(&hub, "c", &h.p("work/repo"), None, None);
    let (i, e) = ask(&hub, &responder, "q1", 1, bash("a", "cargo test"), options());
    let Entry::Permission { options: shown, .. } = &e else { panic!() };
    assert_eq!(shown[3]["name"], "Allow cargo test in quick chats (runs project code)");
    hub.respond_permission("q1", i, Some(shell_rules::RULE_OPTION)).unwrap();
    assert_eq!(h.saved()["shellRules"], json!({ "quick": ["cargo test"] }));
    assert_eq!(auto_reason(&ask(&hub, &responder, "q2", 2, bash("b", "cargo test --lib"), options()).1), Some(permissions::REMEMBERED));
    let (i, e) = ask(&hub, &responder, "c", 3, bash("c", "cargo test"), options());
    let Entry::Permission { options: shown, .. } = &e else { panic!() };
    assert_eq!(shown[3]["name"], "Allow cargo test in this chat (runs project code)");
    hub.respond_permission("c", i, Some(shell_rules::RULE_OPTION)).unwrap();
    assert_eq!(hub.transcript("c").unwrap().info.shell_rules, ["cargo test"]);
    assert_eq!(h.saved()["shellRules"], json!({ "quick": ["cargo test"] }), "a lone chat's rule isn't shared");
}

#[test]
fn saved_shell_rules_are_checked_when_read() {
    let h = Home::new();
    std::fs::write(
        h.settings(),
        json!({ "shellRules": {
            "project:proj": ["pnpm vitest", "rm", "git push", "pnpm run build", "git status", "git status", 7, "sh -c x"],
            "other": ["pnpm tsc"], "project:": ["pnpm tsc"], "quick": "nope"
        } })
        .to_string(),
    )
    .unwrap();
    let hub = h.hub();
    attach(&hub, "p", &h.p("work/repo"), Some("proj"), None);
    let rules = hub.shared.shared_shell_rules(&hub.shared.with_info("p", Clone::clone).unwrap());
    assert_eq!(rules, ["pnpm vitest", "git status"], "only rules the table could have written, once");
    // Malformed as a whole: nothing.
    std::fs::write(h.settings(), "{ not json").unwrap();
    let hub = h.hub();
    attach(&hub, "p", &h.p("work/repo"), Some("proj"), None);
    assert_eq!(hub.shared.shared_shell_rules(&hub.shared.with_info("p", Clone::clone).unwrap()), Vec::<String>::new());
}

// ── review fixes: bare repositories, the separate rule option, rule removal ──

fn plant_bare(dir: &Path, marker: &Path) {
    for d in ["objects", "refs"] {
        std::fs::create_dir_all(dir.join(d)).unwrap();
    }
    std::fs::write(dir.join("HEAD"), "ref: refs/heads/main\n").unwrap();
    std::fs::write(dir.join("config"), format!("[core]\n\tbare = true\n\tfsmonitor = touch {}\n", marker.display())).unwrap();
}

/// A plain folder that looks like a git directory (config naming a program) is never a place `git`
/// runs unasked: not through the built-in list, not through a learned rule, not with a `cd` before it.
#[test]
fn git_in_a_fake_bare_repository_asks_and_never_runs() {
    let h = Home::new();
    let hub = h.hub();
    let (responder, mut rx) = Responder::for_test();
    let marker = h.base.join("PWNED");
    plant_bare(&h.base.join("work/repo/sub"), &marker);
    attach(&hub, "c", &h.p("work/repo"), None, None);
    hub.shared.with("c", |s| s.info.shell_rules = vec!["git status".into(), "git log".into(), "git diff".into()]).unwrap();
    for (n, command) in (1..).zip(["cd sub && git status", "cd sub && git log -n 3", "cd sub && git diff", "cd sub && ls && git status"]) {
        let (_, e) = ask(&hub, &responder, "c", n, bash(&format!("g{n}"), command), options());
        assert!(waiting(&e), "{command}: {e:?}");
    }
    // The chat's own folder being the fake repository.
    attach(&hub, "bare", &h.p("work/repo/sub"), None, None);
    hub.shared.with("bare", |s| s.info.shell_rules = vec!["git status".into()]).unwrap();
    assert!(waiting(&ask(&hub, &responder, "bare", 10, bash("b1", "git status"), options()).1));
    assert!(waiting(&ask(&hub, &responder, "bare", 11, bash("b2", "git log"), options()).1));
    // A normal chat folder still works, and so does `ls` in the fake one.
    assert_eq!(auto_reason(&ask(&hub, &responder, "c", 20, bash("ok", "git status"), options()).1), Some(permissions::REMEMBERED));
    assert_eq!(auto_reason(&ask(&hub, &responder, "bare", 21, bash("ls", "ls"), options()).1), Some(shell_rules::BUILTIN));
    assert_eq!(answers(&mut rx).len(), 2);
    assert!(!marker.exists(), "git never ran");
}

#[test]
fn the_built_in_read_only_list_follows_the_trust_read_only_setting() {
    let h = Home::new();
    let hub = h.hub();
    let (responder, _rx) = Responder::for_test();
    attach(&hub, "c", &h.p("work/repo"), None, None);
    assert_eq!(auto_reason(&ask(&hub, &responder, "c", 1, bash("a", "ls"), options()).1), Some(shell_rules::BUILTIN));
    hub.set_trust_read_only(false);
    assert!(waiting(&ask(&hub, &responder, "c", 2, bash("b", "ls"), options()).1));
    hub.set_trust_read_only(true);
    assert_eq!(auto_reason(&ask(&hub, &responder, "c", 3, bash("c", "ls"), options()).1), Some(shell_rules::BUILTIN));
}

/// yaah's rule option sits beside the agent's options, which keep their ids and names. Choosing it answers
/// the agent with its one-off allow (never its "always", which would write the agent's own settings),
/// keeps the rule in yaah, remembers no exact command, tells the header, and answers siblings it allows.
#[test]
fn the_rule_option_is_separate_and_answers_the_agent_with_its_one_off_allow() {
    let h = Home::new();
    let events: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
    let sink = events.clone();
    let emit: Emit = Arc::new(move |name: &str, _: Value| sink.lock().unwrap().push(name.to_owned()));
    let hub = Hub::open(emit, Some(h.base.join("sessions")), Store::user());
    hub.set_scratch_root(h.base.join(".yaah/scratch"));
    hub.use_permission_file_at(h.settings());
    let (responder, mut rx) = Responder::for_test();
    attach(&hub, "c", &h.p("work/repo"), None, None);
    let (first, e) = ask(&hub, &responder, "c", 1, bash("t1", "pnpm vitest run a"), options());
    let Entry::Permission { options: shown, .. } = &e else { panic!() };
    assert_eq!(shown.as_array().unwrap()[..3], options().as_array().unwrap()[..], "the agent's options are untouched");
    assert_eq!(
        shown[3],
        json!({ "optionId": shell_rules::RULE_OPTION, "name": "Allow pnpm vitest in this chat (runs project code)", "kind": shell_rules::RULE_KIND })
    );
    let (_, sibling) = ask(&hub, &responder, "c", 2, bash("t2", "pnpm vitest run b | tail -2"), options());
    assert!(waiting(&sibling));
    let (_, other) = ask(&hub, &responder, "c", 3, bash("t3", "pnpm tsc"), options());
    assert!(waiting(&other));
    events.lock().unwrap().clear();

    hub.respond_permission("c", first, Some(shell_rules::RULE_OPTION)).unwrap();
    let got = answers(&mut rx);
    assert_eq!(got, [(1, "o".to_owned()), (2, "o".to_owned())], "the agent's allow_once, never its always or our id");
    let info = hub.transcript("c").unwrap();
    assert_eq!(info.info.shell_rules, ["pnpm vitest"]);
    assert!(info.info.remembered.is_empty(), "no exact command kept");
    let Entry::Permission { chosen, answer, .. } = &info.entries[first] else { panic!() };
    assert_eq!((chosen.as_deref(), answer.as_deref()), (Some("Allow pnpm vitest in this chat (runs project code)"), Some("allow_once")));
    let perms: Vec<&Entry> = info.entries.iter().filter(|e| matches!(e, Entry::Permission { .. })).collect();
    assert_eq!(auto_why(perms[1]), Some((permissions::REMEMBERED.into(), "rule: pnpm vitest".into())));
    assert!(waiting(perms[2]), "a command the rule doesn't cover still asks");
    assert!(events.lock().unwrap().iter().any(|e| e == "trust-changed"), "the header list refreshes");

    // The agent's own "always" is not ours: it is the agent's, and nothing of yaah's is kept for it.
    attach(&hub, "d", &h.p("work/repo"), None, None);
    let (i, _) = ask(&hub, &responder, "d", 4, bash("u1", "pnpm eslint src"), options());
    hub.respond_permission("d", i, Some("a")).unwrap();
    assert_eq!(answers(&mut rx), [(4, "a".to_owned())]);
    assert_eq!(hub.transcript("d").unwrap().info.shell_rules, Vec::<String>::new());
}

#[test]
fn no_rule_option_when_the_cap_is_reached_or_the_agent_has_no_one_off_allow() {
    let h = Home::new();
    let hub = h.hub();
    let (responder, _rx) = Responder::for_test();
    attach(&hub, "c", &h.p("work/repo"), None, None);
    let count = |e: &Entry| match e {
        Entry::Permission { options, .. } => options.as_array().unwrap().len(),
        _ => 0,
    };
    assert_eq!(count(&ask(&hub, &responder, "c", 1, bash("a", "cargo clippy"), options()).1), 4);
    hub.shared.with("c", |s| s.info.shell_rules = (0..64).map(|i| format!("pnpm x{i}")).collect()).unwrap();
    assert_eq!(count(&ask(&hub, &responder, "c", 2, bash("b", "cargo clippy"), options()).1), 3, "full: not offered");
    let always_only =
        json!([{ "optionId": "a", "name": "Always", "kind": "allow_always" }, { "optionId": "r", "name": "No", "kind": "reject_once" }]);
    hub.shared.with("c", |s| s.info.shell_rules.clear()).unwrap();
    assert_eq!(count(&ask(&hub, &responder, "c", 3, bash("c", "cargo clippy"), always_only).1), 2);
}

#[test]
fn removing_a_rule_also_removes_the_exact_commands_it_covered() {
    let h = Home::new();
    let hub = h.hub();
    let (responder, _rx) = Responder::for_test();
    attach(&hub, "c", &h.p("work/repo"), None, None);
    hub.shared
        .with("c", |s| {
            s.info.shell_rules = vec!["pnpm vitest".into(), "pnpm tsc".into()];
            s.info.remembered.insert("pnpm vitest run a".into(), "allow_always".into());
            s.info.remembered.insert("pnpm tsc".into(), "allow_always".into());
            s.info.remembered.insert("Read".into(), "allow_always".into());
        })
        .unwrap();
    hub.forget_shell_rule("c", "pnpm vitest", Scope::Chat).unwrap();
    let info = hub.transcript("c").unwrap().info;
    assert_eq!(info.shell_rules, ["pnpm tsc"]);
    assert_eq!(info.remembered.keys().map(String::as_str).collect::<Vec<_>>(), ["Read", "pnpm tsc"], "only the covered command went");
    assert!(waiting(&ask(&hub, &responder, "c", 1, bash("a", "pnpm vitest run a"), options()).1), "asks again");
}

#[test]
fn a_later_update_sets_the_parent_of_a_tool_call() {
    let h = Home::new();
    let hub = h.hub();
    attach(&hub, "c", &h.p("work/repo"), None, None);
    let parent = |hub: &Hub| match &hub.transcript("c").unwrap().entries[0] {
        Entry::Tool { parent_tool_call_id, .. } => parent_tool_call_id.clone(),
        _ => panic!(),
    };
    hub.shared.with("c", |s| upsert_tool(&hub.shared, s, &json!({ "toolCallId": "t", "title": "x" }))).unwrap();
    assert_eq!(parent(&hub), None);
    let with_parent = json!({ "toolCallId": "t", "_meta": { "claudeCode": { "parentToolUseId": "p1" } } });
    hub.shared.with("c", |s| upsert_tool(&hub.shared, s, &with_parent)).unwrap();
    assert_eq!(parent(&hub).as_deref(), Some("p1"));
    let other = json!({ "toolCallId": "t", "_meta": { "claudeCode": { "parentToolUseId": "p2" } } });
    hub.shared.with("c", |s| upsert_tool(&hub.shared, s, &other)).unwrap();
    assert_eq!(parent(&hub).as_deref(), Some("p1"), "set once");
}
