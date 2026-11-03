//! Scratch-only benchmarks for transcript streaming, saving and locking.
#![allow(clippy::all, clippy::pedantic, dead_code, unused)]

use super::*;
use crate::perf_util::*;
use std::sync::atomic::AtomicU64;
use std::time::Instant;

const A: &str = "session";

/// What Tauri does per `emit`: `EmitArgs::new` (serde_json::to_string of the payload),
/// then `emit_js_script` (format! into a JS snippet that the webview evaluates).
fn tauri_emit(bytes: Arc<AtomicU64>, count: Arc<AtomicU64>) -> Emit {
    Arc::new(move |event: &str, payload: Value| {
        let s = serde_json::to_string(&payload).unwrap();
        let script = format!(
            "(function () {{ const fn = window['{}']; fn && fn({{event: '{}', payload: {}}}, {ids}) }})()",
            "__TAURI_TO_IPC_KEY__", event, s, ids = "[1]"
        );
        bytes.fetch_add(script.len() as u64, Ordering::Relaxed);
        count.fetch_add(1, Ordering::Relaxed);
        std::hint::black_box(script);
    })
}

fn store() -> &'static Store {
    Box::leak(Box::new(Store::at(tmp("store").join("agents.json"))))
}

fn shared_with(emit: Emit) -> Shared {
    Shared { app: emit, sessions: Mutex::default(), needs_login: Mutex::default(), profiles: store(), saver: Saver::new() }
}

/// A realistic mix: per 8 entries a user prompt, a thought, 3 tool calls (one with a diff), an agent reply, a plan, a UI.
pub(crate) fn fake_entries(n: usize, heavy: bool) -> Vec<Entry> {
    (0..n)
        .map(|i| match i % 8 {
            0 => Entry::User { text: prose(300), attachments: vec![] },
            1 => Entry::Thought { text: prose(600), message_id: Some(format!("t{i}")) },
            2 | 3 => Entry::Tool {
                tool_call_id: format!("tool{i}"),
                title: "Read src/session.rs".into(),
                kind: Some("read".into()),
                status: Some("completed".into()),
                content: json!([{ "type": "content", "content": { "type": "text", "text": prose(if heavy { 8000 } else { 2000 }) } }]),
                locations: json!([{ "path": "/x/src/session.rs" }]),
                raw_input: json!({ "file_path": "/x/src/session.rs" }),
            },
            4 => Entry::Tool {
                tool_call_id: format!("tool{i}"),
                title: "Edit src/session.rs".into(),
                kind: Some("edit".into()),
                status: Some("completed".into()),
                content: json!([{ "type": "diff", "path": "/x/src/session.rs", "oldText": prose(if heavy { 12000 } else { 3000 }), "newText": prose(if heavy { 12000 } else { 3000 }) }]),
                locations: json!([]),
                raw_input: json!({}),
            },
            5 => Entry::Agent { text: prose(1500), message_id: Some(format!("m{i}")) },
            6 => Entry::Plan { entries: json!([{ "content": "step one", "status": "completed" }, { "content": "step two", "status": "in_progress" }]) },
            _ => Entry::Ui {
                ui_id: None,
                title: Some("t".into()),
                component: Some("test-report".into()),
                version: Some(1),
                tree: json!({ "type": "card", "children": [{ "type": "text", "props": { "text": prose(400) } }] }),
                props: json!({}),
                ask_id: None,
                answer: None,
                draft: None,
                draft_by: None,
            },
        })
        .collect()
}

fn info(id: &str) -> SessionInfo {
    let mut i = test_info(id);
    i.running = true;
    i
}

fn add_session(shared: &Shared, id: &str, entries: Vec<Entry>, save_to: Option<PathBuf>) {
    let mut s = Session::new(info(id), entries, save_to);
    s.attached = Some(1);
    shared.sessions.lock().unwrap().insert(id.into(), s);
}

fn chunk_update(text: &str) -> Value {
    json!({ "sessionUpdate": "agent_message_chunk", "messageId": "m-stream", "content": { "type": "text", "text": text } })
}

