//! The conformance suite a newer adapter version passes before yaah runs it.
//!
//! `agent_versions` installs a newer version of an npm-based agent as a
//! candidate and hands it to the [`Verifier`] registered here ([`Suite`]). The
//! suite runs the version and decides whether it is promoted.
//!
//! **Tier A** (on, automatic, no sign-in, no tokens spent). yaah's own ACP
//! client (`acp.rs`) starts the installed version in a throwaway home
//! ([`Sandbox`]: its own `HOME`, XDG folders, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
//! nothing inherited but `PATH`), so it never sees the user's agent config or
//! credentials, and checks what yaah depends on ([`run_checks`]):
//!
//! - it starts and answers `initialize` (sent exactly as `agents::initialize`
//!   sends it) within [`INIT_TIMEOUT`], with a protocol version yaah speaks;
//! - its `agentCapabilities` still include what yaah uses with that preset
//!   ([`EXPECTATIONS`], one row per preset);
//! - its `authMethods` parse with `agents::auth_methods`, and terminal logins
//!   carry the args `login.rs` reruns the agent with;
//! - signed out, `session/new` (shaped like `session.rs` sends it) either works
//!   or fails with ACP's auth-required error, which is what yaah's login flow
//!   keys on;
//! - an unknown method gets JSON-RPC "method not found", and the agent lives on;
//! - closing its stdin stops it within [`EXIT_TIMEOUT`], leaving no process behind.
//!
//! Then `npm audit --json --omit=dev` runs in the version's folder ([`audit`]).
//! High and critical advisories block promotion; the rest are shown. Offline,
//! the last audit stands and the suite isn't failed for it. The active version
//! of each agent in use is audited daily too ([`watch_advisories`]), so Settings
//! shows advisories for what runs now.
//!
//! Every run's per-check results go to `~/.yaah/agents/conformance.json`
//! ([`Results`]); the verdict goes to `verified.json` through
//! `Versions::record_result` and, when everything passed, `Versions::promote`.
//!
//! **Tier B** ([`live`]) is prepared, not active: checks that need a signed-in
//! agent and spend a few cheap prompts. See that module for how it will gate
//! promotion once it's switched on.

use crate::acp::{self, Connection, Incoming};
use crate::agent_install;
use crate::agent_versions::{Advisory, Outcome, Status, Verifier, Versions};
use crate::agents::{self, Preset, Report};
use crate::json_file::JsonFile;
use crate::provider_stub::Plan;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fmt::Write as _;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// The candidate is already installed (no npx download), so this is generous.
pub const INIT_TIMEOUT: Duration = Duration::from_secs(90);
/// `session/new` signed out: some agents look for credentials first.
pub const SESSION_TIMEOUT: Duration = Duration::from_secs(60);
/// An unknown method is answered at once or not at all.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
/// From closing the agent's stdin to its exit.
pub const EXIT_TIMEOUT: Duration = if cfg!(test) { Duration::from_secs(2) } else { Duration::from_secs(15) };
/// After the agent exits, how long what it started gets to exit too.
pub const CHILD_GRACE: Duration = if cfg!(test) { Duration::from_secs(1) } else { Duration::from_secs(5) };
/// `npm audit` asks the registry once; a stuck one is stopped.
pub const AUDIT_TIMEOUT: Duration = Duration::from_secs(120);
/// The active versions' advisories are refreshed when older than this.
pub const AUDIT_EVERY: Duration = Duration::from_hours(24);
/// A method no agent implements.
pub const UNKNOWN_METHOD: &str = "yaah/conformanceProbe";
const METHOD_NOT_FOUND: i64 = -32601;
/// Reports kept per preset (newest versions first).
const KEEP_REPORTS: usize = 12;

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

// ── What yaah relies on, per preset ─────────────────────────────────────────

/// What yaah uses from one preset's adapter. A newer version that drops any of
/// these fails tier A. Each flag is set only where yaah depends on it today
/// with that agent (checked against the pinned versions, see the experiment in
/// `docs/experiments/2026-11-03-ci-docker/`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[allow(clippy::struct_excessive_bools, reason = "one flag per capability yaah relies on")]
pub struct Expect {
    pub preset: &'static str,
    /// `loadSession`: chats reopen after a restart (`session.rs` `attach`).
    pub load_session: bool,
    /// `mcpCapabilities.http`: yaah's UI tools reach the agent.
    pub mcp_http: bool,
    /// `sessionCapabilities.systemPrompt`: the guide goes in the system prompt (`agent_guide.rs`).
    pub system_prompt: bool,
    /// `sessionCapabilities.additionalDirectories`: projects with several folders.
    pub additional_dirs: bool,
    /// `promptCapabilities.embeddedContext`: the project brief goes inline as a resource.
    pub embedded_context: bool,
    /// Its login is a `terminal` auth method (`login.rs` reruns the agent with its args).
    pub terminal_login: bool,
    /// Signed out (no provider), `session/new` fails with this JSON-RPC error instead of
    /// auth-required: a known deviation yaah works around (goose needs a provider
    /// binding, `agent_routes`). Another code, or auth-required, still fails the check.
    pub signed_out_error: Option<i64>,
}

/// One row per npm-based preset. Presets not listed only need the generic checks.
pub const EXPECTATIONS: &[Expect] = &[
    Expect {
        preset: agents::CLAUDE,
        load_session: true,
        mcp_http: true,
        system_prompt: true,
        additional_dirs: true,
        embedded_context: true,
        terminal_login: true,
        signed_out_error: None,
    },
    Expect {
        preset: "codex",
        load_session: true,
        mcp_http: true,
        system_prompt: true,
        additional_dirs: true,
        embedded_context: true,
        terminal_login: false,
        signed_out_error: None,
    },
    Expect {
        preset: "gemini",
        load_session: true,
        mcp_http: true,
        system_prompt: false,
        additional_dirs: false,
        embedded_context: true,
        terminal_login: false,
        signed_out_error: None,
    },
    Expect {
        preset: "copilot",
        load_session: true,
        mcp_http: true,
        system_prompt: false,
        additional_dirs: false,
        embedded_context: true,
        terminal_login: false,
        signed_out_error: None,
    },
    Expect {
        preset: "qwen",
        load_session: true,
        mcp_http: true,
        system_prompt: false,
        additional_dirs: false,
        embedded_context: true,
        terminal_login: false,
        signed_out_error: None,
    },
    Expect {
        preset: "auggie",
        load_session: true,
        mcp_http: false,
        system_prompt: false,
        additional_dirs: false,
        embedded_context: false,
        terminal_login: false,
        signed_out_error: None,
    },
    Expect {
        preset: "cline",
        load_session: true,
        mcp_http: false,
        system_prompt: false,
        additional_dirs: false,
        embedded_context: false,
        terminal_login: false,
        signed_out_error: None,
    },
    // Release archives from the ACP registry (agent_install::BINARIES), as goose 1.57.0 and OpenCode 2.2.5 answer.
    Expect {
        preset: "goose",
        load_session: true,
        mcp_http: true,
        system_prompt: false,
        additional_dirs: false,
        embedded_context: true,
        terminal_login: false,
        // goose 1.57.0 without a provider: -32603 "Internal error", not -32000.
        signed_out_error: Some(-32603),
    },
    Expect {
        preset: "opencode",
        load_session: true,
        mcp_http: true,
        system_prompt: false,
        additional_dirs: true,
        embedded_context: true,
        terminal_login: true,
        signed_out_error: None,
    },
];

/// What `preset` must keep (nothing beyond the generic checks when it has no row).
pub fn expectations(preset: &str) -> Expect {
    EXPECTATIONS.iter().find(|e| e.preset == preset).copied().unwrap_or(Expect { preset: "", ..Expect::default() })
}

// ── Results ─────────────────────────────────────────────────────────────────

/// One check's outcome.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Check {
    pub name: String,
    pub ok: bool,
    pub detail: String,
}

impl Check {
    fn pass(name: &str, detail: impl Into<String>) -> Self {
        Self { name: name.to_owned(), ok: true, detail: detail.into() }
    }

    fn fail(name: &str, detail: impl Into<String>) -> Self {
        Self { name: name.to_owned(), ok: false, detail: detail.into() }
    }

    fn new(name: &str, ok: bool, detail: impl Into<String>) -> Self {
        Self { name: name.to_owned(), ok, detail: detail.into() }
    }
}

/// How the last `npm audit` went.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuditState {
    /// Not run yet.
    #[default]
    None,
    Ok,
    /// The registry couldn't be reached: the last result stands.
    Unavailable,
    /// npm failed for another reason (no lockfile, say): the last result stands.
    Error,
}

/// One run of the suite on one version.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuiteReport {
    pub version: String,
    /// Empty for a report that only holds a daily audit.
    #[serde(default)]
    pub checks: Vec<Check>,
    /// From the last audit that answered.
    #[serde(default)]
    pub advisories: Vec<Advisory>,
    #[serde(default)]
    pub audit: AuditState,
    /// What went wrong with the last audit, when it didn't answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audit_detail: Option<String>,
    /// Unix seconds of the last audit that answered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audited_at: Option<u64>,
    /// Unix seconds of the last run of the checks (0 when only audited).
    #[serde(default)]
    pub checked_at: u64,
    /// How long the checks and the audit took.
    #[serde(default)]
    pub seconds: f64,
    /// The run promoted the version to `verified`.
    #[serde(default)]
    pub promoted: bool,
}

/// High and critical advisories keep a version from being promoted.
pub fn blocks(a: &Advisory) -> bool {
    matches!(a.severity.to_ascii_lowercase().as_str(), "high" | "critical")
}

impl SuiteReport {
    /// What `Versions::record_result` stores: every failed check, then every blocking advisory.
    pub fn outcome(&self) -> Outcome {
        let checks = self.checks.iter().filter(|c| !c.ok).map(|c| format!("{}: {}", c.name, c.detail));
        let advisories = self.advisories.iter().filter(|a| blocks(a)).map(|a| format!("{} advisory {}: {}", a.severity, a.id, a.title));
        Outcome { failures: checks.chain(advisories).collect(), advisories: self.advisories.clone() }
    }

    pub fn passed(&self) -> bool {
        self.outcome().failures.is_empty()
    }
}

