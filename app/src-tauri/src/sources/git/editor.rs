//! Git for the editor pane: its Source Control view (status split into staged and
//! unstaged, a fingerprint to poll with), the file as HEAD or the index has it (the
//! left side of a split diff), a commit graph, and the few writes the view offers:
//! stage, unstage, discard and commit.
//!
//! Reads go through the parent's hardened runner ([`super::git`]). Writes are the
//! user's own actions on their own repository, so they run git as the user would
//! from a terminal (their hooks, their signing config) but still with no shell, no
//! prompt, a timeout, and paths validated and placed after `--`.

use super::{MAX_TEXT, fingerprint, git, has_head, text, valid_path, valid_rev, whole_lines};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;

/// A commit (its hooks) or a stage of a big tree past this is stopped.
const WRITE_TIMEOUT: Duration = Duration::from_secs(120);
/// Files a status lists, at most (a fresh `node_modules` outside `.gitignore` can be huge).
const MAX_STATUS_FILES: usize = 5000;
/// Commits the graph shows, at most.
const MAX_GRAPH: u64 = 500;
/// Paths one stage, unstage or discard takes.
const MAX_WRITE_PATHS: usize = 2000;
/// A commit message past this isn't one.
const MAX_MESSAGE: usize = 64 << 10;

/// The repository `cwd` is in: its top folder, or `None` outside any.
pub(crate) async fn repo_root(cwd: &Path) -> Result<Option<PathBuf>, String> {
    match git(cwd, &["rev-parse", "--show-toplevel"], 4096).await {
        Ok(out) => Ok(Some(PathBuf::from(text(out.stdout).trim()))),
        Err(e) if e.starts_with("not a git repository") => Ok(None),
        Err(e) => Err(e),
    }
}

/// `XY` of a porcelain v2 entry as single letters, VS Code style (`M`, `A`, `D`, `R`, `C`, `T`, `U`), `None` for `.`.
fn letter(c: char) -> Option<char> {
    matches!(c, 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U').then_some(c)
}

/// The Source Control view of the repository at `root`: branch, upstream and how far ahead or
/// behind, and every changed file once per side (`staged`: in the index; `changes`: in the work
/// tree, untracked included; `conflicts`: unmerged). With `since` equal to the fingerprint only
/// the fingerprint comes back (`unchanged`), so polling a quiet repo costs one `git status`.
pub(crate) async fn status_view(root: &Path, since: Option<&str>) -> Result<Value, String> {
    let out = git(root, &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], MAX_TEXT).await?;
    let raw = text(out.stdout);
    let fp = fingerprint(root, &raw, &["editor"]);
    if since == Some(fp.as_str()) {
        return Ok(json!({ "fingerprint": fp, "unchanged": true }));
    }
    let (mut branch, mut oid, mut upstream, mut ahead, mut behind) = (Value::Null, Value::Null, Value::Null, 0i64, 0i64);
    let (mut staged, mut changes, mut conflicts) = (vec![], vec![], vec![]);
    let mut tokens = raw.split('\0');
    let mut listed = 0usize;
    while let Some(line) = tokens.next() {
        if let Some(h) = line.strip_prefix("# branch.head ") {
            branch = if h == "(detached)" { Value::Null } else { json!(h) };
        } else if let Some(o) = line.strip_prefix("# branch.oid ") {
            oid = if o == "(initial)" { Value::Null } else { json!(o) };
        } else if let Some(u) = line.strip_prefix("# branch.upstream ") {
            upstream = json!(u);
        } else if let Some(ab) = line.strip_prefix("# branch.ab ") {
            for n in ab.split_whitespace() {
                if let Some(a) = n.strip_prefix('+') {
                    ahead = a.parse().unwrap_or(0);
                } else if let Some(b) = n.strip_prefix('-') {
                    behind = b.parse().unwrap_or(0);
                }
            }
        } else if listed >= MAX_STATUS_FILES {
            if line.starts_with('2') {
                tokens.next();
            }
        } else if let Some(path) = line.strip_prefix("? ") {
            listed += 1;
            changes.push(json!({ "path": path, "status": "U", "untracked": true }));
        } else if line.starts_with("u ") {
            listed += 1;
            let path = line.splitn(11, ' ').nth(10).unwrap_or_default();
            conflicts.push(json!({ "path": path, "status": "!" }));
        } else if line.starts_with("1 ") || line.starts_with("2 ") {
            listed += 1;
            let fields = if line.starts_with('1') { 8 } else { 9 };
            let parts: Vec<&str> = line.splitn(fields + 1, ' ').collect();
            let (Some(xy), Some(path)) = (parts.get(1), parts.get(fields)) else { continue };
            let old = line.starts_with('2').then(|| tokens.next().unwrap_or_default());
            let mut xy = xy.chars();
            let (x, y) = (xy.next().unwrap_or('.'), xy.next().unwrap_or('.'));
            let entry = |s: char| {
                let mut e = json!({ "path": path, "status": s.to_string() });
                if let Some(o) = old.filter(|_| s == 'R' || s == 'C') {
                    e["oldPath"] = json!(o);
                }
                e
            };
            if let Some(s) = letter(x) {
                staged.push(entry(s));
            }
            if let Some(s) = letter(y) {
                changes.push(entry(s));
            }
        }
    }
    Ok(json!({
        "fingerprint": fp,
        "root": root.to_string_lossy(),
        "name": root.file_name().map_or_else(|| root.to_string_lossy().into_owned(), |n| n.to_string_lossy().into_owned()),
        "branch": branch,
        "detached": branch.is_null() && !oid.is_null(),
        "oid": oid,
        "upstream": upstream,
        "ahead": ahead,
        "behind": behind,
        "staged": staged,
        "changes": changes,
        "conflicts": conflicts,
        "truncated": listed >= MAX_STATUS_FILES,
    }))
}

