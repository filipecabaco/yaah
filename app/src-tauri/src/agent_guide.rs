//! What agents are told about yaah's UI, and how it reaches each of them.
//!
//! Agents running in yaah can answer with interface (the `yaah-ui` MCP server,
//! `ui_mcp.rs`), but they don't know it unless told: tools may be deferred, and
//! an agent's habit is to `open` files or write standalone HTML. So yaah
//! teaches them, with text it owns (reviewable as Markdown in `agent-guide/`):
//!
//! - **the guide** (`guide.md`): about 550 tokens on when and how to use the UI,
//!   ending with an index of the components available now;
//! - **two skills** in the open Agent Skills format (`SKILL.md` with `name` and
//!   `description` frontmatter): `yaah-ui` (patterns, errors, a primitive index)
//!   and `yaah-components` (saving reusable components). yaah writes them to
//!   `~/.yaah/agent-skills/<name>/SKILL.md`, never into an agent's own config.
//!
//! Every agent with yaah's UI tools gets them through routes that work for any
//! ACP agent ([`plan`]): the MCP server (its instructions, the `ui_guide` tool,
//! the skills as resources and prompts), then the ACP `systemPrompt` when the
//! agent advertises it, else the guide once at the top of the chat's first
//! prompt. Agent-specific extras sit on top, chosen from the agent's kind
//! ([`extras`]): for Claude Code, a local plugin wrapping the same skills.

use crate::agents::{self, Profile};
use crate::ui_library::Library;
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use tauri::State;

const GUIDE: &str = include_str!("../agent-guide/guide.md");

/// One of yaah's skills: its name (also its folder) and its template.
pub struct Skill {
    pub name: &'static str,
    /// What `ui_guide { topic }` calls it.
    pub topic: &'static str,
    template: &'static str,
}

pub const SKILLS: &[Skill] = &[
    Skill { name: "yaah-ui", topic: "ui", template: include_str!("../agent-guide/yaah-ui.md") },
    Skill { name: "yaah-components", topic: "components", template: include_str!("../agent-guide/yaah-components.md") },
];

/// How many component names the guide lists before pointing at `ui_catalog`.
pub const INDEX_CAP: usize = 40;
/// The name the guide goes by when it is attached to a first prompt.
pub const ATTACHMENT: &str = "yaah UI guide";

// ── Text ─────────────────────────────────────────────────────────────────────

/// Component names, yaah's own first, then the user's, then installed libraries'.
pub fn component_names(library: &Library) -> Vec<String> {
    library.component_names().as_ref().clone()
}

/// The names on one line, at most [`INDEX_CAP`] of them.
pub fn component_index(names: &[String]) -> String {
    if names.is_empty() {
        return "none yet (see ui_catalog).".into();
    }
    let shown = names.iter().take(INDEX_CAP).map(String::as_str).collect::<Vec<_>>().join(", ");
    match names.len().checked_sub(INDEX_CAP).filter(|n| *n > 0) {
        Some(more) => format!("{shown} (+{more} more, see ui_catalog)."),
        None => format!("{shown}."),
    }
}

/// The short guide, as the system prompt or first prompt carries it.
pub fn guide_text(names: &[String]) -> String {
    GUIDE.replace("{{components}}", &component_index(names))
}

/// One line per primitive: its props (`*` required) and the first sentence of what it is.
fn primitive_index() -> &'static str {
    static INDEX: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    INDEX.get_or_init(build_primitive_index)
}