/// Per (preset, version) reports: `conformance.json` beside `verified.json`.
pub struct Results {
    file: JsonFile,
}

type Reports = BTreeMap<String, BTreeMap<String, SuiteReport>>;

impl Results {
    pub fn at(agents_root: &Path) -> Self {
        Self { file: JsonFile::new(agents_root.join("conformance.json"), false) }
    }

    pub fn all(&self) -> Reports {
        self.file.read()
    }

    pub fn get(&self, preset: &str, version: &str) -> Option<SuiteReport> {
        self.all().get(preset).and_then(|r| r.get(version)).cloned()
    }

    /// Store a report, keeping the newest [`KEEP_REPORTS`] versions per preset.
    pub fn put(&self, preset: &str, report: &SuiteReport) -> Result<(), String> {
        self.file.update(|all: &mut Reports| {
            let mine = all.entry(preset.to_owned()).or_default();
            mine.insert(report.version.clone(), report.clone());
            while mine.len() > KEEP_REPORTS {
                let oldest =
                    mine.keys().min_by(|a, b| crate::agent_versions::Version::parse(a).cmp(&crate::agent_versions::Version::parse(b))).cloned();
                if let Some(v) = oldest {
                    mine.remove(&v);
                }
            }
            Ok(())
        })
    }
}

// ── Isolation ───────────────────────────────────────────────────────────────

/// A throwaway home for one run: the agent gets its own `HOME`, XDG folders,
/// config folders and temp folder, and inherits nothing else but `PATH`. So it
/// can't read the user's agent config or credentials, and anything it writes
/// goes in here and is removed with it.
pub struct Sandbox {
    root: PathBuf,
}

/// Codex's config in the sandbox (see [`Sandbox::new`]).
const CODEX_SANDBOX_CONFIG: &str = "[features]\nplugins = false\nremote_plugin = false\n";

impl Sandbox {
    pub fn new() -> Result<Self, String> {
        let root = std::env::temp_dir().join(format!("yaah-conformance-{}", crate::random::token()));
        for sub in ["home/.claude", "home/.codex", "home/.config", "home/.local/share", "home/.local/state", "home/.cache", "work", "tmp"] {
            std::fs::create_dir_all(root.join(sub)).map_err(|e| format!("can't create {}: {e}", root.display()))?;
        }
        // Codex refreshes its plugin marketplace at startup with a `git ls-remote` of
        // github.com/openai/plugins that it doesn't wait for. On CI runners that fetch can outlive
        // the agent and fail the shutdown check, which is about processes the adapter leaks, not
        // Codex's own plugin sync. Plugins are off here so any other leftover process still shows.
        std::fs::write(root.join("home/.codex/config.toml"), CODEX_SANDBOX_CONFIG).map_err(|e| format!("can't write Codex's sandbox config: {e}"))?;
        // Agents see the resolved path (macOS's /var is /private/var).
        let root = root.canonicalize().unwrap_or(root);
        Ok(Self { root })
    }

    pub fn home(&self) -> PathBuf {
        self.root.join("home")
    }

    /// The folder `session/new` works in.
    pub fn cwd(&self) -> PathBuf {
        self.root.join("work")
    }

    /// The environment the agent gets: only these.
    pub fn env(&self, preset: Option<&Preset>) -> Vec<(String, String)> {
        let home = self.home();
        let at = |rel: &str| home.join(rel).to_string_lossy().into_owned();
        let mut env: Vec<(String, String)> = vec![
            ("PATH".into(), crate::path_env::path().to_string_lossy().into_owned()),
            ("HOME".into(), home.to_string_lossy().into_owned()),
            ("USERPROFILE".into(), home.to_string_lossy().into_owned()),
            ("XDG_CONFIG_HOME".into(), at(".config")),
            ("XDG_DATA_HOME".into(), at(".local/share")),
            ("XDG_CACHE_HOME".into(), at(".cache")),
            ("XDG_STATE_HOME".into(), at(".local/state")),
            ("TMPDIR".into(), self.root.join("tmp").to_string_lossy().into_owned()),
            // Claude Code and Codex read these before HOME.
            ("CLAUDE_CONFIG_DIR".into(), at(".claude")),
            ("CODEX_HOME".into(), at(".codex")),
            ("LANG".into(), "C.UTF-8".into()),
            ("NO_COLOR".into(), "1".into()),
        ];
        env.extend(preset.into_iter().flat_map(|p| p.env.iter()).map(|(k, v)| ((*k).to_owned(), (*v).to_owned())));
        env
    }

    /// `program args…` in this sandbox: in its work folder, with only [`Self::env`].
    pub fn command(&self, program: &str, args: &[String], preset: Option<&Preset>) -> tokio::process::Command {
        let mut cmd = tokio::process::Command::new(program);
        cmd.args(args).current_dir(self.cwd()).env_clear().envs(self.env(preset));
        cmd
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

// ── Tier A ──────────────────────────────────────────────────────────────────

/// What the agent sent on its own while it was checked.
#[derive(Default)]
struct Seen {
    /// `session/update` kinds.
    updates: BTreeSet<String>,
    /// Requests it made (all refused: the suite offers nothing).
    requests: Vec<String>,
}

/// The processes `pid` started (and theirs), still running.
fn descendants(pid: u32) -> Vec<(u32, String)> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let mut found: Vec<(u32, String)> = vec![];
    let mut frontier = vec![pid];
    while let Some(parent) = frontier.pop() {
        for (child, p) in sys.processes() {
            if p.parent().map(sysinfo::Pid::as_u32) == Some(parent) && !found.iter().any(|(c, _)| *c == child.as_u32()) {
                found.push((child.as_u32(), p.name().to_string_lossy().into_owned()));
                frontier.push(child.as_u32());
            }
        }
    }
    found
}

/// Which of `pids` are still running (zombies waiting on a parent don't count as running work, but do count).
fn still_running(pids: &[(u32, String)]) -> Vec<(u32, String)> {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let ids: Vec<Pid> = pids.iter().map(|(p, _)| Pid::from_u32(*p)).collect();
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::Some(&ids), true, ProcessRefreshKind::nothing());
    pids.iter().filter(|(p, _)| sys.process(Pid::from_u32(*p)).is_some()).cloned().collect()
}

fn kill_all(pids: &[(u32, String)]) {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let ids: Vec<Pid> = pids.iter().map(|(p, _)| Pid::from_u32(*p)).collect();
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::Some(&ids), true, ProcessRefreshKind::nothing());
    for id in ids {
        if let Some(p) = sys.process(id) {
            p.kill();
        }
    }
}

/// What an agent advertises that yaah can use, in a word each.
fn advertised(r: &Report) -> String {
    let flags = [
        ("loadSession", r.load_session),
        ("mcp.http", r.mcp_http),
        ("mcp.sse", r.mcp_sse),
        ("systemPrompt", r.system_prompt),
        ("additionalDirectories", r.additional_dirs),
        ("embeddedContext", r.embedded_context),
        ("image", r.image),
    ];
    let on: Vec<&str> = flags.iter().filter(|(_, on)| *on).map(|(n, _)| *n).collect();
    if on.is_empty() { "nothing optional".into() } else { on.join(", ") }
}

/// The capabilities `expect` asks for, as checks.
fn capability_checks(expect: &Expect, init: &Value, report: &Report) -> Vec<Check> {
    let caps = &init["agentCapabilities"];
    let mut checks = vec![];
    let mut need = |name: &str, wanted: bool, has: bool, why: &str| {
        if wanted {
            checks.push(Check::new(
                name,
                has,
                if has { format!("advertised ({why})") } else { format!("no longer advertised; yaah uses it for {why}") },
            ));
        }
    };
    need("capability loadSession", expect.load_session, report.load_session, "reopening chats");
    need("capability mcpCapabilities.http", expect.mcp_http, report.mcp_http, "yaah's UI tools");
    need("capability sessionCapabilities.systemPrompt", expect.system_prompt, report.system_prompt, "the guide in the system prompt");
    need("capability sessionCapabilities.additionalDirectories", expect.additional_dirs, report.additional_dirs, "projects with several folders");
    need("capability promptCapabilities.embeddedContext", expect.embedded_context, report.embedded_context, "the project brief");
    if !caps.is_object() {
        checks.push(Check::fail("agentCapabilities", format!("not an object: {caps}")));
    }
    checks
}

/// `authMethods` parse the way yaah reads them; terminal logins have args to rerun the agent with.
fn auth_checks(expect: &Expect, init: &Value) -> Vec<Check> {
    let raw = &init["authMethods"];
    let list: &[Value] = match raw {
        Value::Null => &[],
        Value::Array(a) => a,
        other => return vec![Check::fail("authMethods", format!("not a list: {other}"))],
    };
    let parsed = agents::auth_methods(list);
    let mut checks = vec![Check::new(
        "authMethods",
        parsed.len() == list.len(),
        if parsed.len() == list.len() {
            let kinds: Vec<String> = parsed.iter().map(|m| format!("{} ({})", m.id, m.kind)).collect();
            if kinds.is_empty() { "none offered".to_owned() } else { kinds.join(", ") }
        } else {
            format!("{} of {} methods have no id yaah can use", list.len() - parsed.len(), list.len())
        },
    )];
    let terminal: Vec<&Value> = list.iter().filter(|m| m["type"] == "terminal").collect();
    let args_ok = |m: &Value| m["args"].as_array().is_some_and(|a| !a.is_empty() && a.iter().all(Value::is_string));
    let bad: Vec<String> = terminal.iter().filter(|m| !args_ok(m)).map(|m| m["id"].as_str().unwrap_or("?").to_owned()).collect();
    if !bad.is_empty() {
        checks.push(Check::fail("authMethods terminal args", format!("terminal method(s) {bad:?} have no args to run")));
    } else if expect.terminal_login {
        checks.push(match terminal.first() {
            Some(m) => Check::pass("authMethods terminal args", format!("{} → {}", m["id"].as_str().unwrap_or("?"), m["args"])),
            None => Check::fail("authMethods terminal args", "no terminal login method; yaah's login runs one"),
        });
    }
    checks
}