/// File `rel` (relative to the repository's top folder) as `HEAD` or the index (`INDEX`) has it:
/// `None` when it isn't there (a new file). The left side of a split diff. Stored bytes, no filters.
pub(crate) async fn file_at(root: &Path, rel: &str, side: &str) -> Result<Option<Value>, String> {
    let rel = valid_path(rel)?;
    let object = match side {
        "HEAD" => {
            if !has_head(root).await? {
                return Ok(None);
            }
            format!("HEAD:{rel}")
        }
        "INDEX" => format!(":{rel}"),
        other => return Err(format!("unknown side `{other}` (HEAD or INDEX)")),
    };
    let Ok(out) = git(root, &["cat-file", "blob", "--end-of-options", &object], MAX_TEXT).await else { return Ok(None) };
    let binary = out.stdout.iter().take(8000).any(|b| *b == 0);
    let truncated = out.truncated;
    let mut body = if binary { String::new() } else { text(out.stdout) };
    if truncated {
        whole_lines(&mut body);
    }
    Ok(Some(json!({ "text": body, "binary": binary, "truncated": truncated })))
}

/// The commit graph for `HEAD` (and `upstream`, when it names one): newest first in topological
/// order, each commit with its parents and the refs that point at it, for the view to lay out lanes.
pub(crate) async fn graph(root: &Path, upstream: Option<&str>, limit: Option<u64>) -> Result<Value, String> {
    let limit = limit.unwrap_or(200).clamp(1, MAX_GRAPH);
    let max = format!("--max-count={limit}");
    let mut args =
        vec!["log", "--no-color", "-z", "--topo-order", &max, "--format=%H%x1f%P%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%D", "--end-of-options", "HEAD"];
    let upstream = upstream.map(valid_rev).transpose()?;
    args.extend(upstream);
    args.push("--");
    let out = match git(root, &args, MAX_TEXT).await {
        Ok(out) => out,
        // A repository with no commits has no graph; an upstream that went away leaves HEAD's.
        Err(e) if e.contains("does not have any commits yet") || e == "unknown revision `HEAD`" => return Ok(json!([])),
        Err(e) if upstream.is_some() && e.starts_with("unknown revision") => return Box::pin(graph(root, None, Some(limit))).await,
        Err(e) => return Err(e),
    };
    let commits: Vec<Value> = text(out.stdout)
        .split('\0')
        .filter(|c| !c.trim().is_empty())
        .filter_map(|c| {
            let f: Vec<&str> = c.trim_start_matches('\n').splitn(7, '\u{1f}').collect();
            (f.len() == 7).then(|| {
                let refs: Vec<&str> = f[6].split(", ").map(str::trim).filter(|r| !r.is_empty()).collect();
                json!({
                    "sha": f[0],
                    "parents": f[1].split_whitespace().collect::<Vec<_>>(),
                    "short": f[2],
                    "author": f[3],
                    "date": f[4],
                    "subject": f[5],
                    "refs": refs,
                })
            })
        })
        .collect();
    Ok(Value::Array(commits))
}

