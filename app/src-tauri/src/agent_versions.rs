//! Which version of each npm-based agent runs, and keeping it current.
//!
//! Each preset with an `npx` package pins the version yaah was tested with.
//! What runs is a policy ([`choose`]):
//!
//! 1. the version the user holds it at ("Hold at vX", `agentVersions` in `settings.json`);
//! 2. else the newest **verified** version at or above the pin;
//! 3. else the pin.
//!
//! A newer version becomes verified only through the conformance suite:
//!
//! - once a day (and on "Check for updates") yaah reads each package's
//!   `dist-tags.latest` from the npm registry ([`Versions::refresh_latest`],
//!   cached in `~/.yaah/agents/versions.json`);
//! - for presets a saved agent uses, a newer version is installed as a
//!   candidate ([`Versions::install_candidate`], status `installed`) and handed
//!   to the [`Verifier`] hook, never activated;
//! - the suite marks it `verifying`, stores what it found
//!   ([`Versions::record_result`]: failures, advisories) and, when it passed,
//!   [`Versions::promote`]s it to `verified`. Only then does it run.
//!
//! Per (preset, version) state lives in `~/.yaah/agents/verified.json`. Offline
//! or on an error the last known state stays; nothing here blocks startup or an
//! agent start.

use crate::agent_install::{self, Spec};
use crate::agents::{self, Preset};
use crate::json_file::JsonFile;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Where `dist-tags` come from.
pub const REGISTRY: &str = "https://registry.npmjs.org";
/// A check is due when the last one is older than this.
pub const CHECK_EVERY: Duration = Duration::from_hours(24);
/// How often the background loop asks whether a check is due.
const WAKE_EVERY: Duration = Duration::from_hours(1);
/// Registry documents (the abbreviated form) run to about 1.3 MB.
const MAX_DOC: usize = 16 << 20;

// ── semver ──────────────────────────────────────────────────────────────────

/// A semantic version (semver 2.0), compared by precedence: build metadata
/// is ignored and `1.0.0-beta < 1.0.0`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    core: [u64; 3],
    pre: Vec<Ident>,
}

/// A prerelease identifier: numbers sort numerically and before words.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum Ident {
    Num(u64),
    Text(String),
}

impl Version {
    /// `1.2.3`, `1.2.3-beta.1`, `1.2.3+build`. No `v`, no ranges, no tags, no leading zeros.
    pub fn parse(s: &str) -> Option<Self> {
        if s.is_empty() || s.len() > 128 {
            return None;
        }
        let ident_chars = |i: &str| !i.is_empty() && i.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
        let (rest, build) = s.split_once('+').map_or((s, None), |(r, b)| (r, Some(b)));
        if build.is_some_and(|b| !b.split('.').all(ident_chars)) {
            return None;
        }
        let (core, pre) = rest.split_once('-').map_or((rest, None), |(c, p)| (c, Some(p)));
        let nums: Vec<u64> = core.split('.').map(number).collect::<Option<_>>()?;
        let [major, minor, patch] = nums[..] else { return None };
        let pre = match pre {
            None => vec![],
            Some(p) => p
                .split('.')
                .map(|i| match i {
                    _ if !ident_chars(i) => None,
                    _ if i.bytes().all(|b| b.is_ascii_digit()) => number(i).map(Ident::Num),
                    _ => Some(Ident::Text(i.to_owned())),
                })
                .collect::<Option<_>>()?,
        };
        Some(Self { core: [major, minor, patch], pre })
    }

    pub fn is_prerelease(&self) -> bool {
        !self.pre.is_empty()
    }
}

