//! Scratch-only benchmarks for live sources: system, Docker, Postgres.
#![allow(clippy::all, clippy::pedantic, dead_code, unused)]

use super::*;
use crate::perf_util::*;

const A: &str = "sources";

fn cpu_ms() -> u64 {
    let pid = sysinfo::Pid::from_u32(std::process::id());
    let mut s = System::new();
    s.refresh_processes_specifics(ProcessesToUpdate::Some(&[pid]), true, ProcessRefreshKind::nothing().with_cpu());
    s.process(pid).map(|p| p.accumulated_cpu_time()).unwrap_or(0)
}

#[test]
#[ignore]
fn perf_system() {
    let n = bench(0, 3, || {
        std::hint::black_box(Sources::new());
    });
    report("startup", "Sources::new() (first sysinfo process scan)", n.mean / 1e3, "ms", "in setup, before the window shows");
    let s = Sources::new();
    let force = || {
        let mut st = s.system.lock().unwrap();
        st.refreshed = Instant::now() - Duration::from_secs(2);
        st.last = None;
        let t = Instant::now();
        std::hint::black_box(snapshot(&mut st));
        t.elapsed()
    };
    force();
    let mut v = vec![];
    for _ in 0..15 {
        v.push(us(force()));
    }
    let st = stats(v);
    let procs = s.system.lock().unwrap().sys.processes().len();
    report(A, "system: one refresh (snapshot past FRESH)", st.mean / 1e3, "ms", &format!("{procs} processes on this machine; all refreshed with cpu+memory, disks too"));
    report(A, "system: one refresh p99", st.p99 / 1e3, "ms", "");
    let cached = bench(5, 1000, || {
        std::hint::black_box(snapshot(&mut s.system.lock().unwrap()));
    });
    report(A, "system: cached read within FRESH (1 s)", cached.mean, "us", "Value clone");

    // Live nodes polling `system` every 2 s, mounted at different moments (offsets spread over the interval).
    for nodes in [1usize, 4, 8] {
        let s = Arc::new(Sources::new());
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let c0 = cpu_ms();
        let window = Duration::from_secs(20);
        rt.block_on(async {
            let mut tasks = vec![];
            for k in 0..nodes {
                let (s, reads) = (s.clone(), reads.clone());
                tasks.push(tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis((2000 * k / nodes) as u64)).await;
                    let end = Instant::now() + window;
                    while Instant::now() < end {
                        s.read(&json!({ "kind": "system" })).await.unwrap();
                        reads.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        tokio::time::sleep(Duration::from_secs(2)).await;
                    }
                }));
            }
            for t in tasks {
                t.await.unwrap();
            }
        });
        let cpu = cpu_ms() - c0;
        let secs = window.as_secs_f64() + 2.0;
        report(A, &format!("system polled every 2 s by {nodes} live node(s): CPU"), cpu as f64 / secs / 10.0, "% of a core", &format!("{cpu} ms CPU over {secs:.0} s, {} reads", reads.load(std::sync::atomic::Ordering::Relaxed)));
    }
}

#[test]
#[ignore]
fn perf_docker() {
    let s = Sources::new();
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    for (label, src) in [
        ("docker.containers (docker ps -a)", json!({ "kind": "docker.containers" })),
        ("docker.stats (all, --no-stream)", json!({ "kind": "docker.stats" })),
        ("docker.logs --tail 200", json!({ "kind": "docker.logs", "container": "yaah-pg-demo", "tail": 200 })),
    ] {
        let mut v = vec![];
        for _ in 0..4 {
            std::thread::sleep(Duration::from_millis(1100));
            let t = Instant::now();
            let r = rt.block_on(s.read(&src));
            v.push(us(t.elapsed()));
            if let Err(e) = r {
                eprintln!("{label}: {e}");
            }
        }
        let st = stats(v);
        report(A, label, st.mean / 1e3, "ms", "a docker CLI process per read (shared for 1 s between identical reads)");
    }
    // 4 live nodes asking for the same stats at once: one docker call.
    std::thread::sleep(Duration::from_millis(1100));
    let t = Instant::now();
    rt.block_on(async {
        let src = json!({ "kind": "docker.stats" });
        let _ = tokio::join!(s.read(&src), s.read(&src), s.read(&src), s.read(&src));
    });
    report(A, "docker.stats x4 concurrent identical reads", us(t.elapsed()) / 1e3, "ms", "docker_shared: one CLI run serves all four");
}

