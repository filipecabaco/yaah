//! Tier A conformance (`agent_conformance.rs`) for every npm-based preset, at
//! the version yaah pins and at the registry's latest, headless. What CI runs
//! (`mise run ci:conformance`). Never signs in or prompts; each agent runs in a
//! throwaway home.
//!
//! Usage: `cargo run --example conformance -- [options]`
//!
//! - `--only claude,codex`  just these presets
//! - `--pinned` / `--latest`  just one side (default: both)
//! - `--fail-on-latest`  also fail when a latest version wouldn't be promoted
//!   (the nightly job); by default only the pinned versions decide the exit code
//! - `--root DIR`  where versions are installed (default `$YAAH_CONFORMANCE_ROOT`,
//!   else `<temp>/yaah-conformance-installs`), never `~/.yaah/agents`
//! - `--json FILE`, `--markdown FILE`  also write the results there
use serde_json::json;
use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::time::Instant;
use yaah_lib::agent_conformance::{self, AuditState, Results, SuiteReport};
use yaah_lib::agent_install::{self, Spec};
use yaah_lib::agent_versions::{self, REGISTRY};
use yaah_lib::agents::{self, Preset};

struct Row {
    preset: &'static str,
    role: &'static str,
    spec: Spec,
    result: Result<SuiteReport, String>,
}

impl Row {
    /// Whether the version would be promoted (all checks pass, no high or critical advisory).
    fn passed(&self) -> bool {
        self.result.as_ref().is_ok_and(SuiteReport::passed)
    }

    /// Whether every check passed (advisories aside).
    fn checks_passed(&self) -> bool {
        self.result.as_ref().is_ok_and(|r| r.checks.iter().all(|c| c.ok))
    }

    fn verdict(&self) -> &'static str {
        match (&self.result, self.passed(), self.checks_passed()) {
            (Err(_), ..) => "ERROR",
            (Ok(_), true, _) => "pass",
            // Every check passed; a high or critical advisory keeps it from being promoted.
            (Ok(_), false, true) => "blocked",
            (Ok(_), false, false) => "FAIL",
        }
    }
}

struct Options {
    only: Option<Vec<String>>,
    pinned: bool,
    latest: bool,
    fail_on_latest: bool,
    root: PathBuf,
    json: Option<String>,
    markdown: Option<String>,
}

fn options() -> Options {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let value = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let flag = |name: &str| args.iter().any(|a| a == name);
    let (pinned_only, latest_only) = (flag("--pinned"), flag("--latest"));
    Options {
        only: value("--only").map(|s| s.split(',').map(str::to_owned).collect()),
        pinned: pinned_only || !latest_only,
        latest: latest_only || !pinned_only,
        fail_on_latest: flag("--fail-on-latest"),
        root: value("--root")
            .or_else(|| std::env::var("YAAH_CONFORMANCE_ROOT").ok())
            .map_or_else(|| std::env::temp_dir().join("yaah-conformance-installs"), PathBuf::from),
        json: value("--json"),
        markdown: value("--markdown"),
    }
}

/// (preset, "pinned" | "latest", version) for every npm preset asked for.
async fn versions_to_check(o: &Options) -> Vec<(&'static Preset, &'static str, Spec)> {
    let mut wanted = vec![];
    for p in agents::PRESETS.iter().filter(|p| p.spec().is_some()) {
        if o.only.as_ref().is_some_and(|only| !only.iter().any(|x| x == p.id)) {
            continue;
        }
        let pinned = p.spec().expect("npm preset");
        if o.pinned {
            wanted.push((p, "pinned", pinned.clone()));
        }
        if o.latest {
            match agent_versions::fetch_latest(REGISTRY, &pinned.name).await.and_then(|v| pinned.at(&v)) {
                Ok(spec) => wanted.push((p, "latest", spec)),
                Err(e) => eprintln!("{}: couldn't read the latest version: {e}", p.id),
            }
        }
    }
    wanted
}

/// Install every version, in parallel (npm is the slow part). Returns the failures by spec.
async fn install_all(root: &Path, specs: impl Iterator<Item = Spec>) -> HashMap<String, String> {
    let mut unique: Vec<Spec> = specs.collect();
    unique.sort_by_key(ToString::to_string);
    unique.dedup();
    let mut installs = tokio::task::JoinSet::new();
    for spec in unique {
        let root = root.to_owned();
        installs.spawn_blocking(move || {
            let t = Instant::now();
            let got = agent_install::ensure(&root, &spec);
            (spec, got.map(|_| t.elapsed().as_secs_f64()))
        });
    }
    let mut errors = HashMap::new();
    while let Some(Ok((spec, got))) = installs.join_next().await {
        match got {
            Ok(seconds) => eprintln!("installed {spec} ({seconds:.1}s)"),
            Err(e) => {
                eprintln!("couldn't install {spec}: {e}");
                errors.insert(spec.to_string(), e);
            }
        }
    }
    errors
}