fn number(s: &str) -> Option<u64> {
    let plain = !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) && (s == "0" || !s.starts_with('0'));
    if plain { s.parse().ok() } else { None }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        self.core.cmp(&other.core).then_with(|| match (self.pre.is_empty(), other.pre.is_empty()) {
            (true, true) => Ordering::Equal,
            (true, false) => Ordering::Greater,
            (false, true) => Ordering::Less,
            (false, false) => self.pre.cmp(&other.pre),
        })
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Whether `a` is a newer version than `b` (false when either isn't a version).
pub fn newer(a: &str, b: &str) -> bool {
    matches!((Version::parse(a), Version::parse(b)), (Some(a), Some(b)) if a > b)
}

// ── state ───────────────────────────────────────────────────────────────────

/// What the registry said last: `versions.json` is `{ <package>: Latest }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Latest {
    pub latest: String,
    /// Unix seconds.
    pub checked_at: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    /// On disk, not checked yet.
    #[default]
    Installed,
    /// The suite is on it, or it passed and isn't promoted yet.
    Verifying,
    /// Passed and promoted: it may run.
    Verified,
    Failed,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Installed => "installed",
            Status::Verifying => "verifying",
            Status::Verified => "verified",
            Status::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Advisory {
    pub id: String,
    pub severity: String,
    pub title: String,
    pub url: String,
}

/// One (preset, version): `verified.json` is `{ <preset id>: { <version>: Record } }`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub status: Status,
    /// Unix seconds of the last change.
    pub checked_at: u64,
    #[serde(default)]
    pub failures: Vec<String>,
    #[serde(default)]
    pub advisories: Vec<Advisory>,
}

/// What the suite found about a version.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Outcome {
    /// Empty when it passed.
    pub failures: Vec<String>,
    pub advisories: Vec<Advisory>,
}

type Records = BTreeMap<String, BTreeMap<String, Record>>;

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// The version that runs: the hold, else the newest verified version at or
/// above the pin, else the pin.
pub fn choose(pinned: &str, hold: Option<&str>, records: Option<&BTreeMap<String, Record>>) -> String {
    if let Some(h) = hold.filter(|h| Version::parse(h).is_some()) {
        return h.to_owned();
    }
    let Some(pin) = Version::parse(pinned) else { return pinned.to_owned() };
    records
        .into_iter()
        .flatten()
        .filter(|(_, r)| r.status == Status::Verified)
        .filter_map(|(v, _)| Version::parse(v).filter(|parsed| *parsed >= pin).map(|parsed| (parsed, v)))
        .max_by(|a, b| a.0.cmp(&b.0))
        .map_or_else(|| pinned.to_owned(), |(_, v)| v.clone())
}

/// What the conformance suite plugs in. Called on its own thread after the
/// daily check installs a newer version of a preset's package as a candidate
/// (status `installed`). The version doesn't run until the suite promotes it:
/// [`Versions::begin_verification`], [`Versions::candidate_command`] to start
/// it, [`Versions::record_result`], then [`Versions::promote`] if it passed.
pub trait Verifier: Send + Sync {
    fn candidate_installed(&self, versions: &Versions, preset: &str, version: &str);
}

static VERIFIER: OnceLock<Box<dyn Verifier>> = OnceLock::new();

/// Register the suite. Only the first call counts; returns whether this one did.
pub fn set_verifier(v: Box<dyn Verifier>) -> bool {
    VERIFIER.set(v).is_ok()
}

/// The npm-based preset `id` and its pinned package.
fn npm_preset(id: &str) -> Result<(&'static Preset, Spec), String> {
    let preset = agents::preset(id).ok_or_else(|| format!("unknown agent preset {id}"))?;
    let spec = preset.spec().ok_or_else(|| format!("{} isn't run from an npm package", preset.label))?;
    Ok((preset, spec))
}

/// Versions and their state under one agents folder (`~/.yaah/agents`; a temp one in tests).
pub struct Versions {
    root: PathBuf,
    latest: JsonFile,
    verified: JsonFile,
}

impl Versions {
    pub fn at(root: PathBuf) -> Self {
        Self { latest: JsonFile::new(root.join("versions.json"), false), verified: JsonFile::new(root.join("verified.json"), false), root }
    }

    pub fn user() -> &'static Self {
        static USER: OnceLock<Versions> = OnceLock::new();
        USER.get_or_init(|| Self::at(agent_install::root()))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The registry's latest version of each package checked so far.
    pub fn latest(&self) -> BTreeMap<String, Latest> {
        self.latest.read()
    }

    /// Every (preset, version) yaah knows something about.
    pub fn records(&self) -> Records {
        self.verified.read()
    }

    /// What runs for `preset` (see [`choose`]); `None` for presets without an npm package.
    pub fn active(&self, preset: &Preset, holds: &BTreeMap<String, String>) -> Option<Spec> {
        Self::active_in(preset, holds, &self.records())
    }

    pub(crate) fn active_in(preset: &Preset, holds: &BTreeMap<String, String>, records: &Records) -> Option<Spec> {
        let pinned = preset.spec()?;
        pinned.at(&choose(&pinned.version, holds.get(preset.id).map(String::as_str), records.get(preset.id))).ok().or(Some(pinned))
    }

