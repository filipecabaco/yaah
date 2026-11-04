//! App preferences in `~/.config/yaah/settings.json`: appearance here, workspace
//! folders in `repos.rs` (same file; each keeps the other's keys).
//!
//! Settings → General reads `general()` and writes through the setters.

use crate::accounts::home;
use crate::agent_versions::Version;
use crate::json_file::JsonFile;
use crate::layout::{self, Layout};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::OnceLock;

pub const APPEARANCES: &[&str] = &["system", "light", "dark"];
/// VS Code theme files are tens of KB; past this one isn't read.
const MAX_THEME_BYTES: u64 = 2 << 20;

/// `settings.json`, with the lock every writer of it should share (`repos.rs` too).
pub(crate) fn file() -> &'static JsonFile {
    static FILE: OnceLock<JsonFile> = OnceLock::new();
    FILE.get_or_init(|| JsonFile::new(home().join(".config/yaah/settings.json"), false))
}

fn load() -> Map<String, Value> {
    file().read()
}

fn set(key: &str, value: Value) -> Result<(), String> {
    file().update(|all: &mut Map<String, Value>| {
        all.insert(key.to_owned(), value);
        Ok(())
    })
}

fn appearance_in(s: &Map<String, Value>) -> String {
    s.get("appearance").and_then(Value::as_str).filter(|a| APPEARANCES.contains(a)).unwrap_or("system").to_owned()
}

pub fn appearance() -> String {
    appearance_in(&load())
}

pub fn set_appearance(a: &str) -> Result<(), String> {
    if !APPEARANCES.contains(&a) {
        return Err(format!("appearance is one of {APPEARANCES:?}"));
    }
    set("appearance", json!(a))
}

// ── agents ───────────────────────────────────────────────────────────────────
/// Whether chats teach their agent about yaah's UI (`agent_guide.rs`). On unless turned off.
fn teach_agents_in(s: &Map<String, Value>) -> bool {
    s.get("teachAgents").and_then(Value::as_bool).unwrap_or(true)
}

pub fn teach_agents() -> bool {
    teach_agents_in(&load())
}

pub fn set_teach_agents(on: bool) -> Result<(), String> {
    set("teachAgents", json!(on))
}

// ── permissions ──────────────────────────────────────────────────────────────
/// Whether yaah allows an agent's reads and searches inside the chat's folders
/// without asking (`session/permissions.rs`). On unless turned off.
fn trust_read_only_in(s: &Map<String, Value>) -> bool {
    s.get("trustReadOnly").and_then(Value::as_bool).unwrap_or(true)
}

pub fn trust_read_only() -> bool {
    trust_read_only_in(&load())
}

pub fn set_trust_read_only(on: bool) -> Result<(), String> {
    set("trustReadOnly", json!(on))
}

/// Whether a chat draws two or more tool calls in a row as one row that opens on a click. On unless turned off.
fn group_tool_calls_in(s: &Map<String, Value>) -> bool {
    s.get("groupToolCalls").and_then(Value::as_bool).unwrap_or(true)
}

pub fn set_group_tool_calls(on: bool) -> Result<(), String> {
    set("groupToolCalls", json!(on))
}

/// The versions the user holds npm-based agents at ("Hold at vX"): preset id →
/// exact version. A preset without one runs what `agent_versions::choose` picks.
fn agent_versions_in(s: &Map<String, Value>) -> BTreeMap<String, String> {
    let Some(Value::Object(held)) = s.get("agentVersions") else { return BTreeMap::new() };
    held.iter()
        .filter_map(|(k, v)| Some((k.clone(), v.as_str().filter(|v| Version::parse(v).is_some())?.to_owned())))
        .filter(|(k, _)| crate::agents::preset(k).is_some_and(|p| p.npx.is_some()))
        .collect()
}

pub fn agent_versions() -> BTreeMap<String, String> {
    agent_versions_in(&load())
}

/// Hold `preset` at `version`, or release it (`None`).
/// Tier B of the adapter conformance suite (`agent_conformance::live`): live
/// prompts with the user's account before a newer adapter version runs.
/// `liveAdapterTests` in `settings.json`, off by default. Prepared, not active:
/// it reads false until `live::ENABLED` is switched on, and nothing sets it yet
/// (Settings → Agents shows it as "coming soon").
pub fn live_adapter_tests() -> bool {
    crate::agent_conformance::live::ENABLED && load().get("liveAdapterTests").and_then(Value::as_bool).unwrap_or(false)
}

pub fn set_agent_version(preset: &str, version: Option<&str>) -> Result<(), String> {
    set_agent_version_in(file(), preset, version)
}

