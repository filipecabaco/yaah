//! Projects: a named unit of work grouping one or more folders.
//!
//! A project has a status lifecycle,
//! a list of folders, and a context folder (`~/.yaah/projects/<id>/`) holding
//! `project.md`, the brief every chat in the project starts from.
//!
//! The registry lives in `~/.config/yaah/projects.json`.

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
            std::fs::write(&brief, format!("# {name}\n\n")).map_err(|e| format!("write {}: {e}", brief.display()))?;
        }

        let project = Project {
            id,
            name,
            dirs,
            status: Status::Ongoing,
            created_at: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs(),
            context_dir: ctx.to_string_lossy().into_owned(),
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
mod tests {
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
}
