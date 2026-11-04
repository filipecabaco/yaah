use super::*;
use crate::agents::{self, Draft, Store};
use crate::attachments::Kind;
use crate::session::{Session, finish_turn, test_info};
use serde_json::json;
use std::path::PathBuf;
use std::time::{Duration, Instant};

fn item(id: &str) -> Queued {
    Queued {
        id: id.into(),
        text: format!("message {id}"),
        mentions: vec![],
        files: vec![],
        references: 0,
        queued_at: 0,
        config: BTreeMap::new(),
        sending: false,
    }
}

fn queue(ids: &[&str]) -> Queue {
    Queue { items: ids.iter().map(|i| item(i)).collect(), ..Queue::default() }
}

fn ids(q: &Queue) -> Vec<&str> {
    q.items.iter().map(|i| i.id.as_str()).collect()
}

fn reason(q: &Queue) -> Option<PauseReason> {
    q.paused.as_ref().map(|p| p.reason)
}

fn temp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("yaah-queue-{tag}-{}", super::super::random_token()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// A hub over a temp profile store with one profile whose agent can't start (`false`),
/// saving chats in `store` when given; its queues send on their own.
fn hub(dir: &std::path::Path, store: Option<PathBuf>) -> (Arc<Hub>, String) {
    std::fs::write(dir.join("agents.json"), r#"{ "profiles": [] }"#).unwrap();
    let profiles: &'static Store = Box::leak(Box::new(Store::at(dir.join("agents.json"))));
    let draft = Draft { label: "Broken".into(), preset: agents::CUSTOM.into(), command_line: "false".into(), ..Draft::default() };
    let id = profiles.save(&draft).unwrap().0.id;
    let hub = Arc::new(Hub::open(Arc::new(|_: &str, _: Value| {}), store, profiles));
    hub.start_queues();
    (hub, id)
}

/// A chat `sid` of `account` in `hub`, running or not, saved to `save_to`.
fn chat(hub: &Hub, sid: &str, account: &str, running: bool, save_to: Option<PathBuf>) {
    let mut info = test_info(sid);
    info.account_id = account.into();
    info.running = running;
    hub.shared.insert(Session::new(info, vec![], save_to));
}

fn wait_for(what: &str, f: impl Fn() -> bool) {
    let started = Instant::now();
    while !f() {
        assert!(started.elapsed() < Duration::from_secs(15), "timed out waiting until {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

// ── The rules ───────────────────────────────────────────────────────────────

/// stop reason, error, a permission still waiting, Stop pressed → why it pauses, and the detail.
type Case<'a> = (Option<&'a str>, Option<&'a str>, bool, bool, PauseReason, Option<&'a str>);

#[test]
fn only_a_normal_end_sends_the_next_and_everything_else_pauses_saying_why() {
    let mut q = queue(&["a"]);
    assert!(q.turn_ended(Some("end_turn"), None, false), "end_turn, no error, nothing waiting: the next goes");
    assert_eq!(q.paused, None);

    let cases: [Case; 6] = [
        (None, Some("agent process exited"), false, false, PauseReason::Error, Some("agent process exited")),
        (Some("end_turn"), Some("boom"), false, false, PauseReason::Error, Some("boom")),
        (Some("cancelled"), None, false, false, PauseReason::Cancelled, None),
        (Some("end_turn"), None, false, true, PauseReason::Cancelled, None),
        (Some("end_turn"), None, true, false, PauseReason::Permission, None),
        (Some("max_tokens"), None, false, false, PauseReason::Stopped, Some("max_tokens")),
    ];
    for (stop, error, permission, user_stopped, want, detail) in cases {
        let mut q = queue(&["a"]);
        if user_stopped {
            q.stopped_by_user();
        }
        assert!(!q.turn_ended(stop, error, permission), "{stop:?} {error:?} {permission}");
        assert_eq!((reason(&q), q.paused.as_ref().and_then(|p| p.detail.as_deref())), (Some(want), detail));
        assert_eq!(ids(&q), ["a"], "nothing is dropped");
    }
    let mut q = queue(&["a"]);
    assert!(!q.turn_ended(None, None, false));
    assert_eq!(q.paused.as_ref().and_then(|p| p.detail.as_deref()), Some("no stop reason"));

    // A paused queue stays paused through normal turns (sent directly) until Resume.
    let mut q = queue(&["a"]);
    q.turn_ended(Some("cancelled"), None, false);
    assert!(!q.turn_ended(Some("end_turn"), None, false));
    assert_eq!(reason(&q), Some(PauseReason::Cancelled));

    // An empty queue never pauses, and a user's Stop is forgotten with the turn.
    let mut q = Queue::default();
    q.stopped_by_user();
    assert!(!q.turn_ended(Some("cancelled"), None, false));
    assert!(q.is_empty());
    q.push(item("b")).unwrap();
    assert!(q.turn_ended(Some("end_turn"), None, false), "the earlier stop doesn't pause the next turn");
}

#[test]
fn send_now_goes_whatever_the_stopped_turn_ended_with() {
    let mut q = queue(&["a", "b"]);
    q.paused = Some(Pause::new(PauseReason::Error, Some("x")));
    q.move_to("b", 0).unwrap();
    q.send_now = Some("b".into());
    q.stopped_by_user();
    assert!(q.turn_ended(Some("cancelled"), None, false));
    assert_eq!((ids(&q), q.paused.clone()), (vec!["b", "a"], None));
    assert_eq!(q.begin().map(|i| i.id), Some("b".into()));
}

#[test]
fn items_move_and_leave_but_never_the_one_on_its_way() {
    let mut q = queue(&["a", "b", "c"]);
    q.move_to("c", 0).unwrap();
    assert_eq!(ids(&q), ["c", "a", "b"]);
    q.move_to("c", 99).unwrap();
    assert_eq!(ids(&q), ["a", "b", "c"], "clamped to the end");
    q.move_to("a", 1).unwrap();
    assert_eq!(ids(&q), ["b", "a", "c"]);
    assert!(q.move_to("zz", 0).unwrap_err().contains("isn't queued"));

    let first = q.begin().unwrap();
    assert_eq!((first.id.as_str(), q.sending(), q.begin()), ("b", true, None), "one at a time");
    assert!(q.take("b").unwrap_err().contains("being sent"));
    assert!(q.move_to("b", 2).unwrap_err().contains("being sent"));
    q.move_to("c", 0).unwrap();
    assert_eq!(ids(&q), ["b", "c", "a"], "nothing goes above the one on its way");
    assert_eq!(q.take("c").unwrap().id, "c");

    let gone = q.clear();
    assert_eq!((gone.len(), ids(&q)), (1, vec!["b"]), "clear keeps the one on its way");
    q.sent("b");
    assert_eq!((q.items.len(), q.last_sent.as_deref()), (0, Some("b")));

    let mut q = queue(&["a"]);
    q.begin();
    q.failed("a", "the agent isn't logged in");
    assert_eq!((ids(&q), q.sending(), reason(&q)), (vec!["a"], false, Some(PauseReason::SendFailed)));

    let mut q = Queue::default();
    for n in 0..MAX_QUEUED {
        q.push(item(&n.to_string())).unwrap();
    }
    assert!(q.push(item("one too many")).unwrap_err().contains("at most"));
}

#[test]
fn a_restored_queue_waits_for_resume_and_runtime_state_isnt_kept() {
    let mut q = queue(&["a", "b"]);
    q.items[0].sending = true;
    q.last_sent = Some("z".into());
    let saved = serde_json::to_value(&q).unwrap();
    assert_eq!(saved["items"][0]["sending"], true, "the UI sees it");
    let mut back: Queue = serde_json::from_value(saved).unwrap();
    assert!(!back.items[0].sending && back.last_sent.is_none(), "but it isn't read back");
    back.restored();
    assert_eq!(reason(&back), Some(PauseReason::Restart));

    let mut paused = queue(&["a"]);
    paused.paused = Some(Pause::new(PauseReason::Permission, None));
    paused.restored();
    assert_eq!(reason(&paused), Some(PauseReason::Permission), "an earlier reason stays");
    let mut empty = Queue::default();
    empty.restored();
    assert!(empty.is_empty());
    assert!(serde_json::to_value(test_info("c")).unwrap().get("queue").is_none(), "nothing written for a chat without a queue");
}

// ── Through the Hub ─────────────────────────────────────────────────────────

#[test]
fn a_busy_chat_queues_what_a_send_carries_and_an_idle_one_doesnt() {
    let dir = temp("busy");
    let (hub, account) = hub(&dir, None);
    chat(&hub, "q1", &account, true, None);
    hub.shared
        .with("q1", |s| {
            s.info.config.options = super::super::config::offered(&json!({ "configOptions": [
                { "id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": "opus", "options": [{ "value": "opus" }, { "value": "sonnet" }] },
                { "id": "mode", "name": "Mode", "category": "mode", "type": "select", "currentValue": "plan", "options": [{ "value": "plan" }] }
            ]}));
        })
        .unwrap();
    let file = crate::attachments::Attachment {
        id: "att1".into(),
        name: "notes.md".into(),
        kind: Kind::File,
        mime_type: Some("text/markdown".into()),
        size: Some(5),
        path: Some("/tmp/notes.md".into()),
        pasted: false,
        image: None,
        width: None,
        height: None,
        note: None,
        text: true,
        sent_as: None,
    };
    let text = "look at github#o/r#9 and linear#ENG-1, again github#O/R#9";
    let sent = hub.queue_if_busy("q1", text, &["/tmp/a.rs".into()], std::slice::from_ref(&file)).unwrap();
    let Some(Sent::Queued { id, position: 1 }) = sent else { panic!("{sent:?}") };
    let second = hub.queue_if_busy("q1", "then this", &[], &[]).unwrap();
    assert!(matches!(second, Some(Sent::Queued { position: 2, .. })));

    let q = hub.session_info("q1").unwrap().queue;
    let first = &q.items[0];
    assert_eq!((first.id.as_str(), first.text.as_str(), first.references), (id.as_str(), text, 2), "references counted once each, not read");
    assert_eq!((first.mentions.clone(), first.files.clone()), (vec!["/tmp/a.rs".to_owned()], vec![file]));
    assert_eq!(first.config, BTreeMap::from([("model".into(), "opus".into())]), "model and effort only");

    chat(&hub, "q2", &account, false, None);
    assert_eq!(hub.queue_if_busy("q2", "now", &[], &[]).unwrap(), None, "an idle chat sends");
    // …unless a queued message is on its way.
    hub.shared.with("q2", |s| s.info.queue.items.push(Queued { sending: true, ..item("x") })).unwrap();
    assert!(hub.queue_if_busy("q2", "later", &[], &[]).unwrap().is_some());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn edit_hands_the_message_back_and_remove_and_clear_drop_only_their_own_images() {
    let dir = temp("images");
    let (hub, account) = hub(&dir, None);
    let sid = format!("img-{}", super::super::random_token());
    chat(&hub, &sid, &account, true, None);
    let images = hub.image_dir(&sid).unwrap();
    let store = |n: u8| crate::attachments::store_image(&images, &[n; 8], image::ImageFormat::Png).unwrap();
    let (only_mine, sent_too, staged, shared_by_two, kept_for_edit) = (store(1), store(2), store(3), store(4), store(5));
    let pasted = |id: &str| crate::attachments::Attachment {
        id: format!("a-{id}"),
        name: "Pasted image.png".into(),
        kind: Kind::Image,
        mime_type: Some("image/png".into()),
        size: Some(8),
        path: Some(images.join(id).to_string_lossy().into_owned()),
        pasted: true,
        image: Some(id.to_owned()),
        width: Some(1),
        height: Some(1),
        note: None,
        text: false,
        sent_as: None,
    };
    // A message already sent with one of the images.
    hub.shared
        .with(&sid, |s| {
            s.entries.push(Arc::new(Entry::User { text: "earlier".into(), attachments: vec![], files: vec![pasted(&sent_too)], references: vec![] }));
        })
        .unwrap();
    let queued = |text: &str, files: Vec<crate::attachments::Attachment>| match hub.queue_if_busy(&sid, text, &[], &files).unwrap() {
        Some(Sent::Queued { id, .. }) => id,
        other => panic!("{other:?}"),
    };
    let a = queued("a", vec![pasted(&only_mine), pasted(&sent_too), pasted(&staged), pasted(&shared_by_two)]);
    let b = queued("b", vec![pasted(&shared_by_two)]);
    let c = queued("c", vec![pasted(&kept_for_edit)]);
    let e = queued("e", vec![]);
    let exists = |id: &str| images.join(id).is_file();

    hub.queue_remove(&sid, &a, &|id| id == staged).unwrap();
    assert!(!exists(&only_mine), "held by nothing else: deleted");
    assert!(exists(&sent_too) && exists(&staged) && exists(&shared_by_two), "the transcript, the composer and another item still use these");

    let edited = hub.queue_take(&sid, &c).unwrap();
    assert_eq!((edited.text.as_str(), edited.files.len()), ("c", 1));
    assert!(exists(&kept_for_edit), "Edit keeps the attachments: they go back to the composer");
    hub.queue_move(&sid, &e, 0).unwrap();
    assert_eq!(ids(&hub.session_info(&sid).unwrap().queue), [e.as_str(), b.as_str()]);

    hub.queue_clear(&sid, &|_| false).unwrap();
    assert!(!exists(&shared_by_two), "the last item holding it went");
    assert!(hub.session_info(&sid).unwrap().queue.is_empty());
    let _ = std::fs::remove_dir_all(dir);
    let _ = std::fs::remove_dir_all(images);
}

#[test]
fn a_queue_survives_a_restart_paused_with_its_attachments() {
    let dir = temp("restart");
    let sessions = dir.join("sessions");
    let (hub1, account) = hub(&dir, Some(sessions.clone()));
    chat(&hub1, "keep", &account, true, Some(sessions.join("keep.json")));
    let file = dir.join("spec.md");
    std::fs::write(&file, "# spec").unwrap();
    let attached = crate::attachments::attach_path(file.to_str().unwrap(), &hub1.image_dir("keep").unwrap()).unwrap();
    hub1.queue_if_busy("keep", "first", &[], std::slice::from_ref(&attached)).unwrap();
    hub1.queue_if_busy("keep", "second", &[], &[]).unwrap();
    hub1.flush();
    drop(hub1);

    let (hub2, _) = hub(&dir, Some(sessions));
    let info = hub2.session_info("keep").unwrap();
    assert!(!info.running);
    let q = &info.queue;
    assert_eq!(q.items.iter().map(|i| i.text.as_str()).collect::<Vec<_>>(), ["first", "second"], "in order");
    assert_eq!(q.items[0].files, [attached], "the attachments are the queue's, kept with the chat");
    assert_eq!(reason(q), Some(PauseReason::Restart), "nothing goes on its own after a restart");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn resume_and_send_now_send_from_rust_and_a_failed_send_keeps_the_message() {
    let dir = temp("resume");
    let (hub, account) = hub(&dir, None);
    chat(&hub, "r", &account, true, None);
    hub.queue_if_busy("r", "one", &[], &[]).unwrap();
    let Some(Sent::Queued { id: two, .. }) = hub.queue_if_busy("r", "two", &[], &[]).unwrap() else { panic!() };
    // The turn is stopped: the queue pauses.
    hub.cancel("r").unwrap();
    assert!(!finish_turn(&hub.shared, "r", Some("cancelled".into()), None));
    assert_eq!(reason(&hub.session_info("r").unwrap().queue), Some(PauseReason::Cancelled));

    // Send now on the second: no turn runs, so it goes at once; this agent can't start, so it stays first, paused.
    hub.queue_send_now("r", &two).unwrap();
    wait_for("the send fails", || reason(&hub.session_info("r").unwrap().queue) == Some(PauseReason::SendFailed));
    let q = hub.session_info("r").unwrap().queue;
    assert_eq!(q.items.iter().map(|i| i.text.as_str()).collect::<Vec<_>>(), ["two", "one"]);
    assert!(!q.items[0].sending && q.paused.unwrap().detail.is_some(), "with why");

    hub.queue_resume("r").unwrap();
    wait_for("it fails again", || reason(&hub.session_info("r").unwrap().queue) == Some(PauseReason::SendFailed));
    assert_eq!(hub.session_info("r").unwrap().queue.items.len(), 2, "nothing is lost");
    let _ = std::fs::remove_dir_all(dir);
}

/// A tracker stand-in that answers 404 and counts what it was asked.
fn tracker() -> (String, Arc<std::sync::atomic::AtomicUsize>) {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let base = format!("http://{}", server.server_addr().to_ip().unwrap());
    let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let seen = hits.clone();
    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let _ = req.respond(tiny_http::Response::from_string(r#"{"message":"Not Found"}"#).with_status_code(404));
        }
    });
    (base, hits)
}

#[test]
fn references_are_read_when_the_message_is_sent_not_when_it_is_queued() {
    let dir = temp("refs");
    let (hub, account) = hub(&dir, None);
    let (base, hits) = tracker();
    let integrations = crate::integrations::tests::instance(&base, 0);
    integrations.put("github", json!({ "api_key": "test-key" })).unwrap();
    hub.use_integrations(integrations);
    chat(&hub, "refs", &account, true, None);
    hub.queue_if_busy("refs", "fix github#octo/shop#12", &[], &[]).unwrap();
    assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 0, "queuing reads nothing");

    assert!(finish_turn(&hub.shared, "refs", Some("end_turn".into()), None), "a normal end sends the next");
    hub.send_next_in_background("refs");
    wait_for("the reference is read", || hits.load(std::sync::atomic::Ordering::SeqCst) > 0);
    wait_for("the send fails (no agent)", || reason(&hub.session_info("refs").unwrap().queue) == Some(PauseReason::SendFailed));
    let _ = std::fs::remove_dir_all(dir);
}