fn set_agent_version_in(file: &JsonFile, preset: &str, version: Option<&str>) -> Result<(), String> {
    let p = crate::agents::preset(preset).ok_or_else(|| format!("unknown agent preset {preset}"))?;
    if p.npx.is_none() {
        return Err(format!("{} isn't run from an npm package, so yaah doesn't choose its version", p.label));
    }
    if let Some(v) = version
        && Version::parse(v).is_none()
    {
        return Err(format!("`{v}` isn't an exact version such as 1.2.3"));
    }
    file.update(|all: &mut Map<String, Value>| {
        let held = all.entry("agentVersions").or_insert_with(|| json!({}));
        if !held.is_object() {
            *held = json!({});
        }
        if let Some(held) = held.as_object_mut() {
            match version {
                Some(v) => held.insert(preset.to_owned(), json!(v)),
                None => held.remove(preset),
            };
        }
        Ok(())
    })
}

// ── themes ───────────────────────────────────────────────────────────────────
/// VS Code colour themes the user dropped in (`*.json`, the file a theme extension
/// keeps in `themes/`). Only a file *name* crosses the API, never
/// a path, so nothing outside the folder can be read.
pub fn themes_dir() -> PathBuf {
    home().join(".config/yaah/themes")
}

#[allow(clippy::case_sensitive_file_extension_comparisons, reason = "theme files are `.json`, as VS Code writes them")]
fn valid_theme_name(name: &str) -> bool {
    name.ends_with(".json") && !name.starts_with('.') && !name.contains(['/', '\\', '\0']) && name.len() <= 200
}

/// Custom themes: file name, display name and declared type (light/dark, if any).
pub fn custom_themes() -> Vec<Value> {
    let Ok(entries) = std::fs::read_dir(themes_dir()) else { return vec![] };
    let mut out: Vec<Value> = entries
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| valid_theme_name(n))
        .filter_map(|n| {
            let t = read_theme(&n).ok()?;
            let label = t["displayName"].as_str().or(t["name"].as_str()).map_or_else(|| n.trim_end_matches(".json").to_owned(), str::to_owned);
            Some(json!({ "file": n, "label": label, "type": t["type"] }))
        })
        .collect();
    out.sort_by(|a, b| a["label"].as_str().cmp(&b["label"].as_str()));
    out
}

/// One custom theme, if it is a JSON object with a `colors` map (what the UI needs to skin itself).
pub fn read_theme(name: &str) -> Result<Value, String> {
    if !valid_theme_name(name) {
        return Err("not a theme file name".into());
    }
    let path = themes_dir().join(name);
    let size = std::fs::metadata(&path).map_err(|_| format!("no theme {name}"))?.len();
    if size > MAX_THEME_BYTES {
        return Err(format!("{name} is larger than {} MB: not a colour theme", MAX_THEME_BYTES >> 20));
    }
    let raw = std::fs::read_to_string(&path).map_err(|_| format!("no theme {name}"))?;
    // VS Code theme files are often JSONC: drop comments and trailing commas.
    let v: Value = serde_json::from_str(&strip_jsonc(&raw)).map_err(|e| format!("{name} isn't valid JSON: {e}"))?;
    if !v["colors"].is_object() {
        return Err(format!("{name} has no `colors`: not a VS Code colour theme"));
    }
    Ok(v)
}

/// Removes `//` and `/* */` comments (outside strings) and trailing commas.
fn strip_jsonc(s: &str) -> String {
    let (mut out, mut chars, mut in_str) = (String::with_capacity(s.len()), s.chars().peekable(), false);
    while let Some(c) = chars.next() {
        if in_str {
            out.push(c);
            if c == '\\' {
                if let Some(n) = chars.next() {
                    out.push(n);
                }
            } else if c == '"' {
                in_str = false;
            }
        } else if c == '"' {
            in_str = true;
            out.push(c);
        } else if c == '/' && chars.peek() == Some(&'/') {
            for n in chars.by_ref() {
                if n == '\n' {
                    out.push(n);
                    break;
                }
            }
        } else if c == '/' && chars.peek() == Some(&'*') {
            chars.next();
            let mut prev = ' ';
            for n in chars.by_ref() {
                if prev == '*' && n == '/' {
                    break;
                }
                prev = n;
            }
        } else {
            out.push(c);
        }
    }
    // Trailing commas before } or ].
    let mut cleaned = String::with_capacity(out.len());
    let bytes: Vec<char> = out.chars().collect();
    for (i, c) in bytes.iter().enumerate() {
        if *c == ',' && bytes[i + 1..].iter().find(|x| !x.is_whitespace()).is_some_and(|n| *n == '}' || *n == ']') {
            continue;
        }
        cleaned.push(*c);
    }
    cleaned
}

/// The theme for light mode and for dark mode: "yaah", "shiki:<name>" or "custom:<file>".
fn theme_in(s: &Map<String, Value>) -> Value {
    let t = s.get("theme").unwrap_or(&Value::Null);
    let id = |k: &str| t[k].as_str().filter(|s| valid_theme_id(s)).unwrap_or("yaah").to_owned();
    json!({ "light": id("light"), "dark": id("dark") })
}

pub fn theme() -> Value {
    theme_in(&load())
}