fn build_primitive_index() -> String {
    let Some(all) = crate::ui_library::primitives()["primitives"].as_object() else { return String::new() };
    all.iter()
        .map(|(name, p)| {
            let props: Vec<String> =
                p["props"].as_object().into_iter().flatten().map(|(k, v)| if v["required"] == true { format!("{k}*") } else { k.clone() }).collect();
            let about = p["description"].as_str().unwrap_or_default();
            let first = about.split_inclusive(". ").next().unwrap_or(about).trim();
            format!("- `{name}` ({}): {first}", props.join(", "))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// A skill's `SKILL.md`, filled in.
pub fn skill_text(skill: &Skill, names: &[String]) -> String {
    skill.template.replace("{{tools}}", &tool_names()).replace("{{primitives}}", primitive_index()).replace("{{components}}", &component_index(names))
}

/// [`skill_text`] for the library's current names, kept while they don't change
/// (`ui_guide`, the skills as MCP resources and prompts).
pub fn skill_text_cached(skill: &'static Skill, names: &Arc<Vec<String>>) -> Arc<String> {
    type Texts = std::collections::HashMap<&'static str, TextFor>;
    static TEXTS: std::sync::LazyLock<Mutex<Texts>> = std::sync::LazyLock::new(Mutex::default);
    let mut texts = TEXTS.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some((for_names, text)) = texts.get(skill.name)
        && (Arc::ptr_eq(for_names, names) || for_names == names)
    {
        return text.clone();
    }
    let text = Arc::new(skill_text(skill, names));
    texts.insert(skill.name, (names.clone(), text.clone()));
    text
}

/// Every yaah-ui tool by the name agents see: `mcp__yaah-ui__<tool>` where MCP
/// tools are prefixed by server (Claude Code), the bare name where they aren't.
pub fn tool_names() -> String {
    crate::ui_mcp::TOOL_NAMES.iter().map(|t| format!("- `{}` (bare: `{t}`)", crate::ui_mcp::full_tool_name(t))).collect::<Vec<_>>().join("\n")
}

/// The skill for a `ui_guide` topic or a name (`ui`, `yaah-ui`, …); `None` if there is none.
pub fn skill(topic: &str) -> Option<&'static Skill> {
    SKILLS.iter().find(|s| s.topic == topic || s.name == topic)
}

/// What a skill's frontmatter says it is for.
pub fn skill_description(skill: &Skill) -> &'static str {
    skill.template.lines().find_map(|l| l.strip_prefix("description: ")).unwrap_or_default()
}

/// The canonical skill set: `<name>/SKILL.md` for each skill.
pub fn skill_files(names: &[String]) -> Vec<(String, String)> {
    SKILLS.iter().map(|s| (format!("{}/SKILL.md", s.name), skill_text(s, names))).collect()
}

/// The same skills wrapped as a Claude Code plugin: a manifest and `skills/<name>/SKILL.md`.
pub fn plugin_files(names: &[String]) -> Vec<(String, String)> {
    let manifest = json!({
        "name": "yaah",
        "description": "How to answer with interface in yaah's chat. Written by yaah for its chats; regenerated, don't edit.",
        "version": env!("CARGO_PKG_VERSION"),
        "author": { "name": "yaah" },
    });
    let mut files = vec![(".claude-plugin/plugin.json".to_owned(), format!("{manifest:#}\n"))];
    files.extend(skill_files(names).into_iter().map(|(path, text)| (format!("skills/{path}"), text)));
    files
}

/// Write `files` under `root`, each only if its contents changed (a crash
/// leaves the old file or the new one). Returns how many were written.
pub fn write_if_changed(root: &Path, files: &[(String, String)]) -> std::io::Result<usize> {
    let mut written = 0;
    for (rel, text) in files {
        let path = root.join(rel);
        if std::fs::read(&path).is_ok_and(|old| old == text.as_bytes()) {
            continue;
        }
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, text)?;
        std::fs::rename(&tmp, &path)?;
        written += 1;
    }
    Ok(written)
}

// ── Routes ───────────────────────────────────────────────────────────────────

/// A way the guide reaches an agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Route {
    /// The `yaah-ui` server's instructions, the `ui_guide` tool, the skills as
    /// MCP resources and prompts. Every agent that has the UI tools gets it.
    Mcp,
    /// ACP `systemPrompt` (`append`) on `session/new` and `session/load`.
    AcpSystemPrompt,
    /// Prepended once to the chat's first prompt, for agents with no other way.
    FirstPrompt,
    /// Claude Code: `_meta.systemPrompt.append`, when the adapter has no ACP `systemPrompt`.
    ClaudeSystemPrompt,
    /// Claude Code: `_meta.claudeCode.options.plugins`, a local plugin wrapping the skills.
    ClaudePlugin,
}

