//! yaah's own copy of each npm-based agent (a preset with an `npx` package).
//!
//! `npx -y <pkg>@<v>` costs about 280 ms on every start (npm resolves the
//! package each time) and keeps npm's node process alive as the agent's parent
//! (about 115 MB per running agent). So a version's first start runs through npx
//! as before while yaah installs that version in the background, once, into
//! `~/.yaah/agents/<pkg>@<v>/`; later starts run its program with `node`.
//!
//! - One folder per exact version: a new pin, or a newer verified version, gets its own.
//! - npm installs into a temp folder beside it, renamed into place when it's done
//!   and checked, so a crash or a failed install never leaves a folder that's used.
//! - One install of a version at a time (a lock each): two profiles starting at once install once.
//! - npm runs without a shell, with the login shell's PATH (`path_env`).
//! - Version folders nothing refers to any more are removed at startup ([`cleanup`]).
//!
//! Agents the ACP registry ships as release archives (goose, OpenCode: its
//! `agent.json` `distribution.binary`) go the same way ([`ensure_source`] with
//! an [`Archive`]): the archive is downloaded with the app's HTTP client, its
//! sha256 checked against the pin ([`BINARIES`]) or the registry's entry,
//! extracted with the system `tar`/`unzip` into a temp folder, and renamed into
//! `~/.yaah/agents/<registry id>@<version>/`. A [`BINARY_MANIFEST`] in the
//! folder names the program, so [`installed`] needs no preset to find it.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fmt;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant, SystemTime};

use crate::agent_versions::Version;

/// Temp folders an install works in start with this.
const TMP_PREFIX: &str = ".tmp-";
/// npm gets this long; a stuck install is stopped.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(600);
/// A temp folder older than this is from an install that died.
const STALE_TMP: Duration = Duration::from_secs(3600);
/// What a binary install's folder records about it (and how [`installed`] tells it from an npm one).
pub const BINARY_MANIFEST: &str = "yaah-binary.json";
/// The largest release archive downloaded (OpenCode's is about 80 MB zipped).
const MAX_ARCHIVE: u64 = 1 << 30;

// ── Release archives (the ACP registry's `distribution.binary`) ─────────────

/// One platform's download in an agent's `distribution.binary`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Archive {
    /// `https://…` (`http://` only to this machine, for tests).
    pub url: String,
    /// Of the archive, hex.
    pub sha256: String,
    /// The program inside it, relative (`./goose`).
    pub cmd: String,
}

/// One platform's entry of a pinned binary.
#[derive(Debug)]
pub struct Target {
    /// The registry's platform name: `darwin-aarch64`, `linux-x86_64`, …
    pub platform: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub cmd: &'static str,
}

/// An agent yaah installs from the ACP registry's release archives, pinned the
/// way npm presets pin their package: the version yaah was tested with and,
/// per platform, the archive and its sha256 (copied from the registry's
/// `agent.json` at that version). Newer versions come from the registry
/// (`agent_versions`), and run once the conformance suite verified them.
#[derive(Debug)]
pub struct BinaryPin {
    pub preset: &'static str,
    /// Its id in the registry (github.com/agentclientprotocol/registry/<id>/agent.json).
    pub registry_id: &'static str,
    pub version: &'static str,
    pub targets: &'static [Target],
}

impl BinaryPin {
    pub fn spec(&self) -> Spec {
        Spec { name: self.registry_id.to_owned(), version: self.version.to_owned() }
    }

    /// This platform's download, if the pin has one.
    pub fn archive(&self) -> Option<Archive> {
        let here = platform()?;
        self.targets.iter().find(|t| t.platform == here).map(|t| Archive {
            url: t.url.to_owned(),
            sha256: t.sha256.to_owned(),
            cmd: t.cmd.to_owned(),
        })
    }
}

/// Binary agents, by preset. Registry ids, not npm names, but they follow npm's naming rules so [`Spec`] holds them.
pub const BINARIES: &[BinaryPin] = &[
    BinaryPin {
        preset: "goose",
        registry_id: "goose",
        version: "1.57.0",
        targets: &[
            Target {
                platform: "darwin-aarch64",
                url: "https://github.com/block/goose/releases/download/v1.57.0/goose-aarch64-apple-darwin.tar.bz2",
                sha256: "2fbafa227ab28654c47065f1c9ebcd12f527f017e30c08e618bc6fcf363d7935",
                cmd: "./goose",
            },
            Target {
                platform: "darwin-x86_64",
                url: "https://github.com/block/goose/releases/download/v1.57.0/goose-x86_64-apple-darwin.tar.bz2",
                sha256: "e48fe024891a4c272a89c74b9ae843d76a73229643c917b785b0680fef9c647a",
                cmd: "./goose",
            },
            Target {
                platform: "linux-aarch64",
                url: "https://github.com/block/goose/releases/download/v1.57.0/goose-aarch64-unknown-linux-gnu.tar.bz2",
                sha256: "17c6b090db6acc5605da904bbe19cc2765bc7a6786019d85a6d0a361de06dbf7",
                cmd: "./goose",
            },
            Target {
                platform: "linux-x86_64",
                url: "https://github.com/block/goose/releases/download/v1.57.0/goose-x86_64-unknown-linux-gnu.tar.bz2",
                sha256: "e54036f3b7f95d3b0d7854c09465af5ef52a28c7fa03d2497d0ea68a6382282d",
                cmd: "./goose",
            },
        ],
    },
    // The registry's `opencode-v2` entry (OpenCode 2.x).
    BinaryPin {
        preset: "opencode",
        registry_id: "opencode-v2",
        version: "2.2.5",
        targets: &[
            Target {
                platform: "darwin-aarch64",
                url: "https://opencode.ai/files/bin/2.2.5/opencode-darwin-arm64.zip",
                sha256: "25ba9908979fa7d764792c82589b4b5768ab1511154e0317d98aa77d216ce767",
                cmd: "./opencode",
            },
            Target {
                platform: "darwin-x86_64",
                url: "https://opencode.ai/files/bin/2.2.5/opencode-darwin-x64.zip",
                sha256: "4d4419022e6ffbd48afc97c5101bdf001d38b0499f516169b9a80a87a340fd56",
                cmd: "./opencode",
            },
            Target {
                platform: "linux-aarch64",
                url: "https://opencode.ai/files/bin/2.2.5/opencode-linux-arm64.tar.gz",
                sha256: "5a528f42caf576c6cdece6a191eb273d3db54effa5518e0402684d8f8026aeb6",
                cmd: "./opencode",
            },
            Target {
                platform: "linux-x86_64",
                url: "https://opencode.ai/files/bin/2.2.5/opencode-linux-x64.tar.gz",
                sha256: "09f44302c10fd036912f59c81fd1aef5df45dd06f649197f9dfc9bbe2a79614e",
                cmd: "./opencode",
            },
        ],
    },
];

/// The pinned binary of a preset, if it has one.
pub fn binary_pin(preset: &str) -> Option<&'static BinaryPin> {
    BINARIES.iter().find(|b| b.preset == preset)
}

