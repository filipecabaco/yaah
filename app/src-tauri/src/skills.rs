//! Agent skills (Settings → Skills): what is installed for the agents yaah
//! runs, and a quick install from GitHub.
//!
//! A skill is a folder with a `SKILL.md` (YAML frontmatter with `name` and
//! `description`) plus any files and scripts it needs. Each agent reads skills
//! from its own folder ([`skills_dir`]); several profiles can share one.
//!
//! Installing finds every folder with a `SKILL.md` in a repo (the git trees
//! API, recursive), previews each, and downloads the picked ones into a temp
//! folder that is renamed into place. Limits: [`MAX_FILES`] files and
//! [`MAX_BYTES`] per skill, no symlinks or submodules, relative paths only.
//! Where it came from goes in `.yaah-source.json` inside the skill, which is
//! what Update re-fetches. Nothing downloaded is ever run.

use crate::{accounts, agents, integrations};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

pub const MAX_FILES: usize = 300;
pub const MAX_BYTES: u64 = 10 * 1024 * 1024;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);
/// SKILL.md previews fetched per lookup; past this, point at a sub-folder.
const MAX_PREVIEWS: usize = 250;
/// Downloads in flight at once.
const PARALLEL: usize = 8;
const SOURCE_FILE: &str = ".yaah-source.json";
const TMP_PREFIX: &str = ".yaah-tmp-";

// ── Where agents read skills ────────────────────────────────────────────────

/// The user-level skills folders an agent profile reads, its own first, and the
/// doc that lists them (checked Nov 2026). Empty for agents whose docs don't
/// confirm one: Cursor's and Kiro's docs don't say their CLIs read the global
/// folder, and Cline's page couldn't be read. Project folders (`.claude/skills`
/// in a repo…) aren't listed: they belong to the repo.
pub fn skills_dirs(p: &agents::Profile) -> (Vec<PathBuf>, &'static str) {
    let home = accounts::home();
    let env = |k: &str| p.env.get(k).cloned().or_else(|| std::env::var(k).ok()).filter(|v| !v.is_empty()).map(PathBuf::from);
    let h = |rel: &str| home.join(rel);
    let shared = h(".agents/skills");
    match p.preset.as_str() {
        // "Personal: ~/.claude/skills/<skill-name>/SKILL.md"; CLAUDE_CONFIG_DIR moves ~/.claude.
        agents::CLAUDE => {
            let base = p.config_dir.as_ref().map(PathBuf::from).or_else(|| env("CLAUDE_CONFIG_DIR")).unwrap_or_else(|| h(".claude"));
            (vec![base.join("skills")], "https://code.claude.com/docs/en/skills")
        }
        // USER: "$HOME/.agents/skills".
        "codex" => (vec![shared], "https://learn.chatgpt.com/docs/build-skills"),
        // "~/.gemini/skills/ or the ~/.agents/skills/ alias"; GEMINI_CLI_HOME moves ~/.gemini.
        "gemini" => (vec![env("GEMINI_CLI_HOME").unwrap_or(home.clone()).join(".gemini/skills"), shared], "https://geminicli.com/docs/cli/skills"),
        "opencode" => (vec![h(".config/opencode/skills"), shared, h(".claude/skills")], "https://opencode.ai/docs/skills"),
        // "~/.copilot/skills or ~/.agents/skills"; COPILOT_HOME replaces ~/.copilot.
        "copilot" => (
            vec![env("COPILOT_HOME").unwrap_or_else(|| h(".copilot")).join("skills"), shared],
            "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-skills",
        ),
        "goose" => (
            vec![shared, h(".claude/skills")],
            "https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/context-engineering/using-skills.md",
        ),
        "qwen" => (vec![h(".qwen/skills"), shared], "https://qwenlm.github.io/qwen-code-docs/en/users/features/skills/"),
        "auggie" => (vec![h(".augment/skills"), shared, h(".claude/skills")], "https://docs.augmentcode.com/cli/skills"),
        "kimi" => (
            vec![h(".kimi/skills"), h(".config/agents/skills"), shared, h(".claude/skills"), h(".codex/skills")],
            "https://moonshotai.github.io/kimi-cli/en/customization/skills.html",
        ),
        "vibe" => (vec![h(".vibe/skills"), shared], "https://docs.mistral.ai/vibe/code/cli/skills"),
        _ => (vec![], ""),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRef {
    pub id: String,
    pub label: String,
    pub preset: String,
}

/// One skills folder and the agent profiles that read it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    pub dir: String,
    /// Whose folder it is: the agents that read it first, or "Shared".
    pub label: String,
    /// Every profile that reads it.
    pub agents: Vec<AgentRef>,
    pub docs: String,
    pub exists: bool,
    pub skills: Vec<Skill>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub name: String,
    pub description: String,
    /// The folder's name inside the skills folder.
    pub folder: String,
    pub dir: String,
    pub files: usize,
    /// The folder is a symlink (Remove deletes only the link).
    pub linked: bool,
    /// Set when yaah installed it.
    pub source: Option<Source>,
    /// What is wrong with its SKILL.md, if anything.
    pub problem: Option<String>,
}

/// Where a skill yaah installed came from (`.yaah-source.json`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub repo: String,
    #[serde(rename = "ref")]
    pub git_ref: String,
    /// Folder in the repo ("" for the root).
    pub path: String,
    pub sha: String,
    pub installed_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggested {
    pub repo: String,
    pub about: String,
}

/// Repos checked to hold `SKILL.md` folders (git trees API, Nov 2026).
const SUGGESTED: &[(&str, &str)] = &[
    ("anthropics/skills", "Anthropic's examples: documents (PDF, Word, Excel, slides), art, MCP builder"),
    ("supabase/agent-skills", "Supabase and Postgres best practices"),
    ("vercel-labs/agent-skills", "React, Next.js and Vercel deploys"),
    ("obra/superpowers", "Planning, TDD, debugging and code review workflows"),
    ("cloudflare/skills", "Workers, agents and the Cloudflare platform"),
    ("huggingface/skills", "Training, datasets and the Hugging Face Hub"),
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub locations: Vec<Location>,
    /// The skills folder to install into by default: the default Claude profile's.
    pub default_target: Option<String>,
    /// Profiles whose agent has no confirmed skills folder.
    pub unsupported: Vec<AgentRef>,
    pub suggested: Vec<Suggested>,
}

/// Skills folders for these profiles, one per folder: each agent's own
/// folders first (in profile order), then the ones they also read.
pub fn locations_for(profiles: &[agents::Profile], default_id: Option<&str>) -> (Vec<Location>, Option<String>) {
    let mut out: Vec<Location> = Vec::new();
    let mut owners: Vec<Vec<String>> = Vec::new();
    let mut default_target = None;
    let dirs: Vec<_> = profiles.iter().map(skills_dirs).collect();
    let longest = dirs.iter().map(|(d, _)| d.len()).max().unwrap_or(0);
    for rank in 0..longest {
        for (p, (list, docs)) in profiles.iter().zip(&dirs) {
            let Some(dir) = list.get(rank) else { continue };
            let folder_path = dir.to_string_lossy().into_owned();
            if rank == 0 && p.is_claude() && (default_target.is_none() || Some(p.id.as_str()) == default_id) {
                default_target = Some(folder_path.clone());
            }
            let agent = AgentRef { id: p.id.clone(), label: p.label.clone(), preset: p.preset.clone() };
            let i = out.iter().position(|l| l.dir == folder_path).unwrap_or_else(|| {
                out.push(Location {
                    exists: dir.is_dir(),
                    dir: folder_path,
                    label: String::new(),
                    agents: vec![],
                    docs: (*docs).into(),
                    skills: vec![],
                });
                owners.push(vec![]);
                out.len() - 1
            });
            out[i].agents.push(agent);
            // A folder is an agent's own when it's the first it reads, and it isn't the cross-agent one.
            if rank == 0 && !out[i].dir.ends_with("/.agents/skills") {
                owners[i].push(p.label.clone());
            }
        }
    }
    for (l, own) in out.iter_mut().zip(owners) {
        l.label = if own.is_empty() { "Shared".into() } else { own.join(", ") };
    }
    let default_target = default_target.or_else(|| out.first().map(|l| l.dir.clone()));
    (out, default_target)
}

/// Every skills folder of the saved agent profiles, with what is in each.
pub fn overview() -> Overview {
    let file = agents::Store::user().load();
    let (mut locations, default_target) = locations_for(&file.profiles, file.default_id().as_deref());
    for l in &mut locations {
        l.skills = list_dir(Path::new(&l.dir));
    }
    let unsupported = file
        .profiles
        .iter()
        .filter(|p| skills_dirs(p).0.is_empty())
        .map(|p| AgentRef { id: p.id.clone(), label: p.label.clone(), preset: p.preset.clone() })
        .collect();
    Overview {
        locations,
        default_target,
        unsupported,
        suggested: SUGGESTED.iter().map(|(repo, about)| Suggested { repo: (*repo).into(), about: (*about).into() }).collect(),
    }
}

/// The skills in one folder (symlinked skill folders included), by name.
pub fn list_dir(dir: &Path) -> Vec<Skill> {
    let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
    let mut skills: Vec<Skill> = rd
        .flatten()
        .filter_map(|e| {
            let folder = e.file_name().to_string_lossy().into_owned();
            let path = e.path();
            let skill_md = path.join("SKILL.md");
            if folder.starts_with('.') || !skill_md.is_file() {
                return None;
            }
            let linked = e.file_type().is_ok_and(|t| t.is_symlink());
            let (name, description, problem) = match std::fs::read_to_string(&skill_md).map_err(|e| e.to_string()).and_then(|t| describe(&t)) {
                Ok((n, d)) => (n, d, None),
                Err(e) => (folder.clone(), String::new(), Some(e)),
            };
            let source = std::fs::read_to_string(path.join(SOURCE_FILE)).ok().and_then(|s| serde_json::from_str(&s).ok());
            Some(Skill {
                name,
                description,
                files: count_files(&path, 1000),
                folder,
                dir: path.to_string_lossy().into_owned(),
                linked,
                source,
                problem,
            })
        })
        .collect();
    skills.sort_by_key(|s| (s.name.to_lowercase(), s.folder.clone()));
    skills
}

/// Files under `dir` (not following symlinks inside it), up to `cap`.
fn count_files(dir: &Path, cap: usize) -> usize {
    let mut n = 0;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            if n >= cap {
                return n;
            }
            match e.file_type() {
                Ok(t) if t.is_dir() => stack.push(e.path()),
                Ok(_) if e.file_name() != SOURCE_FILE => n += 1,
                _ => {}
            }
        }
    }
    n
}