/// `session/new` the way `session.rs` sends it, minus yaah's own MCP server.
fn session_params(cwd: &Path, preset: &str, report: &Report) -> Value {
    let mut params = json!({ "cwd": cwd, "mcpServers": [] });
    if report.system_prompt {
        params["systemPrompt"] = json!({ "mode": "append", "content": [{ "type": "text", "text": "yaah conformance check." }] });
    }
    if preset == agents::CLAUDE {
        params["_meta"] = json!({ "claudeCode": { "options": { "allowedTools": crate::ui_mcp::allowed_tools() } } });
    }
    params
}

/// Tier A against `program args…` (an installed version of `preset`). Never
/// signs in, never prompts. Each check gets a [`Check`]; once one fails the
/// agent can't go on from, the rest aren't run.
pub async fn run_checks(preset: &Preset, program: &str, args: &[String]) -> Vec<Check> {
    let expect = expectations(preset.id);
    let mut checks = vec![];
    let sandbox = match Sandbox::new() {
        Ok(s) => s,
        Err(e) => return vec![Check::fail("sandbox", e)],
    };
    let seen = Arc::new(Mutex::new(Seen::default()));
    let seen_in = seen.clone();
    let conn = Connection::spawn(
        sandbox.command(program, args, Some(preset)),
        move |msg, responder| match msg {
            Incoming::Notification { method, params } => {
                if method == "session/update"
                    && let Some(kind) = params["update"]["sessionUpdate"].as_str()
                {
                    seen_in.lock().unwrap().updates.insert(kind.to_owned());
                }
            }
            Incoming::Request { id, method, .. } => {
                seen_in.lock().unwrap().requests.push(method.clone());
                let _ = responder.method_not_found(id, &method);
            }
        },
        |_| {},
    );
    let conn = match conn {
        Ok(c) => c,
        Err(e) => return vec![Check::fail("starts", e)],
    };
    let started = Instant::now();

    // initialize, as yaah sends it.
    let init = match tokio::time::timeout(INIT_TIMEOUT, agents::initialize(&conn)).await {
        Ok(Ok(init)) => {
            checks.push(Check::pass("initialize", format!("answered in {:.1}s", started.elapsed().as_secs_f64())));
            checks.push(terminal_offer_check(true));
            init
        }
        Ok(Err(e)) => {
            checks.push(Check::fail("initialize", e));
            checks.push(terminal_offer_check(false));
            return checks;
        }
        Err(_) => {
            let tail = conn.stderr_tail();
            checks.push(Check::fail(
                "initialize",
                format!("no answer within {INIT_TIMEOUT:?}{}", if tail.is_empty() { String::new() } else { format!(": {tail}") }),
            ));
            checks.push(terminal_offer_check(false));
            let _ = conn.shutdown(Duration::from_secs(1)).await;
            return checks;
        }
    };
    let report = Report::from_initialize(&init);
    if let Some(first) = checks.first_mut() {
        let _ = write!(first.detail, "; advertises {}", advertised(&report));
    }
    let agent = format!("{} {}", report.name.as_deref().unwrap_or("?"), report.version.as_deref().unwrap_or("?"));
    checks.push(Check::new(
        "protocolVersion",
        report.compatible,
        match report.protocol_version {
            Some(v) if report.compatible => format!("{v} ({agent})"),
            Some(v) => format!("{v}; yaah speaks {}", acp::PROTOCOL_VERSION),
            None => format!("missing; yaah speaks {}", acp::PROTOCOL_VERSION),
        },
    ));
    checks.extend(capability_checks(&expect, &init, &report));
    checks.extend(auth_checks(&expect, &init));
    checks.push(unknown_method_check(&conn).await);
    if report.compatible && conn.is_alive() {
        let updates = seen.clone();
        checks.push(
            session_check(&conn, &session_params(&sandbox.cwd(), preset.id, &report), &expect, move || updates.lock().unwrap().updates.clone()).await,
        );
    }
    checks.push(shutdown_check(&conn).await);
    let requests = std::mem::take(&mut seen.lock().unwrap().requests);
    if !requests.is_empty() {
        eprintln!("[conformance] {} asked for {requests:?} (refused)", preset.id);
    }
    checks
}

/// yaah offers client terminals (`clientCapabilities.terminal: true`, `acp_terminals.rs`):
/// `initialize` with that offer must still be answered. Whether the agent then uses
/// them is its choice; one that ignores them runs its commands itself, as before.
fn terminal_offer_check(answered: bool) -> Check {
    const NAME: &str = "initialize with terminal: true";
    if agents::client_capabilities()["terminal"] != true {
        return Check::fail(NAME, "yaah no longer offers client terminals");
    }
    if answered {
        Check::pass(NAME, "answered with client terminals offered")
    } else {
        Check::fail(NAME, "initialize failed with client terminals offered")
    }
}

/// An unknown method: "method not found", and the agent carries on.
async fn unknown_method_check(conn: &Connection) -> Check {
    match tokio::time::timeout(PROBE_TIMEOUT, conn.request(UNKNOWN_METHOD, json!({}))).await {
        Err(_) => Check::fail("unknown method", format!("no answer within {PROBE_TIMEOUT:?}")),
        Ok(Ok(v)) => Check::fail("unknown method", format!("answered {UNKNOWN_METHOD} as if it existed: {v}")),
        Ok(Err(e)) if !conn.is_alive() => Check::fail("unknown method", format!("the agent exited: {e}")),
        Ok(Err(e)) if e.code == METHOD_NOT_FOUND => Check::pass("unknown method", format!("method not found ({})", e.code)),
        Ok(Err(e)) => Check::fail("unknown method", format!("expected method not found ({METHOD_NOT_FOUND}), got {e}")),
    }
}

/// Signed out, `session/new` works or asks for a login in the shape yaah's login
/// flow knows (`acp::AUTH_REQUIRED`). `updates` lists the `session/update` kinds seen so far.
async fn session_check(conn: &Connection, params: &Value, expect: &Expect, updates: impl FnOnce() -> BTreeSet<String>) -> Check {
    const NAME: &str = "session/new signed out";
    match tokio::time::timeout(SESSION_TIMEOUT, conn.request("session/new", params.clone())).await {
        Err(_) => Check::fail(NAME, format!("no answer within {SESSION_TIMEOUT:?}")),
        Ok(Ok(r)) => match r["sessionId"].as_str().filter(|s| !s.is_empty()) {
            Some(id) => {
                let seen = updates();
                let seen = if seen.is_empty() { String::new() } else { format!("; updates: {}", seen.into_iter().collect::<Vec<_>>().join(", ")) };
                Check::pass(NAME, format!("works without a login (session {id}){seen}"))
            }
            None => Check::fail(NAME, format!("answered without a sessionId: {r}")),
        },
        Ok(Err(e)) if e.code == acp::AUTH_REQUIRED => Check::pass(NAME, format!("asks for a login: {e}")),
        Ok(Err(e)) if expect.signed_out_error == Some(e.code) => Check::pass(
            NAME,
            format!("fails as known for {} without a provider (no login to offer; a provider binding makes it ready): {e}", expect.preset),
        ),
        Ok(Err(e)) => Check::fail(NAME, format!("expected a session or auth-required ({}), got {e}", acp::AUTH_REQUIRED)),
    }
}

/// Clean shutdown: close stdin, it exits, and nothing it started keeps running.
/// Anything left is killed.
async fn shutdown_check(conn: &Connection) -> Check {
    let children = conn.pid().map(descendants).unwrap_or_default();
    let stopped = conn.shutdown(EXIT_TIMEOUT).await;
    // Give its children a moment to see their parent go.
    let mut left = still_running(&children);
    let grace = Instant::now();
    while !left.is_empty() && grace.elapsed() < CHILD_GRACE {
        tokio::time::sleep(Duration::from_millis(100)).await;
        left = still_running(&left);
    }
    kill_all(&left);
    match (stopped, left.is_empty()) {
        (Ok(status), true) => Check::pass("shutdown", format!("exited ({status}) after stdin closed")),
        (Ok(status), false) => {
            let names: Vec<String> = left.iter().map(|(p, n)| format!("{n} ({p})")).collect();
            Check::fail("shutdown", format!("exited ({status}) but left {} process(es) running after {CHILD_GRACE:?}: {names:?}", left.len()))
        }
        (Err(e), _) => Check::fail("shutdown", e),
    }
}

// ── Provider mode ───────────────────────────────────────────────────────────

/// One prompt on the stub: a tool call, its result, a reply.
pub const PROMPT_TIMEOUT: Duration = Duration::from_secs(180);
/// What provider mode asks; the stub decides what actually happens.
pub const PROVIDER_PROMPT: &str = "Look at the files in this folder with one of your tools, then reply with one word: done.";

/// The read-only tool each agent is asked to call on the stub, when it offers it
/// (else the stub picks a read-only-looking one and builds its arguments).
fn tool_plan(cwd: &Path) -> Vec<Plan> {
    let cwd = cwd.to_string_lossy();
    vec![
        // Claude Code (it offers Read, not Glob, to a session without a login)
        Plan::new("Read", json!({ "file_path": format!("{cwd}/README.md") })),
        // OpenCode
        Plan::new("glob", json!({ "pattern": "*" })),
        Plan::new("read", json!({ "filePath": format!("{cwd}/README.md") })),
        // goose's developer extension
        Plan::new("developer__tree", json!({ "path": cwd })),
        Plan::new("tree", json!({ "path": cwd })),
        Plan::new("developer__shell", json!({ "command": "ls" })),
        Plan::new("shell", json!({ "command": "ls" })),
    ]
}

/// Every running process from `pid` down, with its command line.
fn argv_tree(pid: u32) -> Vec<(u32, String)> {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always));
    let mut ids = vec![pid];
    ids.extend(descendants(pid).into_iter().map(|(p, _)| p));
    ids.into_iter()
        .filter_map(|p| sys.process(Pid::from_u32(p)).map(|proc_| (p, proc_.cmd().iter().map(|a| a.to_string_lossy()).collect::<Vec<_>>().join(" "))))
        .collect()
}

/// What the agent sent while a provider-mode prompt ran.
#[derive(Default)]
struct Turn {
    updates: BTreeSet<String>,
    tool_titles: Vec<String>,
    text: String,
    permissions: usize,
}

