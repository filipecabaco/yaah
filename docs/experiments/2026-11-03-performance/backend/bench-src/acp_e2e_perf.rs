//! Scratch-only: end-to-end throughput, agent spawn cost and npx resolution.
#![allow(clippy::all, clippy::pedantic, dead_code)]

use serde_json::{Value, json};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use yaah_lib::agents::{self, Draft, Store};
use yaah_lib::session::{ChatTarget, Emit, Hub, random_token};

fn report(area: &str, metric: &str, value: f64, unit: &str, note: &str) {
    let line = format!("{area}\t{metric}\t{value:.3}\t{unit}\t{note}");
    println!("RESULT\t{line}");
    if let Ok(path) = std::env::var("PERF_OUT") {
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(f, "{line}");
        }
    }
}

struct Counters {
    bytes: AtomicU64,
    events: AtomicU64,
    done: AtomicBool,
}

/// As Tauri does per emit: to_string + format! into a JS snippet. Notes when a turn ends.
fn emitter(c: Arc<Counters>) -> Emit {
    Arc::new(move |event: &str, payload: Value| {
        let s = serde_json::to_string(&payload).unwrap();
        let script = format!("(function () {{ const fn = window['x']; fn && fn({{event: '{event}', payload: {s}}}, [1]) }})()");
        c.bytes.fetch_add(script.len() as u64, Ordering::Relaxed);
        c.events.fetch_add(1, Ordering::Relaxed);
        if event == "session-info" && payload["running"] == false {
            c.done.store(true, Ordering::Relaxed);
        }
    })
}

fn setup() -> (PathBuf, Arc<Hub>, Arc<Counters>, String) {
    let dir = std::env::temp_dir().join(format!("yaah-perf-e2e-{}", random_token()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("agents.json"), r#"{ "profiles": [] }"#).unwrap();
    let profiles: &'static Store = Box::leak(Box::new(Store::at(dir.join("agents.json"))));
    let exe = std::env::current_exe().unwrap();
    let mut draft = Draft { label: "Scripted".into(), preset: agents::CUSTOM.into(), command_line: agents::join_args([exe.to_string_lossy()]), ..Draft::default() };
    draft.env.insert(super::agent::ENV.into(), "1".into());
    let id = profiles.save(&draft).unwrap().0.id;
    let c = Arc::new(Counters { bytes: AtomicU64::new(0), events: AtomicU64::new(0), done: AtomicBool::new(false) });
    let hub = Arc::new(Hub::open(emitter(c.clone()), Some(dir.join("sessions")), profiles));
    (dir, hub, c, id)
}

fn cpu_ms() -> u64 {
    let out = std::process::Command::new("ps").args(["-o", "time=", "-p", &std::process::id().to_string()]).output().unwrap();
    let t = String::from_utf8_lossy(&out.stdout).trim().to_owned(); // m:ss.cc
    let (m, s) = t.split_once(':').unwrap_or(("0", &t));
    (m.trim().parse::<f64>().unwrap_or(0.0) * 60_000.0 + s.trim().parse::<f64>().unwrap_or(0.0) * 1000.0) as u64
}

pub fn flood() {
    let (dir, hub, c, id) = setup();
    let sid = tauri::async_runtime::block_on(hub.new_session(ChatTarget::Folder(dir.to_string_lossy().into_owned()), &id)).unwrap().session_id;
    for (n, size, per, label) in [
        (5_000, 40, 50, "5,000 chunks x 40 chars, a new message every 50 chunks (2 KB messages)"),
        (5_000, 40, 5_000, "5,000 chunks x 40 chars into one 200 KB message"),
        (10_000, 40, 10_000, "10,000 chunks x 40 chars into one 400 KB message"),
    ] {
        c.done.store(false, Ordering::Relaxed);
        let (b0, e0, cpu0) = (c.bytes.load(Ordering::Relaxed), c.events.load(Ordering::Relaxed), cpu_ms());
        let t = Instant::now();
        tauri::async_runtime::block_on(hub.prompt(&sid, format!("flood {n} {size} {per}"), vec![])).unwrap();
        while !c.done.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_micros(200));
            assert!(t.elapsed() < Duration::from_secs(300));
        }
        let wall = t.elapsed();
        let cpu = cpu_ms() - cpu0;
        report("e2e", &format!("{label}: wall time"), wall.as_secs_f64() * 1e3, "ms", &format!("{:.0} chunks/s; yaah CPU {cpu} ms", n as f64 / wall.as_secs_f64()));
        report("e2e", &format!("{label}: IPC bytes"), (c.bytes.load(Ordering::Relaxed) - b0) as f64 / 1e6, "MB", &format!("{} events", c.events.load(Ordering::Relaxed) - e0));
    }
    hub.flush();
    drop(hub);
    let _ = std::fs::remove_dir_all(dir);
}