// ── SKILL.md frontmatter ────────────────────────────────────────────────────

/// The top-level scalar keys of a YAML frontmatter block (`---` … `---`).
/// Covers what SKILL.md files use: plain, quoted and block (`|`, `>`) scalars,
/// and plain scalars continued on indented lines. Nested values are skipped.
pub fn frontmatter(text: &str) -> Option<BTreeMap<String, String>> {
    let mut lines = text.trim_start_matches('\u{feff}').lines();
    if lines.next()?.trim_end() != "---" {
        return None;
    }
    let mut body = Vec::new();
    let mut closed = false;
    for l in lines {
        if matches!(l.trim_end(), "---" | "...") {
            closed = true;
            break;
        }
        body.push(l);
    }
    if !closed {
        return None;
    }
    let indented = |l: &str| l.starts_with(' ') || l.starts_with('\t') || l.trim().is_empty();
    let mut map = BTreeMap::new();
    let mut i = 0;
    while i < body.len() {
        let line = body[i];
        i += 1;
        if indented(line) || line.starts_with('#') {
            continue;
        }
        let Some((key, rest)) = line.split_once(':') else { continue };
        let rest = rest.trim();
        let start = i;
        while i < body.len() && indented(body[i]) {
            i += 1;
        }
        let cont = &body[start..i];
        let value = if rest.starts_with('|') || rest.starts_with('>') {
            block_scalar(cont, rest.starts_with('>'))
        } else if rest.starts_with('"') || rest.starts_with('\'') {
            let joined = std::iter::once(rest).chain(cont.iter().map(|l| l.trim())).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" ");
            unquote(&joined)
        } else if rest.is_empty() && cont.iter().any(|l| l.trim_start().starts_with("- ") || l.contains(": ")) {
            continue; // a nested list or map
        } else {
            std::iter::once(rest).chain(cont.iter().map(|l| l.trim())).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" ")
        };
        map.insert(key.trim().to_owned(), value);
    }
    Some(map)
}

fn block_scalar(lines: &[&str], folded: bool) -> String {
    let indent = lines.iter().filter(|l| !l.trim().is_empty()).map(|l| l.len() - l.trim_start().len()).min().unwrap_or(0);
    let lines: Vec<&str> = lines.iter().map(|l| if l.trim().is_empty() { "" } else { &l[indent..] }).collect();
    let text = if folded { lines.split(|l| l.is_empty()).map(|para| para.join(" ")).collect::<Vec<_>>().join("\n") } else { lines.join("\n") };
    text.trim_end().to_owned()
}

fn unquote(s: &str) -> String {
    let mut chars = s.chars();
    let q = chars.next().unwrap_or('"');
    let mut out = String::new();
    while let Some(c) = chars.next() {
        match (q, c) {
            ('\'', '\'') if chars.clone().next() == Some('\'') => {
                chars.next();
                out.push('\'');
            }
            ('"', '\\') => match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some(o) => out.push(o),
                None => {}
            },
            (q, c) if c == q => break,
            _ => out.push(c),
        }
    }
    out
}

/// A SKILL.md's name and description, or what is missing.
pub fn describe(text: &str) -> Result<(String, String), String> {
    let fm = frontmatter(text).ok_or("SKILL.md has no YAML frontmatter")?;
    let get = |k: &str| fm.get(k).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
    match (get("name"), get("description")) {
        (Some(n), Some(d)) => Ok((n, d)),
        (None, _) => Err("SKILL.md frontmatter has no `name`".into()),
        (_, None) => Err("SKILL.md frontmatter has no `description`".into()),
    }
}

// ── Paths and inputs ────────────────────────────────────────────────────────

/// A repo path made safe to join under a folder: relative, no `..` or `.`,
/// no empty parts, backslashes or NULs.
pub fn safe_rel(path: &str) -> Result<PathBuf, String> {
    let bad = || format!("unsafe path `{path}`");
    if path.is_empty() || path.len() > 1024 || path.starts_with('/') || path.contains('\\') || path.contains('\0') {
        return Err(bad());
    }
    let mut out = PathBuf::new();
    for part in path.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.len() > 255 {
            return Err(bad());
        }
        out.push(part);
    }
    // Belt and braces: what the OS sees must be plain names only.
    if out.components().all(|c| matches!(c, Component::Normal(_))) { Ok(out) } else { Err(bad()) }
}

/// A skill's folder name: letters, digits, `.`, `_`, `-`, not starting with `.`.
/// `synced` is Claude Code's folder for skills from claude.ai.
pub fn folder_name(name: &str) -> Result<String, String> {
    let ok = !name.is_empty()
        && name.len() <= 100
        && !name.starts_with('.')
        && !name.eq_ignore_ascii_case("synced")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c));
    if ok { Ok(name.to_owned()) } else { Err(format!("`{name}` can't be a skill folder name")) }
}

