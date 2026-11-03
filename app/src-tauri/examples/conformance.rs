//! Tier A conformance (`agent_conformance.rs`) for every preset yaah installs
//! (npm packages, and the ACP registry's release archives: goose, OpenCode), at
//! the version yaah pins and at the registry's latest, headless; then provider
//! mode for the agents that run on a model provider (Claude Code, goose,
//! OpenCode): each starts on its translated OpenRouter route pointed at a local
//! stub (`provider_stub.rs`) and runs one prompt with a tool call. What CI runs
//! (`mise run ci:conformance`). Never signs in; no real model is called; each
//! agent runs in a throwaway home.
//!
//! Usage: `cargo run --example conformance -- [options]`
//!
//! - `--only claude,codex`  just these presets
//! - `--pinned` / `--latest`  just one side (default: both)
//! - `--no-providers` / `--providers-only`  skip provider mode / run only it
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
use yaah_lib::agent_routes;
use yaah_lib::agent_versions::{self, ACP_REGISTRY, REGISTRY, Versions};
use yaah_lib::agents::{self, Preset};

const TIER_A: &str = "tier A";
const PROVIDER: &str = "provider";
/// Claude Code on the stub through ACP `providers/set` instead of env: reported, not gating,
/// while env is the default (`agent_routes::CLAUDE_OPENROUTER`).
const PROVIDERS_SET: &str = "prov-set";

struct Row {
    preset: &'static str,
    role: &'static str,
    /// [`TIER_A`], [`PROVIDER`] or [`PROVIDERS_SET`].
    mode: &'static str,
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

#[allow(clippy::struct_excessive_bools, reason = "one flag per command-line switch")]
struct Options {
    only: Option<Vec<String>>,
    pinned: bool,
    latest: bool,
    fail_on_latest: bool,
    tier_a: bool,
    providers: bool,
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
        tier_a: !flag("--providers-only"),
        providers: !flag("--no-providers"),
        root: value("--root")
            .or_else(|| std::env::var("YAAH_CONFORMANCE_ROOT").ok())
            .map_or_else(|| std::env::temp_dir().join("yaah-conformance-installs"), PathBuf::from),
        json: value("--json"),
        markdown: value("--markdown"),
    }
}

/// (preset, "pinned" | "latest", version) for every installed preset asked for.
/// Binary agents' latest versions (and their downloads) come from the ACP
/// registry, cached under the root so the install can check their sha256.
async fn versions_to_check(o: &Options) -> Vec<(&'static Preset, &'static str, Spec)> {
    let versions = Versions::at(o.root.clone());
    if o.latest {
        match versions.refresh_binaries(ACP_REGISTRY).await {
            Ok(errors) => errors.iter().for_each(|e| eprintln!("ACP registry: {e}")),
            Err(e) => eprintln!("couldn't read the ACP registry: {e}"),
        }
    }
    let latest_binaries = versions.latest();
    let mut wanted = vec![];
    for p in agents::PRESETS.iter().filter(|p| p.spec().is_some()) {
        if o.only.as_ref().is_some_and(|only| !only.iter().any(|x| x == p.id)) {
            continue;
        }
        let pinned = p.spec().expect("installed preset");
        if o.pinned {
            wanted.push((p, "pinned", pinned.clone()));
        }
        if o.latest {
            let latest = if p.binary().is_some() {
                latest_binaries.get(&pinned.name).map(|l| l.latest.clone()).ok_or_else(|| "not in the ACP registry".to_owned())
            } else {
                agent_versions::fetch_latest(REGISTRY, &pinned.name).await
            };
            match latest.and_then(|v| pinned.at(&v)) {
                Ok(spec) => wanted.push((p, "latest", spec)),
                Err(e) => eprintln!("{}: couldn't read the latest version: {e}", p.id),
            }
        }
    }
    wanted
}

