//! Sources: data the app reads itself, so agent-built UI can show (and keep
//! refreshing) real data without it passing through the agent's output.
//!
//! A source is a small JSON description, e.g. `{ "kind": "system" }` or
//! `{ "kind": "postgres.query", "connection": "demo", "sql": "select …" }`.
//! The `live` UI primitive reads one on an interval; the agent can read one
//! with the `source_read` tool to see the data before designing UI.
//!
//! Database credentials live only in the app (`~/.config/yaah/connections.json`,
//! mode 0600). Agents and UI refer to a connection by name, never by URL.

use crate::accounts::home;
use crate::json_file::JsonFile;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};
use sysinfo::{DiskRefreshKind, Disks, ProcessRefreshKind, ProcessesToUpdate, System};

const DOCKER_TIMEOUT: Duration = Duration::from_secs(10);
/// Live views polling the same thing within this share one reading.
const FRESH: Duration = Duration::from_secs(1);
/// Diffs past this are cut, with a note: the full one is a click away on GitHub.
const MAX_DIFF_BYTES: usize = 600_000;
const QUERY_TIMEOUT_MS: u32 = 15_000;
const DEFAULT_ROW_LIMIT: u64 = 1_000;
const MAX_ROW_LIMIT: u64 = 10_000;
const GIB: f64 = 1024.0 * 1024.0 * 1024.0;

/// A reading shared by concurrent callers: the first runs it, the rest wait and reuse it.
type Shared = Arc<tokio::sync::Mutex<Option<(Instant, Result<String, String>)>>>;

pub struct Sources {
    system: Arc<Mutex<SystemState>>,
    /// Recent docker answers, by command line.
    docker: Mutex<HashMap<String, Shared>>,
    connections: Arc<JsonFile>,
}

struct SystemState {
    sys: System,
    disks: Disks,
    refreshed: Instant,
    last: Option<Value>,
}

impl Default for Sources {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Connection {
    pub name: String,
    pub url: String,
}

/// A connection as shown to the UI and agents: no credentials.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub name: String,
    pub kind: &'static str,
    /// host:port/database, without user or password.
    pub target: String,
}

#[derive(Default, Serialize, Deserialize)]
struct ConnectionFile {
    connections: Vec<Connection>,
}

impl Sources {
    pub fn new() -> Self {
        Self::with_store(user_connections())
    }

    /// Sources whose database connections are kept in `path` rather than
    /// `~/.config/yaah/connections.json`.
    pub fn with_connections_file(path: PathBuf) -> Self {
        Self::with_store(Arc::new(JsonFile::new(path, true)))
    }

    fn with_store(connections: Arc<JsonFile>) -> Self {
        let mut sys = System::new();
        // CPU usage is a delta between two refreshes; take the first one now.
        sys.refresh_cpu_usage();
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_cpu());
        let state = SystemState { sys, disks: Disks::new(), refreshed: Instant::now(), last: None };
        Self { system: Arc::new(Mutex::new(state)), docker: Mutex::default(), connections }
    }

    /// Read a source. Errors are written for the agent or user to act on.
    pub async fn read(&self, source: &Value) -> Result<Value, String> {
        let kind = source["kind"].as_str().ok_or("a source needs a `kind`")?;
        match kind {
            "system" => {
                // Refreshing reads every process: off the async threads.
                let state = self.system.clone();
                tokio::task::spawn_blocking(move || snapshot(&mut state.lock().unwrap_or_else(PoisonError::into_inner)))
                    .await
                    .map_err(|e| format!("system: {e}"))
            }
            "docker.containers" => self.docker_containers().await,
            "docker.stats" => self.docker_stats(source["container"].as_str()).await,
            "docker.logs" => {
                let container = source["container"].as_str().ok_or("docker.logs needs `container`")?;
                self.docker_logs(container, source["tail"].as_u64().unwrap_or(200).min(5_000)).await
            }
            "github.pr" => github_pr(repo(&source["repo"])?, pr_number(&source["number"])?).await,
            "github.pr.diff" => github_pr_diff(repo(&source["repo"])?, pr_number(&source["number"])?).await,
            "github.prs" => {
                let state = source["state"].as_str().unwrap_or("open");
                github_prs(repo(&source["repo"])?, state, source["limit"].as_u64().unwrap_or(30).min(100)).await
            }
            "linear.issue" | "linear.issues" | "linear.board" | "linear.cycle" => crate::integrations::linear(kind, source).await,
            "github.issue" | "github.issues" | "gitlab.issue" | "gitlab.issues" | "linear.project" => crate::work_items::source(kind, source).await,
            "postgres.schema" => postgres_schema(self.connection(&source["connection"])?).await,
            "postgres.query" => {
                let sql = source["sql"].as_str().ok_or("postgres.query needs `sql`")?;
                let limit = source["limit"].as_u64().unwrap_or(DEFAULT_ROW_LIMIT).min(MAX_ROW_LIMIT);
                postgres_query(&self.connection(&source["connection"])?, sql, limit).await
            }
            other => Err(format!(
                "unknown source kind `{other}`; known: system, docker.containers, docker.stats, docker.logs, github.pr, github.pr.diff, github.prs, github.issue, github.issues, gitlab.issue, gitlab.issues, linear.issue, linear.issues, linear.project, linear.board, linear.cycle, postgres.schema, postgres.query"
            )),
        }
    }

    /// The saved database connections, without credentials.
    pub fn connections(&self) -> Vec<ConnectionInfo> {
        infos(&self.connections)
    }

    /// Test a connection, then save it (replacing one with the same name).
    pub async fn add_connection(&self, name: &str, url: &str) -> Result<ConnectionInfo, String> {
        add(&self.connections, name, url).await
    }

    fn connection(&self, name: &Value) -> Result<Connection, String> {
        let name = name.as_str().ok_or("needs `connection` (a connection name)")?;
        let all = self.connections.read::<ConnectionFile>().connections;
        let known: Vec<&str> = all.iter().map(|c| c.name.as_str()).collect();
        let missing = format!("no connection named `{name}` (known: {known:?}); the user adds them in yaah");
        all.iter().find(|c| c.name == name).cloned().ok_or(missing)
    }
}