fn valid_theme_id(id: &str) -> bool {
    id == "yaah"
        || id.strip_prefix("shiki:").is_some_and(|n| !n.is_empty() && n.len() <= 100 && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
        || id.strip_prefix("custom:").is_some_and(valid_theme_name)
}

pub fn set_theme(light: &str, dark: &str) -> Result<(), String> {
    if !valid_theme_id(light) || !valid_theme_id(dark) {
        return Err("unknown theme".into());
    }
    set("theme", json!({ "light": light, "dark": dark }))
}

// ── fonts ────────────────────────────────────────────────────────────────────
/// Interface text size in px (the chat's body text; the root size scales with it, so all rem-based text,
/// spacing and icons follow). 14 is today's look.
pub const UI_SIZES: std::ops::RangeInclusive<u8> = 12..=20;
pub const UI_SIZE_DEFAULT: u8 = 14;
/// Code size in px (code blocks, diffs, terminals). Unset, it follows the interface size: 12 at 14.
pub const CODE_SIZES: std::ops::RangeInclusive<u8> = 10..=20;
pub const CODE_SIZE_DEFAULT: u8 = 12;

/// The fonts the user picked: a family per slot (`None` is the system default, today's look) and sizes.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fonts {
    pub ui: Option<String>,
    pub code: Option<String>,
    pub ui_size: Option<u8>,
    pub code_size: Option<u8>,
}

/// A number for CSS: at most four decimals, no trailing zeros.
fn css_number(n: f64) -> String {
    let s = format!("{n:.4}");
    s.trim_end_matches('0').trim_end_matches('.').to_owned()
}

/// What `settings.json` holds, each part checked: a family that isn't plain and installed, or a size
/// out of range, reads as the default.
fn fonts_in(s: &Map<String, Value>, valid: impl Fn(&str) -> bool) -> Fonts {
    let f = s.get("fonts").unwrap_or(&Value::Null);
    let family = |k: &str| f[k].as_str().filter(|n| valid(n)).map(str::to_owned);
    let size = |k: &str, range: &std::ops::RangeInclusive<u8>| f[k].as_u64().and_then(|n| u8::try_from(n).ok()).filter(|n| range.contains(n));
    Fonts { ui: family("ui"), code: family("code"), ui_size: size("uiSize", &UI_SIZES), code_size: size("codeSize", &CODE_SIZES) }
}

/// The fonts for the UI: the choice, the ranges, and the CSS variables to set on the root
/// (`null` leaves index.css's default). Every value here is built by Rust: a family is quoted and
/// escaped (`fonts::css_value`), sizes are numbers.
fn fonts_for_ui(f: &Fonts) -> Value {
    let ui_scale = f.ui_size.map(|n| f64::from(n) / f64::from(UI_SIZE_DEFAULT));
    let code_scale = f.code_size.map(|n| f64::from(n) / f64::from(CODE_SIZE_DEFAULT));
    json!({
        "ui": f.ui,
        "code": f.code,
        "uiSize": f.ui_size,
        "codeSize": f.code_size,
        "limits": {
            "uiSize": { "min": UI_SIZES.start(), "max": UI_SIZES.end(), "default": UI_SIZE_DEFAULT },
            "codeSize": { "min": CODE_SIZES.start(), "max": CODE_SIZES.end(), "default": CODE_SIZE_DEFAULT },
        },
        "css": {
            "--font-ui": f.ui.as_deref().map(|n| crate::fonts::css_value(crate::fonts::Slot::Ui, n)),
            "--font-code": f.code.as_deref().map(|n| crate::fonts::css_value(crate::fonts::Slot::Code, n)),
            "--font-ui-scale": ui_scale.map(css_number),
            "--font-code-scale": code_scale.map(css_number),
        },
    })
}

pub fn fonts() -> Value {
    fonts_for_ui(&fonts_in(&load(), crate::fonts::valid_family))
}

/// Save the whole choice; a family that isn't installed or a size out of range is refused.
pub fn set_fonts(f: &Fonts) -> Result<Value, String> {
    set_fonts_in(file(), f, crate::fonts::valid_family)
}

fn set_fonts_in(file: &JsonFile, f: &Fonts, valid: impl Fn(&str) -> bool) -> Result<Value, String> {
    for name in [&f.ui, &f.code].into_iter().flatten() {
        if !valid(name) {
            return Err(format!("{name:?} isn't a font installed on this machine"));
        }
    }
    if f.ui_size.is_some_and(|n| !UI_SIZES.contains(&n)) {
        return Err(format!("the interface size is {} to {} px", UI_SIZES.start(), UI_SIZES.end()));
    }
    if f.code_size.is_some_and(|n| !CODE_SIZES.contains(&n)) {
        return Err(format!("the code size is {} to {} px", CODE_SIZES.start(), CODE_SIZES.end()));
    }
    let saved = json!({ "ui": f.ui, "code": f.code, "uiSize": f.ui_size, "codeSize": f.code_size });
    file.update(|all: &mut Map<String, Value>| {
        all.insert("fonts".into(), saved);
        Ok(())
    })?;
    Ok(fonts_for_ui(&fonts_in(&file.read(), valid)))
}

