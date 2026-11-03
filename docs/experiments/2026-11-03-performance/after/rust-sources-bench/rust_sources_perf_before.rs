//! Before/after measurements for REVIEW 9.3, 9.7, 9.9 and 9.11. Copy to
//! `app/src-tauri/src/perf_bench.rs`, add `#[cfg(test)] mod perf_bench;` to lib.rs, and run
//!
//!     PERF_OUT=<file.tsv> cargo test --release --lib perf_bench -- --ignored --nocapture --test-threads=1
//!
//! Real things used: this machine's login shell, the local Docker daemon, the
//! `yaah-pg-demo` container (`yaah_ro`, db `shop`) and the integrations stand-in.
//! Results go to `docs/experiments/2026-11-03-performance/after/rust-sources.md`.
#![allow(clippy::pedantic, clippy::all, reason = "measurement code")]

use crate::integrations::tests::{instance, mock};
use crate::ui_libraries::{MANIFEST, Store};
use crate::ui_library::{Bundled, Library, LocalDir};
use serde_json::{Value, json};
use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

fn report(area: &str, metric: &str, value: f64, unit: &str) {
    let line = format!("{area}\t{metric}\t{value:.3}\t{unit}");
    println!("RESULT\t{line}");
    if let Ok(path) = std::env::var("PERF_OUT")
        && let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path)
    {
        let _ = writeln!(f, "{line}");
    }
}

/// Mean µs of `iters` calls after `warm` warm-ups.
fn mean_us(warm: usize, iters: usize, mut f: impl FnMut()) -> f64 {
    for _ in 0..warm {
        f();
    }
    let t = Instant::now();
    for _ in 0..iters {
        f();
    }
    t.elapsed().as_secs_f64() * 1e6 / iters as f64
}