// ── this machine ────────────────────────────────────────────────────────────

fn round(v: f64, places: i32) -> f64 {
    let f = 10f64.powi(places);
    (v * f).round() / f
}

#[allow(clippy::cast_precision_loss, reason = "byte counts are shown rounded to 0.01 GB")]
fn gib(bytes: u64) -> f64 {
    bytes as f64 / GIB
}

fn percent(part: u64, whole: u64) -> f64 {
    round(gib(part) / gib(whole.max(1)) * 100.0, 1)
}

/// CPU, memory, disks and the busiest processes. A reading less than [`FRESH`]
/// old is reused: usage is a delta between refreshes, and refreshing reads every process.
fn snapshot(state: &mut SystemState) -> Value {
    if let Some(v) = &state.last
        && state.refreshed.elapsed() < FRESH
    {
        return v.clone();
    }
    // Usage is a delta between refreshes: one too soon after the first reads 0.
    let wait = sysinfo::MINIMUM_CPU_UPDATE_INTERVAL.saturating_sub(state.refreshed.elapsed());
    if !wait.is_zero() {
        std::thread::sleep(wait);
    }
    state.refreshed = Instant::now();
    let SystemState { sys, disks, .. } = state;
    sys.refresh_cpu_usage();
    sys.refresh_memory();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_cpu().with_memory());
    disks.refresh_specifics(true, DiskRefreshKind::nothing().with_storage());
    let mut processes: Vec<_> = sys.processes().values().collect();
    processes.sort_by(|a, b| b.cpu_usage().total_cmp(&a.cpu_usage()));
    let top: Vec<Value> = processes
        .iter()
        .take(8)
        .map(|p| {
            json!({
                "pid": p.pid().as_u32(),
                "name": p.name().to_string_lossy(),
                "cpu": round(f64::from(p.cpu_usage()), 1),
                "memGb": round(gib(p.memory()), 2),
            })
        })
        .collect();
    // APFS shows one container as several mounts (/ and /System/Volumes/Data): keep the first.
    let mut seen = std::collections::HashSet::new();
    let disks: Vec<Value> = disks
        .iter()
        .filter(|d| d.total_space() > 0)
        // macOS system volumes under /System/Volumes share the main disk.
        .filter(|d| !d.mount_point().starts_with("/System/Volumes"))
        .filter(|d| seen.insert((d.total_space(), d.available_space())))
        .map(|d| {
            let used = d.total_space().saturating_sub(d.available_space());
            json!({
                "mount": d.mount_point().to_string_lossy(),
                "totalGb": round(gib(d.total_space()), 1),
                "usedGb": round(gib(used), 1),
                "pct": percent(used, d.total_space()),
            })
        })
        .collect();
    let load = System::load_average();
    let v = json!({
        "host": System::host_name().unwrap_or_default(),
        "uptimeSecs": System::uptime(),
        "cpu": round(f64::from(sys.global_cpu_usage()), 1),
        "cores": sys.cpus().iter().map(|c| round(f64::from(c.cpu_usage()), 1)).collect::<Vec<_>>(),
        "memUsedGb": round(gib(sys.used_memory()), 2),
        "memTotalGb": round(gib(sys.total_memory()), 2),
        "memPct": percent(sys.used_memory(), sys.total_memory()),
        "swapUsedGb": round(gib(sys.used_swap()), 2),
        "load1": round(load.one, 2),
        "load5": round(load.five, 2),
        "load15": round(load.fifteen, 2),
        "disks": disks,
        "processes": top,
    });
    state.last = Some(v.clone());
    v
}

// ── Docker (via the docker CLI: no daemon socket handling here) ─────────────