/// What the user typed: `owner/repo`, `owner/repo/path/to/dir`, or a
/// github.com URL (`…/tree/<ref>/<path>`, `…/blob/<ref>/<path>/SKILL.md`).
#[derive(Debug, Clone, PartialEq)]
pub struct SourceInput {
    pub repo: String,
    pub git_ref: Option<String>,
    pub path: String,
}

pub fn parse_input(input: &str) -> Result<SourceInput, String> {
    let s = input.trim();
    let s = s.split(['?', '#']).next().unwrap_or("").trim_end_matches('/');
    let bare = s.trim_start_matches("https://").trim_start_matches("http://").trim_start_matches("www.");
    let (is_url, rest) = match bare.strip_prefix("github.com/") {
        Some(r) => (true, r),
        // Owners can't contain dots, so a first part with one is another host.
        None if s.contains("://") || bare.split('/').next().is_some_and(|h| h.contains('.')) => {
            return Err("only github.com sources are supported".into());
        }
        None => (false, bare),
    };
    let parts: Vec<&str> = rest.split('/').collect();
    if parts.len() < 2 || parts[0].is_empty() || parts[1].is_empty() {
        return Err("expected owner/repo, owner/repo/path or a github.com link".into());
    }
    let owner = parts[0];
    let repo = parts[1].strip_suffix(".git").unwrap_or(parts[1]);
    if owner.len() > 39 || !owner.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(format!("`{owner}` isn't a GitHub owner"));
    }
    if repo.len() > 100 || repo == "." || repo == ".." || !repo.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) {
        return Err(format!("`{repo}` isn't a GitHub repo name"));
    }
    let (git_ref, mut path): (Option<String>, Vec<&str>) = match &parts[2..] {
        [] => (None, vec![]),
        [kind, r, p @ ..] if is_url && (*kind == "tree" || *kind == "blob") => (Some((*r).to_owned()), p.to_vec()),
        [kind] if is_url && (*kind == "tree" || *kind == "blob") => return Err("the link has no branch after /tree/".into()),
        p if is_url => return Err(format!("link to a folder (github.com/{owner}/{repo}/tree/<branch>/<path>), not /{}", p[0])),
        p => (None, p.to_vec()),
    };
    if path.last() == Some(&"SKILL.md") {
        path.pop();
    }
    if let Some(r) = &git_ref {
        check_ref(r)?;
    }
    let path = path.join("/");
    if !path.is_empty() {
        safe_rel(&path)?;
    }
    Ok(SourceInput { repo: format!("{owner}/{repo}"), git_ref, path })
}

/// `owner/repo` as `parse_input` checks it.
fn check_repo(repo: &str) -> Result<(), String> {
    match parse_input(repo)? {
        SourceInput { git_ref: None, path, .. } if path.is_empty() => Ok(()),
        _ => Err(format!("`{repo}` isn't owner/repo")),
    }
}

/// A branch, tag or commit name: it goes into an API path.
fn check_ref(r: &str) -> Result<(), String> {
    let ok = !r.is_empty() && r.len() <= 255 && !r.contains("..") && r.chars().all(|c| c.is_ascii_alphanumeric() || "._/-".contains(c));
    if ok { Ok(()) } else { Err(format!("`{r}` isn't a branch, tag or commit")) }
}

fn check_sha(sha: &str) -> Result<(), String> {
    if sha.len() == 40 && sha.chars().all(|c| c.is_ascii_hexdigit()) { Ok(()) } else { Err(format!("`{sha}` isn't a commit sha")) }
}

/// Percent-encodes each segment of a path (keeping the slashes).
fn encode_path(p: &str) -> String {
    p.split('/')
        .map(|seg| {
            seg.bytes()
                .map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("/")
}

// ── Repo trees ──────────────────────────────────────────────────────────────

/// One entry of a recursive git tree.
#[derive(Debug, Clone, Deserialize)]
pub struct TreeEntry {
    pub path: String,
    pub mode: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub sha: String,
    #[serde(default)]
    pub size: Option<u64>,
}

/// Folders (under `base`, "" for the whole repo) that hold a SKILL.md.
pub fn skill_dirs_in(tree: &[TreeEntry], base: &str) -> Vec<String> {
    let mut dirs: Vec<String> = tree
        .iter()
        .filter(|e| e.kind == "blob" && e.mode != "120000")
        .filter_map(|e| if e.path == "SKILL.md" { Some(String::new()) } else { e.path.strip_suffix("/SKILL.md").map(str::to_owned) })
        .filter(|d| base.is_empty() || d == base || d.starts_with(&format!("{base}/")))
        .collect();
    dirs.sort();
    dirs
}

/// A file to download: its repo path, where it goes in the skill, its blob.
#[derive(Debug, Clone, PartialEq)]
pub struct PlannedFile {
    pub repo_path: String,
    pub rel: PathBuf,
    pub blob: String,
    pub size: u64,
    pub executable: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub files: Vec<PlannedFile>,
    pub bytes: u64,
    /// Symlinks and submodules left out.
    pub skipped: Vec<String>,
}

/// What installing the skill in folder `dir` would download, checked against the limits.
pub fn plan(tree: &[TreeEntry], dir: &str) -> Result<Plan, String> {
    let prefix = if dir.is_empty() { String::new() } else { format!("{dir}/") };
    let mut files = Vec::new();
    let mut skipped = Vec::new();
    let mut bytes = 0u64;
    for e in tree.iter().filter(|e| e.path.starts_with(&prefix) && e.kind != "tree") {
        let rel = &e.path[prefix.len()..];
        if e.mode == "120000" || e.kind == "commit" {
            skipped.push(rel.to_owned());
            continue;
        }
        if e.kind != "blob" || rel == SOURCE_FILE {
            continue;
        }
        let size = e.size.unwrap_or(0);
        bytes += size;
        files.push(PlannedFile { repo_path: e.path.clone(), rel: safe_rel(rel)?, blob: e.sha.clone(), size, executable: e.mode == "100755" });
    }
    if !files.iter().any(|f| f.rel == Path::new("SKILL.md")) {
        return Err("no SKILL.md in that folder".into());
    }
    if files.len() > MAX_FILES {
        return Err(format!("has {} files; the limit is {MAX_FILES}", files.len()));
    }
    if bytes > MAX_BYTES {
        return Err(format!("is {}; the limit is {}", human_bytes(bytes), human_bytes(MAX_BYTES)));
    }
    Ok(Plan { files, bytes, skipped })
}

#[allow(clippy::cast_precision_loss, reason = "sizes are shown to one decimal")]
pub fn human_bytes(b: u64) -> String {
    match b {
        b if b >= 1 << 20 => format!("{:.1} MB", b as f64 / (1u64 << 20) as f64),
        b if b >= 1 << 10 => format!("{:.0} KB", b as f64 / 1024.0),
        b => format!("{b} B"),
    }
}

// ── GitHub ──────────────────────────────────────────────────────────────────

async fn api_json(path: &str) -> Result<Value, String> {
    let text = integrations::github_get(path, "application/vnd.github+json", false).await?;
    serde_json::from_str(&text).map_err(|e| format!("GitHub: {e}"))
}

/// The commit a branch, tag or sha points at now.
async fn resolve(repo: &str, git_ref: &str) -> Result<String, String> {
    check_ref(git_ref)?;
    let sha = integrations::github_get(&format!("/repos/{repo}/commits/{}", encode_path(git_ref)), "application/vnd.github.sha", false).await?;
    let sha = sha.trim().to_owned();
    check_sha(&sha)?;
    Ok(sha)
}

/// The repo's whole tree at a commit, and whether GitHub cut it short.
async fn fetch_tree(repo: &str, sha: &str) -> Result<(Vec<TreeEntry>, bool), String> {
    let r = api_json(&format!("/repos/{repo}/git/trees/{sha}?recursive=1")).await?;
    let tree: Vec<TreeEntry> = serde_json::from_value(r["tree"].clone()).map_err(|e| format!("GitHub tree: {e}"))?;
    Ok((tree, r["truncated"] == true))
}

/// One file's bytes. With a GitHub connection through the blobs API (private
/// repos work); without one from raw.githubusercontent.com, which doesn't count
/// against the 60-an-hour API limit. Never more than [`MAX_BYTES`] is held.
async fn file_bytes(repo: &str, sha: &str, f: &PlannedFile, authed: bool) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let max = usize::try_from(MAX_BYTES).unwrap_or(usize::MAX);
    let bytes = if authed {
        let r = api_json(&format!("/repos/{repo}/git/blobs/{}", f.blob)).await?;
        let b64: String = r["content"].as_str().unwrap_or("").chars().filter(|c| !c.is_whitespace()).collect();
        base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| format!("{}: {e}", f.repo_path))?
    } else {
        let url = format!("https://raw.githubusercontent.com/{repo}/{sha}/{}", encode_path(&f.repo_path));
        let resp = integrations::http().get(url).timeout(DOWNLOAD_TIMEOUT).send().await.map_err(|e| format!("{}: {e}", f.repo_path))?;
        if !resp.status().is_success() {
            return Err(format!("{}: HTTP {}", f.repo_path, resp.status()));
        }
        integrations::read_capped(resp, max).await.map_err(|_| format!("{} is over {}", f.repo_path, human_bytes(MAX_BYTES)))?
    };
    if bytes.len() > max {
        return Err(format!("{} is over {}", f.repo_path, human_bytes(MAX_BYTES)));
    }
    Ok(bytes)
}