/// This machine's platform, as the registry names it.
pub fn platform() -> Option<&'static str> {
    Some(match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "darwin-aarch64",
        ("macos", "x86_64") => "darwin-x86_64",
        ("linux", "aarch64") => "linux-aarch64",
        ("linux", "x86_64") => "linux-x86_64",
        ("windows", "aarch64") => "windows-aarch64",
        ("windows", "x86_64") => "windows-x86_64",
        _ => return None,
    })
}

impl Archive {
    /// Refuse what a registry entry shouldn't hold: another scheme, a digest
    /// that isn't one, a program outside the archive's folder.
    pub fn validate(&self) -> Result<(), String> {
        let loopback = ["http://127.0.0.1:", "http://localhost:", "http://[::1]:"].iter().any(|p| self.url.starts_with(p));
        if !self.url.starts_with("https://") && !loopback {
            return Err(format!("{} isn't an https download", self.url));
        }
        if self.sha256.len() != 64 || !self.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(format!("`{}` isn't a sha256", self.sha256));
        }
        let rel = Path::new(&self.cmd);
        let inside = rel.components().all(|c| matches!(c, std::path::Component::CurDir | std::path::Component::Normal(_)));
        if self.cmd.is_empty() || !inside || self.cmd.contains('\\') {
            return Err(format!("the program `{}` isn't a path inside the archive", self.cmd));
        }
        Ok(())
    }

    /// How to unpack it, from the URL's file name.
    #[allow(clippy::case_sensitive_file_extension_comparisons, reason = "the name is lowercased first")]
    fn kind(&self) -> ArchiveKind {
        let name = self.url.split(['?', '#']).next().unwrap_or_default().rsplit('/').next().unwrap_or_default().to_ascii_lowercase();
        if name.ends_with(".zip") {
            ArchiveKind::Zip
        } else if [".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz", ".tar"].iter().any(|e| name.ends_with(e)) {
            ArchiveKind::Tar
        } else {
            ArchiveKind::Raw
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArchiveKind {
    Zip,
    Tar,
    /// The download is the program itself.
    Raw,
}

/// What [`BINARY_MANIFEST`] holds.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct BinaryManifest {
    name: String,
    version: String,
    #[serde(flatten)]
    archive: Archive,
}

/// A pinned npm package: a name and an exact version (never a range or a tag).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Spec {
    pub name: String,
    pub version: String,
}

impl Spec {
    /// `name@1.2.3` or `@scope/name@1.2.3`.
    pub fn parse(spec: &str) -> Result<Self, String> {
        let at = spec.rfind('@').filter(|&i| i > 0).ok_or_else(|| format!("`{spec}` has no version"))?;
        Self::new(&spec[..at], &spec[at + 1..])
    }

    pub fn new(name: &str, version: &str) -> Result<Self, String> {
        if !valid_name(name) {
            return Err(format!("`{name}` isn't an npm package name"));
        }
        if Version::parse(version).is_none() {
            return Err(format!("`{version}` isn't an exact version such as 1.2.3"));
        }
        Ok(Self { name: name.to_owned(), version: version.to_owned() })
    }

    /// The same package at another version.
    pub fn at(&self, version: &str) -> Result<Self, String> {
        Self::new(&self.name, version)
    }

    /// Its folder under the agents root. A scoped name's `/` becomes `+`, which
    /// npm names can't contain, so two packages never share a folder.
    pub fn folder(&self) -> String {
        format!("{}@{}", self.name.replace('/', "+"), self.version)
    }
}

impl fmt::Display for Spec {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}@{}", self.name, self.version)
    }
}

/// npm's rules, minus old upper-case names: `name` or `@scope/name`, URL-safe,
/// not starting with `.` or `_`, at most 214 characters. So never a path.
fn valid_name(name: &str) -> bool {
    let part = |p: &str| {
        !p.is_empty() && !p.starts_with(['.', '_']) && p.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "-._~".contains(c))
    };
    name.len() <= 214
        && match name.strip_prefix('@') {
            Some(scoped) => scoped.split_once('/').is_some_and(|(s, n)| part(s) && part(n)),
            None => part(name),
        }
}

/// The inverse of [`Spec::folder`], for folders found on disk.
fn spec_of_folder(folder: &str) -> Option<Spec> {
    Spec::parse(&folder.replacen('+', "/", 1)).ok().filter(|s| s.folder() == folder)
}

/// A package yaah installed, ready to start.
#[derive(Debug, Clone, PartialEq)]
pub struct Installed {
    /// `node` (or the program itself, when it isn't a node script).
    pub program: PathBuf,
    /// The program's path when `program` is node, with any node options from its shebang first.
    pub args: Vec<String>,
    /// The program file.
    pub bin: PathBuf,
}

impl Installed {
    pub fn command(&self) -> (String, Vec<String>) {
        (self.program.to_string_lossy().into_owned(), self.args.clone())
    }
}

/// `~/.yaah/agents`.
pub fn root() -> PathBuf {
    crate::accounts::home().join(".yaah/agents")
}

/// Where a version lives under `root`.
pub fn dir(root: &Path, spec: &Spec) -> PathBuf {
    root.join(spec.folder())
}

/// The installed package's folder (`<version folder>/node_modules/<name>`).
fn package_dir(version_dir: &Path, spec: &Spec) -> PathBuf {
    version_dir.join("node_modules").join(&spec.name)
}

/// The complete install of `spec` under `root`, if there is one: its package
/// has that version and its program is there.
pub fn installed(root: &Path, spec: &Spec) -> Option<Installed> {
    let dir = dir(root, spec);
    // Our own folder, not a link someone put there.
    if !dir.symlink_metadata().is_ok_and(|m| m.is_dir()) {
        return None;
    }
    check(&dir, spec).ok()
}

/// Whether `version_dir` holds a release archive's program rather than an npm package.
pub fn is_binary(version_dir: &Path) -> bool {
    version_dir.join(BINARY_MANIFEST).is_file()
}

/// What makes an install usable: the package at the right version, and a program to start.
fn check(version_dir: &Path, spec: &Spec) -> Result<Installed, String> {
    if is_binary(version_dir) {
        return check_binary(version_dir, spec);
    }
    let pkg = package_dir(version_dir, spec);
    let raw = std::fs::read(pkg.join("package.json")).map_err(|_| format!("{spec} isn't in {}", version_dir.display()))?;
    let manifest: Value = serde_json::from_slice(&raw).map_err(|e| format!("{spec}'s package.json: {e}"))?;
    if manifest["version"].as_str() != Some(spec.version.as_str()) {
        return Err(format!("npm installed {} {}, not {}", spec.name, manifest["version"], spec.version));
    }
    let bin = bin_path(&pkg, &manifest)?;
    launcher(&bin, crate::path_env::which("node"))
}

