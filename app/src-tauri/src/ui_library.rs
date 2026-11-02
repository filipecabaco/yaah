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
//! A shared, git-backed source can be added beside them later without
//! changing the format.

use crate::accounts::home;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

const PRIMITIVES_JSON: &str = include_str!("../../src/ui-primitives.json");
const MAX_DEPTH: usize = 30;
const MAX_NODES: usize = 3000;
const MAX_NESTING: usize = 8;

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
    /// Which source it came from (e.g. "local"). Not stored.
    #[serde(default, skip_deserializing)]
    pub source: String,
    /// Libraries it is built on: the union of its primitives' `uses`, through
    /// nested components. Derived when read, never trusted from disk.
    #[serde(default, skip_deserializing)]
    pub uses: Vec<String>,
}

/// Where components are stored. One local folder today; shared sources later.
pub trait ComponentSource: Send + Sync {
    fn id(&self) -> &'static str;
    fn writable(&self) -> bool;
    fn list(&self) -> Result<Vec<Component>, String>;
    fn get(&self, name: &str) -> Result<Option<Component>, String>;
    /// Store `component`, keeping the version it replaces in history.
    fn save(&self, component: &Component) -> Result<(), String>;
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
}

pub struct Library {
    sources: Vec<Box<dyn ComponentSource>>,
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
    pub fn local() -> Self {
        // yaah's own first: its names are reserved, so they always resolve to the shipped one.
        Self { sources: vec![Box::new(Bundled::new()), Box::new(LocalDir::new(home().join(".yaah/components")))] }
    }

    #[cfg(test)]
    pub fn with_sources(sources: Vec<Box<dyn ComponentSource>>) -> Self {
        Self { sources }
    }

    /// All components, first source wins on a name clash.
    pub fn list(&self) -> Result<Vec<Component>, String> {
        let mut by_name: BTreeMap<String, Component> = BTreeMap::new();
        for s in &self.sources {
            for c in s.list()? {
                by_name.entry(c.name.clone()).or_insert(c);
            }
        }
        Ok(by_name.into_values().map(|c| self.with_uses(c)).collect())
    }

    pub fn get(&self, name: &str) -> Result<Option<Component>, String> {
        Ok(self.raw_get(name)?.map(|c| self.with_uses(c)))
    }

    fn raw_get(&self, name: &str) -> Result<Option<Component>, String> {
        for s in &self.sources {
            if let Some(c) = s.get(name)? {
                return Ok(Some(c));
            }
        }
        Ok(None)
    }

    fn with_uses(&self, mut c: Component) -> Component {
        let mut uses = BTreeSet::new();
        self.collect_uses(&c.tree, &mut vec![c.name.clone()], &mut uses);
        c.uses = uses.into_iter().collect();
        c
    }

