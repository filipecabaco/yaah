//! Permission requests through the real handler (`handle_incoming`), with a chat
//! attached to agent generation 1 and the answers the agent would read.

use super::*;
use crate::acp::Responder;
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
fn a_trusted_server_in_a_quick_chat_answers_its_waiting_and_later_requests() {
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

    hub.trust_server("p", i, |_, _| unreachable!("a quick chat keeps it itself")).unwrap();
    assert_eq!(answers(&mut rx), [(1, "o".to_owned()), (2, "o".to_owned())], "both of Linear's, with allow_once");
    let t = hub.transcript("p").unwrap();
    assert_eq!(t.info.trusted_mcp_servers, ["claude_ai_Linear"]);
    assert_eq!(auto_reason(&t.entries[i]), Some(permissions::TRUSTED_SERVER));
    assert!(waiting(t.entries.iter().rfind(|e| matches!(e, Entry::Permission { .. })).unwrap()), "GitHub still asks");

    // Later requests, a tool that changes things too.
    let (_, e) = ask(&hub, &responder, "p", 4, linear("d", "update_issue"), options());
    assert!(matches!(&e, Entry::Permission { auto: Some(a), .. } if a.why == "trusted server: Linear"));
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
    assert!(hub.trust_server("p", bash_at, |_, _| unreachable!()).unwrap_err().contains("can't tell which MCP server"));

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
    hub.trust_server("a", index, |project, server| {
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
        hub.trust_server("p", i, |_, _| unreachable!()).unwrap();
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