/// Provider mode: `program args…` (an installed version of `preset`) started
/// on its translated OpenRouter route (`agent_routes::route_with`) pointed at a
/// local stub ([`crate::provider_stub`]), in a [`Sandbox`]. Checks that:
///
/// - `session/new` works without asking for a login (no `-32000`);
/// - one prompt streams, with a tool call, and ends;
/// - the bound model id, and the route's key, reached the stub;
/// - no secret is in the argv of the agent or anything it started.
///
/// Presets without a route get one failed `route` check.
pub async fn run_provider_checks(preset: &Preset, program: &str, args: &[String]) -> Vec<Check> {
    run_provider_checks_via(preset, program, args, crate::agent_routes::ClaudeOpenRouter::Env).await
}

/// [`run_provider_checks`], with Claude Code reaching the stub the way `via` says (env, or ACP `providers/set`).
pub async fn run_provider_checks_via(preset: &Preset, program: &str, args: &[String], via: crate::agent_routes::ClaudeOpenRouter) -> Vec<Check> {
    use crate::agent_routes::{Endpoints, Options, route_with};
    use crate::provider_stub::{STUB_KEY, STUB_MODEL, Stub};
    use crate::providers::{Binding, Kind, ResolvedProvider};
    let sandbox = match Sandbox::new() {
        Ok(s) => s,
        Err(e) => return vec![Check::fail("sandbox", e)],
    };
    let _ = std::fs::write(sandbox.cwd().join("README.md"), "yaah conformance\n");
    let stub = match Stub::start(tool_plan(&sandbox.cwd()), &sandbox.cwd().to_string_lossy()) {
        Ok(s) => s,
        Err(e) => return vec![Check::fail("stub", e)],
    };
    let provider = ResolvedProvider {
        id: "stub".into(),
        kind: Kind::Openrouter,
        label: "conformance stub".into(),
        bedrock: None,
        secret: Some(crate::keychain::SecretString::new(STUB_KEY)),
    };
    let binding = Binding { provider_id: "stub".into(), model: STUB_MODEL.into(), small_model: None };
    let opts = Options { endpoints: Endpoints { openrouter: stub.openrouter_base() }, claude_openrouter: via };
    let route = match route_with(preset.id, &provider, &binding, &sandbox.root.join("profile"), &opts) {
        Ok(r) => r,
        Err(e) => return vec![Check::fail("route", e.0)],
    };
    if let Err(e) = route.write_files() {
        return vec![Check::fail("route", e)];
    }
    let mut cmd = sandbox.command(program, args, Some(preset));
    for k in &route.env_remove {
        cmd.env_remove(k);
    }
    cmd.envs(&route.env);
    let command_line: Vec<String> = std::iter::once(program.to_owned()).chain(args.iter().cloned()).collect();
    let (mut checks, conn) = drive_on_route(preset, cmd, &route, &sandbox.cwd()).await;
    let Some(conn) = conn else { return checks };

    // What the stub saw: the bound model and the route's key.
    let calls = stub.model_calls();
    let models: BTreeSet<String> = calls.iter().filter_map(|s| s.model.clone()).collect();
    let keyed = calls
        .iter()
        .filter(|s| s.authorization.as_deref() == Some(&format!("Bearer {STUB_KEY}")[..]) || s.x_api_key.as_deref() == Some(STUB_KEY))
        .count();
    let apis: BTreeSet<&str> = calls.iter().map(|s| s.api.as_str()).collect();
    let called: Vec<&str> = calls.iter().filter_map(|s| s.called.as_deref()).collect();
    // What credentials arrived instead, when not the route's key (the key itself redacted).
    let auths: BTreeSet<String> =
        calls.iter().flat_map(|s| [s.authorization.clone(), s.x_api_key.clone()]).flatten().map(|a| a.replace(STUB_KEY, "<key>")).collect();
    checks.push(Check::new(
        "model reached the stub",
        models.len() == 1 && models.contains(STUB_MODEL) && keyed == calls.len() && !calls.is_empty(),
        format!(
            "{} call(s) over {apis:?} for {models:?} (only the bound model may be used); {keyed} with the route's key (credentials seen: {auths:?}); tools called {called:?} of {} offered",
            calls.len(),
            calls.iter().map(|s| s.tools.len()).max().unwrap_or(0)
        ),
    ));
    checks.push(argv_check(&conn, &command_line, &[STUB_KEY]));
    checks.push(shutdown_check(&conn).await);
    checks
}

/// Start `cmd` (an agent on `route`), then `initialize`, the route's
/// `providers/set`, `session/new` in `cwd` and one prompt. Returns the checks,
/// and the agent still running unless it couldn't start or initialize.
async fn drive_on_route(
    preset: &Preset,
    cmd: tokio::process::Command,
    route: &crate::agent_routes::Route,
    cwd: &Path,
) -> (Vec<Check>, Option<Arc<Connection>>) {
    const NEW: &str = "session/new on the provider";
    const PROMPT: &str = "prompt streams a tool call";
    let mut checks = vec![];
    let turn = Arc::new(Mutex::new(Turn::default()));
    let seen = turn.clone();
    let conn = Connection::spawn(
        cmd,
        move |msg, responder| match msg {
            Incoming::Notification { method, params } if method == "session/update" => {
                let u = &params["update"];
                let mut t = seen.lock().unwrap();
                if let Some(kind) = u["sessionUpdate"].as_str() {
                    t.updates.insert(kind.to_owned());
                    if kind == "tool_call" {
                        t.tool_titles.push(u["title"].as_str().unwrap_or("?").to_owned());
                    }
                    if kind == "agent_message_chunk" {
                        t.text.push_str(u["content"]["text"].as_str().unwrap_or_default());
                    }
                }
            }
            Incoming::Notification { .. } => {}
            // Allow what the scripted turn asks (a read-only tool in the sandbox).
            Incoming::Request { id, method, params } if method == "session/request_permission" => {
                seen.lock().unwrap().permissions += 1;
                let options = params["options"].as_array().cloned().unwrap_or_default();
                let allow = options.iter().find(|o| o["kind"] == "allow_once").or_else(|| options.iter().find(|o| o["kind"] == "allow_always"));
                let outcome = match allow.or(options.first()).and_then(|o| o["optionId"].as_str()) {
                    Some(o) => json!({ "outcome": { "outcome": "selected", "optionId": o } }),
                    None => json!({ "outcome": { "outcome": "cancelled" } }),
                };
                responder.ok(id, outcome);
            }
            Incoming::Request { id, method, .. } => {
                let _ = responder.method_not_found(id, &method);
            }
        },
        |_| {},
    );
    let conn = match conn {
        Ok(c) => c,
        Err(e) => return (vec![Check::fail("starts", e)], None),
    };
    let init = match tokio::time::timeout(INIT_TIMEOUT, agents::initialize(&conn)).await {
        Ok(Ok(init)) => init,
        Ok(Err(e)) => return (vec![Check::fail("initialize", e)], None),
        Err(_) => {
            let _ = conn.shutdown(Duration::from_secs(1)).await;
            return (vec![Check::fail("initialize", format!("no answer within {INIT_TIMEOUT:?}"))], None);
        }
    };
    if let Err(e) = crate::agent_routes::providers_set(&conn, &init, Some(route)).await {
        checks.push(Check::fail("providers/set", e));
    }
    let report = Report::from_initialize(&init);

    // session/new: the provider is set, so no login is asked for.
    let session = match tokio::time::timeout(SESSION_TIMEOUT, conn.request("session/new", session_params(cwd, preset.id, &report))).await {
        Err(_) => Err(Check::fail(NEW, format!("no answer within {SESSION_TIMEOUT:?}"))),
        Ok(Err(e)) if e.code == acp::AUTH_REQUIRED => Err(Check::fail(NEW, format!("asked for a login although the route sets the provider: {e}"))),
        Ok(Err(e)) => Err(Check::fail(NEW, format!("failed: {e}{}", stderr_note(&conn)))),
        Ok(Ok(r)) => match r["sessionId"].as_str().filter(|s| !s.is_empty()) {
            Some(id) => {
                checks.push(Check::pass(NEW, format!("session {id}, no login asked")));
                Ok(id.to_owned())
            }
            None => Err(Check::fail(NEW, format!("answered without a sessionId: {r}"))),
        },
    };

    // One prompt: it streams, calls a tool, ends.
    if let Ok(sid) = session.map_err(|c| checks.push(c)) {
        let params = json!({ "sessionId": sid, "prompt": [{ "type": "text", "text": PROVIDER_PROMPT }] });
        let started = Instant::now();
        let check = match tokio::time::timeout(PROMPT_TIMEOUT, conn.request("session/prompt", params)).await {
            Err(_) => Check::fail(PROMPT, format!("no answer within {PROMPT_TIMEOUT:?}{}", stderr_note(&conn))),
            Ok(Err(e)) => Check::fail(PROMPT, format!("failed: {e}{}", stderr_note(&conn))),
            Ok(Ok(r)) => {
                let t = turn.lock().unwrap();
                let stop = r["stopReason"].as_str().unwrap_or("?");
                let detail = format!(
                    "{stop} in {:.1}s; tool calls {:?}; {} permission request(s); reply {:?}",
                    started.elapsed().as_secs_f64(),
                    t.tool_titles,
                    t.permissions,
                    t.text.chars().take(80).collect::<String>()
                );
                let streamed = t.updates.contains("tool_call") && t.updates.contains("agent_message_chunk");
                Check::new(PROMPT, streamed && stop == "end_turn", if streamed { detail } else { format!("updates {:?}; {detail}", t.updates) })
            }
        };
        checks.push(check);
    }
    (checks, Some(conn))
}

/// No secret on any command line: ours (`argv`), the agent's, or anything it started.
fn argv_check(conn: &Connection, argv: &[String], secrets: &[&str]) -> Check {
    let secrets: Vec<&str> = secrets.iter().copied().filter(|s| !s.is_empty()).collect();
    let holds = |a: &str| secrets.iter().any(|s| a.contains(s));
    let redact = |a: &str| secrets.iter().fold(a.to_owned(), |a, s| a.replace(s, "<key>"));
    let mut exposed: Vec<String> = argv.iter().filter(|a| holds(a)).map(|a| redact(a)).collect();
    let tree = conn.pid().map(argv_tree).unwrap_or_default();
    exposed.extend(tree.iter().filter(|(_, a)| holds(a)).map(|(p, a)| {
        let redacted = redact(a);
        let at = redacted.find("<key>").unwrap_or(0);
        let start = (0..=at.saturating_sub(60)).rev().find(|i| redacted.is_char_boundary(*i)).unwrap_or(0);
        format!("process {p}: …{}…", redacted[start..].chars().take(80).collect::<String>())
    }));
    Check::new(
        "no secret in argv",
        exposed.is_empty(),
        if exposed.is_empty() {
            format!("checked {} process(es)", tree.len().max(1))
        } else {
            format!("the key is on the command line of {exposed:?}")
        },
    )
}