type Download = Pin<Box<dyn Future<Output = Result<Vec<u8>, String>> + Send>>;
/// Fetches one planned file: from GitHub in the app, from memory in tests.
type Fetch = Arc<dyn Fn(PlannedFile) -> Download + Send + Sync>;

fn from_github(repo: &str, sha: &str, authed: bool) -> Fetch {
    let (repo, sha) = (repo.to_owned(), sha.to_owned());
    Arc::new(move |f| {
        let (repo, sha) = (repo.clone(), sha.clone());
        Box::pin(async move { file_bytes(&repo, &sha, &f, authed).await })
    })
}

async fn signed_in() -> bool {
    integrations::auth("github").await.is_ok()
}

/// Runs `jobs` with at most [`PARALLEL`] in flight; results in input order.
async fn parallel<T, F>(jobs: Vec<F>) -> Vec<T>
where
    T: Send + 'static,
    F: std::future::Future<Output = T> + Send + 'static,
{
    let gate = Arc::new(tokio::sync::Semaphore::new(PARALLEL));
    let handles: Vec<_> = jobs
        .into_iter()
        .map(|job| {
            let gate = gate.clone();
            tokio::spawn(async move {
                let _permit = gate.acquire_owned().await;
                job.await
            })
        })
        .collect();
    let mut out = Vec::with_capacity(handles.len());
    for h in handles {
        out.push(h.await.expect("download task"));
    }
    out
}

// ── Look up ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    /// Folder in the repo ("" for the root).
    pub path: String,
    /// The folder it installs as.
    pub folder: String,
    pub name: String,
    pub description: String,
    pub files: usize,
    pub bytes: u64,
    pub skipped: Vec<String>,
    /// Why it can't be installed (limits, a bad SKILL.md…).
    pub problem: Option<String>,
    /// Skills folders that already have a folder by this name.
    pub installed_in: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lookup {
    pub repo: String,
    #[serde(rename = "ref")]
    pub git_ref: String,
    pub sha: String,
    pub path: String,
    pub skills: Vec<Found>,
    /// Went through the connected GitHub account.
    pub authenticated: bool,
    /// Notes worth showing: a cut-short tree, previews not loaded.
    pub notes: Vec<String>,
}

/// The folder name a repo folder installs as: its last part, or the repo's name for the root.
fn install_folder(repo: &str, dir: &str) -> Result<String, String> {
    folder_name(dir.rsplit('/').next().filter(|s| !s.is_empty()).unwrap_or_else(|| repo.rsplit('/').next().unwrap_or(repo)))
}

/// Finds the skills in a repo (or one folder of it) and previews each.
pub async fn lookup(input: &str, installed_dirs: &[String]) -> Result<Lookup, String> {
    let src = parse_input(input)?;
    let authenticated = signed_in().await;
    let (git_ref, path, sha) = match &src.git_ref {
        None => {
            let r = api_json(&format!("/repos/{}", src.repo)).await?;
            let branch = r["default_branch"].as_str().ok_or("GitHub: no default branch")?.to_owned();
            let sha = resolve(&src.repo, &branch).await?;
            (branch, src.path.clone(), sha)
        }
        // A branch with slashes (`tree/feat/x/skills`) reads as ref `feat` and path `x/skills`: try longer refs.
        Some(r) => {
            let parts: Vec<&str> = if src.path.is_empty() { vec![] } else { src.path.split('/').collect() };
            let mut found = Err(String::new());
            for take in 0..=parts.len().min(3) {
                let candidate = std::iter::once(r.as_str()).chain(parts[..take].iter().copied()).collect::<Vec<_>>().join("/");
                match resolve(&src.repo, &candidate).await {
                    Ok(sha) => {
                        found = Ok((candidate, parts[take..].join("/"), sha));
                        break;
                    }
                    Err(e) if found.as_ref().is_err_and(String::is_empty) => found = Err(e),
                    Err(_) => {}
                }
            }
            found?
        }
    };
    let (tree, truncated) = fetch_tree(&src.repo, &sha).await?;
    let mut notes = Vec::new();
    if truncated {
        notes.push("The repo is too big for GitHub to list in full; some skills may be missing. Look up a sub-folder instead.".into());
    }
    let dirs = skill_dirs_in(&tree, &path);
    if dirs.is_empty() {
        let at = if path.is_empty() { String::new() } else { format!("/{path}") };
        return Err(format!("no SKILL.md found in {}{at} at {git_ref}", src.repo));
    }
    if dirs.len() > MAX_PREVIEWS {
        notes.push(format!("Showing the first {MAX_PREVIEWS} of {} skills; look up a sub-folder for the rest.", dirs.len()));
    }
    let jobs: Vec<_> = dirs
        .into_iter()
        .take(MAX_PREVIEWS)
        .map(|dir| {
            let (repo, sha, tree_md) = (
                src.repo.clone(),
                sha.clone(),
                tree.iter().find(|e| e.path == if dir.is_empty() { "SKILL.md".into() } else { format!("{dir}/SKILL.md") }).cloned(),
            );
            let planned = plan(&tree, &dir);
            let installed_dirs = installed_dirs.to_vec();
            async move {
                let folder = install_folder(&repo, &dir);
                let fallback = folder.clone().unwrap_or_else(|_| dir.clone());
                let mut found = Found {
                    path: dir,
                    folder: fallback.clone(),
                    name: fallback,
                    description: String::new(),
                    files: 0,
                    bytes: 0,
                    skipped: vec![],
                    problem: None,
                    installed_in: vec![],
                };
                match (&folder, &planned) {
                    (Err(e), _) | (_, Err(e)) => found.problem = Some(e.clone()),
                    (Ok(folder), Ok(p)) => {
                        found.files = p.files.len();
                        found.bytes = p.bytes;
                        found.skipped = p.skipped.clone();
                        found.installed_in =
                            installed_dirs.iter().filter(|d| std::fs::symlink_metadata(Path::new(d).join(folder)).is_ok()).cloned().collect();
                    }
                }
                let md = PlannedFile {
                    repo_path: tree_md.as_ref().map(|e| e.path.clone()).unwrap_or_default(),
                    rel: "SKILL.md".into(),
                    blob: tree_md.map(|e| e.sha).unwrap_or_default(),
                    size: 0,
                    executable: false,
                };
                match file_bytes(&repo, &sha, &md, authenticated)
                    .await
                    .and_then(|b| String::from_utf8(b).map_err(|_| "SKILL.md isn't UTF-8".into()))
                    .and_then(|t| describe(&t))
                {
                    Ok((name, description)) => {
                        found.name = name;
                        found.description = description;
                    }
                    Err(e) => found.problem = found.problem.or(Some(e)),
                }
                found
            }
        })
        .collect();
    let skills = parallel(jobs).await;
    Ok(Lookup { repo: src.repo, git_ref, sha, path, skills, authenticated, notes })
}