async fn futures_join<F: std::future::Future>(fs: impl Iterator<Item = F>) {
    let mut set = vec![];
    for f in fs {
        set.push(f);
    }
    for f in set {
        let _ = f.await; // sequential await of futures created up front; first one runs, rest wait on the slot
    }
}

fn demo() -> Connection {
    Connection { name: "shop".into(), url: "postgres://yaah_ro:yaahro@127.0.0.1:54329/shop".into() }
}

#[test]
#[ignore]
fn perf_postgres() {
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    let c = demo();
    if let Err(e) = rt.block_on(postgres_query(&c, "select 1", 1)) {
        eprintln!("skipped: {e}");
        return;
    }
    let mut v = vec![];
    for _ in 0..20 {
        let t = Instant::now();
        let client = rt.block_on(open(&c)).unwrap();
        v.push(us(t.elapsed()));
        drop(client);
    }
    report(A, "postgres: open() a connection", stats(v).mean / 1e3, "ms", "TCP + startup + auth (sslmode prefer), per query");
    let client = rt.block_on(open(&c)).unwrap();
    let r = bench(2, 20, || rt.block_on(check_role(&client)).unwrap());
    report(A, "postgres: check_role()", r.mean / 1e3, "ms", "once per 60 s per URL (trusted_roles)");
    let q = "select * from pg_class limit 50";
    let full = bench(2, 30, || {
        std::hint::black_box(rt.block_on(postgres_query(&c, q, 1000)).unwrap());
    });
    report(A, "postgres.query end to end (role cached)", full.mean / 1e3, "ms", "connect + begin + prepare + wrapped query, new connection each time");
    // The same statements on one reused connection.
    let reused = bench(2, 30, || {
        rt.block_on(async {
            client.batch_execute(&format!("begin read only; set local statement_timeout = {QUERY_TIMEOUT_MS};")).await.unwrap();
            let _ = client.prepare(q).await.unwrap();
            let wrapped = format!("select coalesce(json_agg(t), '[]'::json)::text from (select * from (\n{q}\n) q limit 1001) t");
            let row = client.query_one(&wrapped, &[]).await.unwrap();
            std::hint::black_box(serde_json::from_str::<Value>(row.get::<_, &str>(0)).unwrap());
            client.batch_execute("rollback").await.unwrap();
        })
    });
    report(A, "postgres.query on a reused connection (alternative)", reused.mean / 1e3, "ms", "same statements, no connect");
    let sch = bench(1, 10, || {
        std::hint::black_box(rt.block_on(postgres_schema(c.clone())).unwrap());
    });
    report(A, "postgres.schema end to end", sch.mean / 1e3, "ms", "");
    // connections.json is read on every postgres read.
    let dir = tmp("conn");
    let s = Sources::with_connections_file(dir.join("connections.json"));
    s.connections.update(|f: &mut ConnectionFile| {
        for i in 0..5 {
            f.connections.push(Connection { name: format!("db{i}"), url: format!("postgres://u:p@h:5432/db{i}") });
        }
        Ok(())
    }).unwrap();
    let cr = bench(5, 200, || {
        std::hint::black_box(s.connection(&json!("db3")).unwrap());
    });
    report("disk", "connections.json read per postgres read", cr.mean, "us", "JsonFile::read: open + read + parse, 5 connections");
    let _ = std::fs::remove_dir_all(dir);
}