/// The suite on each version, one at a time so they don't compete for the machine.
async fn check_all(root: &Path, wanted: Vec<(&'static Preset, &'static str, Spec)>, install_errors: &HashMap<String, String>) -> Vec<Row> {
    let results = Results::at(root);
    let mut rows: Vec<Row> = vec![];
    for (preset, role, spec) in wanted {
        // Latest is often the pin: one run counts for both.
        if let Some(same) = rows.iter().find(|r| r.preset == preset.id && r.spec == spec) {
            let result = same.result.clone();
            rows.push(Row { preset: preset.id, role, spec, result });
            continue;
        }
        let result = match (install_errors.get(&spec.to_string()), agent_install::installed(root, &spec)) {
            (Some(e), _) => Err(format!("install failed: {e}")),
            (None, None) => Err("not installed".into()),
            (None, Some(installed)) => {
                let (program, mut args) = installed.command();
                args.extend(preset.args.iter().map(ToString::to_string));
                eprintln!("checking {} {spec}…", preset.id);
                let previous = results.get(preset.id, &spec.version);
                let dir = agent_install::dir(root, &spec);
                let report = agent_conformance::run_suite(preset, &spec.version, &program, &args, &dir, previous.as_ref()).await;
                let _ = results.put(preset.id, &report);
                Ok(report)
            }
        };
        rows.push(Row { preset: preset.id, role, spec, result });
    }
    rows
}

fn advisory_counts(r: &SuiteReport) -> String {
    let n = |s: &str| r.advisories.iter().filter(|a| a.severity.eq_ignore_ascii_case(s)).count();
    let audit = match r.audit {
        AuditState::Ok => "",
        AuditState::Unavailable => " (registry unreachable)",
        AuditState::Error => " (audit failed)",
        AuditState::None => " (not audited)",
    };
    format!("{}/{}/{}/{}{audit}", n("critical"), n("high"), n("moderate"), n("low"))
}

/// Print the table and what failed; returns the same as Markdown.
fn report(rows: &[Row]) -> String {
    let mut md = String::from("| preset | role | version | result | checks | advisories c/h/m/l | time |\n|---|---|---|---|---|---|---|\n");
    println!("\n{:<8} {:<7} {:<10} {:<7} {:<7} {:<30} {:>6}", "preset", "role", "version", "result", "checks", "advisories c/h/m/l", "time");
    for r in rows {
        let (checks, adv, time) = match &r.result {
            Ok(rep) => {
                (format!("{}/{}", rep.checks.iter().filter(|c| c.ok).count(), rep.checks.len()), advisory_counts(rep), format!("{:.1}s", rep.seconds))
            }
            Err(_) => ("-".into(), "-".into(), "-".into()),
        };
        println!("{:<8} {:<7} {:<10} {:<7} {:<7} {:<30} {:>6}", r.preset, r.role, r.spec.version, r.verdict(), checks, adv, time);
        let _ = writeln!(md, "| {} | {} | {} | {} | {checks} | {adv} | {time} |", r.preset, r.role, r.spec.version, r.verdict());
    }
    let mut details = String::new();
    for r in rows {
        let at = format!("{} {} ({})", r.preset, r.spec.version, r.role);
        match &r.result {
            Ok(rep) => {
                for c in rep.checks.iter().filter(|c| !c.ok) {
                    let _ = writeln!(details, "- {at}: **{}**: {}", c.name, c.detail.replace('\n', " "));
                }
                for a in rep.advisories.iter().filter(|a| agent_conformance::blocks(a)) {
                    let _ = writeln!(details, "- {at}: {} advisory {}: {}", a.severity, a.id, a.title);
                }
            }
            Err(e) => {
                let _ = writeln!(details, "- {at}: {e}");
            }
        }
    }
    if !details.is_empty() {
        println!("\n{details}");
        md.push('\n');
        md.push_str(&details);
    }
    md
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    yaah_lib::path_env::adopt_login_shell();
    let o = options();
    std::fs::create_dir_all(&o.root).expect("create the install root");
    let started = Instant::now();

    let wanted = versions_to_check(&o).await;
    let install_started = Instant::now();
    let install_errors = install_all(&o.root, wanted.iter().map(|(_, _, s)| s.clone())).await;
    let install_secs = install_started.elapsed().as_secs_f64();
    let rows = check_all(&o.root, wanted, &install_errors).await;

    let md = report(&rows);
    println!("installs {install_secs:.0}s, total {:.0}s, versions under {}", started.elapsed().as_secs_f64(), o.root.display());
    if let Some(path) = &o.markdown {
        std::fs::write(path, &md).expect("write markdown");
    }
    if let Some(path) = &o.json {
        let out: Vec<_> = rows
            .iter()
            .map(|r| match &r.result {
                Ok(rep) => json!({ "preset": r.preset, "role": r.role, "version": r.spec.version, "passed": r.passed(), "report": rep }),
                Err(e) => json!({ "preset": r.preset, "role": r.role, "version": r.spec.version, "passed": false, "error": e }),
            })
            .collect();
        std::fs::write(path, serde_json::to_string_pretty(&out).unwrap_or_default()).expect("write json");
    }

    // Pinned versions must pass their checks: that's what ships. Latest ones only with --fail-on-latest.
    let failed: Vec<String> = rows
        .iter()
        .filter(|r| if r.role == "pinned" { !r.checks_passed() } else { o.fail_on_latest && !r.passed() })
        .map(|r| format!("{} {} ({})", r.preset, r.spec.version, r.role))
        .collect();
    if !failed.is_empty() {
        eprintln!("failed: {}", failed.join(", "));
        std::process::exit(1);
    }
}