/// Stream `total` chars in `chunk`-char chunks into a chat that already has `prior` entries.
fn stream(prior: usize, total: usize, chunk: usize) {
    let (bytes, count) = (Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0)));
    let shared = shared_with(tauri_emit(bytes.clone(), count.clone()));
    add_session(&shared, "s", fake_entries(prior, false), None);
    let text = prose(total);
    let parts: Vec<String> = text.as_bytes().chunks(chunk).map(|c| String::from_utf8(c.to_vec()).unwrap()).collect();
    let updates: Vec<Value> = parts.iter().map(|p| chunk_update(p)).collect();
    let (a0, b0) = allocs();
    let started = Instant::now();
    let mut times = Vec::with_capacity(updates.len());
    let mut last_bytes = 0;
    for u in &updates {
        let before = bytes.load(Ordering::Relaxed);
        let t = Instant::now();
        let _ = shared.with("s", |s| apply_update(&shared, s, u));
        times.push(t.elapsed().as_secs_f64() * 1e6);
        last_bytes = bytes.load(Ordering::Relaxed) - before;
    }
    let total_t = started.elapsed();
    let (a1, b1) = allocs();
    let n = times.len();
    let tail = stats(times[n - (n / 10).max(1)..].to_vec());
    let note = format!("{total} chars in {chunk}-char chunks ({n} chunks), {prior} prior entries");
    let label = format!("stream {}k chars, {prior} prior", total / 1000);
    report(A, &format!("{label}: total apply+emit"), total_t.as_secs_f64() * 1e3, "ms", &note);
    report(A, &format!("{label}: per chunk at the end (mean of last 10%)"), tail.mean, "us", &note);
    report(A, &format!("{label}: IPC bytes emitted, last chunk"), last_bytes as f64, "B", &note);
    report(A, &format!("{label}: IPC bytes emitted, whole message"), bytes.load(Ordering::Relaxed) as f64 / 1e6, "MB", &note);
    report(A, &format!("{label}: bytes allocated, whole message"), (b1 - b0) as f64 / 1e6, "MB", &format!("{note}; {} allocations", a1 - a0));
}

/// The same stream if only the new text went to the UI (an `append` event).
fn stream_delta(total: usize, chunk: usize) {
    let (bytes, count) = (Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0)));
    let emit = tauri_emit(bytes.clone(), count.clone());
    let text = prose(total);
    let parts: Vec<String> = text.as_bytes().chunks(chunk).map(|c| String::from_utf8(c.to_vec()).unwrap()).collect();
    let mut entry = String::new();
    let started = Instant::now();
    for p in &parts {
        entry.push_str(p);
        emit("session-append", json!({ "sessionId": "s", "index": 7, "text": p }));
    }
    report(
        A,
        &format!("stream {}k chars: delta-only emit (alternative), total", total / 1000),
        started.elapsed().as_secs_f64() * 1e3,
        "ms",
        &format!("same chunks; IPC bytes {:.2} MB", bytes.load(Ordering::Relaxed) as f64 / 1e6),
    );
}

#[test]
#[ignore]
fn perf_stream_chunks() {
    for total in [1_000, 10_000, 50_000, 200_000] {
        stream(0, total, 40);
    }
    // 200+ entries already in the chat: does the chunk cost depend on the transcript?
    stream(250, 50_000, 40);
    stream(2000, 50_000, 40);
    for total in [10_000, 50_000, 200_000] {
        stream_delta(total, 40);
    }
}

/// A tool call whose content grows with each update (streamed command output).
#[test]
#[ignore]
fn perf_tool_updates() {
    let (bytes, count) = (Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0)));
    let shared = shared_with(tauri_emit(bytes.clone(), count.clone()));
    add_session(&shared, "s", vec![], None);
    let _ = shared.with("s", |s| apply_update(&shared, s, &json!({ "sessionUpdate": "tool_call", "toolCallId": "t", "title": "Run cargo test", "status": "in_progress" })));
    let mut times = vec![];
    let b0 = bytes.load(Ordering::Relaxed);
    for i in 1..=200 {
        let u = json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t", "content": [{ "type": "content", "content": { "type": "text", "text": prose(i * 500) } }] });
        let t = Instant::now();
        let _ = shared.with("s", |s| apply_update(&shared, s, &u));
        times.push(t.elapsed().as_secs_f64() * 1e6);
    }
    let tail = stats(times[180..].to_vec());
    report(A, "tool_call_update with 100 KB content: per update", tail.mean, "us", "content replaced whole each update (200 updates growing by 500 chars)");
    report(A, "tool_call_update x200 growing to 100 KB: IPC bytes", (bytes.load(Ordering::Relaxed) - b0) as f64 / 1e6, "MB", "whole tool entry re-emitted per update");
}

