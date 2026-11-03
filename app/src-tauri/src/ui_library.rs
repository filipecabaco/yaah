//! The UI component library agents use, build and improve.
//!
//! A component is data, not code: a tree of base primitives
//! (`src/ui-primitives.json`) and other library components, with a JSON
//! Schema for its props and worked examples. Because it is data it renders
//! straight into the chat's React tree with nothing to sandbox.
//!
//! Components live in a [`ComponentSource`]:
//! - [`Bundled`] (`yaah`): the components yaah ships, embedded from
//!   `src-tauri/components/*.json` and released with the app. Read-only, and
//!   their names are reserved: agents use and compose them, never overwrite.
//! - [`LocalDir`] (`local`): what agents build, in `~/.yaah/components/`.
//!
//! Beside them sit the installed component libraries (`ui_libraries.rs`):
//! sets of components other people publish as a git repo or a folder, which
//! can be installed, updated, turned off and removed while the app runs. Their
//! components are addressed by a qualified name, `<library>/<name>`.
//! Unqualified names resolve as before: yaah's own first, then local. Inside an
//! installed library's component, unqualified names are yaah's own only.
//!
//! The library is kept in memory ([`Snapshot`]): every component with its
//! `uses` worked out once, the catalog agents read and the names the guide
//! lists. yaah's own changes (a save, an install, update, enable or remove)
//! replace it at once; changes made on disk by something else (an edited
//! component file, a folder library's files) are noticed within [`RECHECK`].

use crate::accounts::home;
use crate::ui_libraries::{Pack, Staged, Store};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock, PoisonError, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const PRIMITIVES_JSON: &str = include_str!("../../src/ui-primitives.json");
const MAX_DEPTH: usize = 30;
const MAX_NODES: usize = 3000;
const MAX_NESTING: usize = 8;
/// Nodes a render may have once every library component in it is filled in.
/// Each use of a component copies its whole tree, so a few small components
/// nested a few deep would otherwise expand exponentially.
const MAX_EXPANDED: usize = 3000;
/// How often the files behind the in-memory library are checked for changes
/// made outside yaah. yaah's own changes replace it at once.
pub(crate) const RECHECK: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Example {
    pub title: String,
    pub props: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Component {
    pub name: String,
    pub version: u32,
    /// What it shows and when to use it. Agents read this to choose.
    pub description: String,
    /// JSON Schema for the props.
    pub props: Value,
    pub tree: Value,
    #[serde(default)]
    pub examples: Vec<Example>,
    #[serde(default)]
    pub change_note: Option<String>,
    #[serde(default)]
    pub updated_at: u64,
    /// Which source it came from: "yaah", "local", or an installed library's id. Not stored.
    #[serde(default, skip_deserializing)]
    pub source: String,
    /// Libraries it is built on: the union of its primitives' `uses`, through
    /// nested components. Derived when read, never trusted from disk.
    #[serde(default, skip_deserializing)]
    pub uses: Vec<String>,
    /// The title of the installed component library it comes from. Not stored.
    #[serde(default, skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub library: Option<String>,
}

/// What a component name in a tree refers to.
#[derive(Clone)]
pub(crate) enum Resolved {
    Found(Arc<Component>),
    /// Unknown or unusable here; the message says why (without the node's path).
    Missing(String),
    /// Another installed library's component, checked when that library is used.
    Unchecked,
}

/// Looks up the components a tree uses.
pub(crate) trait Resolve {
    /// `in_library`: the name appears inside an installed library's component,
    /// where unqualified names may only be yaah's own components.
    fn resolve(&self, name: &str, in_library: bool) -> Resolved;
}

/// `acme/pr-card` → `("acme", "pr-card")`.
pub(crate) fn qualified(name: &str) -> Option<(&str, &str)> {
    name.split_once('/')
}

/// Where components are stored. One local folder today; shared sources later.
pub trait ComponentSource: Send + Sync {
    fn id(&self) -> &'static str;
    fn writable(&self) -> bool;
    fn list(&self) -> Result<Vec<Component>, String>;
    fn get(&self, name: &str) -> Result<Option<Component>, String>;
    /// Store `component`, keeping the version it replaces in history.
    fn save(&self, component: &Component) -> Result<(), String>;
    /// Changes whenever what [`list`](Self::list) would return may have changed on disk.
    fn fingerprint(&self) -> u64 {
        0
    }
}

/// The components yaah ships, embedded at build time (see `build.rs`) and
/// parsed once (the catalog and every render read them).
pub struct Bundled {
    components: &'static Result<Vec<Component>, String>,
}

const BUNDLED: &[(&str, &str)] = include!(concat!(env!("OUT_DIR"), "/bundled_components.rs"));

impl Bundled {
    pub fn new() -> Self {
        static PARSED: OnceLock<Result<Vec<Component>, String>> = OnceLock::new();
        Self { components: PARSED.get_or_init(|| BUNDLED.iter().map(|(n, raw)| Self::parse(n, raw)).collect()) }
    }

    fn parse(name: &str, raw: &str) -> Result<Component, String> {
        let mut c: Component = serde_json::from_str(raw).map_err(|e| format!("bundled {name}: {e}"))?;
        if c.name != name {
            return Err(format!("bundled {name}: file says it is `{}`", c.name));
        }
        c.source = "yaah".into();
        Ok(c)
    }
}

impl Default for Bundled {
    fn default() -> Self {
        Self::new()
    }
}

impl ComponentSource for Bundled {
    fn id(&self) -> &'static str {
        "yaah"
    }

    fn writable(&self) -> bool {
        false
    }

    fn list(&self) -> Result<Vec<Component>, String> {
        self.components.clone()
    }

    fn get(&self, name: &str) -> Result<Option<Component>, String> {
        Ok(self.components.as_ref().map_err(Clone::clone)?.iter().find(|c| c.name == name).cloned())
    }

    fn save(&self, _: &Component) -> Result<(), String> {
        Err("components provided by yaah are read-only".into())
    }
}

pub struct LocalDir {
    root: PathBuf,
}

impl LocalDir {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn file(&self, name: &str) -> PathBuf {
        self.root.join(name).join("component.json")
    }
}

