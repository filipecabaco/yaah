//! Scratch-only benchmarks for the ACP reader: line framing, JSON parse, routing.
#![allow(clippy::all, clippy::pedantic, dead_code, unused)]

use super::*;
use crate::perf_util::*;
use std::time::Instant;

fn lines(n: usize, text_len: usize) -> Vec<u8> {
    let text: String = prose(text_len);
    let mut out = Vec::new();
    for i in 0..n {
        let m = json!({ "jsonrpc": "2.0", "method": "session/update", "params": { "sessionId": "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
            "update": { "sessionUpdate": "agent_message_chunk", "messageId": "msg_01", "content": { "type": "text", "text": text } } } });
        out.extend_from_slice(m.to_string().as_bytes());
        out.push(b'\n');
        let _ = i;
    }
    out
}

/// read_line + serde_json::from_slice::<Value> + route, as the reader task does, over an in-memory stream.
fn run(input: &[u8], n: usize, label: &str) {
    let (pending, (tx, _rx)) = (Mutex::new(PendingMap::new()), mpsc::unbounded_channel::<String>());
    let responder = Responder(tx);
    let seen = std::sync::atomic::AtomicUsize::new(0);
    let on = |m: Incoming, _: &Responder| {
        if let Incoming::Notification { params, .. } = m {
            std::hint::black_box(params);
            seen.fetch_add(1, Ordering::Relaxed);
        }
    };
    let (a0, b0) = allocs();
    let started = Instant::now();
    tauri::async_runtime::block_on(async {
        let (mut r, mut buf) = (BufReader::new(input), Vec::new());
        while let Ok(Some(_)) = read_line(&mut r, &mut buf, MAX_MESSAGE).await {
            if let Ok(Value::Object(msg)) = serde_json::from_slice::<Value>(&buf) {
                route(msg, &pending, &responder, &on);
            }
        }
    });
    let t = started.elapsed();
    let (a1, b1) = allocs();
    assert_eq!(seen.load(Ordering::Relaxed), n);
    let per = t.as_secs_f64() * 1e9 / n as f64;
    report("acp", &format!("{label}: read+parse+route per message"), per / 1e3, "us", &format!("{} B/line", input.len() / n));
    report("acp", &format!("{label}: throughput"), n as f64 / t.as_secs_f64() / 1e3, "k msg/s", &format!("{:.0} MB/s", input.len() as f64 / t.as_secs_f64() / 1e6));
    report("acp", &format!("{label}: allocations per message"), (a1 - a0) as f64 / n as f64, "allocs", &format!("{:.0} B allocated per message", (b1 - b0) as f64 / n as f64));
}

/// Parse only, into a Value vs. skipping (IgnoredAny): the floor a typed or borrowed parse could approach.
fn parse_only(input: &[u8], n: usize, label: &str) {
    let ls: Vec<&[u8]> = input.split(|b| *b == b'\n').filter(|l| !l.is_empty()).collect();
    let t = Instant::now();
    for l in &ls {
        std::hint::black_box(serde_json::from_slice::<Value>(l).unwrap());
    }
    let v = t.elapsed().as_secs_f64() * 1e9 / n as f64;
    let t = Instant::now();
    for l in &ls {
        std::hint::black_box(serde_json::from_slice::<serde::de::IgnoredAny>(l).unwrap());
    }
    let skip = t.elapsed().as_secs_f64() * 1e9 / n as f64;
    report("acp", &format!("{label}: parse to Value"), v / 1e3, "us", "");
    report("acp", &format!("{label}: parse floor (IgnoredAny)"), skip / 1e3, "us", "lower bound for a typed/borrowed parse");
}

#[test]
#[ignore]
fn perf_acp_reader() {
    let small = lines(100_000, 40);
    run(&small, 100_000, "100k chunks of 40 chars");
    parse_only(&small, 100_000, "100k chunks of 40 chars");
    let big = lines(200, 100_000);
    run(&big, 200, "200 messages of 100 KB");
    parse_only(&big, 200, "200 messages of 100 KB");
}