/// Serialising a transcript for the saver (done under the sessions lock) and writing it.
#[test]
#[ignore]
fn perf_save() {
    for (n, heavy) in [(200, false), (1000, false), (1000, true), (5000, true)] {
        let shared = shared_with(Arc::new(|_: &str, _: Value| {}));
        let dir = tmp("save");
        add_session(&shared, "s", fake_entries(n, heavy), Some(dir.join("s.json")));
        let sessions = shared.sessions.lock().unwrap();
        let s = sessions.get("s").unwrap();
        let size = serde_json::to_vec(&s.entries).unwrap().len();
        let st = bench(2, 20, || shared.save(s));
        drop(sessions);
        let label = format!("save() {n} entries ({:.1} MB)", size as f64 / 1e6);
        report(A, &format!("{label}: serialise under the sessions lock"), st.mean, "us", "Shared::save: serde_json::to_vec of the whole transcript");
        let bytes = vec![b'x'; size];
        let w = bench(1, 10, || write_private(&dir.join("w.json"), &bytes).unwrap());
        report(A, &format!("{label}: background write (write_private)"), w.mean, "us", "saver thread; not under the lock");
        shared.saver.flush();
        let _ = std::fs::remove_dir_all(dir);
    }
}

fn form_entry(fields: usize, image_bytes: usize) -> Entry {
    let mut kids: Vec<Value> = (0..fields).map(|i| json!({ "type": "textfield", "props": { "name": format!("f{i}"), "label": format!("Field {i}") } })).collect();
    if image_bytes > 0 {
        kids.insert(0, json!({ "type": "image", "props": { "src": format!("data:image/png;base64,{}", "A".repeat(image_bytes)) } }));
    }
    Entry::Ui {
        ui_id: Some("f".into()),
        title: Some("form".into()),
        component: None,
        version: None,
        tree: json!({ "type": "form", "children": kids }),
        props: json!({}),
        ask_id: None,
        answer: None,
        draft: None,
        draft_by: None,
    }
}

fn hub_with(n: usize, heavy: bool, image: usize) -> (Hub, Arc<AtomicU64>, PathBuf) {
    let bytes = Arc::new(AtomicU64::new(0));
    let dir = tmp("hub");
    let hub = Hub::open(tauri_emit(bytes.clone(), Arc::default()), Some(dir.clone()), store());
    let mut entries = fake_entries(n, heavy);
    entries.push(form_entry(20, image));
    let s = Session::new(info("a"), entries, Some(dir.join("a.json")));
    hub.shared.sessions.lock().unwrap().insert("a".into(), s);
    (hub, bytes, dir)
}

