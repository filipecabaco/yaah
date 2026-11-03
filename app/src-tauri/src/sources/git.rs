//! Git sources: `git.diff`, `git.log`, `git.status` and `git.show`, read in
//! the chat's folder (given by yaah from the session, never by the agent).
//!
//! Read-only: git runs through [`crate::path_env::tokio_command`] (no shell),
//! with optional locks off (so `status` never rewrites the index) and nothing
//! that could run a program a repository configures (external diff drivers,
//! textconv filters, fsmonitor hooks, signature checks). Refs and paths are
//! validated before they reach the command line, and come after
//! `--end-of-options` / `--` anyway. Output is capped at [`MAX_TEXT`].

use serde_json::{Value, json};
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;

/// Diff and `show` text past this is cut on a line, with `truncated: true`.
pub(crate) const MAX_TEXT: usize = 4 << 20;
/// Any git run past this is stopped.
const TIMEOUT: Duration = Duration::from_secs(20);
const MAX_REF: usize = 256;
const MAX_PATH: usize = 1024;
const MAX_PATHS: usize = 200;
const DEFAULT_LOG: u64 = 50;
const MAX_LOG: u64 = 500;
const MAX_CONTEXT: u64 = 100;
/// The tree of a repository with no commits yet.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// Settings that keep git from running anything a repository's config names,
/// and from writing anything while it reads.
const SAFE: &[&str] = &[
    "--no-pager",
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.quotepath=off",
    "-c",
    "color.ui=never",
    "-c",
    "log.showSignature=false",
    "-c",
    "diff.external=",
    "-c",
    "submodule.recurse=false",
];

/// The flags every diff gets: plain `a/`/`b/` prefixes whatever the user's
/// config says (the UI parses them), renames found, no external programs.
const DIFF: &[&str] = &["--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "-M", "--src-prefix=a/", "--dst-prefix=b/"];

pub(crate) fn is_git(kind: &str) -> bool {
    matches!(kind, "git.diff" | "git.log" | "git.status" | "git.show")
}

/// Read a git source in `cwd`.
pub(crate) async fn read(kind: &str, source: &Value, cwd: &Path) -> Result<Value, String> {
    if !cwd.is_dir() {
        return Err(format!("the chat's folder {} doesn't exist", cwd.display()));
    }
    match kind {
        "git.diff" => diff(source, cwd).await,
        "git.log" => log(source, cwd).await,
        "git.status" => status(cwd).await,
        "git.show" => show(source, cwd).await,
        other => Err(format!("unknown git source `{other}`")),
    }
}

// ── validation ──────────────────────────────────────────────────────────────

/// A revision or range (`main`, `HEAD~3`, `main...HEAD`, `v1.2^{commit}`, `HEAD@{1}`).
pub(crate) fn valid_rev(r: &str) -> Result<&str, String> {
    let ok = !r.is_empty() && r.len() <= MAX_REF && !r.starts_with('-') && r.chars().all(|c| c.is_ascii_alphanumeric() || "._/@^~{}-".contains(c));
    if ok { Ok(r) } else { Err(format!("`{r}` isn't a revision (letters, digits and . _ / @ ^ ~ {{ }} -, not starting with -)")) }
}

/// A path relative to the chat's folder that stays inside it.
pub(crate) fn valid_path(p: &str) -> Result<&str, String> {
    let bad = |why: &str| Err(format!("path `{p}` {why}"));
    if p.is_empty() || p.len() > MAX_PATH || p.contains('\0') {
        return bad("isn't a path");
    }
    if p.starts_with('-') {
        return bad("can't start with -");
    }
    if p.starts_with('/') || p.starts_with('~') {
        return bad("must be relative to the chat's folder");
    }
    if p.starts_with(':') {
        return bad("can't use pathspec magic");
    }
    if p.split('/').any(|part| part == "..") {
        return bad("can't use .. to leave the chat's folder");
    }
    Ok(p)
}

fn opt_str<'a>(source: &'a Value, key: &str) -> Result<Option<&'a str>, String> {
    match &source[key] {
        Value::Null => Ok(None),
        Value::String(s) if s.trim().is_empty() => Ok(None),
        Value::String(s) => Ok(Some(s.trim())),
        other => Err(format!("`{key}` must be a string, got {other}")),
    }
}