impl ComponentSource for LocalDir {
    fn id(&self) -> &'static str {
        "local"
    }

    fn writable(&self) -> bool {
        true
    }

    fn list(&self) -> Result<Vec<Component>, String> {
        let Ok(entries) = std::fs::read_dir(&self.root) else { return Ok(vec![]) };
        let mut out = vec![];
        for e in entries.filter_map(Result::ok) {
            let name = e.file_name().to_string_lossy().into_owned();
            if let Ok(Some(c)) = self.get(&name) {
                out.push(c);
            }
        }
        Ok(out)
    }

    fn get(&self, name: &str) -> Result<Option<Component>, String> {
        if !valid_name(name) {
            return Ok(None);
        }
        match std::fs::read_to_string(self.file(name)) {
            Ok(raw) => {
                let mut c: Component = serde_json::from_str(&raw).map_err(|e| format!("{name}: {e}"))?;
                self.id().clone_into(&mut c.source);
                Ok(Some(c))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("read {name}: {e}")),
        }
    }

    fn save(&self, c: &Component) -> Result<(), String> {
        let dir = self.root.join(&c.name);
        let history = dir.join("history");
        std::fs::create_dir_all(&history).map_err(|e| format!("create {}: {e}", history.display()))?;
        let file = self.file(&c.name);
        if let Ok(previous) = std::fs::read_to_string(&file)
            && let Ok(prev) = serde_json::from_str::<Component>(&previous)
        {
            std::fs::write(history.join(format!("v{}.json", prev.version)), previous).map_err(|e| format!("write history: {e}"))?;
        }
        let tmp = file.with_extension("json.tmp");
        let json = serde_json::to_string_pretty(c).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, json).map_err(|e| format!("write {}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, &file).map_err(|e| format!("rename {}: {e}", file.display()))
    }

    /// The names, sizes, times and inodes of every `component.json`: a stat each, no reads.
    fn fingerprint(&self) -> u64 {
        let mut h = DefaultHasher::new();
        let Ok(entries) = std::fs::read_dir(&self.root) else { return 0 };
        let mut names: Vec<_> = entries.filter_map(Result::ok).map(|e| e.file_name()).collect();
        names.sort();
        for n in names {
            n.hash(&mut h);
            match std::fs::metadata(self.root.join(&n).join("component.json")) {
                Ok(m) => (m.len(), m.modified().ok(), m.ino()).hash(&mut h),
                Err(_) => 0u8.hash(&mut h),
            }
        }
        h.finish()
    }
}

pub struct Library {
    /// yaah's own, then local: fixed for the app's life.
    sources: Vec<Box<dyn ComponentSource>>,
    /// Installed libraries (on or off), by title. Replaced on install, update,
    /// enable and remove; a folder library is reloaded when its files change.
    pub(crate) packs: RwLock<Vec<Arc<Pack>>>,
    /// Where installed libraries are recorded and checked out. `None`: none can be installed.
    pub(crate) store: Option<Store>,
    /// Libraries fetched and validated by `inspect`, waiting for `install`.
    pub(crate) staged: Mutex<HashMap<String, Staged>>,
    /// One install, update, enable or remove at a time.
    pub(crate) ops: Mutex<()>,
    /// Bumped by every change yaah makes to the library; the snapshot of an older one is stale.
    generation: AtomicU64,
    /// The library in memory, as of a generation and the files' fingerprint.
    cache: Mutex<Option<Arc<Snapshot>>>,
    /// `false` while the installed libraries are first read (in the background, at startup).
    loaded: Mutex<bool>,
    loaded_cv: Condvar,
}

/// The library as last read: every component with its `uses`, and what agents
/// are given from it (the catalog, the component names), built on first use.
pub(crate) struct Snapshot {
    generation: u64,
    fingerprint: u64,
    /// When the files were last checked against `fingerprint`.
    checked: Mutex<Instant>,
    /// Each source's components (yaah's own, then local) by name.
    sources: Vec<HashMap<String, Arc<Component>>>,
    packs: Vec<Arc<Pack>>,
    /// What `list` returns: by name, with `uses`.
    list: Vec<Component>,
    catalog: OnceLock<Arc<String>>,
    names: OnceLock<Arc<Vec<String>>>,
}

/// Resolves names against a snapshot, each name once per check or render.
pub(crate) struct Resolver<'a> {
    lib: &'a Library,
    snap: &'a Snapshot,
    memo: RefCell<HashMap<(bool, String), Resolved>>,
}

impl<'a> Resolver<'a> {
    fn new(lib: &'a Library, snap: &'a Snapshot) -> Self {
        Self { lib, snap, memo: RefCell::default() }
    }

    /// A component by name, as [`Library::raw_get`] finds it.
    fn get(&self, name: &str) -> Result<Option<Component>, String> {
        if let Some((lib, short)) = qualified(name) {
            return Ok(self.snap.packs.iter().find(|p| p.id() == lib && p.record.enabled).and_then(|p| p.loaded.components.get(short).cloned()));
        }
        for (s, known) in self.lib.sources.iter().zip(&self.snap.sources) {
            if let Some(c) = known.get(name) {
                return Ok(Some((**c).clone()));
            }
            // Not in memory: a file added since, or one that doesn't parse (and says why).
            if let Some(c) = s.get(name)? {
                return Ok(Some(c));
            }
        }
        Ok(None)
    }

    fn lookup(&self, name: &str, in_library: bool) -> Resolved {
        if let Some((lib, short)) = qualified(name) {
            let Some(p) = self.snap.packs.iter().find(|p| p.id() == lib) else {
                return Resolved::Missing(format!("unknown type `{name}`: no component library `{lib}` is installed"));
            };
            if !p.record.enabled {
                return Resolved::Missing(format!("`{name}` is in the component library `{lib}`, which is turned off"));
            }
            return match p.loaded.components.get(short) {
                Some(c) => Resolved::Found(Arc::new(c.clone())),
                None => Resolved::Missing(match p.loaded.entries.iter().find(|e| e.name == name).and_then(|e| e.error.as_deref()) {
                    Some(why) => format!("`{name}` isn't loaded, its library has a problem with it: {why}"),
                    None => format!("unknown type `{name}`: the component library `{lib}` has no component `{short}`"),
                }),
            };
        }
        // Inside a library only yaah's own: the user's local components differ from user to user.
        let sources = || self.lib.sources.iter().zip(&self.snap.sources).filter(|(s, _)| !in_library || s.id() == "yaah");
        if let Some(c) = sources().find_map(|(_, known)| known.get(name)) {
            return Resolved::Found(c.clone());
        }
        for (s, _) in sources() {
            match s.get(name) {
                Ok(Some(c)) => return Resolved::Found(Arc::new(c)),
                Ok(None) => {}
                Err(e) => return Resolved::Missing(e),
            }
        }
        Resolved::Missing(format!("unknown type `{name}`; use a primitive from ui_catalog or an existing component"))
    }
}

impl Resolve for Resolver<'_> {
    fn resolve(&self, name: &str, in_library: bool) -> Resolved {
        let key = (in_library && qualified(name).is_none(), name.to_owned());
        if let Some(r) = self.memo.borrow().get(&key) {
            return r.clone();
        }
        let r = self.lookup(name, in_library);
        self.memo.borrow_mut().insert(key, r.clone());
        r
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What the agent sends to create or update a component.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    pub name: String,
    pub description: String,
    #[serde(default = "empty_object_schema")]
    pub props: Value,
    pub tree: Value,
    #[serde(default)]
    pub examples: Vec<Example>,
    #[serde(default)]
    pub change_note: Option<String>,
    /// The version the agent last read; refuses the save if it moved on.
    #[serde(default)]
    pub expected_version: Option<u32>,
}