/// Form edits (user typing, debounced 350 ms; or the agent's ui_set_values), re-renders and get_transcript.
#[test]
#[ignore]
fn perf_form_edits_and_transcript() {
    for (n, heavy, image) in [(200, false, 0), (1000, true, 0), (1000, true, 1_000_000)] {
        let (hub, bytes, dir) = hub_with(n, heavy, image);
        let label = format!("{n} entries{}{}", if heavy { " heavy" } else { "" }, if image > 0 { " + 1 MB image in the form" } else { "" });
        let b0 = bytes.load(Ordering::Relaxed);
        let mut i = 0;
        let st = bench(2, 30, || {
            i += 1;
            hub.edit_form("a", FormRef::UiId("f"), &json!({ "f1": format!("typed {i}") }), "user").unwrap();
        });
        let per = (bytes.load(Ordering::Relaxed) - b0) as f64 / 32.0;
        report(A, &format!("edit_form ({label})"), st.mean, "us", &format!("emits the whole UI entry ({per:.0} B) and re-serialises the whole transcript for the saver"));
        let g = bench(1, 10, || {
            std::hint::black_box(hub.form("a", FormRef::UiId("f")).unwrap());
        });
        report(A, &format!("ui_get_values / form() ({label})"), g.mean, "us", "rposition + form_fields walk");
        let t = bench(1, 10, || {
            let tr = hub.transcript("a").unwrap();
            std::hint::black_box(serde_json::to_string(&tr).unwrap());
        });
        let size = serde_json::to_string(&hub.transcript("a").unwrap()).unwrap().len();
        report(A, &format!("get_transcript clone+serialise ({label})"), t.mean, "us", &format!("IPC reply {:.2} MB", size as f64 / 1e6));
        let p = bench(1, 20, || {
            hub.push_ui("a", form_entry(20, image));
        });
        report(A, &format!("push_ui re-render same id ({label})"), p.mean, "us", "rposition scan + emit + whole-transcript save");
        hub.flush();
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// Chat B streams while chat A (a long chat) takes form edits: both need the one sessions lock.
#[test]
#[ignore]
fn perf_lock_contention() {
    for contended in [false, true] {
        let (hub, _bytes, dir) = hub_with(5000, true, 0);
        let mut b = Session::new(info("b"), vec![], None);
        b.attached = Some(1);
        hub.shared.sessions.lock().unwrap().insert("b".into(), b);
        let hub = Arc::new(hub);
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let editor = contended.then(|| {
            let (hub, stop) = (hub.clone(), stop.clone());
            std::thread::spawn(move || {
                let mut i = 0;
                while !stop.load(Ordering::Relaxed) {
                    i += 1;
                    // The agent filling a form in (ui_set_values) and get_transcript on chat switch, back to back.
                    hub.edit_form("a", FormRef::UiId("f"), &json!({ "f1": format!("v{i}") }), "agent").unwrap();
                    std::hint::black_box(hub.transcript("a").unwrap());
                    std::thread::sleep(Duration::from_millis(20));
                }
            })
        });
        let shared = hub.shared.clone();
        let mut lat = vec![];
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(3) {
            let u = chunk_update("token text ");
            let t = Instant::now();
            let _ = shared.with("b", |s| apply_update(&shared, s, &u));
            lat.push(t.elapsed().as_secs_f64() * 1e6);
            std::thread::sleep(Duration::from_micros(500));
        }
        stop.store(true, Ordering::Relaxed);
        if let Some(e) = editor {
            e.join().unwrap();
        }
        let s = stats(lat);
        let label = if contended { "while chat A (5000 entries, 28 MB) takes edits + get_transcript" } else { "uncontended" };
        report(A, &format!("chat B chunk latency p50 ({label})"), s.p50, "us", &format!("{} chunks", s.n));
        report(A, &format!("chat B chunk latency p99 ({label})"), s.p99, "us", "");
        report(A, &format!("chat B chunk latency max ({label})"), s.max, "us", "");
        hub.flush();
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// Startup: restoring saved chats.
#[test]
#[ignore]
fn perf_load_sessions() {
    for (files, entries) in [(20, 200), (100, 200), (100, 1000)] {
        let dir = tmp("load");
        let mut total = 0;
        for i in 0..files {
            let t = Transcript { info: test_info(&format!("c{i}")), entries: fake_entries(entries, false) };
            let raw = serde_json::to_vec(&t).unwrap();
            total += raw.len();
            std::fs::write(dir.join(format!("c{i}.json")), raw).unwrap();
        }
        let st = bench(1, 3, || {
            std::hint::black_box(load_sessions(&dir));
        });
        report("startup", &format!("load_sessions {files} chats x {entries} entries ({:.0} MB)", total as f64 / 1e6), st.mean / 1e3, "ms", "Hub::with_store, before the window is built (runs in setup)");
        let _ = std::fs::remove_dir_all(dir);
    }
}
