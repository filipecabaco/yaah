//! Installable component libraries: sets of components people and companies
//! publish as a git repo (or keep in a folder), installed beside yaah's own and
//! the user's (see `ui_library.rs`).
//!
//! A library is data like every component: installing one can only add UI
//! drawn with yaah's primitives, and its `live` nodes must name the source kind
//! they read, so what it reads is shown before it is installed (`reads`).
//!
//! ```text
//! yaah-library.json        manifest (≤ 64 KB)
//! components/<name>.json   one component per file (≤ 256 KB, ≤ 500 files)
//! README.md                optional
//! ```
//! Records are kept in `~/.config/yaah/libraries.json`, git checkouts in
//! `~/.yaah/libraries/<id>/`. A folder library is read in place and reloaded
//! when its files change, so its author sees edits without reinstalling.
//!
//! Fetching runs `git` itself (never a shell) with only https and ssh allowed,
//! no hooks, no submodules, symlinks checked out as plain files, no prompts and
//! a time limit. A GitHub token from Settings → Integrations reaches git
//! through its environment, never its command line.

use crate::integrations::{self, Auth};
use crate::json_file::{self, JsonFile};
use crate::ui_library::{self as ui, Bundled, Component, ComponentSource, Library, Resolve, Resolved, SaveRequest, qualified};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::Read;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::rc::Rc;
use std::sync::{Arc, PoisonError};
use std::time::{Duration, Instant};

pub const MANIFEST: &str = "yaah-library.json";
const MAX_MANIFEST: u64 = 64 * 1024;
const MAX_FILE: u64 = 256 * 1024;
const MAX_COMPONENTS: usize = 500;
const GIT_TIMEOUT: Duration = Duration::from_secs(120);
/// Ids taken by yaah's own components and the user's.
const RESERVED: &[&str] = &["yaah", "local"];
/// A preview not installed within this long is dropped with its checkout.
const STAGING_TTL: Duration = Duration::from_hours(1);
/// Inside a checkout's `.git` (which a repo can't ship files into): the symlinks dropped after cloning.
const SKIPPED_FILE: &str = "yaah-skipped.json";
/// Errors reported for one component; the rest are counted.
const ERRORS_SHOWN: usize = 5;

/// Where a library comes from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum LibrarySource {
    Git {
        url: String,
        /// A tag or branch; none follows the repo's default branch.
        #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
        git_ref: Option<String>,
    },
    Folder {
        path: String,
    },
}

/// One installed library in `libraries.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: String,
    pub source: LibrarySource,
    /// The checked-out commit (git only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    pub enabled: bool,
    pub installed_at: u64,
    pub updated_at: u64,
}

