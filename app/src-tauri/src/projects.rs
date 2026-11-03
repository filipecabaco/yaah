//! Projects: a named unit of work grouping one or more folders.
//!
//! A project has a status lifecycle,
//! a list of folders, and a context folder (`~/.yaah/projects/<id>/`) holding
//! `project.md`, the brief every chat in the project starts from.
//!
//! The registry lives in `~/.config/yaah/projects.json`.
//!
//! A project started from a tracker item (`work_items.rs`) keeps a `link` to it,
//! and its brief carries the item between two markers at the top: refreshing
//! rewrites only that block, so what the user wrote around it stays.

use crate::accounts::home;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Planning,
    Ongoing,
    Done,
    Archived,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    /// Absolute paths. The first one is the chat's working directory.
    pub dirs: Vec<String>,
    pub status: Status,
    pub created_at: u64,
    /// Not persisted: derived from the id.
    #[serde(default, skip_deserializing)]
    pub context_dir: String,
    /// The tracker item the project was started from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<ProjectLink>,
    /// The agent (profile id) new chats in the project start with; none: the
    /// one picked in the sidebar. Registries from before this field load as none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
}

/// What a new project may start with besides its name and folders.
#[derive(Debug, Clone, Default)]
pub struct NewProject {
    /// The agent new chats start with (see `Project::agent_id`).
    pub agent_id: Option<String>,
    /// Markdown, written into the brief under `## Statement of work`.
    pub statement_of_work: String,
}

pub const STATEMENT_HEADING: &str = "## Statement of work";

/// A new project's brief: its title and, when given, the statement of work.
pub fn initial_brief(name: &str, statement_of_work: &str) -> String {
    match statement_of_work.trim() {
        "" => format!("# {name}\n\n"),
        sow => format!("# {name}\n\n{STATEMENT_HEADING}\n\n{sow}\n"),
    }
}

/// An agent id as the user chose it: empty means none; anything else must be
/// an agent `exists` knows.
pub fn agent_choice(agent_id: Option<&str>, exists: impl Fn(&str) -> bool) -> Result<Option<String>, String> {
    match agent_id.map(str::trim) {
        None | Some("") => Ok(None),
        Some(id) if exists(id) => Ok(Some(id.to_owned())),
        Some(id) => Err(format!("unknown agent `{id}`: pick one from Settings → Agents")),
    }
}

/// A tracker item a project follows (read-only).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLink {
    /// `github`, `linear`, `linear-project` or `gitlab`.
    pub service: String,
    /// `owner/repo#12`, `ENG-142`, a Linear project's slug id, `group/proj#7`.
    pub id: String,
    pub url: String,
    pub title: String,
    /// Seconds since the epoch, like `created_at`.
    pub linked_at: u64,
    pub synced_at: u64,
}

pub const SOURCE_START: &str = "<!-- yaah:source:start -->";
pub const SOURCE_END: &str = "<!-- yaah:source:end -->";

/// `brief` with its source block replaced by `block` (or added at the top), or
/// removed with `None`. Text outside the markers is kept as it is.
pub fn set_source_block(brief: &str, block: Option<&str>) -> String {
    let span = brief.find(SOURCE_START).and_then(|start| brief[start..].find(SOURCE_END).map(|end| (start, start + end + SOURCE_END.len())));
    let (before, after) = match span {
        Some((start, end)) => (&brief[..start], &brief[end..]),
        None => ("", brief),
    };
    let after = after.trim_start_matches(['\r', '\n']);
    let Some(block) = block else {
        return format!("{before}{after}");
    };
    let rest = if after.is_empty() { String::new() } else { format!("\n{after}") };
    format!("{before}{SOURCE_START}\n{}\n{SOURCE_END}\n{rest}", block.trim_end())
}

impl Project {
    pub fn brief_path(&self) -> PathBuf {
        Path::new(&self.context_dir).join("project.md")
    }

    /// Where a chat runs: the first folder, or the context folder when the
    /// project has none yet.
    pub fn cwd(&self) -> String {
        self.dirs.first().cloned().unwrap_or_else(|| self.context_dir.clone())
    }

    /// Every root a chat may touch besides its cwd.
    pub fn additional_dirs(&self) -> Vec<String> {
        let mut extra: Vec<String> = self.dirs.iter().skip(1).cloned().collect();
        if !self.dirs.is_empty() {
            extra.push(self.context_dir.clone());
        }
        extra
    }
}

#[derive(Default, Serialize, Deserialize)]
struct Registry {
    projects: Vec<Project>,
}