    fn update(&self, preset: &str, version: &str, f: impl FnOnce(Option<&mut Record>) -> Result<Option<Record>, String>) -> Result<(), String> {
        self.verified.update(|all: &mut Records| {
            let mine = all.entry(preset.to_owned()).or_default();
            if let Some(new) = f(mine.get_mut(version))? {
                mine.insert(version.to_owned(), new);
            }
            Ok(())
        })
    }

    /// Install `version` of `preset`'s package into its own folder and record it
    /// as a candidate (`installed`; a version already verified stays verified).
    /// Blocks while npm runs. Returns the version's folder.
    pub fn install_candidate(&self, preset: &str, version: &str) -> Result<PathBuf, String> {
        let (_, pinned) = npm_preset(preset)?;
        let spec = pinned.at(version)?;
        agent_install::ensure(&self.root, &spec)?;
        self.update(preset, version, |old| {
            Ok(match old {
                Some(r) if r.status == Status::Verified => None,
                _ => Some(Record { status: Status::Installed, checked_at: now(), ..Record::default() }),
            })
        })?;
        Ok(agent_install::dir(&self.root, &spec))
    }

    /// How to start an installed version of `preset` (its program and the preset's args), for the suite.
    pub fn candidate_command(&self, preset: &str, version: &str) -> Result<(String, Vec<String>), String> {
        let (p, pinned) = npm_preset(preset)?;
        let spec = pinned.at(version)?;
        let installed = agent_install::installed(&self.root, &spec).ok_or_else(|| format!("{spec} isn't installed"))?;
        let (program, mut args) = installed.command();
        args.extend(p.args.iter().map(ToString::to_string));
        Ok((program, args))
    }

    /// Record `version` as an installed candidate, as [`Self::install_candidate`] leaves it (without npm).
    #[cfg(test)]
    pub(crate) fn mark_candidate(&self, preset: &str, version: &str) {
        self.update(preset, version, |_| Ok(Some(Record { status: Status::Installed, checked_at: now(), ..Record::default() }))).unwrap();
    }

    /// The suite started on `version`.
    pub fn begin_verification(&self, preset: &str, version: &str) -> Result<(), String> {
        npm_preset(preset)?;
        self.update(preset, version, |old| {
            let r = old.ok_or_else(|| format!("{preset} {version} isn't a candidate; install it first"))?;
            r.status = Status::Verifying;
            r.checked_at = now();
            Ok(None)
        })
    }

    /// Store what the suite found. Any failure marks the version `failed` (it
    /// never runs); a pass leaves it `verifying` until [`Self::promote`].
    pub fn record_result(&self, preset: &str, version: &str, outcome: &Outcome) -> Result<(), String> {
        npm_preset(preset)?;
        self.update(preset, version, |old| {
            let r = old.ok_or_else(|| format!("{preset} {version} isn't a candidate; install it first"))?;
            r.status = if outcome.failures.is_empty() { Status::Verifying } else { Status::Failed };
            r.failures.clone_from(&outcome.failures);
            r.advisories.clone_from(&outcome.advisories);
            r.checked_at = now();
            Ok(None)
        })
    }

    /// Mark a version that passed as `verified`: from the next start it runs,
    /// unless the user holds the preset at another version.
    pub fn promote(&self, preset: &str, version: &str) -> Result<(), String> {
        let (_, pinned) = npm_preset(preset)?;
        let spec = pinned.at(version)?;
        if agent_install::installed(&self.root, &spec).is_none() {
            return Err(format!("{spec} isn't installed"));
        }
        self.update(preset, version, |old| {
            let r = old.ok_or_else(|| format!("{preset} {version} was never checked"))?;
            if r.status == Status::Failed || !r.failures.is_empty() {
                return Err(format!("{preset} {version} failed its checks: {}", r.failures.first().map_or("", String::as_str)));
            }
            r.status = Status::Verified;
            r.checked_at = now();
            Ok(None)
        })
    }

