//! Scratch-only benchmarks for startup steps and small config reads.
#![allow(clippy::all, clippy::pedantic, dead_code, unused)]

use super::*;
use crate::perf_util::*;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Instant;

#[test]
#[ignore]
fn perf_login_shell() {
    let shell = std::env::var_os("SHELL").unwrap();
    let mut v = vec![];
    for _ in 0..5 {
        let t = Instant::now();
        let p = login_shell_path(&shell, SHELL_TIMEOUT);
        v.push(us(t.elapsed()));
        assert!(p.is_some());
    }
    let s = stats(v);
    report("startup", &format!("adopt_login_shell ({} -ilc), mean of 5", shell.to_string_lossy()), s.mean / 1e3, "ms", "blocks run() before tauri::Builder; this machine's rc files");
    report("startup", "adopt_login_shell max", s.max / 1e3, "ms", "timeout is 5 s");
}

#[test]
#[ignore]
fn perf_startup_misc() {
    // Guide sync: component names (library.list()) + compare/write the skill and plugin files.
    let home = tmp("guide");
    let names: Vec<String> = (0..700).map(|i| format!("c-{i}")).collect();
    let n2 = names.clone();
    let g = Arc::new(crate::agent_guide::Guide::new(home.clone(), move || n2.clone(), || true));
    let t = Instant::now();
    g.sync().unwrap();
    report("startup", "Guide::sync first run (writes skills + plugin)", us(t.elapsed()) / 1e3, "ms", "background thread at startup");
    let s = bench(1, 10, || {
        g.sync().unwrap();
    });
    report("startup", "Guide::sync unchanged (reads + compares)", s.mean / 1e3, "ms", "also runs inside deliver() for every Claude session/new and session/load");

    // The real app library for the guide: deliver() for Claude runs component_names twice (text + sync).
    let root = tmp("guidelib");
    let lib = Arc::new(crate::ui_libraries::perf_bench::build(&root, 200, 500, 0));
    let l2 = lib.clone();
    let g = crate::agent_guide::Guide::new(home.clone(), move || crate::agent_guide::component_names(&l2), || true);
    let traits = crate::agent_guide::Traits { preset: "claude", ui: true, system_prompt: false };
    let d = bench(1, 10, || {
        let mut params = json!({ "cwd": "/x", "mcpServers": [] });
        std::hint::black_box(g.deliver(&traits, &mut params));
    });
    report("session", "guide.deliver() for a Claude session/new (723 components)", d.mean / 1e3, "ms", "component_names twice (text + plugin sync) + file compare");
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&home);

    // Config reads on hot paths.
    let dir = tmp("cfg");
    let agents_path = dir.join("agents.json");
    let store = crate::agents::Store::at(agents_path.clone());
    for i in 0..6 {
        let mut d = crate::agents::Draft { label: format!("Agent {i}"), preset: crate::agents::CUSTOM.into(), command_line: "/bin/echo".into(), ..Default::default() };
        d.env.insert("A".into(), "b".into());
        store.save(&d).unwrap();
    }
    let id = store.load().profiles[3].id.clone();
    let f = bench(5, 200, || {
        std::hint::black_box(store.find(&id));
    });
    report("disk", "agents::Store::find (agents.json read per prompt/new_session/auth)", f.mean, "us", &format!("{} B file, 6 profiles", std::fs::metadata(&agents_path).unwrap().len()));
    for (label, kb) in [("200 KB", 200usize), ("2 MB", 2000)] {
        let p = dir.join(format!("claude-{kb}.json"));
        let projects: serde_json::Map<String, Value> = (0..kb * 2).map(|i| (format!("/Users/x/p{i}"), json!({ "history": prose(400), "allowedTools": [] }))).collect();
        std::fs::write(&p, json!({ "mcpServers": { "a": { "command": "x" } }, "projects": projects }).to_string()).unwrap();
        let r = bench(2, 20, || {
            let raw = std::fs::read_to_string(&p).unwrap();
            std::hint::black_box(serde_json::from_str::<Value>(&raw).unwrap());
        });
        report("disk", &format!("~/.claude.json read+parse ({label}) per Claude session/new and session/load"), r.mean / 1e3, "ms", "mcp_servers::inject -> read_source (this machine's files: 178 KB and 206 KB)");
    }
    let jf = crate::json_file::JsonFile::new(dir.join("settings.json"), false);
    jf.update(|m: &mut serde_json::Map<String, Value>| {
        m.insert("teachAgents".into(), json!(true));
        m.insert("appearance".into(), json!("system"));
        Ok(())
    })
    .unwrap();
    let r = bench(5, 200, || {
        std::hint::black_box(jf.read::<serde_json::Map<String, Value>>());
    });
    report("disk", "settings.json read (teach_agents per session/new)", r.mean, "us", "");
    let w = bench(1, 20, || {
        jf.update(|m: &mut serde_json::Map<String, Value>| {
            m.insert("x".into(), json!(1));
            Ok(())
        })
        .unwrap();
    });
    report("disk", "JsonFile::update (write + fsync + rename)", w.mean / 1e3, "ms", "e.g. record_report on every agent start");
    let _ = std::fs::remove_dir_all(dir);
}