pub fn spawn() {
    let (dir, hub, _c, id) = setup();
    let folder = dir.to_string_lossy().into_owned();
    let mut cold = vec![];
    let mut warm = vec![];
    for _ in 0..5 {
        tauri::async_runtime::block_on(hub.drop_agent(&id));
        let t = Instant::now();
        tauri::async_runtime::block_on(hub.new_session(ChatTarget::Folder(folder.clone()), &id)).unwrap();
        cold.push(t.elapsed().as_secs_f64() * 1e3);
        let t = Instant::now();
        tauri::async_runtime::block_on(hub.new_session(ChatTarget::Folder(folder.clone()), &id)).unwrap();
        warm.push(t.elapsed().as_secs_f64() * 1e3);
    }
    let mean = |v: &[f64]| v.iter().sum::<f64>() / v.len() as f64;
    report("agents", "new chat, agent not running: spawn + initialize + session/new (scripted Rust agent)", mean(&cold), "ms", "includes record_report (agents.json write + fsync)");
    report("agents", "new chat, agent running: session/new only", mean(&warm), "ms", "");
    hub.flush();
    drop(hub);
    let _ = std::fs::remove_dir_all(dir);
}

/// The Claude adapter through `npx -y <pkg>@<version>` (what yaah runs) vs. `node <cached bin>`: time to the `initialize` answer.
pub fn npx() {
    yaah_lib::path_env::adopt_login_shell();
    let home = std::env::var("HOME").unwrap();
    let cfg = std::env::temp_dir().join(format!("yaah-perf-claude-{}", random_token()));
    std::fs::create_dir_all(&cfg).unwrap();
    let bin = std::fs::read_dir(format!("{home}/.npm/_npx"))
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|e| e.path().join("node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js"))
        .find(|p| p.exists());
    let run = |program: &str, args: Vec<String>| -> (f64, u64) {
        let mut cmd = yaah_lib::path_env::tokio_command(program);
        cmd.args(args).env("CLAUDE_CONFIG_DIR", &cfg).env_remove("ANTHROPIC_API_KEY");
        let t = Instant::now();
        let conn = tauri::async_runtime::block_on(async {
            let conn = yaah_lib::acp::Connection::spawn(cmd, |_, _| {}, |_| {}).unwrap();
            agents::initialize(&conn).await.unwrap();
            conn
        });
        let ms = t.elapsed().as_secs_f64() * 1e3;
        std::thread::sleep(Duration::from_secs(3));
        // RSS of the process tree under us (npx -> node) after it settles.
        let out = std::process::Command::new("ps").args(["-A", "-o", "pid=,ppid=,rss="]).output().unwrap();
        let rows: Vec<(u32, u32, u64)> = String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| {
                let v: Vec<&str> = l.split_whitespace().collect();
                Some((v.first()?.parse().ok()?, v.get(1)?.parse().ok()?, v.get(2)?.parse().ok()?))
            })
            .collect();
        let me = std::process::id();
        let mut tree = vec![me];
        let mut rss = 0;
        let mut changed = true;
        while changed {
            changed = false;
            for (pid, ppid, r) in &rows {
                if tree.contains(ppid) && !tree.contains(pid) {
                    tree.push(*pid);
                    rss += r;
                    changed = true;
                }
            }
        }
        drop(conn);
        (ms, rss / 1024)
    };
    for i in 0..3 {
        let (ms, rss) = run("npx", vec!["-y".into(), yaah_lib::session::ADAPTER_PACKAGE.into()]);
        report("agents", &format!("claude-agent-acp via npx -y, run {}: time to initialize answer", i + 1), ms, "ms", &format!("children RSS {rss} MB after 3 s"));
    }
    if let Some(bin) = bin {
        for i in 0..3 {
            let (ms, rss) = run("node", vec![bin.to_string_lossy().into_owned()]);
            report("agents", &format!("claude-agent-acp via node <cached dist/index.js>, run {}: time to initialize answer", i + 1), ms, "ms", &format!("children RSS {rss} MB after 3 s"));
        }
    }
    let _ = std::fs::remove_dir_all(cfg);
}
