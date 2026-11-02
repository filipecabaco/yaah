//! Finding and cloning git repos so they can be added to a project.
//!
//! Repos are discovered under "workspace roots" (folders where the user keeps
//! their checkouts), saved in `~/.config/yaah/settings.json`. When none are
//! saved, common locations that exist are used.

use crate::accounts::home;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;

/// How deep below a root to look for repos (root/org/repo is depth 2).
const MAX_DEPTH: usize = 3;
const MAX_REPOS: usize = 2000;
const SKIP: &[&str] = &["node_modules", "target", "_build", "deps", "dist", "build", "vendor", "Library"];
const GUESSES: &[&str] = &["Documents/workspace", "workspace", "code", "src", "projects", "dev", "Developer", "repos", "git"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub name: String,
    pub path: String,
    /// `owner/repo` (or the raw URL) of the `origin` remote.
    pub remote: Option<String>,
    pub branch: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default)]
    workspace_roots: Vec<String>,
    /// Everything else in settings.json (appearance, …), kept as is when roots are saved.
    #[serde(flatten)]
    rest: serde_json::Map<String, serde_json::Value>,
}

fn settings_path() -> PathBuf {
    home().join(".config/yaah/settings.json")
}

fn load_settings() -> Settings {
    std::fs::read_to_string(settings_path()).ok().and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default()
}

pub fn roots() -> Vec<String> {
    let saved = load_settings().workspace_roots;
    if !saved.is_empty() {
        return saved;
    }
    let home = home();
    GUESSES.iter().map(|g| home.join(g)).filter(|p| p.is_dir()).map(|p| p.to_string_lossy().into_owned()).take(1).collect()
}

pub fn set_roots(roots: Vec<String>) -> Result<Vec<String>, String> {
    for r in &roots {
        if !Path::new(r).is_dir() {
            return Err(format!("{r} is not a folder"));
        }
    }
    // Through the settings file's lock, so a theme change at the same moment can't undo this (or the reverse).
    crate::settings::file().update(|all: &mut serde_json::Map<String, serde_json::Value>| {
        all.insert("workspaceRoots".into(), serde_json::json!(roots));
        Ok(())
    })?;
    Ok(roots)
}

/// Every git repo under `roots`, sorted by name. Doesn't descend into repos.
pub fn scan(roots: &[String]) -> Vec<Repo> {
    let mut found = vec![];
    for root in roots {
        walk(Path::new(root), 0, &mut found);
    }
    found.sort_by_key(|r| r.name.to_lowercase());
    found.dedup_by(|a, b| a.path == b.path);
    found
}

fn walk(dir: &Path, depth: usize, found: &mut Vec<Repo>) {
    if found.len() >= MAX_REPOS {
        return;
    }
    if let Some(repo) = describe(dir) {
        found.push(repo);
        return;
    }
    if depth >= MAX_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.filter_map(Result::ok) {
        let name = e.file_name();
        let name = name.to_string_lossy();
        // file_type() doesn't follow symlinks, so linked folders can't loop us.
        if name.starts_with('.') || SKIP.contains(&name.as_ref()) || !e.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        walk(&e.path(), depth + 1, found);
    }
}

/// A repo's name, origin remote and current branch, if `dir` is a repo root.
pub fn describe(dir: &Path) -> Option<Repo> {
    let git = dir.join(".git");
    if !git.exists() {
        return None;
    }
    // A worktree's `.git` is a file: `gitdir: <main>/.git/worktrees/<name>`. HEAD
    // lives there; the config lives in the main repo's .git (its `commondir`).
    let (head_dir, common_dir) = if git.is_dir() {
        (git.clone(), git)
    } else {
        let gitdir = std::fs::read_to_string(&git).ok()?;
        let gitdir = dir.join(gitdir.trim().strip_prefix("gitdir:")?.trim());
        let common = std::fs::read_to_string(gitdir.join("commondir")).map_or_else(|_| gitdir.clone(), |c| gitdir.join(c.trim()));
        (gitdir, common)
    };
    let branch = std::fs::read_to_string(head_dir.join("HEAD")).ok().and_then(|h| h.trim().strip_prefix("ref: refs/heads/").map(str::to_owned));
    let remote = std::fs::read_to_string(common_dir.join("config")).ok().and_then(|c| origin_url(&c)).map(|u| short_remote(&u));
    Some(Repo { name: dir.file_name()?.to_string_lossy().into_owned(), path: dir.to_string_lossy().into_owned(), remote, branch })
}

fn origin_url(config: &str) -> Option<String> {
    let mut in_origin = false;
    for line in config.lines().map(str::trim) {
        if line.starts_with('[') {
            in_origin = line == "[remote \"origin\"]";
        } else if in_origin && let Some(url) = line.strip_prefix("url") {
            return Some(url.trim_start_matches([' ', '=']).trim().to_owned());
        }
    }
    None
}

/// `git@github.com:owner/repo.git` / `https://github.com/owner/repo` → `owner/repo`.
fn short_remote(url: &str) -> String {
    let path = url.split_once("github.com").or_else(|| url.split_once("gitlab.com")).map(|(_, rest)| rest.trim_start_matches([':', '/']));
    match path {
        Some(p) => p.trim_end_matches('/').trim_end_matches(".git").to_owned(),
        None => url.to_owned(),
    }
}