fn tmp(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("yaah-perf-{tag}-{}", crate::random::token()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn component_json(name: &str, inner: Option<&str>) -> Value {
    let mut kids: Vec<Value> =
        (0..10).map(|i| json!({ "type": if i % 2 == 0 { "text" } else { "badge" }, "props": { "text": format!("{{{{label}}}} {i}") } })).collect();
    if let Some(inner) = inner {
        kids.push(json!({ "type": inner, "props": { "label": "{{label}}" } }));
    }
    json!({
        "name": name, "version": 1,
        "description": format!("The {name} component: a label with ten rows of text and badges, for performance measurements of the library."),
        "props": { "type": "object", "properties": { "label": { "type": "string" } }, "required": ["label"] },
        "tree": { "type": "card", "props": { "title": "{{label}}" }, "children": [{ "type": "stack", "children": kids }] },
        "examples": [{ "title": "one", "props": { "label": "hi" } }]
    })
}

/// yaah's own, 200 local components and a 500-component folder library (723 in all).
fn library(root: &Path) -> Library {
    let comps = root.join("components");
    for i in 0..200 {
        let name = format!("loc-{i}");
        let inner = (i % 4 == 3).then(|| format!("loc-{}", i - 1));
        std::fs::create_dir_all(comps.join(&name)).unwrap();
        std::fs::write(comps.join(&name).join("component.json"), component_json(&name, inner.as_deref()).to_string()).unwrap();
    }
    let dir = root.join("folder-lib");
    std::fs::create_dir_all(dir.join("components")).unwrap();
    std::fs::write(dir.join(MANIFEST), json!({ "name": "acme", "title": "acme components", "description": "Perf", "version": "1.0.0" }).to_string())
        .unwrap();
    for i in 0..500 {
        let inner = (i % 4 == 3).then(|| format!("acme/c-{}", i - 1));
        std::fs::write(dir.join("components").join(format!("c-{i}.json")), component_json(&format!("c-{i}"), inner.as_deref()).to_string()).unwrap();
    }
    let records = json!([{ "id": "acme", "source": { "kind": "folder", "path": dir }, "enabled": true, "installedAt": 0, "updatedAt": 0 }]);
    std::fs::create_dir_all(root.join("config")).unwrap();
    std::fs::write(root.join("config/libraries.json"), records.to_string()).unwrap();
    let lib = Library::new(
        vec![Box::new(Bundled::new()), Box::new(LocalDir::new(comps))],
        Some(Store::at(root.join("config/libraries.json"), root.join("libraries"))),
    );
    lib.reload();
    lib
}

#[test]
#[ignore = "measurement"]
fn perf_bench_startup() {
    let t = Instant::now();
    crate::path_env::adopt_login_shell();
    report("startup", "run() blocked on the login-shell PATH", t.elapsed().as_secs_f64() * 1e3, "ms");
    let t = Instant::now();
    let _ = crate::path_env::path();
    report("startup", "path() after that", t.elapsed().as_secs_f64() * 1e3, "ms");
    let root = tmp("startup-lib");
    let lib = library(&root);
    let t = Instant::now();
    lib.reload();
    report("startup", "Library load in setup (723 components): time on the setup thread", t.elapsed().as_secs_f64() * 1e3, "ms");
    let t = Instant::now();
    let _ = crate::sources::Sources::new();
    report("startup", "Sources::new in setup", t.elapsed().as_secs_f64() * 1e3, "ms");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
#[ignore = "measurement"]
fn perf_bench_library() {
    let root = tmp("lib");
    let lib = Arc::new(library(&root));
    let names = || crate::agent_guide::component_names(&lib);
    report("library", "ui_catalog JSON (723 components)", mean_us(2, 20, || drop(lib.catalog().unwrap().to_string())) / 1e3, "ms");
    report("library", "component_names (guide index)", mean_us(2, 20, || drop(names())) / 1e3, "ms");
    report(
        "library",
        "ui_guide text (yaah-ui skill)",
        mean_us(2, 20, || drop(crate::agent_guide::skill_text(crate::agent_guide::skill("ui").unwrap(), &names()))) / 1e3,
        "ms",
    );
    report(
        "library",
        "prepare a local component",
        mean_us(2, 50, || drop(lib.prepare(Some("loc-3"), json!({ "label": "x" }), None).unwrap())) / 1e3,
        "ms",
    );
    let tree = json!({ "type": "stack", "children": (0..200).map(|i| json!({ "type": format!("loc-{}", i % 200), "props": { "label": "x" } })).collect::<Vec<_>>() });
    report("library", "validate a tree with 200 local refs", mean_us(1, 10, || drop(lib.prepare(None, json!({}), Some(tree.clone())))) / 1e3, "ms");
    let home = tmp("guide");
    let l2 = lib.clone();
    let guide = crate::agent_guide::Guide::new(home.clone(), move || crate::agent_guide::component_names(&l2), || true);
    let traits = crate::agent_guide::Traits { preset: "claude", ui: true, system_prompt: false };
    report(
        "library",
        "guide.deliver() for a Claude session/new",
        mean_us(2, 20, || {
            let mut p = json!({ "cwd": "/x" });
            drop(guide.deliver(&traits, &mut p));
        }) / 1e3,
        "ms",
    );
    let _ = std::fs::remove_dir_all(root);
    let _ = std::fs::remove_dir_all(home);
}

/// Four live nodes polling `docker.stats` every 2 s, started 0.5 s apart, for 12 s:
/// how many `docker stats` processes that runs. Run with a logging `docker`
/// wrapper first on PATH and `DOCKER_LOG` naming its log.
#[test]
#[ignore = "measurement"]
fn perf_bench_docker_stats() {
    let log = std::env::var("DOCKER_LOG").ok();
    if let Some(log) = &log {
        let _ = std::fs::remove_file(log);
    }
    let sources = Arc::new(crate::sources::Sources::new());
    let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let start = Instant::now();
    let pollers: Vec<_> = (0..4)
        .map(|n| {
            let (sources, reads) = (sources.clone(), reads.clone());
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(500 * n));
                while start.elapsed() < Duration::from_secs(12) {
                    let t = Instant::now();
                    let _ = tauri::async_runtime::block_on(sources.read(&json!({ "kind": "docker.stats" })));
                    reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    std::thread::sleep(Duration::from_secs(2).saturating_sub(t.elapsed()));
                }
            })
        })
        .collect();
    for p in pollers {
        p.join().unwrap();
    }
    report("sources", "docker.stats: reads by 4 pollers in 12 s", reads.load(std::sync::atomic::Ordering::SeqCst) as f64, "reads");
    if let Some(log) = log {
        let runs = std::fs::read_to_string(log).unwrap_or_default().lines().filter(|l| *l == "stats").count();
        report("sources", "docker.stats: `docker stats` processes run for those reads", runs as f64, "runs");
    }
}

#[test]
#[ignore = "measurement"]
fn perf_bench_postgres() {
    let dir = tmp("pg");
    std::fs::write(
        dir.join("connections.json"),
        json!({ "connections": [{ "name": "shop", "url": "postgres://yaah_ro:yaahro@127.0.0.1:54329/shop" }] }).to_string(),
    )
    .unwrap();
    let sources = crate::sources::Sources::with_connections_file(dir.join("connections.json"));
    let q = json!({ "kind": "postgres.query", "connection": "shop", "sql": "select * from pg_class limit 50" });
    if let Err(e) = tauri::async_runtime::block_on(sources.read(&q)) {
        eprintln!("skipped: {e}");
        return;
    }
    report("sources", "postgres.query end to end", mean_us(3, 50, || drop(tauri::async_runtime::block_on(sources.read(&q)).unwrap())) / 1e3, "ms");
    let _ = std::fs::remove_dir_all(dir);
}