// ── Install, update, remove ─────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRequest {
    pub repo: String,
    #[serde(rename = "ref")]
    pub git_ref: String,
    pub sha: String,
    /// Repo folders to install, from a lookup.
    pub paths: Vec<String>,
    /// A skills folder from the overview.
    pub target: String,
    #[serde(default)]
    pub replace: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    pub path: String,
    pub folder: String,
    pub dir: Option<String>,
    pub error: Option<String>,
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// Skills folders of the saved profiles (the only places install, update and remove touch).
pub fn known_dirs() -> Vec<String> {
    let file = agents::Store::user().load();
    locations_for(&file.profiles, None).0.into_iter().map(|l| l.dir).collect()
}

/// Install from a lookup into one of the profiles' skills folders.
pub async fn install(req: InstallRequest) -> Result<Vec<Installed>, String> {
    if !known_dirs().contains(&req.target) {
        return Err(format!("{} isn't a skills folder of an agent yaah runs", req.target));
    }
    install_into(Path::new(&req.target), &req.repo, &req.git_ref, &req.sha, &req.paths, req.replace).await
}

/// Install repo folders at a commit into `target`. Each skill succeeds or fails on its own.
pub async fn install_into(target: &Path, repo: &str, git_ref: &str, sha: &str, paths: &[String], replace: bool) -> Result<Vec<Installed>, String> {
    check_repo(repo)?;
    check_sha(sha)?;
    check_ref(git_ref)?;
    if paths.is_empty() {
        return Err("pick at least one skill".into());
    }
    let (tree, _) = fetch_tree(repo, sha).await?;
    let fetch = from_github(repo, sha, signed_in().await);
    let mut out = Vec::new();
    for path in paths {
        let folder = install_folder(repo, path);
        let r = match &folder {
            Ok(folder) => {
                let source = Source { repo: repo.into(), git_ref: git_ref.into(), path: path.clone(), sha: sha.into(), installed_at: now() };
                install_one(target, folder, &tree, source, replace, &fetch).await
            }
            Err(e) => Err(e.clone()),
        };
        out.push(Installed {
            path: path.clone(),
            folder: folder.unwrap_or_else(|_| path.clone()),
            dir: r.as_ref().ok().map(|d| d.to_string_lossy().into_owned()),
            error: r.err(),
        });
    }
    Ok(out)
}

/// Download one skill, then (off the async threads) write it into a temp folder
/// next to its final place and swap it in.
async fn install_one(target: &Path, folder: &str, tree: &[TreeEntry], source: Source, replace: bool, fetch: &Fetch) -> Result<PathBuf, String> {
    let folder = folder_name(folder)?;
    let plan = plan(tree, &source.path)?;
    let dest = target.join(&folder);
    if !replace && std::fs::symlink_metadata(&dest).is_ok() {
        return Err(format!("{folder} is already installed there"));
    }
    let files = download(&plan, fetch).await?;
    let target = target.to_owned();
    tokio::task::spawn_blocking(move || place(&target, &dest, &files, &source, replace)).await.map_err(|e| format!("install {folder}: {e}"))?
}

/// The planned files' bytes, refusing a skill that turns out larger than [`MAX_BYTES`]
/// (the tree's sizes are only what GitHub listed).
async fn download(plan: &Plan, fetch: &Fetch) -> Result<Vec<(PlannedFile, Vec<u8>)>, String> {
    let jobs: Vec<_> = plan
        .files
        .iter()
        .cloned()
        .map(|f| {
            let get = fetch(f.clone());
            async move { get.await.map(|b| (f, b)) }
        })
        .collect();
    let mut total = 0u64;
    let mut out = Vec::with_capacity(jobs.len());
    for r in parallel(jobs).await {
        let (f, bytes) = r?;
        total += bytes.len() as u64;
        if total > MAX_BYTES {
            return Err(format!("is over {}", human_bytes(MAX_BYTES)));
        }
        out.push((f, bytes));
    }
    Ok(out)
}

/// Write the files into a fresh temp folder in `target`, record the source, then
/// swap it in for `dest` (an old copy moves aside until the new one is in place).
fn place(target: &Path, dest: &Path, files: &[(PlannedFile, Vec<u8>)], source: &Source, replace: bool) -> Result<PathBuf, String> {
    let existing = std::fs::symlink_metadata(dest).ok();
    if existing.is_some() && !replace {
        return Err(format!("{} is already installed there", dest.file_name().unwrap_or_default().to_string_lossy()));
    }
    std::fs::create_dir_all(target).map_err(|e| format!("create {}: {e}", target.display()))?;
    let tmp = target.join(format!("{TMP_PREFIX}{}", &crate::session::random_token()[..12]));
    let filled = std::fs::create_dir(&tmp).map_err(|e| format!("create {}: {e}", tmp.display())).and_then(|()| {
        for (f, bytes) in files {
            write_new(&tmp.join(&f.rel), bytes, f.executable)?;
        }
        let json = serde_json::to_string_pretty(source).map_err(|e| e.to_string())?;
        write_new(&tmp.join(SOURCE_FILE), json.as_bytes(), false)
    });
    if let Err(e) = filled {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(e);
    }
    let old = target.join(format!("{TMP_PREFIX}old-{}", &crate::session::random_token()[..12]));
    if let Some(meta) = &existing {
        let moved = if meta.is_symlink() { std::fs::remove_file(dest) } else { std::fs::rename(dest, &old) };
        if let Err(e) = moved {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(format!("replace {}: {e}", dest.display()));
        }
    }
    if let Err(e) = std::fs::rename(&tmp, dest) {
        let _ = std::fs::rename(&old, dest);
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(format!("install {}: {e}", dest.display()));
    }
    let _ = std::fs::remove_dir_all(&old);
    Ok(dest.to_owned())
}

/// Write a file that must not exist yet (never follows a planted symlink).
/// Only files GitHub marks executable (100755) get the x bit, and only inside the skill.
fn write_new(path: &Path, bytes: &[u8], executable: bool) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(if executable { 0o755 } else { 0o644 })
        .open(path)
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    f.write_all(bytes).map_err(|e| format!("write {}: {e}", path.display()))
}