fn empty_object_schema() -> Value {
    json!({ "type": "object", "properties": {} })
}

/// A tree ready to render: library references expanded into `$component`
/// nodes carrying their own tree, so the renderer only sees primitives.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    pub component: Option<String>,
    pub version: Option<u32>,
    pub tree: Value,
    pub props: Value,
}

impl Library {
    /// The app's library: yaah's own, the user's, and the libraries they installed.
    /// Returns at once: the installed libraries are read on a thread of their own,
    /// and anything that needs them waits until they are.
    pub fn local() -> Arc<Self> {
        // yaah's own first: its names are reserved, so they always resolve to the shipped one.
        let lib = Arc::new(Self::new(vec![Box::new(Bundled::new()), Box::new(LocalDir::new(home().join(".yaah/components")))], Some(Store::user())));
        *lock(&lib.loaded) = false;
        let load = {
            let lib = lib.clone();
            move || {
                lib.clean_staging();
                lib.reload();
                *lock(&lib.loaded) = true;
                lib.loaded_cv.notify_all();
            }
        };
        if let Err(e) = std::thread::Builder::new().name("yaah-library-load".into()).spawn(load) {
            eprintln!("[library] loading in the foreground: {e}");
            lib.clean_staging();
            lib.reload();
            *lock(&lib.loaded) = true;
        }
        lib
    }

    pub(crate) fn new(sources: Vec<Box<dyn ComponentSource>>, store: Option<Store>) -> Self {
        Self {
            sources,
            packs: RwLock::default(),
            store,
            staged: Mutex::default(),
            ops: Mutex::default(),
            generation: AtomicU64::new(0),
            cache: Mutex::default(),
            loaded: Mutex::new(true),
            loaded_cv: Condvar::new(),
        }
    }

    /// Wait for the first read of the installed libraries.
    fn wait_loaded(&self) {
        let loaded = lock(&self.loaded);
        drop(self.loaded_cv.wait_while(loaded, |l| !*l).unwrap_or_else(PoisonError::into_inner));
    }