async fn docker(args: &[&str]) -> Result<String, String> {
    let out =
        tokio::time::timeout(DOCKER_TIMEOUT, crate::path_env::tokio_command("docker").args(args).stdin(Stdio::null()).kill_on_drop(true).output())
            .await
            .map_err(|_| "docker didn't answer within 10s".to_owned())?
            .map_err(|e| format!("couldn't run docker: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("docker {}: {}", args[0], err.trim()));
    }
    // `docker logs` writes the container's stderr to ours; keep both. Their
    // order of arrival is lost anyway, so stdout then stderr.
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    if args[0] == "logs" {
        text.push_str(&String::from_utf8_lossy(&out.stderr));
    }
    Ok(text)
}

fn json_lines(text: &str) -> Vec<Value> {
    text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

/// "12.5%" → 12.5
fn pct(v: &Value) -> Value {
    v.as_str().and_then(|s| s.trim_end_matches('%').parse::<f64>().ok()).map_or(Value::Null, |n| json!(n))
}

/// Container names and ids only (Docker's own rule): they go on a command line,
/// after `--`, and can't start with a dash.
fn valid_container(c: &str) -> Result<(), String> {
    let ok = c.len() <= 128
        && c.starts_with(|ch: char| ch.is_ascii_alphanumeric())
        && c.chars().all(|ch| ch.is_ascii_alphanumeric() || "_.-".contains(ch));
    if ok { Ok(()) } else { Err(format!("`{c}` isn't a container name")) }
}

impl Sources {
    /// `docker <args>`, shared with any caller asking the same within [`FRESH`]
    /// (`docker stats` alone takes a couple of seconds).
    async fn docker_shared(&self, args: &[&str]) -> Result<String, String> {
        let slot = self.docker.lock().unwrap_or_else(PoisonError::into_inner).entry(args.join("\u{1f}")).or_default().clone();
        let mut slot = slot.lock().await;
        if let Some((at, out)) = &*slot
            && at.elapsed() < FRESH
        {
            return out.clone();
        }
        let out = docker(args).await;
        *slot = Some((Instant::now(), out.clone()));
        out
    }

    async fn docker_containers(&self) -> Result<Value, String> {
        let rows = json_lines(&self.docker_shared(&["ps", "-a", "--format", "{{json .}}"]).await?);
        Ok(rows
            .iter()
            .map(|r| {
                json!({
                    "id": r["ID"], "name": r["Names"], "image": r["Image"], "state": r["State"],
                    "status": r["Status"], "ports": r["Ports"], "created": r["CreatedAt"],
                })
            })
            .collect())
    }

    async fn docker_stats(&self, container: Option<&str>) -> Result<Value, String> {
        let mut args = vec!["stats", "--no-stream", "--format", "{{json .}}"];
        if let Some(c) = container {
            valid_container(c)?;
            args.extend(["--", c]);
        }
        let rows = json_lines(&self.docker_shared(&args).await?);
        Ok(rows
            .iter()
            .map(|r| {
                json!({
                    "name": r["Name"], "cpu": pct(&r["CPUPerc"]), "memPct": pct(&r["MemPerc"]),
                    "memUsage": r["MemUsage"], "netIO": r["NetIO"], "blockIO": r["BlockIO"], "pids": r["PIDs"],
                })
            })
            .collect())
    }

    async fn docker_logs(&self, container: &str, tail: u64) -> Result<Value, String> {
        valid_container(container)?;
        let tail = tail.to_string();
        let text = self.docker_shared(&["logs", "--tail", &tail, "--timestamps", "--", container]).await?;
        let lines: Vec<&str> = text.lines().collect();
        Ok(json!({ "container": container, "lines": lines.len(), "text": lines.join("\n") }))
    }
}

// ── GitHub (its API, with the account connected in Settings → Integrations) ─

/// `owner/name` only: it goes into API paths.
fn repo(v: &Value) -> Result<(&str, &str), String> {
    let r = v.as_str().ok_or("GitHub sources need `repo`: \"owner/name\"")?;
    let ok_part =
        |p: &str| !p.is_empty() && !p.starts_with('.') && p.len() <= 100 && p.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c));
    match r.split_once('/') {
        Some((owner, name)) if ok_part(owner) && ok_part(name) => Ok((owner, name)),
        _ => Err(format!("`{r}` isn't a repo; use \"owner/name\"")),
    }
}

fn pr_number(v: &Value) -> Result<u64, String> {
    v.as_u64().or_else(|| v.as_str().and_then(|s| s.trim_start_matches('#').parse().ok())).ok_or_else(|| "needs a PR `number`".into())
}

/// The checks on a PR's head commit: check runs (with their workflow) and commit statuses.
const CHECKS_FIELDS: &str = "commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { __typename \
    ... on CheckRun { name status conclusion detailsUrl checkSuite { workflowRun { workflow { name } } } } \
    ... on StatusContext { context state targetUrl } } } } } } }";

const PR_QUERY: &str = "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { \
    number title state isDraft url body additions deletions changedFiles createdAt updatedAt mergeable reviewDecision \
    author { login } headRefName baseRefName labels(first: 20) { nodes { name } } \
    reviews(last: 30) { nodes { author { login } state body submittedAt } } \
    comments(last: 30) { nodes { author { login } body createdAt } } \
    files(first: 100) { nodes { path additions deletions } } CHECKS } } }";

/// GraphQL's PR into the flat shape `shape_pr` reads (the one `gh --json` used).
fn flatten_pr(pr: &Value) -> Value {
    let mut p = pr.clone();
    for k in ["labels", "reviews", "comments", "files"] {
        p[k] = pr[k]["nodes"].clone();
    }
    let contexts = pr["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["contexts"]["nodes"].as_array().cloned().unwrap_or_default();
    p["statusCheckRollup"] = contexts
        .into_iter()
        .map(|mut c| {
            if let Some(w) = c["checkSuite"]["workflowRun"]["workflow"]["name"].as_str() {
                c["workflowName"] = json!(w);
            }
            c
        })
        .collect();
    p
}

async fn github_pr((owner, name): (&str, &str), number: u64) -> Result<Value, String> {
    let q = PR_QUERY.replace("CHECKS", CHECKS_FIELDS);
    let data = crate::integrations::github_graphql(&q, json!({ "owner": owner, "name": name, "number": number })).await?;
    let pr = &data["repository"]["pullRequest"];
    if pr.is_null() {
        return Err(format!("no PR #{number} in {owner}/{name}"));
    }
    Ok(shape_pr(&flatten_pr(pr)))
}

/// Cut `text` to at most `max` bytes, on a line end so a patch still parses.
fn cut_at_line(text: &mut String, max: usize) -> bool {
    if text.len() <= max {
        return false;
    }
    let cut = text.floor_char_boundary(max);
    text.truncate(text[..cut].rfind('\n').unwrap_or(cut));
    true
}

async fn github_pr_diff((owner, name): (&str, &str), number: u64) -> Result<Value, String> {
    let mut text = crate::integrations::github_get(&format!("/repos/{owner}/{name}/pulls/{number}"), "application/vnd.github.diff", true).await?;
    let bytes = text.len();
    let truncated = cut_at_line(&mut text, MAX_DIFF_BYTES);
    Ok(json!({ "repo": format!("{owner}/{name}"), "number": number, "text": text, "bytes": bytes, "truncated": truncated }))
}

async fn github_prs((owner, name): (&str, &str), state: &str, limit: u64) -> Result<Value, String> {
    let states = match state {
        "open" => json!(["OPEN"]),
        "closed" => json!(["CLOSED"]),
        "merged" => json!(["MERGED"]),
        "all" => json!(["OPEN", "CLOSED", "MERGED"]),
        _ => return Err(format!("state `{state}` isn't one of open, closed, merged, all")),
    };
    let q = format!(
        "query($owner: String!, $name: String!, $states: [PullRequestState!], $first: Int!) {{ repository(owner: $owner, name: $name) {{ \
         pullRequests(states: $states, first: $first, orderBy: {{ field: UPDATED_AT, direction: DESC }}) {{ nodes {{ \
         number title url isDraft author {{ login }} headRefName reviewDecision updatedAt {CHECKS_FIELDS} }} }} }} }}"
    );
    let data = crate::integrations::github_graphql(&q, json!({ "owner": owner, "name": name, "states": states, "first": limit.max(1) })).await?;
    if data["repository"].is_null() {
        return Err(format!("no repo {owner}/{name} (or no access to it)"));
    }
    Ok(data["repository"]["pullRequests"]["nodes"].as_array().into_iter().flatten().map(pr_row).collect())
}

fn pr_row(pr: &Value) -> Value {
    let p = flatten_pr(pr);
    let (_, summary) = checks(&p["statusCheckRollup"]);
    json!({
        "number": p["number"], "title": p["title"], "url": p["url"], "author": p["author"]["login"],
        "branch": p["headRefName"], "draft": p["isDraft"],
        "review": match p["reviewDecision"].as_str().unwrap_or_default() { "APPROVED" => "approved", "CHANGES_REQUESTED" => "changes requested", "REVIEW_REQUIRED" => "review required", _ => "" },
        "checks": summary["text"], "checksTone": summary["tone"], "updatedAt": p["updatedAt"],
    })
}

/// pass / fail / pending / skipped, from a `CheckRun` or a commit `StatusContext`.
fn check_state(c: &Value) -> &'static str {
    if c["__typename"] == "StatusContext" {
        return match c["state"].as_str().unwrap_or_default() {
            "SUCCESS" => "pass",
            "PENDING" | "EXPECTED" => "pending",
            _ => "fail",
        };
    }
    if c["status"].as_str().is_some_and(|s| s != "COMPLETED") {
        return "pending";
    }
    match c["conclusion"].as_str().unwrap_or_default() {
        "SUCCESS" => "pass",
        "NEUTRAL" | "SKIPPED" => "skipped",
        _ => "fail",
    }
}