fn stderr_note(conn: &Connection) -> String {
    let tail = conn.stderr_tail();
    let last: Vec<&str> = tail.lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect();
    if last.is_empty() { String::new() } else { format!("\n{}", last.join("\n")) }
}

// ── npm audit ───────────────────────────────────────────────────────────────

/// Why an audit has no answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuditError {
    /// The registry couldn't be reached (offline, a proxy): keep the last result.
    Unavailable(String),
    /// Anything else: npm missing, no lockfile, unreadable output.
    Failed(String),
}

impl std::fmt::Display for AuditError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuditError::Unavailable(e) | AuditError::Failed(e) => f.write_str(e),
        }
    }
}

/// `npm audit --json --omit=dev` in an installed version's folder (its
/// `package-lock.json`). Through `path_env::command`, never a shell; stopped
/// after [`AUDIT_TIMEOUT`]. `env` adds variables (tests point npm at a stand-in registry).
pub fn audit(dir: &Path, env: &[(&str, &str)]) -> Result<Vec<Advisory>, AuditError> {
    let npm = crate::path_env::which("npm").ok_or_else(|| AuditError::Failed("npm isn't on your PATH".into()))?;
    if !dir.join("package-lock.json").is_file() {
        return Err(AuditError::Failed(format!("no package-lock.json in {}", dir.display())));
    }
    let mut child = crate::path_env::command(npm)
        .args(["audit", "--json", "--omit=dev", "--no-update-notifier", "--fetch-retries=1"])
        .current_dir(dir)
        .envs(env.iter().copied())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| AuditError::Failed(format!("couldn't start npm: {e}")))?;
    // Read stdout on its own thread so a large report can't fill the pipe while we wait.
    let mut stdout = child.stdout.take().ok_or_else(|| AuditError::Failed("npm started without stdout".into()))?;
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        out
    });
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() > AUDIT_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AuditError::Unavailable(format!("npm audit took longer than {AUDIT_TIMEOUT:?}")));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(AuditError::Failed(e.to_string())),
        }
    }
    let out = reader.join().unwrap_or_default();
    // npm exits 1 when it finds advisories: the JSON says what happened, not the status.
    let doc: Value = serde_json::from_slice(&out).map_err(|_| {
        AuditError::Failed(format!("npm audit printed no JSON: {}", String::from_utf8_lossy(&out).chars().take(200).collect::<String>()))
    })?;
    parse_audit(&doc)
}