fn paths(source: &Value) -> Result<Vec<&str>, String> {
    let list: Vec<&Value> = match &source["paths"] {
        Value::Null => return Ok(vec![]),
        Value::String(_) => vec![&source["paths"]],
        Value::Array(items) => items.iter().collect(),
        other => return Err(format!("`paths` must be an array of strings, got {other}")),
    };
    if list.len() > MAX_PATHS {
        return Err(format!("at most {MAX_PATHS} paths"));
    }
    list.into_iter().map(|v| v.as_str().ok_or_else(|| format!("`paths` must be strings, got {v}")).and_then(valid_path)).collect()
}

fn range(source: &Value) -> Result<Option<&str>, String> {
    opt_str(source, "range")?.map(valid_rev).transpose()
}

// ── running git ─────────────────────────────────────────────────────────────

struct Out {
    stdout: Vec<u8>,
    truncated: bool,
}

/// `git <args>` in `cwd`: at most `cap` bytes of its output (it is stopped past that).
async fn git(cwd: &Path, args: &[&str], cap: usize) -> Result<Out, String> {
    let mut cmd = crate::path_env::tokio_command("git");
    cmd.args(SAFE)
        .args(args)
        .current_dir(cwd)
        // The repository is the chat's folder, whatever the app was started with.
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_EXTERNAL_DIFF")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        // Messages in English, so errors can be recognised.
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("couldn't run git: {e}"))?;
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        return Err("couldn't read git's output".into());
    };
    let run = async {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let limit = u64::try_from(cap).unwrap_or(u64::MAX).saturating_add(1);
        // Each pipe is closed once read up to its limit: git, writing more, stops
        // (SIGPIPE) instead of waiting forever for a reader.
        let read_out = async {
            let mut pipe = stdout.take(limit);
            pipe.read_to_end(&mut out).await
        };
        let read_err = async {
            let mut pipe = stderr.take(64 << 10);
            pipe.read_to_end(&mut err).await
        };
        let (o, e) = tokio::join!(read_out, read_err);
        o.and(e).map_err(|e| format!("reading git's output: {e}"))?;
        let truncated = out.len() > cap;
        if truncated {
            let _ = child.start_kill();
            out.truncate(cap);
        }
        let status = child.wait().await.map_err(|e| e.to_string())?;
        if !truncated && !status.success() {
            return Err(git_error(cwd, args, &String::from_utf8_lossy(&err)));
        }
        Ok(Out { stdout: out, truncated })
    };
    tokio::time::timeout(TIMEOUT, run).await.map_err(|_| format!("git {} didn't finish within {}s", args[0], TIMEOUT.as_secs()))?
}

/// git's complaint, said plainly.
fn git_error(cwd: &Path, args: &[&str], stderr: &str) -> String {
    let lower = stderr.to_lowercase();
    if lower.contains("not a git repository") {
        return format!("not a git repository: {}", cwd.display());
    }
    // "fatal: ambiguous argument 'nope': unknown revision or path not in the working tree."
    // "fatal: bad revision 'nope'", "fatal: invalid object name 'nope'."
    for marker in ["ambiguous argument '", "bad revision '", "invalid object name '", "unknown revision '"] {
        if let Some(rest) = stderr.split(marker).nth(1)
            && let Some(name) = rest.split('\'').next()
        {
            return format!("unknown revision `{name}`");
        }
    }
    if lower.contains("does not exist in") || lower.contains("exists on disk, but not in") {
        let line = stderr.lines().find(|l| l.contains("exist")).unwrap_or(stderr).trim();
        return line.trim_start_matches("fatal: ").to_owned();
    }
    let last = stderr.lines().rfind(|l| !l.trim().is_empty()).unwrap_or("failed").trim();
    format!("git {}: {}", args[0], last.trim_start_matches("fatal: ").trim_start_matches("error: "))
}

