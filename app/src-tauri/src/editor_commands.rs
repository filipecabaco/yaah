//! The editor pane's commands: a folder's files (list, read, write, create, find) and its
//! repository's Source Control (`sources/git/editor.rs`).
//!
//! Every path is relative to the pane's folder (`root`, checked like a terminal's) and is
//! resolved inside it: no absolute paths, no `..`, and the real path (symlinks followed) must
//! stay under the folder's real path, so a link can't lead a read or a write out of it.
//! A write names the version of the file it replaces (`version`, from the read): when the file
//! changed on disk since, it's refused with [`CHANGED`] and the pane asks before overwriting.
#![allow(clippy::needless_pass_by_value, reason = "Tauri hands commands their arguments by value")]

use crate::files;
use crate::sources::git::editor as git;
use crate::terminals;
use serde::Serialize;
use serde_json::{Value, json};
use std::path::{Component, Path, PathBuf};

/// Files past this open read-only in a note rather than in the editor.
const MAX_READ: u64 = 8 << 20;
/// Entries one folder lists, at most.
const MAX_ENTRIES: usize = 5000;
/// Folders never listed: git's own.
const HIDDEN: &[&str] = &[".git"];
/// The start of the error a write gets when the file moved on since it was read.
pub const CHANGED: &str = "changed on disk";

/// `rel` under `root` (both already real), without following anything yet: relative, no `..`.
fn joined(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.contains('\0') || rel.len() > 4096 {
        return Err("not a path".into());
    }
    let p = Path::new(rel);
    if p.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
        return Err(format!("`{rel}` must be a path inside the folder"));
    }
    Ok(root.join(p))
}

/// `rel` under `root`, existing, whose real path stays inside `root`.
fn inside(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let resolved = joined(root, rel)?.canonicalize().map_err(|_| format!("{rel} doesn't exist"))?;
    if !resolved.starts_with(root) {
        return Err(format!("{rel} leads outside the folder"));
    }
    Ok(resolved)
}

/// A file's version: its size and modified time, enough to see it changed under the editor.
fn version(meta: &std::fs::Metadata) -> String {
    let nanos = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
    format!("{}:{nanos}", meta.len())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    /// Relative to the pane's folder, `/`-separated.
    path: String,
    dir: bool,
    /// A link (shown, opened only when it leads inside the folder).
    link: bool,
}

/// What a folder of the pane's folder holds: folders first, then files, by name, `.git` left out.
#[tauri::command]
pub fn editor_list(root: String, dir: String) -> Result<Vec<Entry>, String> {
    let root = terminals::checked_dir(&root)?;
    let at = if dir.is_empty() { root.clone() } else { inside(&root, &dir)? };
    let mut out = vec![];
    for e in std::fs::read_dir(&at).map_err(|e| format!("couldn't list {dir}: {e}"))?.filter_map(Result::ok).take(MAX_ENTRIES) {
        let name = e.file_name().to_string_lossy().into_owned();
        if HIDDEN.contains(&name.as_str()) {
            continue;
        }
        let Ok(kind) = e.file_type() else { continue };
        let link = kind.is_symlink();
        // A link counts as a folder when it leads to one inside the pane's folder.
        let is_dir = kind.is_dir() || (link && e.path().canonicalize().is_ok_and(|r| r.is_dir() && r.starts_with(&root)));
        let path = if dir.is_empty() { name.clone() } else { format!("{}/{name}", dir.trim_end_matches('/')) };
        out.push(Entry { name, path, dir: is_dir, link });
    }
    out.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

/// A file's text and version. `binary` or `tooLarge` files come back without text.
#[tauri::command]
pub fn editor_read(root: String, path: String) -> Result<Value, String> {
    let root = terminals::checked_dir(&root)?;
    let file = inside(&root, &path)?;
    let meta = std::fs::metadata(&file).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err(format!("{path} isn't a file"));
    }
    let readonly = meta.permissions().readonly();
    if meta.len() > MAX_READ {
        return Ok(json!({ "text": "", "binary": false, "tooLarge": true, "size": meta.len(), "version": version(&meta), "readonly": true }));
    }
    let bytes = std::fs::read(&file).map_err(|e| format!("couldn't read {path}: {e}"))?;
    if bytes.iter().take(8000).any(|b| *b == 0) {
        return Ok(json!({ "text": "", "binary": true, "tooLarge": false, "size": meta.len(), "version": version(&meta), "readonly": true }));
    }
    let text = String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
    Ok(json!({ "text": text, "binary": false, "tooLarge": false, "size": meta.len(), "version": version(&meta), "readonly": readonly }))
}