/// A skill folder directly inside one of `known` skills folders.
fn known_skill(dir: &str, known: &[String]) -> Result<PathBuf, String> {
    let p = PathBuf::from(dir);
    let name = p.file_name().and_then(|n| n.to_str()).ok_or_else(|| format!("{dir} isn't a skill folder"))?;
    folder_name(name)?;
    let parent = p.parent().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
    if !known.contains(&parent) {
        return Err(format!("{dir} isn't in a skills folder of an agent yaah runs"));
    }
    Ok(p)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Updated {
    pub updated: bool,
    pub sha: String,
}

/// Re-fetch a skill yaah installed from the latest commit of its branch.
pub async fn update(dir: &str) -> Result<Updated, String> {
    let dir = known_skill(dir, &known_dirs())?;
    update_at(&dir).await
}

pub async fn update_at(dir: &Path) -> Result<Updated, String> {
    let raw = std::fs::read_to_string(dir.join(SOURCE_FILE))
        .map_err(|_| "yaah didn't install this skill, so there's nothing to update from".to_string())?;
    let src: Source = serde_json::from_str(&raw).map_err(|e| format!("{SOURCE_FILE}: {e}"))?;
    check_repo(&src.repo)?;
    let sha = resolve(&src.repo, &src.git_ref).await?;
    if sha == src.sha {
        return Ok(Updated { updated: false, sha });
    }
    let (tree, _) = fetch_tree(&src.repo, &sha).await?;
    let folder = dir.file_name().and_then(|n| n.to_str()).ok_or("not a skill folder")?.to_owned();
    let target = dir.parent().ok_or("not a skill folder")?;
    let fetch = from_github(&src.repo, &sha, signed_in().await);
    let source = Source { sha: sha.clone(), installed_at: now(), ..src };
    install_one(target, &folder, &tree, source, true, &fetch).await?;
    Ok(Updated { updated: true, sha })
}

/// Delete a skill. A symlinked skill loses only the link.
pub fn remove(dir: &str) -> Result<(), String> {
    remove_at(&known_skill(dir, &known_dirs())?)
}

pub fn remove_at(dir: &Path) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    if meta.is_symlink() {
        return std::fs::remove_file(dir).map_err(|e| format!("remove {}: {e}", dir.display()));
    }
    if !dir.join("SKILL.md").is_file() {
        return Err(format!("{} has no SKILL.md; not removing it", dir.display()));
    }
    std::fs::remove_dir_all(dir).map_err(|e| format!("remove {}: {e}", dir.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, mode: &str, kind: &str, size: u64) -> TreeEntry {
        TreeEntry { path: path.into(), mode: mode.into(), kind: kind.into(), sha: format!("sha-{path}"), size: Some(size) }
    }
    fn blob(path: &str, size: u64) -> TreeEntry {
        entry(path, "100644", "blob", size)
    }

    #[test]
    fn reads_frontmatter() {
        let md = "---\nname: pdf\ndescription: Use this for PDFs: reading, merging.\nlicense: MIT\n---\n# PDF\n";
        assert_eq!(describe(md).unwrap(), ("pdf".into(), "Use this for PDFs: reading, merging.".into()));

        let quoted = "\u{feff}---\r\nname: \"my-skill\"\r\ndescription: 'It''s \"quoted\"'\r\n---\r\n";
        assert_eq!(describe(quoted).unwrap(), ("my-skill".into(), "It's \"quoted\"".into()));

        let escaped = "---\nname: x\ndescription: \"line\\none \\\"two\\\"\"\n---\n";
        assert_eq!(describe(escaped).unwrap().1, "line\none \"two\"");

        let folded = "---\nname: x\ndescription: >\n  Folded onto\n  one line.\n\n  New paragraph.\nmetadata:\n  author: me\n  version: \"1\"\n---\n";
        let fm = frontmatter(folded).unwrap();
        assert_eq!(fm["description"], "Folded onto one line.\nNew paragraph.");
        assert!(!fm.contains_key("metadata") && !fm.contains_key("author"), "nested maps are skipped");

        let literal = "---\nname: x\ndescription: |\n  keep\n    indent\n---\n";
        assert_eq!(frontmatter(literal).unwrap()["description"], "keep\n  indent");

        let plain_multiline = "---\nname: x\ndescription: Starts here\n  and carries on.\nallowed-tools:\n  - Read\n  - Bash\n---\n";
        let fm = frontmatter(plain_multiline).unwrap();
        assert_eq!(fm["description"], "Starts here and carries on.");
        assert!(!fm.contains_key("allowed-tools"));

        assert_eq!(describe("# no frontmatter").unwrap_err(), "SKILL.md has no YAML frontmatter");
        assert_eq!(describe("---\nname: x\n").unwrap_err(), "SKILL.md has no YAML frontmatter", "unclosed");
        assert_eq!(describe("---\nname: x\n---\n").unwrap_err(), "SKILL.md frontmatter has no `description`");
        assert_eq!(describe("---\ndescription: d\n---\n").unwrap_err(), "SKILL.md frontmatter has no `name`");
    }

    #[test]
    fn sanitizes_paths() {
        assert_eq!(safe_rel("scripts/run.py").unwrap(), PathBuf::from("scripts/run.py"));
        assert_eq!(safe_rel(".hidden/x").unwrap(), PathBuf::from(".hidden/x"));
        for bad in ["", "/etc/passwd", "../x", "a/../../x", "a/./b", "a//b", "a/", "a\\..\\b", "..", ".", "a\0b"] {
            assert!(safe_rel(bad).is_err(), "{bad:?} should be refused");
        }
        assert!(safe_rel(&"a".repeat(256)).is_err());
        assert!(folder_name("pdf").is_ok() && folder_name("my_skill-2.0").is_ok());
        for bad in ["", ".git", "..", "a/b", "a b", "ünï", "Synced"] {
            assert!(folder_name(bad).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn known_skill_must_be_directly_in_a_skills_folder() {
        let known = vec!["/h/.claude/skills".to_string()];
        assert!(known_skill("/h/.claude/skills/pdf", &known).is_ok());
        assert!(known_skill("/h/.claude/skills/../../.ssh", &known).is_err());
        assert!(known_skill("/h/.claude/skills/a/b", &known).is_err());
        assert!(known_skill("/h/.claude/skills", &known).is_err());
        assert!(known_skill("/elsewhere/pdf", &known).is_err());
    }

    #[test]
    fn plans_within_limits() {
        let tree = vec![
            entry("skills", "040000", "tree", 0),
            blob("skills/pdf/SKILL.md", 100),
            entry("skills/pdf/scripts/fill.py", "100755", "blob", 2_000),
            entry("skills/pdf/link", "120000", "blob", 10),
            entry("skills/pdf/vendor", "160000", "commit", 0),
            blob("skills/pdf/.yaah-source.json", 10),
            blob("skills/pdfx/SKILL.md", 10),
            blob("README.md", 10),
        ];
        let p = plan(&tree, "skills/pdf").unwrap();
        let rels: Vec<_> = p.files.iter().map(|f| f.rel.to_string_lossy().into_owned()).collect();
        assert_eq!(rels, ["SKILL.md", "scripts/fill.py"], "sibling `pdfx` and the reserved source file are left out");
        assert!(p.files[1].executable && !p.files[0].executable);
        assert_eq!(p.bytes, 2_100);
        assert_eq!(p.skipped, ["link", "vendor"], "symlinks and submodules are skipped");
        assert_eq!(plan(&tree, "skills").unwrap_err(), "no SKILL.md in that folder");

        let mut many = vec![blob("s/SKILL.md", 1)];
        many.extend((0..MAX_FILES).map(|i| blob(&format!("s/f{i}"), 1)));
        assert_eq!(plan(&many, "s").unwrap_err(), "has 301 files; the limit is 300");
        assert!(plan(&many[..MAX_FILES], "s").is_ok(), "exactly 300 is fine");

        let big = vec![blob("s/SKILL.md", 1), blob("s/data.bin", MAX_BYTES)];
        assert_eq!(plan(&big, "s").unwrap_err(), "is 10.0 MB; the limit is 10.0 MB");

        let evil = vec![blob("s/SKILL.md", 1), blob("s/a/../../x", 1)];
        assert!(plan(&evil, "s").unwrap_err().starts_with("unsafe path"));

        let root = vec![blob("SKILL.md", 1), blob("lib/x.js", 1), blob("other/SKILL.md", 1)];
        assert_eq!(skill_dirs_in(&root, ""), ["", "other"]);
        assert_eq!(skill_dirs_in(&tree, "skills"), ["skills/pdf", "skills/pdfx"]);
        assert_eq!(skill_dirs_in(&tree, "skills/pdf"), ["skills/pdf"], "a prefix match isn't a sub-folder");
        assert_eq!(install_folder("o/my-skill", "").unwrap(), "my-skill");
        assert_eq!(install_folder("o/r", "skills/pdf").unwrap(), "pdf");
    }

    #[test]
    fn parses_source_inputs() {
        let p = |s: &str| parse_input(s).unwrap();
        let si = |repo: &str, r: Option<&str>, path: &str| SourceInput { repo: repo.into(), git_ref: r.map(Into::into), path: path.into() };
        assert_eq!(p("anthropics/skills"), si("anthropics/skills", None, ""));
        assert_eq!(p(" anthropics/skills/skills/pdf/ "), si("anthropics/skills", None, "skills/pdf"));
        assert_eq!(p("https://github.com/anthropics/skills"), si("anthropics/skills", None, ""));
        assert_eq!(p("github.com/anthropics/skills.git"), si("anthropics/skills", None, ""));
        assert_eq!(p("https://github.com/anthropics/skills/tree/main/skills/pdf"), si("anthropics/skills", Some("main"), "skills/pdf"));
        assert_eq!(p("https://www.github.com/o/r/tree/v1.2"), si("o/r", Some("v1.2"), ""));
        assert_eq!(p("https://github.com/o/r/blob/main/skills/x/SKILL.md?plain=1#L3"), si("o/r", Some("main"), "skills/x"));
        assert_eq!(p("o/r/skills/x/SKILL.md"), si("o/r", None, "skills/x"));
        for bad in [
            "",
            "anthropics",
            "https://gitlab.com/o/r",
            "https://github.com/o/r/issues/3",
            "o/r/../x",
            "bad owner/r",
            "https://github.com/o/r/tree",
            "https://github.com/o/r/tree/a..b/x",
            "gist.github.com/o/r",
        ] {
            assert!(parse_input(bad).is_err(), "{bad:?} should be refused");
        }
        assert!(check_repo("o/r").is_ok() && check_repo("o/r/x").is_err());
        assert!(check_sha(&"a".repeat(40)).is_ok() && check_sha("main").is_err());
        assert_eq!(encode_path("feat/a b#1"), "feat/a%20b%231");
    }

    #[test]
    fn groups_locations_and_picks_the_default_claude() {
        let mk = |id: &str, preset: &str, dir: Option<&str>| agents::Profile {
            id: id.into(),
            label: id.into(),
            preset: preset.into(),
            command: "x".into(),
            args: vec![],
            env: BTreeMap::default(),
            config_dir: dir.map(Into::into),
            report: None,
        };
        let home = accounts::home().to_string_lossy().into_owned();
        let profiles = [
            mk("default", "claude", None),
            mk("work", "claude", Some("/h/.claude-work")),
            mk("same", "claude", Some("/h/.claude-work")),
            mk("c", "custom", None),
            mk("codex", "codex", None),
            mk("goose", "goose", None),
        ];
        let (locs, def) = locations_for(&profiles, Some("work"));
        let dirs: Vec<_> = locs.iter().map(|l| (l.dir.replace(&home, "~"), l.label.as_str(), l.agents.len())).collect();
        assert_eq!(
            dirs,
            [("~/.claude/skills".into(), "default", 2), ("/h/.claude-work/skills".into(), "work, same", 2), ("~/.agents/skills".into(), "Shared", 2)],
            "profiles sharing a folder share a location; goose also reads ~/.claude/skills; custom agents have none"
        );
        assert_eq!(def.as_deref(), Some("/h/.claude-work/skills"));
        assert_eq!(locations_for(&profiles, Some("c")).1, Some(locs[0].dir.clone()), "a non-Claude default falls back to the first Claude");
        assert_eq!(locations_for(&profiles[4..], None).1, Some(format!("{home}/.agents/skills")), "no Claude: the first folder");
    }

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("yaah-skills-{tag}-{}", crate::session::random_token()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn lists_and_removes() {
        let root = tmp("list");
        let skill = root.join("b-skill");
        std::fs::create_dir_all(skill.join("scripts")).unwrap();
        std::fs::write(skill.join("SKILL.md"), "---\nname: b-skill\ndescription: B\n---\n").unwrap();
        std::fs::write(skill.join("scripts/x.sh"), "echo").unwrap();
        let source = Source { repo: "o/r".into(), git_ref: "main".into(), path: "b-skill".into(), sha: "a".repeat(40), installed_at: 1 };
        std::fs::write(skill.join(SOURCE_FILE), serde_json::to_string(&source).unwrap()).unwrap();
        let broken = root.join("a-broken");
        std::fs::create_dir_all(&broken).unwrap();
        std::fs::write(broken.join("SKILL.md"), "no frontmatter").unwrap();
        std::fs::create_dir_all(root.join(".yaah-tmp-x")).unwrap();
        std::fs::write(root.join(".yaah-tmp-x/SKILL.md"), "").unwrap();
        std::fs::create_dir_all(root.join("not-a-skill")).unwrap();
        std::os::unix::fs::symlink(&skill, root.join("c-link")).unwrap();

        let list = list_dir(&root);
        let names: Vec<_> = list.iter().map(|s| (s.folder.as_str(), s.linked)).collect();
        assert_eq!(names, [("a-broken", false), ("b-skill", false), ("c-link", true)]);
        assert_eq!(list[0].problem.as_deref(), Some("SKILL.md has no YAML frontmatter"));
        assert_eq!(list[1].files, 2, "the source file isn't counted");
        assert_eq!(list[1].source.as_ref(), Some(&source));

        remove_at(&root.join("c-link")).unwrap();
        assert!(skill.join("SKILL.md").is_file(), "removing a link keeps what it points at");
        assert!(remove_at(&root.join("not-a-skill")).is_err());
        remove_at(&skill).unwrap();
        assert!(!skill.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    /// Files served from memory instead of GitHub; `bloat` makes one file larger than the tree said.
    fn from_memory(files: &[(&str, &str)], bloat: Option<&str>) -> Fetch {
        let files: BTreeMap<String, Vec<u8>> = files.iter().map(|(p, b)| ((*p).to_owned(), b.as_bytes().to_vec())).collect();
        let bloat = bloat.map(str::to_owned);
        Arc::new(move |f: PlannedFile| {
            let bytes = if bloat.as_deref() == Some(f.repo_path.as_str()) {
                Ok(vec![0u8; usize::try_from(MAX_BYTES).unwrap() + 1])
            } else {
                files.get(&f.repo_path).cloned().ok_or_else(|| format!("{}: HTTP 404 Not Found", f.repo_path))
            };
            Box::pin(async move { bytes })
        })
    }

    fn source_for(path: &str) -> Source {
        Source { repo: "o/r".into(), git_ref: "main".into(), path: path.into(), sha: "a".repeat(40), installed_at: 1 }
    }

    fn mode(p: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p).unwrap().permissions().mode() & 0o777
    }

    #[tokio::test]
    async fn installs_replaces_and_cleans_up_without_the_network() {
        let tree = vec![
            blob("skills/pdf/SKILL.md", 40),
            entry("skills/pdf/scripts/fill.sh", "100755", "blob", 9),
            blob("skills/pdf/docs/notes.md", 5),
            entry("skills/pdf/escape", "120000", "blob", 10),
        ];
        let files = [
            ("skills/pdf/SKILL.md", "---\nname: pdf\ndescription: PDFs\n---\n"),
            ("skills/pdf/scripts/fill.sh", "echo hi\n"),
            ("skills/pdf/docs/notes.md", "notes"),
        ];
        let target = tmp("install");
        let fetch = from_memory(&files, None);

        let dir = install_one(&target, "pdf", &tree, source_for("skills/pdf"), false, &fetch).await.unwrap();
        assert_eq!(dir, target.join("pdf"));
        assert_eq!(mode(&dir.join("scripts/fill.sh")), 0o755, "executable as GitHub marks it");
        assert_eq!(mode(&dir.join("docs/notes.md")), 0o644);
        assert!(!dir.join("escape").exists(), "symlinks are left out");
        let listed = list_dir(&target);
        assert_eq!((listed[0].name.as_str(), listed[0].files, listed[0].source.as_ref().unwrap().path.as_str()), ("pdf", 3, "skills/pdf"));

        let again = install_one(&target, "pdf", &tree, source_for("skills/pdf"), false, &fetch).await.unwrap_err();
        assert_eq!(again, "pdf is already installed there");
        std::fs::write(dir.join("local-edit.txt"), "mine").unwrap();
        install_one(&target, "pdf", &tree, source_for("skills/pdf"), true, &fetch).await.unwrap();
        assert!(!dir.join("local-edit.txt").exists(), "replacing swaps the whole folder");

        // A skill folder that is a link to elsewhere: replacing drops the link, never what it points at.
        let elsewhere = tmp("elsewhere");
        std::fs::write(elsewhere.join("SKILL.md"), "keep me").unwrap();
        std::os::unix::fs::symlink(&elsewhere, target.join("linked")).unwrap();
        install_one(&target, "linked", &tree, source_for("skills/pdf"), true, &fetch).await.unwrap();
        assert!(!std::fs::symlink_metadata(target.join("linked")).unwrap().is_symlink());
        assert_eq!(std::fs::read_to_string(elsewhere.join("SKILL.md")).unwrap(), "keep me");

        let left: Vec<_> = std::fs::read_dir(&target).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert!(left.iter().all(|n| !n.starts_with(TMP_PREFIX)), "no temp folders left behind: {left:?}");
        let _ = std::fs::remove_dir_all(target);
        let _ = std::fs::remove_dir_all(elsewhere);
    }

    #[tokio::test]
    async fn refuses_downloads_past_the_limits_and_leaves_nothing() {
        let tree = vec![blob("s/SKILL.md", 10), blob("s/data.bin", 10)];
        let target = tmp("limits");
        let files = [("s/SKILL.md", "---\nname: s\ndescription: d\n---\n"), ("s/data.bin", "x")];
        // GitHub's tree said 10 bytes; the file came back over the limit.
        let err = install_one(&target, "s", &tree, source_for("s"), false, &from_memory(&files, Some("s/data.bin"))).await.unwrap_err();
        assert_eq!(err, "is over 10.0 MB");
        let err = install_one(&target, "s", &tree, source_for("s"), false, &from_memory(&files[..1], None)).await.unwrap_err();
        assert_eq!(err, "s/data.bin: HTTP 404 Not Found");
        assert_eq!(
            install_one(&target, ".git", &tree, source_for("s"), false, &from_memory(&files, None)).await.unwrap_err(),
            "`.git` can't be a skill folder name"
        );
        assert_eq!(std::fs::read_dir(&target).unwrap().count(), 0, "a failed install leaves nothing");

        // Checked before anything is fetched.
        assert!(install_into(&target, "o/r", "main", "nope", &["s".into()], false).await.unwrap_err().contains("isn't a commit sha"));
        assert!(install_into(&target, "o/r/x", "main", &"a".repeat(40), &["s".into()], false).await.is_err());
        assert!(install_into(&target, "o/r", "a..b", &"a".repeat(40), &["s".into()], false).await.unwrap_err().contains("isn't a branch"));
        assert_eq!(install_into(&target, "o/r", "main", &"a".repeat(40), &[], false).await.unwrap_err(), "pick at least one skill");
        let _ = std::fs::remove_dir_all(target);
    }

    #[tokio::test]
    async fn update_refuses_a_tampered_source_file() {
        let dir = tmp("update").join("pdf");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(update_at(&dir).await.unwrap_err().contains("didn't install this skill"));
        let mut src = source_for("pdf");
        src.git_ref = "../../user".into();
        std::fs::write(dir.join(SOURCE_FILE), serde_json::to_string(&src).unwrap()).unwrap();
        assert!(update_at(&dir).await.unwrap_err().contains("isn't a branch, tag or commit"));
        src.repo = "evil.example.com/x".into();
        std::fs::write(dir.join(SOURCE_FILE), serde_json::to_string(&src).unwrap()).unwrap();
        assert!(update_at(&dir).await.is_err());
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }

    /// A real lookup and install of one small skill from anthropics/skills, into a temp folder.
    /// `cargo test --lib live_skills -- --ignored --nocapture`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "downloads from GitHub"]
    async fn live_skills_lookup_and_install() {
        let found = lookup("https://github.com/anthropics/skills/tree/main/skills", &[]).await.unwrap();
        println!("{} skills at {} ({}), authenticated: {}", found.skills.len(), found.git_ref, &found.sha[..7], found.authenticated);
        assert!(found.skills.len() > 5);
        let pick =
            found.skills.iter().filter(|s| s.problem.is_none() && s.files > 1).min_by_key(|s| s.bytes).expect("an installable multi-file skill");
        println!("installing {} ({} files, {}): {}", pick.folder, pick.files, human_bytes(pick.bytes), pick.description);

        let target = tmp("live");
        let paths = [pick.path.clone()];
        let r = install_into(&target, &found.repo, &found.git_ref, &found.sha, &paths, false).await.unwrap();
        assert!(r[0].error.is_none(), "{:?}", r[0].error);
        let listed = list_dir(&target);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, pick.name);
        assert_eq!(listed[0].files, pick.files);
        assert_eq!(listed[0].source.as_ref().unwrap().sha, found.sha);

        let again = install_into(&target, &found.repo, &found.git_ref, &found.sha, &paths, false).await.unwrap();
        assert_eq!(again[0].error.as_deref(), Some(format!("{} is already installed there", pick.folder).as_str()));
        let replaced = install_into(&target, &found.repo, &found.git_ref, &found.sha, &paths, true).await.unwrap();
        assert!(replaced[0].error.is_none());
        let dir = PathBuf::from(replaced[0].dir.as_ref().unwrap());
        assert!(!update_at(&dir).await.unwrap().updated, "already at the latest commit");
        // Pretend it came from an older commit: Update fetches it again.
        let mut src: Source = serde_json::from_str(&std::fs::read_to_string(dir.join(SOURCE_FILE)).unwrap()).unwrap();
        src.sha = "0".repeat(40);
        std::fs::write(dir.join(SOURCE_FILE), serde_json::to_string(&src).unwrap()).unwrap();
        let up = update_at(&dir).await.unwrap();
        println!("update: {up:?}");
        assert!(up.updated && up.sha == found.sha);
        assert_eq!(list_dir(&target)[0].source.as_ref().unwrap().sha, found.sha);
        let left: Vec<_> = std::fs::read_dir(&target).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(left.len(), 1, "no temp folders left behind: {left:?}");
        let _ = std::fs::remove_dir_all(target);
    }
}