    /// The version folders worth keeping: per npm preset, the pin, the hold,
    /// what runs, and newer versions still waiting or verified. Failed versions
    /// and older ones go.
    pub fn keep(&self, holds: &BTreeMap<String, String>) -> BTreeSet<String> {
        let records = self.records();
        let mut keep = BTreeSet::new();
        for preset in agents::PRESETS {
            let (Some(pinned), Some(active)) = (preset.spec(), Self::active_in(preset, holds, &records)) else { continue };
            keep.insert(pinned.folder());
            keep.extend(holds.get(preset.id).and_then(|h| pinned.at(h).ok()).map(|s| s.folder()));
            for (v, r) in records.get(preset.id).into_iter().flatten() {
                if r.status != Status::Failed && newer(v, &active.version) {
                    keep.extend(pinned.at(v).ok().map(|s| s.folder()));
                }
            }
            keep.insert(active.folder());
        }
        keep
    }

    /// Read each package's `dist-tags.latest` from the registry at `base` and
    /// cache it. A package that fails keeps its last known answer. Errs only
    /// when none could be read; otherwise returns the failures.
    pub async fn refresh_latest(&self, base: &str, packages: &[String]) -> Result<Vec<String>, String> {
        let mut tasks = tokio::task::JoinSet::new();
        for pkg in packages {
            let (base, pkg) = (base.to_owned(), pkg.clone());
            tasks.spawn(async move {
                let got = fetch_latest(&base, &pkg).await;
                (pkg, got)
            });
        }
        let (mut found, mut errors) = (BTreeMap::new(), vec![]);
        while let Some(done) = tasks.join_next().await {
            match done {
                Ok((pkg, Ok(v))) => {
                    found.insert(pkg, Latest { latest: v, checked_at: now() });
                }
                Ok((pkg, Err(e))) => errors.push(format!("{pkg}: {e}")),
                Err(e) => errors.push(e.to_string()),
            }
        }
        if found.is_empty() && !errors.is_empty() {
            return Err(format!("couldn't reach the npm registry: {}", errors[0]));
        }
        self.latest.update(|all: &mut BTreeMap<String, Latest>| {
            all.extend(found);
            Ok(())
        })?;
        Ok(errors)
    }

    /// Whether some npm preset's latest version is unknown or older than [`CHECK_EVERY`].
    fn check_due(&self) -> bool {
        let latest = self.latest();
        let stale = now().saturating_sub(CHECK_EVERY.as_secs());
        agents::PRESETS.iter().filter_map(Preset::spec).any(|s| latest.get(&s.name).is_none_or(|l| l.checked_at < stale))
    }

    /// The daily check: refresh the latest versions (when due, or `force`), then
    /// install newer ones for the presets in `in_use` as candidates and hand each
    /// to the [`Verifier`]. Candidates install on background threads.
    pub async fn check(&'static self, base: &str, force: bool, in_use: &BTreeSet<&'static str>) -> Result<(), String> {
        if !force && !self.check_due() {
            return Ok(());
        }
        let packages: Vec<String> = agents::PRESETS.iter().filter_map(Preset::spec).map(|s| s.name).collect();
        for e in self.refresh_latest(base, &packages).await? {
            eprintln!("[agents] version check: {e}");
        }
        let holds = crate::settings::agent_versions();
        for (preset, version) in self.candidates(&holds, in_use) {
            std::thread::spawn(move || match self.install_candidate(preset, &version) {
                Ok(_) => match VERIFIER.get() {
                    Some(v) => v.candidate_installed(self, preset, &version),
                    None => eprintln!("[agents] {preset} {version} installed; it runs once verified"),
                },
                Err(e) => eprintln!("[agents] couldn't install {preset} {version} to check it: {e}"),
            });
        }
        Ok(())
    }

    /// Newer versions to install as candidates: per preset in use, the registry's
    /// latest when it's newer than what runs and yaah hasn't seen it yet.
    pub fn candidates(&self, holds: &BTreeMap<String, String>, in_use: &BTreeSet<&'static str>) -> Vec<(&'static str, String)> {
        let (latest, records) = (self.latest(), self.records());
        agents::PRESETS
            .iter()
            .filter(|p| in_use.contains(p.id))
            .filter_map(|p| {
                let active = Self::active_in(p, holds, &records)?;
                let pinned = p.spec()?;
                let l = &latest.get(&active.name)?.latest;
                let unseen = records.get(p.id).is_none_or(|r| !r.contains_key(l));
                (unseen && newer(l, &active.version) && !newer(&pinned.version, l)).then(|| (p.id, l.clone()))
            })
            .collect()
    }
}