/// The program npx would run for a package, by npm's rule: its only `bin` (or
/// the one every entry points at), else the one named like the package without
/// its scope. It has to be a file inside the package.
pub fn bin_path(pkg_dir: &Path, manifest: &Value) -> Result<PathBuf, String> {
    let name = manifest["name"].as_str().ok_or("its package.json has no name")?;
    let short = name.rsplit('/').next().unwrap_or(name);
    let rel = match &manifest["bin"] {
        Value::String(s) => s.as_str(),
        Value::Object(map) if !map.is_empty() => {
            // npm compares them normalised: `./x.js` and `x.js` are one program.
            let targets: HashSet<&str> = map.values().filter_map(Value::as_str).map(|t| t.trim_start_matches("./")).collect();
            match (targets.len(), map.get(short).and_then(Value::as_str)) {
                (1, _) if map.values().all(Value::is_string) => targets.into_iter().next().unwrap_or_default(),
                (_, Some(own)) => own,
                _ => return Err(format!("{name} has several programs and none is called {short}")),
            }
        }
        _ => return Err(format!("{name} has no program to run (no `bin` in its package.json)")),
    };
    let missing = || format!("{name}'s program {rel} is missing");
    let path = pkg_dir.join(rel).canonicalize().map_err(|_| missing())?;
    let base = pkg_dir.canonicalize().map_err(|_| missing())?;
    if !path.starts_with(&base) {
        return Err(format!("{name}'s program {rel} is outside the package"));
    }
    if !path.is_file() {
        return Err(missing());
    }
    Ok(path)
}

/// How to start `bin`: with `node` when it's a node script (a node shebang, or
/// none and text), else on its own (another interpreter's shebang, a native program).
fn launcher(bin: &Path, node: Option<PathBuf>) -> Result<Installed, String> {
    let mut head = Vec::with_capacity(512);
    std::fs::File::open(bin).and_then(|f| f.take(512).read_to_end(&mut head)).map_err(|e| format!("can't read {}: {e}", bin.display()))?;
    let bin_arg = bin.to_string_lossy().into_owned();
    let node_options = match head.strip_prefix(b"#!") {
        Some(rest) => {
            let line = String::from_utf8_lossy(rest.split(|&b| b == b'\n').next().unwrap_or_default()).into_owned();
            let words: Vec<&str> = line.split_whitespace().collect();
            // `#!/usr/bin/env node`, `#!/usr/bin/env -S node --flag`, `#!/opt/node/bin/node`.
            words
                .iter()
                .position(|w| Path::new(w).file_name().is_some_and(|n| n == "node"))
                .map(|i| words[i + 1..].iter().map(|w| (*w).to_owned()).collect::<Vec<_>>())
        }
        None if head.contains(&0) => None,
        None => Some(vec![]),
    };
    if let Some(mut args) = node_options {
        let node = node.ok_or("node isn't on your PATH")?;
        args.push(bin_arg);
        return Ok(Installed { program: node, args, bin: bin.to_owned() });
    }
    crate::path_env::which(&bin_arg).ok_or_else(|| format!("{} isn't executable", bin.display()))?;
    Ok(Installed { program: bin.to_owned(), args: vec![], bin: bin.to_owned() })
}

/// A binary install: its manifest is for this version, and its program is an
/// executable file inside the folder.
fn check_binary(version_dir: &Path, spec: &Spec) -> Result<Installed, String> {
    let raw = std::fs::read(version_dir.join(BINARY_MANIFEST)).map_err(|e| format!("{spec}'s {BINARY_MANIFEST}: {e}"))?;
    let m: BinaryManifest = serde_json::from_slice(&raw).map_err(|e| format!("{spec}'s {BINARY_MANIFEST}: {e}"))?;
    if m.name != spec.name || m.version != spec.version {
        return Err(format!("{} holds {}@{}, not {spec}", version_dir.display(), m.name, m.version));
    }
    m.archive.validate()?;
    let missing = || format!("{spec}'s program {} is missing", m.archive.cmd);
    let bin = version_dir.join(&m.archive.cmd).canonicalize().map_err(|_| missing())?;
    let base = version_dir.canonicalize().map_err(|_| missing())?;
    if !bin.starts_with(&base) || !bin.is_file() {
        return Err(missing());
    }
    if !is_executable(&bin) {
        return Err(format!("{} isn't executable", bin.display()));
    }
    Ok(Installed { program: bin.clone(), args: vec![], bin })
}

#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(p: &Path) -> bool {
    p.is_file()
}

/// One lock per version folder: whoever holds it is the only one installing it.
fn install_lock(folder: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(Mutex::default).lock().unwrap_or_else(PoisonError::into_inner).entry(folder.to_owned()).or_default().clone()
}

/// `spec`'s install under `root`, installing it first if it isn't there. Blocks
/// while npm runs.
pub fn ensure(root: &Path, spec: &Spec) -> Result<Installed, String> {
    ensure_from(root, spec, &spec.to_string())
}

/// [`ensure`], with npm installing `source` (a registry spec, or a local
/// tarball in tests) as `spec`.
fn ensure_from(root: &Path, spec: &Spec, source: &str) -> Result<Installed, String> {
    let lock = install_lock(&spec.folder());
    let _installing = lock.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(done) = installed(root, spec) {
        return Ok(done);
    }
    let npm = crate::path_env::which("npm").ok_or("npm isn't on your PATH")?;
    std::fs::create_dir_all(root).map_err(|e| format!("can't create {}: {e}", root.display()))?;
    let tmp = root.join(format!("{TMP_PREFIX}{}-{}", spec.folder(), crate::random::token()));
    std::fs::create_dir(&tmp).map_err(|e| format!("can't create {}: {e}", tmp.display()))?;
    let done = run_npm(&npm, &tmp, source).and_then(|()| {
        // Checked before it's in place: an install without its program never gets a folder.
        check(&tmp, spec)?;
        let target = dir(root, spec);
        match std::fs::rename(&tmp, &target) {
            Ok(()) => Ok(()),
            // Another yaah got there first.
            Err(_) if installed(root, spec).is_some() => Ok(()),
            Err(e) => Err(format!("can't move the install into {}: {e}", target.display())),
        }
    });
    if tmp.exists() {
        let _ = std::fs::remove_dir_all(&tmp);
    }
    done?;
    installed(root, spec).ok_or_else(|| format!("{spec} was installed but can't be started"))
}

/// `npm install --prefix <dir> … <source>`, no shell, stopped after [`INSTALL_TIMEOUT`].
fn run_npm(npm: &Path, dir: &Path, source: &str) -> Result<(), String> {
    // npm's output goes to a file, so a chatty install can't fill a pipe and stall.
    let log_path = dir.join("npm-install.log");
    let log = std::fs::File::create(&log_path).map_err(|e| e.to_string())?;
    let mut child = crate::path_env::command(npm)
        .args(["install", "--prefix"])
        .arg(dir)
        .args(["--no-audit", "--no-fund", "--omit=dev", "--no-update-notifier", "--loglevel=error"])
        .arg(source)
        // Not yaah's own folder: an `.npmrc` there has nothing to say about this.
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log)
        .spawn()
        .map_err(|e| format!("couldn't start npm: {e}"))?;
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if started.elapsed() > INSTALL_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("npm install {source} took longer than {INSTALL_TIMEOUT:?}"));
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let output = std::fs::read_to_string(&log_path).unwrap_or_default();
    let _ = std::fs::remove_file(&log_path);
    if status.success() {
        return Ok(());
    }
    let tail: Vec<&str> = output.lines().filter(|l| !l.trim().is_empty()).collect();
    Err(format!("npm install {source} failed ({status}): {}", tail[tail.len().saturating_sub(5)..].join("\n")))
}