impl Route {
    pub fn label(self) -> &'static str {
        match self {
            Route::Mcp => "yaah-ui MCP server: instructions, the ui_guide tool, the skills as resources and prompts",
            Route::AcpSystemPrompt => "The guide in the system prompt (ACP systemPrompt, append)",
            Route::FirstPrompt => "The guide at the top of each chat's first message",
            Route::ClaudeSystemPrompt => "The guide in Claude Code's system prompt (_meta.systemPrompt)",
            Route::ClaudePlugin => "The skills as a Claude Code plugin (~/.yaah/agent-plugin)",
        }
    }
}

/// What decides an agent's routes.
#[derive(Debug, Clone, Copy)]
pub struct Traits<'a> {
    /// The profile's preset (`claude`, `codex`, `gemini`, `custom`, …).
    pub preset: &'a str,
    /// It gets yaah's UI server (it reaches HTTP MCP servers and the server is up).
    pub ui: bool,
    /// It advertises ACP `sessionCapabilities.systemPrompt`.
    pub system_prompt: bool,
}

/// Per-agent extras on top of the generic routes. An agent is listed only when
/// it has a per-session way to take skills that yaah can use safely:
/// - Claude Code (claude-agent-acp 0.99): `_meta.claudeCode.options.plugins`,
///   forwarded to the Agent SDK; and `_meta.systemPrompt` for adapters that
///   predate the ACP `systemPrompt`.
/// - Codex (codex-acp 2.5): reads skills only from `<additional dir>/.agents/skills`,
///   and makes every additional directory a trusted, writable sandbox root. Not
///   worth giving the agent write access to yaah's folder: generic routes only.
/// - Gemini CLI (0.63, `--acp`): `session/new` takes only `cwd` and `mcpServers`:
///   generic routes only.
///
/// Add an agent here when its adapter grows a per-session skills or plugin option.
fn extras(t: &Traits) -> Vec<Route> {
    match t.preset {
        agents::CLAUDE if t.system_prompt => vec![Route::ClaudePlugin],
        agents::CLAUDE => vec![Route::ClaudeSystemPrompt, Route::ClaudePlugin],
        _ => vec![],
    }
}

/// The routes the guide takes to an agent; `teach` is the user's setting.
pub fn plan(t: &Traits, teach: bool) -> Vec<Route> {
    if !t.ui {
        // No UI tools in its chats: nothing to teach.
        return vec![];
    }
    let mut routes = vec![Route::Mcp];
    if !teach {
        return routes;
    }
    let extras = extras(t);
    if t.system_prompt {
        routes.push(Route::AcpSystemPrompt);
    } else if !extras.contains(&Route::ClaudeSystemPrompt) {
        routes.push(Route::FirstPrompt);
    }
    routes.extend(extras);
    routes
}

/// `v[path…]` as an object, made one (and its parents) if it isn't.
fn object_at<'a>(v: &'a mut Value, path: &[&str]) -> &'a mut Map<String, Value> {
    let mut at = v;
    for key in path {
        if !at.is_object() {
            *at = json!({});
        }
        at = at.as_object_mut().expect("just made an object").entry(*key).or_insert_with(|| json!({}));
    }
    if !at.is_object() {
        *at = json!({});
    }
    at.as_object_mut().expect("just made an object")
}

// ── The app's guide ──────────────────────────────────────────────────────────

/// A text and the component names it was built for.
type TextFor = (Arc<Vec<String>>, Arc<String>);

/// The guide and skills as they are now, and where yaah writes them.
pub struct Guide {
    /// `~/.yaah`.
    home: PathBuf,
    components: Box<dyn Fn() -> Arc<Vec<String>> + Send + Sync>,
    enabled: Box<dyn Fn() -> bool + Send + Sync>,
    /// One write at a time.
    writing: Mutex<()>,
    /// The guide text for the names it was last built for.
    text: Mutex<Option<TextFor>>,
}

impl Guide {
    /// `components` lists the component names; `enabled` reads the user's setting.
    pub fn new(
        home: PathBuf,
        components: impl Fn() -> Vec<String> + Send + Sync + 'static,
        enabled: impl Fn() -> bool + Send + Sync + 'static,
    ) -> Self {
        Self::with_names(home, move || Arc::new(components()), enabled)
    }

