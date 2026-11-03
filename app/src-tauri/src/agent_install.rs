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

/// What makes an install usable: the package at the right version, and a program to start.
fn check(version_dir: &Path, spec: &Spec) -> Result<Installed, String> {
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

/// Install `spec` on a background thread, unless that's already happening. A
/// failure is only logged: the agent keeps starting through npx.
pub fn ensure_in_background(spec: Spec) {
    static RUNNING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    let running = RUNNING.get_or_init(Mutex::default);
    if !running.lock().unwrap_or_else(PoisonError::into_inner).insert(spec.folder()) {
        return;
    }
    std::thread::spawn(move || {
        let root = root();
        match ensure(&root, &spec) {
            Ok(_) => eprintln!("[agents] installed {spec} in {}", root.display()),
            Err(e) => eprintln!("[agents] couldn't install {spec}; it keeps starting through npx: {e}"),
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