/// `yaah-library.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryComponent {
    /// Qualified for an installed library (`acme/pr-card`).
    pub name: String,
    pub description: String,
    pub valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryInfo {
    pub id: String,
    /// `builtin`, `local`, `git` or `folder`.
    pub kind: &'static str,
    pub title: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<LibrarySource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    pub enabled: bool,
    pub components: Vec<LibraryComponent>,
    /// Source kinds its components' `live` nodes read (`github`, `postgres`…).
    pub reads: Vec<String>,
    /// Other libraries its components use.
    pub needs: Vec<String>,
    /// Library-level problems: a missing manifest field, a skipped symlink…
    pub errors: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryPreview {
    #[serde(flatten)]
    pub info: LibraryInfo,
    pub staging_id: String,
    /// The installed library installing this one replaces (same id).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replaces: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryUpdate {
    pub library: LibraryInfo,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    /// Qualified names of the components added, removed or changed.
    pub changed: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryExport {
    pub path: String,
    /// Local components the picked ones use but weren't picked; nothing was written.
    pub missing: Vec<String>,
}

/// A library read from disk and checked.
#[derive(Debug, Clone, Default)]
pub struct Loaded {
    pub manifest: Manifest,
    /// The valid components by short name, each named `<id>/<name>`.
    pub components: BTreeMap<String, Component>,
    /// Every component file, valid or not.
    pub entries: Vec<LibraryComponent>,
    pub reads: Vec<String>,
    pub needs: Vec<String>,
    pub errors: Vec<String>,
    /// A hash of each component file by short name: what an update compares.
    digests: BTreeMap<String, u64>,
}

impl Loaded {
    /// An installed library that can't be read at all: shown with why, and nothing loads.
    fn broken(id: &str, why: String) -> Self {
        Self { manifest: Manifest { name: id.into(), title: id.into(), ..Manifest::default() }, errors: vec![why], ..Self::default() }
    }
}

/// An installed library, loaded.
#[derive(Debug)]
pub struct Pack {
    pub record: Record,
    pub root: PathBuf,
    pub loaded: Loaded,
    /// Folder libraries: the state of their files when loaded (see [`fingerprint`]).
    fingerprint: u64,
}

impl Pack {
    pub fn id(&self) -> &str {
        &self.record.id
    }

    fn is_folder(&self) -> bool {
        matches!(self.record.source, LibrarySource::Folder { .. })
    }

    fn load(store: &Store, record: Record) -> Self {
        let root = match &record.source {
            LibrarySource::Git { .. } => store.checkout(&record.id),
            LibrarySource::Folder { path } => PathBuf::from(path),
        };
        let fingerprint = if matches!(record.source, LibrarySource::Folder { .. }) { fingerprint(&root) } else { 0 };
        let loaded = load_dir(&root, Some(&record.id)).unwrap_or_else(|e| Loaded::broken(&record.id, e));
        Self { record, root, loaded, fingerprint }
    }

    pub fn info(&self) -> LibraryInfo {
        let kind = if self.is_folder() { "folder" } else { "git" };
        let mut info = info_of(&self.loaded, kind, Some(self.record.source.clone()), self.record.commit.clone());
        info.enabled = self.record.enabled;
        info.installed_at = Some(self.record.installed_at);
        info.updated_at = Some(self.record.updated_at);
        info
    }
}

/// A library `inspect` fetched and checked, waiting for `install`.
#[derive(Debug)]
pub struct Staged {
    source: LibrarySource,
    /// The checkout (git); a folder is read in place.
    dir: Option<PathBuf>,
    id: String,
    commit: Option<String>,
    at: Instant,
}

/// Where installed libraries are recorded and checked out.
pub struct Store {
    records: JsonFile,
    dir: PathBuf,
    /// Tests clone local repos over `file://`; the app never does.
    #[cfg(test)]
    allow_file_urls: bool,
}

impl Store {
    pub fn user() -> Self {
        let home = crate::accounts::home();
        Self::at(home.join(".config/yaah/libraries.json"), home.join(".yaah/libraries"))
    }

    pub fn at(records: PathBuf, dir: PathBuf) -> Self {
        Self {
            records: JsonFile::new(records, false),
            dir,
            #[cfg(test)]
            allow_file_urls: false,
        }
    }

    #[allow(clippy::unused_self, reason = "only tests turn file:// on")]
    fn file_urls_allowed(&self) -> bool {
        #[cfg(test)]
        return self.allow_file_urls;
        #[cfg(not(test))]
        false
    }

    fn staging(&self) -> PathBuf {
        self.dir.join(".staging")
    }

    fn checkout(&self, id: &str) -> PathBuf {
        self.dir.join(id)
    }

    /// The records, minus any a hand edit left unusable.
    fn records(&self) -> Vec<Record> {
        self.records.read::<Vec<Record>>().into_iter().filter(|r| valid_library_name(&r.id) && !RESERVED.contains(&r.id.as_str())).collect()
    }

    /// `git` with the settings every library fetch runs under.
    fn git(&self) -> tokio::process::Command {
        let mut c = crate::path_env::tokio_command("git");
        c.env("GIT_TERMINAL_PROMPT", "0").env_remove("GIT_ASKPASS");
        for setting in
            ["protocol.allow=never", "protocol.https.allow=always", "protocol.ssh.allow=always", "core.symlinks=false", "core.hooksPath=/dev/null"]
        {
            c.args(["-c", setting]);
        }
        if self.file_urls_allowed() {
            c.args(["-c", "protocol.file.allow=always"]);
        }
        c.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        c
    }

    /// Shallow-clone `url` at `git_ref` into `dest`; returns the commit.
    async fn fetch(&self, url: &str, git_ref: Option<&str>, dest: &Path) -> Result<String, String> {
        check_url(url, self.file_urls_allowed())?;
        if let Some(r) = git_ref {
            check_ref(r)?;
        }
        let mut c = self.git();
        if let Some(header) = github_header(url).await {
            c.env("GIT_CONFIG_COUNT", "1").env("GIT_CONFIG_KEY_0", "http.https://github.com/.extraheader").env("GIT_CONFIG_VALUE_0", header);
        }
        c.args(["clone", "--quiet", "--depth", "1", "--no-recurse-submodules", "--single-branch"]);
        if let Some(r) = git_ref {
            c.args(["--branch", r]);
        }
        c.arg("--").arg(url).arg(dest);
        run(c, "git clone").await?;
        let mut c = self.git();
        c.arg("-C").arg(dest).args(["rev-parse", "HEAD"]);
        let commit = run(c, "git rev-parse").await?.trim().to_owned();
        let mut c = self.git();
        c.arg("-C").arg(dest).args(["ls-files", "-s", "-z"]);
        drop_symlinks(dest, &run(c, "git ls-files").await?)?;
        Ok(commit)
    }
}

async fn run(mut cmd: tokio::process::Command, what: &str) -> Result<String, String> {
    let out = tokio::time::timeout(GIT_TIMEOUT, cmd.output())
        .await
        .map_err(|_| format!("{what} took longer than {}s and was stopped", GIT_TIMEOUT.as_secs()))?
        .map_err(|e| format!("couldn't run git ({e}); is git installed?"))?;
    if !out.status.success() {
        return Err(git_error(&String::from_utf8_lossy(&out.stderr), what));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn git_error(stderr: &str, what: &str) -> String {
    let last = stderr.lines().map(str::trim).rfind(|l| !l.is_empty() && !l.starts_with("hint:")).unwrap_or("failed");
    let mut msg = format!("{what} failed: {}", last.trim_start_matches("fatal: ").trim_start_matches("error: "));
    let denied =
        ["Authentication failed", "could not read Username", "Permission denied", "Repository not found", "terminal prompts disabled", "403"];
    if denied.iter().any(|s| stderr.contains(s)) {
        msg.push_str(
            ". If the repo is private, connect GitHub in Settings → Integrations (for github.com), \
             or set up git credentials for its host (an SSH key or a credential helper)",
        );
    }
    msg
}

/// `Authorization` for github.com over https, from the GitHub connection (or `GITHUB_TOKEN`).
async fn github_header(url: &str) -> Option<String> {
    if !url.starts_with("https://github.com/") {
        return None;
    }
    let (Auth::Bearer(token) | Auth::Key(token)) = integrations::auth("github").await.ok()?;
    let basic = base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"));
    Some(format!("Authorization: Basic {basic}"))
}

/// With `core.symlinks=false` a committed symlink is checked out as a plain file
/// holding its target. Remove those and remember them for the library's errors.
fn drop_symlinks(dest: &Path, ls_files: &str) -> Result<(), String> {
    let mut skipped = vec![];
    for entry in ls_files.split('\0').filter(|e| !e.is_empty()) {
        let Some((meta, path)) = entry.split_once('\t') else { continue };
        if !meta.starts_with("120000 ") {
            continue;
        }
        let file = dest.join(path);
        // ls-files names paths inside the checkout, never `..`.
        if Path::new(path).components().all(|c| matches!(c, std::path::Component::Normal(_))) && file.symlink_metadata().is_ok() {
            std::fs::remove_file(&file).map_err(|e| format!("{path}: {e}"))?;
        }
        if path == MANIFEST || path.starts_with("components/") {
            skipped.push(format!("{path} is a symlink; skipped (libraries can't use symlinks)"));
        }
    }
    json_file::write(&dest.join(".git").join(SKIPPED_FILE), &skipped, false)
}

fn skipped_by_git(root: &Path) -> Vec<String> {
    read_regular(&root.join(".git").join(SKIPPED_FILE), MAX_MANIFEST)
        .ok()
        .and_then(|raw| serde_json::from_slice::<Vec<String>>(&raw).ok())
        .unwrap_or_default()
}

// ── checks ──────────────────────────────────────────────────────────────────

/// A library id: a component name of at most 32 characters.
pub fn valid_library_name(name: &str) -> bool {
    name.len() <= 32 && ui::valid_name(name)
}

/// A git URL yaah fetches: `https://…`, `ssh://…` or `user@host:path`, nothing
/// git could read as an option or a transport helper.
pub fn check_url(url: &str, allow_file: bool) -> Result<(), String> {
    let refuse = || Err(format!("`{url}` isn't a git URL yaah can fetch: use https://…, ssh://… or user@host:path"));
    if url.is_empty() || url.len() > 2048 || url.starts_with('-') || url.contains("::") || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return refuse();
    }
    let host_ok = |h: &str| !h.is_empty() && !h.starts_with('-') && h.chars().all(|c| c.is_ascii_alphanumeric() || "-._[]:".contains(c));
    let user_ok = |u: &str| !u.is_empty() && !u.starts_with('-') && u.chars().all(|c| c.is_ascii_alphanumeric() || "-._~%".contains(c));
    if let Some(rest) = url.strip_prefix("https://") {
        let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
        let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
        return if host_ok(host) { Ok(()) } else { refuse() };
    }
    if let Some(rest) = url.strip_prefix("ssh://") {
        let authority = rest.split('/').next().unwrap_or_default();
        let ok = match authority.rsplit_once('@') {
            Some((user, host)) => user_ok(user) && host_ok(host),
            None => host_ok(authority),
        };
        return if ok && rest.len() > authority.len() + 1 { Ok(()) } else { refuse() };
    }
    if url.starts_with("file://") {
        return if allow_file && url.starts_with("file:///") {
            Ok(())
        } else {
            Err("local file:// URLs aren't fetched; add the folder as a library instead".into())
        };
    }
    if url.contains("://") {
        return refuse();
    }
    // scp-like: user@host:path
    match url.split_once(':') {
        Some((user_host, path)) if !path.is_empty() && !path.starts_with('-') => match user_host.split_once('@') {
            Some((user, host)) if user_ok(user) && host_ok(host) && !host.contains(':') => Ok(()),
            _ => refuse(),
        },
        _ => refuse(),
    }
}

/// A tag or branch name, never something git could read as an option.
pub fn check_ref(r: &str) -> Result<(), String> {
    let ok = !r.is_empty() && r.len() <= 200 && !r.starts_with('-') && r.chars().all(|c| c.is_ascii_alphanumeric() || "._/-".contains(c));
    if ok { Ok(()) } else { Err(format!("`{r}` isn't a tag or branch name (letters, digits, `.`, `_`, `/`, `-`, not starting with `-`)")) }
}

/// Parse and check a manifest. Problems that leave the library usable go to `errors`.
fn parse_manifest(raw: &[u8], errors: &mut Vec<String>) -> Result<Manifest, String> {
    let v: Value = serde_json::from_slice(raw).map_err(|e| format!("{MANIFEST} isn't valid JSON: {e}"))?;
    let obj = v.as_object().ok_or_else(|| format!("{MANIFEST} must be a JSON object"))?;
    let text = |key: &str, max: usize, errors: &mut Vec<String>| -> Option<String> {
        match obj.get(key) {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) if s.trim().is_empty() => None,
            Some(Value::String(s)) if s.trim().chars().count() > max => {
                errors.push(format!("{MANIFEST}: `{key}` is longer than {max} characters, so it's cut short"));
                Some(s.trim().chars().take(max).collect())
            }
            Some(Value::String(s)) => Some(s.trim().to_owned()),
            Some(_) => {
                errors.push(format!("{MANIFEST}: `{key}` must be a string"));
                None
            }
        }
    };
    let name = text("name", 64, errors).ok_or_else(|| format!("{MANIFEST} has no `name` (the library's id, like \"acme\")"))?;
    if !valid_library_name(&name) {
        return Err(format!("{MANIFEST}: the name `{name}` must be kebab-case: lowercase letters, digits and -, starting with a letter, 2-32 chars"));
    }
    if RESERVED.contains(&name.as_str()) {
        return Err(format!("{MANIFEST}: the name `{name}` is reserved for yaah; pick another"));
    }
    let title = text("title", 80, errors).unwrap_or_else(|| {
        errors.push(format!("{MANIFEST} has no `title`"));
        name.clone()
    });
    let description = text("description", 500, errors).unwrap_or_else(|| {
        errors.push(format!("{MANIFEST} has no `description`"));
        String::new()
    });
    let homepage = text("homepage", 300, errors).filter(|h| {
        let ok = h.starts_with("https://") || h.starts_with("http://");
        if !ok {
            errors.push(format!("{MANIFEST}: `homepage` must be an http(s) URL; ignored"));
        }
        ok
    });
    Ok(Manifest { publisher: text("publisher", 80, errors), version: text("version", 32, errors), name, title, description, homepage })
}

enum ReadError {
    Missing,
    Symlink,
    NotFile,
    TooBig,
    Io(String),
}

impl ReadError {
    fn say(&self, max: u64) -> String {
        match self {
            Self::Missing => "missing".into(),
            Self::Symlink => "a symlink; skipped (libraries can't use symlinks)".into(),
            Self::NotFile => "not a regular file".into(),
            Self::TooBig => format!("over {} KB", max / 1024),
            Self::Io(e) => e.clone(),
        }
    }
}

/// A regular file's bytes, never following a symlink (one swapped in after the check is caught too).
fn read_regular(path: &Path, max: u64) -> Result<Vec<u8>, ReadError> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(ReadError::Missing),
        Err(e) => return Err(ReadError::Io(e.to_string())),
    };
    if meta.file_type().is_symlink() {
        return Err(ReadError::Symlink);
    }
    if !meta.is_file() {
        return Err(ReadError::NotFile);
    }
    if meta.len() > max {
        return Err(ReadError::TooBig);
    }
    let file = std::fs::File::open(path).map_err(|e| ReadError::Io(e.to_string()))?;
    let opened = file.metadata().map_err(|e| ReadError::Io(e.to_string()))?;
    if opened.ino() != meta.ino() || opened.dev() != meta.dev() {
        return Err(ReadError::Symlink);
    }
    let mut buf = vec![];
    file.take(max + 1).read_to_end(&mut buf).map_err(|e| ReadError::Io(e.to_string()))?;
    if buf.len() as u64 > max {
        return Err(ReadError::TooBig);
    }
    Ok(buf)
}