#[derive(Default)]
pub struct Projects {
    lock: Mutex<()>,
    /// Read-modify-write of a brief's source block, one at a time.
    brief_lock: Mutex<()>,
}

/// Where projects live: the home folder, or (in a test, on its own thread) a temp one.
fn root() -> PathBuf {
    #[cfg(test)]
    if let Some(r) = tests::ROOT.with(|r| r.borrow().clone()) {
        return r;
    }
    home()
}

fn registry_path() -> PathBuf {
    root().join(".config/yaah/projects.json")
}

fn context_dir(id: &str) -> PathBuf {
    root().join(".yaah/projects").join(id)
}

fn new_id() -> String {
    crate::session::random_token()[..16].to_owned()
}

impl Projects {
    pub fn list(&self) -> Result<Vec<Project>, String> {
        let _g = self.lock.lock().unwrap();
        Ok(load()?.projects)
    }

    pub fn get(&self, id: &str) -> Result<Project, String> {
        self.list()?.into_iter().find(|p| p.id == id).ok_or_else(|| format!("unknown project {id}"))
    }

    pub fn create(&self, name: &str, dirs: &[String]) -> Result<Project, String> {
        self.create_with(name, dirs, NewProject::default())
    }

    /// A project with an agent and a statement of work (written into the brief).
    pub fn create_with(&self, name: &str, dirs: &[String], new: NewProject) -> Result<Project, String> {
        let dirs = dedupe(dirs.iter().map(|d| validate_dir(d)).collect::<Result<_, _>>()?);
        let name = match name.trim() {
            "" => dirs.first().and_then(|d| Path::new(d).file_name()).map_or_else(|| "Untitled project".into(), |n| n.to_string_lossy().into_owned()),
            n => n.to_owned(),
        };
        let id = new_id();
        let ctx = context_dir(&id);
        std::fs::create_dir_all(&ctx).map_err(|e| format!("create {}: {e}", ctx.display()))?;
        let brief = ctx.join("project.md");
        if !brief.exists() {
            std::fs::write(&brief, initial_brief(&name, &new.statement_of_work)).map_err(|e| format!("write {}: {e}", brief.display()))?;
        }

        let project = Project {
            id,
            name,
            dirs,
            status: Status::Ongoing,
            created_at: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs(),
            context_dir: ctx.to_string_lossy().into_owned(),
            link: None,
            agent_id: new.agent_id.filter(|a| !a.trim().is_empty()),
        };
        self.mutate(|r| {
            r.projects.push(project.clone());
            Ok(())
        })?;
        Ok(project)
    }

    pub fn update<F>(&self, id: &str, f: F) -> Result<Project, String>
    where
        F: FnOnce(&mut Project) -> Result<(), String>,
    {
        self.mutate(|r| {
            let p = r.projects.iter_mut().find(|p| p.id == id).ok_or_else(|| format!("unknown project {id}"))?;
            f(p)?;
            Ok(p.clone())
        })
    }

    /// The agent new chats in the project start with (`None`: the sidebar's).
    pub fn set_agent(&self, id: &str, agent_id: Option<String>) -> Result<Project, String> {
        self.update(id, |p| {
            p.agent_id = agent_id.filter(|a| !a.trim().is_empty());
            Ok(())
        })
    }

    pub fn add_dir(&self, id: &str, dir: &str) -> Result<Project, String> {
        self.add_dirs(id, &[dir.to_owned()])
    }

    /// Add several folders at once; all must be valid or none are added.
    pub fn add_dirs(&self, id: &str, dirs: &[String]) -> Result<Project, String> {
        let dirs: Vec<String> = dirs.iter().map(|d| validate_dir(d)).collect::<Result<_, _>>()?;
        self.update(id, |p| {
            for dir in dirs {
                if !p.dirs.contains(&dir) {
                    p.dirs.push(dir);
                }
            }
            Ok(())
        })
    }

    pub fn remove_dir(&self, id: &str, dir: &str) -> Result<Project, String> {
        self.update(id, |p| {
            p.dirs.retain(|d| d != dir);
            Ok(())
        })
    }

    /// Removes the project and its context folder (the brief). Never touches
    /// the project's own folders.
    pub fn delete(&self, id: &str) -> Result<(), String> {
        // Only a project in the registry: the id names a folder that gets deleted.
        self.mutate(|r| {
            let at = r.projects.iter().position(|p| p.id == id).ok_or_else(|| format!("unknown project {id}"))?;
            r.projects.remove(at);
            Ok(())
        })?;
        let ctx = context_dir(id);
        if plain_id(id) && ctx.exists() {
            std::fs::remove_dir_all(&ctx).map_err(|e| format!("remove {}: {e}", ctx.display()))?;
        }
        Ok(())
    }