    /// Libraries a tree is built on, following nested components (cycle-safe).
    fn collect_uses(&self, node: &Value, stack: &mut Vec<String>, out: &mut BTreeSet<String>) {
        let Some(obj) = node.as_object() else { return };
        for key in ["children", "else"] {
            for kid in obj.get(key).and_then(Value::as_array).into_iter().flatten() {
                self.collect_uses(kid, stack, out);
            }
        }
        let Some(t) = obj.get("type").and_then(Value::as_str) else { return };
        if let Some(p) = primitive(t) {
            out.extend(p.get("uses").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned));
        } else if !stack.iter().any(|s| s == t)
            && stack.len() < MAX_NESTING
            && let Ok(Some(c)) = self.raw_get(t)
        {
            stack.push(t.to_owned());
            self.collect_uses(&c.tree, stack, out);
            stack.pop();
        }
    }

    /// Everything an agent needs to choose or build a component.
    pub fn catalog(&self) -> Result<Value, String> {
        let p = primitives();
        let components: Vec<Value> = self
            .list()?
            .into_iter()
            .map(|c| json!({ "name": c.name, "version": c.version, "source": c.source, "description": c.description, "props": c.props, "uses": c.uses }))
            .collect();
        Ok(json!({ "primitives": p["primitives"], "syntax": p["syntax"], "sources": p["sources"], "components": components }))
    }

    /// Validate and store a component. Errors are written for the agent to fix.
    pub fn save(&self, req: SaveRequest) -> Result<Component, Vec<String>> {
        let mut errs = vec![];
        if !valid_name(&req.name) {
            errs.push("name must be kebab-case: lowercase letters, digits and -, starting with a letter, 2-48 chars".into());
        }
        if is_primitive(&req.name) {
            errs.push(format!("`{}` is a primitive; pick another name", req.name));
        }
        if req.description.trim().len() < 10 {
            errs.push("description must say what the component shows and when to use it".into());
        }
        if !req.props.is_object() || req.props.get("type").is_some_and(|t| t != "object") {
            errs.push("props must be a JSON Schema object: { type: \"object\", properties: {...}, required: [...] }".into());
        }
        let existing = self.get(&req.name).map_err(|e| vec![e])?;
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
        let stack = vec![req.name.clone()];
        let mut ctx = Ctx::default();
        validate(&req.tree, "tree", self, &mut ctx, 0, &mut errs);
        if errs.is_empty() {
            self.check_cycles(&req.tree, &stack, &mut errs);
        }
        for (i, ex) in req.examples.iter().enumerate() {
            check_props(&req.props, &ex.props, &format!("examples[{i}].props"), &mut errs);
        }
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
        };
        let target = self.sources.iter().find(|s| s.writable()).ok_or_else(|| vec!["no writable component source".to_owned()])?;
        target.save(&component).map_err(|e| vec![e])?;
        Ok(self.with_uses(Component { source: target.id().to_owned(), ..component }))
    }

    /// Validate a render request and expand library references.
    pub fn prepare(&self, component: Option<&str>, props: Value, tree: Option<Value>) -> Result<Prepared, Vec<String>> {
        let mut errs = vec![];
        let props = if props.is_null() { json!({}) } else { props };
        let (root, name, version) = match (component, tree) {
            (Some(name), None) => {
                let Some(c) = self.get(name).map_err(|e| vec![e])? else {
                    return Err(vec![format!("no component named `{name}`; call ui_catalog to see what exists")]);
                };
                check_props(&c.props, &props, "props", &mut errs);
                (json!({ "type": name, "props": props }), Some(name.to_owned()), Some(c.version))
            }
            (None, Some(tree)) => {
                validate(&tree, "tree", self, &mut Ctx::default(), 0, &mut errs);
                (tree, None, None)
            }
            _ => return Err(vec!["give either `component` (with `props`) or an ad-hoc `tree`, not both".into()]),
        };
        if !errs.is_empty() {
            return Err(errs);
        }
        let tree = self.expand(&root, &mut vec![], &mut errs);
        if !errs.is_empty() {
            return Err(errs);
        }
        Ok(Prepared { component: name, version, tree, props })
    }

    fn check_cycles(&self, node: &Value, stack: &[String], errs: &mut Vec<String>) {
        let mut stack = stack.to_vec();
        self.expand(node, &mut stack, errs);
    }

    /// Replace library references with `$component` nodes holding their tree.
    fn expand(&self, node: &Value, stack: &mut Vec<String>, errs: &mut Vec<String>) -> Value {
        let Some(obj) = node.as_object() else { return node.clone() };
        let mut out = obj.clone();
        for key in ["children", "else"] {
            if let Some(Value::Array(kids)) = obj.get(key) {
                out.insert(key.into(), Value::Array(kids.iter().map(|k| self.expand(k, stack, errs)).collect()));
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
        let Ok(Some(c)) = self.get(t) else {
            errs.push(format!("no component named `{t}`"));
            return Value::Null;
        };
        stack.push(t.to_owned());
        let inner = self.expand(&c.tree, stack, errs);
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

fn primitives() -> &'static Value {
    static P: OnceLock<Value> = OnceLock::new();
    P.get_or_init(|| serde_json::from_str(PRIMITIVES_JSON).expect("ui-primitives.json is valid JSON"))
}

fn primitive(name: &str) -> Option<&'static Map<String, Value>> {
    primitives()["primitives"].get(name)?.as_object()
}

fn is_primitive(name: &str) -> bool {
    primitive(name).is_some()
}

/// Errors past this many are dropped: enough for the agent to fix, not a flood.
const MAX_ERRORS: usize = 50;

fn validate(node: &Value, path: &str, lib: &Library, ctx: &mut Ctx, depth: usize, errs: &mut Vec<String>) {
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
            match lib.get(t) {
                Ok(Some(c)) => check_props(&c.props, &Value::Object(props.clone()), &format!("{path}.props"), errs),
                Ok(None) => errs.push(format!("{path}: unknown type `{t}`; use a primitive from ui_catalog or an existing component")),
                Err(e) => errs.push(e),
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
fn shown(v: &Value) -> String {
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
fn check_props(schema: &Value, props: &Value, path: &str, errs: &mut Vec<String>) {
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

fn valid_name(name: &str) -> bool {
    (2..=48).contains(&name.len())
        && name.starts_with(|c: char| c.is_ascii_lowercase())
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn now() -> u64 {
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