/// Advisories in an `npm audit --json` report (v2), one per advisory, sorted
/// most severe first. A report that is an error says whether the registry was
/// out of reach.
pub fn parse_audit(doc: &Value) -> Result<Vec<Advisory>, AuditError> {
    if let Some(err) = doc.get("error") {
        let code = err["code"].as_str().unwrap_or_default();
        let text = [doc["message"].as_str(), err["summary"].as_str(), err["detail"].as_str()]
            .into_iter()
            .flatten()
            .find(|t| !t.is_empty())
            .unwrap_or(code)
            .to_owned();
        let network =
            ["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "request to", "audit endpoint"];
        let unreachable = network.iter().any(|n| code.contains(n) || text.contains(n)) || (code.is_empty() && text.is_empty());
        return Err(if unreachable {
            AuditError::Unavailable(if text.is_empty() { "the registry didn't answer".into() } else { text })
        } else {
            AuditError::Failed(format!("{code} {text}").trim().to_owned())
        });
    }
    let Some(vulns) = doc["vulnerabilities"].as_object() else {
        return Err(AuditError::Failed("npm audit's report has no `vulnerabilities`".into()));
    };
    let mut seen = HashSet::new();
    let mut out = vec![];
    for v in vulns.values() {
        // `via` holds advisories, or names of packages that are vulnerable through one (listed on their own).
        for via in v["via"].as_array().into_iter().flatten().filter(|x| x.is_object()) {
            let url = via["url"].as_str().unwrap_or_default().to_owned();
            let id = url
                .rsplit('/')
                .next()
                .filter(|s| s.starts_with("GHSA-") || s.starts_with("CVE-"))
                .map(str::to_owned)
                .or_else(|| via["source"].as_u64().map(|s| format!("npm-{s}")))
                .unwrap_or_else(|| "unknown".into());
            if seen.insert(id.clone()) {
                let pkg = via["name"].as_str().or(v["name"].as_str()).unwrap_or("?");
                let title = via["title"].as_str().unwrap_or("advisory");
                out.push(Advisory {
                    id,
                    severity: via["severity"].as_str().or(v["severity"].as_str()).unwrap_or("unknown").to_owned(),
                    title: format!("{title} ({pkg} {})", via["range"].as_str().unwrap_or("")).replace(" )", ")"),
                    url,
                });
            }
        }
    }
    let rank = |s: &str| ["critical", "high", "moderate", "low", "info"].iter().position(|x| *x == s).unwrap_or(5);
    out.sort_by(|a, b| rank(&a.severity).cmp(&rank(&b.severity)).then_with(|| a.id.cmp(&b.id)));
    Ok(out)
}

/// The audit, into `report`: new advisories when it answered, else the last ones kept.
fn audit_into(report: &mut SuiteReport, result: Result<Vec<Advisory>, AuditError>, previous: Option<&SuiteReport>) {
    match result {
        Ok(advisories) => {
            report.advisories = advisories;
            report.audit = AuditState::Ok;
            report.audit_detail = None;
            report.audited_at = Some(now());
        }
        Err(e) => {
            report.audit = if matches!(e, AuditError::Unavailable(_)) { AuditState::Unavailable } else { AuditState::Error };
            report.audit_detail = Some(e.to_string());
            if let Some(p) = previous {
                report.advisories.clone_from(&p.advisories);
                report.audited_at = p.audited_at;
            }
        }
    }
}

// ── The suite ───────────────────────────────────────────────────────────────

/// Tier A and the audit on an installed version: `program args…` starts it,
/// `dir` is its folder. `previous` is its last report (its audit stands when
/// the registry can't be reached).
pub async fn run_suite(preset: &Preset, version: &str, program: &str, args: &[String], dir: &Path, previous: Option<&SuiteReport>) -> SuiteReport {
    let started = Instant::now();
    let checks = run_checks(preset, program, args).await;
    let mut report = SuiteReport { version: version.to_owned(), checks, checked_at: now(), ..SuiteReport::default() };
    if agent_install::is_binary(dir) {
        // A release archive: no npm dependencies to audit; its sha256 was checked when it was installed.
        report.audit_detail = Some("a release archive (sha256-checked), not an npm package: nothing to audit".into());
    } else {
        let dir = dir.to_owned();
        let result = tokio::task::spawn_blocking(move || audit(&dir, &[])).await.unwrap_or_else(|e| Err(AuditError::Failed(e.to_string())));
        audit_into(&mut report, result, previous);
    }
    report.seconds = (started.elapsed().as_secs_f64() * 10.0).round() / 10.0;
    report
}

/// Verify `version` of `preset` under `versions`' root: install it if it
/// isn't, run the suite, store the report, and for a version yaah tracks (a
/// candidate, or one verified before) record the verdict and promote it when
/// everything passed. A version that was verified and now fails is marked
/// failed, so what runs falls back to the newest one still verified. The pin,
/// or a held version yaah never checked, only gets its report.
pub async fn verify(versions: &Versions, preset_id: &str, version: &str) -> Result<SuiteReport, String> {
    let preset = agents::preset(preset_id).ok_or_else(|| format!("unknown agent preset {preset_id}"))?;
    let pinned = preset.spec().ok_or_else(|| format!("{} isn't installed by yaah", preset.label))?;
    let spec = pinned.at(version)?;
    let root = versions.root().to_owned();
    {
        let (spec, archive) = (spec.clone(), versions.archive_for(&spec)?);
        let root = root.clone();
        tokio::task::spawn_blocking(move || agent_install::ensure_source(&root, &spec, archive.as_ref())).await.map_err(|e| e.to_string())??;
    }
    let (program, args) = versions.candidate_command(preset_id, version)?;
    let record = versions.records().get(preset_id).and_then(|r| r.get(version)).cloned();
    // A verified version keeps running while it's re-checked; anything else is `verifying` meanwhile.
    if record.as_ref().is_some_and(|r| r.status != Status::Verified) {
        versions.begin_verification(preset_id, version)?;
    }
    let results = Results::at(&root);
    let previous = results.get(preset_id, version);
    let mut report = run_suite(preset, version, &program, &args, &agent_install::dir(&root, &spec), previous.as_ref()).await;
    if record.is_some() {
        let outcome = report.outcome();
        versions.record_result(preset_id, version, &outcome)?;
        if outcome.failures.is_empty() {
            versions.promote(preset_id, version)?;
            report.promoted = true;
        }
    }
    results.put(preset_id, &report)?;
    Ok(report)
}

/// The suite, as `agent_versions`' hook: each candidate the daily check
/// installs is verified on the thread that installed it.
pub struct Suite;

impl Verifier for Suite {
    fn candidate_installed(&self, versions: &Versions, preset: &str, version: &str) {
        match tauri::async_runtime::block_on(verify(versions, preset, version)) {
            Ok(r) if r.promoted => eprintln!("[conformance] {preset} {version} passed and runs from the next start"),
            Ok(r) => eprintln!("[conformance] {preset} {version} failed: {:?}", r.outcome().failures),
            Err(e) => eprintln!("[conformance] couldn't check {preset} {version}: {e}"),
        }
    }
}

/// Audit the version of each preset in use that runs now, when its last audit
/// is older than [`AUDIT_EVERY`] (or `force`). Offline, the last result stays.
/// Returns the presets audited.
pub async fn audit_active(versions: &Versions, in_use: &BTreeSet<&'static str>, force: bool) -> Vec<String> {
    let holds = crate::settings::agent_versions();
    let results = Results::at(versions.root());
    let stale = now().saturating_sub(AUDIT_EVERY.as_secs());
    let mut done = vec![];
    for preset in agents::PRESETS.iter().filter(|p| in_use.contains(p.id)) {
        let Some(active) = versions.active(preset, &holds) else { continue };
        let previous = results.get(preset.id, &active.version);
        if !force && previous.as_ref().and_then(|p| p.audited_at).is_some_and(|t| t > stale) {
            continue;
        }
        let dir = agent_install::dir(versions.root(), &active);
        // Release archives have no npm dependencies to audit.
        if agent_install::installed(versions.root(), &active).is_none() || agent_install::is_binary(&dir) {
            continue;
        }
        let result = tokio::task::spawn_blocking(move || audit(&dir, &[])).await.unwrap_or_else(|e| Err(AuditError::Failed(e.to_string())));
        let mut report = previous.clone().unwrap_or_else(|| SuiteReport { version: active.version.clone(), ..SuiteReport::default() });
        audit_into(&mut report, result, previous.as_ref());
        if let Err(e) = results.put(preset.id, &report) {
            eprintln!("[conformance] couldn't save the audit of {} {}: {e}", preset.id, active.version);
        }
        done.push(preset.id.to_owned());
    }
    done
}

/// The daily audit of what runs, in the background for as long as the app runs.
pub fn watch_advisories() {
    tauri::async_runtime::spawn(async {
        loop {
            let in_use = agents::presets_in_use(&agents::Store::user().load());
            audit_active(Versions::user(), &in_use, false).await;
            tokio::time::sleep(Duration::from_hours(1)).await;
        }
    });
}

// ── Tier B ──────────────────────────────────────────────────────────────────

/// Tier B: checks that need a signed-in agent and spend a few cheap prompts.
/// **Prepared, not active.** Nothing here runs from the app: [`ENABLED`] is
/// false and the setting (`liveAdapterTests` in `settings.json`, shown in
/// Settings → Agents as "coming soon") has no effect yet. The checks run only
/// as `#[ignore]`d tests (`session.rs` `mod live_tests`, `live_adapter_*`),
/// against an account given in `YAAH_LIVE_ACCOUNT` and, with
/// `YAAH_LIVE_CANDIDATE=<version>`, a candidate installed under `~/.yaah/agents`.
///
/// How it will gate promotion once switched on:
///
/// 1. tier A and the audit run first, as now; a failure there stops the run;
/// 2. if the user turned the setting on and a saved, signed-in profile uses the
///    preset, each [`CHECKS`] row runs once against the candidate with that
///    profile's credentials (its config dir and env; the candidate's command),
///    in a fresh temp project, with permission requests answered by the live
///    harness's `harness_allows` (writes inside the temp folder only);
/// 3. any failing row is added to the failures as `live <name>: <detail>`, so
///    `record_result` marks the version failed and it never runs; all passing
///    (or no signed-in profile, recorded as a note) lets `promote` go ahead;
/// 4. a row that can't apply to an agent (no `loadSession`, no HTTP MCP) is
///    skipped for it, by the same [`Expect`] table tier A uses.
pub mod live {
    use serde_json::Value;

    /// Off until tier B is switched on; the setting can't override it.
    pub const ENABLED: bool = false;

    /// How a check drives the chat.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Flow {
        /// The prompts in order, one turn each.
        Turns,
        /// The first prompt, cancelled once the agent starts answering.
        CancelMidTurn,
        /// The first prompt, then a fresh yaah (a restart) reopens the chat with
        /// `session/load` and sends the second.
        Reload,
        /// The prompts, with yaah's UI server advertised at a port nothing listens
        /// on, so the agent has an MCP server that can't start to tell the user about.
        BrokenMcp,
    }

    /// What a check sees: the chat's entries and every event the UI got, as JSON.
    pub struct Transcript<'a> {
        pub entries: &'a [Value],
        pub events: &'a [Value],
        /// The temp project folder.
        pub root: &'a std::path::Path,
    }

    /// One live check: how to run it and how to judge what came back.
    pub struct LiveCheck {
        pub name: &'static str,
        pub flow: Flow,
        pub prompts: &'static [&'static str],
        /// yaah's UI server is attached (the agent can call `ui_*` tools).
        pub ui: bool,
        /// Only for agents with this capability (see `Expect`).
        pub needs: fn(&super::Expect) -> bool,
        pub judge: fn(&Transcript<'_>) -> Result<(), String>,
    }

    fn always(_: &super::Expect) -> bool {
        true
    }

    fn of_type<'a>(t: &'a Transcript<'_>, kind: &'a str) -> impl Iterator<Item = &'a Value> + 'a {
        t.entries.iter().filter(move |e| e["type"] == kind)
    }

    fn updates_of<'a>(t: &'a Transcript<'_>, event: &'a str) -> impl Iterator<Item = &'a Value> + 'a {
        t.events.iter().filter(move |e| e["event"] == event).map(|e| &e["payload"])
    }

    fn streams(t: &Transcript<'_>) -> Result<(), String> {
        let text: String = of_type(t, "agent").filter_map(|e| e["text"].as_str()).collect();
        // Chunks merge into one entry that the UI saw grow.
        let growth = updates_of(t, "session-entry").filter(|p| p["entry"]["type"] == "agent").count();
        if !text.to_lowercase().contains("yaah") {
            return Err(format!("the reply doesn't contain the word asked for: {text:?}"));
        }
        if growth < 2 {
            return Err(format!("the reply came in {growth} update(s); expected agent_message_chunks that assemble"));
        }
        Ok(())
    }

    fn ui_tool_call(t: &Transcript<'_>) -> Result<(), String> {
        let calls: Vec<&Value> = updates_of(t, "session-entry")
            .filter(|p| p["entry"]["type"] == "tool" && p["entry"]["title"].as_str().is_some_and(|s| s.contains("ui_catalog")))
            .collect();
        let statuses: Vec<&str> = calls.iter().filter_map(|p| p["entry"]["status"].as_str()).collect();
        if calls.is_empty() {
            return Err("no ui_catalog tool call arrived".into());
        }
        if !statuses.contains(&"completed") || calls.len() < 2 {
            return Err(format!("ui_catalog arrived without status updates to completed: {statuses:?}"));
        }
        Ok(())
    }

    fn permission_round_trip(t: &Transcript<'_>) -> Result<(), String> {
        let asked = of_type(t, "permission").find(|e| e["chosen"].is_string()).ok_or("no permission request was answered")?;
        let written = std::fs::read_to_string(t.root.join("repo/conformance.txt")).unwrap_or_default();
        if written.trim() != "ok" {
            return Err(format!("after allowing {:?} the file holds {written:?}", asked["title"]));
        }
        Ok(())
    }

    fn cancelled(t: &Transcript<'_>) -> Result<(), String> {
        let stop = updates_of(t, "session-info").filter_map(|p| p["stopReason"].as_str()).last().unwrap_or_default();
        if stop == "cancelled" { Ok(()) } else { Err(format!("the turn ended with {stop:?}, not cancelled")) }
    }

    fn reloads(t: &Transcript<'_>) -> Result<(), String> {
        let last = of_type(t, "agent").filter_map(|e| e["text"].as_str()).last().unwrap_or_default();
        if last.to_lowercase().contains("pelican") { Ok(()) } else { Err(format!("after session/load the agent didn't remember: {last:?}")) }
    }

    fn notices(t: &Transcript<'_>) -> Result<(), String> {
        let items: Vec<&Value> = of_type(t, "notices").flat_map(|e| e["items"].as_array().into_iter().flatten()).collect();
        if items.is_empty() { Err("no notice arrived for the MCP server that can't start".into()) } else { Ok(()) }
    }

    fn commands(t: &Transcript<'_>) -> Result<(), String> {
        let any = updates_of(t, "session-info").any(|p| p["commands"].as_array().is_some_and(|c| !c.is_empty()));
        if any { Ok(()) } else { Err("no available_commands_update reached the chat".into()) }
    }

    /// The tier B checks, cheapest first. Each runs in its own chat.
    pub const CHECKS: &[LiveCheck] = &[
        LiveCheck {
            name: "prompt streams",
            flow: Flow::Turns,
            prompts: &["Reply with exactly three words, the first being yaah. No tools."],
            ui: false,
            needs: always,
            judge: streams,
        },
        LiveCheck {
            name: "available commands",
            flow: Flow::Turns,
            prompts: &["Reply with: ok. No tools."],
            ui: false,
            needs: always,
            judge: commands,
        },
        LiveCheck {
            name: "ui tool call",
            flow: Flow::Turns,
            prompts: &["Call the yaah-ui tool ui_catalog once (load it with ToolSearch if it's deferred), then reply with: done."],
            ui: true,
            needs: |e| e.mcp_http,
            judge: ui_tool_call,
        },
        LiveCheck {
            name: "permission round trip",
            flow: Flow::Turns,
            prompts: &["Use your Write tool to create conformance.txt in the current directory containing exactly `ok`, then reply with: done."],
            ui: false,
            needs: always,
            judge: permission_round_trip,
        },
        LiveCheck {
            name: "cancel mid-turn",
            flow: Flow::CancelMidTurn,
            prompts: &["Count from 1 to 400, one number per line, no tools."],
            ui: false,
            needs: always,
            judge: cancelled,
        },
        LiveCheck {
            name: "session/load replays",
            flow: Flow::Reload,
            prompts: &["Remember the word pelican. Reply with: noted.", "Which word did I ask you to remember? One word."],
            ui: false,
            needs: |e| e.load_session,
            judge: reloads,
        },
        LiveCheck {
            name: "notices",
            flow: Flow::BrokenMcp,
            prompts: &["Reply with: ok. No tools."],
            ui: false,
            needs: |e| e.mcp_http,
            judge: notices,
        },
    ];
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_install::tests::temp_dir;

    #[test]
    fn every_installed_preset_has_a_row_and_rows_are_presets() {
        for e in EXPECTATIONS {
            let p = agents::preset(e.preset).unwrap_or_else(|| panic!("{} isn't a preset", e.preset));
            assert!(p.spec().is_some(), "{} isn't installed by yaah", e.preset);
        }
        for p in agents::PRESETS.iter().filter(|p| p.spec().is_some()) {
            assert_eq!(expectations(p.id).preset, p.id, "{} has no row", p.id);
        }
        assert_eq!(expectations("kimi"), Expect::default());
    }

    #[test]
    fn reads_npm_audit_reports() {
        let doc = json!({
            "auditReportVersion": 2,
            "vulnerabilities": {
                "minimist": { "name": "minimist", "severity": "critical", "via": [
                    { "source": 1_096_465, "name": "minimist", "title": "Prototype Pollution in minimist", "url": "https://github.com/advisories/GHSA-vh95-rmgr-6w4m", "severity": "moderate", "range": ">=1.0.0 <1.2.3" },
                    { "source": 1_097_678, "name": "minimist", "title": "Prototype Pollution in minimist", "url": "https://github.com/advisories/GHSA-xvch-5gv4-984h", "severity": "critical", "range": ">=1.0.0 <1.2.6" }
                ] },
                // Vulnerable only through minimist: no advisory of its own.
                "mkdirp": { "name": "mkdirp", "severity": "critical", "via": ["minimist"] },
                "odd": { "name": "odd", "severity": "low", "via": [{ "source": 7, "title": "No URL", "severity": "low" }] }
            },
            "metadata": { "vulnerabilities": { "critical": 2, "total": 3 } }
        });
        let got = parse_audit(&doc).unwrap();
        let ids: Vec<&str> = got.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, ["GHSA-xvch-5gv4-984h", "GHSA-vh95-rmgr-6w4m", "npm-7"], "most severe first, once each");
        assert_eq!(got[0].severity, "critical");
        assert_eq!(got[0].title, "Prototype Pollution in minimist (minimist >=1.0.0 <1.2.6)");
        assert_eq!(got[0].url, "https://github.com/advisories/GHSA-xvch-5gv4-984h");
        assert!(blocks(&got[0]) && !blocks(&got[1]) && !blocks(&got[2]));
        assert_eq!(parse_audit(&json!({ "auditReportVersion": 2, "vulnerabilities": {} })).unwrap(), Vec::<Advisory>::new());

        // Offline (what npm 11 prints) is "unavailable"; a missing lockfile is an error.
        let offline = json!({ "message": "request to http://127.0.0.1:9/-/npm/v1/security/advisories/bulk failed, reason: connect ECONNREFUSED 127.0.0.1:9", "error": { "summary": "", "detail": "" } });
        assert!(matches!(parse_audit(&offline), Err(AuditError::Unavailable(m)) if m.contains("ECONNREFUSED")));
        let nolock = json!({ "error": { "code": "ENOLOCK", "summary": "This command requires an existing lockfile.", "detail": "" } });
        assert!(matches!(parse_audit(&nolock), Err(AuditError::Failed(m)) if m.contains("ENOLOCK")));
        assert!(matches!(parse_audit(&json!({})), Err(AuditError::Failed(_))));
    }

    #[test]
    fn outcomes_fail_on_checks_and_blocking_advisories_only() {
        let adv = |sev: &str| Advisory { id: format!("GHSA-{sev}"), severity: sev.into(), title: "t".into(), url: String::new() };
        let mut r = SuiteReport {
            version: "1.0.0".into(),
            checks: vec![Check::pass("initialize", "ok")],
            advisories: vec![adv("moderate"), adv("low")],
            ..SuiteReport::default()
        };
        assert!(r.passed(), "moderate and low are shown, not blocking");
        assert_eq!(r.outcome().advisories.len(), 2);
        r.advisories.push(adv("High"));
        r.checks.push(Check::fail("shutdown", "still running"));
        assert_eq!(r.outcome().failures, ["shutdown: still running", "High advisory GHSA-High: t"]);
    }

    #[test]
    fn an_unavailable_audit_keeps_the_last_answer() {
        let adv = Advisory { id: "GHSA-1".into(), severity: "high".into(), title: "t".into(), url: String::new() };
        let previous = SuiteReport { advisories: vec![adv.clone()], audit: AuditState::Ok, audited_at: Some(5), ..SuiteReport::default() };
        let mut r = SuiteReport::default();
        audit_into(&mut r, Err(AuditError::Unavailable("offline".into())), Some(&previous));
        assert_eq!((r.audit, r.advisories.as_slice(), r.audited_at), (AuditState::Unavailable, &[adv][..], Some(5)));
        let mut r = SuiteReport::default();
        audit_into(&mut r, Ok(vec![]), Some(&previous));
        assert!(r.advisories.is_empty() && r.audit == AuditState::Ok && r.audited_at.is_some_and(|t| t > 5));
    }

    #[test]
    fn results_keep_the_newest_versions() {
        let root = temp_dir("conformance-results");
        let results = Results::at(&root);
        for minor in 0..15 {
            results.put("claude", &SuiteReport { version: format!("1.{minor}.0"), ..SuiteReport::default() }).unwrap();
        }
        let kept: Vec<String> = results.all()["claude"].keys().cloned().collect();
        assert_eq!(kept.len(), KEEP_REPORTS);
        assert!(!kept.contains(&"1.2.0".to_owned()) && kept.contains(&"1.14.0".to_owned()) && kept.contains(&"1.10.0".to_owned()), "{kept:?}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_sandbox_hands_down_nothing_but_path() {
        let sandbox = Sandbox::new().unwrap();
        let auggie = agents::preset("auggie").unwrap();
        let env: BTreeMap<String, String> = sandbox.env(Some(auggie)).into_iter().collect();
        let home = sandbox.home().to_string_lossy().into_owned();
        assert_eq!(env["HOME"], home);
        for k in ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "TMPDIR"] {
            assert!(env[k].starts_with(home.trim_end_matches("/home")), "{k}: {}", env[k]);
        }
        assert_eq!(env["AUGMENT_DISABLE_AUTO_UPDATE"], "1", "the preset's own env");
        // A real child sees exactly that.
        let out = tauri::async_runtime::block_on(async { sandbox.command("env", &[], None).output().await }).unwrap();
        let seen: BTreeSet<String> =
            String::from_utf8_lossy(&out.stdout).lines().filter_map(|l| l.split_once('=').map(|(k, _)| k.to_owned())).collect();
        let allowed: BTreeSet<String> = sandbox.env(None).into_iter().map(|(k, _)| k).collect();
        assert!(seen.is_subset(&allowed), "{seen:?}");
        assert!(!seen.contains("ANTHROPIC_API_KEY") && !seen.contains("GITHUB_TOKEN"));
        let root = sandbox.root.clone();
        drop(sandbox);
        assert!(!root.exists(), "removed with the sandbox");
    }

    /// A small ACP agent in node; `YAAH_FAKE` picks a way to misbehave.
    const FAKE_AGENT: &str = r#"