/// The component files of a library, by name; problems with the folder go to `errors`.
fn component_files(root: &Path, errors: &mut Vec<String>) -> Vec<(String, PathBuf)> {
    let dir = root.join("components");
    match std::fs::symlink_metadata(&dir) {
        Ok(m) if m.file_type().is_symlink() => {
            errors.push("components is a symlink; skipped (libraries can't use symlinks)".into());
            return vec![];
        }
        Ok(m) if m.is_dir() => {}
        Ok(_) => {
            errors.push("components isn't a folder".into());
            return vec![];
        }
        Err(_) => {
            errors.push("no components folder: put each component in components/<name>.json".into());
            return vec![];
        }
    }
    let Ok(read) = std::fs::read_dir(&dir) else {
        errors.push("couldn't read the components folder".into());
        return vec![];
    };
    let mut names: Vec<_> = read.filter_map(Result::ok).map(|e| e.file_name()).collect();
    names.sort();
    let mut out = vec![];
    for raw in names {
        let Some(name) = raw.to_str() else {
            errors.push(format!("components/{}: file names must be UTF-8; skipped", raw.to_string_lossy()));
            continue;
        };
        let path = dir.join(name);
        let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
        if meta.file_type().is_symlink() {
            errors.push(format!("components/{name} is a symlink; skipped (libraries can't use symlinks)"));
            continue;
        }
        let Some(stem) = name.strip_suffix(".json") else { continue };
        if name.starts_with('.') || !meta.is_file() {
            continue;
        }
        if out.len() == MAX_COMPONENTS {
            errors.push(format!("more than {MAX_COMPONENTS} components; only the first {MAX_COMPONENTS} by file name are loaded"));
            break;
        }
        out.push((stem.to_owned(), path));
    }
    out
}

/// Resolves names while one library is checked on its own: its own components
/// by qualified name, yaah's own unqualified, other libraries' left for later.
struct Scope<'a> {
    id: &'a str,
    siblings: &'a BTreeMap<String, Component>,
    bundled: Bundled,
}

impl Resolve for Scope<'_> {
    fn resolve(&self, name: &str, _: bool) -> Resolved {
        match qualified(name) {
            Some((lib, short)) if !valid_library_name(lib) || !ui::valid_name(short) => {
                Resolved::Missing(format!("`{name}` isn't a component name; components from a library are named `library/name`"))
            }
            Some((lib, short)) if lib == self.id => match self.siblings.get(short) {
                Some(c) => Resolved::Found(Rc::new(c.clone())),
                None => Resolved::Missing(format!("unknown type `{name}`: this library has no component `{short}`")),
            },
            Some(_) => Resolved::Unchecked,
            None => match self.bundled.get(name) {
                Ok(Some(c)) => Resolved::Found(Rc::new(c)),
                _ => Resolved::Missing(format!(
                    "unknown type `{name}`: inside a library, unqualified names are yaah's own components only. \
                     Refer to this library's components as `{}/{name}`; the user's own components can't be used, they differ from user to user",
                    self.id
                )),
            },
        }
    }
}

/// The component types a tree names (not primitives).
fn types_in(tree: &Value) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    ui::walk_nodes(tree, &mut |obj| {
        if let Some(t) = obj.get("type").and_then(Value::as_str)
            && !ui::is_primitive(t)
        {
            out.insert(t.to_owned());
        }
    });
    out
}

/// The literal source kind of a `live` node, if it has one.
fn live_kind(obj: &serde_json::Map<String, Value>) -> Option<&str> {
    obj.get("props")?.get("source")?.get("kind")?.as_str().filter(|k| !k.is_empty() && !k.contains("{{"))
}

/// The source kinds (`github`, `postgres`…) a tree reads, following the
/// components `follow` gives (each once, through `seen`).
fn reads_of(tree: &Value, follow: &dyn Fn(&str) -> Option<Component>, seen: &mut BTreeSet<String>, out: &mut BTreeSet<String>) {
    let mut nested = vec![];
    ui::walk_nodes(tree, &mut |obj| match obj.get("type").and_then(Value::as_str) {
        Some("live") => {
            if let Some(kind) = live_kind(obj) {
                out.insert(kind.split('.').next().unwrap_or(kind).to_owned());
            }
        }
        // The SQL editor runs queries on a saved connection.
        Some("sql") => {
            out.insert("postgres".into());
        }
        Some(t) if !ui::is_primitive(t) => nested.push(t.to_owned()),
        _ => {}
    });
    for t in nested {
        if seen.insert(t.clone())
            && let Some(c) = follow(&t)
        {
            reads_of(&c.tree, follow, seen, out);
        }
    }
}

fn digest(bytes: &[u8]) -> u64 {
    let mut h = DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}

fn summarize(errs: &[String]) -> String {
    let mut s = errs.iter().take(ERRORS_SHOWN).cloned().collect::<Vec<_>>().join("; ");
    if errs.len() > ERRORS_SHOWN {
        let _ = write!(s, " (and {} more)", errs.len() - ERRORS_SHOWN);
    }
    s
}

/// Parse one component file: its name must be the file's.
fn parse_component(id: &str, title: &str, stem: &str, bytes: &[u8]) -> Result<Component, String> {
    if !ui::valid_name(stem) {
        return Err("the file name must be the component's name: kebab-case, lowercase letters, digits and -, starting with a letter".into());
    }
    if ui::is_primitive(stem) {
        return Err(format!("`{stem}` is a primitive's name; pick another"));
    }
    let mut c: Component = serde_json::from_slice(bytes).map_err(|e| format!("not a component: {e}"))?;
    if c.name != stem {
        return Err(format!("its `name` is `{}` but the file is {stem}.json; they must match", c.name));
    }
    c.name = format!("{id}/{stem}");
    id.clone_into(&mut c.source);
    c.library = Some(title.to_owned());
    Ok(c)
}

/// Check each parsed component like an agent's save, as a component of library
/// `id`; problems go to `bad`. A component using one that didn't load can't load either.
fn check_all(id: &str, parsed: &BTreeMap<String, Component>, bad: &mut BTreeMap<String, String>) {
    // Each checked like an agent's save, as a component of this library.
    let scope = Scope { id, siblings: parsed, bundled: Bundled::new() };
    for (stem, c) in parsed {
        let mut errs = vec![];
        ui::check_contents(&c.name, &c.description, &c.props, &c.tree, &c.examples, &scope, true, &mut errs);
        let mut bound_live = false;
        ui::walk_nodes(&c.tree, &mut |obj| bound_live |= obj.get("type").and_then(Value::as_str) == Some("live") && live_kind(obj).is_none());
        if bound_live {
            errs.push(
                "a `live` node in a library must name its source kind (like { kind: \"github.pr\", … }), not take it from props, \
                 so what the library reads is known before it's installed"
                    .into(),
            );
        }
        if !errs.is_empty() {
            bad.insert(stem.clone(), summarize(&errs));
        }
    }
    // A component using one that didn't load can't load either.
    let refs: BTreeMap<&String, BTreeSet<String>> = parsed.iter().map(|(s, c)| (s, types_in(&c.tree))).collect();
    let own = format!("{id}/");
    loop {
        let newly: Vec<(String, String)> = refs
            .iter()
            .filter(|(s, _)| !bad.contains_key(s.as_str()))
            .filter_map(|(s, types)| {
                let broken = types.iter().filter_map(|t| t.strip_prefix(&own)).find(|r| bad.contains_key(*r))?;
                Some(((*s).clone(), format!("uses `{own}{broken}`, which didn't load")))
            })
            .collect();
        if newly.is_empty() {
            break;
        }
        bad.extend(newly);
    }
}

/// Read and check the library at `root`. `Err` when it can't be used at all
/// (no manifest, a bad name, or not the `expect`ed library); a component with
/// problems is reported in `entries` and left out.
pub fn load_dir(root: &Path, expect: Option<&str>) -> Result<Loaded, String> {
    match std::fs::symlink_metadata(root) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => return Err(format!("{} isn't a folder", root.display())),
        Err(e) => return Err(format!("{}: {e}", root.display())),
    }
    let raw = read_regular(&root.join(MANIFEST), MAX_MANIFEST).map_err(|e| match e {
        ReadError::Missing => format!("no {MANIFEST} at the top: this isn't a yaah component library"),
        other => format!("{MANIFEST} is {}", other.say(MAX_MANIFEST)),
    })?;
    let mut errors = vec![];
    let manifest = parse_manifest(&raw, &mut errors)?;
    if let Some(id) = expect
        && manifest.name != id
    {
        return Err(format!("{MANIFEST} now names the library `{}`, not `{id}`; remove `{id}` and install it again", manifest.name));
    }
    let id = manifest.name.clone();
    errors.extend(skipped_by_git(root));

    let mut parsed: BTreeMap<String, Component> = BTreeMap::new();
    let mut bad: BTreeMap<String, String> = BTreeMap::new();
    let mut descriptions: BTreeMap<String, String> = BTreeMap::new();
    let mut digests = BTreeMap::new();
    for (stem, path) in component_files(root, &mut errors) {
        match read_regular(&path, MAX_FILE) {
            Err(e) => {
                bad.insert(stem, format!("the file is {}", e.say(MAX_FILE)));
            }
            Ok(bytes) => {
                digests.insert(stem.clone(), digest(&bytes));
                if let Some(d) = serde_json::from_slice::<Value>(&bytes).ok().and_then(|v| v["description"].as_str().map(str::to_owned)) {
                    descriptions.insert(stem.clone(), d);
                }
                match parse_component(&id, &manifest.title, &stem, &bytes) {
                    Ok(c) => {
                        parsed.insert(stem, c);
                    }
                    Err(e) => {
                        bad.insert(stem, e);
                    }
                }
            }
        }
    }

    check_all(&id, &parsed, &mut bad);
    let own = format!("{id}/");
    let components: BTreeMap<String, Component> = parsed.iter().filter(|(s, _)| !bad.contains_key(*s)).map(|(s, c)| (s.clone(), c.clone())).collect();
    let mut reads = BTreeSet::new();
    let mut needs = BTreeSet::new();
    let bundled = Bundled::new();
    let follow = |t: &str| match t.strip_prefix(&own) {
        Some(short) => components.get(short).cloned(),
        None if qualified(t).is_none() => bundled.get(t).ok().flatten(),
        None => None,
    };
    let mut seen = BTreeSet::new();
    for c in components.values() {
        reads_of(&c.tree, &follow, &mut seen, &mut reads);
        needs.extend(types_in(&c.tree).iter().filter_map(|t| qualified(t)).filter(|(lib, _)| *lib != id).map(|(lib, _)| lib.to_owned()));
    }
    let names: BTreeSet<&String> = parsed.keys().chain(bad.keys()).collect();
    let entries = names
        .into_iter()
        .map(|stem| LibraryComponent {
            name: format!("{own}{stem}"),
            description: parsed.get(stem).map(|c| c.description.clone()).or_else(|| descriptions.get(stem).cloned()).unwrap_or_default(),
            valid: !bad.contains_key(stem),
            error: bad.get(stem).cloned(),
        })
        .collect();
    Ok(Loaded { manifest, components, entries, reads: reads.into_iter().collect(), needs: needs.into_iter().collect(), errors, digests })
}