    /// The library changed: what's in memory is stale.
    pub(crate) fn changed(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    fn fingerprint(&self) -> u64 {
        let mut h = DefaultHasher::new();
        for s in &self.sources {
            s.fingerprint().hash(&mut h);
        }
        h.finish()
    }

    /// The library in memory: the last snapshot while it is current, else a new one.
    /// The files are looked at no more than every [`RECHECK`].
    pub(crate) fn snapshot(&self) -> Result<Arc<Snapshot>, String> {
        self.wait_loaded();
        // Held while a snapshot is built, so concurrent callers share one build.
        let mut cache = lock(&self.cache);
        if let Some(snap) = cache.as_ref()
            && snap.generation == self.generation()
        {
            if lock(&snap.checked).elapsed() < RECHECK {
                return Ok(snap.clone());
            }
            self.refresh_folders();
            if snap.generation == self.generation() && snap.fingerprint == self.fingerprint() {
                *lock(&snap.checked) = Instant::now();
                return Ok(snap.clone());
            }
        } else if cache.is_none() {
            self.refresh_folders();
        }
        // Taken before the files are read: a change while reading is caught at the next check.
        let (generation, fingerprint) = (self.generation(), self.fingerprint());
        let snap = Arc::new(self.build(generation, fingerprint)?);
        *cache = Some(snap.clone());
        Ok(snap)
    }

    fn build(&self, generation: u64, fingerprint: u64) -> Result<Snapshot, String> {
        let mut sources = vec![];
        for s in &self.sources {
            sources.push(s.list()?.into_iter().map(|c| (c.name.clone(), Arc::new(c))).collect::<HashMap<_, _>>());
        }
        let mut snap = Snapshot {
            generation,
            fingerprint,
            checked: Mutex::new(Instant::now()),
            sources,
            packs: self.packs(),
            list: vec![],
            catalog: OnceLock::new(),
            names: OnceLock::new(),
        };
        // First source wins on a name clash, then every enabled library's valid components by qualified name.
        let mut by_name: BTreeMap<String, Component> = BTreeMap::new();
        for known in &snap.sources {
            for c in known.values() {
                by_name.entry(c.name.clone()).or_insert_with(|| (**c).clone());
            }
        }
        for p in snap.packs.iter().filter(|p| p.record.enabled) {
            for c in p.loaded.components.values() {
                by_name.insert(c.name.clone(), c.clone());
            }
        }
        // One memo for the whole list: each component's libraries are worked out once.
        let list = {
            let resolver = Resolver::new(self, &snap);
            let mut memo = HashMap::new();
            by_name.into_values().map(|c| with_uses(&resolver, c, &mut memo)).collect()
        };
        snap.list = list;
        Ok(snap)
    }

    #[cfg(test)]
    pub fn with_sources(sources: Vec<Box<dyn ComponentSource>>) -> Self {
        Self::new(sources, None)
    }

    pub(crate) fn sources(&self) -> &[Box<dyn ComponentSource>] {
        &self.sources
    }

    /// The installed libraries as they are now.
    pub(crate) fn packs(&self) -> Vec<Arc<Pack>> {
        self.wait_loaded();
        self.packs.read().unwrap_or_else(PoisonError::into_inner).clone()
    }

    /// All components, first source wins on a name clash, then every enabled
    /// library's valid components by qualified name.
    pub fn list(&self) -> Result<Vec<Component>, String> {
        Ok(self.snapshot()?.list.clone())
    }

    pub fn get(&self, name: &str) -> Result<Option<Component>, String> {
        let snap = self.snapshot()?;
        if let Ok(i) = snap.list.binary_search_by(|c| c.name.as_str().cmp(name)) {
            return Ok(Some(snap.list[i].clone()));
        }
        let resolver = Resolver::new(self, &snap);
        Ok(resolver.get(name)?.map(|c| with_uses(&resolver, c, &mut HashMap::new())))
    }

    /// A component by name: qualified from an enabled library, else yaah's own, then local.
    pub(crate) fn raw_get(&self, name: &str) -> Result<Option<Component>, String> {
        let snap = self.snapshot()?;
        Resolver::new(self, &snap).get(name)
    }

    /// Everything an agent needs to choose or build a component.
    #[cfg(test)]
    pub fn catalog(&self) -> Result<Value, String> {
        serde_json::from_str(&self.catalog_json()?).map_err(|e| e.to_string())
    }

    /// [`catalog`](Self::catalog) as JSON text, built once per snapshot (`ui_catalog` sends it as is).
    pub fn catalog_json(&self) -> Result<Arc<String>, String> {
        let snap = self.snapshot()?;
        Ok(snap
            .catalog
            .get_or_init(|| {
                let p = primitives();
                let components: Vec<Value> = snap
                    .list
                    .iter()
                    .map(|c| {
                        let mut v = json!({ "name": c.name, "version": c.version, "source": c.source, "description": c.description, "props": c.props, "uses": c.uses });
                        if let Some(title) = &c.library {
                            v["library"] = title.clone().into();
                        }
                        v
                    })
                    .collect();
                Arc::new(json!({ "primitives": p["primitives"], "syntax": p["syntax"], "sources": p["sources"], "components": components }).to_string())
            })
            .clone())
    }

    /// Component names, yaah's own first, then the user's, then installed libraries' (what the guide lists).
    pub fn component_names(&self) -> Arc<Vec<String>> {
        let Ok(snap) = self.snapshot() else { return Arc::default() };
        snap.names
            .get_or_init(|| {
                let mut all: Vec<&Component> = snap.list.iter().collect();
                all.sort_by_key(|c| (u8::from(c.source != "yaah") + u8::from(c.source != "yaah" && c.source != "local"), c.name.as_str()));
                Arc::new(all.into_iter().map(|c| c.name.clone()).collect())
            })
            .clone()
    }

    /// Validate and store a component in the local collection. Errors are written for the agent to fix.
    pub fn save(&self, req: SaveRequest) -> Result<Component, Vec<String>> {
        if let Some(e) = qualified_save_error(&req.name) {
            return Err(vec![e]);
        }
        let snap = self.snapshot().map_err(|e| vec![e])?;
        let resolver = Resolver::new(self, &snap);
        let mut errs = vec![];
        if !valid_name(&req.name) {
            errs.push("name must be kebab-case: lowercase letters, digits and -, starting with a letter, 2-48 chars".into());
        }
        if is_primitive(&req.name) {
            errs.push(format!("`{}` is a primitive; pick another name", req.name));
        }
        let existing = resolver.get(&req.name).map_err(|e| vec![e])?;
        if let Some(c) = &existing
            && self.sources.iter().any(|s| !s.writable() && s.id() == c.source)
        {
            return Err(vec![format!(
                "`{}` is provided by {} and can't be changed. Use it as is, compose it inside your own component, or save your variant under a new name",
                req.name, c.source
            )]);
        }
        if let (Some(expected), Some(current)) = (req.expected_version, &existing)
            && expected != current.version
        {
            errs.push(format!(
                "`{}` is at v{} but you expected v{expected}; read it again with ui_get_component and reapply your change",
                req.name, current.version
            ));
        }
        if req.expected_version.is_some() && existing.is_none() {
            errs.push(format!("`{}` doesn't exist yet; omit expectedVersion to create it", req.name));
        }

        // The tree may use other library components, but never itself.
        check_contents(&req.name, &req.description, &req.props, &req.tree, &req.examples, &resolver, false, &mut errs);
        if !errs.is_empty() {
            return Err(errs);
        }

        let component = Component {
            name: req.name,
            version: existing.as_ref().map_or(1, |c| c.version + 1),
            description: req.description.trim().to_owned(),
            props: req.props,
            tree: req.tree,
            examples: req.examples,
            change_note: req.change_note,
            updated_at: now(),
            source: String::new(),
            uses: vec![],
            library: None,
        };
        let target = self.sources.iter().find(|s| s.writable()).ok_or_else(|| vec!["no writable component source".to_owned()])?;
        target.save(&component).map_err(|e| vec![e])?;
        self.changed();
        Ok(with_uses(&resolver, Component { source: target.id().to_owned(), ..component }, &mut HashMap::new()))
    }

    /// Validate a render request and expand library references.
    pub fn prepare(&self, component: Option<&str>, props: Value, tree: Option<Value>) -> Result<Prepared, Vec<String>> {
        let snap = self.snapshot().map_err(|e| vec![e])?;
        let resolver = Resolver::new(self, &snap);
        let mut errs = vec![];
        let props = if props.is_null() { json!({}) } else { props };
        let (root, name, version) = match (component, tree) {
            (Some(name), None) => {
                let c = match resolver.resolve(name, false) {
                    Resolved::Found(c) => c,
                    Resolved::Missing(why) if qualified(name).is_some() => return Err(vec![why]),
                    _ => return Err(vec![format!("no component named `{name}`; call ui_catalog to see what exists")]),
                };
                check_props(&c.props, &props, "props", &mut errs);
                (json!({ "type": name, "props": props }), Some(name.to_owned()), Some(c.version))
            }
            (None, Some(tree)) => {
                validate(&tree, "tree", &resolver, &mut Ctx::default(), 0, &mut errs);
                (tree, None, None)
            }
            _ => return Err(vec!["give either `component` (with `props`) or an ad-hoc `tree`, not both".into()]),
        };
        if !errs.is_empty() {
            return Err(errs);
        }
        let tree = Expansion::new(&resolver).expand(&root, &mut vec![], false, &mut errs);
        if !errs.is_empty() {
            return Err(errs);
        }
        Ok(Prepared { component: name, version, tree, props })
    }
}

impl Resolve for Library {
    fn resolve(&self, name: &str, in_library: bool) -> Resolved {
        match self.snapshot() {
            Ok(snap) => Resolver::new(self, &snap).lookup(name, in_library),
            Err(e) => Resolved::Missing(e),
        }
    }
}

/// `c` with its `uses` filled in. `memo` holds each nested component's
/// libraries once worked out, so a component used many times is walked once.
fn with_uses(lib: &dyn Resolve, mut c: Component, memo: &mut Uses) -> Component {
    let mut uses = BTreeSet::new();
    let in_library = qualified(&c.name).is_some();
    collect_uses(lib, &c.tree, &mut vec![c.name.clone()], in_library, memo, &mut 0, &mut uses);
    c.uses = uses.into_iter().collect();
    c
}

/// The libraries component `name` is built on, worked out once per `memo`.
fn uses_of(lib: &dyn Resolve, name: &str, stack: &mut Vec<String>, in_library: bool, memo: &mut Uses) -> Rc<BTreeSet<String>> {
    // Inside a library an unqualified name may resolve differently (yaah's own only).
    let key = if in_library && qualified(name).is_none() { format!("\0{name}") } else { name.to_owned() };
    if let Some(u) = memo.get(&key) {
        return u.clone();
    }
    let mut out = BTreeSet::new();
    if let Resolved::Found(c) = lib.resolve(name, in_library) {
        stack.push(name.to_owned());
        collect_uses(lib, &c.tree, stack, in_library || qualified(name).is_some(), memo, &mut 0, &mut out);
        stack.pop();
    }
    let out = Rc::new(out);
    memo.insert(key, out.clone());
    out
}

/// Libraries a tree is built on, following nested components (cycle-safe).
/// At most [`MAX_NODES`] nodes of one tree are walked (`walked` counts them):
/// the save checks keep trees under that, but a file on disk may not be.
fn collect_uses(
    lib: &dyn Resolve,
    node: &Value,
    stack: &mut Vec<String>,
    in_library: bool,
    memo: &mut Uses,
    walked: &mut usize,
    out: &mut BTreeSet<String>,
) {
    *walked += 1;
    if *walked > MAX_NODES {
        return;
    }
    let Some(obj) = node.as_object() else { return };
    for key in ["children", "else"] {
        for kid in obj.get(key).and_then(Value::as_array).into_iter().flatten() {
            collect_uses(lib, kid, stack, in_library, memo, walked, out);
        }
    }
    let Some(t) = obj.get("type").and_then(Value::as_str) else { return };
    if let Some(p) = primitive(t) {
        out.extend(p.get("uses").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned));
    } else if !stack.iter().any(|s| s == t) && stack.len() < MAX_NESTING {
        out.extend(uses_of(lib, t, stack, in_library, memo).iter().cloned());
    }
}