/// `dist-tags.latest` of `pkg` from the registry at `base` (the small "install" document).
pub async fn fetch_latest(base: &str, pkg: &str) -> Result<String, String> {
    let url = format!("{}/{}", base.trim_end_matches('/'), pkg.replace('/', "%2f"));
    let resp = crate::integrations::http()
        .get(url)
        .header(reqwest::header::ACCEPT, "application/vnd.npm.install-v1+json")
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let body = crate::integrations::read_capped(resp, MAX_DOC).await?;
    latest_tag(&serde_json::from_slice(&body).map_err(|_| "the answer wasn't JSON".to_owned())?)
}

/// The `latest` tag, only: a prerelease counts only when it's what `latest` points at.
fn latest_tag(doc: &Value) -> Result<String, String> {
    let v = doc["dist-tags"]["latest"].as_str().ok_or("no `latest` tag")?;
    Version::parse(v).map(|_| v.to_owned()).ok_or_else(|| format!("`latest` is `{v}`, not a version"))
}

/// The daily check, in the background for as long as the app runs.
pub fn watch() {
    tauri::async_runtime::spawn(async {
        loop {
            let in_use = agents::presets_in_use(&agents::Store::user().load());
            if let Err(e) = Versions::user().check(REGISTRY, false, &in_use).await {
                eprintln!("[agents] version check: {e}");
            }
            tokio::time::sleep(WAKE_EVERY).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_install::tests::{fake_install, temp_dir};
    use serde_json::json;

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap_or_else(|| panic!("{s}"))
    }

    #[test]
    fn semver_precedence() {
        // The order from semver.org §11, then core numbers compared as numbers.
        let ordered = [
            "1.0.0-alpha",
            "1.0.0-alpha.1",
            "1.0.0-alpha.beta",
            "1.0.0-beta",
            "1.0.0-beta.2",
            "1.0.0-beta.11",
            "1.0.0-rc.1",
            "1.0.0",
            "1.0.1",
            "1.2.0",
            "1.10.0",
            "2.0.0",
        ];
        for w in ordered.windows(2) {
            assert!(v(w[0]) < v(w[1]), "{} < {}", w[0], w[1]);
            assert!(newer(w[1], w[0]) && !newer(w[0], w[1]));
        }
        assert_eq!(v("1.0.0+build.5"), v("1.0.0"), "build metadata doesn't count");
        assert!(v("0.100.0") > v("0.99.1"), "numbers, not text");
        assert!(v("1.0.0-rc.1").is_prerelease() && !v("1.0.0").is_prerelease());
        for bad in [
            "",
            "1",
            "1.2",
            "1.2.3.4",
            "v1.2.3",
            "01.2.3",
            "1.02.3",
            "1.2.3-",
            "1.2.3-01",
            "1.2.3-a..b",
            "1.2.3+",
            "^1.2.3",
            "~1.2.3",
            "latest",
            "1.2.x",
            "1.2.3 ",
            "1.2.3-a_b",
            "file:../x",
        ] {
            assert!(Version::parse(bad).is_none(), "{bad:?}");
        }
        assert!(!newer("latest", "1.0.0") && !newer("1.0.0", "x"));
    }

    fn record(status: Status) -> Record {
        Record { status, ..Record::default() }
    }

    #[test]
    fn what_runs_is_the_hold_else_the_newest_verified_else_the_pin() {
        let recs: BTreeMap<String, Record> = [
            ("1.1.0", Status::Verified),
            ("1.3.0", Status::Verified),
            ("1.4.0", Status::Failed),
            ("1.5.0", Status::Verifying),
            ("1.6.0", Status::Installed),
            ("0.9.0", Status::Verified),
        ]
        .into_iter()
        .map(|(k, s)| (k.to_owned(), record(s)))
        .collect();
        assert_eq!(choose("1.0.0", None, Some(&recs)), "1.3.0", "only verified ones, the newest");
        assert_eq!(choose("1.0.0", Some("1.1.0"), Some(&recs)), "1.1.0", "a hold wins");
        assert_eq!(choose("1.0.0", Some("not-a-version"), Some(&recs)), "1.3.0");
        assert_eq!(choose("2.0.0", None, Some(&recs)), "2.0.0", "never below the pin");
        assert_eq!(choose("1.0.0", None, None), "1.0.0");
        let pre: BTreeMap<String, Record> = [("1.1.0-rc.1".to_owned(), record(Status::Verified))].into();
        assert_eq!(choose("1.0.0", None, Some(&pre)), "1.1.0-rc.1", "a verified prerelease above the pin counts like any verified version");
    }

    /// A stand-in npm registry: path → (status, body), recording each request's path and Accept header.
    fn registry(answers: Vec<(&'static str, u16, String)>) -> (String, std::sync::mpsc::Receiver<(String, String)>) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}", server.server_addr().to_ip().unwrap());
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for req in server.incoming_requests() {
                let accept = req.headers().iter().find(|h| h.field.equiv("accept")).map(|h| h.value.to_string()).unwrap_or_default();
                let path = req.url().to_owned();
                let _ = tx.send((path.clone(), accept));
                let (status, body) = answers.iter().find(|(p, ..)| *p == path).map_or((404, "{}".to_owned()), |(_, s, b)| (*s, b.clone()));
                let _ = req.respond(tiny_http::Response::from_string(body).with_status_code(status));
            }
        });
        (base, rx)
    }

    #[tokio::test]
    async fn reads_latest_from_the_registry_and_keeps_the_last_answer_on_errors() {
        let root = temp_dir("versions");
        let versions = Versions::at(root.clone());
        let doc = |latest: &str| {
            json!({ "name": "x", "dist-tags": { "latest": latest, "next": "9.0.0-beta.1" }, "versions": { "1.0.0": {}, "9.0.0-beta.1": {} } })
                .to_string()
        };
        let (base, seen) = registry(vec![
            ("/@yaah%2ftool", 200, doc("1.2.0")),
            ("/plain", 200, doc("2.0.0-rc.1")),
            ("/broken", 200, "<html>".into()),
            ("/tagged", 200, json!({ "dist-tags": { "latest": "^1.0.0" } }).to_string()),
        ]);
        assert_eq!(fetch_latest(&base, "@yaah/tool").await.unwrap(), "1.2.0", "`latest`, never the newer `next`");
        let (path, accept) = seen.recv().unwrap();
        assert_eq!((path.as_str(), accept.as_str()), ("/@yaah%2ftool", "application/vnd.npm.install-v1+json"));
        assert_eq!(fetch_latest(&base, "plain").await.unwrap(), "2.0.0-rc.1", "a prerelease only when it is `latest`");
        assert!(fetch_latest(&base, "broken").await.unwrap_err().contains("JSON"));
        assert!(fetch_latest(&base, "tagged").await.unwrap_err().contains("not a version"));
        assert!(fetch_latest(&base, "missing").await.unwrap_err().contains("404"));

        let pkgs = ["@yaah/tool".to_owned(), "missing".to_owned()];
        let errors = versions.refresh_latest(&base, &pkgs).await.unwrap();
        assert_eq!(errors.len(), 1, "{errors:?}");
        let cached = versions.latest();
        assert_eq!(cached["@yaah/tool"].latest, "1.2.0");
        assert!(!cached.contains_key("missing"));
        let raw: Value = serde_json::from_str(&std::fs::read_to_string(root.join("versions.json")).unwrap()).unwrap();
        assert!(raw["@yaah/tool"]["checkedAt"].as_u64().is_some(), "{raw}");

        // Offline: an error, and what was known stays.
        let err = versions.refresh_latest("http://127.0.0.1:9", &pkgs).await.unwrap_err();
        assert!(err.contains("couldn't reach"), "{err}");
        assert_eq!(versions.latest(), cached);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_candidate_runs_only_once_promoted() {
        let root = temp_dir("verify");
        let versions = Versions::at(root.clone());
        let claude = agents::preset(agents::CLAUDE).unwrap();
        let pinned = claude.spec().unwrap();
        let none = BTreeMap::new();
        assert_eq!(versions.active(claude, &none), Some(pinned.clone()));

        // As install_candidate leaves it (npm itself is tested in agent_install).
        let next = pinned.at("999.0.0").unwrap();
        fake_install(&root, &next);
        versions.update("claude", "999.0.0", |_| Ok(Some(Record { status: Status::Installed, ..Record::default() }))).unwrap();
        assert_eq!(versions.active(claude, &none), Some(pinned.clone()), "installed isn't verified");
        assert!(versions.promote("claude", "999.0.0").is_ok(), "an installed candidate with no failures may be promoted directly");
        assert_eq!(versions.active(claude, &none), Some(next.clone()));

        // A failure is recorded and blocks promotion.
        let later = pinned.at("999.1.0").unwrap();
        fake_install(&root, &later);
        assert!(versions.begin_verification("claude", "999.1.0").is_err(), "not a candidate yet");
        versions.update("claude", "999.1.0", |_| Ok(Some(Record::default()))).unwrap();
        versions.begin_verification("claude", "999.1.0").unwrap();
        assert_eq!(versions.records()["claude"]["999.1.0"].status, Status::Verifying);
        let advisory =
            Advisory { id: "GHSA-x".into(), severity: "high".into(), title: "t".into(), url: "https://github.com/advisories/GHSA-x".into() };
        let failed = Outcome { failures: vec!["session/new timed out".into()], advisories: vec![advisory.clone()] };
        versions.record_result("claude", "999.1.0", &failed).unwrap();
        let r = &versions.records()["claude"]["999.1.0"];
        assert_eq!((r.status, r.failures.as_slice(), r.advisories.as_slice()), (Status::Failed, &failed.failures[..], &[advisory][..]));
        assert!(versions.promote("claude", "999.1.0").unwrap_err().contains("session/new timed out"));
        assert_eq!(versions.active(claude, &none), Some(next.clone()));

        // A pass waits for promote.
        versions.record_result("claude", "999.1.0", &Outcome::default()).unwrap();
        assert_eq!(versions.records()["claude"]["999.1.0"].status, Status::Verifying);
        assert_eq!(versions.active(claude, &none), Some(next.clone()));
        versions.promote("claude", "999.1.0").unwrap();
        assert_eq!(versions.active(claude, &none), Some(later.clone()));
        // A hold freezes it.
        let holds = BTreeMap::from([("claude".to_owned(), "999.0.0".to_owned())]);
        assert_eq!(versions.active(claude, &holds), Some(next.clone()));

        // Not installed, unknown, or not an npm preset: refused.
        assert!(versions.promote("claude", "999.2.0").is_err());
        assert!(versions.record_result("claude", "998.0.0", &Outcome::default()).is_err());
        assert!(versions.begin_verification("goose", "1.0.0").is_err());
        assert!(versions.candidate_command("claude", "latest").is_err());
        if crate::path_env::which("node").is_some() {
            let (program, args) = versions.candidate_command("claude", "999.1.0").unwrap();
            assert!(program.ends_with("node") && args[0].contains("999.1.0"), "{program} {args:?}");
        }

        // What cleanup keeps: pin, hold, what runs, newer verified; not older ones.
        let keep = versions.keep(&BTreeMap::new());
        assert!(keep.contains(&pinned.folder()) && keep.contains(&later.folder()) && !keep.contains(&next.folder()));
        assert!(versions.keep(&holds).contains(&next.folder()) && versions.keep(&holds).contains(&later.folder()));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn candidates_are_newer_unseen_versions_of_presets_in_use() {
        let root = temp_dir("candidates");
        let versions = Versions::at(root.clone());
        let claude = agents::preset(agents::CLAUDE).unwrap().spec().unwrap();
        let gemini = agents::preset("gemini").unwrap().spec().unwrap();
        let set = |pkg: &str, latest: &str| {
            versions
                .latest
                .update(|m: &mut BTreeMap<String, Latest>| {
                    m.insert(pkg.to_owned(), Latest { latest: latest.into(), checked_at: now() });
                    Ok(())
                })
                .unwrap();
        };
        set(&claude.name, "999.0.0");
        set(&gemini.name, "999.0.0");
        let in_use = BTreeSet::from(["claude"]);
        let none = BTreeMap::new();
        assert_eq!(versions.candidates(&none, &in_use), [("claude", "999.0.0".to_owned())], "only presets a saved agent uses");
        versions.update("claude", "999.0.0", |_| Ok(Some(record(Status::Failed)))).unwrap();
        assert!(versions.candidates(&none, &in_use).is_empty(), "a version seen before isn't tried again");
        set(&claude.name, &claude.version);
        assert!(versions.candidates(&none, &in_use).is_empty(), "nothing newer");
        set(&claude.name, "0.0.1");
        assert!(versions.candidates(&none, &in_use).is_empty(), "never below the pin");
        assert!(versions.check_due(), "the other npm presets were never checked");
        std::fs::remove_dir_all(root).unwrap();
    }
}