/// `spec`'s install under `root`: from npm, or from `archive` for an agent the
/// registry ships as release archives. Blocks while it runs.
pub fn ensure_source(root: &Path, spec: &Spec, archive: Option<&Archive>) -> Result<Installed, String> {
    match archive {
        None => ensure(root, spec),
        Some(a) => ensure_archive(root, spec, a),
    }
}

/// [`ensure`] for a release archive: download it, check its sha256, unpack it
/// in a temp folder, check the program is there, then move the folder into
/// place. Blocks (the download runs on the app's async runtime); call it from
/// a thread that may block, never from async code.
pub fn ensure_archive(root: &Path, spec: &Spec, archive: &Archive) -> Result<Installed, String> {
    archive.validate()?;
    let lock = install_lock(&spec.folder());
    let _installing = lock.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(done) = installed(root, spec) {
        return Ok(done);
    }
    std::fs::create_dir_all(root).map_err(|e| format!("can't create {}: {e}", root.display()))?;
    let tmp = root.join(format!("{TMP_PREFIX}{}-{}", spec.folder(), crate::random::token()));
    std::fs::create_dir(&tmp).map_err(|e| format!("can't create {}: {e}", tmp.display()))?;
    let done = unpack_archive(&tmp, spec, archive).and_then(|()| {
        check(&tmp, spec)?;
        let target = dir(root, spec);
        match std::fs::rename(&tmp, &target) {
            Ok(()) => Ok(()),
            Err(_) if installed(root, spec).is_some() => Ok(()),
            Err(e) => Err(format!("can't move the install into {}: {e}", target.display())),
        }
    });
    if tmp.exists() {
        let _ = std::fs::remove_dir_all(&tmp);
    }
    done?;
    installed(root, spec).ok_or_else(|| format!("{spec} was installed but can't be started"))
}