    pub fn read_brief(&self, id: &str) -> Result<String, String> {
        let p = self.get(id)?;
        Ok(std::fs::read_to_string(p.brief_path()).unwrap_or_default())
    }

    pub fn write_brief(&self, id: &str, text: &str) -> Result<(), String> {
        let p = self.get(id)?;
        std::fs::write(p.brief_path(), text).map_err(|e| format!("write brief: {e}"))
    }

    /// Write (`Some`) or remove (`None`) the brief's source block, keeping the rest.
    pub fn set_brief_source(&self, id: &str, block: Option<&str>) -> Result<(), String> {
        let _g = self.brief_lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let brief = self.read_brief(id)?;
        let mut text = set_source_block(&brief, block);
        if text.trim().is_empty() {
            // Nothing left once the item is gone: back to the brief a new project starts with.
            text = format!("# {}\n\n", self.get(id)?.name);
        }
        self.write_brief(id, &text)
    }

    /// The project that follows `service`'s item `id` (ids compare without case:
    /// `Owner/Repo#1` is `owner/repo#1`).
    pub fn linked(&self, service: &str, id: &str) -> Result<Option<Project>, String> {
        Ok(self.list()?.into_iter().find(|p| p.link.as_ref().is_some_and(|l| l.service == service && l.id.eq_ignore_ascii_case(id))))
    }

    fn mutate<T>(&self, f: impl FnOnce(&mut Registry) -> Result<T, String>) -> Result<T, String> {
        let _g = self.lock.lock().unwrap();
        let mut r = load()?;
        let out = f(&mut r)?;
        save(&r)?;
        Ok(out)
    }
}

fn load() -> Result<Registry, String> {
    let path = registry_path();
    let mut r: Registry = match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|e| format!("parse {}: {e}", path.display()))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Registry::default(),
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    for p in &mut r.projects {
        p.context_dir = context_dir(&p.id).to_string_lossy().into_owned();
    }
    Ok(r)
}

fn save(r: &Registry) -> Result<(), String> {
    crate::json_file::write(&registry_path(), r, false)
}

fn validate_dir(dir: &str) -> Result<String, String> {
    let p = Path::new(dir);
    if !p.is_absolute() {
        return Err(format!("{dir} is not an absolute path"));
    }
    if !p.is_dir() {
        return Err(format!("{dir} is not a folder"));
    }
    let s = p.to_string_lossy();
    let trimmed = s.trim_end_matches('/');
    Ok(if trimmed.is_empty() { "/".into() } else { trimmed.to_owned() })
}