/// Checks as rows a UI can show without logic, and a one-line summary.
fn checks(rollup: &Value) -> (Vec<Value>, Value) {
    let mut counts = BTreeMap::from([("pass", 0), ("fail", 0), ("pending", 0), ("skipped", 0)]);
    let mut rows: Vec<Value> = rollup
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| {
            let state = check_state(c);
            *counts.entry(state).or_default() += 1;
            let name = c["name"].as_str().or(c["context"].as_str()).unwrap_or("check");
            let name = match c["workflowName"].as_str() {
                Some(w) if !w.is_empty() && w != name => format!("{w} / {name}"),
                _ => name.to_owned(),
            };
            let (tone, mark) = match state {
                "pass" => ("success", "✓"),
                "fail" => ("danger", "✗"),
                "pending" => ("warning", "●"),
                _ => ("muted", "–"),
            };
            json!({ "name": name, "state": state, "tone": tone, "mark": mark, "url": c["detailsUrl"].as_str().or(c["targetUrl"].as_str()) })
        })
        .collect();
    // Failures first, then pending, then the rest.
    rows.sort_by_key(|r| match r["state"].as_str() {
        Some("fail") => 0,
        Some("pending") => 1,
        _ => 2,
    });
    let text = [("fail", "failed"), ("pending", "pending"), ("pass", "passed"), ("skipped", "skipped")]
        .iter()
        .filter(|(k, _)| counts[k] > 0)
        .map(|(k, w)| format!("{} {w}", counts[k]))
        .collect::<Vec<_>>()
        .join(", ");
    let tone = if counts["fail"] > 0 {
        "danger"
    } else if counts["pending"] > 0 {
        "warning"
    } else {
        "success"
    };
    (
        rows,
        json!({ "pass": counts["pass"], "fail": counts["fail"], "pending": counts["pending"], "skipped": counts["skipped"], "text": if text.is_empty() { "no checks".into() } else { text }, "tone": tone }),
    )
}

/// A PR shaped for display: plain fields, labels for state and review, checks summarised.
fn shape_pr(p: &Value) -> Value {
    let (check_rows, summary) = checks(&p["statusCheckRollup"]);
    let state = p["state"].as_str().unwrap_or_default().to_lowercase();
    let draft = p["isDraft"].as_bool().unwrap_or(false);
    let review = p["reviewDecision"].as_str().unwrap_or_default();
    let mut label = state.chars();
    let state_label =
        if draft && state == "open" { "Draft".to_owned() } else { label.next().map(|c| c.to_uppercase().chain(label).collect()).unwrap_or_default() };
    json!({
        "number": p["number"], "title": p["title"], "url": p["url"], "body": p["body"],
        "state": state,
        "stateLabel": state_label,
        "draft": draft,
        "author": p["author"]["login"],
        "head": p["headRefName"], "base": p["baseRefName"],
        "additions": p["additions"], "deletions": p["deletions"], "changedFiles": p["changedFiles"],
        "createdAt": p["createdAt"], "updatedAt": p["updatedAt"], "mergeable": p["mergeable"],
        "review": review.to_lowercase(),
        "reviewLabel": match review { "APPROVED" => "Approved", "CHANGES_REQUESTED" => "Changes requested", "REVIEW_REQUIRED" => "Review required", _ => "No review needed" },
        "labels": p["labels"].as_array().into_iter().flatten().map(|l| l["name"].clone()).collect::<Vec<_>>(),
        "checks": check_rows,
        "checksSummary": summary,
        "reviews": p["reviews"].as_array().into_iter().flatten().map(|r| json!({
            "author": r["author"]["login"], "state": r["state"].as_str().unwrap_or_default().replace('_', " ").to_lowercase(),
            "body": r["body"], "at": r["submittedAt"],
        })).collect::<Vec<_>>(),
        "comments": p["comments"].as_array().into_iter().flatten().map(|c| json!({ "author": c["author"]["login"], "body": c["body"], "at": c["createdAt"] })).collect::<Vec<_>>(),
        "files": p["files"].as_array().into_iter().flatten().map(|f| json!({ "path": f["path"], "additions": f["additions"], "deletions": f["deletions"] })).collect::<Vec<_>>(),
    })
}

