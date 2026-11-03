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
    /// The `origin` remote's URL as configured.
    #[serde(skip)]
    pub origin: Option<String>,
    /// A linked worktree (its `.git` is a file), not the main checkout.
    #[serde(skip)]
    pub worktree: bool,
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
    let worktree = !git.is_dir();
    let (head_dir, common_dir) = if worktree {
        let gitdir = std::fs::read_to_string(&git).ok()?;
        let gitdir = dir.join(gitdir.trim().strip_prefix("gitdir:")?.trim());
        let common = std::fs::read_to_string(gitdir.join("commondir")).map_or_else(|_| gitdir.clone(), |c| gitdir.join(c.trim()));
        (gitdir, common)
    } else {
        (git.clone(), git)
    };
    let branch = std::fs::read_to_string(head_dir.join("HEAD")).ok().and_then(|h| h.trim().strip_prefix("ref: refs/heads/").map(str::to_owned));
    let origin = std::fs::read_to_string(common_dir.join("config")).ok().and_then(|c| origin_url(&c));
    Some(Repo {
        name: dir.file_name()?.to_string_lossy().into_owned(),
        path: dir.to_string_lossy().into_owned(),
        remote: origin.as_deref().map(short_remote),
        branch,
        worktree,
        origin,
    })
}

/// The host and path of a git remote URL, lowercased, without `.git` or slashes
/// around the path: `https://github.com/o/r.git`, `git@github.com:o/r`,
/// `ssh://git@host:2222/group/sub/proj.git` and `https://user@host/o/r/` all work.
pub fn remote_host_path(url: &str) -> Option<(String, String)> {
    let url = url.trim();
    let (host, path) = if let Some((scheme, rest)) = url.split_once("://") {
        if !matches!(scheme, "https" | "http" | "ssh" | "git" | "git+ssh" | "ssh+git") {
            return None;
        }
        let (authority, path) = rest.split_once('/')?;
        let host = authority.rsplit('@').next()?;
        // An `ssh://host:port` port, or an `https://host:8443` one.
        (host.split(':').next()?, path)
    } else {
        // scp-like: `[user@]host:path` (a `:` before any `/`).
        let (before, path) = url.split_once(':')?;
        if before.contains('/') {
            return None;
        }
        (before.rsplit('@').next()?, path)
    };
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path).trim_end_matches('/');
    if host.is_empty() || path.is_empty() {
        return None;
    }
    Some((host.to_lowercase(), path.to_lowercase()))
}

/// The repos whose `origin` is `path` (`owner/repo`, `group/sub/proj`) on `host`.
/// Main checkouts win; worktrees of it count only when there's no main checkout.
pub fn matching<'a>(repos: &'a [Repo], host: &str, path: &str) -> Vec<&'a Repo> {
    let want = (host.to_lowercase(), path.trim_matches('/').to_lowercase());
    let all: Vec<&Repo> = repos.iter().filter(|r| r.origin.as_deref().and_then(remote_host_path).is_some_and(|hp| hp == want)).collect();
    if all.iter().any(|r| !r.worktree) { all.into_iter().filter(|r| !r.worktree).collect() } else { all }
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
    fn remote_hosts_and_paths() {
        let gh = Some(("github.com".to_owned(), "supabase/realtime".to_owned()));
        for url in [
            "https://github.com/supabase/realtime",
            "https://github.com/supabase/realtime.git",
            "https://github.com/Supabase/Realtime/",
            "https://x-access-token@github.com/supabase/realtime.git",
            "git@github.com:supabase/realtime.git",
            "git@github.com:/supabase/realtime",
            "ssh://git@github.com/supabase/realtime.git",
            "ssh://git@github.com:22/supabase/realtime",
            "github.com:supabase/realtime",
        ] {
            assert_eq!(remote_host_path(url), gh, "{url}");
        }
        assert_eq!(
            remote_host_path("ssh://git@gitlab.example.com:2222/group/sub/proj.git"),
            Some(("gitlab.example.com".into(), "group/sub/proj".into()))
        );
        assert_eq!(remote_host_path("https://gitlab.example.com:8443/group/proj"), Some(("gitlab.example.com".into(), "group/proj".into())));
        for bad in ["", "/local/path/repo", "../relative", "file:///srv/repo.git", "https://github.com", "git@github.com:"] {
            assert_eq!(remote_host_path(bad), None, "{bad}");
        }
    }

    #[test]
    fn matches_repos_by_origin_preferring_main_checkouts() {
        let repo = |path: &str, origin: &str, worktree: bool| Repo {
            name: path.into(),
            path: path.into(),
            remote: None,
            branch: None,
            origin: Some(origin.into()),
            worktree,
        };
        let all = [
            repo("/w/shop", "https://github.com/Acme/Shop.git", false),
            repo("/w/shop-wt", "https://github.com/Acme/Shop.git", true),
            repo("/w/fork", "git@github.com:me/shop.git", false),
            repo("/w/api", "ssh://git@gitlab.example.com:2222/team/sub/api.git", false),
        ];
        let paths = |found: Vec<&Repo>| found.iter().map(|r| r.path.clone()).collect::<Vec<_>>();
        assert_eq!(paths(matching(&all, "github.com", "acme/shop")), ["/w/shop"], "the worktree is left out next to its main checkout");
        assert_eq!(paths(matching(&all[1..], "GitHub.com", "Acme/Shop/")), ["/w/shop-wt"], "a worktree alone still counts");
        assert_eq!(paths(matching(&all, "gitlab.example.com", "team/sub/api")), ["/w/api"]);
        assert!(matching(&all, "gitlab.com", "team/sub/api").is_empty(), "another host");
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