/// Five identical GitHub issue reads at once, then one a second later: HTTP requests made.
#[test]
#[ignore = "measurement"]
fn perf_bench_api_sources() {
    let (base, seen) = mock(|r| match r.path.as_str() {
        "/api.github.com/repos/o/r/issues/1" => {
            std::thread::sleep(Duration::from_millis(30));
            (200, json!({ "number": 1, "title": "t", "state": "open", "html_url": "u", "comments": 0, "user": { "login": "ada" }, "labels": [] }))
        }
        _ => (200, json!([])),
    });
    let i = instance(&base, 0);
    i.put("github", json!({ "api_key": "ghp_x" })).unwrap();
    let src = json!({ "kind": "github.issue", "repo": "o/r", "number": 1 });
    let read = || crate::work_items::source_with(i, "github.issue", &src);
    tauri::async_runtime::block_on(async {
        let reads: Vec<_> = (0..5).map(|_| read()).collect();
        for r in futures_join(reads).await {
            r.unwrap();
        }
    });
    let concurrent = seen.lock().unwrap().iter().filter(|l| l.starts_with("/api.github.com/repos/o/r/issues/1?")).count();
    report("sources", "5 identical concurrent github.issue reads: HTTP requests", concurrent as f64, "requests");
    std::thread::sleep(Duration::from_secs(1));
    tauri::async_runtime::block_on(read()).unwrap();
    let all = seen.lock().unwrap().iter().filter(|l| l.starts_with("/api.github.com/repos/o/r/issues/1?")).count();
    report("sources", "a 6th read 1 s later: HTTP requests in all", all as f64, "requests");
    report(
        "disk",
        "integrations token read (connected())",
        mean_us(10, 2000, || {
            std::hint::black_box(i.connected("github"));
        }),
        "us",
    );
}

async fn futures_join<F: std::future::Future>(fs: Vec<F>) -> Vec<F::Output> {
    let mut handles = vec![];
    for f in fs {
        handles.push(Box::pin(f));
    }
    let mut out = vec![];
    // Polled together on one task: same as several live nodes asking at once.
    let mut pending: Vec<_> = handles.into_iter().map(Some).collect();
    let mut results: Vec<Option<F::Output>> = (0..pending.len()).map(|_| None).collect();
    std::future::poll_fn(|cx| {
        let mut done = true;
        for (k, slot) in pending.iter_mut().enumerate() {
            if let Some(f) = slot {
                match f.as_mut().poll(cx) {
                    std::task::Poll::Ready(v) => {
                        results[k] = Some(v);
                        *slot = None;
                    }
                    std::task::Poll::Pending => done = false,
                }
            }
        }
        if done { std::task::Poll::Ready(()) } else { std::task::Poll::Pending }
    })
    .await;
    out.extend(results.into_iter().map(Option::unwrap));
    out
}

#[test]
#[ignore = "measurement"]
fn perf_bench_config_reads() {
    let dir = tmp("cfg");
    let profiles: Vec<Value> = (0..6)
        .map(|i| json!({ "id": format!("p{i}"), "label": format!("P{i}"), "preset": "custom", "command": "npx", "args": ["-y", "agent"], "env": {} }))
        .collect();
    std::fs::write(dir.join("agents.json"), json!({ "profiles": profiles, "default": "p0" }).to_string()).unwrap();
    let store = crate::agents::Store::at(dir.join("agents.json"));
    report("disk", "agents.json Store::find", mean_us(10, 2000, || drop(store.find("p3"))), "us");
    for (label, n) in [("200 KB", 200), ("2 MB", 2000)] {
        let projects: serde_json::Map<String, Value> =
            (0..n).map(|i| (format!("/Users/x/p{i}"), json!({ "history": [{ "display": "x".repeat(900) }], "mcpServers": {} }))).collect();
        let path = dir.join(format!("claude-{n}.json"));
        std::fs::write(&path, json!({ "projects": projects, "mcpServers": { "s": { "type": "http", "url": "https://x.example/mcp" } } }).to_string())
            .unwrap();
        report("disk", &format!("~/.claude.json read ({label})"), mean_us(3, 30, || drop(crate::mcp_servers::read_source(&path))) / 1e3, "ms");
    }
    let _ = std::fs::remove_dir_all(dir);
}