// ── Postgres connections ────────────────────────────────────────────────────

fn user_connections() -> Arc<JsonFile> {
    static USER: OnceLock<Arc<JsonFile>> = OnceLock::new();
    USER.get_or_init(|| Arc::new(JsonFile::new(home().join(".config/yaah/connections.json"), true))).clone()
}

/// host:port/db for display; never the user or password.
fn target(url: &str) -> String {
    url.parse::<tokio_postgres::Config>().ok().map_or_else(
        || "?".into(),
        |c| {
            let host = c
                .get_hosts()
                .first()
                .map(|h| match h {
                    tokio_postgres::config::Host::Tcp(h) => h.clone(),
                    tokio_postgres::config::Host::Unix(p) => p.display().to_string(),
                })
                .unwrap_or_default();
            let port = c.get_ports().first().copied().unwrap_or(5432);
            format!("{host}:{port}/{}", c.get_dbname().unwrap_or(""))
        },
    )
}

fn info(c: &Connection) -> ConnectionInfo {
    ConnectionInfo { kind: "postgres", target: target(&c.url), name: c.name.clone() }
}

fn infos(store: &JsonFile) -> Vec<ConnectionInfo> {
    store.read::<ConnectionFile>().connections.iter().map(info).collect()
}

async fn add(store: &JsonFile, name: &str, url: &str) -> Result<ConnectionInfo, String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 64 || !name.chars().all(|c| c.is_ascii_alphanumeric() || "-_".contains(c)) {
        return Err("connection names use letters, digits, - and _".into());
    }
    let c = Connection { name: name.to_owned(), url: url.trim().to_owned() };
    let client = open(&c).await.map_err(|e| format!("couldn't connect: {e}"))?;
    // Always asked afresh here: a role that changed since the last check is caught when it's saved.
    check_role(&client).await?;
    trusted_roles().lock().unwrap_or_else(PoisonError::into_inner).insert(c.url.clone(), Instant::now());
    store.update(|f: &mut ConnectionFile| {
        f.connections.retain(|x| x.name != c.name);
        f.connections.push(c.clone());
        Ok(())
    })?;
    Ok(info(&c))
}

pub fn list_connections() -> Vec<ConnectionInfo> {
    infos(&user_connections())
}

/// Test a connection, then save it (replacing one with the same name).
pub async fn add_connection(name: &str, url: &str) -> Result<ConnectionInfo, String> {
    add(&user_connections(), name, url).await
}

pub fn remove_connection(name: &str) -> Result<(), String> {
    user_connections().update(|f: &mut ConnectionFile| {
        f.connections.retain(|c| c.name != name);
        Ok(())
    })
}

// ── Postgres queries (read-only) ────────────────────────────────────────────

fn tls() -> Result<postgres_native_tls::MakeTlsConnector, String> {
    static TLS: OnceLock<Result<postgres_native_tls::MakeTlsConnector, String>> = OnceLock::new();
    TLS.get_or_init(|| native_tls::TlsConnector::builder().build().map(postgres_native_tls::MakeTlsConnector::new).map_err(|e| e.to_string())).clone()
}

async fn open(c: &Connection) -> Result<tokio_postgres::Client, String> {
    let (client, conn) = tokio::time::timeout(Duration::from_secs(10), tokio_postgres::connect(&c.url, tls()?))
        .await
        .map_err(|_| "timed out connecting".to_owned())?
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn(async move {
        let _ = conn.await;
    });
    Ok(client)
}

/// A connection for agent or UI SQL: only as a role [`check_role`] accepts.
async fn connect(c: &Connection) -> Result<tokio_postgres::Client, String> {
    let client = open(c).await?;
    let fresh = trusted_roles().lock().unwrap_or_else(PoisonError::into_inner).get(&c.url).is_some_and(|at| at.elapsed() < ROLE_CHECK_TTL);
    if !fresh {
        check_role(&client).await?;
        trusted_roles().lock().unwrap_or_else(PoisonError::into_inner).insert(c.url.clone(), Instant::now());
    }
    Ok(client)
}

/// How long a role that passed [`check_role`] is trusted before it's asked again,
/// so live views polling every second don't pay for the check each time.
const ROLE_CHECK_TTL: Duration = Duration::from_secs(60);

/// Connection URLs whose role passed [`check_role`], and when.
fn trusted_roles() -> &'static Mutex<HashMap<String, Instant>> {
    static TRUSTED: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    TRUSTED.get_or_init(Mutex::default)
}

/// Roles a connection may not have, directly or through membership. A READ ONLY
/// transaction doesn't stop them: superusers and these predefined roles can read
/// and write the server's files (`pg_read_file`, `COPY … TO`), run programs, or
/// end other sessions (`pg_terminate_backend`).
const POWERFUL_ROLES: &[&str] = &["pg_read_server_files", "pg_write_server_files", "pg_execute_server_program", "pg_signal_backend"];

/// What to tell the user when the connection's role is refused.
const READ_ONLY_ROLE_HINT: &str = "yaah only connects as a read-only role: create one with     `CREATE ROLE yaah_ro LOGIN PASSWORD '…'; GRANT pg_read_all_data TO yaah_ro;` (PostgreSQL 14+;     on older versions GRANT SELECT on the tables instead) and use it in the connection URL";