async fn load_blocking(root: PathBuf, expect: Option<String>) -> Result<Loaded, String> {
    tokio::task::spawn_blocking(move || load_dir(&root, expect.as_deref())).await.map_err(|e| e.to_string())?
}

/// What a folder library's files look like now: names, sizes and times.
fn fingerprint(root: &Path) -> u64 {
    fn stamp(p: &Path, h: &mut DefaultHasher) {
        match std::fs::symlink_metadata(p) {
            Ok(m) => (m.len(), m.modified().ok(), m.ino(), m.file_type().is_symlink()).hash(h),
            Err(_) => 0u8.hash(h),
        }
    }
    let mut h = DefaultHasher::new();
    stamp(&root.join(MANIFEST), &mut h);
    let dir = root.join("components");
    stamp(&dir, &mut h);
    if let Ok(read) = std::fs::read_dir(&dir) {
        let mut names: Vec<_> = read.filter_map(Result::ok).map(|e| e.file_name()).collect();
        names.sort();
        for n in names {
            n.hash(&mut h);
            stamp(&dir.join(&n), &mut h);
        }
    }
    h.finish()
}

fn info_of(loaded: &Loaded, kind: &'static str, source: Option<LibrarySource>, commit: Option<String>) -> LibraryInfo {
    let m = &loaded.manifest;
    LibraryInfo {
        id: m.name.clone(),
        kind,
        title: m.title.clone(),
        description: m.description.clone(),
        publisher: m.publisher.clone(),
        homepage: m.homepage.clone(),
        version: m.version.clone(),
        source,
        commit,
        enabled: true,
        components: loaded.entries.clone(),
        reads: loaded.reads.clone(),
        needs: loaded.needs.clone(),
        errors: loaded.errors.clone(),
        installed_at: None,
        updated_at: None,
    }
}

/// Put `new` where `dest` is, replacing it; `dest` stays as it was on failure.
fn replace_dir(new: &Path, dest: &Path) -> Result<(), String> {
    let fail = |e: std::io::Error| format!("couldn't install into {}: {e}", dest.display());
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(fail)?;
    }
    let old = dest.with_file_name(format!(".old-{}", &crate::session::random_token()[..12]));
    let had = dest.symlink_metadata().is_ok();
    if had {
        std::fs::rename(dest, &old).map_err(fail)?;
    }
    if let Err(e) = std::fs::rename(new, dest) {
        if had {
            let _ = std::fs::rename(&old, dest);
        }
        return Err(fail(e));
    }
    if had {
        let _ = std::fs::remove_dir_all(&old);
    }
    Ok(())
}

/// `{type: "card"}` → `{type: "acme/card"}` for each exported sibling.
fn qualify(node: &mut Value, lib: &str, picked: &BTreeSet<String>) {
    let Some(obj) = node.as_object_mut() else { return };
    if let Some(Value::String(t)) = obj.get_mut("type")
        && picked.contains(t.as_str())
    {
        *t = format!("{lib}/{t}");
    }
    for key in ["children", "else"] {
        if let Some(Value::Array(kids)) = obj.get_mut(key) {
            for k in kids {
                qualify(k, lib, picked);
            }
        }
    }
}

fn readme(m: &Manifest, components: &BTreeMap<&String, Component>) -> String {
    let mut s = format!("# {}\n\n{}\n\n", m.title, m.description);
    let _ = write!(
        s,
        "A component library for yaah. Install it from the Component library page with this repo's git URL \
         (add `ref` to pin a tag or branch). Its components are named `{}/<name>`.\n\n## Components\n\n",
        m.name
    );
    for (n, c) in components {
        let _ = writeln!(s, "- `{}/{n}` — {}", m.name, c.description);
    }
    s
}