    /// Like [`new`](Self::new), with names the caller already shares (the library's, kept in memory).
    pub(crate) fn with_names(
        home: PathBuf,
        components: impl Fn() -> Arc<Vec<String>> + Send + Sync + 'static,
        enabled: impl Fn() -> bool + Send + Sync + 'static,
    ) -> Self {
        Self { home, components: Box::new(components), enabled: Box::new(enabled), writing: Mutex::new(()), text: Mutex::new(None) }
    }

    /// The app's: `~/.yaah`, the app's library, and Settings → Chat.
    pub(crate) fn for_app(library: Arc<Library>) -> Self {
        Self::with_names(crate::accounts::home().join(".yaah"), move || library.component_names(), crate::settings::teach_agents)
    }

    /// `~/.yaah/agent-skills`: `<name>/SKILL.md` for each skill.
    pub fn skills_dir(&self) -> PathBuf {
        self.home.join("agent-skills")
    }

    /// `~/.yaah/agent-plugin`: the skills wrapped as a Claude Code plugin.
    pub fn plugin_dir(&self) -> PathBuf {
        self.home.join("agent-plugin")
    }

    pub fn enabled(&self) -> bool {
        (self.enabled)()
    }

    pub fn text(&self) -> String {
        self.shared_text().as_ref().clone()
    }

    /// The guide for the components now, built again only when they change.
    fn shared_text(&self) -> Arc<String> {
        let names = (self.components)();
        let mut cached = self.text.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some((for_names, text)) = cached.as_ref()
            && (Arc::ptr_eq(for_names, &names) || *for_names == names)
        {
            return text.clone();
        }
        let text = Arc::new(guide_text(&names));
        *cached = Some((names, text.clone()));
        text
    }

    /// Bring the skill files and the plugin up to date; writes only what changed.
    pub fn sync(&self) -> Result<usize, String> {
        let names = (self.components)();
        let _one = self.writing.lock().unwrap_or_else(PoisonError::into_inner);
        let skills = write_if_changed(&self.skills_dir(), &skill_files(&names));
        let plugin = write_if_changed(&self.plugin_dir(), &plugin_files(&names));
        match (skills, plugin) {
            (Ok(a), Ok(b)) => Ok(a + b),
            (Err(e), _) | (_, Err(e)) => Err(format!("writing yaah's agent skills: {e}")),
        }
    }

    /// [`sync`](Self::sync) on a thread of its own (startup, library changes).
    pub fn sync_in_background(self: &Arc<Self>) {
        let guide = self.clone();
        let _ = std::thread::Builder::new().name("yaah-agent-guide".into()).spawn(move || {
            if let Err(e) = guide.sync() {
                eprintln!("[agent-guide] {e}");
            }
        });
    }

    /// Put the guide into `session/new` or `session/load` params for an agent,
    /// by the routes it takes, next to whatever `_meta` is already there.
    /// Returns the text to prepend to the chat's first prompt when that is the route.
    pub fn deliver(&self, traits: &Traits, params: &mut Value) -> Option<String> {
        let routes = plan(traits, self.enabled());
        if routes.len() <= 1 {
            return None;
        }
        let text = self.shared_text();
        let mut first_prompt = None;
        for route in routes {
            match route {
                Route::Mcp => {}
                Route::AcpSystemPrompt => {
                    params["systemPrompt"] = json!({ "mode": "append", "content": [{ "type": "text", "text": text.as_str() }] });
                }
                Route::FirstPrompt => first_prompt = Some(text.as_str().to_owned()),
                Route::ClaudeSystemPrompt => {
                    object_at(params, &["_meta", "systemPrompt"]).insert("append".into(), json!(text.as_str()));
                }
                Route::ClaudePlugin => match self.sync() {
                    Ok(_) => {
                        let options = object_at(params, &["_meta", "claudeCode", "options"]);
                        let plugins = options.entry("plugins").or_insert_with(|| json!([]));
                        if let Some(list) = plugins.as_array_mut() {
                            list.push(json!({ "type": "local", "path": self.plugin_dir() }));
                        }
                    }
                    Err(e) => eprintln!("[agent-guide] no plugin for this chat: {e}"),
                },
            }
        }
        first_prompt
    }
}