/// Download `archive` into `dir`, check it, unpack it there and write the manifest.
fn unpack_archive(dir: &Path, spec: &Spec, archive: &Archive) -> Result<(), String> {
    // A dot name: never the program, and gone before the folder is used.
    let file = dir.join(".download");
    let url = archive.url.clone();
    let to = file.clone();
    let got = tauri::async_runtime::block_on(async move { download(&url, &to).await })?;
    if !got.eq_ignore_ascii_case(&archive.sha256) {
        return Err(format!("{spec}: the download's sha256 is {got}, but the registry says {}; not installed", archive.sha256.to_ascii_lowercase()));
    }
    let os = std::ffi::OsStr::new;
    match archive.kind() {
        ArchiveKind::Zip => run_tool("unzip", &[os("-q"), os("-o"), file.as_os_str(), os("-d"), dir.as_os_str()])?,
        ArchiveKind::Tar => run_tool("tar", &[os("-xf"), file.as_os_str(), os("-C"), dir.as_os_str()])?,
        ArchiveKind::Raw => {
            let to = dir.join(&archive.cmd);
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::copy(&file, &to).map_err(|e| format!("can't copy the download: {e}"))?;
        }
    }
    let _ = std::fs::remove_file(&file);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let bin = dir.join(&archive.cmd);
        if bin.symlink_metadata().is_ok_and(|m| m.is_file()) {
            let mode = std::fs::metadata(&bin).map_or(0o644, |m| m.permissions().mode());
            let _ = std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(mode | 0o755));
        }
    }
    let manifest = BinaryManifest { name: spec.name.clone(), version: spec.version.clone(), archive: archive.clone() };
    std::fs::write(dir.join(BINARY_MANIFEST), serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// GET `url` into `to` with the app's HTTP client; returns the body's sha256 (hex).
async fn download(url: &str, to: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Write;
    let mut resp = crate::integrations::http().get(url).timeout(INSTALL_TIMEOUT).send().await.map_err(|e| format!("can't download {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("can't download {url}: HTTP {}", resp.status()));
    }
    if resp.content_length().is_some_and(|n| n > MAX_ARCHIVE) {
        return Err(format!("{url} is larger than {} MB", MAX_ARCHIVE >> 20));
    }
    let mut out = std::fs::File::create(to).map_err(|e| format!("can't write {}: {e}", to.display()))?;
    let (mut hasher, mut total) = (Sha256::new(), 0u64);
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("can't download {url}: {e}"))? {
        total += chunk.len() as u64;
        if total > MAX_ARCHIVE {
            return Err(format!("{url} is larger than {} MB", MAX_ARCHIVE >> 20));
        }
        hasher.update(&chunk);
        out.write_all(&chunk).map_err(|e| format!("can't write {}: {e}", to.display()))?;
    }
    out.flush().map_err(|e| e.to_string())?;
    Ok(format!("{:x}", hasher.finalize()))
}

/// `tar` or `unzip`, no shell, with the login shell's PATH; its output only in the error.
fn run_tool(tool: &str, args: &[&std::ffi::OsStr]) -> Result<(), String> {
    let bin = crate::path_env::which(tool).ok_or_else(|| format!("{tool} isn't on your PATH; it's needed to unpack the download"))?;
    let out = crate::path_env::command(bin).args(args).stdin(Stdio::null()).output().map_err(|e| format!("couldn't start {tool}: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    Err(format!("{tool} failed ({}): {}", out.status, err.lines().take(5).collect::<Vec<_>>().join("\n")))
}

/// Install `spec` on a background thread, unless that's already happening. A
/// failure is only logged: an npm agent keeps starting through npx.
pub fn ensure_in_background(spec: Spec) {
    static RUNNING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    let running = RUNNING.get_or_init(Mutex::default);
    if !running.lock().unwrap_or_else(PoisonError::into_inner).insert(spec.folder()) {
        return;
    }
    std::thread::spawn(move || {
        let versions = crate::agent_versions::Versions::user();
        let root = versions.root();
        match versions.ensure(&spec) {
            Ok(_) => eprintln!("[agents] installed {spec} in {}", root.display()),
            Err(e) => eprintln!("[agents] couldn't install {spec}: {e}"),
        }
        running.lock().unwrap_or_else(PoisonError::into_inner).remove(&spec.folder());
    });
}

/// Remove what nothing needs from `root`: version folders not named in `keep`,
/// and temp folders an install left when it died. Only `root`'s own
/// sub-folders are touched (never a link or what it points at, never a file,
/// never a name that isn't one of ours). Returns the names removed.
pub fn cleanup(root: &Path, keep: &BTreeSet<String>) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(root) else { return vec![] };
    let mut removed = vec![];
    for entry in entries.filter_map(Result::ok) {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else { continue };
        // `DirEntry::file_type` doesn't follow links: a link to a folder isn't a folder here.
        let Ok(meta) = entry.path().symlink_metadata() else { continue };
        if !meta.is_dir() {
            continue;
        }
        let unused = if name.starts_with(TMP_PREFIX) {
            meta.modified().ok().and_then(|m| SystemTime::now().duration_since(m).ok()).is_some_and(|age| age > STALE_TMP)
        } else {
            spec_of_folder(&name).is_some() && !keep.contains(&name)
        };
        // A folder being installed right now is the lock holder's.
        let lock = install_lock(&name);
        let Ok(_free) = lock.try_lock() else { continue };
        if unused && std::fs::remove_dir_all(entry.path()).is_ok() {
            removed.push(name);
        }
    }
    removed
}

/// [`cleanup`] of `~/.yaah/agents` on a background thread.
pub fn cleanup_in_background(keep: BTreeSet<String>) {
    std::thread::spawn(move || {
        for name in cleanup(&root(), &keep) {
            eprintln!("[agents] removed {name}: nothing runs it any more");
        }
    });
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    pub(crate) fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("yaah-{tag}-{}", crate::random::token()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A package folder with `package.json` and the files given (path, contents).
    fn package(dir: &Path, manifest: &Value, files: &[(&str, &str)]) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("package.json"), manifest.to_string()).unwrap();
        for (rel, body) in files {
            let p = dir.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
        }
        dir.to_owned()
    }

    /// Put a fake install of `spec` in place by hand (what npm would leave).
    pub(crate) fn fake_install(root: &Path, spec: &Spec) -> PathBuf {
        let short = spec.name.rsplit('/').next().unwrap();
        let manifest = json!({ "name": spec.name, "version": spec.version, "bin": { short: "dist/index.js" } });
        package(&package_dir(&dir(root, spec), spec), &manifest, &[("dist/index.js", "#!/usr/bin/env node\nconsole.log('hi')\n")]);
        dir(root, spec)
    }

    /// Put a fake binary install of `spec` in place by hand (what [`ensure_archive`] leaves): `cmd` runs `script`.
    pub(crate) fn fake_binary_install(root: &Path, spec: &Spec, cmd: &str, script: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let d = dir(root, spec);
        let bin = d.join(cmd);
        std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
        std::fs::write(&bin, script).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let archive = Archive { url: "https://example.com/x.tar.gz".into(), sha256: "0".repeat(64), cmd: cmd.into() };
        let m = BinaryManifest { name: spec.name.clone(), version: spec.version.clone(), archive };
        std::fs::write(d.join(BINARY_MANIFEST), serde_json::to_vec(&m).unwrap()).unwrap();
        d
    }

    /// A stand-in download server: path → body. Counts requests per path.
    pub(crate) fn file_server(files: Vec<(String, Vec<u8>)>) -> (String, Arc<Mutex<HashMap<String, usize>>>) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}", server.server_addr().to_ip().unwrap());
        let hits: Arc<Mutex<HashMap<String, usize>>> = Arc::default();
        let seen = hits.clone();
        std::thread::spawn(move || {
            for req in server.incoming_requests() {
                let path = req.url().to_owned();
                *seen.lock().unwrap().entry(path.clone()).or_default() += 1;
                let _ = match files.iter().find(|(p, _)| *p == path) {
                    Some((_, body)) => req.respond(tiny_http::Response::from_data(body.clone())),
                    None => req.respond(tiny_http::Response::from_string("not here").with_status_code(404)),
                };
            }
        });
        (base, hits)
    }

    pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        format!("{:x}", Sha256::digest(bytes))
    }

    /// A `.tar.gz` (system `tar`) holding `files` (path, contents), each executable.
    pub(crate) fn tar_gz(work: &Path, files: &[(&str, &str)]) -> Vec<u8> {
        use std::os::unix::fs::PermissionsExt;
        let src = work.join(format!("tar-src-{}", crate::random::token()));
        for (rel, body) in files {
            let p = src.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, body).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let out = work.join(format!("{}.tar.gz", crate::random::token()));
        let ok = crate::path_env::command("tar").arg("-czf").arg(&out).arg("-C").arg(&src).arg(".").status().unwrap();
        assert!(ok.success());
        std::fs::read(out).unwrap()
    }

    /// A `.zip` with one stored (uncompressed) file, marked as a Unix executable; written by hand so tests need no `zip`.
    fn zip_one(name: &str, body: &[u8]) -> Vec<u8> {
        let crc = {
            let mut c = !0u32;
            for &b in body {
                c ^= u32::from(b);
                for _ in 0..8 {
                    c = if c & 1 == 1 { (c >> 1) ^ 0xEDB8_8320 } else { c >> 1 };
                }
            }
            !c
        };
        let (n, size) = (u16::try_from(name.len()).unwrap(), u32::try_from(body.len()).unwrap());
        let mut out = vec![];
        let le16 = |o: &mut Vec<u8>, v: u16| o.extend_from_slice(&v.to_le_bytes());
        let le32 = |o: &mut Vec<u8>, v: u32| o.extend_from_slice(&v.to_le_bytes());
        // Local file header.
        le32(&mut out, 0x0403_4b50);
        for v in [20u16, 0, 0, 0, 0] {
            le16(&mut out, v);
        }
        for v in [crc, size, size] {
            le32(&mut out, v);
        }
        le16(&mut out, n);
        le16(&mut out, 0);
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(body);
        let central = u32::try_from(out.len()).unwrap();
        // Central directory: made by Unix (3 << 8), mode 0100755 in the high half of the external attributes.
        le32(&mut out, 0x0201_4b50);
        for v in [(3u16 << 8) | 0x14, 20, 0, 0, 0, 0] {
            le16(&mut out, v);
        }
        for v in [crc, size, size] {
            le32(&mut out, v);
        }
        for v in [n, 0, 0, 0, 0] {
            le16(&mut out, v);
        }
        le32(&mut out, 0o100_755 << 16);
        le32(&mut out, 0);
        out.extend_from_slice(name.as_bytes());
        let dir_size = u32::try_from(out.len()).unwrap() - central;
        le32(&mut out, 0x0605_4b50);
        for v in [0u16, 0, 1, 1] {
            le16(&mut out, v);
        }
        le32(&mut out, dir_size);
        le32(&mut out, central);
        le16(&mut out, 0);
        out
    }

    fn run(i: &Installed) -> String {
        let out = std::process::Command::new(&i.program).args(&i.args).output().unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    }

    #[test]
    fn release_archives_install_only_when_their_sha256_matches() {
        let root = temp_dir("binary");
        let agents = root.join("agents");
        let tgz = tar_gz(&root, &[("bin/tool", "#!/bin/sh\necho tar-ok\n")]);
        let zip = zip_one("tool", b"#!/bin/sh\necho zip-ok\n");
        let raw = b"#!/bin/sh\necho raw-ok\n".to_vec();
        let (base, hits) = file_server(vec![("/tool.tar.gz".into(), tgz.clone()), ("/tool.zip".into(), zip.clone()), ("/tool".into(), raw.clone())]);
        let spec = Spec::parse("tool@1.0.0").unwrap();
        let tar_archive = Archive { url: format!("{base}/tool.tar.gz"), sha256: sha256_hex(&tgz).to_uppercase(), cmd: "./bin/tool".into() };

        // Two starts at once: one download.
        let installs: Vec<_> = (0..2)
            .map(|_| {
                let (agents, spec, a) = (agents.clone(), spec.clone(), tar_archive.clone());
                std::thread::spawn(move || ensure_archive(&agents, &spec, &a))
            })
            .collect();
        let results: Vec<Installed> = installs.into_iter().map(|t| t.join().unwrap().unwrap()).collect();
        assert_eq!(results[0], results[1]);
        assert_eq!(hits.lock().unwrap()["/tool.tar.gz"], 1, "downloaded once");
        let i = &results[0];
        let final_dir = dir(&agents, &spec).canonicalize().unwrap();
        assert_eq!(i.bin, final_dir.join("bin/tool"), "the registry's cmd, inside <id>@<version>");
        assert!(i.args.is_empty() && i.program == i.bin, "a program of its own, not node");
        assert_eq!(run(i), "tar-ok");
        assert!(is_binary(&final_dir) && !final_dir.join(".download").exists(), "the archive itself isn't kept");
        assert_eq!(installed(&agents, &spec).as_ref(), Some(i));
        assert_eq!(spec_of_folder(&spec.folder()), Some(spec.clone()), "cleanup knows the folder as one of ours");
        ensure_archive(&agents, &spec, &Archive { url: format!("{base}/gone.tar.gz"), ..tar_archive.clone() }).unwrap();
        assert!(!hits.lock().unwrap().contains_key("/gone.tar.gz"), "already there: no download");

        // A zip, and a bare program.
        let z = ensure_archive(
            &agents,
            &spec.at("2.0.0").unwrap(),
            &Archive { url: format!("{base}/tool.zip"), sha256: sha256_hex(&zip), cmd: "./tool".into() },
        )
        .unwrap();
        assert_eq!(run(&z), "zip-ok");
        let r = ensure_archive(
            &agents,
            &spec.at("3.0.0").unwrap(),
            &Archive { url: format!("{base}/tool"), sha256: sha256_hex(&raw), cmd: "tool".into() },
        )
        .unwrap();
        assert_eq!(run(&r), "raw-ok");

        // A digest that doesn't match, a missing program, a 404: nothing is installed, nothing is left behind.
        let bad = spec.at("4.0.0").unwrap();
        let err = ensure_archive(&agents, &bad, &Archive { sha256: "ab".repeat(32), ..tar_archive.clone() }).unwrap_err();
        assert!(err.contains("sha256") && err.contains(&sha256_hex(&tgz)), "{err}");
        let err = ensure_archive(&agents, &bad, &Archive { cmd: "./bin/other".into(), ..tar_archive.clone() }).unwrap_err();
        assert!(err.contains("missing"), "{err}");
        let err = ensure_archive(&agents, &bad, &Archive { url: format!("{base}/nope.tar.gz"), ..tar_archive.clone() }).unwrap_err();
        assert!(err.contains("404"), "{err}");
        let names: BTreeSet<String> = std::fs::read_dir(&agents).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, BTreeSet::from(["tool@1.0.0".to_owned(), "tool@2.0.0".into(), "tool@3.0.0".into()]));

        // A manifest for another version isn't an install of this one.
        std::fs::rename(dir(&agents, &spec.at("2.0.0").unwrap()), dir(&agents, &spec.at("2.0.1").unwrap())).unwrap();
        assert!(installed(&agents, &spec.at("2.0.1").unwrap()).is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn archive_entries_are_checked_before_anything_is_downloaded() {
        let ok = Archive { url: "https://example.com/a.tar.gz".into(), sha256: "a".repeat(64), cmd: "./bin/a".into() };
        assert!(ok.validate().is_ok());
        assert!(Archive { url: "http://127.0.0.1:8080/a.zip".into(), ..ok.clone() }.validate().is_ok(), "this machine, for tests");
        for bad in [
            Archive { url: "http://example.com/a.tar.gz".into(), ..ok.clone() },
            Archive { url: "file:///etc/passwd".into(), ..ok.clone() },
            Archive { sha256: "xyz".into(), ..ok.clone() },
            Archive { sha256: "g".repeat(64), ..ok.clone() },
            Archive { cmd: "../escape".into(), ..ok.clone() },
            Archive { cmd: "/usr/bin/env".into(), ..ok.clone() },
            Archive { cmd: String::new(), ..ok.clone() },
            Archive { cmd: "dir\\goose.exe".into(), ..ok.clone() },
        ] {
            assert!(bad.validate().is_err(), "{bad:?}");
        }
        let kind = |url: &str| Archive { url: url.into(), ..ok.clone() }.kind();
        assert_eq!(kind("https://x/goose-aarch64-apple-darwin.tar.bz2"), ArchiveKind::Tar);
        assert_eq!(kind("https://x/opencode-darwin-arm64.zip?download=1"), ArchiveKind::Zip);
        assert_eq!(kind("https://x/tool"), ArchiveKind::Raw);
        // Every pin is well formed and has this platform (yaah ships for macOS arm64 and Linux).
        for pin in BINARIES {
            assert!(Spec::new(pin.registry_id, pin.version).is_ok(), "{}", pin.registry_id);
            for t in pin.targets {
                Archive { url: t.url.into(), sha256: t.sha256.into(), cmd: t.cmd.into() }.validate().unwrap();
                assert!(t.url.contains(pin.version), "{} {}", pin.registry_id, t.url);
            }
            assert!(pin.archive().is_some(), "{} has no download for {:?}", pin.registry_id, platform());
        }
    }

    #[test]
    fn specs_are_exact_and_never_paths() {
        let s = Spec::parse("@agentclientprotocol/claude-agent-acp@0.99.1").unwrap();
        assert_eq!((s.name.as_str(), s.version.as_str()), ("@agentclientprotocol/claude-agent-acp", "0.99.1"));
        assert_eq!(s.folder(), "@agentclientprotocol+claude-agent-acp@0.99.1");
        assert_eq!(spec_of_folder(&s.folder()), Some(s.clone()));
        assert_eq!(Spec::parse("cline@3.0.74").unwrap().folder(), "cline@3.0.74");
        assert_eq!(s.at("1.0.0-beta.2").unwrap().to_string(), "@agentclientprotocol/claude-agent-acp@1.0.0-beta.2");
        for bad in [
            "cline",
            "cline@latest",
            "cline@^3.0.0",
            "cline@3",
            "@scope@1.0.0",
            "../x@1.0.0",
            "@a/../b@1.0.0",
            "a/b@1.0.0",
            ".x@1.0.0",
            "X@1.0.0",
            "@1.0.0",
        ] {
            assert!(Spec::parse(bad).is_err(), "{bad}");
        }
        for not_ours in ["versions.json", ".tmp-x", "cline@latest", "a+b+c@1.0.0", "cline"] {
            assert_eq!(spec_of_folder(not_ours), None, "{not_ours}");
        }
    }

    #[test]
    fn finds_the_program_npx_would_run() {
        let dir = temp_dir("bin");
        let js = &[("dist/index.js", "#!/usr/bin/env node\n"), ("other.js", "#!/usr/bin/env node\n")][..];
        // A string `bin`.
        let p = package(&dir.join("a"), &json!({ "name": "a", "bin": "./dist/index.js" }), js);
        assert!(bin_path(&p, &json!({ "name": "a", "bin": "./dist/index.js" })).unwrap().ends_with("a/dist/index.js"));
        // A map: the only entry, under any name.
        let m = json!({ "name": "@scope/tool", "bin": { "something-else": "dist/index.js" } });
        let p = package(&dir.join("b"), &m, js);
        assert!(bin_path(&p, &m).unwrap().ends_with("dist/index.js"));
        // Several: the one named like the package without its scope.
        let m = json!({ "name": "@scope/tool", "bin": { "helper": "other.js", "tool": "dist/index.js" } });
        assert!(bin_path(&p, &m).unwrap().ends_with("dist/index.js"));
        // Several names for one file.
        let m = json!({ "name": "@scope/tool", "bin": { "x": "other.js", "y": "./other.js" } });
        assert!(bin_path(&p, &m).unwrap().ends_with("other.js"));
        // None that fits, none at all, missing, or outside the package.
        for m in [
            json!({ "name": "@scope/tool", "bin": { "x": "other.js", "y": "dist/index.js" } }),
            json!({ "name": "tool" }),
            json!({ "name": "tool", "bin": {} }),
            json!({ "name": "tool", "bin": "missing.js" }),
            json!({ "name": "tool", "bin": "../a/dist/index.js" }),
            json!({ "bin": "dist/index.js" }),
        ] {
            assert!(bin_path(&p, &m).is_err(), "{m}");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn node_scripts_run_with_node_and_others_on_their_own() {
        let dir = temp_dir("launch");
        let node = Some(PathBuf::from("/opt/node/bin/node"));
        let write = |name: &str, body: &[u8], exec: bool| {
            use std::os::unix::fs::PermissionsExt;
            let p = dir.join(name);
            std::fs::write(&p, body).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(if exec { 0o755 } else { 0o644 })).unwrap();
            p
        };
        let env = write("env.js", b"#!/usr/bin/env node\n", true);
        let i = launcher(&env, node.clone()).unwrap();
        assert_eq!(i.command(), ("/opt/node/bin/node".into(), vec![env.to_string_lossy().into_owned()]));
        let flags = write("flags.js", b"#!/usr/bin/env -S node --no-warnings\n", false);
        assert_eq!(launcher(&flags, node.clone()).unwrap().args, ["--no-warnings".to_owned(), flags.to_string_lossy().into_owned()]);
        let plain = write("plain.js", b"console.log(1)\n", false);
        assert_eq!(launcher(&plain, node.clone()).unwrap().program, PathBuf::from("/opt/node/bin/node"), "no shebang: still a node script");
        assert!(launcher(&env, None).is_err(), "no node, no direct run");

        let sh = write("run.sh", b"#!/bin/sh\necho hi\n", true);
        assert_eq!(launcher(&sh, node.clone()).unwrap().command(), (sh.to_string_lossy().into_owned(), vec![]));
        let native = write("native", b"\x7fELF\x02\x01\x01\0\0\0", true);
        assert_eq!(launcher(&native, node.clone()).unwrap().program, native);
        let not_exec = write("noexec.sh", b"#!/bin/sh\n", false);
        assert!(launcher(&not_exec, node).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_install_counts_only_when_complete() {
        let root = temp_dir("installed");
        let spec = Spec::parse("@scope/tool@1.2.3").unwrap();
        assert!(installed(&root, &spec).is_none());
        fake_install(&root, &spec);
        if crate::path_env::which("node").is_some() {
            let i = installed(&root, &spec).unwrap();
            assert!(i.bin.ends_with("node_modules/@scope/tool/dist/index.js"));
            assert_eq!(i.args.last().map(String::as_str), Some(i.bin.to_str().unwrap()));
        }
        // Another version in the folder, or the program gone: not an install of this one.
        assert!(installed(&root, &spec.at("1.2.4").unwrap()).is_none());
        std::fs::remove_file(package_dir(&dir(&root, &spec), &spec).join("dist/index.js")).unwrap();
        assert!(installed(&root, &spec).is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    /// A real npm package as a tarball (`npm pack`), so `npm install` runs offline.
    /// Its postinstall notes where it ran and fails when `fail` is set.
    fn tarball(dir: &Path, name: &str, version: &str, fail: bool) -> PathBuf {
        let src = dir.join(format!("src-{name}-{version}"));
        let log = dir.join("postinstall.log");
        let script =
            format!("require('fs').appendFileSync({log:?}, process.cwd() + '\\n'); process.exit({})", i32::from(fail), log = log.to_string_lossy());
        let short = name.rsplit('/').next().unwrap();
        let manifest = json!({ "name": name, "version": version, "bin": { short: "bin/cli.js" }, "scripts": { "postinstall": format!("node -e \"{}\"", script.replace('"', "\\\"")) } });
        package(&src, &manifest, &[("bin/cli.js", "#!/usr/bin/env node\nconsole.log('ok')\n")]);
        let out = crate::path_env::command("npm").args(["pack", "--silent", "--pack-destination"]).arg(dir).current_dir(&src).output().unwrap();
        assert!(out.status.success(), "npm pack: {}", String::from_utf8_lossy(&out.stderr));
        dir.join(String::from_utf8_lossy(&out.stdout).trim())
    }

    fn have_npm() -> bool {
        let ok = crate::path_env::which("npm").is_some() && crate::path_env::which("node").is_some();
        if !ok {
            eprintln!("skipped: npm and node aren't on PATH");
        }
        ok
    }

    #[test]
    fn installs_into_a_temp_folder_then_moves_it_into_place_once() {
        if !have_npm() {
            return;
        }
        let root = temp_dir("install");
        let spec = Spec::parse("@yaah-test/tool@1.0.0").unwrap();
        let tgz = tarball(&root, &spec.name, "1.0.0", false);
        let source = tgz.to_string_lossy().into_owned();
        let agents = root.join("agents");

        // Two starts at once: one npm install.
        let installs: Vec<_> = (0..2)
            .map(|_| {
                let (agents, spec, source) = (agents.clone(), spec.clone(), source.clone());
                std::thread::spawn(move || ensure_from(&agents, &spec, &source))
            })
            .collect();
        let results: Vec<Installed> = installs.into_iter().map(|t| t.join().unwrap().unwrap()).collect();
        assert_eq!(results[0], results[1]);
        let ran_in = std::fs::read_to_string(root.join("postinstall.log")).unwrap();
        assert_eq!(ran_in.lines().count(), 1, "installed once: {ran_in}");
        let final_dir = dir(&agents, &spec).canonicalize().unwrap();
        assert!(!Path::new(ran_in.trim()).starts_with(&final_dir), "npm worked in a temp folder, not in place: {ran_in}");
        assert!(ran_in.contains(TMP_PREFIX));

        // In place, startable, and nothing left behind.
        assert!(results[0].bin.starts_with(&final_dir));
        let out = std::process::Command::new(&results[0].program).args(&results[0].args).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "ok");
        let names: Vec<String> = std::fs::read_dir(&agents).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, [spec.folder()]);
        assert!(!final_dir.join("npm-install.log").exists());

        // Already there: no npm at all.
        ensure_from(&agents, &spec, "/nonexistent.tgz").unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_failed_install_leaves_no_folder() {
        if !have_npm() {
            return;
        }
        let root = temp_dir("install-fail");
        let agents = root.join("agents");
        let spec = Spec::parse("yaah-test-broken@2.0.0").unwrap();
        let tgz = tarball(&root, &spec.name, "2.0.0", true);
        let err = ensure_from(&agents, &spec, &tgz.to_string_lossy()).unwrap_err();
        assert!(err.contains("failed"), "{err}");
        // A package that installs but isn't the version asked for doesn't count either.
        let other = tarball(&root, &spec.name, "2.0.1", false);
        let err = ensure_from(&agents, &spec, &other.to_string_lossy()).unwrap_err();
        assert!(err.contains("not 2.0.0"), "{err}");
        assert!(ensure_from(&agents, &spec, "/nonexistent/x.tgz").is_err());
        assert_eq!(std::fs::read_dir(&agents).unwrap().count(), 0, "no version folder, no temp folder");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleanup_keeps_what_runs_and_never_leaves_the_folder() {
        let base = temp_dir("cleanup");
        let root = base.join("agents");
        let (kept, old) = (Spec::parse("@scope/tool@2.0.0").unwrap(), Spec::parse("@scope/tool@1.0.0").unwrap());
        fake_install(&root, &kept);
        fake_install(&root, &old);
        // Things that aren't ours, or aren't folders, stay.
        let outside = base.join("outside@1.0.0");
        std::fs::create_dir_all(outside.join("keep-me")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("linked@1.0.0")).unwrap();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(root.join("versions.json"), "{}").unwrap();
        std::fs::write(root.join("file@1.0.0"), "").unwrap();
        // A fresh temp folder may be an install in progress; a day-old one isn't.
        std::fs::create_dir_all(root.join(".tmp-fresh")).unwrap();
        let stale = root.join(".tmp-stale");
        std::fs::create_dir_all(&stale).unwrap();
        let day_ago = SystemTime::now() - Duration::from_hours(24);
        std::fs::File::open(&stale).unwrap().set_modified(day_ago).unwrap();

        let removed = cleanup(&root, &BTreeSet::from([kept.folder()]));
        assert_eq!(removed.iter().collect::<HashSet<_>>(), HashSet::from([&old.folder(), &".tmp-stale".to_owned()]));
        assert!(dir(&root, &kept).exists() && !dir(&root, &old).exists());
        for stays in ["linked@1.0.0", "notes", "versions.json", "file@1.0.0", ".tmp-fresh"] {
            assert!(root.join(stays).symlink_metadata().is_ok(), "{stays}");
        }
        assert!(outside.join("keep-me").is_dir(), "a link is never followed");
        assert_eq!(cleanup(&base.join("missing"), &BTreeSet::new()), Vec::<String>::new());
        std::fs::remove_dir_all(base).unwrap();
    }

    /// RSS (KB) and count of this process's descendants, from `ps`.
    fn descendants() -> (u64, usize) {
        let ps = std::process::Command::new("ps").args(["-A", "-o", "pid=,ppid=,rss="]).stdout(Stdio::piped()).spawn().unwrap();
        let ps_pid = u64::from(ps.id());
        let out = ps.wait_with_output().unwrap();
        let rows: Vec<[u64; 3]> = String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| {
                let n: Vec<u64> = l.split_whitespace().filter_map(|w| w.parse().ok()).collect();
                <[u64; 3]>::try_from(n).ok()
            })
            // Not `ps` itself.
            .filter(|[pid, ..]| *pid != ps_pid)
            .collect();
        let mut tree = HashSet::from([u64::from(std::process::id())]);
        // Parents before children isn't guaranteed: repeat until nothing new joins.
        while let added @ 1.. = rows.iter().filter(|[pid, ppid, _]| tree.contains(ppid) && tree.insert(*pid)).count() {
            let _ = added;
        }
        let kids: Vec<&[u64; 3]> = rows.iter().filter(|[pid, ..]| *pid != u64::from(std::process::id()) && tree.contains(pid)).collect();
        (kids.iter().map(|[.., rss]| rss).sum(), kids.len())
    }

    /// The before/after numbers in docs/experiments/2026-11-03-performance/backend/agent-install.md:
    /// spawn to `initialize` answer, and RSS of the agent's process tree, for the Claude adapter
    /// through `npx -y` and from yaah's install (`node <bin>`, what `Profile::process` now starts).
    #[test]
    #[ignore = "network: installs the real Claude adapter into ~/.yaah/agents and starts it"]
    fn measure_npx_vs_installed() {
        use crate::agents;
        let spec = Spec::parse(crate::session::ADAPTER_PACKAGE).unwrap();
        let started = Instant::now();
        let ours = ensure(&root(), &spec).unwrap();
        println!("install (or found): {:?}", started.elapsed());
        let config = temp_dir("claude-config");
        let profile =
            agents::Draft { label: "Claude".into(), preset: agents::CLAUDE.into(), command_line: format!("npx -y {spec}"), ..Default::default() }
                .to_profile(&[])
                .unwrap();
        assert_eq!(profile.launch().0, ours.program.to_string_lossy(), "the saved npx command starts yaah's install");
        let cmd = |npx: bool| {
            let mut c = if npx {
                let mut c = crate::path_env::tokio_command("npx");
                c.args(["-y", &spec.to_string()]);
                c
            } else {
                profile.process()
            };
            c.env("CLAUDE_CONFIG_DIR", &config);
            c
        };
        tauri::async_runtime::block_on(async {
            let run = |npx: bool| {
                let c = cmd(npx);
                async move {
                    let t = Instant::now();
                    let conn = crate::acp::Connection::spawn(c, |_, _| {}, |_| {}).unwrap();
                    agents::initialize(&conn).await.unwrap();
                    let ms = t.elapsed().as_secs_f64() * 1000.0;
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    let (rss, procs) = descendants();
                    drop(conn);
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    let left = descendants().1;
                    (ms, rss, procs, left)
                }
            };
            // Warm npx's cache and the OS file cache first.
            run(true).await;
            run(false).await;
            let mut all: HashMap<bool, Vec<(f64, u64, usize, usize)>> = HashMap::new();
            for _ in 0..7 {
                for npx in [true, false] {
                    let r = run(npx).await;
                    println!(
                        "{} init_ms={:.0} tree_rss_mb={} procs={} left_after_kill={}",
                        if npx { "npx " } else { "node" },
                        r.0,
                        r.1 / 1024,
                        r.2,
                        r.3
                    );
                    all.entry(npx).or_default().push(r);
                }
            }
            for npx in [true, false] {
                let mut ms: Vec<f64> = all[&npx].iter().map(|r| r.0).collect();
                ms.sort_by(f64::total_cmp);
                let mut rss: Vec<u64> = all[&npx].iter().map(|r| r.1).collect();
                rss.sort_unstable();
                println!(
                    "{}: init ms min {:.0} median {:.0} max {:.0}; tree RSS MB median {}",
                    if npx { "npx -y" } else { "node <bin>" },
                    ms[0],
                    ms[ms.len() / 2],
                    ms[ms.len() - 1],
                    rss[rss.len() / 2] / 1024
                );
            }
        });
        std::fs::remove_dir_all(config).unwrap();
    }
}