fn text(bytes: Vec<u8>) -> String {
    String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

/// Cut `s` to its last whole line (after the output was capped mid-line).
fn whole_lines(s: &mut String) {
    if let Some(end) = s.rfind('\n') {
        s.truncate(end + 1);
    } else {
        s.clear();
    }
}

/// Whether the repository has a commit yet (an empty one has no HEAD to diff against).
async fn has_head(cwd: &Path) -> Result<bool, String> {
    match git(cwd, &["rev-parse", "--verify", "-q", "HEAD^{commit}"], 4096).await {
        Ok(_) => Ok(true),
        Err(e) if e.starts_with("not a git repository") => Err(e),
        Err(_) => Ok(false),
    }
}

// ── git.diff ────────────────────────────────────────────────────────────────

async fn diff(source: &Value, cwd: &Path) -> Result<Value, String> {
    let range = range(source)?;
    let staged = source["staged"].as_bool().unwrap_or(false);
    let paths = paths(source)?;
    let context = source["context"].as_u64().unwrap_or(3).min(MAX_CONTEXT).to_string();
    // Default: the working tree (staged and not) against HEAD.
    let base = match range {
        Some(r) => Some(r),
        None if staged => None,
        None => Some(if has_head(cwd).await? { "HEAD" } else { EMPTY_TREE }),
    };
    let args = |extra: &[&'static str], unified: Option<&str>| -> Vec<String> {
        let mut a: Vec<String> = vec!["diff".into()];
        a.extend(DIFF.iter().map(|s| (*s).to_owned()));
        a.extend(extra.iter().map(|s| (*s).to_owned()));
        if let Some(u) = unified {
            a.push(format!("--unified={u}"));
        }
        if staged {
            a.push("--cached".into());
        }
        a.push("--end-of-options".into());
        a.extend(base.map(str::to_owned));
        a.push("--".into());
        a.extend(paths.iter().map(|p| (*p).to_owned()));
        a
    };
    let (patch, numstat, names) = (args(&[], Some(&context)), args(&["--numstat", "-z"], None), args(&["--name-status", "-z"], None));
    let (patch, numstat, names) = (refs(&patch), refs(&numstat), refs(&names));
    let (patch, numstat, names) = tokio::join!(git(cwd, &patch, MAX_TEXT), git(cwd, &numstat, MAX_TEXT), git(cwd, &names, MAX_TEXT));
    let patch = patch?;
    let mut diff_text = text(patch.stdout);
    if patch.truncated {
        whole_lines(&mut diff_text);
    }
    let files = diff_files(&text(numstat?.stdout), &text(names?.stdout));
    let additions: u64 = files.iter().filter_map(|f| f["additions"].as_u64()).sum();
    let deletions: u64 = files.iter().filter_map(|f| f["deletions"].as_u64()).sum();
    Ok(json!({
        "range": range.unwrap_or(if staged { "staged" } else { "HEAD" }),
        "staged": staged,
        "text": diff_text,
        "files": files,
        "additions": additions,
        "deletions": deletions,
        "truncated": patch.truncated,
    }))
}

fn refs(a: &[String]) -> Vec<&str> {
    a.iter().map(String::as_str).collect()
}

/// Files from `--numstat -z` (counts, `-` for binary) and `--name-status -z` (what happened).
fn diff_files(numstat: &str, names: &str) -> Vec<Value> {
    let mut statuses: Vec<(String, &'static str)> = vec![];
    let mut tokens = names.split('\0').filter(|t| !t.is_empty());
    while let Some(code) = tokens.next() {
        let status = match code.chars().next() {
            Some('A' | 'C') => "added",
            Some('D') => "deleted",
            Some('R') => "renamed",
            _ => "modified",
        };
        // Renames and copies name the old path, then the new one.
        if matches!(code.chars().next(), Some('R' | 'C')) {
            tokens.next();
        }
        if let Some(path) = tokens.next() {
            statuses.push((path.to_owned(), status));
        }
    }
    let mut files = vec![];
    let mut tokens = numstat.split('\0');
    while let Some(record) = tokens.next() {
        if record.is_empty() {
            continue;
        }
        let mut parts = record.splitn(3, '\t');
        let (Some(add), Some(del), Some(path)) = (parts.next(), parts.next(), parts.next()) else { continue };
        // A rename has an empty path here, then the old and new paths.
        let (old, path) = if path.is_empty() {
            let old = tokens.next().unwrap_or_default().to_owned();
            (Some(old), tokens.next().unwrap_or_default().to_owned())
        } else {
            (None, path.to_owned())
        };
        let binary = add == "-" && del == "-";
        let status = statuses.iter().find(|(p, _)| *p == path).map_or(if old.is_some() { "renamed" } else { "modified" }, |(_, s)| *s);
        let mut f = json!({
            "path": path,
            "status": status,
            "additions": add.parse::<u64>().unwrap_or(0),
            "deletions": del.parse::<u64>().unwrap_or(0),
            "binary": binary,
        });
        if let Some(old) = old.filter(|o| *o != path) {
            f["oldPath"] = json!(old);
        }
        files.push(f);
    }
    files
}

// ── git.log ─────────────────────────────────────────────────────────────────

async fn log(source: &Value, cwd: &Path) -> Result<Value, String> {
    let range = range(source)?;
    let paths = paths(source)?;
    let limit = source["limit"].as_u64().unwrap_or(DEFAULT_LOG).clamp(1, MAX_LOG).to_string();
    let max = format!("--max-count={limit}");
    let mut args = vec!["log", "--no-color", "-z", &max, "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b", "--end-of-options"];
    args.extend(range);
    args.push("--");
    args.extend(paths.iter().copied());
    let out = match git(cwd, &args, MAX_TEXT).await {
        Ok(out) => out,
        // A repository without commits has no history (rather than an error).
        Err(e) if e.contains("does not have any commits yet") || (range.is_none() && e == "unknown revision `HEAD`") => {
            return Ok(json!([]));
        }
        Err(e) => return Err(e),
    };
    let log = text(out.stdout);
    let commits: Vec<Value> = log
        .split('\0')
        .filter(|c| !c.trim().is_empty())
        .filter_map(|c| {
            let f: Vec<&str> = c.trim_start_matches('\n').splitn(7, '\u{1f}').collect();
            (f.len() == 7)
                .then(|| json!({ "sha": f[0], "short": f[1], "author": f[2], "email": f[3], "date": f[4], "subject": f[5], "body": f[6].trim_end() }))
        })
        .collect();
    Ok(Value::Array(commits))
}

// ── git.status ──────────────────────────────────────────────────────────────

fn change(c: char) -> Value {
    match c {
        'M' => json!("modified"),
        'T' => json!("typechange"),
        'A' => json!("added"),
        'D' => json!("deleted"),
        'R' => json!("renamed"),
        'C' => json!("copied"),
        'U' => json!("unmerged"),
        _ => Value::Null,
    }
}

async fn status(cwd: &Path) -> Result<Value, String> {
    let out = git(cwd, &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"], MAX_TEXT).await?;
    Ok(parse_status(&text(out.stdout)))
}

/// `git status --porcelain=v2 --branch -z`.
fn parse_status(out: &str) -> Value {
    let (mut branch, mut upstream, mut ahead, mut behind, mut oid) = (Value::Null, Value::Null, 0i64, 0i64, Value::Null);
    let mut files = vec![];
    let mut tokens = out.split('\0');
    while let Some(line) = tokens.next() {
        if let Some(head) = line.strip_prefix("# branch.head ") {
            branch = json!(head);
        } else if let Some(o) = line.strip_prefix("# branch.oid ") {
            oid = if o == "(initial)" { Value::Null } else { json!(o) };
        } else if let Some(up) = line.strip_prefix("# branch.upstream ") {
            upstream = json!(up);
        } else if let Some(ab) = line.strip_prefix("# branch.ab ") {
            for n in ab.split_whitespace() {
                if let Some(a) = n.strip_prefix('+') {
                    ahead = a.parse().unwrap_or(0);
                } else if let Some(b) = n.strip_prefix('-') {
                    behind = b.parse().unwrap_or(0);
                }
            }
        } else if let Some(path) = line.strip_prefix("? ") {
            files.push(json!({ "path": path, "index": Value::Null, "worktree": "untracked" }));
        } else if line.starts_with("1 ") || line.starts_with("2 ") || line.starts_with("u ") {
            // Fields before the path: 8 for changes, 9 for renames and copies, 10 for conflicts.
            let fields = match line.as_bytes()[0] {
                b'1' => 8,
                b'2' => 9,
                _ => 10,
            };
            let parts: Vec<&str> = line.splitn(fields + 1, ' ').collect();
            let (Some(xy), Some(path)) = (parts.get(1), parts.get(fields)) else { continue };
            let mut xy = xy.chars();
            let (x, y) = (xy.next().unwrap_or('.'), xy.next().unwrap_or('.'));
            let mut f = if line.starts_with('u') {
                json!({ "path": path, "index": "unmerged", "worktree": "unmerged" })
            } else {
                json!({ "path": path, "index": change(x), "worktree": change(y) })
            };
            if line.starts_with('2') {
                f["oldPath"] = json!(tokens.next().unwrap_or_default());
            }
            files.push(f);
        }
    }
    let detached = branch == json!("(detached)");
    json!({
        "branch": if detached { Value::Null } else { branch },
        "detached": detached,
        "oid": oid,
        "upstream": upstream,
        "ahead": ahead,
        "behind": behind,
        "clean": files.is_empty(),
        "files": files,
    })
}

// ── git.show ────────────────────────────────────────────────────────────────

async fn show(source: &Value, cwd: &Path) -> Result<Value, String> {
    let rev = valid_rev(opt_str(source, "rev")?.ok_or("git.show needs `rev` (a commit, tag or branch)")?)?;
    if rev.contains("..") {
        return Err(format!("git.show takes one revision, not a range (`{rev}`); use git.diff or git.log for ranges"));
    }
    let path = opt_str(source, "path")?.map(valid_path).transpose()?;
    let (out, binary) = if let Some(path) = path {
        // The file at that revision, as stored (no filters run).
        let object = format!("{rev}:{path}");
        let out = git(cwd, &["cat-file", "blob", "--end-of-options", &object], MAX_TEXT).await.map_err(|e| {
            if e.starts_with("unknown revision") || e.starts_with("git cat-file") { format!("no file `{path}` at `{rev}` ({e})") } else { e }
        })?;
        let binary = out.stdout.iter().take(8000).any(|b| *b == 0);
        (out, binary)
    } else {
        let mut args = vec!["show"];
        args.extend(DIFF);
        args.extend(["--format=fuller", "--end-of-options", rev, "--"]);
        (git(cwd, &args, MAX_TEXT).await?, false)
    };
    let truncated = out.truncated;
    let body = if binary {
        format!("(binary file{})", if truncated { ", over 4 MB" } else { "" })
    } else {
        let mut t = text(out.stdout);
        if truncated {
            whole_lines(&mut t);
        }
        t
    };
    let mut v = json!({ "rev": rev, "text": body, "truncated": truncated, "binary": binary });
    if let Some(p) = path {
        v["path"] = json!(p);
    }
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("yaah-git-{tag}-{}", crate::session::random_token()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sh_git(dir: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .args(["-c", "user.name=Ada", "-c", "user.email=ada@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"])
            .args(["-c", "init.defaultBranch=main"])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn write(dir: &Path, path: &str, body: &[u8]) {
        let p = dir.join(path);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }

    /// A repository with two commits on `main` and a `feature` branch with two more
    /// (a change, a new file, a rename, a binary file and a deletion).
    fn repo() -> PathBuf {
        let dir = temp("repo");
        sh_git(&dir, &["init", "-q"]);
        write(&dir, "src/main.go", b"package main\n\nfunc main() {\n\tprintln(\"hi\")\n}\n");
        write(&dir, "README.md", b"# demo\n");
        write(&dir, "docs/old-name.md", b"one\ntwo\nthree\nfour\nfive\nsix\n");
        write(&dir, "gone.txt", b"bye\n");
        sh_git(&dir, &["add", "-A"]);
        sh_git(&dir, &["commit", "-qm", "First commit"]);
        sh_git(&dir, &["commit", "-q", "--allow-empty", "-m", "Second\n\nWith a body."]);
        sh_git(&dir, &["checkout", "-qb", "feature"]);
        write(&dir, "src/main.go", b"package main\n\nfunc main() {\n\tprintln(\"hello\")\n}\n");
        write(&dir, "src/new.go", b"package main\n\nconst query = `\n\tselect *\n\tfrom t\n`\n");
        sh_git(&dir, &["mv", "docs/old-name.md", "docs/new-name.md"]);
        write(&dir, "logo.png", &[0x89, b'P', b'N', b'G', 0, 0, 1, 2, 3, 0, 255]);
        sh_git(&dir, &["rm", "-q", "gone.txt"]);
        sh_git(&dir, &["add", "-A"]);
        sh_git(&dir, &["commit", "-qm", "Feature work"]);
        dir
    }

    fn run(kind: &str, source: &Value, cwd: &Path) -> Result<Value, String> {
        tauri::async_runtime::block_on(read(kind, source, cwd))
    }

    fn file<'a>(v: &'a Value, path: &str) -> &'a Value {
        v["files"].as_array().unwrap().iter().find(|f| f["path"] == path).unwrap_or_else(|| panic!("no {path} in {v}"))
    }

    #[test]
    fn diffs_a_range_with_renames_binaries_and_deletions() {
        let dir = repo();
        let v = run("git.diff", &json!({ "range": "main...feature" }), &dir).unwrap();
        assert_eq!(v["range"], "main...feature");
        assert_eq!(v["truncated"], false);
        assert_eq!(file(&v, "src/main.go")["status"], "modified");
        assert_eq!((file(&v, "src/main.go")["additions"].as_u64(), file(&v, "src/main.go")["deletions"].as_u64()), (Some(1), Some(1)));
        assert_eq!(file(&v, "src/new.go")["status"], "added");
        assert_eq!(file(&v, "gone.txt")["status"], "deleted");
        let renamed = file(&v, "docs/new-name.md");
        assert_eq!((renamed["status"].as_str(), renamed["oldPath"].as_str()), (Some("renamed"), Some("docs/old-name.md")));
        let png = file(&v, "logo.png");
        assert_eq!((png["binary"].as_bool(), png["status"].as_str()), (Some(true), Some("added")));
        assert_eq!(v["additions"], 7);
        let text = v["text"].as_str().unwrap();
        assert!(text.contains("diff --git a/src/main.go b/src/main.go"), "plain prefixes: {text}");
        assert!(text.contains("rename from docs/old-name.md"));
        assert!(text.contains("Binary files /dev/null and b/logo.png differ"));
        // The tab-indented raw string comes through as is.
        assert!(text.contains("+\tselect *\n"));
    }

    #[test]
    fn diffs_the_working_tree_staged_and_paths() {
        let dir = repo();
        write(&dir, "README.md", b"# demo\n\nmore\n");
        write(&dir, "src/main.go", b"package main\n");
        sh_git(&dir, &["add", "src/main.go"]);
        // Default: working tree (staged and not) against HEAD.
        let all = run("git.diff", &json!({}), &dir).unwrap();
        assert_eq!(all["range"], "HEAD");
        let paths: Vec<&str> = all["files"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap()).collect();
        assert_eq!(paths, ["README.md", "src/main.go"]);
        let staged = run("git.diff", &json!({ "staged": true }), &dir).unwrap();
        assert_eq!(staged["files"].as_array().unwrap().len(), 1);
        assert_eq!(file(&staged, "src/main.go")["deletions"], 4);
        let only = run("git.diff", &json!({ "paths": ["README.md"] }), &dir).unwrap();
        assert_eq!(only["files"].as_array().unwrap().len(), 1);
        assert!(!only["text"].as_str().unwrap().contains("main.go"));
        let wide = run("git.diff", &json!({ "paths": ["README.md"], "context": 0 }), &dir).unwrap();
        assert!(wide["text"].as_str().unwrap().contains("@@ -1,0 +2,2 @@"), "{}", wide["text"]);
        // Nothing changed: an empty diff, not an error.
        sh_git(&dir, &["checkout", "-q", "--", "."]);
        sh_git(&dir, &["reset", "-q", "--hard"]);
        let none = run("git.diff", &json!({}), &dir).unwrap();
        assert_eq!((none["text"].as_str(), none["files"].as_array().map(Vec::len)), (Some(""), Some(0)));
    }

    #[test]
    fn a_large_diff_is_cut_on_a_line_and_says_so() {
        let dir = temp("big");
        sh_git(&dir, &["init", "-q"]);
        write(&dir, "big.txt", b"start\n");
        sh_git(&dir, &["add", "-A"]);
        sh_git(&dir, &["commit", "-qm", "start"]);
        // ~6 MB of new lines: past the 4 MB cap.
        let line = "x".repeat(99) + "\n";
        write(&dir, "big.txt", line.repeat(60_000).as_bytes());
        let v = run("git.diff", &json!({}), &dir).unwrap();
        assert_eq!(v["truncated"], true);
        let text = v["text"].as_str().unwrap();
        assert!(text.len() <= MAX_TEXT && text.len() > MAX_TEXT - 200, "{}", text.len());
        assert!(text.ends_with('\n'), "cut on a line end");
        // The file list is still whole.
        assert_eq!(file(&v, "big.txt")["additions"], 60_000);
    }

    #[test]
    fn logs_shows_and_status() {
        let dir = repo();
        let log = run("git.log", &json!({ "limit": 2 }), &dir).unwrap();
        let log = log.as_array().unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!((log[0]["subject"].as_str(), log[0]["author"].as_str()), (Some("Feature work"), Some("Ada")));
        assert_eq!(log[1]["body"], "With a body.");
        assert_eq!(log[0]["sha"].as_str().unwrap().len(), 40);
        assert!(log[0]["date"].as_str().unwrap().contains('T'));
        let range = run("git.log", &json!({ "range": "main..feature" }), &dir).unwrap();
        assert_eq!(range.as_array().unwrap().len(), 1);
        let by_path = run("git.log", &json!({ "paths": ["README.md"] }), &dir).unwrap();
        assert_eq!(by_path[0]["subject"], "First commit");

        let show = run("git.show", &json!({ "rev": "HEAD" }), &dir).unwrap();
        let text = show["text"].as_str().unwrap();
        assert!(text.contains("Feature work") && text.contains("diff --git a/src/main.go b/src/main.go"), "{text}");
        let at = run("git.show", &json!({ "rev": "main", "path": "src/main.go" }), &dir).unwrap();
        assert_eq!(at["text"], "package main\n\nfunc main() {\n\tprintln(\"hi\")\n}\n");
        let png = run("git.show", &json!({ "rev": "feature", "path": "logo.png" }), &dir).unwrap();
        assert_eq!((png["binary"].as_bool(), png["text"].as_str()), (Some(true), Some("(binary file)")));
        assert!(run("git.show", &json!({ "rev": "main", "path": "src/new.go" }), &dir).unwrap_err().contains("src/new.go"));
        assert!(run("git.show", &json!({ "rev": "main..feature" }), &dir).unwrap_err().contains("not a range"));

        write(&dir, "README.md", b"changed\n");
        write(&dir, "notes.txt", b"new\n");
        sh_git(&dir, &["mv", "src/new.go", "src/renamed.go"]);
        let st = run("git.status", &json!({}), &dir).unwrap();
        assert_eq!((st["branch"].as_str(), st["upstream"].as_str(), st["clean"].as_bool()), (Some("feature"), None, Some(false)));
        let readme = file(&st, "README.md");
        assert_eq!((readme["index"].as_str(), readme["worktree"].as_str()), (None, Some("modified")));
        assert_eq!(file(&st, "notes.txt")["worktree"], "untracked");
        let renamed = file(&st, "src/renamed.go");
        assert_eq!((renamed["index"].as_str(), renamed["oldPath"].as_str()), (Some("renamed"), Some("src/new.go")));
    }

    #[test]
    fn refuses_options_escapes_and_bad_revisions() {
        let dir = repo();
        for bad in ["-x", "--output=/tmp/x", "main;rm", "a b", "$(id)", "main:README.md"] {
            assert!(run("git.diff", &json!({ "range": bad }), &dir).unwrap_err().contains("isn't a revision"), "{bad}");
        }
        for bad in ["..", "../secret", "src/../../x", "/etc/passwd", "-p", ":(glob)*", "~/x"] {
            let e = run("git.diff", &json!({ "paths": [bad] }), &dir).unwrap_err();
            assert!(e.starts_with(&format!("path `{bad}`")), "{bad}: {e}");
        }
        assert!(run("git.log", &json!({ "paths": ["../x"] }), &dir).unwrap_err().contains("can't use .."));
        assert!(run("git.show", &json!({ "rev": "HEAD", "path": "../x" }), &dir).unwrap_err().contains("can't use .."));
        assert!(run("git.show", &json!({}), &dir).unwrap_err().contains("needs `rev`"));
        assert!(run("git.diff", &json!({ "paths": "README.md", "range": 3 }), &dir).unwrap_err().contains("must be a string"));
        assert_eq!(run("git.diff", &json!({ "range": "nope" }), &dir).unwrap_err(), "unknown revision `nope`");
        assert_eq!(run("git.log", &json!({ "range": "nope..main" }), &dir).unwrap_err(), "unknown revision `nope..main`");
        assert_eq!(run("git.show", &json!({ "rev": "deadbeef" }), &dir).unwrap_err(), "unknown revision `deadbeef`");
        // `..` inside a range is the range operator, not a path.
        assert!(run("git.diff", &json!({ "range": "main..feature" }), &dir).is_ok());
    }

    #[test]
    fn not_a_repository_and_an_empty_one() {
        let dir = temp("plain");
        let e = run("git.status", &json!({}), &dir).unwrap_err();
        assert!(e.starts_with("not a git repository"), "{e}");
        assert!(run("git.diff", &json!({}), &dir).unwrap_err().starts_with("not a git repository"));
        assert!(run("git.log", &json!({}), &dir).unwrap_err().starts_with("not a git repository"));
        assert!(run("git.diff", &json!({}), &dir.join("missing")).unwrap_err().contains("doesn't exist"));

        sh_git(&dir, &["init", "-q"]);
        write(&dir, "a.txt", b"a\n");
        sh_git(&dir, &["add", "a.txt"]);
        assert_eq!(run("git.log", &json!({}), &dir).unwrap(), json!([]));
        let v = run("git.diff", &json!({}), &dir).unwrap();
        assert_eq!(file(&v, "a.txt")["status"], "added");
        let st = run("git.status", &json!({}), &dir).unwrap();
        assert_eq!((st["branch"].as_str(), st["oid"].as_str()), (Some("main"), None));
        assert_eq!(file(&st, "a.txt")["index"], "added");
    }

    #[test]
    fn status_never_writes_and_config_cant_run_programs() {
        let dir = repo();
        // A repository that asks git to run programs: none of them may run.
        let marker = dir.join("ran");
        let script = dir.join("evil.sh");
        std::fs::write(&script, format!("#!/bin/sh\ntouch {}\necho x\n", marker.display())).unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let s = script.display().to_string();
        sh_git(&dir, &["config", "core.fsmonitor", &s]);
        sh_git(&dir, &["config", "diff.external", &s]);
        sh_git(&dir, &["config", "diff.evil.textconv", &s]);
        sh_git(&dir, &["config", "core.pager", &s]);
        write(&dir, ".gitattributes", b"*.go diff=evil\n");
        write(&dir, "src/main.go", b"package main // edited\n");
        let index = dir.join(".git/index");
        let before = std::fs::metadata(&index).unwrap().modified().unwrap();
        run("git.status", &json!({}), &dir).unwrap();
        let v = run("git.diff", &json!({}), &dir).unwrap();
        assert!(v["text"].as_str().unwrap().contains("+package main // edited"));
        run("git.show", &json!({ "rev": "HEAD" }), &dir).unwrap();
        run("git.log", &json!({}), &dir).unwrap();
        assert!(!marker.exists(), "a configured program ran");
        assert_eq!(std::fs::metadata(&index).unwrap().modified().unwrap(), before, "the index was rewritten");
    }

    #[test]
    fn the_folder_comes_from_yaah_never_the_source() {
        let dir = repo();
        let s = crate::sources::Sources::with_connections_file(dir.join("connections.json"));
        let e = tauri::async_runtime::block_on(s.read(&json!({ "kind": "git.status", "cwd": dir }))).unwrap_err();
        assert!(e.contains("reads the chat's folder"), "{e}");
        // A folder named in the source is ignored: the chat's is read.
        let elsewhere = temp("elsewhere");
        let source = json!({ "kind": "git.status", "cwd": elsewhere, "dir": elsewhere, "repo": elsewhere });
        let v = tauri::async_runtime::block_on(s.read_in(&source, Some(&dir))).unwrap();
        assert_eq!(v["branch"], "feature");
    }

    #[test]
    fn parses_status_records() {
        let out = "# branch.oid abc\0# branch.head (detached)\0# branch.upstream origin/main\0# branch.ab +2 -1\0\
                   u UU N... 100644 100644 100644 100644 a b c conflict.rs\0? new file.txt\0";
        let v = parse_status(out);
        assert_eq!(
            (v["branch"].clone(), v["detached"].as_bool(), v["ahead"].as_i64(), v["behind"].as_i64()),
            (Value::Null, Some(true), Some(2), Some(1))
        );
        assert_eq!(file(&v, "conflict.rs")["index"], "unmerged");
        assert_eq!(file(&v, "new file.txt")["worktree"], "untracked");
    }
}