/// Save `text` to an existing file, when it's still at `version` (none: overwrite whatever is
/// there). In place, so the file keeps its permissions, owner and links. Its new version.
#[tauri::command]
pub fn editor_write(root: String, path: String, text: String, version: Option<String>) -> Result<String, String> {
    let root = terminals::checked_dir(&root)?;
    let file = inside(&root, &path)?;
    let meta = std::fs::metadata(&file).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err(format!("{path} isn't a file"));
    }
    if let Some(v) = version
        && v != self::version(&meta)
    {
        return Err(format!("{CHANGED}: {path} was changed by something else since it was opened"));
    }
    std::fs::write(&file, text).map_err(|e| format!("couldn't save {path}: {e}"))?;
    std::fs::metadata(&file).map(|m| self::version(&m)).map_err(|e| e.to_string())
}

/// A new empty file or folder at `path`, its parent folder inside the pane's. Refused when something is there.
#[tauri::command]
pub fn editor_create(root: String, path: String, dir: bool) -> Result<(), String> {
    let root = terminals::checked_dir(&root)?;
    let target = joined(&root, &path)?;
    let (Some(parent), Some(name)) = (target.parent(), target.file_name()) else { return Err("not a path".into()) };
    if name.to_string_lossy().trim().is_empty() {
        return Err("a name is needed".into());
    }
    // Parent folders are made as needed, as VS Code does for `a/b/c.txt`. Before any is made, the
    // deepest one that exists must really be inside (a linked folder can't lead the rest out).
    let existing = parent.ancestors().find(|a| a.exists()).ok_or_else(|| "not a path".to_owned())?;
    if !existing.canonicalize().is_ok_and(|r| r.starts_with(&root)) {
        return Err(format!("{path} leads outside the folder"));
    }
    std::fs::create_dir_all(parent).map_err(|e| format!("couldn't make the folders for {path}: {e}"))?;
    let rel_parent = parent.strip_prefix(&root).map_err(|_| "not a path".to_owned())?.to_string_lossy().into_owned();
    let parent = if rel_parent.is_empty() { root.clone() } else { inside(&root, &rel_parent)? };
    let target = parent.join(name);
    if std::fs::symlink_metadata(&target).is_ok() {
        return Err(format!("{path} already exists"));
    }
    if dir {
        std::fs::create_dir(&target).map_err(|e| format!("couldn't make {path}: {e}"))
    } else {
        std::fs::OpenOptions::new().write(true).create_new(true).open(&target).map(drop).map_err(|e| format!("couldn't make {path}: {e}"))
    }
}

/// Quick open (⌘P): files of the folder whose path matches `query` fuzzily.
#[tauri::command]
pub async fn editor_find(root: String, query: String) -> Result<Vec<files::FileMatch>, String> {
    let root = terminals::checked_dir(&root)?;
    tokio::task::spawn_blocking(move || files::search(std::slice::from_ref(&root), &query, 60)).await.map_err(|e| e.to_string())
}

// ── Source Control ──────────────────────────────────────────────────────────

/// The repository the pane's folder is in, or an error the view shows.
async fn repo(cwd: &str) -> Result<PathBuf, String> {
    let dir = terminals::checked_dir(cwd)?;
    git::repo_root(&dir).await?.ok_or_else(|| format!("{cwd} isn't in a git repository"))
}

/// The Source Control view (`{ "repo": null }` outside a repository). `since`: the last fingerprint.
#[tauri::command]
pub async fn editor_git_status(cwd: String, since: Option<String>) -> Result<Value, String> {
    let dir = terminals::checked_dir(&cwd)?;
    let Some(root) = git::repo_root(&dir).await? else { return Ok(json!({ "repo": null })) };
    let mut v = git::status_view(&root, since.as_deref()).await?;
    v["repo"] = json!(true);
    // Where the pane's folder sits in the repository (`""` at its top), both real paths: how the
    // view turns a change's path into one of its own files.
    let real_root = root.canonicalize().unwrap_or_else(|_| root.clone());
    v["prefix"] = json!(dir.strip_prefix(&real_root).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default());
    if v["unchanged"] != json!(true) {
        v["hasCommits"] = json!(git::has_commits(&root).await);
    }
    Ok(v)
}

/// A file as HEAD or the index has it (`side`), `null` when it isn't there. `path`: relative to the repository.
#[tauri::command]
pub async fn editor_git_file(cwd: String, path: String, side: String) -> Result<Option<Value>, String> {
    git::file_at(&repo(&cwd).await?, &path, &side).await
}