/// ⌘= / ⌘- / ⌘0: everything a size bigger (`1`), smaller (`-1`), or the default size (`0`).
/// The interface size moves a px at a time within its range; a code size of its own (sizes not
/// linked) moves with it, and a linked one follows by itself. The families stay.
pub fn step_font_size(step: i8) -> Result<Value, String> {
    step_font_size_in(file(), step, crate::fonts::valid_family)
}

fn step_font_size_in(file: &JsonFile, step: i8, valid: impl Fn(&str) -> bool) -> Result<Value, String> {
    let f = fonts_in(&file.read(), &valid);
    let moved = |n: u8, range: &std::ops::RangeInclusive<u8>| n.saturating_add_signed(step.signum()).clamp(*range.start(), *range.end());
    let (ui_size, code_size) = if step == 0 {
        (None, f.code_size.map(|_| CODE_SIZE_DEFAULT))
    } else {
        let ui = moved(f.ui_size.unwrap_or(UI_SIZE_DEFAULT), &UI_SIZES);
        (Some(ui).filter(|&n| n != UI_SIZE_DEFAULT), f.code_size.map(|n| moved(n, &CODE_SIZES)))
    };
    set_fonts_in(file, &Fonts { ui_size, code_size, ..f }, valid)
}

// ── tool cards ───────────────────────────────────────────────────────────────
/// How a tool call's card opens in a chat: "auto" (open while it runs), "collapsed"
/// or "expanded". Keyed by the card's kind of tool: a name (`ToolSearch`, `Load skill`,
/// `mcp__fetch__fetch`) or a whole MCP server (`mcp__yaah-ui`).
pub const TOOL_CARD_MODES: &[&str] = &["auto", "collapsed", "expanded"];

/// Noisy ones start collapsed: their bodies are inputs (or pages, search hits, command
/// output) nobody needs to read in the flow of a chat. Keys are what the cards'
/// `cardKey` (src/lib/tool-cards.ts) makes of a tool call:
/// - `mcp__fetch`: every tool of the fetch MCP server (`mcp__fetch__fetch`);
/// - `kind:fetch`: Claude's `WebFetch` (`Fetch https://…`) and `WebSearch` (`Search "…"`);
///   `Fetch`, `WebFetch` and `WebSearch` are the same calls before their input arrives;
/// - `kind:execute`: shell commands (Claude's Bash, titled by the command itself).
const TOOL_CARD_DEFAULTS: &[(&str, &str)] = &[
    ("ToolSearch", "collapsed"),
    ("Load skill", "collapsed"),
    ("Skill", "collapsed"),
    ("TodoWrite", "collapsed"),
    ("mcp__yaah-ui", "collapsed"),
    ("mcp__fetch", "collapsed"),
    ("kind:fetch", "collapsed"),
    ("Fetch", "collapsed"),
    ("WebFetch", "collapsed"),
    ("WebSearch", "collapsed"),
    ("kind:execute", "collapsed"),
];

/// Every rule in effect: the defaults, then the user's own on top.
fn tool_cards_in(s: &Map<String, Value>) -> Value {
    let mut all: Map<String, Value> = TOOL_CARD_DEFAULTS.iter().map(|(k, m)| ((*k).to_owned(), json!(m))).collect();
    if let Some(Value::Object(mine)) = s.get("toolCards") {
        all.extend(mine.iter().filter(|(_, v)| v.as_str().is_some_and(|m| TOOL_CARD_MODES.contains(&m))).map(|(k, v)| (k.clone(), v.clone())));
    }
    json!({ "rules": all, "defaults": TOOL_CARD_DEFAULTS.iter().map(|(k, m)| json!({ "key": k, "mode": m })).collect::<Vec<_>>() })
}

pub fn tool_cards() -> Value {
    tool_cards_in(&load())
}

/// Set how cards of one kind open; `None` goes back to the default.
pub fn set_tool_card(key: &str, mode: Option<&str>) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() || key.len() > 200 {
        return Err("name the kind of tool".into());
    }
    if let Some(m) = mode
        && !TOOL_CARD_MODES.contains(&m)
    {
        return Err(format!("a card is one of {TOOL_CARD_MODES:?}"));
    }
    // One read-modify-write, so two quick changes can't undo each other.
    file().update(|all: &mut Map<String, Value>| {
        let cards = all.entry("toolCards").or_insert_with(|| json!({}));
        if !cards.is_object() {
            *cards = json!({});
        }
        if let Some(mine) = cards.as_object_mut() {
            match mode {
                Some(m) => mine.insert(key.to_owned(), json!(m)),
                None => mine.remove(key),
            };
        }
        Ok(())
    })
}

// ── terminals ────────────────────────────────────────────────────────────────
/// The app "Open in terminal" uses (`terminal_apps.rs`): "system" or one found.
fn terminal_app_in(s: &Map<String, Value>) -> String {
    s.get("terminalApp").and_then(Value::as_str).filter(|a| !a.is_empty() && a.len() <= 64).unwrap_or(crate::terminal_apps::SYSTEM).to_owned()
}

pub fn terminal_app() -> String {
    terminal_app_in(&load())
}