/// Refuse a connection whose role (or any role it can become) is a superuser or
/// holds one of [`POWERFUL_ROLES`].
async fn check_role(client: &tokio_postgres::Client) -> Result<(), String> {
    let sql = format!(
        "select current_user::text, coalesce(array_agg(distinct case when p.rolsuper then 'superuser' else p.rolname::text end), '{{}}') \
         from pg_roles u join pg_roles p on pg_has_role(u.oid, p.oid, 'member') \
         where u.rolname in (current_user, session_user) and (p.rolsuper or p.rolname in ({}))",
        POWERFUL_ROLES.iter().map(|r| format!("'{r}'")).collect::<Vec<_>>().join(", ")
    );
    let row =
        client.query_one(&sql, &[]).await.map_err(|e| format!("couldn't check the connection's role ({}); {READ_ONLY_ROLE_HINT}", db_error(&e)))?;
    let (user, mut powers): (String, Vec<String>) = (row.get(0), row.get(1));
    if powers.is_empty() {
        return Ok(());
    }
    powers.sort_unstable();
    Err(format!(
        "the role `{user}` can't be used: it has {} (a read-only transaction doesn't stop those reading the server's files, running programs or ending sessions). {READ_ONLY_ROLE_HINT}",
        powers.join(", ")
    ))
}

/// Skip `/* … */` (nested, as Postgres allows) after its opening `/*`.
fn after_block_comment(s: &str) -> &str {
    let mut depth = 1;
    let mut i = 0;
    let b = s.as_bytes();
    while i < b.len() && depth > 0 {
        match (b[i], b.get(i + 1)) {
            (b'/', Some(b'*')) => (depth, i) = (depth + 1, i + 2),
            (b'*', Some(b'/')) => (depth, i) = (depth - 1, i + 2),
            _ => i += 1,
        }
    }
    &s[i.min(s.len())..]
}

/// A statement's first keyword, lowercased, past comments and opening parentheses.
fn first_keyword(sql: &str) -> String {
    let mut s = sql;
    loop {
        s = s.trim_start_matches(|c: char| c.is_whitespace() || c == '(');
        if let Some(rest) = s.strip_prefix("--") {
            s = rest.split_once('\n').map_or("", |(_, r)| r);
        } else if let Some(rest) = s.strip_prefix("/*") {
            s = after_block_comment(rest);
        } else {
            break;
        }
    }
    s.chars().take_while(char::is_ascii_alphabetic).collect::<String>().to_ascii_lowercase()
}

/// Statements run as written when they can't be wrapped as a subquery. Writes
/// stay on the list so Postgres refuses them in the read-only transaction (a
/// clearer answer than ours); COPY, DO, CALL, SET, LOAD and transaction control
/// don't: they can reach the server's files, run programs, or end the transaction.
const RAW_STATEMENTS: &[&str] = &["select", "with", "values", "table", "show", "explain", "insert", "update", "delete", "merge"];

/// Run `sql` in a READ ONLY transaction with a statement timeout; rows come
/// back as JSON objects (Postgres builds them, so every type converts).
async fn postgres_query(c: &Connection, sql: &str, limit: u64) -> Result<Value, String> {
    query_within(c, sql, limit, QUERY_TIMEOUT_MS).await
}

async fn query_within(c: &Connection, sql: &str, limit: u64, timeout_ms: u32) -> Result<Value, String> {
    let sql = sql.trim().trim_end_matches(';').trim();
    if sql.is_empty() {
        return Err("empty query".into());
    }
    let client = connect(c).await?;
    let begin = format!("begin read only; set local statement_timeout = {timeout_ms};");
    client.batch_execute(&begin).await.map_err(|e| db_error(&e))?;
    let result = async {
        // Column order (and a parse check: one statement only) from preparing the query itself.
        let stmt = client.prepare(sql).await.map_err(|e| db_error(&e))?;
        let columns: Vec<String> = stmt.columns().iter().map(|c| c.name().to_owned()).collect();
        // On their own lines, so a trailing `--` comment in `sql` can't swallow the wrapper.
        let wrapped = format!("select coalesce(json_agg(t), '[]'::json)::text from (select * from (\n{sql}\n) q limit {}) t", limit + 1);
        let mut rows: Vec<Value> = if let Ok(row) = client.query_one(&wrapped, &[]).await {
            serde_json::from_str(row.get::<_, &str>(0)).map_err(|e| e.to_string())?
        } else {
            // Not wrappable (SHOW, EXPLAIN, INSERT … RETURNING): run it as written, still in
            // a read-only transaction (so writes are refused by Postgres), with text values.
            let keyword = first_keyword(sql);
            if !RAW_STATEMENTS.contains(&keyword.as_str()) {
                return Err(format!("`{keyword}` statements aren't run here: connections are for reading (SELECT, WITH, SHOW, EXPLAIN)"));
            }
            client.batch_execute(&format!("rollback; {begin}")).await.map_err(|e| db_error(&e))?;
            let limit = usize::try_from(limit).unwrap_or(usize::MAX);
            client
                .simple_query(sql)
                .await
                .map_err(|e| db_error(&e))?
                .into_iter()
                .filter_map(|m| match m {
                    tokio_postgres::SimpleQueryMessage::Row(r) => Some(Value::Object(
                        columns.iter().enumerate().map(|(i, c)| (c.clone(), r.get(i).map_or(Value::Null, |s| json!(s)))).collect(),
                    )),
                    _ => None,
                })
                .take(limit.saturating_add(1))
                .collect()
        };
        let limit = usize::try_from(limit).unwrap_or(usize::MAX);
        let truncated = rows.len() > limit;
        rows.truncate(limit);
        Ok::<_, String>(json!({ "connection": c.name, "columns": columns, "rows": rows, "truncated": truncated }))
    }
    .await;
    let _ = client.batch_execute("rollback").await;
    result
}