const mode = process.argv[2] || "good";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === "initialize" && mode === "no-terminals" && m.params.clientCapabilities.terminal === true) {
      send({ id: m.id, error: { code: -32602, message: "unknown client capability: terminal" } });
    } else if (m.method === "initialize") {
      const caps = { loadSession: mode !== "no-load", mcpCapabilities: { http: true }, promptCapabilities: { embeddedContext: true },
        sessionCapabilities: { additionalDirectories: {}, systemPrompt: {} } };
      const auth = mode === "bad-terminal" ? [{ id: "t", name: "Log in", type: "terminal" }]
        : [{ id: "login", name: "Log in", type: "terminal", args: ["--cli", "auth", "login"] }, { id: "key", name: "Key", type: "env_var", vars: [{ name: "K" }] }];
      send({ id: m.id, result: { protocolVersion: mode === "v2" ? 2 : 1, agentInfo: { name: "fake", version: "1.0.0" }, agentCapabilities: caps, authMethods: auth } });
      if (mode === "child") require("child_process").spawn("sleep", ["30"], { stdio: "ignore" });
    } else if (m.method === "session/new") {
      if (mode === "auth") send({ id: m.id, error: { code: -32000, message: "Authentication required" } });
      else if (mode === "crashy-session") send({ id: m.id, error: { code: -32603, message: "Internal error: no credentials" } });
      else { send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "available_commands_update", availableCommands: [] } } }); send({ id: m.id, result: { sessionId: "s1" } }); }
    } else if (m.id !== undefined) {
      if (mode === "lenient") send({ id: m.id, result: null });
      else send({ id: m.id, error: { code: -32601, message: "Method not found" } });
    }
  }
});
if (mode === "linger") setInterval(() => {}, 1000);
process.stdin.on("end", () => { if (mode !== "linger") process.exit(0); });
"#;

    fn fake(mode: &str) -> Option<(String, Vec<String>, PathBuf)> {
        let node = crate::path_env::which("node")?;
        let dir = temp_dir("fake-agent");
        std::fs::write(dir.join("agent.js"), FAKE_AGENT).unwrap();
        Some((node.to_string_lossy().into_owned(), vec![dir.join("agent.js").to_string_lossy().into_owned(), mode.to_owned()], dir))
    }

    fn failing(checks: &[Check]) -> Vec<&str> {
        checks.iter().filter(|c| !c.ok).map(|c| c.name.as_str()).collect()
    }

    #[tokio::test]
    async fn tier_a_passes_a_conforming_agent_and_names_each_regression() {
        let Some((program, args, dir)) = fake("good") else { return };
        let claude = agents::preset(agents::CLAUDE).unwrap();
        let run = |mode: &str| {
            let mut a = args.clone();
            a[1] = mode.to_owned();
            let program = program.clone();
            async move { run_checks(claude, &program, &a).await }
        };
        let good = run("good").await;
        assert!(failing(&good).is_empty(), "{good:#?}");
        let names: Vec<&str> = good.iter().map(|c| c.name.as_str()).collect();
        for n in [
            "initialize",
            "initialize with terminal: true",
            "protocolVersion",
            "capability loadSession",
            "authMethods",
            "authMethods terminal args",
            "unknown method",
            "session/new signed out",
            "shutdown",
        ] {
            assert!(names.contains(&n), "{n} missing from {names:?}");
        }
        assert!(good.iter().any(|c| c.name == "session/new signed out" && c.detail.contains("available_commands_update")));

        assert!(run("auth").await.iter().all(|c| c.ok), "auth-required is what yaah's login flow expects");
        assert_eq!(failing(&run("v2").await), ["protocolVersion"]);
        assert_eq!(failing(&run("no-terminals").await), ["initialize", "initialize with terminal: true"], "an agent refusing the offer is caught");
        assert_eq!(failing(&run("no-load").await), ["capability loadSession"]);
        assert_eq!(failing(&run("bad-terminal").await), ["authMethods terminal args"]);
        assert_eq!(failing(&run("crashy-session").await), ["session/new signed out"]);
        // goose's known -32603 without a provider passes for goose only; any other code still fails it.
        let goose = agents::preset("goose").unwrap();
        let mut crashy = args.clone();
        crashy[1] = "crashy-session".to_owned();
        let checks = run_checks(goose, &program, &crashy).await;
        assert!(failing(&checks).is_empty(), "{checks:#?}");
        assert!(checks.iter().any(|c| c.name == "session/new signed out" && c.detail.contains("fails as known for goose")));
        crashy[1] = "auth".to_owned();
        assert!(failing(&run_checks(goose, &program, &crashy).await).is_empty(), "auth-required is always fine");
        assert_eq!(failing(&run("lenient").await), ["unknown method"]);
        let linger = run("linger").await;
        assert_eq!(failing(&linger), ["shutdown"]);
        assert!(linger.last().unwrap().detail.contains("killed"), "{linger:?}");
        if crate::path_env::which("sleep").is_some() {
            let child = run("child").await;
            assert_eq!(failing(&child), ["shutdown"], "{child:#?}");
            assert!(child.last().unwrap().detail.contains("sleep"));
        }
        let missing = run_checks(claude, "/nonexistent/agent", &[]).await;
        assert_eq!(failing(&missing), ["starts"]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// A stand-in npm registry that answers the bulk advisory endpoint and packuments.
    fn registry(advisories: Value, packuments: Vec<(&'static str, Value)>) -> String {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}", server.server_addr().to_ip().unwrap());
        std::thread::spawn(move || {
            for req in server.incoming_requests() {
                let path = req.url().to_owned();
                let body = if path.contains("/security/advisories/bulk") {
                    advisories.to_string()
                } else {
                    packuments.iter().find(|(p, _)| path.trim_start_matches('/') == *p).map_or_else(|| "{}".to_owned(), |(_, v)| v.to_string())
                };
                let json = tiny_http::Header::from_bytes("content-type", "application/json").unwrap();
                let _ = req.respond(tiny_http::Response::from_string(body).with_header(json));
            }
        });
        base
    }

    #[test]
    fn audits_an_install_with_npm_itself() {
        if crate::path_env::which("npm").is_none() {
            return;
        }
        // What `npm install --prefix` leaves: a manifest and a lockfile.
        let dir = temp_dir("audit");
        std::fs::write(dir.join("package.json"), r#"{ "dependencies": { "minimist": "1.2.0" } }"#).unwrap();
        let lock = json!({ "lockfileVersion": 3, "requires": true, "packages": {
            "": { "dependencies": { "minimist": "1.2.0" } },
            "node_modules/minimist": { "version": "1.2.0", "resolved": "https://registry.npmjs.org/minimist/-/minimist-1.2.0.tgz" }
        } });
        std::fs::write(dir.join("package-lock.json"), lock.to_string()).unwrap();
        let advisories = json!({ "minimist": [
            { "id": 1_097_678, "url": "https://github.com/advisories/GHSA-xvch-5gv4-984h", "title": "Prototype Pollution in minimist", "severity": "critical", "vulnerable_versions": ">=1.0.0 <1.2.6", "cwe": [], "cvss": { "score": 9.8, "vectorString": null } }
        ] });
        let packument = json!({ "name": "minimist", "dist-tags": { "latest": "1.2.8" }, "versions": {
            "1.2.0": { "name": "minimist", "version": "1.2.0" }, "1.2.8": { "name": "minimist", "version": "1.2.8" }
        } });
        let base = registry(advisories, vec![("minimist", packument)]);
        let cache = dir.join("npm-cache");
        let cache = cache.to_string_lossy();
        let env = [("npm_config_registry", base.as_str()), ("npm_config_cache", cache.as_ref())];
        let got = audit(&dir, &env).unwrap();
        assert_eq!(got.len(), 1, "{got:?}");
        assert_eq!((got[0].id.as_str(), got[0].severity.as_str()), ("GHSA-xvch-5gv4-984h", "critical"));

        // The registry out of reach: unavailable, not a failure.
        let offline = [("npm_config_registry", "http://127.0.0.1:9"), ("npm_config_cache", cache.as_ref())];
        assert!(matches!(audit(&dir, &offline), Err(AuditError::Unavailable(_))), "{:?}", audit(&dir, &offline));
        std::fs::remove_file(dir.join("package-lock.json")).unwrap();
        assert!(matches!(audit(&dir, &env), Err(AuditError::Failed(m)) if m.contains("package-lock")));
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Tier B, live: goose, OpenCode and Claude Code each run one prompt on Amazon
    /// Bedrock through their translated route, with the AWS profile named by
    /// `YAAH_LIVE_AWS_PROFILE` (SSO works: `aws sso login --profile P` first).
    /// `YAAH_LIVE_AWS_REGION` (default us-east-1) and `YAAH_LIVE_BEDROCK_MODEL`
    /// (default the US Claude Haiku 4.5 inference profile) pick the rest. The
    /// pinned versions are installed under `~/.yaah/agents`. Spends a few cheap prompts.
    #[test]
    #[ignore = "live: Amazon Bedrock with the AWS profile in YAAH_LIVE_AWS_PROFILE; spends tokens"]
    fn live_bedrock_route_runs_a_prompt_on_each_agent() {
        use crate::agent_routes::{Options, route_with};
        use crate::providers::{Bedrock, Binding, Kind, ResolvedProvider};
        let profile = std::env::var("YAAH_LIVE_AWS_PROFILE").expect("set YAAH_LIVE_AWS_PROFILE to an AWS profile with Bedrock access");
        let region = std::env::var("YAAH_LIVE_AWS_REGION").unwrap_or_else(|_| "us-east-1".into());
        let model = std::env::var("YAAH_LIVE_BEDROCK_MODEL").unwrap_or_else(|_| "us.anthropic.claude-haiku-4-5-20251001-v1:0".into());
        let provider = ResolvedProvider {
            id: "live".into(),
            kind: Kind::Bedrock,
            label: "live Bedrock".into(),
            bedrock: Some(Bedrock { profile, region, prefix: None }),
            secret: None,
        };
        let binding = Binding { provider_id: "live".into(), model, small_model: None };
        let mut failed = vec![];
        for id in ["goose", "opencode", agents::CLAUDE] {
            let preset = agents::preset(id).unwrap();
            let installed = Versions::user().ensure(&preset.spec().unwrap()).unwrap();
            let (program, mut args) = installed.command();
            args.extend(preset.args.iter().map(ToString::to_string));
            let dir = temp_dir("live-bedrock");
            let (work, own) = (dir.join("work"), dir.join("profile"));
            std::fs::create_dir_all(&work).unwrap();
            std::fs::write(work.join("README.md"), "yaah live check\n").unwrap();
            let route = route_with(id, &provider, &binding, &own, &Options::default()).unwrap();
            route.write_files().unwrap();
            // The user's own environment (the AWS SDK reads ~/.aws and its SSO cache), on the route; Claude's own config aside.
            let mut cmd = crate::path_env::tokio_command(&program);
            cmd.args(&args).current_dir(&work).env("CLAUDE_CONFIG_DIR", dir.join("claude"));
            for k in &route.env_remove {
                cmd.env_remove(k);
            }
            cmd.envs(&route.env);
            let command_line: Vec<String> = std::iter::once(program.clone()).chain(args.iter().cloned()).collect();
            let checks = tauri::async_runtime::block_on(async {
                let (mut checks, conn) = drive_on_route(preset, cmd, &route, &work).await;
                if let Some(conn) = conn {
                    checks.push(argv_check(&conn, &command_line, &[]));
                    checks.push(shutdown_check(&conn).await);
                }
                checks
            });
            for c in &checks {
                println!("{id}: {} {}: {}", if c.ok { "ok  " } else { "FAIL" }, c.name, c.detail);
            }
            failed.extend(checks.iter().filter(|c| !c.ok).map(|c| format!("{id} {}", c.name)));
            let _ = std::fs::remove_dir_all(dir);
        }
        assert!(failed.is_empty(), "{failed:?}");
    }

    #[tokio::test]
    async fn verify_promotes_a_passing_candidate_and_fails_a_regression() {
        let Some((_, _, fake_dir)) = fake("good") else { return };
        let root = temp_dir("verify-suite");
        let versions = Versions::at(root.clone());
        let claude = agents::preset(agents::CLAUDE).unwrap();
        // An installed candidate whose program is the fake agent (as install_candidate leaves it).
        let install = |version: &str, mode: &str| {
            let spec = claude.spec().unwrap().at(version).unwrap();
            let dir = crate::agent_install::tests::fake_install(&root, &spec);
            let bin = dir.join("node_modules").join(&spec.name).join("dist/index.js");
            let script = std::fs::read_to_string(fake_dir.join("agent.js")).unwrap().replace("process.argv[2] || \"good\"", &format!("{mode:?}"));
            std::fs::write(&bin, format!("#!/usr/bin/env node\n{script}")).unwrap();
        };
        install("999.0.0", "good");
        versions.mark_candidate("claude", "999.0.0");
        let report = verify(&versions, "claude", "999.0.0").await.unwrap();
        assert!(report.checks.iter().all(|c| c.ok), "{report:#?}");
        assert!(report.promoted);
        assert_eq!(versions.records()["claude"]["999.0.0"].status, Status::Verified);
        assert_eq!(Results::at(&root).get("claude", "999.0.0").unwrap().checks.len(), report.checks.len(), "the report is stored");

        install("999.1.0", "v2");
        versions.mark_candidate("claude", "999.1.0");
        let report = verify(&versions, "claude", "999.1.0").await.unwrap();
        assert!(!report.promoted);
        let r = &versions.records()["claude"]["999.1.0"];
        assert_eq!(r.status, Status::Failed);
        assert!(r.failures[0].starts_with("protocolVersion: 2"), "{:?}", r.failures);
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(fake_dir).unwrap();
    }
}