/// Install every version, in parallel (npm and downloads are the slow part). Returns the failures by spec.
async fn install_all(root: &Path, specs: impl Iterator<Item = Spec>) -> HashMap<String, String> {
    let mut unique: Vec<Spec> = specs.collect();
    unique.sort_by_key(ToString::to_string);
    unique.dedup();
    let mut installs = tokio::task::JoinSet::new();
    for spec in unique {
        let root = root.to_owned();
        installs.spawn_blocking(move || {
            let t = Instant::now();
            let got = Versions::at(root).ensure(&spec);
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

/// How to start an installed version: its program, then the preset's args.
fn command(root: &Path, preset: &Preset, spec: &Spec, install_errors: &HashMap<String, String>) -> Result<(String, Vec<String>), String> {
    match (install_errors.get(&spec.to_string()), agent_install::installed(root, spec)) {
        (Some(e), _) => Err(format!("install failed: {e}")),
        (None, None) => Err("not installed".into()),
        (None, Some(installed)) => {
            let (program, mut args) = installed.command();
            args.extend(preset.args.iter().map(ToString::to_string));
            Ok((program, args))
        }
    }
}

/// The suite on each version, one at a time so they don't compete for the machine:
/// tier A, then provider mode for the presets that have a route.
async fn check_all(o: &Options, wanted: Vec<(&'static Preset, &'static str, Spec)>, install_errors: &HashMap<String, String>) -> Vec<Row> {
    let root = o.root.as_path();
    let results = Results::at(root);
    let mut rows: Vec<Row> = vec![];
    let modes = [(TIER_A, o.tier_a), (PROVIDER, o.providers), (PROVIDERS_SET, o.providers)];
    for (mode, _) in modes.iter().filter(|(_, on)| *on) {
        for (preset, role, spec) in &wanted {
            if (*mode == PROVIDER && agent_routes::unsupported(preset.id).is_some()) || (*mode == PROVIDERS_SET && preset.id != agents::CLAUDE) {
                continue;
            }
            // Latest is often the pin: one run counts for both.
            if let Some(same) = rows.iter().find(|r| r.preset == preset.id && r.spec == *spec && r.mode == *mode) {
                let result = same.result.clone();
                rows.push(Row { preset: preset.id, role, mode, spec: spec.clone(), result });
                continue;
            }
            let result = match command(root, preset, spec, install_errors) {
                Err(e) => Err(e),
                Ok((program, args)) if *mode == TIER_A => {
                    eprintln!("checking {} {spec}…", preset.id);
                    let previous = results.get(preset.id, &spec.version);
                    let dir = agent_install::dir(root, spec);
                    let report = agent_conformance::run_suite(preset, &spec.version, &program, &args, &dir, previous.as_ref()).await;
                    let _ = results.put(preset.id, &report);
                    Ok(report)
                }
                Ok((program, args)) => {
                    eprintln!("checking {} {spec} on a model provider (the stub, {mode})…", preset.id);
                    let started = Instant::now();
                    let via = if *mode == PROVIDERS_SET { agent_routes::ClaudeOpenRouter::ProvidersSet } else { agent_routes::ClaudeOpenRouter::Env };
                    let checks = agent_conformance::run_provider_checks_via(preset, &program, &args, via).await;
                    let seconds = (started.elapsed().as_secs_f64() * 10.0).round() / 10.0;
                    Ok(SuiteReport { version: spec.version.clone(), checks, seconds, ..SuiteReport::default() })
                }
            };
            rows.push(Row { preset: preset.id, role, mode, spec: spec.clone(), result });
        }
    }
    rows
}

fn advisory_counts(r: &SuiteReport, mode: &str) -> String {
    if mode != TIER_A {
        return "-".into();
    }
    let n = |s: &str| r.advisories.iter().filter(|a| a.severity.eq_ignore_ascii_case(s)).count();
    let audit = match r.audit {
        AuditState::Ok => "",
        AuditState::Unavailable => " (registry unreachable)",
        AuditState::Error => " (audit failed)",
        AuditState::None if r.audit_detail.is_some() => " (release archive)",
        AuditState::None => " (not audited)",
    };
    format!("{}/{}/{}/{}{audit}", n("critical"), n("high"), n("moderate"), n("low"))
}

/// Print the table and what failed; returns the same as Markdown.
fn report(rows: &[Row]) -> String {
    let mut md =
        String::from("| preset | role | mode | version | result | checks | advisories c/h/m/l | time |\n|---|---|---|---|---|---|---|---|\n");
    println!(
        "\n{:<8} {:<7} {:<8} {:<10} {:<7} {:<7} {:<30} {:>6}",
        "preset", "role", "mode", "version", "result", "checks", "advisories c/h/m/l", "time"
    );
    for r in rows {
        let (checks, adv, time) = match &r.result {
            Ok(rep) => (
                format!("{}/{}", rep.checks.iter().filter(|c| c.ok).count(), rep.checks.len()),
                advisory_counts(rep, r.mode),
                format!("{:.1}s", rep.seconds),
            ),
            Err(_) => ("-".into(), "-".into(), "-".into()),
        };
        println!("{:<8} {:<7} {:<8} {:<10} {:<7} {:<7} {:<30} {:>6}", r.preset, r.role, r.mode, r.spec.version, r.verdict(), checks, adv, time);
        let _ = writeln!(md, "| {} | {} | {} | {} | {} | {checks} | {adv} | {time} |", r.preset, r.role, r.mode, r.spec.version, r.verdict());
    }
    let mut details = String::new();
    for r in rows {
        let at = format!("{} {} ({}, {})", r.preset, r.spec.version, r.role, r.mode);
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
    let rows = check_all(&o, wanted, &install_errors).await;

    let md = report(&rows);
    println!("installs {install_secs:.0}s, total {:.0}s, versions under {}", started.elapsed().as_secs_f64(), o.root.display());
    if let Some(path) = &o.markdown {
        std::fs::write(path, &md).expect("write markdown");
    }
    if let Some(path) = &o.json {
        let out: Vec<_> = rows
            .iter()
            .map(|r| match &r.result {
                Ok(rep) => {
                    json!({ "preset": r.preset, "role": r.role, "mode": r.mode, "version": r.spec.version, "passed": r.passed(), "report": rep })
                }
                Err(e) => json!({ "preset": r.preset, "role": r.role, "mode": r.mode, "version": r.spec.version, "passed": false, "error": e }),
            })
            .collect();
        std::fs::write(path, serde_json::to_string_pretty(&out).unwrap_or_default()).expect("write json");
    }

    // Pinned versions must pass their checks: that's what ships. Latest ones only with --fail-on-latest.
    // Claude's `providers/set` rows only report (env is what ships).
    let failed: Vec<String> = rows
        .iter()
        .filter(|r| r.mode != PROVIDERS_SET)
        .filter(|r| if r.role == "pinned" { !r.checks_passed() } else { o.fail_on_latest && !r.passed() })
        .map(|r| format!("{} {} ({}, {})", r.preset, r.spec.version, r.role, r.mode))
        .collect();
    if !failed.is_empty() {
        eprintln!("failed: {}", failed.join(", "));
        std::process::exit(1);
    }
}