#[tauri::command]
pub async fn editor_git_stage(cwd: String, paths: Vec<String>) -> Result<(), String> {
    git::stage(&repo(&cwd).await?, &paths).await
}

#[tauri::command]
pub async fn editor_git_unstage(cwd: String, paths: Vec<String>) -> Result<(), String> {
    git::unstage(&repo(&cwd).await?, &paths).await
}

/// Throw away the work tree's changes to `paths` (untracked ones are deleted). The view asks first.
#[tauri::command]
pub async fn editor_git_discard(cwd: String, paths: Vec<String>) -> Result<(), String> {
    git::discard(&repo(&cwd).await?, &paths).await
}

/// Commit; the new commit's short id.
#[tauri::command]
pub async fn editor_git_commit(cwd: String, message: String, all: bool, amend: bool) -> Result<String, String> {
    git::commit(&repo(&cwd).await?, &message, all, amend).await
}

#[tauri::command]
pub async fn editor_git_graph(cwd: String, upstream: Option<String>, limit: Option<u64>) -> Result<Value, String> {
    git::graph(&repo(&cwd).await?, upstream.as_deref(), limit).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("yaah-editor-{}", crate::session::random_token()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/main.rs"), "fn main() {}\n").unwrap();
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        dir.canonicalize().unwrap()
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn lists_folders_first_without_git() {
        let dir = temp();
        std::fs::write(dir.join("README.md"), "hi").unwrap();
        let names: Vec<_> = editor_list(s(&dir), String::new()).unwrap().into_iter().map(|e| (e.path, e.dir)).collect();
        assert_eq!(names, vec![("src".into(), true), ("README.md".into(), false)]);
        let inner: Vec<_> = editor_list(s(&dir), "src".into()).unwrap().into_iter().map(|e| e.path).collect();
        assert_eq!(inner, vec!["src/main.rs"]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reads_and_writes_with_a_version_check() {
        let dir = temp();
        let r = editor_read(s(&dir), "src/main.rs".into()).unwrap();
        assert_eq!(r["text"], "fn main() {}\n");
        let v = r["version"].as_str().unwrap().to_owned();
        let v2 = editor_write(s(&dir), "src/main.rs".into(), "fn main() { 1; }\n".into(), Some(v.clone())).unwrap();
        assert_ne!(v, v2);
        let stale = editor_write(s(&dir), "src/main.rs".into(), "lost".into(), Some(v)).unwrap_err();
        assert!(stale.starts_with(CHANGED), "{stale}");
        editor_write(s(&dir), "src/main.rs".into(), "forced\n".into(), None).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("src/main.rs")).unwrap(), "forced\n");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn binary_files_come_without_text() {
        let dir = temp();
        std::fs::write(dir.join("img.bin"), [0u8, 1, 2]).unwrap();
        let r = editor_read(s(&dir), "img.bin".into()).unwrap();
        assert_eq!(r["binary"], true);
        assert_eq!(r["text"], "");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn never_leaves_the_folder() {
        let dir = temp();
        let outside = std::env::temp_dir().join(format!("yaah-editor-out-{}", crate::session::random_token()));
        std::fs::write(&outside, "secret").unwrap();
        for bad in ["../x", "/etc/passwd", "src/../../x"] {
            assert!(editor_read(s(&dir), bad.into()).is_err(), "{bad}");
            assert!(editor_write(s(&dir), bad.into(), "x".into(), None).is_err(), "{bad}");
            assert!(editor_create(s(&dir), bad.into(), false).is_err(), "{bad}");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, dir.join("link")).unwrap();
            assert!(editor_read(s(&dir), "link".into()).unwrap_err().contains("outside"));
            assert!(editor_write(s(&dir), "link".into(), "pwned".into(), None).is_err());
            assert_eq!(std::fs::read_to_string(&outside).unwrap(), "secret");
            std::os::unix::fs::symlink(std::env::temp_dir(), dir.join("dirlink")).unwrap();
            assert!(editor_create(s(&dir), "dirlink/escape.txt".into(), false).is_err(), "a linked parent can't lead out");
            assert!(editor_list(s(&dir), "dirlink".into()).is_err());
        }
        std::fs::remove_file(outside).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn creates_files_and_folders_once() {
        let dir = temp();
        editor_create(s(&dir), "lib/new/mod.rs".into(), false).unwrap();
        assert!(dir.join("lib/new/mod.rs").is_file());
        assert!(editor_create(s(&dir), "lib/new/mod.rs".into(), false).unwrap_err().contains("exists"));
        editor_create(s(&dir), "docs".into(), true).unwrap();
        assert!(dir.join("docs").is_dir());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