fn lock<T>(m: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

// ── the library commands ────────────────────────────────────────────────────

impl Library {
    fn store(&self) -> Result<&Store, String> {
        self.store.as_ref().ok_or_else(|| "component libraries can't be installed here".to_owned())
    }

    /// Previews and half-replaced checkouts an earlier run left behind.
    pub(crate) fn clean_staging(&self) {
        let Some(store) = &self.store else { return };
        let _ = std::fs::remove_dir_all(store.staging());
        for e in std::fs::read_dir(&store.dir).into_iter().flatten().filter_map(Result::ok) {
            if e.file_name().to_string_lossy().starts_with(".old-") {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }

    /// Load every installed library again from its records.
    pub(crate) fn reload(&self) {
        let Some(store) = &self.store else { return };
        let mut packs: Vec<Arc<Pack>> = store.records().into_iter().map(|r| Arc::new(Pack::load(store, r))).collect();
        sort_packs(&mut packs);
        *self.packs.write().unwrap_or_else(PoisonError::into_inner) = packs;
    }

    /// Reload the folder libraries whose files changed since they were read.
    pub(crate) fn refresh_folders(&self) {
        let Some(store) = &self.store else { return };
        let stale: Vec<Arc<Pack>> = self.packs().into_iter().filter(|p| p.is_folder() && fingerprint(&p.root) != p.fingerprint).collect();
        if stale.is_empty() {
            return;
        }
        let fresh: Vec<Arc<Pack>> = stale.iter().map(|p| Arc::new(Pack::load(store, p.record.clone()))).collect();
        let mut packs = self.packs.write().unwrap_or_else(PoisonError::into_inner);
        for (old, new) in stale.iter().zip(fresh) {
            if let Some(slot) = packs.iter_mut().find(|p| Arc::ptr_eq(p, old)) {
                *slot = new;
            }
        }
        sort_packs(&mut packs);
    }

    fn info(&self, id: &str) -> Result<LibraryInfo, String> {
        self.packs().iter().find(|p| p.id() == id).map(|p| p.info()).ok_or_else(|| format!("no component library `{id}` is installed"))
    }

    /// yaah's own, then the user's, then installed libraries by title.
    pub fn list_libraries(&self) -> Result<Vec<LibraryInfo>, String> {
        self.refresh_folders();
        let mut out = vec![];
        for s in self.sources() {
            let mut comps = s.list()?;
            comps.sort_by(|a, b| a.name.cmp(&b.name));
            let follow = |t: &str| if qualified(t).is_some() { None } else { self.raw_get(t).ok().flatten() };
            let (mut reads, mut needs, mut seen) = (BTreeSet::new(), BTreeSet::new(), BTreeSet::new());
            for c in &comps {
                reads_of(&c.tree, &follow, &mut seen, &mut reads);
                needs.extend(types_in(&c.tree).iter().filter_map(|t| qualified(t)).map(|(lib, _)| lib.to_owned()));
            }
            let (kind, title, description, publisher) = if s.writable() {
                ("local", "My components", "Components you and your agents build, kept in ~/.yaah/components.", None)
            } else {
                (
                    "builtin",
                    "Provided by yaah",
                    "Components that ship with yaah. Read-only: compose them, or copy one into your collection to change it.",
                    Some("yaah"),
                )
            };
            out.push(LibraryInfo {
                id: s.id().to_owned(),
                kind,
                title: title.into(),
                description: description.into(),
                publisher: publisher.map(Into::into),
                homepage: None,
                version: None,
                source: None,
                commit: None,
                enabled: true,
                components: comps
                    .into_iter()
                    .map(|c| LibraryComponent { name: c.name, description: c.description, valid: true, error: None })
                    .collect(),
                reads: reads.into_iter().collect(),
                needs: needs.into_iter().collect(),
                errors: vec![],
                installed_at: None,
                updated_at: None,
            });
        }
        out.extend(self.packs().iter().map(|p| p.info()));
        Ok(out)
    }

    /// Fetch a library into staging and check it. Installs nothing.
    pub async fn inspect(&self, source: LibrarySource) -> Result<LibraryPreview, String> {
        let store = self.store()?;
        self.prune_staged();
        let staging_id = crate::session::random_token()[..16].to_owned();
        let (source, dir, commit, loaded) = match source {
            LibrarySource::Git { url, git_ref } => {
                let url = url.trim().to_owned();
                let git_ref = git_ref.map(|r| r.trim().to_owned()).filter(|r| !r.is_empty());
                check_url(&url, store.file_urls_allowed())?;
                if let Some(r) = &git_ref {
                    check_ref(r)?;
                }
                std::fs::create_dir_all(store.staging()).map_err(|e| format!("create {}: {e}", store.staging().display()))?;
                let dir = store.staging().join(&staging_id);
                let fetched = match store.fetch(&url, git_ref.as_deref(), &dir).await {
                    Ok(commit) => load_blocking(dir.clone(), None).await.map(|l| (commit, l)),
                    Err(e) => Err(e),
                };
                match fetched {
                    Ok((commit, loaded)) => (LibrarySource::Git { url, git_ref }, Some(dir), Some(commit), loaded),
                    Err(e) => {
                        let _ = std::fs::remove_dir_all(&dir);
                        return Err(e);
                    }
                }
            }
            LibrarySource::Folder { path } => {
                let p = PathBuf::from(path.trim());
                if !p.is_absolute() {
                    return Err("pick a folder (an absolute path)".into());
                }
                let canon = std::fs::canonicalize(&p).map_err(|e| format!("{}: {e}", p.display()))?;
                let loaded = load_blocking(canon.clone(), None).await?;
                (LibrarySource::Folder { path: canon.to_string_lossy().into_owned() }, None, None, loaded)
            }
        };
        let id = loaded.manifest.name.clone();
        let replaces = self.packs().iter().find(|p| p.id() == id).map(|p| p.id().to_owned());
        let kind = if dir.is_some() { "git" } else { "folder" };
        let info = info_of(&loaded, kind, Some(source.clone()), commit.clone());
        lock(&self.staged).insert(staging_id.clone(), Staged { source, dir, id, commit, at: Instant::now() });
        Ok(LibraryPreview { info, staging_id, replaces })
    }

    /// Drop previews nobody installed (a cancelled preview is only dropped in
    /// the UI), and any staging folder on disk older than [`STAGING_TTL`].
    fn prune_staged(&self) {
        let mut staged = lock(&self.staged);
        staged.retain(|_, s| {
            let keep = s.at.elapsed() < STAGING_TTL;
            if !keep && let Some(dir) = &s.dir {
                let _ = std::fs::remove_dir_all(dir);
            }
            keep
        });
        let Some(store) = &self.store else { return };
        for e in std::fs::read_dir(store.staging()).into_iter().flatten().filter_map(Result::ok) {
            let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age >= STAGING_TTL);
            if old && !staged.contains_key(&*e.file_name().to_string_lossy()) {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }

    /// Install a previewed library (replacing one with the same id) and turn it on.
    pub fn install(&self, staging_id: &str) -> Result<LibraryInfo, String> {
        let store = self.store()?;
        let _one = lock(&self.ops);
        let staged = lock(&self.staged).remove(staging_id).ok_or("this preview has expired; look the library up again")?;
        let id = staged.id.clone();
        let checkout = store.checkout(&id);
        match (&staged.source, &staged.dir) {
            (LibrarySource::Git { .. }, Some(dir)) => {
                if let Err(e) = replace_dir(dir, &checkout) {
                    let _ = std::fs::remove_dir_all(dir);
                    return Err(e);
                }
            }
            (LibrarySource::Folder { path }, _) => {
                load_dir(Path::new(path), Some(&id))?;
                if checkout.symlink_metadata().is_ok() {
                    std::fs::remove_dir_all(&checkout).map_err(|e| format!("remove {}: {e}", checkout.display()))?;
                }
            }
            (LibrarySource::Git { .. }, None) => return Err("nothing was fetched for this preview; look the library up again".into()),
        }
        let t = ui::now();
        store.records.update(|records: &mut Vec<Record>| {
            records.retain(|r| r.id != id);
            records.push(Record {
                id: id.clone(),
                source: staged.source.clone(),
                commit: staged.commit.clone(),
                enabled: true,
                installed_at: t,
                updated_at: t,
            });
            Ok(())
        })?;
        self.reload();
        self.info(&id)
    }

    /// Git: fetch the ref again into staging and swap it in when it checks out
    /// (the installed version stays otherwise). Folder: read it again.
    pub async fn update(&self, id: &str) -> Result<LibraryUpdate, String> {
        let store = self.store()?;
        let record = store.records().into_iter().find(|r| r.id == id).ok_or_else(|| format!("no component library `{id}` is installed"))?;
        let before = self.packs().iter().find(|p| p.id() == id).map(|p| p.loaded.digests.clone()).unwrap_or_default();
        let (from, to) = match &record.source {
            LibrarySource::Git { url, git_ref } => {
                std::fs::create_dir_all(store.staging()).map_err(|e| format!("create {}: {e}", store.staging().display()))?;
                let dir = store.staging().join(&crate::session::random_token()[..16]);
                let fetched = match store.fetch(url, git_ref.as_deref(), &dir).await {
                    Ok(commit) => load_blocking(dir.clone(), Some(id.to_owned())).await.map(|_| commit),
                    Err(e) => Err(e),
                };
                let commit = match fetched {
                    Ok(c) => c,
                    Err(e) => {
                        let _ = std::fs::remove_dir_all(&dir);
                        return Err(format!("couldn't update `{id}`, so the installed version stays: {e}"));
                    }
                };
                let swapped = {
                    let _one = lock(&self.ops);
                    if store.records().iter().any(|r| r.id == id) {
                        replace_dir(&dir, &store.checkout(id)).and_then(|()| {
                            store.records.update(|records: &mut Vec<Record>| {
                                if let Some(r) = records.iter_mut().find(|r| r.id == id) {
                                    r.commit = Some(commit.clone());
                                    r.updated_at = ui::now();
                                }
                                Ok(())
                            })
                        })
                    } else {
                        Err(format!("`{id}` was removed while it updated"))
                    }
                };
                if let Err(e) = swapped {
                    let _ = std::fs::remove_dir_all(&dir);
                    return Err(e);
                }
                (record.commit.clone(), Some(commit))
            }
            LibrarySource::Folder { .. } => {
                let _one = lock(&self.ops);
                store.records.update(|records: &mut Vec<Record>| {
                    if let Some(r) = records.iter_mut().find(|r| r.id == id) {
                        r.updated_at = ui::now();
                    }
                    Ok(())
                })?;
                (None, None)
            }
        };
        self.reload();
        let after = self.packs().iter().find(|p| p.id() == id).map(|p| p.loaded.digests.clone()).unwrap_or_default();
        let changed = before
            .keys()
            .chain(after.keys())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .filter(|n| before.get(*n) != after.get(*n))
            .map(|n| format!("{id}/{n}"))
            .collect();
        Ok(LibraryUpdate { library: self.info(id)?, from, to, changed })
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<LibraryInfo, String> {
        if RESERVED.contains(&id) {
            return Err("yaah's own components and yours are always on".into());
        }
        let store = self.store()?;
        let _one = lock(&self.ops);
        store.records.update(|records: &mut Vec<Record>| {
            let r = records.iter_mut().find(|r| r.id == id).ok_or_else(|| format!("no component library `{id}` is installed"))?;
            r.enabled = enabled;
            Ok(())
        })?;
        self.reload();
        self.info(id)
    }

    /// Uninstall. A git checkout is deleted; a folder library's folder is left alone.
    pub fn remove(&self, id: &str) -> Result<(), String> {
        if RESERVED.contains(&id) {
            return Err("yaah's own components and yours can't be removed".into());
        }
        let store = self.store()?;
        let _one = lock(&self.ops);
        let removed = store.records.update(|records: &mut Vec<Record>| {
            let i = records.iter().position(|r| r.id == id).ok_or_else(|| format!("no component library `{id}` is installed"))?;
            Ok(records.remove(i))
        })?;
        if matches!(removed.source, LibrarySource::Git { .. }) && valid_library_name(id) {
            let dir = store.checkout(id);
            if dir.symlink_metadata().is_ok()
                && let Err(e) = std::fs::remove_dir_all(&dir)
            {
                eprintln!("[libraries] couldn't delete {}: {e}", dir.display());
            }
        }
        self.reload();
        Ok(())
    }

    /// Copy one of yaah's components or an installed library's into the
    /// user's collection. References to its own library stay qualified.
    pub fn copy_component(&self, name: &str, new_name: Option<&str>) -> Result<Component, String> {
        self.refresh_folders();
        let (lib, short) = qualified(name).unwrap_or(("yaah", name));
        let (c, origin) = if lib == "yaah" {
            let c = self.sources().iter().find(|s| s.id() == "yaah").and_then(|s| s.get(short).ok().flatten());
            (c.ok_or_else(|| format!("yaah has no component `{short}`"))?, "yaah".to_owned())
        } else {
            let packs = self.packs();
            let p = packs.iter().find(|p| p.id() == lib).ok_or_else(|| format!("no component library `{lib}` is installed"))?;
            if !p.record.enabled {
                return Err(format!("turn the library `{lib}` on first: its components can't be used while it's off"));
            }
            let c = p.loaded.components.get(short).cloned().ok_or_else(|| format!("`{name}` isn't a component `{lib}` loaded"))?;
            let at = p.record.commit.as_deref().map(|s| &s[..s.len().min(7)]).or(p.loaded.manifest.version.as_deref());
            (c, format!("{}{}", p.loaded.manifest.title, at.map(|a| format!(" @ {a}")).unwrap_or_default()))
        };
        let new = new_name.map(str::trim).filter(|n| !n.is_empty()).unwrap_or(short);
        if !ui::valid_name(new) {
            return Err(format!(
                "`{new}` can't be a component name: kebab-case, lowercase letters, digits and -, starting with a letter, 2-48 chars"
            ));
        }
        if ui::is_primitive(new) || self.raw_get(new)?.is_some() {
            return Err(format!("`{new}` is already taken; pick another name for the copy"));
        }
        self.save(SaveRequest {
            name: new.to_owned(),
            description: c.description,
            props: c.props,
            tree: c.tree,
            examples: c.examples,
            change_note: Some(format!("Copied from {name} ({origin}).")),
            expected_version: None,
        })
        .map_err(|errs| errs.join("\n"))
    }

    /// Write local components out as a library folder, `<dir>/<name>/`, ready
    /// to publish as a git repo. References between the exported components
    /// become `<name>/<sibling>`. If they use local components that weren't
    /// picked, nothing is written and those are returned as `missing`.
    pub fn export(&self, dir: &str, manifest: &Manifest, names: &[String]) -> Result<LibraryExport, String> {
        let mut problems = vec![];
        let manifest = parse_manifest(&serde_json::to_vec(manifest).map_err(|e| e.to_string())?, &mut problems)?;
        if !problems.is_empty() {
            return Err(problems.join("; "));
        }
        if manifest.version.is_none() {
            return Err("give the library a version, like 1.0.0".into());
        }
        let dir = Path::new(dir);
        if !dir.is_absolute() || !dir.is_dir() {
            return Err(format!("{} isn't a folder", dir.display()));
        }
        let target = dir.join(&manifest.name);
        let local = self.sources().iter().find(|s| s.writable()).ok_or("there's no local collection to export from")?;
        let bundled = |t: &str| self.sources().iter().any(|s| s.id() == "yaah" && s.get(t).ok().flatten().is_some());
        let picked: BTreeSet<String> = names.iter().map(|n| n.trim().to_owned()).collect();
        if picked.is_empty() {
            return Err("pick at least one component".into());
        }
        let mut comps: BTreeMap<&String, Component> = BTreeMap::new();
        for n in &picked {
            comps.insert(n, local.get(n)?.ok_or_else(|| format!("`{n}` isn't in your collection"))?);
        }
        // Local components the picked ones use (through each other) that weren't picked.
        let (mut missing, mut seen) = (BTreeSet::new(), picked.clone());
        let mut queue: Vec<Component> = comps.values().cloned().collect();
        while let Some(c) = queue.pop() {
            for t in types_in(&c.tree) {
                if qualified(&t).is_some() || bundled(&t) {
                    continue;
                }
                if let Ok(Some(dep)) = local.get(&t) {
                    if !picked.contains(&t) {
                        missing.insert(t.clone());
                    }
                    if seen.insert(t) {
                        queue.push(dep);
                    }
                }
            }
        }
        let path = target.to_string_lossy().into_owned();
        if !missing.is_empty() {
            return Ok(LibraryExport { path, missing: missing.into_iter().collect() });
        }
        match std::fs::symlink_metadata(&target) {
            Ok(m) if m.is_dir() && std::fs::read_dir(&target).is_ok_and(|mut d| d.next().is_none()) => {}
            Ok(_) => return Err(format!("{path} already exists and isn't empty; pick another folder")),
            Err(_) => {}
        }
        for (n, c) in &comps {
            let mut tree = c.tree.clone();
            qualify(&mut tree, &manifest.name, &picked);
            let mut file =
                json!({ "name": n, "version": c.version, "description": c.description, "props": c.props, "tree": tree, "examples": c.examples });
            if let Some(note) = &c.change_note {
                file["changeNote"] = note.clone().into();
            }
            json_file::write(&target.join("components").join(format!("{n}.json")), &file, false)?;
        }
        json_file::write(&target.join(MANIFEST), &manifest, false)?;
        std::fs::write(target.join("README.md"), readme(&manifest, &comps)).map_err(|e| format!("write README.md: {e}"))?;
        Ok(LibraryExport { path, missing: vec![] })
    }
}

fn sort_packs(packs: &mut [Arc<Pack>]) {
    packs.sort_by_cached_key(|p| (p.loaded.manifest.title.to_lowercase(), p.id().to_owned()));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui_library::LocalDir;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("yaah-libs-{tag}-{}", crate::session::random_token()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn git(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// The app's library over a temp home: yaah's own, a local collection and a store.
    fn app(root: &Path, allow_file_urls: bool) -> Library {
        let mut store = Store::at(root.join("config/libraries.json"), root.join("libraries"));
        store.allow_file_urls = allow_file_urls;
        Library::new(vec![Box::new(Bundled::new()), Box::new(LocalDir::new(root.join("components")))], Some(store))
    }

    fn manifest(name: &str) -> Value {
        json!({ "name": name, "title": format!("{name} components"), "description": "Components for testing", "publisher": "Test Inc.", "version": "1.0.0" })
    }

    #[allow(clippy::needless_pass_by_value, reason = "callers build the tree in place")]
    fn component(name: &str, tree: Value) -> Value {
        json!({
            "name": name, "version": 1, "description": format!("The {name} test component"),
            "props": { "type": "object", "properties": { "label": { "type": "string" } }, "required": ["label"] },
            "tree": tree, "examples": [{ "title": "one", "props": { "label": "hi" } }]
        })
    }

    fn write_library(dir: &Path, manifest: &Value, comps: &[(&str, Value)]) {
        std::fs::create_dir_all(dir.join("components")).unwrap();
        std::fs::write(dir.join(MANIFEST), manifest.to_string()).unwrap();
        for (name, c) in comps {
            std::fs::write(dir.join("components").join(format!("{name}.json")), c.to_string()).unwrap();
        }
    }

    fn badge() -> Value {
        component("badge-row", json!({ "type": "stack", "children": [{ "type": "badge", "props": { "text": "{{label}}" } }] }))
    }

    fn card(lib: &str) -> Value {
        component("info-card", json!({ "type": "card", "children": [{ "type": format!("{lib}/badge-row"), "props": { "label": "{{label}}" } }] }))
    }

    /// A bare repo holding `work`'s commits, as a file:// URL.
    fn publish(root: &Path, work: &Path) -> String {
        git(work, &["init", "-q", "-b", "main"]);
        commit(work, "first");
        let bare = root.join("origin.git");
        std::fs::create_dir_all(&bare).unwrap();
        git(&bare, &["init", "-q", "--bare", "-b", "main"]);
        git(work, &["push", "-q", bare.to_str().unwrap(), "main"]);
        format!("file://{}", bare.display())
    }

    fn commit(work: &Path, msg: &str) {
        git(work, &["add", "-A"]);
        git(work, &["commit", "-q", "-m", msg]);
    }

    fn push(root: &Path, work: &Path, msg: &str) {
        commit(work, msg);
        git(work, &["push", "-q", root.join("origin.git").to_str().unwrap(), "main"]);
    }

    fn names(lib: &Library) -> Vec<String> {
        lib.list().unwrap().into_iter().map(|c| c.name).collect()
    }

    #[tokio::test]
    async fn installs_updates_disables_and_removes_a_git_library() {
        let root = tmp("git");
        let lib = app(&root, true);
        let work = root.join("work");
        write_library(&work, &manifest("acme"), &[("badge-row", badge()), ("info-card", card("acme"))]);
        std::os::unix::fs::symlink("/etc/hosts", work.join("components/evil.json")).unwrap();
        let url = publish(&root, &work);

        let preview = lib.inspect(LibrarySource::Git { url: url.clone(), git_ref: None }).await.unwrap();
        assert_eq!((preview.info.id.as_str(), preview.info.kind, preview.replaces.as_deref()), ("acme", "git", None));
        assert_eq!(preview.info.commit.as_ref().map(String::len), Some(40));
        assert!(preview.info.components.iter().all(|c| c.valid), "{:?}", preview.info.components);
        assert_eq!(preview.info.components.len(), 2, "the symlink isn't a component");
        assert!(preview.info.errors.iter().any(|e| e.contains("components/evil.json is a symlink")), "{:?}", preview.info.errors);
        assert!(!names(&lib).contains(&"acme/info-card".to_owned()), "inspecting installs nothing");
        assert_eq!(lib.list_libraries().unwrap().len(), 2);

        let info = lib.install(&preview.staging_id).unwrap();
        assert!(info.enabled && info.installed_at.is_some());
        assert!(root.join("libraries/acme/yaah-library.json").is_file());
        assert!(!root.join("libraries/acme/components/evil.json").exists());
        assert!(lib.install(&preview.staging_id).unwrap_err().contains("expired"));
        let c = lib.get("acme/info-card").unwrap().unwrap();
        assert_eq!((c.source.as_str(), c.library.as_deref()), ("acme", Some("acme components")));
        let all = lib.list_libraries().unwrap();
        assert_eq!(all.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(), ["yaah", "local", "acme"]);
        assert!(all[2].errors.iter().any(|e| e.contains("symlink")), "remembered after install: {:?}", all[2].errors);

        // A new release: one component changed, one added.
        let mut changed = card("acme");
        changed["description"] = "A card with a badge row, now improved".into();
        write_library(
            &work,
            &manifest("acme"),
            &[("info-card", changed), ("extra", component("extra", json!({ "type": "text", "props": { "text": "{{label}}" } })))],
        );
        push(&root, &work, "second");
        let up = lib.update("acme").await.unwrap();
        assert_ne!(up.from, up.to);
        assert_eq!(up.from, info.commit);
        assert_eq!(up.changed, ["acme/extra", "acme/info-card"]);
        assert_eq!(lib.get("acme/info-card").unwrap().unwrap().description, "A card with a badge row, now improved");
        assert!(lib.update("acme").await.unwrap().changed.is_empty(), "nothing new");

        // A release that renames the library is refused, and the installed one stays.
        write_library(&work, &manifest("other"), &[]);
        push(&root, &work, "renamed");
        let err = lib.update("acme").await.unwrap_err();
        assert!(err.contains("installed version stays") && err.contains("names the library `other`"), "{err}");
        assert_eq!(lib.info("acme").unwrap().commit, up.to);

        let off = lib.set_enabled("acme", false).unwrap();
        assert!(!off.enabled);
        assert!(!names(&lib).iter().any(|n| n.starts_with("acme/")));
        assert!(lib.prepare(Some("acme/info-card"), json!({ "label": "x" }), None).unwrap_err()[0].contains("turned off"));
        lib.set_enabled("acme", true).unwrap();
        assert!(lib.prepare(Some("acme/info-card"), json!({ "label": "x" }), None).is_ok());
        assert!(lib.set_enabled("yaah", false).is_err() && lib.remove("local").is_err());

        lib.remove("acme").unwrap();
        assert!(!root.join("libraries/acme").exists());
        assert_eq!(lib.list_libraries().unwrap().len(), 2);
        assert!(lib.prepare(Some("acme/info-card"), json!({ "label": "x" }), None).unwrap_err()[0].contains("no component library `acme`"));
        // Installed state survives a restart (a fresh load from the records).
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn qualified_references_expand_and_unqualified_ones_stay_as_they_were() {
        let root = tmp("refs");
        let lib = app(&root, false);
        let yaah = Bundled::new().list().unwrap().into_iter().find(|c| !c.examples.is_empty()).unwrap();
        let folder = root.join("acme");
        let uses_yaah = component(
            "with-yaah",
            json!({ "type": "stack", "children": [{ "type": "acme/info-card", "props": { "label": "{{label}}" } }, { "type": yaah.name, "props": yaah.examples[0].props }] }),
        );
        let uses_other = component("uses-other", json!({ "type": "other/thing", "props": {} }));
        write_library(
            &folder,
            &manifest("acme"),
            &[("badge-row", badge()), ("info-card", card("acme")), ("with-yaah", uses_yaah), ("uses-other", uses_other)],
        );
        let preview = lib.inspect(LibrarySource::Folder { path: folder.to_string_lossy().into() }).await.unwrap();
        assert!(preview.info.components.iter().all(|c| c.valid), "{:?}", preview.info.components);
        assert_eq!(preview.info.needs, ["other"]);
        lib.install(&preview.staging_id).unwrap();

        let p = lib.prepare(Some("acme/with-yaah"), json!({ "label": "hi" }), None).unwrap();
        assert_eq!((p.tree["type"].as_str(), p.tree["name"].as_str()), (Some("$component"), Some("acme/with-yaah")));
        let kids = &p.tree["tree"]["children"];
        assert_eq!(kids[0]["name"], "acme/info-card");
        assert_eq!(kids[0]["tree"]["children"][0]["name"], "acme/badge-row");
        assert_eq!(kids[0]["tree"]["children"][0]["tree"]["children"][0]["type"], "badge");
        assert_eq!(kids[1]["name"], yaah.name);
        let err = lib.prepare(Some("acme/uses-other"), json!({ "label": "x" }), None).unwrap_err();
        assert!(err[0].contains("no component library `other` is installed"), "{err:?}");

        // The user's own components compose library ones; unqualified names resolve as before.
        let mine = lib
            .save(SaveRequest {
                name: "my-card".into(),
                description: "Wraps the acme card for testing".into(),
                props: json!({ "type": "object" }),
                tree: json!({ "type": "acme/info-card", "props": { "label": "mine" } }),
                examples: vec![],
                change_note: None,
                expected_version: None,
            })
            .unwrap();
        assert_eq!(mine.source, "local");
        assert!(lib.prepare(Some("my-card"), json!({}), None).is_ok());
        assert_eq!(lib.get(&yaah.name).unwrap().unwrap().source, "yaah");
        let catalog = lib.catalog().unwrap();
        let listed = catalog["components"].as_array().unwrap().iter().find(|c| c["name"] == "acme/info-card").unwrap().clone();
        assert_eq!((listed["source"].as_str(), listed["library"].as_str()), (Some("acme"), Some("acme components")));
        // An expansion over the budget is refused through library components too.
        let errs = lib.prepare(None, json!({}), Some(json!({ "type": "acme/nope" }))).unwrap_err();
        assert!(errs[0].contains("has no component `nope`"), "{errs:?}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn a_library_may_not_use_the_users_own_components() {
        let root = tmp("unq");
        let lib = app(&root, false);
        lib.save(SaveRequest {
            name: "my-badge".into(),
            description: "The user's own badge for testing".into(),
            props: json!({ "type": "object" }),
            tree: json!({ "type": "badge", "props": { "text": "mine" } }),
            examples: vec![],
            change_note: None,
            expected_version: None,
        })
        .unwrap();
        let folder = root.join("acme");
        write_library(
            &folder,
            &manifest("acme"),
            &[
                ("badge-row", badge()),
                ("uses-local", component("uses-local", json!({ "type": "my-badge" }))),
                ("uses-that", component("uses-that", json!({ "type": "acme/uses-local", "props": { "label": "x" } }))),
                ("bare-sibling", component("bare-sibling", json!({ "type": "badge-row", "props": { "label": "x" } }))),
            ],
        );
        let loaded = load_dir(&folder, None).unwrap();
        let by_name = |n: &str| loaded.entries.iter().find(|e| e.name == n).unwrap().clone();
        let local = by_name("acme/uses-local");
        assert!(!local.valid && local.error.as_deref().unwrap().contains("unqualified names are yaah's own"), "{local:?}");
        let that = by_name("acme/uses-that");
        assert!(!that.valid && that.error.as_deref().unwrap().contains("my-badge"), "{that:?}");
        assert!(by_name("acme/bare-sibling").error.unwrap().contains("acme/badge-row"), "own components are qualified");
        assert!(by_name("acme/badge-row").valid);
        assert_eq!(loaded.components.keys().collect::<Vec<_>>(), ["badge-row"]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn skips_symlinks_and_reports_invalid_components_while_the_rest_load() {
        let root = tmp("bad");
        let lib = app(&root, false);
        let folder = root.join("acme");
        let live = component(
            "pr-status",
            json!({ "type": "live", "props": { "source": { "kind": "github.pr", "repo": "{{label}}", "number": 1 } }, "children": [{ "type": "container-logs", "props": { "container": "x" } }] }),
        );
        let bound = component("bound", json!({ "type": "live", "props": { "source": { "kind": "{{label}}" } }, "children": [] }));
        let mut misnamed = badge();
        misnamed["name"] = "other-name".into();
        write_library(&folder, &manifest("acme"), &[("badge-row", badge()), ("pr-status", live), ("bound", bound), ("misnamed", misnamed)]);
        let dir = folder.join("components");
        std::fs::write(dir.join("broken.json"), "{ not json").unwrap();
        std::fs::write(dir.join("huge.json"), " ".repeat(300 * 1024)).unwrap();
        std::fs::write(dir.join("README.md"), "not a component").unwrap();
        let secret = root.join("secret.json");
        std::fs::write(&secret, badge().to_string()).unwrap();
        std::os::unix::fs::symlink(&secret, dir.join("linked.json")).unwrap();

        let preview = lib.inspect(LibrarySource::Folder { path: folder.to_string_lossy().into() }).await.unwrap();
        let info = &preview.info;
        assert!(info.errors.iter().any(|e| e.contains("components/linked.json is a symlink; skipped")), "{:?}", info.errors);
        let error = |n: &str| info.components.iter().find(|c| c.name == format!("acme/{n}")).and_then(|c| c.error.clone()).unwrap_or_default();
        assert!(error("broken").contains("not a component"), "{info:?}");
        assert!(error("huge").contains("over 256 KB"));
        assert!(error("misnamed").contains("they must match"));
        assert!(error("bound").contains("must name its source kind"));
        assert!(error("badge-row").is_empty() && error("pr-status").is_empty(), "{info:?}");
        assert_eq!(info.reads, ["docker", "github"], "its own live node and the yaah component it uses");
        assert_eq!(info.components.len(), 6, "linked.json and README.md aren't components");

        // A folder library is live: edits show without reinstalling.
        lib.install(&preview.staging_id).unwrap();
        assert!(lib.get("acme/broken").unwrap().is_none());
        let mut fixed = badge();
        fixed["name"] = "broken".into();
        std::fs::write(dir.join("broken.json"), fixed.to_string()).unwrap();
        assert!(lib.get("acme/broken").unwrap().is_some());
        let up = lib.update("acme").await.unwrap();
        assert_eq!((up.from, up.to), (None, None));
        // The folder isn't deleted with the library.
        lib.remove("acme").unwrap();
        assert!(folder.join(MANIFEST).is_file());

        // A manifest that's missing or names a reserved id can't be inspected at all.
        std::fs::write(folder.join(MANIFEST), manifest("yaah").to_string()).unwrap();
        assert!(lib.inspect(LibrarySource::Folder { path: folder.to_string_lossy().into() }).await.unwrap_err().contains("reserved"));
        std::fs::remove_file(folder.join(MANIFEST)).unwrap();
        assert!(load_dir(&folder, None).unwrap_err().contains("isn't a yaah component library"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn refuses_urls_and_refs_git_could_misread() {
        for good in
            ["https://github.com/acme/ui", "https://git.acme.dev/team/ui.git", "ssh://git@github.com/acme/ui.git", "git@github.com:acme/ui.git"]
        {
            assert_eq!(check_url(good, false), Ok(()), "{good}");
        }
        for bad in [
            "-u",
            "--upload-pack=touch /tmp/pwned",
            "ext::sh -c touch% /tmp/pwned",
            "https://github.com/a::b",
            "file:///tmp/repo",
            "http://github.com/acme/ui",
            "ssh://-oProxyCommand=touch/x",
            "git@-oProxyCommand=x:y",
            "git@host:-u",
            "/tmp/repo",
            "acme/ui",
            "https://-x/repo",
            "",
        ] {
            assert!(check_url(bad, false).is_err(), "{bad}");
        }
        assert!(check_url("file:///tmp/repo", false).unwrap_err().contains("add the folder"));
        for good in ["main", "v1.2.0", "release/2026-11", "feature_x"] {
            assert_eq!(check_ref(good), Ok(()), "{good}");
        }
        for bad in ["-u", "--upload-pack=x", "a b", "", "x;y", "$(id)"] {
            assert!(check_ref(bad).is_err(), "{bad}");
        }
        // Through the command, before anything runs.
        let root = tmp("urls");
        let lib = app(&root, false);
        let refuse = |url: &str, git_ref: Option<&str>| lib.inspect(LibrarySource::Git { url: url.into(), git_ref: git_ref.map(Into::into) });
        assert!(refuse("--upload-pack=touch /tmp/x", None).await.unwrap_err().contains("isn't a git URL"));
        assert!(refuse("file:///tmp/x", None).await.unwrap_err().contains("file://"));
        assert!(refuse("https://github.com/acme/ui", Some("--upload-pack=x")).await.unwrap_err().contains("isn't a tag or branch"));
        assert!(!root.join("libraries/.staging").exists() || std::fs::read_dir(root.join("libraries/.staging")).unwrap().next().is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn pins_a_tag() {
        let root = tmp("ref");
        let lib = app(&root, true);
        let work = root.join("work");
        write_library(&work, &manifest("acme"), &[("badge-row", badge())]);
        let url = publish(&root, &work);
        git(&work, &["tag", "v1"]);
        git(&work, &["push", "-q", root.join("origin.git").to_str().unwrap(), "v1"]);
        write_library(&work, &manifest("acme"), &[("info-card", card("acme"))]);
        push(&root, &work, "after the tag");
        // Staging left behind (a preview cancelled in the UI an hour ago, or by an earlier run) goes on the next look-up.
        let (stale, fresh) = (root.join("libraries/.staging/stale"), root.join("libraries/.staging/fresh"));
        std::fs::create_dir_all(&stale).unwrap();
        std::fs::create_dir_all(&fresh).unwrap();
        let two_hours_ago = std::time::SystemTime::now() - Duration::from_hours(2);
        std::fs::File::open(&stale).unwrap().set_modified(two_hours_ago).unwrap();
        let preview = lib.inspect(LibrarySource::Git { url: url.clone(), git_ref: Some("v1".into()) }).await.unwrap();
        assert!(!stale.exists() && fresh.exists());
        lib.clean_staging();
        assert!(!root.join("libraries/.staging").exists(), "startup clears it all");
        assert_eq!(preview.info.components.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["acme/badge-row"]);
        let latest = lib.inspect(LibrarySource::Git { url, git_ref: None }).await.unwrap();
        assert_eq!(latest.info.components.len(), 2);
        let err = lib.inspect(LibrarySource::Git { url: format!("file://{}", root.join("nope.git").display()), git_ref: None }).await.unwrap_err();
        assert!(err.starts_with("git clone failed"), "{err}");
        std::fs::remove_dir_all(root).unwrap();
    }

    fn save_local(lib: &Library, name: &str, tree: Value) {
        lib.save(SaveRequest {
            name: name.into(),
            description: format!("The {name} local test component"),
            props: json!({ "type": "object", "properties": { "label": { "type": "string" } } }),
            tree,
            examples: vec![ui::Example { title: "one".into(), props: json!({ "label": "hi" }) }],
            change_note: None,
            expected_version: None,
        })
        .unwrap();
    }

    #[tokio::test]
    async fn exports_a_collection_that_installs_back() {
        let root = tmp("export");
        let lib = app(&root, false);
        save_local(&lib, "env-badge", json!({ "type": "badge", "props": { "text": "{{label}}" } }));
        save_local(&lib, "env-inner", json!({ "type": "text", "props": { "text": "{{label}}" } }));
        save_local(&lib, "env-mid", json!({ "type": "stack", "children": [{ "type": "env-inner", "props": { "label": "{{label}}" } }] }));
        save_local(
            &lib,
            "env-card",
            json!({ "type": "card", "children": [
                { "type": "env-badge", "props": { "label": "{{label}}" } },
                { "type": "env-mid", "props": { "label": "{{label}}" } }
            ]}),
        );
        let out = root.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let m: Manifest = serde_json::from_value(manifest("team")).unwrap();
        let dir = out.to_string_lossy().into_owned();

        let partial = lib.export(&dir, &m, &["env-card".into()]).unwrap();
        assert_eq!(partial.missing, ["env-badge", "env-inner", "env-mid"], "everything it uses, through each other");
        assert!(!out.join("team").exists(), "nothing written");

        let picked: Vec<String> = ["env-card", "env-badge", "env-mid", "env-inner"].map(Into::into).to_vec();
        let done = lib.export(&dir, &m, &picked).unwrap();
        assert_eq!(done.missing, Vec::<String>::new());
        assert_eq!(PathBuf::from(&done.path), out.join("team"));
        let file: Value = serde_json::from_str(&std::fs::read_to_string(out.join("team/components/env-card.json")).unwrap()).unwrap();
        assert_eq!((file["name"].as_str(), file["tree"]["children"][0]["type"].as_str()), (Some("env-card"), Some("team/env-badge")));
        assert!(file.get("source").is_none() && file.get("uses").is_none(), "only what a library file holds");
        let written: Value = serde_json::from_str(&std::fs::read_to_string(out.join("team").join(MANIFEST)).unwrap()).unwrap();
        assert_eq!((written["name"].as_str(), written["version"].as_str()), (Some("team"), Some("1.0.0")));
        assert!(std::fs::read_to_string(out.join("team/README.md")).unwrap().contains("`team/env-card`"));
        assert!(lib.export(&dir, &m, &picked).unwrap_err().contains("isn't empty"));

        let preview = lib.inspect(LibrarySource::Folder { path: done.path.clone() }).await.unwrap();
        assert!(preview.info.components.iter().all(|c| c.valid) && preview.info.errors.is_empty(), "{:?}", preview.info);
        lib.install(&preview.staging_id).unwrap();
        let p = lib.prepare(Some("team/env-card"), json!({ "label": "prod" }), None).unwrap();
        assert_eq!(p.tree["tree"]["children"][1]["tree"]["children"][0]["name"], "team/env-inner");

        let mut bad = m.clone();
        bad.version = None;
        assert!(lib.export(&dir, &bad, &picked).unwrap_err().contains("version"));
        bad = m.clone();
        bad.name = "local".into();
        assert!(lib.export(&dir, &bad, &picked).unwrap_err().contains("reserved"));
        assert!(lib.export(&dir, &m, &["nope".into()]).unwrap_err().contains("isn't in your collection"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn copies_components_into_the_collection() {
        let root = tmp("copy");
        let lib = app(&root, false);
        let folder = root.join("acme");
        write_library(&folder, &manifest("acme"), &[("badge-row", badge()), ("info-card", card("acme"))]);
        let preview = lib.inspect(LibrarySource::Folder { path: folder.to_string_lossy().into() }).await.unwrap();
        lib.install(&preview.staging_id).unwrap();

        let copy = lib.copy_component("acme/info-card", None).unwrap();
        assert_eq!((copy.name.as_str(), copy.source.as_str(), copy.version), ("info-card", "local", 1));
        assert_eq!(copy.tree["children"][0]["type"], "acme/badge-row", "references to its library stay qualified");
        assert!(copy.change_note.unwrap().contains("acme/info-card"));
        assert!(root.join("components/info-card/component.json").is_file());
        assert!(lib.copy_component("acme/info-card", None).unwrap_err().contains("already taken"));
        assert_eq!(lib.copy_component("acme/info-card", Some("my-card")).unwrap().name, "my-card");
        assert!(lib.copy_component("acme/nope", Some("x-nope")).is_err());

        let yaah = Bundled::new().list().unwrap()[0].name.clone();
        assert!(lib.copy_component(&yaah, None).unwrap_err().contains("already taken"));
        assert_eq!(lib.copy_component(&yaah, Some("my-yaah-copy")).unwrap().source, "local");
        lib.set_enabled("acme", false).unwrap();
        assert!(lib.copy_component("acme/badge-row", Some("off-copy")).unwrap_err().contains("turn the library `acme` on"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn agents_cant_save_a_qualified_name() {
        let root = tmp("save");
        let lib = app(&root, false);
        let errs = lib
            .save(SaveRequest {
                name: "acme/info-card".into(),
                description: "An attempt to overwrite a library component".into(),
                props: json!({ "type": "object" }),
                tree: json!({ "type": "badge", "props": { "text": "x" } }),
                examples: vec![],
                change_note: None,
                expected_version: None,
            })
            .unwrap_err();
        assert!(errs[0].contains("Copy it to the collection first") && errs[0].contains("`info-card`"), "{errs:?}");
        assert!(!root.join("components").exists(), "nothing written");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn installed_libraries_load_again_from_their_records() {
        let root = tmp("restart");
        let folder = root.join("acme");
        write_library(&folder, &manifest("acme"), &[("badge-row", badge())]);
        let store = Store::at(root.join("config/libraries.json"), root.join("libraries"));
        let record = Record {
            id: "acme".into(),
            source: LibrarySource::Folder { path: folder.to_string_lossy().into() },
            commit: None,
            enabled: true,
            installed_at: 1,
            updated_at: 1,
        };
        let hand_edited = Record { id: "../escape".into(), ..record.clone() };
        json_file::write(&root.join("config/libraries.json"), &[record, hand_edited], false).unwrap();
        let lib = Library::new(vec![Box::new(Bundled::new())], Some(store));
        lib.reload();
        assert_eq!(lib.packs().iter().map(|p| p.id().to_owned()).collect::<Vec<_>>(), ["acme"]);
        assert!(lib.get("acme/badge-row").unwrap().is_some());
        let raw = std::fs::read_to_string(root.join("config/libraries.json")).unwrap();
        assert!(raw.contains("\"kind\": \"folder\"") && raw.contains("\"installedAt\""), "{raw}");
        std::fs::remove_dir_all(root).unwrap();
    }
}
