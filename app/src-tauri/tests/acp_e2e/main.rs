//! End to end: the real `Hub`, `acp.rs` and `login.rs` against a scripted ACP
//! agent running as its own process. The agent is this binary, started again
//! with `YAAH_SCRIPTED_AGENT` set (see `agent.rs`); nothing is faked in-process.
//!
//! `harness = false`: `main` is the agent or the test runner. Arguments filter
//! tests by name, as with libtest.

mod agent;

use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use yaah_lib::agent_guide::{self, Guide};
use yaah_lib::agents::{self, Draft, Store};
use yaah_lib::login::Logins;
use yaah_lib::projects::{Project, Status};
use yaah_lib::session::{ChatTarget, Emit, Entry, Hub, Transcript, random_token};

const ACCOUNT: &str = "scripted";
const PATIENCE: Duration = Duration::from_secs(20);

fn main() {
    if std::env::var_os(agent::ENV).is_some() {
        return agent::run();
    }
    let tests: &[(&str, fn())] = &[
        ("initialize_advertises_notices_and_a_turn_streams", initialize_advertises_notices_and_a_turn_streams),
        ("long_replies_stream_as_coalesced_appends", long_replies_stream_as_coalesced_appends),
        ("project_chats_send_the_brief_and_folders_once", project_chats_send_the_brief_and_folders_once),
        ("dont_ask_again_answers_waiting_and_later_requests_in_that_chat_only", dont_ask_again_answers_waiting_and_later_requests_in_that_chat_only),
        ("unnamed_requests_are_never_remembered", unnamed_requests_are_never_remembered),
        ("notices_and_the_mcp_status_fallback_make_one_card", notices_and_the_mcp_status_fallback_make_one_card),
        ("cancel_answers_waiting_permissions_and_tells_the_agent", cancel_answers_waiting_permissions_and_tells_the_agent),
        ("a_crashed_agent_is_restarted_and_the_chat_reattached", a_crashed_agent_is_restarted_and_the_chat_reattached),
        ("chats_survive_a_restart_and_reattach_with_session_load", chats_survive_a_restart_and_reattach_with_session_load),
        ("malformed_output_is_skipped_and_the_chat_carries_on", malformed_output_is_skipped_and_the_chat_carries_on),
        ("agents_yaah_cant_use_are_refused", agents_yaah_cant_use_are_refused),
        ("auth_errors_ask_for_a_login", auth_errors_ask_for_a_login),
        ("logins_run_the_agents_methods", logins_run_the_agents_methods),
        ("an_agent_cant_write_into_or_take_over_another_agents_chat", an_agent_cant_write_into_or_take_over_another_agents_chat),
        ("the_ui_guide_goes_in_the_acp_system_prompt_when_advertised", the_ui_guide_goes_in_the_acp_system_prompt_when_advertised),
        ("the_ui_guide_goes_with_the_first_prompt_otherwise", the_ui_guide_goes_with_the_first_prompt_otherwise),
        ("claude_gets_the_ui_guide_and_plugin_beside_allowed_tools", claude_gets_the_ui_guide_and_plugin_beside_allowed_tools),
        ("switching_agents_hands_the_chat_to_a_fresh_session", switching_agents_hands_the_chat_to_a_fresh_session),
        ("a_switched_chat_reloads_on_its_new_agent_after_a_restart", a_switched_chat_reloads_on_its_new_agent_after_a_restart),
        ("switching_agents_is_refused_mid_turn", switching_agents_is_refused_mid_turn),
        (
            "added_repos_reach_the_agent_through_session_load_before_the_next_prompt",
            added_repos_reach_the_agent_through_session_load_before_the_next_prompt,
        ),
        (
            "an_agent_without_load_gets_added_repos_in_a_fresh_session_and_a_hand_off",
            an_agent_without_load_gets_added_repos_in_a_fresh_session_and_a_hand_off,
        ),
        ("other_chats_in_the_project_pick_up_added_repos_on_their_next_prompt", other_chats_in_the_project_pick_up_added_repos_on_their_next_prompt),
        ("quick_chats_start_with_repos_chosen_up_front", quick_chats_start_with_repos_chosen_up_front),
    ];
    let filters: Vec<String> = std::env::args().skip(1).filter(|a| !a.starts_with('-')).collect();
    let chosen: Vec<_> = tests.iter().filter(|(name, _)| filters.is_empty() || filters.iter().any(|f| name.contains(f.as_str()))).collect();
    println!("\nrunning {} tests", chosen.len());
    let mut failed = vec![];
    for (name, test) in chosen {
        let started = Instant::now();
        let ok = std::panic::catch_unwind(test).is_ok();
        println!("test {name} ... {} ({:.1}s)", if ok { "ok" } else { "FAILED" }, started.elapsed().as_secs_f32());
        if !ok {
            failed.push(*name);
        }
    }
    println!("\ntest result: {}. {} failed: {failed:?}\n", if failed.is_empty() { "ok" } else { "FAILED" }, failed.len());
    if !failed.is_empty() {
        std::process::exit(101);
    }
}

/// A temp home for one test: a profile that runs the scripted agent, a Hub
/// saving transcripts there, and every event the UI would get.
struct Fixture {
    dir: PathBuf,
    profiles: &'static Store,
    hub: Arc<Hub>,
    events: Arc<Mutex<Vec<(String, Value)>>>,
}