/// Why `name` can't be saved, when it is a library's qualified name.
pub(crate) fn qualified_save_error(name: &str) -> Option<String> {
    let (lib, short) = qualified(name)?;
    Some(format!(
        "`{name}` is a qualified name: components named `library/name` belong to an installed library and are read-only, and \
         ui_save_component only writes the user's own collection. Copy it to the collection first: read it with ui_get_component \
         and save it under an unqualified name such as `{short}` (pick another if that's taken), then change the copy. \
         It can keep using `{lib}/…` components"
    ))
}

/// The checks every stored component passes, whoever wrote it: a description,
/// a props schema, a valid tree within the node and expansion budgets, and
/// examples that fit the schema. `name` heads the expansion stack (a component
/// can't contain itself).
#[allow(clippy::too_many_arguments, reason = "the parts of a component, checked together")]
pub(crate) fn check_contents(
    name: &str,
    description: &str,
    props: &Value,
    tree: &Value,
    examples: &[Example],
    lib: &dyn Resolve,
    in_library: bool,
    errs: &mut Vec<String>,
) {
    let before = errs.len();
    if description.trim().len() < 10 {
        errs.push("description must say what the component shows and when to use it".into());
    }
    if !props.is_object() || props.get("type").is_some_and(|t| t != "object") {
        errs.push("props must be a JSON Schema object: { type: \"object\", properties: {...}, required: [...] }".into());
    }
    validate(tree, "tree", lib, &mut Ctx::default(), 0, errs);
    // Refuse a tree that contains itself, nests too deep, or expands past [`MAX_EXPANDED`].
    if errs.len() == before {
        Expansion::new(lib).expand(tree, &mut vec![name.to_owned()], in_library, errs);
    }
    for (i, ex) in examples.iter().enumerate() {
        check_props(props, &ex.props, &format!("examples[{i}].props"), errs);
    }
}

/// Libraries per component name, for one list or catalog call.
type Uses = HashMap<String, Rc<BTreeSet<String>>>;

/// One expansion of a tree: a single node budget for everything it pulls in,
/// and each component read once.
struct Expansion<'a> {
    lib: &'a dyn Resolve,
    nodes: usize,
    read: HashMap<(bool, String), Resolved>,
}

impl<'a> Expansion<'a> {
    fn new(lib: &'a dyn Resolve) -> Self {
        Self { lib, nodes: 0, read: HashMap::new() }
    }

    fn component(&mut self, name: &str, in_library: bool) -> Resolved {
        let key = (in_library && qualified(name).is_none(), name.to_owned());
        if let Some(c) = self.read.get(&key) {
            return c.clone();
        }
        let c = self.lib.resolve(name, in_library);
        self.read.insert(key, c.clone());
        c
    }

    /// Replace library references with `$component` nodes holding their tree.
    /// `in_library`: `node` is inside an installed library's component.
    fn expand(&mut self, node: &Value, stack: &mut Vec<String>, in_library: bool, errs: &mut Vec<String>) -> Value {
        self.nodes += 1;
        if self.nodes > MAX_EXPANDED {
            // Said once; everything after it is skipped without more work.
            if self.nodes == MAX_EXPANDED + 1 {
                errs.push(format!(
                    "with its components filled in this UI has more than {MAX_EXPANDED} nodes (every use of a component copies its whole tree, \
                     so nesting multiplies); use fewer or smaller nested components, or an `each` over a list in props"
                ));
            }
            return Value::Null;
        }
        let Some(obj) = node.as_object() else { return node.clone() };
        let mut out = obj.clone();
        for key in ["children", "else"] {
            if let Some(Value::Array(kids)) = obj.get(key) {
                out.insert(key.into(), Value::Array(kids.iter().map(|k| self.expand(k, stack, in_library, errs)).collect()));
            }
        }
        let Some(t) = obj.get("type").and_then(Value::as_str) else { return Value::Object(out) };
        if is_primitive(t) {
            return Value::Object(out);
        }
        if stack.iter().any(|s| s == t) {
            errs.push(format!("components can't contain themselves: {} → {t}", stack.join(" → ")));
            return Value::Null;
        }
        if stack.len() >= MAX_NESTING {
            errs.push(format!("components nest more than {MAX_NESTING} deep: {}", stack.join(" → ")));
            return Value::Null;
        }
        let c = match self.component(t, in_library) {
            Resolved::Found(c) => c,
            Resolved::Missing(why) => {
                errs.push(if qualified(t).is_some() || in_library { why } else { format!("no component named `{t}`") });
                return Value::Null;
            }
            // Another library's, while one library is checked on its own.
            Resolved::Unchecked => return Value::Null,
        };
        stack.push(t.to_owned());
        let inner = self.expand(&c.tree, stack, in_library || qualified(t).is_some(), errs);
        stack.pop();
        json!({
            "type": "$component",
            "name": t,
            "version": c.version,
            "props": obj.get("props").cloned().unwrap_or_else(|| json!({})),
            "tree": inner,
        })
    }
}

#[derive(Default)]
struct Ctx {
    nodes: usize,
}

pub(crate) fn primitives() -> &'static Value {
    static P: OnceLock<Value> = OnceLock::new();
    P.get_or_init(|| serde_json::from_str(PRIMITIVES_JSON).expect("ui-primitives.json is valid JSON"))
}

pub(crate) fn primitive(name: &str) -> Option<&'static Map<String, Value>> {
    primitives()["primitives"].get(name)?.as_object()
}

pub(crate) fn is_primitive(name: &str) -> bool {
    primitive(name).is_some()
}

/// Errors past this many are dropped: enough for the agent to fix, not a flood.
const MAX_ERRORS: usize = 50;

/// Visit every object node of a tree (through `children` and `else`), at most
/// [`MAX_NODES`] of them: what a library reads and refers to is found this way.
pub(crate) fn walk_nodes(tree: &Value, f: &mut dyn FnMut(&Map<String, Value>)) {
    fn go(node: &Value, f: &mut dyn FnMut(&Map<String, Value>), seen: &mut usize, depth: usize) {
        *seen += 1;
        if *seen > MAX_NODES || depth > MAX_DEPTH + 1 {
            return;
        }
        let Some(obj) = node.as_object() else { return };
        f(obj);
        for key in ["children", "else"] {
            for kid in obj.get(key).and_then(Value::as_array).into_iter().flatten() {
                go(kid, f, seen, depth + 1);
            }
        }
    }
    go(tree, f, &mut 0, 0);
}

