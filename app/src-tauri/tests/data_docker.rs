//! `docker.*` sources against the real docker CLI. Skipped when docker isn't
//! installed or its daemon isn't running.

use serde_json::{Value, json};
use yaah_lib::sources::Sources;

fn docker_up() -> bool {
    let up = std::process::Command::new("docker")
        .arg("info")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    if !up {
        eprintln!("skipped: docker isn't running");
    }
    up
}

fn sources() -> Sources {
    let dir = std::env::temp_dir().join(format!("yaah-data-docker-{}", yaah_lib::session::random_token()));
    Sources::with_connections_file(dir.join("connections.json"))
}

#[tokio::test]
async fn lists_containers_stats_and_logs() {
    if !docker_up() {
        return;
    }
    let s = sources();
    let containers = s.read(&json!({ "kind": "docker.containers" })).await.unwrap();
    let all = containers.as_array().unwrap();
    for c in all {
        assert!(c["id"].is_string() && c["name"].is_string() && c["state"].is_string(), "{c}");
    }
    let Some(running) = all.iter().find(|c| c["state"] == "running").and_then(|c| c["name"].as_str()) else {
        eprintln!("no running container: stats and logs not checked");
        return;
    };
    let stats = s.read(&json!({ "kind": "docker.stats", "container": running })).await.unwrap();
    assert_eq!(stats.as_array().map(Vec::len), Some(1));
    assert_eq!(stats[0]["name"], running);
    assert!(stats[0]["cpu"].is_number() && stats[0]["memPct"].is_number(), "{stats}");

    let logs = s.read(&json!({ "kind": "docker.logs", "container": running, "tail": 3 })).await.unwrap();
    assert_eq!(logs["container"], running);
    assert!(logs["lines"].as_u64().unwrap() <= 6, "the tail of stdout and stderr: {logs}");

    // Several live views asking at once share one docker run, and see the same answer.
    let list = json!({ "kind": "docker.containers" });
    let (a, b) = tokio::join!(s.read(&list), s.read(&list));
    assert_eq!(a.unwrap(), b.unwrap());
}

async fn logs(s: &Sources, container: &str) -> Result<Value, String> {
    s.read(&json!({ "kind": "docker.logs", "container": container })).await
}

#[tokio::test]
async fn names_are_checked_before_docker_runs_and_its_errors_come_back() {
    let s = sources();
    for bad in ["--follow", "-a", "x y", "x;id", "../x", "$(id)"] {
        assert!(logs(&s, bad).await.unwrap_err().contains("isn't a container name"), "{bad}");
    }
    if !docker_up() {
        return;
    }
    let e = logs(&s, "yaah-no-such-container").await.unwrap_err();
    assert!(e.starts_with("docker logs:") && e.contains("yaah-no-such-container"), "{e}");
    let v: Value = s.read(&json!({ "kind": "docker.stats" })).await.unwrap();
    assert!(v.is_array());
}