// ── writes ──────────────────────────────────────────────────────────────────

/// Paths for a write: relative to the repository, inside it, not too many.
fn write_paths(paths: &[String]) -> Result<Vec<&str>, String> {
    if paths.is_empty() {
        return Err("no files given".into());
    }
    if paths.len() > MAX_WRITE_PATHS {
        return Err(format!("{} files at once; at most {MAX_WRITE_PATHS}", paths.len()));
    }
    paths.iter().map(|p| valid_path(p)).collect()
}

/// `git <args>` in `root` the way the user would run it (their config, hooks and signing), with
/// stdin from `input`, no prompt, and a timeout. Its stdout, or its complaint.
async fn git_write(root: &Path, args: &[&str], input: Option<&str>) -> Result<String, String> {
    let mut cmd = crate::path_env::tokio_command("git");
    cmd.args(["--no-pager", "-c", "color.ui=never", "-c", "core.quotepath=off"])
        .args(args)
        .current_dir(root)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env("GIT_TERMINAL_PROMPT", "0")
        // No editor can open: a commit takes its message from stdin.
        .env("GIT_EDITOR", "true")
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("couldn't run git: {e}"))?;
    if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
        use tokio::io::AsyncWriteExt;
        stdin.write_all(input.as_bytes()).await.map_err(|e| format!("writing to git: {e}"))?;
    }
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        return Err("couldn't read git's output".into());
    };
    let run = async {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let (mut so, mut se) = (stdout.take(1 << 20), stderr.take(1 << 20));
        let (o, e) = tokio::join!(so.read_to_end(&mut out), se.read_to_end(&mut err));
        o.and(e).map_err(|e| format!("reading git's output: {e}"))?;
        let status = child.wait().await.map_err(|e| e.to_string())?;
        if status.success() {
            Ok(text(out))
        } else {
            // Hooks print to either stream: show what they said.
            let said = [text(err), text(out)].into_iter().map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n");
            Err(if said.is_empty() {
                format!("git {} failed", args[0])
            } else {
                said.trim_start_matches("fatal: ").trim_start_matches("error: ").to_owned()
            })
        }
    };
    tokio::time::timeout(WRITE_TIMEOUT, run).await.map_err(|_| format!("git {} didn't finish within {}s", args[0], WRITE_TIMEOUT.as_secs()))?
}