pub fn set_terminal_app(id: &str) -> Result<(), String> {
    if !crate::terminal_apps::detected().iter().any(|a| a.id == id) {
        return Err(format!("{id} isn't a terminal app yaah found"));
    }
    set("terminalApp", json!(id))
}

/// Where a new terminal pane opens when nothing says where: the last folder one
/// opened in, while it's still a folder, else the home folder.
pub fn terminal_dir() -> PathBuf {
    terminal_dir_in(&load())
}

fn terminal_dir_in(s: &Map<String, Value>) -> PathBuf {
    s.get("lastTerminalDir").and_then(Value::as_str).and_then(|d| crate::terminals::checked_dir(d).ok()).unwrap_or_else(home)
}

pub fn set_terminal_dir(dir: &std::path::Path) -> Result<(), String> {
    set("lastTerminalDir", json!(dir.to_string_lossy()))
}

// ── window layout ────────────────────────────────────────────────────────────
/// The split panes and the sidebar as last left (`layout.rs`), panes on chats or
/// projects that are gone already dropped: `{ panes, sidebar }`.
pub fn window_layout(chat_exists: impl Fn(&str) -> bool, project_exists: impl Fn(&str) -> bool) -> Value {
    window_layout_in(&load(), chat_exists, project_exists)
}

fn window_layout_in(s: &Map<String, Value>, chat_exists: impl Fn(&str) -> bool, project_exists: impl Fn(&str) -> bool) -> Value {
    layout::for_ui(layout::from_saved(s.get("layout")), layout::Sidebar::from_saved(s.get("sidebar")), chat_exists, project_exists)
}

pub fn set_layout(l: Layout) -> Result<(), String> {
    set_layout_in(file(), l)
}

fn set_layout_in(file: &JsonFile, l: Layout) -> Result<(), String> {
    let l = serde_json::to_value(l.checked()?).map_err(|e| e.to_string())?;
    file.update(|all: &mut Map<String, Value>| {
        all.insert("layout".into(), l);
        Ok(())
    })
}

pub fn set_sidebar(collapsed: bool, width: u32) -> Result<(), String> {
    set_sidebar_in(file(), collapsed, width)
}

fn set_sidebar_in(file: &JsonFile, collapsed: bool, width: u32) -> Result<(), String> {
    let s = serde_json::to_value(layout::Sidebar::new(collapsed, width)).map_err(|e| e.to_string())?;
    file.update(|all: &mut Map<String, Value>| {
        all.insert("sidebar".into(), s);
        Ok(())
    })
}

/// Where yaah keeps things, for the General tab ("Reveal" buttons).
fn data_dirs() -> Vec<Value> {
    let h = home();
    [
        ("Chats", ".yaah/sessions", "Transcripts, restored at start."),
        ("Quick-chat folders", ".yaah/scratch", "Scratch folders for chats without a project."),
        ("Project context", ".yaah/projects", "Each project's brief and context folder."),
        ("Component library", ".yaah/components", "Components agents built, with history. yaah's own ship with the app."),
        ("Agents installed by yaah", ".yaah/agents", "npm-based agents, one folder per version, run directly with Node."),
        ("Settings", ".config/yaah", "Agents, integrations, MCP servers, connections and these settings (secrets in 0600 files)."),
        ("Themes", ".config/yaah/themes", "Drop any VS Code colour theme (.json) here and pick it under Appearance."),
    ]
    .iter()
    .map(|(label, rel, about)| {
        let p = h.join(rel);
        json!({ "label": label, "path": p.to_string_lossy(), "about": about, "exists": p.exists() })
    })
    .collect()
}