fn validate(node: &Value, path: &str, lib: &dyn Resolve, ctx: &mut Ctx, depth: usize, errs: &mut Vec<String>) {
    ctx.nodes += 1;
    // Stop walking a tree that is too big; say so once.
    if ctx.nodes > MAX_NODES {
        if ctx.nodes == MAX_NODES + 1 {
            errs.push(format!("tree has more than {MAX_NODES} nodes"));
        }
        return;
    }
    if errs.len() >= MAX_ERRORS {
        return;
    }
    if depth > MAX_DEPTH {
        errs.push(format!("{path}: nested more than {MAX_DEPTH} deep"));
        return;
    }
    let obj = match node {
        Value::String(_) => return,
        Value::Object(o) => o,
        _ => {
            errs.push(format!("{path}: a node is a string or an object, got {}", shown(node)));
            return;
        }
    };
    let walk = |key: &str, ctx: &mut Ctx, errs: &mut Vec<String>| match obj.get(key) {
        None => {}
        Some(Value::Array(kids)) => {
            for (i, k) in kids.iter().enumerate() {
                validate(k, &format!("{path}.{key}[{i}]"), lib, ctx, depth + 1, errs);
            }
        }
        Some(_) => errs.push(format!("{path}.{key}: must be an array of nodes")),
    };

    if let Some(each) = obj.get("each") {
        if !each.is_string() {
            errs.push(format!("{path}.each: must be a path string like \"items\""));
        }
        for k in ["as", "index"] {
            if obj.get(k).is_some_and(|v| !v.is_string()) {
                errs.push(format!("{path}.{k}: must be a string"));
            }
        }
        walk("children", ctx, errs);
    } else if let Some(cond) = obj.get("if") {
        if !cond.is_string() {
            errs.push(format!("{path}.if: must be a path string"));
        }
        walk("children", ctx, errs);
        walk("else", ctx, errs);
    } else if let Some(t) = obj.get("type").and_then(Value::as_str) {
        let no_props = Map::new();
        let props = match obj.get("props") {
            None => &no_props,
            Some(Value::Object(p)) => p,
            Some(_) => {
                errs.push(format!("{path}.props: must be an object"));
                &no_props
            }
        };
        if let Some(p) = primitive(t) {
            let spec = p["props"].as_object().unwrap_or(&no_props);
            for (k, v) in props {
                let Some(s) = spec.get(k) else {
                    let allowed: Vec<&String> = spec.keys().collect();
                    errs.push(format!("{path}: `{t}` has no prop `{k}` (allowed: {allowed:?})"));
                    continue;
                };
                check_value(s, v, &format!("{path}.props.{k}"), errs);
            }
            for (k, s) in spec {
                if s["required"] == true && !props.contains_key(k) {
                    errs.push(format!("{path}: `{t}` needs prop `{k}`"));
                }
            }
            if obj.contains_key("children") && p["children"] != true {
                errs.push(format!("{path}: `{t}` takes no children; use its props"));
            }
            walk("children", ctx, errs);
        } else {
            match lib.resolve(t, false) {
                Resolved::Found(c) => check_props(&c.props, &Value::Object(props.clone()), &format!("{path}.props"), errs),
                Resolved::Missing(why) => errs.push(format!("{path}: {why}")),
                Resolved::Unchecked => {}
            }
            if obj.contains_key("children") {
                errs.push(format!("{path}: library components take props, not children"));
            }
        }
    } else {
        errs.push(format!("{path}: needs `type`, `each` or `if`"));
    }
}

/// A value as it goes into an error: short, whatever the agent sent.
pub(crate) fn shown(v: &Value) -> String {
    let text = v.to_string();
    if text.chars().count() > 80 { format!("{}…", text.chars().take(80).collect::<String>()) } else { text }
}

fn is_binding(v: &Value) -> bool {
    v.as_str().is_some_and(|s| s.contains("{{"))
}

/// Check one prop value against a primitive's prop spec. Bound values are
/// only known at render time, so they pass.
fn check_value(spec: &Value, v: &Value, path: &str, errs: &mut Vec<String>) {
    if is_binding(v) {
        return;
    }
    let want = spec["type"].as_str().unwrap_or("string");
    if !type_matches(want, v) {
        errs.push(format!("{path}: expected {want}, got {}", shown(v)));
        return;
    }
    if let (Some(options), Some(s)) = (spec["enum"].as_array(), v.as_str())
        && !options.iter().any(|o| o == s)
    {
        errs.push(format!("{path}: `{s}` isn't one of {options:?}"));
    }
}

/// Check props against a component's JSON Schema: required keys and the
/// top-level type of each property.
pub(crate) fn check_props(schema: &Value, props: &Value, path: &str, errs: &mut Vec<String>) {
    let Some(props) = props.as_object() else {
        errs.push(format!("{path}: must be an object"));
        return;
    };
    for req in schema["required"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        if !props.contains_key(req) {
            errs.push(format!("{path}: missing required prop `{req}`"));
        }
    }
    let defined: HashMap<&String, &Value> = schema["properties"].as_object().map(|p| p.iter().collect()).unwrap_or_default();
    for (k, v) in props {
        match defined.get(k) {
            None if !defined.is_empty() => errs.push(format!("{path}: `{k}` isn't in the component's props schema")),
            Some(s) if !is_binding(v) => {
                if let Some(want) = s["type"].as_str()
                    && !type_matches(want, v)
                {
                    errs.push(format!("{path}.{k}: expected {want}, got {}", shown(v)));
                }
            }
            _ => {}
        }
    }
}

fn type_matches(want: &str, v: &Value) -> bool {
    match want {
        "string" => v.is_string(),
        "number" => v.is_number(),
        "integer" => v.is_i64() || v.is_u64(),
        "boolean" => v.is_boolean(),
        "array" => v.is_array(),
        "object" => v.is_object(),
        _ => true,
    }
}