impl Fixture {
    fn new(env: &[(&str, &str)]) -> Self {
        let dir = std::env::temp_dir().join(format!("yaah-e2e-{}", random_token()));
        std::fs::create_dir_all(&dir).unwrap();
        // An existing file, so nothing migrates this machine's real Claude accounts in.
        std::fs::write(dir.join("agents.json"), r#"{ "profiles": [] }"#).unwrap();
        let profiles: &'static Store = Box::leak(Box::new(Store::at(dir.join("agents.json"))));
        let events = Arc::default();
        let hub = Arc::new(Hub::open(emitter(&events), Some(dir.join("sessions")), profiles));
        let f = Self { dir, profiles, hub, events };
        assert_eq!(f.add_profile("Scripted", env), ACCOUNT);
        f
    }

    /// Another profile running the scripted agent; returns its id.
    fn add_profile(&self, label: &str, env: &[(&str, &str)]) -> String {
        self.add_profile_as(label, agents::CUSTOM, env)
    }

    /// A profile of a given preset (`claude`, say) that runs the scripted agent.
    fn add_profile_as(&self, label: &str, preset: &str, env: &[(&str, &str)]) -> String {
        let exe = std::env::current_exe().unwrap();
        let mut draft =
            Draft { label: label.into(), preset: preset.into(), command_line: agents::join_args([exe.to_string_lossy()]), ..Draft::default() };
        draft.env.insert(agent::ENV.into(), "1".into());
        draft.env.insert("YAAH_AGENT_LOG".into(), self.dir.join("agent.log").to_string_lossy().into_owned());
        for (k, v) in env {
            draft.env.insert((*k).into(), (*v).into());
        }
        self.profiles.save(&draft).unwrap().0.id
    }

    /// As in the app: a UI server for agents that reach HTTP MCP servers (nothing
    /// listens; the scripted agent never connects), and yaah's UI guide, its
    /// skills written under the test's folder.
    fn teach(&self) {
        self.hub.set_ui_port(1);
        self.hub.set_guide(Arc::new(Guide::new(self.dir.join("yaah-home"), || vec!["test-report".into(), "acme/pr-card".into()], || true)));
    }

    /// Flush, as the app does on exit, and open the store again in a new Hub (the
    /// old one, and its agent, go once it is replaced): an app restart.
    fn restart(&mut self) {
        self.hub.flush();
        self.hub = Arc::new(Hub::open(emitter(&self.events), Some(self.dir.join("sessions")), self.profiles));
    }

    fn chat(&self) -> String {
        tauri::async_runtime::block_on(self.hub.new_session(ChatTarget::Folder(self.dir.to_string_lossy().into_owned()), ACCOUNT)).unwrap().session_id
    }

    fn prompt(&self, sid: &str, text: &str) {
        tauri::async_runtime::block_on(self.hub.prompt(sid, text.into(), vec![])).unwrap();
    }

    /// Prompt and wait for the turn to end.
    fn turn(&self, sid: &str, text: &str) -> Transcript {
        self.prompt(sid, text);
        self.finished(sid)
    }

    /// The transcript once no turn is running.
    fn finished(&self, sid: &str) -> Transcript {
        self.until(sid, "the turn ends", |t| (!t.info.running).then_some(()));
        self.hub.transcript(sid).unwrap()
    }

    /// Poll the transcript until `f` finds something.
    fn until<T>(&self, sid: &str, what: &str, f: impl Fn(&Transcript) -> Option<T>) -> T {
        let started = Instant::now();
        loop {
            if let Some(v) = f(&self.hub.transcript(sid).unwrap()) {
                return v;
            }
            assert!(started.elapsed() < PATIENCE, "timed out waiting until {what}: {:#?}", self.hub.transcript(sid).unwrap().entries);
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn event(&self, what: &str, f: impl Fn(&str, &Value) -> bool) -> Value {
        let started = Instant::now();
        loop {
            if let Some((_, v)) = self.events.lock().unwrap().iter().find(|(n, v)| f(n, v)) {
                return v.clone();
            }
            assert!(started.elapsed() < PATIENCE, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// Every message the agent processes received, as (pid, message).
    fn received(&self) -> Vec<(u64, Value)> {
        std::fs::read_to_string(self.dir.join("agent.log"))
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .map(|v| (v["pid"].as_u64().unwrap_or(0), serde_json::from_str(v["line"].as_str().unwrap_or("null")).unwrap_or_default()))
            .collect()
    }

    fn requests(&self, method: &str) -> Vec<Value> {
        self.received().into_iter().filter(|(_, m)| m["method"] == method).map(|(_, m)| m["params"].clone()).collect()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn emitter(events: &Arc<Mutex<Vec<(String, Value)>>>) -> Emit {
    let events = events.clone();
    Arc::new(move |name: &str, payload: Value| events.lock().unwrap().push((name.to_owned(), payload)))
}

fn as_values(t: &Transcript) -> Vec<Value> {
    t.entries.iter().map(|e| serde_json::to_value(e).unwrap()).collect()
}

fn utf16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// What the UI builds from one chat's events, by the streaming contract: an
/// append applies only when the shown text plus it is `len` UTF-16 units long.
fn replay(events: &[(String, Value)], sid: &str) -> Vec<Value> {
    let mut entries: Vec<Value> = vec![];
    for (name, v) in events.iter().filter(|(_, v)| v["sessionId"] == sid) {
        let Some(i) = v["index"].as_u64().and_then(|i| usize::try_from(i).ok()) else { continue };
        match name.as_str() {
            "session-entry" => {
                if entries.len() <= i {
                    entries.resize(i + 1, Value::Null);
                }
                entries[i] = v["entry"].clone();
            }
            "session-append" => {
                let field = v["field"].as_str().unwrap();
                let shown = entries[i][field].as_str().expect("an append to text the UI has").to_owned();
                let text = v["text"].as_str().unwrap();
                assert_eq!(utf16(&shown) + utf16(text), usize::try_from(v["len"].as_u64().unwrap()).unwrap(), "out of sync at {v}");
                entries[i][field] = json!(shown + text);
            }
            "session-draft" => {
                entries[i]["draft"] = v["draft"].clone();
                entries[i]["draftBy"] = v["draftBy"].clone();
            }
            _ => {}
        }
    }
    entries
}

fn last_agent_text(t: &Transcript) -> String {
    t.entries.iter().rev().find_map(|e| if let Entry::Agent { text, .. } = e { Some(text.clone()) } else { None }).unwrap_or_default()
}

fn waiting_permissions(t: &Transcript) -> Vec<usize> {
    t.entries.iter().enumerate().filter(|(_, e)| matches!(e, Entry::Permission { chosen: None, .. })).map(|(i, _)| i).collect()
}

fn chosen(t: &Transcript) -> Vec<Option<String>> {
    t.entries.iter().filter_map(|e| if let Entry::Permission { chosen, .. } = e { Some(chosen.clone()) } else { None }).collect()
}

// ── Tests ───────────────────────────────────────────────────────────────────

fn initialize_advertises_notices_and_a_turn_streams() {
    let f = Fixture::new(&[]);
    let sid = f.chat();
    let init = f.requests("initialize").pop().expect("initialize was sent");
    assert_eq!(init["protocolVersion"], 1);
    assert_eq!(init["clientCapabilities"]["session"]["notices"], json!({}), "yaah advertises notices");
    assert_eq!(init["clientCapabilities"]["auth"]["terminal"], true);
    assert_eq!(init["clientCapabilities"]["terminal"], false);
    let report = f.profiles.find(ACCOUNT).unwrap().report.expect("initialize is recorded on the profile");
    assert!(report.compatible && report.load_session && report.embedded_context && report.additional_dirs && !report.mcp_http);

    let t = f.turn(&sid, "stream please");
    assert_eq!(t.info.title, "stream please", "the first prompt names the chat");
    assert_eq!(t.info.stop_reason.as_deref(), Some("end_turn"));
    assert_eq!(t.info.commands, [json!({ "name": "review", "description": "Review" })]);
    let kinds: Vec<&str> = t
        .entries
        .iter()
        .map(|e| match e {
            Entry::User { .. } => "user",
            Entry::Thought { .. } => "thought",
            Entry::Agent { .. } => "agent",
            Entry::Tool { .. } => "tool",
            Entry::Plan { .. } => "plan",
            _ => "other",
        })
        .collect();
    assert_eq!(kinds, ["user", "thought", "agent", "tool", "plan", "agent"], "chunks merge, updates update in place");
    assert!(matches!(&t.entries[1], Entry::Thought { text, .. } if text == "Thinking hard"));
    assert!(matches!(&t.entries[2], Entry::Agent { text, message_id: Some(m) } if text == "Hello world" && m == "m1"));
    let Entry::Tool { title, status, content, locations, .. } = &t.entries[3] else { panic!() };
    assert_eq!((title.as_str(), status.as_deref()), ("Read notes.md", Some("completed")), "a null title keeps the one there");
    assert_eq!(content[0]["content"]["text"], "notes");
    assert_eq!(locations[0]["path"], "/tmp/notes.md");
    assert!(matches!(&t.entries[4], Entry::Plan { entries } if entries[0]["status"] == "completed"), "a new plan replaces the last");
    assert!(matches!(&t.entries[5], Entry::Agent { text, .. } if text == "[notes](file:///tmp/notes.md)"));

    // The UI heard about every change, by index: a message starts as an entry and grows by appends.
    let events = f.events.lock().unwrap().clone();
    assert!(events.iter().any(|(n, v)| n == "session-entry" && v["index"] == 2 && v["entry"]["text"] == "Hello "));
    assert!(events.iter().any(|(n, v)| n == "session-append" && v["index"] == 2 && v["field"] == "text" && v["len"] == 11));
    assert!(!events.iter().any(|(n, v)| n == "session-entry" && v["entry"]["text"] == "Hello world"), "the whole message isn't sent again");
    assert!(events.iter().any(|(n, v)| n == "session-info" && v["running"] == true));
    assert_eq!(replay(&events, &sid), as_values(&t), "the UI's copy, built from the events, is the transcript");

    // Mentions go as links; only absolute paths count.
    tauri::async_runtime::block_on(f.hub.prompt(&sid, "echo hi".into(), vec!["/tmp/a b.txt".into(), "relative.txt".into()])).unwrap();
    f.until(&sid, "the echo", |t| (!t.info.running && last_agent_text(t) == "echo: echo hi").then_some(()));
    let prompt = f.requests("session/prompt").pop().unwrap();
    assert_eq!(prompt["prompt"][0], json!({ "type": "resource_link", "uri": "file:///tmp/a b.txt", "name": "a b.txt" }));
    assert_eq!(prompt["prompt"].as_array().unwrap().len(), 2);
    assert!(matches!(&f.hub.transcript(&sid).unwrap().entries[6], Entry::User { attachments, .. } if attachments == &["a b.txt"]));
}

/// A long reply from a real agent process: the chunks arrive back to back and
/// reach the UI as a few appends, joined, in order, the rest sent before the
/// turn ends; the transcript is written when the turn ends.
fn long_replies_stream_as_coalesced_appends() {
    let f = Fixture::new(&[]);
    f.hub.set_timings(yaah_lib::session::COALESCE, Duration::from_secs(3600));
    let sid = f.chat();
    let t = f.turn(&sid, "long 2000");
    let expected = (0..2000).fold(String::new(), |mut s, i| {
        use std::fmt::Write;
        let _ = write!(s, "{i}: héllo 👋 𝄞 ");
        s
    });
    assert_eq!(last_agent_text(&t), expected);
    let events = f.events.lock().unwrap().clone();
    let appends: Vec<&Value> = events.iter().filter(|(n, v)| n == "session-append" && v["sessionId"] == sid.as_str()).map(|(_, v)| v).collect();
    assert!(!appends.is_empty() && appends.len() < 2000, "{} appends for 2000 chunks", appends.len());
    assert_eq!(appends.last().unwrap()["len"], utf16(&expected));
    assert_eq!(replay(&events, &sid), as_values(&t), "the UI's copy, built from the events, is the transcript");
    let last_append = events.iter().rposition(|(n, _)| n == "session-append").unwrap();
    let stopped = events.iter().rposition(|(n, v)| n == "session-info" && v["running"] == false).unwrap();
    assert!(last_append < stopped, "the turn's text is all sent before it ends");

    // The turn's end wrote the transcript, though saves otherwise wait an hour here.
    let saved = || {
        let files = std::fs::read_dir(f.dir.join("sessions")).ok()?;
        let file = files.filter_map(Result::ok).map(|e| e.path()).find(|p| p.extension().is_some_and(|e| e == "json"))?;
        std::fs::read_to_string(file).ok()
    };
    let started = Instant::now();
    while !saved().is_some_and(|s| s.contains("1999: héllo")) {
        assert!(started.elapsed() < PATIENCE, "the turn's end didn't write the transcript");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn project_chats_send_the_brief_and_folders_once() {
    let f = Fixture::new(&[]);
    let (repo, other, ctx) = (f.dir.join("repo"), f.dir.join("other"), f.dir.join("ctx"));
    for d in [&repo, &other, &ctx] {
        std::fs::create_dir_all(d).unwrap();
    }
    std::fs::write(ctx.join("project.md"), "# Shop\n\nRefunds must be exact.\n").unwrap();
    let project = Project {
        id: "p1".into(),
        name: "Shop".into(),
        dirs: vec![repo.to_string_lossy().into(), other.to_string_lossy().into()],
        status: Status::Ongoing,
        created_at: 0,
        context_dir: ctx.to_string_lossy().into(),
        link: None,
        agent_id: None,
    };
    let info = tauri::async_runtime::block_on(f.hub.new_session(ChatTarget::Project(&project), ACCOUNT)).unwrap();
    assert_eq!((info.project_id.as_deref(), info.cwd.as_str()), (Some("p1"), repo.to_str().unwrap()));
    let new = f.requests("session/new").pop().unwrap();
    assert_eq!(new["additionalDirectories"], json!([other, ctx]));
    assert_eq!(new["cwd"], json!(repo));

    f.turn(&info.session_id, "first");
    f.turn(&info.session_id, "second");
    let prompts = f.requests("session/prompt");
    assert_eq!(prompts[0]["prompt"][0]["resource"]["text"], "# Shop\n\nRefunds must be exact.\n", "embedded, since the agent takes it");
    assert_eq!(prompts[1]["prompt"].as_array().unwrap().len(), 1, "the brief goes once");
    assert!(matches!(&f.hub.transcript(&info.session_id).unwrap().entries[0], Entry::User { attachments, .. } if attachments == &["project.md"]));

    assert_eq!(f.hub.list_sessions().len(), 1);
    assert_eq!(f.hub.session_roots(&info.session_id), [repo, other, ctx]);
    assert_eq!(f.hub.set_session_project(&info.session_id, None).unwrap().project_id, None);
}

fn dont_ask_again_answers_waiting_and_later_requests_in_that_chat_only() {
    let f = Fixture::new(&[]);
    let sid = f.chat();
    f.prompt(&sid, "permissions");
    let waiting = f.until(&sid, "four requests wait", |t| Some(waiting_permissions(t)).filter(|w| w.len() == 4));
    let t = f.hub.transcript(&sid).unwrap();
    assert!(matches!(&t.entries[waiting[0]], Entry::Permission { title, tool_call_id: Some(id), .. } if title == "Run ls" && id == "ls"));

    // "Always" on the first ls: the two other ls requests already waiting are answered too, rm is not.
    f.hub.respond_permission(&sid, waiting[0], Some("always")).unwrap();
    assert_eq!(waiting_permissions(&f.hub.transcript(&sid).unwrap()), [waiting[3]], "only the different request still waits");
    assert!(f.hub.respond_permission(&sid, waiting[1], Some("no")).unwrap_err().contains("already answered"));
    f.hub.respond_permission(&sid, waiting[3], Some("no")).unwrap();

    // The agent asks about ls again later (by tool call id only): answered without asking.
    let t = f.finished(&sid);
    assert_eq!(last_agent_text(&t), "outcomes: always,always,always,no,always", "what the agent got, in order");
    let marks = chosen(&t);
    assert_eq!(marks.len(), 5);
    assert_eq!(marks[0].as_deref(), Some("Always allow"));
    assert!(marks[1].as_deref().unwrap().ends_with("(you said don't ask again)"));
    assert_eq!(marks[3].as_deref(), Some("Reject"));
    assert!(marks[4].as_deref().unwrap().ends_with("(you said don't ask again)"), "later requests show, marked");

    // Another chat with the same agent still asks.
    let other = f.chat();
    f.prompt(&other, "ask-again");
    let w = f.until(&other, "the other chat asks", |t| waiting_permissions(t).first().copied());
    f.hub.respond_permission(&other, w, Some("once")).unwrap();
    let t = f.turn(&sid, "ask-again");
    assert_eq!(last_agent_text(&t), "outcomes: always", "…while the first chat still remembers");
    assert_eq!(last_agent_text(&f.hub.transcript(&other).unwrap()), "outcomes: once");
}

fn unnamed_requests_are_never_remembered() {
    let f = Fixture::new(&[]);
    let sid = f.chat();
    f.prompt(&sid, "unnamed");
    let w = f.until(&sid, "a request", |t| waiting_permissions(t).first().copied());
    f.hub.respond_permission(&sid, w, Some("always")).unwrap();
    let w2 = f.until(&sid, "a second request", |t| waiting_permissions(t).first().copied());
    let t = f.hub.transcript(&sid).unwrap();
    assert!(matches!(&t.entries[w2], Entry::Permission { title, .. } if title == "The agent wants to run a tool"));
    f.hub.respond_permission(&sid, w2, None).unwrap();
    let t = f.finished(&sid);
    assert_eq!(last_agent_text(&t), "outcomes: always,cancelled", "the second was asked, not auto-answered");
}

fn notices_and_the_mcp_status_fallback_make_one_card() {
    let f = Fixture::new(&[]);
    let sid = f.chat();
    let t = f.turn(&sid, "notices");
    let cards: Vec<_> = t.entries.iter().filter_map(|e| if let Entry::Notices { items } = e { Some(items) } else { None }).collect();
    assert_eq!(cards.len(), 1, "notices in a row join one card");
    let items = cards[0];
    assert_eq!(items.len(), 3, "the repeated notice is shown once: {items:?}");
    assert_eq!(
        (items[0].severity.as_str(), items[0].mcp_server.as_deref(), items[0].description.as_deref()),
        ("warning", Some("github"), Some("exit 1"))
    );
    assert_eq!((items[1].title.as_str(), items[1].description.as_deref()), ("Linear needs sign-in", Some("open settings")));
    assert_eq!((items[1].severity.as_str(), items[1].mcp_server.as_deref()), ("warning", Some("linear")));
    assert_eq!((items[2].title.as_str(), items[2].severity.as_str(), items[2].mcp_server.as_deref()), ("Indexing done", "info", None));
    assert_eq!(last_agent_text(&t), "ready");
}

fn cancel_answers_waiting_permissions_and_tells_the_agent() {
    let f = Fixture::new(&[]);
    let sid = f.chat();
    f.prompt(&sid, "wait");
    let w = f.until(&sid, "the deploy request", |t| waiting_permissions(t).first().copied());
    assert!(tauri::async_runtime::block_on(f.hub.prompt(&sid, "again".into(), vec![])).unwrap_err().contains("already running"));
    f.hub.cancel(&sid).unwrap();
    let t = f.finished(&sid);
    assert_eq!(t.info.stop_reason.as_deref(), Some("cancelled"));
    assert_eq!(chosen(&t)[0].as_deref(), Some("cancelled"));
    assert!(matches!(&t.entries[w], Entry::Permission { chosen: Some(c), .. } if c == "cancelled"));
    assert_eq!(last_agent_text(&t), "outcomes: cancelled", "the agent got `cancelled` for the request");
    assert_eq!(f.requests("session/cancel"), [json!({ "sessionId": sid })]);
    assert!(f.hub.respond_permission(&sid, w, Some("once")).is_err());
}

fn a_crashed_agent_is_restarted_and_the_chat_reattached() {
    let f = Fixture::new(&[]);
    let sid = f.chat();
    let t = f.turn(&sid, "crash now");
    let Some(Entry::Error { message, .. }) = t.entries.last() else { panic!("{:?}", t.entries) };
    assert!(message.contains("agent process exited") && message.contains("crashing on purpose"), "with its stderr: {message}");
    assert_eq!(t.entries.iter().filter(|e| matches!(e, Entry::Error { .. })).count(), 1, "one error, not one per listener");

    let t = f.turn(&sid, "echo back");
    assert_eq!(last_agent_text(&t), "echo: echo back");
    let pids: std::collections::BTreeSet<u64> = f.received().iter().map(|(p, _)| *p).collect();
    assert_eq!(pids.len(), 2, "a second agent process");
    assert_eq!(f.requests("session/load").last().unwrap()["sessionId"], json!(sid));
    assert!(!t.entries.iter().any(|e| matches!(e, Entry::Agent { text, .. } if text.contains("replayed"))), "the replay is ignored");
}

fn chats_survive_a_restart_and_reattach_with_session_load() {
    let mut f = Fixture::new(&[]);
    let sid = f.chat();
    f.turn(&sid, "stream");
    f.hub.rename_session(&sid, "Kept").unwrap();
    let before = f.hub.transcript(&sid).unwrap().entries.len();
    f.restart();

    let t = f.hub.transcript(&sid).expect("restored from disk");
    assert_eq!((t.info.title.as_str(), t.entries.len(), t.info.running), ("Kept", before, false));
    let t = f.turn(&sid, "echo after restart");
    assert_eq!(t.entries.len(), before + 2, "the replayed history wasn't added again");
    assert_eq!(last_agent_text(&t), "echo: echo after restart");
    assert_eq!(f.requests("session/load").len(), 1);
    assert!(f.requests("session/load")[0]["cwd"].is_string());

    f.hub.delete_session(&sid).unwrap();
    f.restart();
    assert!(f.hub.transcript(&sid).is_err(), "deleted for good");

    // An agent that can't load sessions says so instead of losing the chat.
    let mut f = Fixture::new(&[("YAAH_AGENT_NO_LOAD", "1")]);
    let sid = f.chat();
    f.turn(&sid, "hi");
    f.restart();
    let err = tauri::async_runtime::block_on(f.hub.prompt(&sid, "again".into(), vec![])).unwrap_err();
    assert!(err.contains("can't reopen"), "{err}");
    assert!(!f.hub.transcript(&sid).unwrap().info.running);
}

fn malformed_output_is_skipped_and_the_chat_carries_on() {
    let f = Fixture::new(&[]);
    let sid = f.chat();
    let t = f.turn(&sid, "garbage");
    assert_eq!(last_agent_text(&t), "fs: -32601; lost: cancelled", "unsupported requests are refused, unknown chats cancelled");
    assert!(!t.entries.iter().any(|e| matches!(e, Entry::Agent { text, .. } if text == "lost")));
    assert!(!t.entries.iter().any(|e| matches!(e, Entry::Tool { .. })), "a tool call without an id is dropped");
    let odd = t.entries.iter().find_map(|e| if let Entry::Permission { options, .. } = e { Some(options.clone()) } else { None });
    assert_eq!(odd, Some(json!([])), "options that aren't a list become none");
    let t = f.turn(&sid, "echo still here");
    assert_eq!(last_agent_text(&t), "echo: echo still here");
}

fn agents_yaah_cant_use_are_refused() {
    let f = Fixture::new(&[("YAAH_AGENT_PROTOCOL", "2")]);
    let err = tauri::async_runtime::block_on(f.hub.new_session(ChatTarget::Folder(f.dir.to_string_lossy().into()), ACCOUNT)).unwrap_err();
    assert!(err.contains("unsupported ACP protocol"), "{err}");

    // An agent picks the session id; one that looks like a path still saves inside the sessions folder.
    let mut f = Fixture::new(&[("YAAH_AGENT_SESSION_ID", "../../escaped")]);
    let sid = f.chat();
    assert_eq!(sid, "../../escaped");
    f.restart();
    assert!(!f.dir.join("escaped.json").exists() && !f.dir.parent().unwrap().join("escaped.json").exists());
    assert_eq!(std::fs::read_dir(f.dir.join("sessions")).unwrap().count(), 1);
    assert!(f.hub.transcript(&sid).is_ok(), "and is restored by the id inside it");

    let err = tauri::async_runtime::block_on(f.hub.new_session(ChatTarget::Folder("/".into()), "nobody-has-this-id")).unwrap_err();
    assert!(err.contains("unknown agent"), "{err}");
    let mut broken = f.profiles.find(ACCOUNT).unwrap();
    broken.command = "/definitely/not/an/agent".into();
    assert!(tauri::async_runtime::block_on(agents::test(&broken)).unwrap_err().contains("failed to start"));
    let report = tauri::async_runtime::block_on(agents::test(&f.profiles.find(ACCOUNT).unwrap())).unwrap();
    assert_eq!(report.name.as_deref(), Some("scripted"));
}

fn auth_errors_ask_for_a_login() {
    let f = Fixture::new(&[]);
    let sid = f.chat();
    let t = f.turn(&sid, "auth");
    assert!(matches!(t.entries.last(), Some(Entry::Error { login_account: Some(a), message }) if a == ACCOUNT && message.contains("not logged in")));
    assert!(f.hub.needs_login(ACCOUNT));
    f.event("accounts-changed", |n, _| n == "accounts-changed");
    f.hub.logged_in(ACCOUNT);
    assert!(!f.hub.needs_login(ACCOUNT));
}

fn logins_run_the_agents_methods() {
    let f = Fixture::new(&[]);
    let logins = Logins::default();
    let emit = emitter(&f.events);
    let start = |method: &str| tauri::async_runtime::block_on(logins.start(f.hub.clone(), emit.clone(), ACCOUNT, method));
    let kinds: Vec<String> = tauri::async_runtime::block_on(yaah_lib::login::methods(&f.hub, ACCOUNT)).unwrap().into_iter().map(|m| m.kind).collect();
    assert_eq!(kinds, ["agent", "terminal", "env_var"]);

    // Terminal: the agent command again with the method's args and env; a link shows, a pasted code finishes it.
    start("terminal-login").unwrap();
    assert!(start("terminal-login").unwrap_err().contains("already running"), "one login at a time");
    // Both streams are read: the OSC 8 link on stdout, a plain URL on stderr.
    f.event("the OSC 8 link", |n, v| n == "login-url" && v["url"] == "https://example.com/login?c=1");
    f.event("the plain link", |n, v| n == "login-url" && v["url"] == "https://example.com/fallback");
    f.event("plain output", |n, v| n == "login-output" && v["line"] == "Open this link to sign in");
    tauri::async_runtime::block_on(logins.submit_code(ACCOUNT, "  let-me-in \n")).unwrap();
    let done = f.event("the end", |n, _| n == "login-done");
    assert_eq!(done["ok"], true, "{done}");

    // Cancelled while waiting for the code.
    f.events.lock().unwrap().clear();
    start("terminal-login").unwrap();
    f.event("the login link", |n, _| n == "login-url");
    logins.cancel(ACCOUNT);
    let done = f.event("the end", |n, _| n == "login-done");
    assert_eq!((done["ok"].clone(), done["message"].clone()), (json!(false), json!("login cancelled")));
    assert!(tauri::async_runtime::block_on(logins.submit_code(ACCOUNT, "x")).is_err(), "nothing is running");

    // Agent-handled: ACP `authenticate`.
    f.events.lock().unwrap().clear();
    start("agent-login").unwrap();
    assert_eq!(f.event("the end", |n, _| n == "login-done")["ok"], true);
    assert!(f.requests("authenticate").contains(&json!({ "methodId": "agent-login" })));

    // Variables: nothing to run, just what to set.
    assert!(start("key").unwrap_err().contains("SCRIPTED_KEY"));
    assert!(start("nope").unwrap_err().contains("does not offer"));
}

fn an_agent_cant_write_into_or_take_over_another_agents_chat() {
    let mut f = Fixture::new(&[]);
    let mine = f.chat();
    f.turn(&mine, "echo mine");
    let before = f.hub.transcript(&mine).unwrap().entries.len();

    // Another profile's agent process writes into, and asks permission in, a chat it didn't start.
    let other = f.add_profile("Other", &[]);
    let dir = f.dir.to_string_lossy().into_owned();
    let theirs = tauri::async_runtime::block_on(f.hub.new_session(ChatTarget::Folder(dir.clone()), &other)).unwrap().session_id;
    let t = f.turn(&theirs, &format!("spoof {mine}"));
    assert_eq!(last_agent_text(&t), "spoof: cancelled", "its permission request is answered cancelled, unseen");
    let t = f.hub.transcript(&mine).unwrap();
    assert_eq!(t.entries.len(), before, "nothing reached the other chat: {:#?}", t.entries);
    assert!(!t.entries.iter().any(|e| matches!(e, Entry::Permission { .. } | Entry::Tool { .. })));

    // …nor take it over by answering `session/new` with its id.
    let thief = f.add_profile("Thief", &[("YAAH_AGENT_SESSION_ID", &mine)]);
    let err = tauri::async_runtime::block_on(f.hub.new_session(ChatTarget::Folder(dir), &thief)).unwrap_err();
    assert!(err.contains("already has"), "{err}");
    let t = f.hub.transcript(&mine).unwrap();
    assert_eq!((t.info.account_id.as_str(), t.entries.len()), (ACCOUNT, before), "the chat is still the first agent's");
    assert_eq!(last_agent_text(&f.turn(&mine, "echo still mine")), "echo: echo still mine");
    f.restart();
    assert_eq!(f.hub.transcript(&mine).unwrap().entries.len(), before + 2, "its saved transcript wasn't overwritten");
}

// ── What agents are told about yaah's UI (agent_guide.rs) ──────────────────

const GUIDE_START: &str = "# You are running inside yaah";

/// The generic route for an agent that advertises it: the ACP `systemPrompt`,
/// on `session/new` and again on `session/load`; nothing in the prompts.
fn the_ui_guide_goes_in_the_acp_system_prompt_when_advertised() {
    let mut f = Fixture::new(&[("YAAH_AGENT_MCP_HTTP", "1"), ("YAAH_AGENT_SYSTEM_PROMPT", "1")]);
    f.teach();
    let sid = f.chat();
    let new = f.requests("session/new").pop().unwrap();
    assert_eq!(new["mcpServers"][0]["name"], "yaah-ui");
    assert_eq!(new["systemPrompt"]["mode"], "append");
    let guide = new["systemPrompt"]["content"][0]["text"].as_str().unwrap();
    assert!(guide.starts_with(GUIDE_START) && guide.contains("test-report, acme/pr-card."), "{guide}");
    assert!(new.get("_meta").is_none(), "no Claude extras for another agent");

    let t = f.turn(&sid, "echo hi");
    assert_eq!(last_agent_text(&t), "echo: echo hi");
    assert_eq!(f.requests("session/prompt")[0]["prompt"].as_array().unwrap().len(), 1, "nothing added to the prompt");
    assert!(matches!(&t.entries[0], Entry::User { attachments, .. } if attachments.is_empty()));

    f.restart();
    f.teach();
    f.turn(&sid, "echo again");
    let load = f.requests("session/load").pop().unwrap();
    assert_eq!(load["systemPrompt"]["content"][0]["text"], json!(guide), "the same guide on session/load");
}

/// The fallback: an agent with no `systemPrompt` gets the guide once, at the top of the first prompt.
fn the_ui_guide_goes_with_the_first_prompt_otherwise() {
    let f = Fixture::new(&[("YAAH_AGENT_MCP_HTTP", "1")]);
    f.teach();
    let sid = f.chat();
    let new = f.requests("session/new").pop().unwrap();
    assert!(new.get("systemPrompt").is_none() && new.get("_meta").is_none());

    let t = f.turn(&sid, "echo first");
    assert_eq!(last_agent_text(&t), "echo: echo first", "the user's text is still what the agent answers");
    f.turn(&sid, "echo second");
    let prompts = f.requests("session/prompt");
    let first = prompts[0]["prompt"].as_array().unwrap();
    assert_eq!(first.len(), 2);
    assert!(first[0]["text"].as_str().unwrap().starts_with(GUIDE_START), "the guide comes first: {first:?}");
    assert_eq!(first[1]["text"], "echo first");
    assert_eq!(prompts[1]["prompt"].as_array().unwrap().len(), 1, "the guide goes once");
    let t = f.hub.transcript(&sid).unwrap();
    assert!(
        matches!(&t.entries[0], Entry::User { text, attachments } if text == "echo first" && attachments == &[agent_guide::ATTACHMENT]),
        "the chat shows it was attached, not its text: {:?}",
        t.entries[0]
    );

    // An agent without yaah's UI server isn't told about it.
    let f = Fixture::new(&[]);
    f.teach();
    let sid = f.chat();
    f.turn(&sid, "echo plain");
    assert_eq!(f.requests("session/prompt")[0]["prompt"].as_array().unwrap().len(), 1);
    assert!(f.requests("session/new")[0].get("systemPrompt").is_none());
}

/// The Claude adapter on top of the generic routes: the plugin wrapping the
/// skills, and `_meta.systemPrompt` only when the ACP `systemPrompt` isn't there,
/// all merged with the `allowedTools` yaah already sends.
fn claude_gets_the_ui_guide_and_plugin_beside_allowed_tools() {
    let f = Fixture::new(&[]);
    f.teach();
    let older = f.add_profile_as("Claude (older adapter)", agents::CLAUDE, &[("YAAH_AGENT_MCP_HTTP", "1")]);
    let newer = f.add_profile_as("Claude", agents::CLAUDE, &[("YAAH_AGENT_MCP_HTTP", "1"), ("YAAH_AGENT_SYSTEM_PROMPT", "1")]);
    let plugin = f.dir.join("yaah-home/agent-plugin");
    let chat =
        |account: &str| tauri::async_runtime::block_on(f.hub.new_session(ChatTarget::Folder(f.dir.to_string_lossy().into_owned()), account)).unwrap();

    chat(&older);
    let new = f.requests("session/new").pop().unwrap();
    let options = &new["_meta"]["claudeCode"]["options"];
    assert!(options["allowedTools"].as_array().unwrap().iter().any(|t| t == "mcp__yaah-ui__ui_render"), "allowedTools still there");
    assert_eq!(options["plugins"], json!([{ "type": "local", "path": plugin }]));
    assert!(new["_meta"]["systemPrompt"]["append"].as_str().unwrap().starts_with(GUIDE_START));
    assert!(new.get("systemPrompt").is_none());
    assert!(
        plugin.join(".claude-plugin/plugin.json").is_file() && plugin.join("skills/yaah-ui/SKILL.md").is_file(),
        "written before it's handed over"
    );
    assert!(f.dir.join("yaah-home/agent-skills/yaah-components/SKILL.md").is_file(), "the canonical skills too");

    let sid = chat(&newer).session_id;
    let new = f.requests("session/new").pop().unwrap();
    assert!(new["systemPrompt"]["content"][0]["text"].as_str().unwrap().starts_with(GUIDE_START), "the spec param when advertised");
    assert!(new["_meta"].get("systemPrompt").is_none(), "and no _meta copy");
    assert_eq!(new["_meta"]["claudeCode"]["options"]["plugins"][0]["type"], "local");
    assert!(new["_meta"]["claudeCode"]["options"]["allowedTools"].is_array());
    f.turn(&sid, "echo hi");
    assert_eq!(f.requests("session/prompt").pop().unwrap()["prompt"].as_array().unwrap().len(), 1, "no first-prompt copy");
}

// ── Switching agents ────────────────────────────────────────────────────────

/// The pid of the process that answered a method, in the order sent.
fn pids(f: &Fixture, method: &str) -> Vec<u64> {
    f.received().into_iter().filter(|(_, m)| m["method"] == method).map(|(pid, _)| pid).collect()
}

/// The `session/prompt` requests, with the pid of the process that got each.
fn prompts(f: &Fixture) -> Vec<(u64, Value)> {
    f.received().into_iter().filter(|(_, m)| m["method"] == "session/prompt").map(|(pid, m)| (pid, m["params"].clone())).collect()
}

fn switching_agents_hands_the_chat_to_a_fresh_session() {
    let f = Fixture::new(&[]);
    let second = f.add_profile("Second", &[("YAAH_AGENT_NAME", "second")]);
    let sid = f.chat();
    f.turn(&sid, "hello there");
    let first_pid = pids(&f, "session/new")[0];

    let info = f.hub.switch_agent(&sid, &second).unwrap();
    assert_eq!((info.account_id.as_str(), info.handoff_from.as_deref(), info.session_id.as_str()), (second.as_str(), Some("Scripted"), sid.as_str()));
    let shown = f.event("the switch entry", |n, v| n == "session-entry" && v["sessionId"] == sid.as_str() && v["entry"]["type"] == "switch");
    assert_eq!(shown["entry"], json!({ "type": "switch", "accountId": second, "label": "Second", "from": "Scripted" }));
    f.event("the new agent in the info", |n, v| n == "session-info" && v["sessionId"] == sid.as_str() && v["accountId"] == second.as_str());

    // The next prompt starts a session on the second agent's process, in the same folder, and hands off.
    let t = f.turn(&sid, "what next");
    assert_eq!(last_agent_text(&t), "second echo: what next", "the reply lands in the same chat");
    let news = f.requests("session/new");
    let new_pids = pids(&f, "session/new");
    assert_eq!(news.len(), 2);
    assert_ne!(new_pids[1], first_pid, "a process of its own");
    assert_eq!(news[1]["cwd"], news[0]["cwd"]);
    let agent_session = t.info.agent_session_id.clone().expect("the new agent's session id is recorded");
    assert_ne!(agent_session, sid);
    assert!(t.info.handoff_from.is_none(), "handed off once");
    let (pid, prompt) = prompts(&f).pop().unwrap();
    assert_eq!((pid, prompt["sessionId"].as_str()), (new_pids[1], Some(agent_session.as_str())));
    let blocks = prompt["prompt"].as_array().unwrap();
    let handoff = blocks[0]["text"].as_str().unwrap();
    assert!(handoff.starts_with("You're taking over this chat from Scripted. The conversation so far:"), "{handoff}");
    for said in ["User: hello there", "Agent: echo: hello there", "[switched to Second]"] {
        assert!(handoff.contains(said), "{said} in {handoff}");
    }
    assert_eq!(blocks.last().unwrap()["text"], "what next", "the user's own text comes last");
    let user = t.entries.iter().rev().find_map(|e| if let Entry::User { attachments, .. } = e { Some(attachments.clone()) } else { None });
    assert_eq!(user, Some(vec!["hand-off from Scripted".to_owned()]));

    // Later prompts go to the same session, without a hand-off; the first agent hears nothing more.
    let t = f.turn(&sid, "and then");
    assert_eq!(last_agent_text(&t), "second echo: and then");
    let (pid, prompt) = prompts(&f).pop().unwrap();
    assert_eq!((pid, prompt["sessionId"].as_str()), (new_pids[1], Some(agent_session.as_str())));
    assert_eq!(prompt["prompt"], json!([{ "type": "text", "text": "and then" }]));
    assert_eq!(prompts(&f).iter().filter(|(p, _)| *p == first_pid).count(), 1);

    // Cancel reaches the new agent's session too.
    f.hub.cancel(&sid).unwrap();
    let started = Instant::now();
    let cancel = loop {
        if let Some(c) = f.requests("session/cancel").pop() {
            break c;
        }
        assert!(started.elapsed() < PATIENCE, "session/cancel never arrived");
        std::thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(cancel["sessionId"], agent_session.as_str());

    // Switching back hands off again, to a fresh session on the first agent.
    f.hub.switch_agent(&sid, ACCOUNT).unwrap();
    let t = f.turn(&sid, "back again");
    assert_eq!(last_agent_text(&t), "echo: back again");
    let (_, prompt) = prompts(&f).pop().unwrap();
    let handoff = prompt["prompt"][0]["text"].as_str().unwrap();
    assert!(handoff.starts_with("You're taking over this chat from Second.") && handoff.contains("Agent: second echo: and then"), "{handoff}");
    assert_eq!(f.requests("session/new").len(), 3, "never reloads the first agent's old session");
    assert_eq!(f.requests("session/load"), Vec::<Value>::new(), "never reloads");
}

fn a_switched_chat_reloads_on_its_new_agent_after_a_restart() {
    let mut f = Fixture::new(&[]);
    let second = f.add_profile("Second", &[("YAAH_AGENT_NAME", "second")]);
    let sid = f.chat();
    f.turn(&sid, "hello");
    f.hub.switch_agent(&sid, &second).unwrap();
    let t = f.turn(&sid, "over to you");
    let agent_session = t.info.agent_session_id.clone().unwrap();
    let before = t.entries.len();
    f.restart();

    let info = f.hub.session_info(&sid).expect("the chat keeps its own id");
    assert_eq!((info.account_id.as_str(), info.agent_session_id.as_deref()), (second.as_str(), Some(agent_session.as_str())));
    let t = f.turn(&sid, "still there?");
    assert_eq!(last_agent_text(&t), "second echo: still there?", "the second agent answers, into this chat");
    assert_eq!(t.entries.len(), before + 2, "the replayed history wasn't added again");
    let loads = f.requests("session/load");
    assert_eq!(loads.len(), 1);
    assert_eq!(loads[0]["sessionId"], agent_session.as_str(), "reopened by the id its agent knows");
    let (_, prompt) = prompts(&f).pop().unwrap();
    assert_eq!(prompt["sessionId"], agent_session.as_str());
    assert_eq!(prompt["prompt"].as_array().unwrap().len(), 1, "no second hand-off");
}

fn switching_agents_is_refused_mid_turn() {
    let f = Fixture::new(&[]);
    let second = f.add_profile("Second", &[]);
    let sid = f.chat();
    f.prompt(&sid, "wait");
    f.until(&sid, "the permission request", |t| waiting_permissions(t).first().copied());
    let err = f.hub.switch_agent(&sid, &second).unwrap_err();
    assert!(err.contains("Wait for the turn"), "{err}");
    assert_eq!(f.hub.session_info(&sid).unwrap().account_id, ACCOUNT, "nothing changed");
    f.hub.cancel(&sid).unwrap();
    let t = f.finished(&sid);
    assert!(!t.entries.iter().any(|e| matches!(e, Entry::Switch { .. })));
    f.hub.switch_agent(&sid, &second).expect("once the turn is over");
}

// ── Adding repos to a chat as it goes (docs/research/chat-repos-contract.md) ──

/// `names` made as folders in the fixture's dir; their paths.
fn repos(f: &Fixture, names: &[&str]) -> Vec<String> {
    names
        .iter()
        .map(|n| {
            let d = f.dir.join(n);
            std::fs::create_dir_all(&d).unwrap();
            d.to_string_lossy().into_owned()
        })
        .collect()
}

/// A quick chat has no project to add to.
fn no_project(_: &str, _: &[String]) -> Result<Option<Project>, String> {
    panic!("a quick chat's repos are its own")
}

/// The methods the agent received, in order, leaving out the ones every turn has.
fn methods(f: &Fixture) -> Vec<String> {
    f.received().into_iter().filter_map(|(_, m)| m["method"].as_str().map(str::to_owned)).filter(|m| m != "session/cancel").collect()
}

fn added_dirs(t: &Transcript) -> Vec<(Vec<String>, String)> {
    t.entries.iter().filter_map(|e| if let Entry::AddedDirs { paths, to } = e { Some((paths.clone(), to.clone())) } else { None }).collect()
}

fn added_repos_reach_the_agent_through_session_load_before_the_next_prompt() {
    let mut f = Fixture::new(&[]);
    let r = repos(&f, &["api", "web"]);
    let sid = f.chat();
    f.turn(&sid, "hello");
    let info = f.hub.add_dirs(&sid, std::slice::from_ref(&r[0]), no_project).unwrap();
    assert_eq!((info.extra_dirs.clone(), info.dirs_changed), (vec![r[0].clone()], true));
    f.event("the new folders in the info", |n, v| n == "session-info" && v["sessionId"] == sid.as_str() && v["extraDirs"] == json!([r[0]]));
    let notice = f.event("the notice", |n, v| n == "session-entry" && v["sessionId"] == sid.as_str() && v["entry"]["type"] == "addedDirs");
    assert_eq!(notice["entry"], json!({ "type": "addedDirs", "paths": [r[0]], "to": "chat" }));
    assert!(f.requests("session/load").is_empty(), "nothing goes to the agent until the next prompt");

    let t = f.turn(&sid, "now with the api");
    assert_eq!(last_agent_text(&t), "echo: now with the api", "the replay of history isn't added again");
    let loads = f.requests("session/load");
    assert_eq!(loads.len(), 1);
    assert_eq!((loads[0]["sessionId"].as_str(), &loads[0]["additionalDirectories"]), (Some(sid.as_str()), &json!([r[0]])));
    assert_eq!(loads[0]["cwd"], json!(f.dir));
    let order = methods(&f);
    let n = order.len();
    assert_eq!(&order[n - 2..], ["session/load", "session/prompt"], "reopened right before the prompt: {order:?}");
    assert!(!t.info.dirs_changed);
    assert_eq!(added_dirs(&t), [(vec![r[0].clone()], "chat".to_owned())]);

    f.turn(&sid, "and again");
    assert_eq!(f.requests("session/load").len(), 1, "once");

    // Added mid-turn: accepted, the notice after the reply, the folder from the next prompt.
    f.prompt(&sid, "wait");
    f.until(&sid, "the permission request", |t| waiting_permissions(t).first().copied());
    let info = f.hub.add_dirs(&sid, std::slice::from_ref(&r[1]), no_project).unwrap();
    assert!(info.running && info.dirs_changed);
    f.hub.cancel(&sid).unwrap();
    let t = f.finished(&sid);
    assert!(matches!(t.entries.last(), Some(Entry::AddedDirs { paths, .. }) if *paths == [r[1].clone()]), "after the turn's reply");
    assert_eq!(f.requests("session/load").len(), 1, "never mid-turn");

    // It holds across a restart: the restored chat reattaches with both.
    f.restart();
    let info = f.hub.session_info(&sid).unwrap();
    assert_eq!(info.additional_dirs, r);
    f.turn(&sid, "after the restart");
    let loads = f.requests("session/load");
    assert_eq!(loads.len(), 2);
    assert_eq!(loads[1]["additionalDirectories"], json!(r));
}

fn an_agent_without_load_gets_added_repos_in_a_fresh_session_and_a_hand_off() {
    let f = Fixture::new(&[("YAAH_AGENT_NO_LOAD", "1")]);
    let r = repos(&f, &["api"]);
    let sid = f.chat();
    f.turn(&sid, "hello there");
    f.hub.add_dirs(&sid, &r, no_project).unwrap();

    let t = f.turn(&sid, "with the api");
    assert_eq!(last_agent_text(&t), "echo: with the api");
    assert_eq!(f.requests("session/load"), Vec::<Value>::new());
    let news = f.requests("session/new");
    assert_eq!(news.len(), 2, "a fresh session");
    assert_eq!(news[1]["additionalDirectories"], json!(r));
    assert_eq!(news[1]["cwd"], news[0]["cwd"]);
    let agent_session = t.info.agent_session_id.clone().expect("the fresh session's id is recorded");
    assert!(!t.info.dirs_changed && t.info.handoff_from.is_none());
    let (_, prompt) = prompts(&f).pop().unwrap();
    assert_eq!(prompt["sessionId"], agent_session.as_str());
    let handoff = prompt["prompt"][0]["text"].as_str().unwrap();
    assert!(handoff.starts_with("You're taking over this chat from Scripted."), "{handoff}");
    for said in ["User: hello there", "Agent: echo: hello there", &format!("[added {} to this chat]", r[0])] {
        assert!(handoff.contains(said), "{said} in {handoff}");
    }

    let t = f.turn(&sid, "and then");
    assert_eq!(last_agent_text(&t), "echo: and then");
    assert_eq!(f.requests("session/new").len(), 2, "handed off once");
    assert_eq!(prompts(&f).pop().unwrap().1["prompt"], json!([{ "type": "text", "text": "and then" }]));
}

fn other_chats_in_the_project_pick_up_added_repos_on_their_next_prompt() {
    let f = Fixture::new(&[]);
    let r = repos(&f, &["repo", "ctx", "new"]);
    let project = Project {
        id: "p1".into(),
        name: "Shop".into(),
        dirs: vec![r[0].clone()],
        status: Status::Ongoing,
        created_at: 0,
        context_dir: r[1].clone(),
        link: None,
        agent_id: None,
    };
    let start = |p: &Project| tauri::async_runtime::block_on(f.hub.new_session(ChatTarget::Project(p), ACCOUNT)).unwrap().session_id;
    let (one, two) = (start(&project), start(&project));
    let quick = f.chat();
    for sid in [&one, &two, &quick] {
        f.turn(sid, "hello");
    }

    let after = Project { dirs: vec![r[0].clone(), r[2].clone()], ..project.clone() };
    let info = f
        .hub
        .add_dirs(&one, std::slice::from_ref(&r[2]), |id, dirs| {
            assert_eq!((id, dirs), ("p1", std::slice::from_ref(&r[2])));
            Ok(Some(after.clone()))
        })
        .unwrap();
    assert!(info.extra_dirs.is_empty(), "a project chat's folders come from the project");
    assert_eq!(added_dirs(&f.hub.transcript(&one).unwrap()), [(vec![r[2].clone()], "project".to_owned())]);

    // The other chat, before the one it was added from.
    f.turn(&two, "do you see it?");
    let loads = f.requests("session/load");
    assert_eq!(loads.len(), 1);
    assert_eq!((loads[0]["sessionId"].as_str(), &loads[0]["additionalDirectories"]), (Some(two.as_str()), &json!([r[2], r[1]])));
    f.turn(&one, "and here?");
    let loads = f.requests("session/load");
    assert_eq!((loads.len(), loads[1]["sessionId"].as_str()), (2, Some(one.as_str())));
    assert_eq!(loads[1]["additionalDirectories"], json!([r[2], r[1]]));
    f.turn(&quick, "not me");
    assert_eq!(f.requests("session/load").len(), 2, "a chat outside the project isn't reopened");

    // A chat started in the project later gets it from the start.
    let three = start(&after);
    assert_eq!(f.requests("session/new").pop().unwrap()["additionalDirectories"], json!([r[2], r[1]]));
    assert!(!f.hub.session_info(&three).unwrap().dirs_changed);
}

fn quick_chats_start_with_repos_chosen_up_front() {
    let f = Fixture::new(&[]);
    let r = repos(&f, &["api", "web"]);
    let cwd = f.dir.to_string_lossy().into_owned();
    let chosen = [r[0].clone(), r[1].clone(), r[0].clone(), cwd.clone()];
    let info = tauri::async_runtime::block_on(f.hub.new_session_with(ChatTarget::Folder(cwd.clone()), ACCOUNT, &chosen)).unwrap();
    assert_eq!((info.extra_dirs.clone(), info.additional_dirs.clone(), info.dirs_changed), (r.clone(), r.clone(), false));
    assert_eq!(f.requests("session/new").pop().unwrap()["additionalDirectories"], json!(r));
    let bad = f.dir.join("missing").to_string_lossy().into_owned();
    let err = tauri::async_runtime::block_on(f.hub.new_session_with(ChatTarget::Folder(cwd), ACCOUNT, &[bad])).unwrap_err();
    assert!(err.contains("is not a folder"), "{err}");
    assert_eq!(f.requests("session/new").len(), 1, "checked before any session starts");
}
