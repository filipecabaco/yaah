//! Scratch-only benchmarks for the UI MCP server.
#![allow(clippy::all, clippy::pedantic, dead_code, unused)]

use super::*;
use crate::perf_util::*;
use crate::session::SessionInfo;
use std::io::Write as _;
use std::time::Instant;

const A: &str = "ui_mcp";

fn exchange(port: u16, body: &str) -> String {
    let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(s, "POST /mcp/tok HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
    let mut out = String::new();
    let _ = s.read_to_string(&mut out);
    out
}

fn setup(local: usize, folder: usize, prior: usize) -> (Arc<Hub>, Arc<UiHost>, u16, PathBuf) {
    let dir = crate::perf_util::tmp("uimcp");
    let info = SessionInfo {
        session_id: "s1".into(),
        project_id: None,
        created_at: 0,
        account_id: "default".into(),
        cwd: dir.to_string_lossy().into_owned(),
        additional_dirs: vec![],
        title: "t".into(),
        running: false,
        stop_reason: None,
        commands: vec![],
    };
    std::fs::create_dir_all(dir.join("sessions")).unwrap();
    let entries: Vec<Value> = crate::session::perf_entries(prior);
    std::fs::write(dir.join("sessions/s1.json"), json!({ "info": info, "entries": entries }).to_string()).unwrap();
    let hub = Arc::new(Hub::with_store(Arc::new(|_: &str, _: Value| {}), dir.join("sessions")));
    let library = Arc::new(crate::ui_libraries::perf_bench::build(&dir.join("lib"), local, folder, 0));
    let sources = Arc::new(crate::sources::Sources::with_connections_file(dir.join("connections.json")));
    let host = Arc::new(UiHost::new(hub.clone(), library, sources));
    host.test_tokens.lock().unwrap().insert("tok".into(), "s1".into());
    let port = start(host.clone()).unwrap();
    hub.set_ui_port(port);
    (hub, host, port, dir)
}

fn tool(name: &str, args: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { "name": name, "arguments": args } }).to_string()
}

#[test]
#[ignore]
fn perf_ui_mcp() {
    for (local, folder, prior) in [(0, 0, 200), (200, 500, 1000)] {
        let (hub, host, port, dir) = setup(local, folder, prior);
        let label = format!("{} components, {prior}-entry chat", 23 + local + folder);
        // Baseline: the HTTP exchange itself (TCP connect, thread per request, tiny method).
        let ping = json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }).to_string();
        let p = bench(5, 200, || {
            std::hint::black_box(exchange(port, &ping));
        });
        report(A, "HTTP ping round trip (thread per request)", p.mean, "us", "loopback, Connection: close");
        let tl = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }).to_string();
        let t = bench(5, 200, || {
            std::hint::black_box(exchange(port, &tl));
        });
        report(A, "tools/list round trip", t.mean, "us", "tools() JSON rebuilt per call");
        let cat = tool("ui_catalog", json!({}));
        let size = exchange(port, &cat).len();
        let c = bench(2, 30, || {
            std::hint::black_box(exchange(port, &cat));
        });
        report(A, &format!("ui_catalog round trip ({label})"), c.mean / 1e3, "ms", &format!("{:.0} KB reply; rebuilt per call, not cached", size as f64 / 1e3));
        let c = bench(2, 30, || {
            std::hint::black_box(call_tool(&host, Some("s1"), "ui_catalog", &json!({})));
        });
        report(A, &format!("ui_catalog handler only ({label})"), c.mean / 1e3, "ms", "");
        let g = tool("ui_guide", json!({ "topic": "ui" }));
        let gg = bench(1, 20, || {
            std::hint::black_box(exchange(port, &g));
        });
        report(A, &format!("ui_guide round trip ({label})"), gg.mean / 1e3, "ms", "component_names -> library.list()");

        // ui_render: a 2,990-node ad-hoc tree (near MAX_NODES), with an id so it replaces in place.
        let big = json!({ "type": "stack", "children": (0..2990).map(|i| json!({ "type": "text", "props": { "text": format!("row {i} {}", prose(30)) } })).collect::<Vec<_>>() });
        let r = tool("ui_render", json!({ "tree": big, "id": "big" }));
        let rr = bench(1, 10, || {
            std::hint::black_box(exchange(port, &r));
        });
        report(A, &format!("ui_render 2,990-node tree, by id ({label})"), rr.mean / 1e3, "ms", &format!("{:.0} KB request; prepare + inline_files + push_ui (emit + whole-transcript save)", r.len() as f64 / 1e3));
        let small = tool("ui_render", json!({ "component": "test-report", "props": { "text": "test a ... ok\n" }, "id": "small" }));
        let rs = bench(2, 30, || {
            std::hint::black_box(exchange(port, &small));
        });
        report(A, &format!("ui_render bundled component, by id ({label})"), rs.mean / 1e3, "ms", "");
        let prep = bench(1, 10, || {
            std::hint::black_box(host.library.prepare(None, json!({}), Some(big.clone())).unwrap());
        });
        report(A, &format!("  of which prepare() of the 2,990-node tree ({label})"), prep.mean / 1e3, "ms", "");

        // A form, then ui_get_values / ui_set_values.
        let form = json!({ "type": "form", "children": (0..30).map(|i| json!({ "type": "textfield", "props": { "name": format!("f{i}"), "label": format!("F{i}") } })).collect::<Vec<_>>() });
        exchange(port, &tool("ui_render", json!({ "tree": form, "id": "form" })));
        let gv = tool("ui_get_values", json!({ "id": "form" }));
        let g = bench(2, 50, || {
            std::hint::black_box(exchange(port, &gv));
        });
        report(A, &format!("ui_get_values round trip ({label})"), g.mean, "us", "");
        let sv = tool("ui_set_values", json!({ "id": "form", "values": { "f1": "agent" } }));
        let s = bench(2, 30, || {
            std::hint::black_box(exchange(port, &sv));
        });
        report(A, &format!("ui_set_values round trip ({label})"), s.mean / 1e3, "ms", "includes whole-transcript save");
        hub.flush();
        let _ = std::fs::remove_dir_all(dir);
    }
}
