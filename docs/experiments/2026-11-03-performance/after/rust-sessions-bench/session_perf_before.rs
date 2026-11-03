//! Before: streaming, locking and startup, on the code at HEAD (113ed35).
#![allow(clippy::all, clippy::pedantic, dead_code, unused)]

use super::*;
use std::sync::atomic::AtomicU64;
use std::time::Instant;

fn report(metric: &str, value: f64, unit: &str, note: &str) {
    println!("RESULT\tbefore\t{metric}\t{value:.3}\t{unit}\t{note}");
}
struct Stats {
    mean: f64,
    p50: f64,
    p99: f64,
    max: f64,
    n: usize,
}
fn stats(mut us: Vec<f64>) -> Stats {
    us.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = us.len().max(1);
    let mean = us.iter().sum::<f64>() / n as f64;
    let at = |q: f64| us.get(((n as f64 - 1.0) * q).round() as usize).copied().unwrap_or(0.0);
    Stats { mean, p50: at(0.5), p99: at(0.99), max: us.last().copied().unwrap_or(0.0), n: us.len() }
}
fn bench(warm: usize, iters: usize, mut f: impl FnMut()) -> Stats {
    for _ in 0..warm {
        f();
    }
    let mut v = vec![];
    for _ in 0..iters {
        let t = Instant::now();
        f();
        v.push(t.elapsed().as_secs_f64() * 1e6);
    }
    stats(v)
}
fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("yaah-perf-{tag}-{}", random_token()));
    std::fs::create_dir_all(&d).unwrap();
    d
}
fn prose(n: usize) -> String {
    "The quick brown fox jumps over the lazy dog; `code` and **bold** text, then a newline.\n".chars().cycle().take(n).collect()
}

/// What Tauri does per emit: serialise the payload into a JS snippet.
fn tauri_emit(bytes: Arc<AtomicU64>) -> Emit {
    Arc::new(move |event: &str, payload: Value| {
        let s = serde_json::to_string(&payload).unwrap();
        let script = format!("(function () {{ const fn = window['__TAURI_TO_IPC_KEY__']; fn && fn({{event: '{event}', payload: {s}}}, [1]) }})()");
        bytes.fetch_add(script.len() as u64, Ordering::Relaxed);
        std::hint::black_box(script);
    })
}

fn store() -> &'static Store {
    Box::leak(Box::new(Store::at(tmp("store").join("agents.json"))))
}

fn fake_entries(n: usize, heavy: bool) -> Vec<Entry> {
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
            6 => Entry::Plan { entries: json!([{ "content": "step one", "status": "completed" }]) },
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

fn chunk_update(text: &str) -> Value {
    json!({ "sessionUpdate": "agent_message_chunk", "messageId": "m-stream", "content": { "type": "text", "text": text } })
}

fn stream(total: usize) {
    let bytes = Arc::new(AtomicU64::new(0));
    let shared = Shared { app: tauri_emit(bytes.clone()), sessions: Mutex::default(), needs_login: Mutex::default(), profiles: store(), saver: Saver::new() };
    let mut s = Session::new(info("s"), vec![], None);
    s.attached = Some(1);
    shared.sessions.lock().unwrap().insert("s".into(), s);
    let text = prose(total);
    let updates: Vec<Value> = text.as_bytes().chunks(40).map(|c| chunk_update(std::str::from_utf8(c).unwrap())).collect();
    let started = Instant::now();
    for u in &updates {
        let _ = shared.with("s", |s| apply_update(&shared, s, u));
    }
    let ms = started.elapsed().as_secs_f64() * 1e3;
    report(&format!("stream {}k chars (40-char chunks): Rust apply+emit, whole message", total / 1000), ms, "ms", "");
    report(&format!("stream {}k chars (40-char chunks): IPC bytes, whole message", total / 1000), bytes.load(Ordering::Relaxed) as f64 / 1e6, "MB", "");
}

#[test]
#[ignore]
fn perf_stream_chunks() {
    for total in [50_000, 200_000] {
        stream(total);
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
    let hub = Hub::open(tauri_emit(bytes.clone()), Some(dir.clone()), store());
    let mut entries = fake_entries(n, heavy);
    entries.push(form_entry(20, image));
    hub.shared.sessions.lock().unwrap().insert("a".into(), Session::new(info("a"), entries, Some(dir.join("a.json"))));
    (hub, bytes, dir)
}

#[test]
#[ignore]
fn perf_form_edits() {
    let (hub, bytes, dir) = hub_with(1000, true, 1_000_000);
    let b0 = bytes.load(Ordering::Relaxed);
    let mut i = 0;
    let st = bench(2, 30, || {
        i += 1;
        hub.edit_form("a", FormRef::UiId("f"), &json!({ "f1": format!("typed {i}") }), "user").unwrap();
    });
    let per = (bytes.load(Ordering::Relaxed) - b0) as f64 / 32.0;
    report("edit_form (1000 heavy entries + 1 MB image in the form): Rust time", st.mean, "us", "");
    report("edit_form (1000 heavy entries + 1 MB image in the form): IPC bytes per edit", per, "B", "");
    hub.flush();
    let _ = std::fs::remove_dir_all(dir);
}

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
        let label = if contended { "while chat A (5000 heavy entries, 28 MB) takes edits + get_transcript" } else { "uncontended" };
        report(&format!("chat B chunk latency p50 ({label})"), s.p50, "us", &format!("{} chunks", s.n));
        report(&format!("chat B chunk latency p99 ({label})"), s.p99, "us", "");
        report(&format!("chat B chunk latency max ({label})"), s.max, "us", "");
        hub.flush();
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[test]
#[ignore]
fn perf_load_sessions() {
    for (files, entries) in [(100, 200), (100, 1000)] {
        let dir = tmp("load");
        let mut total = 0;
        for i in 0..files {
            let t = Transcript { info: test_info(&format!("c{i}")), entries: fake_entries(entries, false) };
            let raw = serde_json::to_vec(&t).unwrap();
            total += raw.len();
            std::fs::write(dir.join(format!("c{i}.json")), raw).unwrap();
        }
        let st = bench(1, 5, || {
            std::hint::black_box(load_sessions(&dir));
        });
        report(&format!("load_sessions {files} chats x {entries} entries ({:.0} MB)", total as f64 / 1e6), st.mean / 1e3, "ms", "mean of 5");
        let _ = std::fs::remove_dir_all(dir);
    }
}