// ── Settings → Chat ──────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    name: &'static str,
    description: &'static str,
    path: String,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteInfo {
    id: Route,
    label: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRoutes {
    id: String,
    label: String,
    /// `false` until the agent has started once: its capabilities aren't known yet.
    known: bool,
    routes: Vec<RouteInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideInfo {
    enabled: bool,
    guide: String,
    skills_dir: String,
    plugin_dir: String,
    skills: Vec<SkillInfo>,
    agents: Vec<AgentRoutes>,
}

/// An agent's routes from what it reported in its last `initialize`.
fn routes_of(p: &Profile, teach: bool) -> AgentRoutes {
    let routes = p.report.as_ref().map(|r| plan(&Traits { preset: &p.preset, ui: r.mcp_http, system_prompt: r.system_prompt }, teach));
    AgentRoutes {
        id: p.id.clone(),
        label: p.label.clone(),
        known: routes.is_some(),
        routes: routes.unwrap_or_default().into_iter().map(|id| RouteInfo { id, label: id.label() }).collect(),
    }
}

impl Guide {
    fn info(&self, profiles: &[Profile]) -> GuideInfo {
        let names = (self.components)();
        let enabled = self.enabled();
        GuideInfo {
            enabled,
            guide: guide_text(&names),
            skills_dir: self.skills_dir().to_string_lossy().into_owned(),
            plugin_dir: self.plugin_dir().to_string_lossy().into_owned(),
            skills: SKILLS
                .iter()
                .map(|s| SkillInfo {
                    name: s.name,
                    description: skill_description(s),
                    path: self.skills_dir().join(s.name).join("SKILL.md").to_string_lossy().into_owned(),
                    text: skill_text(s, &names),
                })
                .collect(),
            agents: profiles.iter().map(|p| routes_of(p, enabled)).collect(),
        }
    }
}

/// What agents are told, and how it reaches each configured agent.
#[tauri::command]
pub async fn agent_guide(guide: State<'_, Arc<Guide>>) -> Result<GuideInfo, String> {
    let guide = guide.inner().clone();
    // Off the async workers: listing components reads every component file.
    tauri::async_runtime::spawn_blocking(move || guide.info(&agents::Store::user().load().profiles)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_teach_agents(enabled: bool) -> Result<(), String> {
    crate::settings::set_teach_agents(enabled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui_library::{Bundled, LocalDir, SaveRequest};

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("yaah-guide-{tag}-{}", crate::session::random_token()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn names(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("c{i}")).collect()
    }

    #[test]
    fn the_component_index_is_capped() {
        assert_eq!(component_index(&[]), "none yet (see ui_catalog).");
        assert_eq!(component_index(&names(3)), "c0, c1, c2.");
        assert_eq!(component_index(&names(INDEX_CAP)).matches(", ").count(), INDEX_CAP - 1, "exactly the cap: no `more`");
        let long = component_index(&names(INDEX_CAP + 7));
        assert!(long.ends_with("c39 (+7 more, see ui_catalog)."), "{long}");
        assert!(!long.contains("c40"));
    }

    #[test]
    fn the_guide_is_short_and_ends_with_the_index() {
        let text = guide_text(&names(INDEX_CAP + 7));
        assert!(text.starts_with("# You are running inside yaah"));
        assert!(text.trim_end().ends_with("(+7 more, see ui_catalog)."));
        for must in [
            "yaah-ui",
            "`open`",
            "standalone HTML",
            "`browser`",
            "ToolSearch",
            "ui_catalog",
            "library/name",
            "ui_save_component",
            "source_read",
            "`live`",
            "Never paste large data",
            "diff-review",
            "`git.log`",
            "ui_ask",
            "ui_guide",
            "`mcp__yaah-ui__ui_catalog`",
            "bare `ui_catalog`",
        ] {
            assert!(text.contains(must), "the guide mentions {must}");
        }
        // About 4 characters a token: 250-560 tokens for the guide itself (raised from 460 for the "reference, don't paste" rule).
        let own = guide_text(&[]).len() / 4;
        assert!((250..=560).contains(&own), "the guide is about {own} tokens");
        assert!(!text.contains("{{"), "every placeholder is filled");
    }

    #[test]
    fn the_ui_skill_shows_referencing_data_beside_pasting_it() {
        let skill = SKILLS.iter().find(|s| s.name == "yaah-ui").unwrap();
        let text = skill_text(skill, &[]);
        let section = text.split("## Reference data, don't paste it").nth(1).expect("the section is there");
        let section = section.split("\n## ").next().unwrap();
        let bad = section.find(r#"{ "type": "patch""#).expect("the pasted diff, as the slow example");
        let good = section.find(r#"{ "type": "diff-review", "props": { "range": "main...HEAD""#).expect("diff-review, as the fast one");
        assert!(bad < good, "bad first, then good");
        for source in ["`git.diff`", "`git.log`", "`git.status`", "`git.show`", "`postgres.query`", "`docker.logs`", "`textfile` with its `path`"] {
            assert!(section.contains(source), "the table names {source}");
        }
        // Each example is valid JSON as written (the pasted diff is cut short on purpose).
        for block in section.split("```json\n").skip(1) {
            let json = block.split("\n```").next().unwrap();
            assert!(serde_json::from_str::<Value>(json).is_ok(), "{json}");
        }
    }

    #[test]
    fn components_list_yaahs_first_then_local_then_libraries() {
        let dir = temp("names");
        let lib = Library::with_sources(vec![Box::new(Bundled::new()), Box::new(LocalDir::new(dir.join("components")))]);
        let mine = SaveRequest {
            name: "aaa-mine".into(),
            description: "A greeting I made, shown when someone says hello.".into(),
            props: json!({ "type": "object", "properties": {} }),
            tree: json!({ "type": "text", "props": { "text": "hi" } }),
            examples: vec![crate::ui_library::Example { title: "x".into(), props: json!({}) }],
            change_note: None,
            expected_version: None,
        };
        lib.save(mine).unwrap();
        let names = component_names(&lib);
        assert!(names.contains(&"test-report".to_owned()));
        assert_eq!(names.last().map(String::as_str), Some("aaa-mine"), "the user's own after yaah's, though it sorts first");
        assert!(guide_text(&names).contains("test-report"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn skills_are_agent_skills_with_frontmatter() {
        for s in SKILLS {
            let text = skill_text(s, &names(2));
            let front = text.strip_prefix("---\n").and_then(|t| t.split_once("\n---\n")).map(|(f, _)| f).expect("frontmatter");
            assert!(front.lines().any(|l| l == format!("name: {}", s.name)), "{}: name matches its folder", s.name);
            let description = skill_description(s);
            assert!(!description.is_empty() && description.len() <= 1024, "{}: description fits the spec", s.name);
            assert!(s.name.len() <= 64 && s.name.chars().all(|c| c.is_ascii_lowercase() || c == '-'));
            assert!(!text.contains("{{primitives}}") && !text.contains("{{components}}"));
        }
        let ui = skill_text(skill("ui").unwrap(), &names(2));
        assert!(ui.contains("- `chart` (") && ui.contains("kind*"), "the primitive index lists props, required starred");
        let primitives = crate::ui_library::primitives()["primitives"].as_object().unwrap().len();
        assert_eq!(primitive_index().lines().count(), primitives, "every primitive is indexed");
        assert!(skill("yaah-components").is_some() && skill("nope").is_none());
    }

    /// Agents called `ui_catalog` where their tool list had `mcp__yaah-ui__ui_catalog`
    /// and got "No such tool": the skills spell out both names of every tool.
    #[test]
    fn the_skills_name_every_tool_both_ways() {
        let ui = skill_text(skill("ui").unwrap(), &[]);
        for t in crate::ui_mcp::TOOL_NAMES {
            assert!(ui.contains(&format!("- `mcp__yaah-ui__{t}` (bare: `{t}`)")), "yaah-ui names {t}");
        }
        assert!(!ui.contains("{{tools}}"));
        let components = skill_text(skill("components").unwrap(), &[]);
        for t in ["ui_save_component", "ui_get_component", "ui_catalog", "ui_render"] {
            assert!(components.contains(&format!("`mcp__yaah-ui__{t}`")) && components.contains(&format!("`{t}`")), "yaah-components names {t}");
        }
        assert!(components.contains("examples[0].title is required"), "and says how save errors read");
    }

    /// The JSON examples in the skills are real: trees render and the saved component saves.
    #[test]
    fn the_skills_examples_validate() {
        let dir = temp("examples");
        let lib = Library::with_sources(vec![Box::new(Bundled::new()), Box::new(LocalDir::new(dir.join("components")))]);
        let blocks = |text: &str| -> Vec<Value> {
            text.split("```json\n").skip(1).map(|b| serde_json::from_str(b.split("\n```").next().unwrap()).expect("a JSON example")).collect()
        };
        let ui = blocks(skill_text(skill("ui").unwrap(), &[]).as_str());
        assert_eq!(ui.len(), 5, "three patterns, and the pasted diff beside diff-review");
        for tree in ui {
            lib.prepare(None, json!({}), Some(tree.clone())).unwrap_or_else(|e| panic!("{tree}: {e:?}"));
        }
        let save = blocks(skill_text(skill("components").unwrap(), &[]).as_str()).remove(0);
        let saved = lib.save(serde_json::from_value(save).unwrap()).unwrap_or_else(|e| panic!("{e:?}"));
        assert_eq!((saved.name.as_str(), saved.version), ("release-checklist", 1));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn writes_the_skills_and_plugin_only_when_they_change() {
        let home = temp("write");
        let components = Arc::new(Mutex::new(names(2)));
        let c = components.clone();
        let guide = Guide::new(home.clone(), move || c.lock().unwrap().clone(), || true);
        assert_eq!(guide.sync().unwrap(), 5, "two skills, then the plugin's manifest and two skills");
        for f in [
            "agent-skills/yaah-ui/SKILL.md",
            "agent-skills/yaah-components/SKILL.md",
            "agent-plugin/.claude-plugin/plugin.json",
            "agent-plugin/skills/yaah-ui/SKILL.md",
        ] {
            assert!(home.join(f).is_file(), "{f}");
        }
        let manifest: Value = serde_json::from_str(&std::fs::read_to_string(home.join("agent-plugin/.claude-plugin/plugin.json")).unwrap()).unwrap();
        assert_eq!(manifest["name"], "yaah");
        let written = std::fs::metadata(home.join("agent-skills/yaah-components/SKILL.md")).unwrap().modified().unwrap();

        assert_eq!(guide.sync().unwrap(), 0, "nothing changed, nothing written");
        components.lock().unwrap().push("new-one".into());
        assert_eq!(guide.sync().unwrap(), 2, "a new component changes the yaah-ui skill, in both places");
        assert!(std::fs::read_to_string(home.join("agent-plugin/skills/yaah-ui/SKILL.md")).unwrap().contains("new-one"));
        assert_eq!(std::fs::metadata(home.join("agent-skills/yaah-components/SKILL.md")).unwrap().modified().unwrap(), written);

        std::fs::write(home.join("agent-skills/yaah-ui/SKILL.md"), "edited by hand").unwrap();
        assert_eq!(guide.sync().unwrap(), 1, "a hand edit is put back");
        assert!(!home.join("agent-skills/yaah-ui/SKILL.tmp").exists());
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn routes_are_generic_first_with_extras_by_kind() {
        use Route::*;
        let t = |preset, ui, system_prompt| Traits { preset, ui, system_prompt };
        assert_eq!(plan(&t("gemini", true, false), true), [Mcp, FirstPrompt], "no capability: the first prompt");
        assert_eq!(plan(&t("codex", true, true), true), [Mcp, AcpSystemPrompt], "advertised: the ACP systemPrompt");
        assert_eq!(plan(&t("custom", true, true), true), [Mcp, AcpSystemPrompt]);
        assert_eq!(plan(&t("claude", true, true), true), [Mcp, AcpSystemPrompt, ClaudePlugin], "Claude: the spec param, plus the plugin");
        assert_eq!(plan(&t("claude", true, false), true), [Mcp, ClaudeSystemPrompt, ClaudePlugin], "an older adapter: _meta instead");
        assert_eq!(plan(&t("claude", true, true), false), [Mcp], "turned off: only the MCP server's own");
        assert_eq!(plan(&t("claude", false, true), true), [], "no UI tools: nothing to teach");
    }

    #[test]
    fn delivery_merges_into_the_params_already_there() {
        let home = temp("deliver");
        let guide = Guide::new(home.clone(), || vec!["test-report".into()], || true);
        let base = json!({ "cwd": "/x", "_meta": { "claudeCode": { "options": { "allowedTools": ["mcp__yaah-ui__ui_render"] } } } });

        let mut p = base.clone();
        assert!(guide.deliver(&Traits { preset: "claude", ui: true, system_prompt: false }, &mut p).is_none());
        assert!(p["_meta"]["systemPrompt"]["append"].as_str().unwrap().contains("test-report"));
        assert_eq!(p["_meta"]["claudeCode"]["options"]["allowedTools"], json!(["mcp__yaah-ui__ui_render"]), "allowedTools kept");
        assert_eq!(p["_meta"]["claudeCode"]["options"]["plugins"], json!([{ "type": "local", "path": home.join("agent-plugin") }]));
        assert!(p.get("systemPrompt").is_none());
        assert!(home.join("agent-plugin/skills/yaah-ui/SKILL.md").is_file(), "the plugin is written before it is handed over");

        let mut p = base.clone();
        guide.deliver(&Traits { preset: "claude", ui: true, system_prompt: true }, &mut p);
        assert_eq!(p["systemPrompt"]["mode"], "append");
        assert!(p["systemPrompt"]["content"][0]["text"].as_str().unwrap().starts_with("# You are running inside yaah"));
        assert!(p["_meta"].get("systemPrompt").is_none(), "the spec param wins; no _meta copy");

        let mut p = json!({ "cwd": "/x" });
        let first = guide.deliver(&Traits { preset: "gemini", ui: true, system_prompt: false }, &mut p);
        assert!(first.unwrap().contains("test-report"));
        assert_eq!(p, json!({ "cwd": "/x" }), "nothing in the params");

        let off = Guide::new(home.clone(), Vec::new, || false);
        let mut p = base.clone();
        assert!(off.deliver(&Traits { preset: "claude", ui: true, system_prompt: true }, &mut p).is_none());
        assert_eq!(p, base, "turned off: the params are left alone");
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn settings_list_each_agents_routes() {
        let home = temp("info");
        let guide = Guide::new(home.clone(), || vec!["test-report".into()], || true);
        let mut claude = Profile {
            id: "default".into(),
            label: "Claude".into(),
            preset: agents::CLAUDE.into(),
            command: "npx".into(),
            args: vec![],
            env: std::collections::BTreeMap::new(),
            config_dir: None,
            report: None,
        };
        let mut fresh = claude.clone();
        fresh.id = "fresh".into();
        claude.report = Some(agents::Report { mcp_http: true, system_prompt: true, ..agents::Report::default() });
        let info = serde_json::to_value(guide.info(&[claude, fresh])).unwrap();
        assert_eq!(info["enabled"], true);
        assert_eq!(info["skills"].as_array().unwrap().len(), 2);
        assert!(info["skills"][0]["path"].as_str().unwrap().ends_with("agent-skills/yaah-ui/SKILL.md"));
        let routes: Vec<&str> = info["agents"][0]["routes"].as_array().unwrap().iter().map(|r| r["id"].as_str().unwrap()).collect();
        assert_eq!(routes, ["mcp", "acpSystemPrompt", "claudePlugin"]);
        assert_eq!((info["agents"][1]["known"].as_bool(), info["agents"][1]["routes"].as_array().map(Vec::len)), (Some(false), Some(0)));
        std::fs::remove_dir_all(home).unwrap();
    }
}