/// Clone `source` (`owner/repo`, or any git URL) into `root`. `owner/repo`
/// goes through `gh` when it's installed so the user's protocol choice
/// (SSH vs HTTPS) applies, otherwise GitHub over HTTPS.
pub async fn clone(source: &str, root: &str) -> Result<Repo, String> {
    let source = source.trim();
    let shorthand = is_shorthand(source);
    let name = source
        .trim_end_matches('/')
        .rsplit(['/', ':'])
        .next()
        .map(|n| n.trim_end_matches(".git"))
        .filter(|n| !n.is_empty() && *n != "." && *n != "..")
        .ok_or("can't tell the repo name from that")?
        .to_owned();
    let root = Path::new(root);
    if !root.is_absolute() || !root.is_dir() {
        return Err(format!("{} is not a folder", root.display()));
    }
    let dest = root.join(&name);
    // symlink_metadata: a dangling link there counts as taken too.
    if dest.symlink_metadata().is_ok() {
        return Err(format!("{} already exists", dest.display()));
    }
    let dest_str = dest.to_string_lossy().into_owned();

    let mut cmd = if shorthand && crate::path_env::which("gh").is_some() {
        let mut c = crate::path_env::tokio_command("gh");
        c.args(["repo", "clone", source, &dest_str]);
        c
    } else {
        let url = if shorthand { format!("https://github.com/{source}.git") } else { source.to_owned() };
        let mut c = crate::path_env::tokio_command("git");
        c.args(["clone", "--", &url, &dest_str]);
        c
    };
    // Never hang waiting for a credentials prompt nobody can see.
    cmd.env("GIT_TERMINAL_PROMPT", "0").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());

    let out = cmd.output().await.map_err(|e| format!("failed to run clone: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let last = err.lines().rfind(|l| !l.trim().is_empty()).unwrap_or("clone failed");
        return Err(last.trim().to_owned());
    }
    describe(&dest).ok_or_else(|| "cloned, but the folder isn't a git repo".into())
}

/// `owner/repo`. Neither part may start with `-`, so `gh` can't read one as a flag.
fn is_shorthand(s: &str) -> bool {
    let mut parts = s.split('/');
    let ok = |p: Option<&str>| {
        p.is_some_and(|p| !p.is_empty() && !p.starts_with('-') && p.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)))
    };
    ok(parts.next()) && ok(parts.next()) && parts.next().is_none() && !s.contains(':')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_remotes() {
        assert_eq!(short_remote("git@github.com:supabase/realtime.git"), "supabase/realtime");
        assert_eq!(short_remote("https://github.com/supabase/realtime"), "supabase/realtime");
        assert_eq!(short_remote("https://example.org/x.git"), "https://example.org/x.git");
    }

    #[test]
    fn origin_from_config() {
        let cfg =
            "[core]\n\tbare = false\n[remote \"upstream\"]\n\turl = git@github.com:a/b.git\n[remote \"origin\"]\n\turl = git@github.com:me/b.git\n";
        assert_eq!(origin_url(cfg).as_deref(), Some("git@github.com:me/b.git"));
    }

    #[test]
    fn shorthand_detection() {
        assert!(is_shorthand("supabase/realtime"));
        assert!(!is_shorthand("git@github.com:supabase/realtime.git"));
        assert!(!is_shorthand("https://github.com/supabase/realtime"));
        assert!(!is_shorthand("realtime"));
        assert!(!is_shorthand("--upload-pack=x/y") && !is_shorthand("a/-b"), "nothing gh could read as a flag");
    }

    fn git(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git").args(args).current_dir(dir).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// Scanning finds repos and worktrees (not inside them), and cloning lands
    /// in the chosen root without overwriting anything.
    #[test]
    fn scans_and_clones_local_repos() {
        let root = std::env::temp_dir().join(format!("yaah-repos-{}", crate::session::random_token()));
        let origin = root.join("org/origin");
        std::fs::create_dir_all(&origin).unwrap();
        git(&origin, &["init", "-q", "-b", "trunk"]);
        git(&origin, &["remote", "add", "origin", "git@github.com:me/origin.git"]);
        git(&origin, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"]);
        git(&origin, &["worktree", "add", "-q", "-b", "side", "../origin-side"]);
        std::fs::create_dir_all(root.join("node_modules/dep/.git")).unwrap();
        std::fs::create_dir_all(root.join("a/b/c/d/deep/.git")).unwrap();

        let found = scan(&[root.to_string_lossy().into_owned()]);
        let names: Vec<(&str, Option<&str>, Option<&str>)> =
            found.iter().map(|r| (r.name.as_str(), r.remote.as_deref(), r.branch.as_deref())).collect();
        assert_eq!(
            names,
            [("origin", Some("me/origin"), Some("trunk")), ("origin-side", Some("me/origin"), Some("side"))],
            "skips node_modules and too-deep folders"
        );

        let dest = root.join("clones");
        std::fs::create_dir_all(&dest).unwrap();
        let clone_into = |source: &str, into: &Path| tauri::async_runtime::block_on(clone(source, &into.to_string_lossy()));
        let cloned = clone_into(&origin.to_string_lossy(), &dest).unwrap();
        assert_eq!((cloned.name.as_str(), cloned.branch.as_deref()), ("origin", Some("trunk")));
        assert!(clone_into(&origin.to_string_lossy(), &dest).unwrap_err().contains("already exists"));
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("nowhere"), dest.join("dangling")).unwrap();
        assert!(clone_into("/x/dangling", &dest).unwrap_err().contains("already exists"), "a dangling link is taken too");
        assert!(clone_into(&origin.to_string_lossy(), Path::new("relative")).is_err());
        assert!(clone_into("..", &dest).is_err() && clone_into("/", &dest).is_err());
        assert!(clone_into(&root.join("missing").to_string_lossy(), &dest).is_err(), "git's error comes back");
        std::fs::remove_dir_all(root).unwrap();
    }
}
