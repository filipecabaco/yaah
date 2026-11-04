//! A chat's message queue (`session/queue.rs`) against the scripted agent: what is
//! sent while a turn runs waits, then goes from Rust as each turn ends, in order;
//! a stopped turn pauses it, Send now jumps it, and a restart leaves it paused.

use super::{Fixture, last_agent_text};
use yaah_lib::session::{Entry, PauseReason, Queue, Sent, Transcript};

fn send(f: &Fixture, sid: &str, text: &str) -> Sent {
    tauri::async_runtime::block_on(f.hub.send_or_queue(sid, text.into(), vec![], vec![])).unwrap()
}

fn queue(f: &Fixture, sid: &str) -> Queue {
    f.hub.session_info(sid).unwrap().queue
}

fn texts(q: &Queue) -> Vec<String> {
    q.items.iter().map(|i| i.text.clone()).collect()
}

fn user_texts(t: &Transcript) -> Vec<String> {
    t.entries.iter().filter_map(|e| if let Entry::User { text, .. } = e { Some(text.clone()) } else { None }).collect()
}

fn agent_texts(t: &Transcript) -> Vec<String> {
    t.entries.iter().filter_map(|e| if let Entry::Agent { text, .. } = e { Some(text.clone()) } else { None }).collect()
}

/// Wait until the chat is idle with an empty queue, and `n` messages were sent.
fn drained(f: &Fixture, sid: &str, n: usize) -> Transcript {
    f.until(sid, "the queue is sent", |t| (!t.info.running && t.info.queue.items.is_empty() && user_texts(t).len() == n).then_some(()));
    f.hub.transcript(sid).unwrap()
}

pub fn queued_messages_go_in_order_as_turns_end() {
    let f = Fixture::new(&[]);
    let sid = f.chat();
    assert_eq!(send(&f, &sid, "slow 600 first"), Sent::Started);
    assert!(matches!(send(&f, &sid, "echo one"), Sent::Queued { position: 1, .. }));
    assert!(matches!(send(&f, &sid, "echo two"), Sent::Queued { position: 2, .. }));
    assert_eq!(texts(&queue(&f, &sid)), ["echo one", "echo two"]);
    f.until(&sid, "the agent logs the first prompt", |_| (!f.requests("session/prompt").is_empty()).then_some(()));
    assert_eq!(f.requests("session/prompt").len(), 1, "nothing more reached the agent while it worked");

    let t = drained(&f, &sid, 3);
    assert_eq!(user_texts(&t), ["slow 600 first", "echo one", "echo two"]);
    assert_eq!(agent_texts(&t), ["slow: first", "echo: echo one", "echo: echo two"], "one at a time, each after the last ended");
    assert_eq!(t.info.queue.paused, None);
    let prompts: Vec<String> =
        f.requests("session/prompt").iter().map(|p| p["prompt"].as_array().unwrap().last().unwrap()["text"].as_str().unwrap().to_owned()).collect();
    assert_eq!(prompts, ["slow 600 first", "echo one", "echo two"]);
    // The UI heard each one leave the queue.
    let events = f.events.lock().unwrap().clone();
    assert!(events.iter().any(|(n, v)| n == "session-info" && v["queue"]["items"].as_array().is_some_and(|i| i.len() == 2)));
    assert!(events.iter().any(|(n, v)| n == "session-info" && v["queue"]["lastSent"].is_string()));
}

pub fn a_stopped_turn_pauses_the_queue_and_send_now_jumps_it() {
    let f = Fixture::new(&[]);
    let sid = f.chat();
    send(&f, &sid, "wait");
    f.until(&sid, "the deploy request", |t| super::waiting_permissions(t).first().copied());
    send(&f, &sid, "echo a");
    send(&f, &sid, "echo b");
    f.hub.cancel(&sid).unwrap();
    f.until(&sid, "the queue pauses", |t| (!t.info.running && t.info.queue.paused.is_some()).then_some(()));
    let q = queue(&f, &sid);
    assert_eq!((q.paused.as_ref().map(|p| p.reason), texts(&q)), (Some(PauseReason::Cancelled), vec!["echo a".to_owned(), "echo b".to_owned()]));
    std::thread::sleep(std::time::Duration::from_millis(200));
    assert_eq!(f.requests("session/prompt").len(), 1, "a stopped turn sends nothing on");

    f.hub.queue_resume(&sid).unwrap();
    let t = drained(&f, &sid, 3);
    assert_eq!(user_texts(&t)[1..], ["echo a", "echo b"]);

    // Send now on the last one: the running turn stops, it goes first, the other follows.
    send(&f, &sid, "wait");
    f.until(&sid, "the deploy request again", |t| super::waiting_permissions(t).first().copied());
    send(&f, &sid, "echo c");
    let Sent::Queued { id, .. } = send(&f, &sid, "echo d") else { panic!("queued") };
    f.hub.queue_send_now(&sid, &id).unwrap();
    let t = drained(&f, &sid, 6);
    assert_eq!(user_texts(&t)[3..], ["wait", "echo d", "echo c"]);
    assert_eq!(last_agent_text(&t), "echo: echo c");
    assert_eq!(t.info.queue.paused, None, "Send now isn't a pause");
}

pub fn a_queue_waits_after_a_restart_until_resumed() {
    let mut f = Fixture::new(&[]);
    let sid = f.chat();
    send(&f, &sid, "slow 1500 cut");
    send(&f, &sid, "echo later");
    f.restart();
    let q = queue(&f, &sid);
    assert_eq!((q.paused.as_ref().map(|p| p.reason), texts(&q)), (Some(PauseReason::Restart), vec!["echo later".to_owned()]));
    assert!(!f.hub.session_info(&sid).unwrap().running);

    f.hub.queue_resume(&sid).unwrap();
    f.until(&sid, "the queued message is answered", |t| (last_agent_text(t) == "echo: echo later" && !t.info.running).then_some(()));
    assert!(queue(&f, &sid).is_empty());
    assert!(!f.requests("session/load").is_empty(), "it reattached first, as any message after a restart does");
}