fn db_error(e: &tokio_postgres::Error) -> String {
    match e.as_db_error() {
        Some(db) => format!("{}: {}", db.severity(), db.message()),
        None => e.to_string(),
    }
}

async fn postgres_schema(c: Connection) -> Result<Value, String> {
    let q = postgres_query(
        &c,
        "select table_schema as schema, table_name as table, column_name as column, data_type as type, is_nullable = 'YES' as nullable \
         from information_schema.columns \
         where table_schema not in ('pg_catalog', 'information_schema') \
         order by table_schema, table_name, ordinal_position",
        MAX_ROW_LIMIT,
    )
    .await?;
    let mut tables: Vec<Value> = vec![];
    for r in q["rows"].as_array().into_iter().flatten() {
        let column = json!({ "name": r["column"], "type": r["type"], "nullable": r["nullable"] });
        match tables.last_mut() {
            Some(t) if t["schema"] == r["schema"] && t["table"] == r["table"] => {
                if let Some(cols) = t["columns"].as_array_mut() {
                    cols.push(column);
                }
            }
            _ => tables.push(json!({ "schema": r["schema"], "table": r["table"], "columns": [column] })),
        }
    }
    Ok(json!({ "connection": q["connection"], "tables": tables }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_snapshot_is_sane_and_shared_while_fresh() {
        let s = Sources::new();
        let read = || tauri::async_runtime::block_on(s.read(&json!({ "kind": "system" }))).unwrap();
        let v = read();
        assert!(v["memTotalGb"].as_f64().unwrap() > 0.5);
        assert!((0.0..=100.0).contains(&v["memPct"].as_f64().unwrap()));
        assert_ne!(v["cores"].as_array().unwrap().len(), 0);
        assert_ne!(v["processes"].as_array().unwrap().len(), 0);
        assert_ne!(v["disks"].as_array().unwrap().len(), 0);
        assert_eq!(read(), v, "a second reader within a second gets the same reading");
    }

    /// GitHub's PR JSON becomes plain rows: failures first, a summary, labels for state and review.
    #[test]
    fn shapes_a_pull_request() {
        let p = json!({
            "number": 7, "title": "Refunds", "state": "OPEN", "isDraft": true, "author": { "login": "ada" },
            "headRefName": "feat/refunds", "baseRefName": "main", "reviewDecision": "CHANGES_REQUESTED",
            "labels": [{ "name": "billing" }],
            "statusCheckRollup": [
                { "__typename": "CheckRun", "name": "test", "workflowName": "CI", "status": "COMPLETED", "conclusion": "SUCCESS", "detailsUrl": "u1" },
                { "__typename": "CheckRun", "name": "lint", "workflowName": "CI", "status": "COMPLETED", "conclusion": "FAILURE", "detailsUrl": "u2" },
                { "__typename": "CheckRun", "name": "e2e", "status": "IN_PROGRESS", "conclusion": "" },
                { "__typename": "StatusContext", "context": "deploy/preview", "state": "SUCCESS", "targetUrl": "u3" },
                { "__typename": "CheckRun", "name": "docs", "status": "COMPLETED", "conclusion": "SKIPPED" }
            ],
            "reviews": [{ "author": { "login": "grace" }, "state": "CHANGES_REQUESTED", "body": "Round to cents", "submittedAt": "t" }],
            "files": [{ "path": "src/refund.rs", "additions": 10, "deletions": 2 }]
        });
        let v = shape_pr(&p);
        assert_eq!(v["stateLabel"], "Draft");
        assert_eq!(v["reviewLabel"], "Changes requested");
        assert_eq!(v["checks"][0]["name"], "CI / lint");
        assert_eq!(v["checks"][0]["tone"], "danger");
        assert_eq!(v["checks"][1]["state"], "pending");
        assert_eq!(v["checksSummary"]["text"], "1 failed, 1 pending, 2 passed, 1 skipped");
        assert_eq!(v["checksSummary"]["tone"], "danger");
        assert_eq!(v["reviews"][0]["state"], "changes requested");
        assert_eq!(v["labels"], json!(["billing"]));
        assert_eq!(shape_pr(&json!({ "state": "MERGED" }))["stateLabel"], "Merged");
        assert_eq!(shape_pr(&json!({}))["checksSummary"]["text"], "no checks");
        assert_eq!(repo(&json!("supabase/realtime")).unwrap(), ("supabase", "realtime"));
        for bad in ["supabase", "a/b/c", "a/b c", "../x", "a/b;rm", "a/.git"] {
            assert!(repo(&json!(bad)).is_err(), "{bad}");
        }
        assert_eq!(pr_number(&json!("#42")).unwrap(), 42);
        assert!(pr_number(&json!("forty-two")).is_err());
    }

    #[test]
    fn lists_pull_requests_with_their_checks() {
        let pr = json!({ "number": 3, "title": "t", "author": { "login": "ada" }, "reviewDecision": "APPROVED",
            "commits": { "nodes": [{ "commit": { "statusCheckRollup": { "contexts": { "nodes": [
                { "__typename": "StatusContext", "context": "ci", "state": "PENDING" } ] } } } }] } });
        let row = pr_row(&pr);
        assert_eq!(
            (row["review"].as_str(), row["checks"].as_str(), row["checksTone"].as_str()),
            (Some("approved"), Some("1 pending"), Some("warning"))
        );
    }

    #[test]
    fn diffs_are_cut_on_a_line() {
        let mut d = "a\nbé\ncc\n".to_owned();
        assert!(!cut_at_line(&mut d.clone(), 100));
        assert!(cut_at_line(&mut d, 4), "the cut falls inside the two-byte é");
        assert_eq!(d, "a");
    }

    #[test]
    fn refuses_odd_input() {
        let dir = std::env::temp_dir().join(format!("yaah-src-{}", crate::session::random_token()));
        let s = Sources::with_connections_file(dir.join("connections.json"));
        let run = |v: Value| tauri::async_runtime::block_on(s.read(&v)).unwrap_err();
        assert!(run(json!({ "kind": "nope" })).contains("unknown source kind"));
        assert_eq!(run(json!({})), "a source needs a `kind`");
        for bad in ["x; rm -rf /", "--follow", "-H=tcp://evil", ""] {
            assert!(run(json!({ "kind": "docker.logs", "container": bad })).contains("isn't a container name"), "{bad}");
        }
        assert!(run(json!({ "kind": "docker.stats", "container": "-a" })).contains("isn't a container name"));
        assert!(run(json!({ "kind": "postgres.query", "connection": "missing", "sql": "select 1" })).contains("no connection named"));
        assert!(run(json!({ "kind": "github.prs", "repo": "o/r", "state": "weird" })).contains("isn't one of"));
        assert!(valid_container("yaah-pg-demo").is_ok() && valid_container("4f1c2b3a9d0e").is_ok());
    }

    #[test]
    fn finds_the_first_keyword_past_comments() {
        assert_eq!(first_keyword("  SELECT 1"), "select");
        assert_eq!(first_keyword("-- note\n  /* a /* nested */ comment */ (copy x to program 'id')"), "copy");
        assert_eq!(first_keyword("/* unclosed"), "");
        assert_eq!(first_keyword("Explain analyze select 1"), "explain");
        assert_eq!(first_keyword("do $$ begin end $$"), "do");
    }

    #[test]
    fn shows_targets_without_credentials() {
        assert_eq!(target("postgres://admin:hunter2@db.example.com:6543/app"), "db.example.com:6543/app");
        assert_eq!(target("not a url"), "?");
    }
}

/// Against a real database: the demo container (`yaah-pg-demo` on 127.0.0.1:54329)
/// or `YAAH_PG_TEST_URL` (a superuser URL). yaah runs as `yaah_ro`, a read-only
/// role the tests create there. Skipped when neither answers. More in `tests/data_postgres.rs`.
#[cfg(test)]
mod postgres_tests {
    use super::*;

    fn admin_url() -> String {
        std::env::var("YAAH_PG_TEST_URL").unwrap_or_else(|_| "postgres://postgres:yaahdemo@127.0.0.1:54329/shop".into())
    }

    /// Create `yaah_ro` (once, whoever gets there first) and return its URL.
    async fn read_only_url(admin: &str) -> Result<String, String> {
        const SETUP: &str = "do $$ begin if not exists (select from pg_roles where rolname = 'yaah_ro') then \
            create role yaah_ro login password 'yaahro'; end if; end $$; grant pg_read_all_data to yaah_ro";
        let (client, conn) = tokio_postgres::connect(admin, tokio_postgres::NoTls).await.map_err(|e| e.to_string())?;
        tauri::async_runtime::spawn(conn);
        // Other test processes may be creating it at the same moment.
        for attempt in 0.. {
            match client.batch_execute(SETUP).await {
                Ok(()) => break,
                Err(_) if attempt < 3 => tokio::time::sleep(Duration::from_millis(50)).await,
                Err(e) => return Err(e.to_string()),
            }
        }
        let mut url = reqwest::Url::parse(admin).map_err(|e| e.to_string())?;
        url.set_username("yaah_ro").and_then(|()| url.set_password(Some("yaahro"))).map_err(|()| "not a URL with a user".to_owned())?;
        Ok(url.into())
    }

    fn demo() -> Option<Connection> {
        let url = tauri::async_runtime::block_on(read_only_url(&admin_url()));
        let c = url.map(|url| Connection { name: "demo".into(), url });
        match c.and_then(|c| tauri::async_runtime::block_on(postgres_query(&c, "select 1", 1)).map(|_| c)) {
            Ok(c) => Some(c),
            Err(e) => {
                eprintln!("skipped: no Postgres to test against ({e})");
                None
            }
        }
    }

    #[test]
    fn superusers_are_refused_before_any_sql_runs() {
        let Some(_) = demo() else { return };
        let admin = Connection { name: "admin".into(), url: admin_url() };
        let e = tauri::async_runtime::block_on(postgres_query(&admin, "select pg_read_file('/etc/hostname')", 1)).unwrap_err();
        assert!(e.contains("superuser") && e.contains("CREATE ROLE yaah_ro") && e.contains("pg_read_all_data"), "{e}");
        let store = JsonFile::new(std::env::temp_dir().join(format!("yaah-pg-{}", crate::session::random_token())).join("c.json"), true);
        assert!(tauri::async_runtime::block_on(add(&store, "admin", &admin.url)).unwrap_err().contains("superuser"));
        assert!(infos(&store).is_empty(), "a refused connection isn't saved");
    }

    #[test]
    fn the_read_only_role_cant_reach_the_servers_files() {
        let Some(c) = demo() else { return };
        for sql in ["select pg_read_file('/etc/hostname')", "select * from pg_ls_dir('.')", "select pg_stat_file('postgresql.conf')"] {
            let e = tauri::async_runtime::block_on(query_within(&c, sql, 10, 5_000)).unwrap_err();
            assert!(e.contains("permission denied"), "{sql}: {e}");
        }
    }

    #[test]
    fn the_statement_timeout_cancels_long_queries_on_both_paths() {
        let Some(c) = demo() else { return };
        let run = |sql: &str| tauri::async_runtime::block_on(query_within(&c, sql, 10, 300)).unwrap_err();
        let started = Instant::now();
        assert!(run("select pg_sleep(5)").contains("statement timeout"));
        // EXPLAIN ANALYZE can't be wrapped as a subquery, so it runs as written: still bounded.
        assert!(run("explain analyze select pg_sleep(5)").contains("statement timeout"));
        assert!(started.elapsed() < Duration::from_secs(4));
    }
}
