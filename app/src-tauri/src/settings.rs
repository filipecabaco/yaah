//! App preferences in `~/.config/yaah/settings.json`: appearance here, workspace
//! folders in `repos.rs` (same file; each keeps the other's keys).
//!
//! Settings → General reads `general()` and writes through the setters.

use crate::accounts::home;
use crate::json_file::JsonFile;
use serde_json::{Map, Value, json};
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

// ── tool cards ───────────────────────────────────────────────────────────────
/// How a tool call's card opens in a chat: "auto" (open while it runs), "collapsed"
/// or "expanded". Keyed by the card's kind of tool: a name (`ToolSearch`, `Load skill`,
/// `mcp__fetch__fetch`) or a whole MCP server (`mcp__yaah-ui`).
pub const TOOL_CARD_MODES: &[&str] = &["auto", "collapsed", "expanded"];

/// Noisy ones start collapsed: their bodies are inputs nobody needs to read.
const TOOL_CARD_DEFAULTS: &[(&str, &str)] =
    &[("ToolSearch", "collapsed"), ("Load skill", "collapsed"), ("Skill", "collapsed"), ("TodoWrite", "collapsed"), ("mcp__yaah-ui", "collapsed")];

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

/// Where yaah keeps things, for the General tab ("Reveal" buttons).
fn data_dirs() -> Vec<Value> {
    let h = home();
    [
        ("Chats", ".yaah/sessions", "Transcripts, restored at start."),
        ("Quick-chat folders", ".yaah/scratch", "Scratch folders for chats without a project."),
        ("Project context", ".yaah/projects", "Each project's brief and context folder."),
        ("Component library", ".yaah/components", "Components agents built, with history. yaah's own ship with the app."),
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
        "toolCards": tool_cards_in(&s),
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
        assert!(set_tool_card(" ", Some("auto")).is_err() && set_tool_card("Bash", Some("sideways")).is_err());
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