fn with_paths<'a>(mut args: Vec<&'a str>, paths: &[&'a str]) -> Vec<&'a str> {
    args.push("--");
    args.extend(paths);
    args
}

/// `git add` these paths (new, changed or deleted).
pub(crate) async fn stage(root: &Path, paths: &[String]) -> Result<(), String> {
    let paths = write_paths(paths)?;
    git_write(root, &with_paths(vec!["add", "-A"], &paths), None).await.map(drop)
}

/// Take these paths out of the index, leaving the work tree as it is.
pub(crate) async fn unstage(root: &Path, paths: &[String]) -> Result<(), String> {
    let paths = write_paths(paths)?;
    let args = if has_head(root).await? { vec!["restore", "--staged"] } else { vec!["rm", "--cached", "-r", "-q"] };
    git_write(root, &with_paths(args, &paths), None).await.map(drop)
}

/// Throw away the work tree's changes to these paths (back to the index, as VS Code's "Discard
/// Changes"); an untracked path is deleted. Only paths git lists as changed or untracked are
/// touched: anything else is refused before a file is removed.
pub(crate) async fn discard(root: &Path, paths: &[String]) -> Result<(), String> {
    let paths = write_paths(paths)?;
    let status = status_view(root, None).await?;
    let listed = |key: &str, untracked: bool| -> Vec<String> {
        status[key].as_array().map_or_default(|a| {
            a.iter()
                .filter(|f| f["untracked"].as_bool().unwrap_or(false) == untracked)
                .filter_map(|f| f["path"].as_str().map(str::to_owned))
                .collect()
        })
    };
    let (changed, untracked) = (listed("changes", false), listed("changes", true));
    let (mut restore, mut remove) = (vec![], vec![]);
    for p in paths {
        if untracked.iter().any(|u| u == p) {
            remove.push(p);
        } else if changed.iter().any(|c| c == p) {
            restore.push(p);
        } else {
            return Err(format!("`{p}` has no changes to discard"));
        }
    }
    if !restore.is_empty() {
        git_write(root, &with_paths(vec!["checkout"], &restore), None).await?;
    }
    for p in remove {
        // Listed by git as an untracked file of this work tree; a symlink is removed as the link itself.
        let path = root.join(p);
        let meta = std::fs::symlink_metadata(&path).map_err(|e| format!("{p}: {e}"))?;
        if meta.is_dir() {
            return Err(format!("`{p}` is a folder; discard its files instead"));
        }
        std::fs::remove_file(&path).map_err(|e| format!("couldn't delete {p}: {e}"))?;
    }
    Ok(())
}

/// Commit what is staged (`all`: every tracked change, as `git commit -a`), with `message` from
/// stdin, the user's hooks and signing as configured. The new commit's short id.
pub(crate) async fn commit(root: &Path, message: &str, all: bool, amend: bool) -> Result<String, String> {
    if message.trim().is_empty() && !amend {
        return Err("a commit needs a message".into());
    }
    if message.len() > MAX_MESSAGE || message.contains('\0') {
        return Err("that message isn't one git can take".into());
    }
    let mut args = vec!["commit", "--file=-", "--cleanup=strip"];
    if all {
        args.push("--all");
    }
    if amend {
        args.push("--amend");
        if message.trim().is_empty() {
            args = vec!["commit", "--amend", "--no-edit"];
        }
    }
    git_write(root, &args, Some(message)).await?;
    let out = git(root, &["rev-parse", "--short", "HEAD"], 4096).await?;
    Ok(text(out.stdout).trim().to_owned())
}

/// Whether HEAD exists, for the view (an empty repository can't amend).
pub(crate) async fn has_commits(root: &Path) -> bool {
    has_head(root).await.unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("yaah-editor-git-{tag}-{}", crate::session::random_token()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sh(dir: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git")
            .args(["-c", "user.name=Ada", "-c", "user.email=ada@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"])
            .args(["-c", "init.defaultBranch=main"])
            .args(args)
            .current_dir(dir)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?}");
    }

    fn repo(tag: &str) -> PathBuf {
        let dir = temp(tag);
        sh(&dir, &["init", "-q"]);
        sh(&dir, &["config", "user.name", "Ada"]);
        sh(&dir, &["config", "user.email", "ada@example.com"]);
        sh(&dir, &["config", "commit.gpgsign", "false"]);
        sh(&dir, &["config", "core.hooksPath", "/dev/null"]);
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        sh(&dir, &["add", "a.txt"]);
        sh(&dir, &["commit", "-q", "-m", "first"]);
        dir.canonicalize().unwrap()
    }

    fn paths(v: &Value, key: &str) -> Vec<String> {
        v[key].as_array().unwrap().iter().map(|f| format!("{}{}", f["status"].as_str().unwrap(), f["path"].as_str().unwrap())).collect()
    }

    #[tokio::test]
    async fn status_splits_staged_and_changes_and_polls_cheaply() {
        let dir = repo("status");
        std::fs::write(dir.join("a.txt"), "two\n").unwrap();
        std::fs::write(dir.join("new.txt"), "n\n").unwrap();
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub/deep.txt"), "d\n").unwrap();
        let v = status_view(&dir, None).await.unwrap();
        assert_eq!(v["branch"], "main");
        assert_eq!(paths(&v, "staged"), Vec::<String>::new());
        assert_eq!(paths(&v, "changes"), vec!["Ma.txt", "Unew.txt", "Usub/deep.txt"], "untracked files one by one");

        stage(&dir, &["a.txt".into(), "new.txt".into()]).await.unwrap();
        let v = status_view(&dir, None).await.unwrap();
        assert_eq!(paths(&v, "staged"), vec!["Ma.txt", "Anew.txt"]);
        let fp = v["fingerprint"].as_str().unwrap().to_owned();
        assert_eq!(status_view(&dir, Some(&fp)).await.unwrap()["unchanged"], true);

        unstage(&dir, &["new.txt".into()]).await.unwrap();
        let v = status_view(&dir, None).await.unwrap();
        assert_eq!(paths(&v, "staged"), vec!["Ma.txt"]);
        assert_ne!(v["fingerprint"].as_str().unwrap(), fp);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn file_at_reads_head_and_index_and_none_for_new_files() {
        let dir = repo("file-at");
        std::fs::write(dir.join("a.txt"), "staged\n").unwrap();
        stage(&dir, &["a.txt".into()]).await.unwrap();
        std::fs::write(dir.join("a.txt"), "worktree\n").unwrap();
        assert_eq!(file_at(&dir, "a.txt", "HEAD").await.unwrap().unwrap()["text"], "one\n");
        assert_eq!(file_at(&dir, "a.txt", "INDEX").await.unwrap().unwrap()["text"], "staged\n");
        assert!(file_at(&dir, "nope.txt", "HEAD").await.unwrap().is_none());
        assert!(file_at(&dir, "../etc/passwd", "HEAD").await.is_err(), "paths stay inside");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn discard_restores_tracked_and_deletes_only_listed_untracked_files() {
        let dir = repo("discard");
        std::fs::write(dir.join("a.txt"), "changed\n").unwrap();
        std::fs::write(dir.join("junk.txt"), "x\n").unwrap();
        assert!(discard(&dir, &["other.txt".into()]).await.is_err(), "nothing to discard: refused");
        discard(&dir, &["a.txt".into(), "junk.txt".into()]).await.unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "one\n");
        assert!(!dir.join("junk.txt").exists());
        assert!(discard(&dir, &["-rf".into()]).await.is_err(), "no flags as paths");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn commit_takes_staged_or_all_and_the_graph_shows_it() {
        let dir = repo("commit");
        assert!(commit(&dir, "  ", false, false).await.is_err(), "a message is needed");
        std::fs::write(dir.join("a.txt"), "two\n").unwrap();
        assert!(commit(&dir, "nothing staged", false, false).await.is_err());
        let short = commit(&dir, "-n looks like a flag\n\nbody", true, false).await.unwrap();
        assert_ne!(short, "", "the new commit's short id");
        let g = graph(&dir, Some("origin/nope"), None).await.unwrap();
        let g = g.as_array().unwrap();
        assert_eq!(g.len(), 2);
        assert_eq!(g[0]["subject"], "-n looks like a flag");
        assert_eq!(g[0]["parents"][0], g[1]["sha"]);
        assert!(g[0]["refs"].as_array().unwrap().iter().any(|r| r.as_str().unwrap().contains("main")));
        assert!(has_commits(&dir).await);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