/// An id that names exactly one folder under the projects folder.
fn plain_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn dedupe(dirs: Vec<String>) -> Vec<String> {
    let mut out = Vec::with_capacity(dirs.len());
    for d in dirs {
        if !out.contains(&d) {
            out.push(d);
        }
    }
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    thread_local! {
        /// This thread's stand-in for the home folder (HOME is shared by every test).
        pub static ROOT: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
    }

    #[test]
    fn project_lifecycle_in_a_temp_home() {
        let home = std::env::temp_dir().join(format!("yaah-test-{}", std::process::id()));
        let (a, b) = (home.join("repo-a"), home.join("repo-b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        ROOT.with(|r| *r.borrow_mut() = Some(home.clone()));

        let store = Projects::default();
        let p = store.create("", &[a.to_string_lossy().into(), a.to_string_lossy().into()]).unwrap();
        assert_eq!(p.name, "repo-a", "name defaults to the first folder");
        assert_eq!(p.dirs.len(), 1, "duplicate folders collapse");
        assert!(p.brief_path().is_file(), "brief is created");
        assert_eq!(p.additional_dirs(), vec![p.context_dir.clone()]);

        let p = store.add_dir(&p.id, &b.to_string_lossy()).unwrap();
        assert_eq!(p.cwd(), a.to_string_lossy());
        assert_eq!(p.additional_dirs(), vec![b.to_string_lossy().into_owned(), p.context_dir.clone()]);
        assert!(store.add_dir(&p.id, "relative/path").is_err());

        let p = store
            .update(&p.id, |p| {
                p.status = Status::Done;
                Ok(())
            })
            .unwrap();
        assert_eq!(store.get(&p.id).unwrap().status, Status::Done, "persisted");

        // Ids that aren't in the registry delete nothing, however they're spelled.
        for bad in ["../..", "..", "", "nope"] {
            assert!(store.delete(bad).is_err(), "{bad}");
        }
        assert!(home.join(".yaah/projects").is_dir() && a.is_dir());
        assert!(store.read_brief("nope").is_err() && store.write_brief("../x", "hi").is_err());
        store.write_brief(&p.id, "# repo-a\n\nShip it.\n").unwrap();
        assert_eq!(store.read_brief(&p.id).unwrap(), "# repo-a\n\nShip it.\n");
        let p = store.remove_dir(&p.id, &b.to_string_lossy()).unwrap();
        assert_eq!(p.dirs.len(), 1);
        assert!(store.add_dirs(&p.id, &[b.to_string_lossy().into(), "/definitely/not/here".into()]).is_err(), "all or nothing");
        assert_eq!(store.get(&p.id).unwrap().dirs.len(), 1);

        store.delete(&p.id).unwrap();
        assert!(store.list().unwrap().is_empty());
        assert!(!Path::new(&p.context_dir).exists(), "context folder removed");
        assert!(a.is_dir(), "project folders are never touched");

        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn a_statement_of_work_goes_into_the_brief_under_its_heading() {
        assert_eq!(initial_brief("Shop", ""), "# Shop\n\n", "none: the title alone, as before");
        assert_eq!(initial_brief("Shop", "  \n\t"), "# Shop\n\n", "blank counts as none");
        assert_eq!(
            initial_brief("Shop", "\n**Goal:** refunds in cents.\n\n- In: API\n- Out: UI\n\n"),
            "# Shop\n\n## Statement of work\n\n**Goal:** refunds in cents.\n\n- In: API\n- Out: UI\n"
        );
        // A tracker item's block goes on top of it and leaves it be.
        let brief = set_source_block(&initial_brief("Shop", "Done when it ships."), Some("# ENG-1 X"));
        assert!(brief.ends_with("# Shop\n\n## Statement of work\n\nDone when it ships.\n"), "{brief}");
    }

    #[test]
    fn an_agent_choice_is_none_or_a_known_agent() {
        let known = |id: &str| id == "work";
        assert_eq!(agent_choice(None, known), Ok(None));
        assert_eq!(agent_choice(Some(" "), known), Ok(None));
        assert_eq!(agent_choice(Some("work"), known), Ok(Some("work".into())));
        assert!(agent_choice(Some("gone"), known).unwrap_err().contains("unknown agent `gone`"));
    }

    #[test]
    fn a_project_keeps_its_agent_and_starts_its_brief_with_the_statement_of_work() {
        let home = std::env::temp_dir().join(format!("yaah-test-agent-{}", crate::session::random_token()));
        ROOT.with(|r| *r.borrow_mut() = Some(home.clone()));
        std::fs::create_dir_all(home.join(".config/yaah")).unwrap();
        // A registry from before agents: it loads, with no agent.
        std::fs::write(
            home.join(".config/yaah/projects.json"),
            r#"{"projects":[{"id":"old1","name":"Old","dirs":[],"status":"ongoing","createdAt":1}]}"#,
        )
        .unwrap();
        let store = Projects::default();
        assert_eq!(store.get("old1").unwrap().agent_id, None);

        let new = NewProject { agent_id: Some("work".into()), statement_of_work: "Ship refunds.\n".into() };
        let p = store.create_with("Refunds", &[], new).unwrap();
        assert_eq!(p.agent_id.as_deref(), Some("work"));
        assert_eq!(store.get(&p.id).unwrap().agent_id.as_deref(), Some("work"), "persisted");
        assert_eq!(store.read_brief(&p.id).unwrap(), "# Refunds\n\n## Statement of work\n\nShip refunds.\n");

        // Changed from the project page, then cleared (back to the sidebar's agent).
        assert_eq!(store.set_agent(&p.id, Some("personal".into())).unwrap().agent_id.as_deref(), Some("personal"));
        assert_eq!(store.set_agent(&p.id, Some(String::new())).unwrap().agent_id, None, "empty is none");
        assert!(store.set_agent("nope", None).is_err());
        let p2 = store.create_with("Blank agent", &[], NewProject { agent_id: Some(String::new()), ..NewProject::default() }).unwrap();
        assert_eq!(p2.agent_id, None);
        assert_eq!(store.read_brief(&p2.id).unwrap(), "# Blank agent\n\n");

        let raw = std::fs::read_to_string(home.join(".config/yaah/projects.json")).unwrap();
        let saved: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert!(saved["projects"].as_array().unwrap().iter().all(|p| p.get("agentId").is_none()), "no `agentId: null`: {raw}");
        store.set_agent(&p.id, Some("work".into())).unwrap();
        let raw = std::fs::read_to_string(home.join(".config/yaah/projects.json")).unwrap();
        assert!(raw.contains(r#""agentId": "work""#) || raw.contains(r#""agentId":"work""#), "{raw}");
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn the_source_block_is_written_refreshed_and_removed() {
        let block = |t: &str| format!("# ENG-142 {t}\n\n**Source:** Linear issue: https://linear.app/x/issue/ENG-142\n");
        // Written into a new project's brief.
        let b = set_source_block("", Some(&block("Refunds")));
        assert_eq!(b, format!("{SOURCE_START}\n{}\n{SOURCE_END}\n", block("Refunds").trim_end()));
        // The user writes below it (and even above it); a refresh keeps both.
        let edited = format!("Above.\n{b}\n## Notes\n\nAsk Ana about cents.\n");
        let refreshed = set_source_block(&edited, Some(&block("Partial refunds")));
        assert!(refreshed.starts_with(&format!("Above.\n{SOURCE_START}\n# ENG-142 Partial refunds")), "{refreshed}");
        assert!(
            refreshed.ends_with("{SOURCE_END}\n\n## Notes\n\nAsk Ana about cents.\n".replace("{SOURCE_END}", SOURCE_END).as_str()),
            "{refreshed}"
        );
        assert_eq!(refreshed.matches(SOURCE_START).count(), 1);
        assert_eq!(set_source_block(&refreshed, Some(&block("Partial refunds"))), refreshed, "refreshing twice changes nothing");
        // A brief that had no block gets one on top.
        let added = set_source_block("# Shop\n\nMine.\n", Some("# X"));
        assert_eq!(added, format!("{SOURCE_START}\n# X\n{SOURCE_END}\n\n# Shop\n\nMine.\n"));
        // Unlinking drops the block and keeps the rest.
        assert_eq!(set_source_block(&refreshed, None), "Above.\n## Notes\n\nAsk Ana about cents.\n");
        assert_eq!(set_source_block(&b, None), "");
        assert_eq!(set_source_block("no block here\n", None), "no block here\n");
        // A start marker without its end isn't a block: nothing after it is eaten.
        let broken = format!("{SOURCE_START}\nhalf\n");
        assert_eq!(set_source_block(&broken, Some("# Y")), format!("{SOURCE_START}\n# Y\n{SOURCE_END}\n\n{broken}"));
    }

    #[test]
    fn links_round_trip_and_old_registries_still_load() {
        let home = std::env::temp_dir().join(format!("yaah-test-link-{}", crate::session::random_token()));
        ROOT.with(|r| *r.borrow_mut() = Some(home.clone()));
        std::fs::create_dir_all(home.join(".config/yaah")).unwrap();
        std::fs::write(
            home.join(".config/yaah/projects.json"),
            r#"{"projects":[{"id":"old1","name":"Old","dirs":[],"status":"ongoing","createdAt":1}]}"#,
        )
        .unwrap();
        let store = Projects::default();
        assert!(store.get("old1").unwrap().link.is_none(), "a project from before links loads");
        let link = ProjectLink {
            service: "github".into(),
            id: "Owner/Repo#12".into(),
            url: "https://github.com/owner/repo/issues/12".into(),
            title: "t".into(),
            linked_at: 5,
            synced_at: 5,
        };
        let p = store.create("Linked", &[]).unwrap();
        store
            .update(&p.id, |p| {
                p.link = Some(link.clone());
                Ok(())
            })
            .unwrap();
        assert_eq!(store.get(&p.id).unwrap().link, Some(link));
        assert_eq!(store.linked("github", "owner/repo#12").unwrap().map(|p| p.id), Some(p.id.clone()));
        assert!(store.linked("gitlab", "owner/repo#12").unwrap().is_none(), "another service's item");
        let raw = std::fs::read_to_string(home.join(".config/yaah/projects.json")).unwrap();
        let saved: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(saved["projects"][1]["link"]["linkedAt"], 5, "{raw}");
        assert!(saved["projects"][0].get("link").is_none(), "no `link: null` for unlinked projects: {raw}");

        store.set_brief_source(&p.id, Some("# Linked block")).unwrap();
        store.set_brief_source(&p.id, None).unwrap();
        assert_eq!(store.read_brief(&p.id).unwrap(), "# Linked\n\n", "an emptied brief gets its title back");
        std::fs::remove_dir_all(&home).unwrap();
    }
}