pub fn general() -> Value {
    let s = load();
    json!({
        "appearance": appearance_in(&s),
        "theme": theme_in(&s),
        "fonts": fonts_for_ui(&fonts_in(&s, crate::fonts::valid_family)),
        "toolCards": tool_cards_in(&s),
        "teachAgents": teach_agents_in(&s),
        "trustReadOnly": trust_read_only_in(&s),
        "groupToolCalls": group_tool_calls_in(&s),
        "terminalApp": terminal_app_in(&s),
        "terminalApps": crate::terminal_apps::detected(),
        "customThemes": custom_themes(),
        "workspaceRoots": crate::repos::roots(),
        "dataDirs": data_dirs(),
        "version": env!("CARGO_PKG_VERSION"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_vs_code_theme_jsonc() {
        let raw = r##"{
            // a comment, as VS Code themes have
            "name": "Night // not a comment",
            "type": "dark", /* block */
            "colors": { "editor.background": "#011627", },
        }"##;
        let v: Value = serde_json::from_str(&strip_jsonc(raw)).unwrap();
        assert_eq!(v["name"], "Night // not a comment");
        assert_eq!(v["colors"]["editor.background"], "#011627");
    }

    #[test]
    fn theme_names_stay_in_the_folder() {
        for bad in ["../settings.json", "x/../../y.json", ".hidden.json", "theme.js", "/etc/passwd.json"] {
            assert!(read_theme(bad).is_err(), "{bad}");
        }
        assert!(valid_theme_id("yaah") && valid_theme_id("shiki:github-dark") && valid_theme_id("custom:night-owl.json"));
        assert!(!valid_theme_id("shiki:../x") && !valid_theme_id("custom:../x.json") && !valid_theme_id("vscode:x"));
        assert!(set_theme("shiki:../x", "yaah").is_err());
    }

    #[test]
    fn trusting_reads_is_on_unless_turned_off() {
        assert!(trust_read_only_in(&Map::new()), "on by default");
        let off: Map<String, Value> = serde_json::from_value(json!({ "trustReadOnly": false })).unwrap();
        assert!(!trust_read_only_in(&off));
        let odd: Map<String, Value> = serde_json::from_value(json!({ "trustReadOnly": "no" })).unwrap();
        assert!(trust_read_only_in(&odd), "a value that isn't a bool is the default");
        assert!(group_tool_calls_in(&Map::new()), "grouping tool calls is on by default");
        let off: Map<String, Value> = serde_json::from_value(json!({ "groupToolCalls": false })).unwrap();
        assert!(!group_tool_calls_in(&off));
    }

    #[test]
    fn appearance_is_checked() {
        assert!(set_appearance("sepia").is_err());
        assert!(APPEARANCES.contains(&appearance().as_str()));
    }

    #[test]
    fn saved_values_are_checked_when_read() {
        let s: Map<String, Value> = serde_json::from_value(json!({
            "appearance": "neon",
            "theme": { "light": "custom:../../etc/passwd.json", "dark": "shiki:night-owl" },
            "toolCards": { "Bash": "expanded", "Read": "sideways", "ToolSearch": "auto" }
        }))
        .unwrap();
        assert_eq!(appearance_in(&s), "system", "an unknown appearance falls back");
        assert_eq!(theme_in(&s), json!({ "light": "yaah", "dark": "shiki:night-owl" }), "a path never comes back as a theme");
        let rules = &tool_cards_in(&s)["rules"];
        assert_eq!((rules["Bash"].as_str(), rules["ToolSearch"].as_str()), (Some("expanded"), Some("auto")), "the user's own win over the defaults");
        assert!(rules.get("Read").is_none(), "unknown modes are ignored");
        assert_eq!(theme_in(&Map::new()), json!({ "light": "yaah", "dark": "yaah" }));
        assert!(teach_agents_in(&Map::new()), "agents are taught about yaah's UI unless turned off");
        assert!(!teach_agents_in(&serde_json::from_value(json!({ "teachAgents": false })).unwrap()));
        assert!(teach_agents_in(&serde_json::from_value(json!({ "teachAgents": "no" })).unwrap()), "only a real false turns it off");
        assert!(set_tool_card(" ", Some("auto")).is_err() && set_tool_card("Bash", Some("sideways")).is_err());
    }

    #[test]
    fn web_fetches_searches_and_commands_start_collapsed_unless_the_user_says_otherwise() {
        let rules = &tool_cards_in(&Map::new())["rules"];
        for key in ["mcp__fetch", "kind:fetch", "Fetch", "WebFetch", "WebSearch", "kind:execute", "ToolSearch", "mcp__yaah-ui"] {
            assert_eq!(rules[key], "collapsed", "{key}");
        }
        let defaults = tool_cards_in(&Map::new())["defaults"].as_array().unwrap().len();
        assert_eq!(defaults, TOOL_CARD_DEFAULTS.len(), "every default is listed for Settings");

        let mine: Map<String, Value> =
            serde_json::from_value(json!({ "toolCards": { "kind:execute": "expanded", "mcp__fetch": "auto", "kind:fetch": "bogus" } })).unwrap();
        let rules = &tool_cards_in(&mine)["rules"];
        assert_eq!(rules["kind:execute"], "expanded", "the user's rule wins");
        assert_eq!(rules["mcp__fetch"], "auto");
        assert_eq!(rules["kind:fetch"], "collapsed", "an invalid rule leaves the default");
    }

    #[test]
    fn agent_version_holds_round_trip_and_refuse_anything_but_a_version() {
        let dir = std::env::temp_dir().join(format!("yaah-settings-{}", crate::random::token()));
        let file = JsonFile::new(dir.join("settings.json"), false);
        file.update(|m: &mut Map<String, Value>| Ok(m.insert("appearance".into(), json!("dark")))).unwrap();
        set_agent_version_in(&file, "claude", Some("0.100.0")).unwrap();
        set_agent_version_in(&file, "gemini", Some("1.0.0-rc.1")).unwrap();
        let held = agent_versions_in(&file.read());
        assert_eq!(held, BTreeMap::from([("claude".into(), "0.100.0".into()), ("gemini".into(), "1.0.0-rc.1".into())]));
        set_agent_version_in(&file, "claude", None).unwrap();
        assert_eq!(agent_versions_in(&file.read()).keys().collect::<Vec<_>>(), ["gemini"], "released");
        assert_eq!(file.read::<Map<String, Value>>()["appearance"], "dark", "other settings stay");

        for bad in ["latest", "^1.0.0", "1.0", "v1.0.0", "file:../x", "1.0.0 || 2.0.0", "", "git+https://x"] {
            assert!(set_agent_version_in(&file, "claude", Some(bad)).is_err(), "{bad:?}");
        }
        assert!(set_agent_version_in(&file, "goose", Some("1.0.0")).is_err(), "not an npm preset");
        assert!(set_agent_version_in(&file, "nope", Some("1.0.0")).is_err());
        // Whatever the file holds, only valid versions of npm presets come back.
        let s: Map<String, Value> =
            serde_json::from_value(json!({ "agentVersions": { "claude": "latest", "goose": "1.0.0", "codex": "2.6.0", "gemini": 3 } })).unwrap();
        assert_eq!(agent_versions_in(&s), BTreeMap::from([("codex".into(), "2.6.0".into())]));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_layout_and_sidebar_persist_beside_other_settings_and_come_back_pruned() {
        let dir = std::env::temp_dir().join(format!("yaah-layout-{}", crate::random::token()));
        let file = JsonFile::new(dir.join("settings.json"), false);
        file.update(|m: &mut Map<String, Value>| Ok(m.insert("appearance".into(), json!("dark")))).unwrap();
        assert_eq!(window_layout_in(&file.read(), |_| true, |_| true), json!({ "panes": null, "sidebar": { "collapsed": false, "width": 288 } }));

        let saved: Layout = serde_json::from_value(json!({
            "root": {
                "type": "split", "id": "s1", "dir": "row", "ratio": 0.3,
                "a": { "type": "pane", "id": "p1", "content": { "kind": "chat", "id": "kept" } },
                "b": { "type": "pane", "id": "p2", "content": { "kind": "chat", "id": "deleted" } },
            },
            "focused": "p2",
        }))
        .unwrap();
        set_layout_in(&file, saved).unwrap();
        set_sidebar_in(&file, true, 9999).unwrap();
        let all: Map<String, Value> = file.read();
        assert_eq!(all["appearance"], "dark", "other settings stay");
        assert_eq!(all["sidebar"], json!({ "collapsed": true, "width": 480 }), "the width is kept within bounds");
        assert_eq!(all["layout"]["root"]["b"]["content"]["id"], "deleted", "saved whole; pruning happens when read");

        // A restart after "deleted" was deleted: its pane is gone and the focus moved.
        let back = window_layout_in(&all, |id| id == "kept", |_| true);
        assert_eq!(back["panes"], json!({ "root": { "type": "pane", "id": "p1", "content": { "kind": "chat", "id": "kept" } }, "focused": "p1" }));
        assert_eq!(back["sidebar"]["collapsed"], true);

        // What the UI couldn't have made is refused and the saved layout stays.
        let dup: Layout = serde_json::from_value(json!({
            "root": { "type": "split", "id": "s1", "dir": "row", "ratio": 0.5,
                "a": { "type": "pane", "id": "p1", "content": null }, "b": { "type": "pane", "id": "p1", "content": null } },
            "focused": "p1",
        }))
        .unwrap();
        assert!(set_layout_in(&file, dup).is_err());
        assert_eq!(file.read::<Map<String, Value>>()["layout"]["root"]["a"]["id"], "p1");
        assert_eq!(file.read::<Map<String, Value>>()["layout"]["root"]["type"], "split");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn fonts_default_to_the_system_look_and_round_trip() {
        let installed = |n: &str| crate::fonts::plain_name(n) && ["Georgia", "Menlo"].contains(&n);
        let dir = std::env::temp_dir().join(format!("yaah-fonts-{}", crate::random::token()));
        let file = JsonFile::new(dir.join("settings.json"), false);
        file.update(|m: &mut Map<String, Value>| Ok(m.insert("appearance".into(), json!("dark")))).unwrap();

        let none = fonts_for_ui(&fonts_in(&file.read(), installed));
        assert_eq!(
            (none["ui"].clone(), none["code"].clone(), none["uiSize"].clone(), none["codeSize"].clone()),
            (Value::Null, Value::Null, Value::Null, Value::Null)
        );
        assert!(none["css"].as_object().unwrap().values().all(Value::is_null), "the default sets no CSS: index.css's look stays");
        assert_eq!(none["limits"]["uiSize"], json!({ "min": 12, "max": 20, "default": 14 }));

        let chosen = Fonts { ui: Some("Georgia".into()), code: Some("Menlo".into()), ui_size: Some(16), code_size: Some(15) };
        let back = set_fonts_in(&file, &chosen, installed).unwrap();
        assert_eq!(fonts_in(&file.read(), installed), chosen, "round-trips");
        assert_eq!(back["css"]["--font-ui"], r#""Georgia", "Geist Variable", system-ui, sans-serif"#);
        assert!(back["css"]["--font-code"].as_str().unwrap().starts_with(r#""Menlo", "#));
        assert_eq!(back["css"]["--font-ui-scale"], "1.1429");
        assert_eq!(back["css"]["--font-code-scale"], "1.25");
        assert_eq!(file.read::<Map<String, Value>>()["appearance"], "dark", "other settings stay");

        // Reset: back to the defaults.
        set_fonts_in(&file, &Fonts::default(), installed).unwrap();
        assert_eq!(fonts_in(&file.read(), installed), Fonts::default());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn fonts_are_checked_when_saved_and_when_read() {
        let installed = |n: &str| crate::fonts::plain_name(n) && ["Georgia", "Menlo"].contains(&n);
        let dir = std::env::temp_dir().join(format!("yaah-fonts-{}", crate::random::token()));
        let file = JsonFile::new(dir.join("settings.json"), false);
        let injection = r#"Georgia", sans-serif; } body { display: none } :root { --x: ""#;
        for bad in [
            Fonts { ui: Some("Comic Sans Nowhere".into()), ..Fonts::default() },
            Fonts { code: Some(injection.into()), ..Fonts::default() },
            Fonts { ui_size: Some(11), ..Fonts::default() },
            Fonts { ui_size: Some(21), ..Fonts::default() },
            Fonts { code_size: Some(9), ..Fonts::default() },
            Fonts { code_size: Some(255), ..Fonts::default() },
        ] {
            assert!(set_fonts_in(&file, &bad, installed).is_err(), "{bad:?}");
        }
        assert!(file.read::<Map<String, Value>>().get("fonts").is_none(), "nothing refused was written");
        for edge in [12, 20] {
            assert!(set_fonts_in(&file, &Fonts { ui_size: Some(edge), ..Fonts::default() }, installed).is_ok());
        }

        // A crafted settings.json: every odd value reads as the default, and no CSS comes of it.
        let s: Map<String, Value> = serde_json::from_value(json!({
            "fonts": { "ui": injection, "code": "Uninstalled Mono", "uiSize": 99, "codeSize": "13" }
        }))
        .unwrap();
        assert_eq!(fonts_in(&s, installed), Fonts::default());
        let css = &fonts_for_ui(&fonts_in(&s, installed))["css"];
        assert!(css.as_object().unwrap().values().all(Value::is_null), "{css}");
        let s: Map<String, Value> = serde_json::from_value(json!({ "fonts": "Georgia" })).unwrap();
        assert_eq!(fonts_in(&s, installed), Fonts::default(), "not an object");
        let s: Map<String, Value> = serde_json::from_value(json!({ "fonts": { "ui": "Georgia", "uiSize": 12.5 } })).unwrap();
        assert_eq!(fonts_in(&s, installed), Fonts { ui: Some("Georgia".into()), ..Fonts::default() }, "sizes are whole px");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn font_size_steps_within_range_and_keeps_the_link() {
        let installed = |n: &str| crate::fonts::plain_name(n) && n == "Georgia";
        let dir = std::env::temp_dir().join(format!("yaah-fonts-{}", crate::random::token()));
        let file = JsonFile::new(dir.join("settings.json"), false);
        let saved = || fonts_in(&file.read(), installed);

        // Linked (no code size of its own): only the interface size moves; code follows it in CSS.
        step_font_size_in(&file, 1, installed).unwrap();
        assert_eq!(saved(), Fonts { ui_size: Some(15), ..Fonts::default() });
        step_font_size_in(&file, -1, installed).unwrap();
        assert_eq!(saved(), Fonts::default(), "back at 14 is the default, not a stored 14");
        for _ in 0..10 {
            step_font_size_in(&file, -1, installed).unwrap();
        }
        assert_eq!(saved().ui_size, Some(12), "stops at the smallest");
        for _ in 0..20 {
            step_font_size_in(&file, 1, installed).unwrap();
        }
        assert_eq!(saved().ui_size, Some(20), "stops at the largest");

        // Not linked: the code size moves with it, each within its own range; the families stay.
        set_fonts_in(&file, &Fonts { ui: Some("Georgia".into()), ui_size: Some(19), code_size: Some(11), ..Fonts::default() }, installed).unwrap();
        step_font_size_in(&file, 1, installed).unwrap();
        step_font_size_in(&file, 1, installed).unwrap();
        assert_eq!(saved(), Fonts { ui: Some("Georgia".into()), ui_size: Some(20), code_size: Some(13), ..Fonts::default() });

        // ⌘0: default sizes, still not linked, font kept.
        let back = step_font_size_in(&file, 0, installed).unwrap();
        assert_eq!(saved(), Fonts { ui: Some("Georgia".into()), code_size: Some(CODE_SIZE_DEFAULT), ..Fonts::default() });
        assert_eq!(back["css"]["--font-ui-scale"], Value::Null);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn jsonc_keeps_strings_intact() {
        let raw = r#"{ "a": "say \"hi\" // still a string", "list": [1, 2, ], /* x */ "b": "/* not a comment */" }"#;
        let v: Value = serde_json::from_str(&strip_jsonc(raw)).unwrap();
        assert_eq!(v["a"], "say \"hi\" // still a string");
        assert_eq!(v["list"], json!([1, 2]));
        assert_eq!(v["b"], "/* not a comment */");
        for bad in ["a\0.json", "a\\b.json", &format!("{}.json", "x".repeat(200))] {
            assert!(!valid_theme_name(bad), "{bad:?}");
        }
    }
}
