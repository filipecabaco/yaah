//! Scratch-only benchmarks for GitHub / Linear / GitLab reads against the local stand-in.
#![allow(clippy::all, clippy::pedantic, dead_code, unused)]

use super::*;
use super::tests::{instance, mock};
use crate::perf_util::*;

const A: &str = "integrations";

#[test]
#[ignore]
fn perf_integrations() {
    let pr = json!({ "data": { "repository": { "pullRequest": { "number": 1, "title": "t", "body": prose(2000), "files": { "nodes": [] } } } } });
    let (base, seen) = mock(move |r| {
        if r.path.ends_with("/graphql") {
            (200, pr.clone())
        } else if r.path.contains("/api/v4/") {
            (200, json!({ "iid": 7, "title": "t" }))
        } else {
            (200, Value::String(prose(20_000)))
        }
    });
    let i = instance(&base, 0);
    i.put("github", json!({ "access_token": "gho_x" })).unwrap();
    i.put("linear", json!({ "access_token": "lin_x", "expires_at": 4_000_000_000u64 })).unwrap();
    i.put("gitlab", json!({ "access_token": "gl_x", "base_url": "https://gitlab.example.com" })).unwrap();
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();

    let t = bench(5, 200, || {
        std::hint::black_box(rt.block_on(i.github_graphql("query { x }", json!({}))).unwrap());
    });
    report(A, "github_graphql round trip (local stand-in, shared client)", t.mean, "us", "includes integrations.json read for the token");
    let t = bench(5, 200, || {
        std::hint::black_box(rt.block_on(i.github_get("/repos/o/r/pulls/1", "application/vnd.github.diff", true)).unwrap());
    });
    report(A, "github_get (diff, 20 KB) round trip", t.mean, "us", "");
    let t = bench(5, 200, || {
        std::hint::black_box(rt.block_on(i.gitlab_get("/projects/x/issues/7")).unwrap());
    });
    report(A, "gitlab_get round trip", t.mean, "us", "reads integrations.json twice (auth + base url)");
    let t = bench(5, 200, || {
        std::hint::black_box(rt.block_on(i.linear("query { x }", json!({}))).unwrap());
    });
    report(A, "linear graphql round trip", t.mean, "us", "");
    let tk = bench(10, 500, || {
        std::hint::black_box(i.token("github"));
    });
    report("disk", "integrations.json read per API request (token())", tk.mean, "us", "3 services stored");

    // A fresh client per request, for comparison (what reuse saves on loopback; TLS to the real APIs would add more).
    let t = bench(2, 50, || {
        rt.block_on(async {
            let c = reqwest::Client::builder().connect_timeout(Duration::from_secs(10)).user_agent("yaah").build().unwrap();
            let r = c.post(format!("{base}/api.github.com/graphql")).json(&json!({ "query": "q" })).send().await.unwrap();
            std::hint::black_box(r.bytes().await.unwrap());
        })
    });
    report(A, "graphql with a new reqwest::Client per request (alternative, not what yaah does)", t.mean, "us", "loopback, no TLS");

    // Duplicate polling: 5 live nodes showing the same PR, one poll round.
    let before = seen.lock().unwrap().len();
    rt.block_on(async {
        let q = "query { pr }";
        let _ = tokio::join!(
            i.github_graphql(q, json!({ "n": 1 })),
            i.github_graphql(q, json!({ "n": 1 })),
            i.github_graphql(q, json!({ "n": 1 })),
            i.github_graphql(q, json!({ "n": 1 })),
            i.github_graphql(q, json!({ "n": 1 }))
        );
    });
    let reqs = seen.lock().unwrap().len() - before;
    report(A, "requests sent for 5 identical concurrent reads", reqs as f64, "requests", "no in-flight dedup or short cache for GitHub/Linear/GitLab");
}