pub(crate) fn valid_name(name: &str) -> bool {
    (2..=48).contains(&name.len())
        && name.starts_with(|c: char| c.is_ascii_lowercase())
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

pub(crate) fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lib() -> (Library, PathBuf) {
        let dir = std::env::temp_dir().join(format!("yaah-ui-{}", crate::session::random_token()));
        (Library::with_sources(vec![Box::new(LocalDir::new(dir.clone()))]), dir)
    }

    fn save(lib: &Library, name: &str, tree: Value) -> Result<Component, Vec<String>> {
        lib.save(SaveRequest {
            name: name.into(),
            description: "A test component used in unit tests".into(),
            props: json!({ "type": "object", "properties": { "env": { "type": "string" } }, "required": ["env"] }),
            tree,
            examples: vec![Example { title: "prod".into(), props: json!({ "env": "prod" }) }],
            change_note: None,
            expected_version: None,
        })
    }

    #[test]
    fn saves_versions_and_keeps_history() {
        let (lib, dir) = lib();
        let tree = json!({ "type": "badge", "props": { "text": "{{env}}" } });
        assert_eq!(save(&lib, "env-badge", tree.clone()).unwrap().version, 1);
        assert_eq!(save(&lib, "env-badge", tree).unwrap().version, 2);
        assert!(dir.join("env-badge/history/v1.json").is_file());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn explains_what_is_wrong() {
        let (lib, dir) = lib();
        let errs = save(
            &lib,
            "Bad Name",
            json!({ "type": "stack", "children": [
                { "type": "badge", "props": { "variant": "loud" } },
                { "type": "text", "props": { "text": "x", "colour": "red" } },
                { "type": "nope" }
            ]}),
        )
        .unwrap_err();
        let all = errs.join("\n");
        assert!(all.contains("kebab-case"), "{all}");
        assert!(all.contains("`badge` needs prop `text`"), "{all}");
        assert!(all.contains("`loud` isn't one of"), "{all}");
        assert!(all.contains("has no prop `colour`"), "{all}");
        assert!(all.contains("unknown type `nope`"), "{all}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn expands_nested_components_and_refuses_cycles() {
        let (lib, dir) = lib();
        save(&lib, "env-badge", json!({ "type": "badge", "props": { "text": "{{env}}" } })).unwrap();
        save(&lib, "env-card", json!({ "type": "card", "children": [{ "type": "env-badge", "props": { "env": "{{env}}" } }] })).unwrap();

        let p = lib.prepare(Some("env-card"), json!({ "env": "prod" }), None).unwrap();
        assert_eq!(p.tree["type"], "$component");
        assert_eq!(p.tree["tree"]["children"][0]["type"], "$component");
        assert_eq!(p.tree["tree"]["children"][0]["tree"]["type"], "badge");

        // env-badge → env-card → env-badge
        let errs = save(&lib, "env-badge", json!({ "type": "env-card", "props": { "env": "x" } })).unwrap_err();
        assert!(errs.join(" ").contains("can't contain themselves"), "{errs:?}");

        assert!(lib.prepare(Some("env-card"), json!({}), None).unwrap_err()[0].contains("missing required prop `env`"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn knows_which_libraries_a_component_uses() {
        let (lib, dir) = lib();
        save(&lib, "env-chart", json!({ "type": "chart", "props": { "kind": "bar", "data": [], "x": "day", "series": [{ "key": "{{env}}" }] } }))
            .unwrap();
        let dash = save(
            &lib,
            "env-dashboard",
            json!({ "type": "stack", "children": [
                { "type": "markdown", "props": { "text": "# {{env}}" } },
                { "type": "env-chart", "props": { "env": "{{env}}" } }
            ]}),
        )
        .unwrap();
        assert_eq!(dash.uses, vec!["react-markdown", "recharts", "remark-gfm"]);
        assert!(lib.catalog().unwrap()["components"].as_array().unwrap().iter().any(|c| c["uses"] == json!(["recharts"])));
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// `lvl-0` holds ten charts; every `lvl-k` holds ten `lvl-(k-1)`: lvl-6 would expand to millions of nodes.
    fn level(k: usize) -> Component {
        let kid = if k == 0 {
            json!({ "type": "chart", "props": { "kind": "bar", "data": [], "x": "day", "series": [] } })
        } else {
            json!({ "type": format!("lvl-{}", k - 1), "props": {} })
        };
        Component {
            name: format!("lvl-{k}"),
            version: 1,
            description: "A level of a deeply nested test component".into(),
            props: empty_object_schema(),
            tree: json!({ "type": "stack", "children": vec![kid; 10] }),
            examples: vec![],
            change_note: None,
            updated_at: 0,
            source: String::new(),
            uses: vec![],
            library: None,
        }
    }

    #[test]
    fn nesting_that_multiplies_is_refused_quickly() {
        let (lib, dir) = lib();
        let started = std::time::Instant::now();
        let mut refused = None;
        for k in 0..=6 {
            let c = level(k);
            let req = SaveRequest {
                name: c.name,
                description: c.description,
                props: c.props,
                tree: c.tree,
                examples: vec![],
                change_note: None,
                expected_version: None,
            };
            match lib.save(req) {
                Ok(_) => assert!(refused.is_none()),
                Err(errs) => {
                    refused.get_or_insert(k);
                    let errs = errs.join(" ");
                    assert!(errs.contains("more than 3000 nodes") || errs.contains("unknown type `lvl-"), "{errs}");
                }
            }
        }
        assert_eq!(refused, Some(3), "lvl-2 expands to 1,221 nodes and fits; lvl-3 (12,221) doesn't");
        assert!(lib.prepare(Some("lvl-2"), json!({}), None).is_ok());
        assert!(started.elapsed() < std::time::Duration::from_secs(1), "took {:?}", started.elapsed());
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// A library that already holds such components (written to disk by hand, or
    /// before the budget existed) stays quick to list, read and refuse.
    #[test]
    fn a_library_with_exploding_components_stays_responsive() {
        let (lib, dir) = lib();
        let store = LocalDir::new(dir.clone());
        for k in 0..=6 {
            store.save(&level(k)).unwrap();
        }
        let started = std::time::Instant::now();
        let catalog = lib.catalog().unwrap();
        let top = catalog["components"].as_array().unwrap().iter().find(|c| c["name"] == "lvl-6").unwrap();
        assert_eq!(top["uses"], json!(["recharts"]), "libraries still come through every level");
        assert_eq!(lib.list().unwrap().len(), 7);
        assert_eq!(lib.get("lvl-6").unwrap().unwrap().uses, ["recharts"]);
        let errs = lib.prepare(Some("lvl-6"), json!({}), None).unwrap_err();
        assert_eq!(errs.len(), 1, "said once: {errs:?}");
        assert!(errs[0].contains("more than 3000 nodes"), "{errs:?}");
        let errs = lib.prepare(None, json!({}), Some(json!({ "type": "card", "children": [{ "type": "lvl-5" }] }))).unwrap_err();
        assert!(errs[0].contains("more than 3000 nodes"), "{errs:?}");
        let mut wrap = level(7);
        wrap.name = "wrapper".into();
        wrap.tree = json!({ "type": "lvl-6" });
        let req = SaveRequest {
            name: wrap.name,
            description: wrap.description,
            props: wrap.props,
            tree: wrap.tree,
            examples: vec![],
            change_note: None,
            expected_version: None,
        };
        assert!(lib.save(req).unwrap_err().join(" ").contains("more than 3000 nodes"));
        assert!(started.elapsed() < std::time::Duration::from_secs(1), "took {:?}", started.elapsed());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_stale_updates() {
        let (lib, dir) = lib();
        save(&lib, "env-badge", json!({ "type": "badge", "props": { "text": "{{env}}" } })).unwrap();
        save(&lib, "env-badge", json!({ "type": "badge", "props": { "text": "{{env}}" } })).unwrap();
        let errs = lib
            .save(SaveRequest {
                name: "env-badge".into(),
                description: "A test component used in unit tests".into(),
                props: json!({ "type": "object" }),
                tree: json!("x"),
                examples: vec![],
                change_note: None,
                expected_version: Some(1),
            })
            .unwrap_err();
        assert!(errs[0].contains("is at v2 but you expected v1"), "{errs:?}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn description_of(lib: &Library, name: &str) -> Option<String> {
        let catalog: Value = serde_json::from_str(&lib.catalog_json().unwrap()).unwrap();
        catalog["components"].as_array().unwrap().iter().find(|c| c["name"] == name).map(|c| c["description"].as_str().unwrap().to_owned())
    }

    /// The library is kept in memory: yaah's own saves show at once, an edit on
    /// disk within the recheck window, and the catalog and names are built once per change.
    #[test]
    fn the_library_in_memory_follows_saves_and_edits() {
        let (lib, dir) = lib();
        save(&lib, "env-badge", json!({ "type": "badge", "props": { "text": "{{env}}" } })).unwrap();
        assert_eq!(description_of(&lib, "env-badge").as_deref(), Some("A test component used in unit tests"));
        let (catalog, names) = (lib.catalog_json().unwrap(), lib.component_names());
        assert!(Arc::ptr_eq(&catalog, &lib.catalog_json().unwrap()), "the catalog JSON is built once");
        assert!(Arc::ptr_eq(&names, &lib.component_names()), "and the names");

        // Someone edits the file: memory serves the old one for now, then the edit within the window.
        let file = dir.join("env-badge/component.json");
        let mut c: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        c["description"] = json!("Edited in an editor, outside yaah");
        std::fs::write(&file, c.to_string()).unwrap();
        let edited = Instant::now();
        assert_eq!(description_of(&lib, "env-badge").as_deref(), Some("A test component used in unit tests"), "from memory");
        while description_of(&lib, "env-badge").as_deref() != Some("Edited in an editor, outside yaah") {
            assert!(edited.elapsed() < RECHECK + Duration::from_secs(1), "the edit didn't show within {RECHECK:?}");
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!Arc::ptr_eq(&catalog, &lib.catalog_json().unwrap()), "a new catalog for the new library");

        // A save shows at once, in the catalog, the names and to renders.
        save(&lib, "env-card", json!({ "type": "card", "children": [{ "type": "env-badge", "props": { "env": "{{env}}" } }] })).unwrap();
        assert!(description_of(&lib, "env-card").is_some());
        assert!(lib.component_names().contains(&"env-card".to_owned()));
        assert_eq!(lib.get("env-card").unwrap().unwrap().version, 1);
        // A file added by hand renders at once (looked up on a miss), and lists within the window.
        let mut copy = c.clone();
        copy["name"] = json!("env-copy");
        std::fs::create_dir_all(dir.join("env-copy")).unwrap();
        std::fs::write(dir.join("env-copy/component.json"), copy.to_string()).unwrap();
        assert!(lib.prepare(Some("env-copy"), json!({ "env": "x" }), None).is_ok());
        // Removed by hand: gone within the window.
        std::fs::remove_dir_all(dir.join("env-card")).unwrap();
        let removed = Instant::now();
        while description_of(&lib, "env-card").is_some() || description_of(&lib, "env-copy").is_none() {
            assert!(removed.elapsed() < RECHECK + Duration::from_secs(1));
            std::thread::sleep(Duration::from_millis(50));
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// While checking one tree each name is looked up once, however often it is used.
    #[test]
    fn names_are_resolved_once_per_check() {
        struct Counting<'a>(&'a Library, std::cell::Cell<usize>);
        impl Resolve for Counting<'_> {
            fn resolve(&self, name: &str, in_library: bool) -> Resolved {
                self.1.set(self.1.get() + 1);
                self.0.resolve(name, in_library)
            }
        }
        let (lib, dir) = lib();
        save(&lib, "env-badge", json!({ "type": "badge", "props": { "text": "{{env}}" } })).unwrap();
        let snap = lib.snapshot().unwrap();
        let counting = Counting(&lib, std::cell::Cell::new(0));
        let memo = Resolver { lib: &lib, snap: &snap, memo: RefCell::default() };
        let tree = json!({ "type": "stack", "children": vec![json!({ "type": "env-badge", "props": { "env": "x" } }); 200] });
        let mut errs = vec![];
        validate(&tree, "tree", &counting, &mut Ctx::default(), 0, &mut errs);
        assert_eq!(counting.1.get(), 200, "without a memo: once per node");
        validate(&tree, "tree", &memo, &mut Ctx::default(), 0, &mut errs);
        assert_eq!(memo.memo.borrow().len(), 1, "with it: once per name");
        assert!(errs.is_empty(), "{errs:?}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn with_bundled() -> (Library, PathBuf) {
        let dir = std::env::temp_dir().join(format!("yaah-ui-{}", crate::session::random_token()));
        (Library::with_sources(vec![Box::new(Bundled::new()), Box::new(LocalDir::new(dir.clone()))]), dir)
    }

    /// The guard for launching a new yaah component: it must be as valid as
    /// anything an agent saves, and every example must render.
    #[test]
    fn every_bundled_component_is_valid() {
        let (lib, _) = with_bundled();
        let all = Bundled::new().list().unwrap();
        assert!(!all.is_empty());
        for c in &all {
            let mut errs = vec![];
            if !valid_name(&c.name) || is_primitive(&c.name) {
                errs.push("bad name".to_owned());
            }
            if c.description.trim().len() < 40 {
                errs.push("description too short for an agent to choose by".to_owned());
            }
            if c.examples.is_empty() {
                errs.push("needs at least one example".to_owned());
            }
            validate(&c.tree, "tree", &lib, &mut Ctx::default(), 0, &mut errs);
            for (i, ex) in c.examples.iter().enumerate() {
                if let Err(e) = lib.prepare(Some(&c.name), ex.props.clone(), None) {
                    errs.push(format!("examples[{i}]: {e:?}"));
                }
            }
            assert!(errs.is_empty(), "{}: {errs:?}", c.name);
        }
        let catalog = lib.catalog().unwrap();
        assert!(catalog["components"].as_array().unwrap().iter().all(|c| c["source"] == "yaah"));
    }

    #[test]
    fn bundled_names_are_reserved() {
        let (lib, dir) = with_bundled();
        let name = Bundled::new().list().unwrap()[0].name.clone();
        let errs = save(&lib, &name, json!({ "type": "badge", "props": { "text": "mine" } })).unwrap_err();
        assert!(errs[0].contains("provided by yaah"), "{errs:?}");
        // Composing one is fine.
        save(
            &lib,
            "my-wrapper",
            json!({ "type": "card", "children": [{ "type": name, "props": lib.get(&name).unwrap().unwrap().examples[0].props }] }),
        )
        .unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }
}
