//! References to tracker items in a chat message: `github#owner/repo#9` (a pull
//! request or an issue: GitHub numbers them together), `gitlab#group/proj!45` (a
//! merge request), `gitlab#group/proj#7` (an issue) and `linear#ENG-123`.
//!
//! - **Suggestions** for the composer's `#`, `github#`, `gitlab#` and `linear#`
//!   lists: recent items (in the chat's repos first, then yours) and, as the user
//!   types, a search of the service. Ranked here; the UI only shows them.
//! - **On send** every token in the text is read and attached for the agent: an
//!   embedded `resource` (markdown, the item's https URI) when the agent accepts
//!   embedded context, else text after the message. One that can't be read goes
//!   anyway, with a short note for the agent, and is marked for the user.
//!
//! Read-only toward every tracker (GETs and GraphQL queries). Credentials stay in
//! `integrations.rs`: nothing here sees a token, and nothing it builds holds one.

use crate::integrations::Integrations;
use crate::work_items::{self, BriefCaps, QueueError, WorkService, clip, s, strings};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fmt::Write;
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

/// References read per message; later ones go as a note.
pub const MAX_REFERENCES: usize = 10;
/// How long the `#` list waits for one service before showing the others without it.
pub const SUGGEST_TIMEOUT: Duration = Duration::from_secs(6);
/// Characters of reference text per message, all references together.
pub const TOTAL_CHARS: usize = 60_000;
const BODY_CHARS: usize = 6_000;
const REF_COMMENTS: usize = 3;
const REF_COMMENT_CHARS: usize = 800;
/// Changed files listed for a PR or MR.
const MAX_FILES: usize = 50;
const REVIEWS: usize = 3;
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(15);
const SEARCH_TIMEOUT: Duration = Duration::from_secs(8);
/// How long a list or a search answer is reused (typing back and forth costs nothing).
const CACHE_FOR: Duration = Duration::from_secs(60);
const CACHE_SIZE: usize = 128;
/// Shorter queries filter the recent items only; ids and numbers always look up.
const MIN_SEARCH: usize = 2;
const LIMIT: usize = 30;
const PER_SEARCH: u64 = 20;
/// GitLab is read per project: at most this many of the chat's.
const GITLAB_REPOS: usize = 3;
/// GitHub's search takes them as `repo:` qualifiers.
const GITHUB_REPOS: usize = 5;
const QUERY_CHARS: usize = 100;

const CAPS: BriefCaps = BriefCaps { description: BODY_CHARS, comments: REF_COMMENTS, comment_chars: REF_COMMENT_CHARS, author: true };

// ── types (camelCase JSON, shared with the frontend) ────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Pr,
    Mr,
    Issue,
}

/// A tracker item as the composer lists it and the transcript shows it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    pub service: WorkService,
    pub kind: Kind,
    /// `owner/repo#9`, `group/proj!45`, `ENG-123`.
    pub id: String,
    /// What goes in the text: `github#owner/repo#9`.
    pub token: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub url: String,
    /// `open`, `draft`, `merged`, `closed`, `done` or `canceled`.
    #[serde(default)]
    pub state: String,
    /// The tracker's own name for it when it says more (Linear's "In Review", GitHub's "Not planned").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// `owner/repo`, `group/proj`, or a Linear team key.
    #[serde(default)]
    pub scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    /// Set on a sent reference that couldn't be read: why.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestions {
    pub items: Vec<Reference>,
    /// The services asked for that are connected (none: the UI offers Settings → Integrations).
    pub connected: Vec<WorkService>,
    pub errors: Vec<QueueError>,
}

/// A reference read for a message: its chip, and its details (`None`: couldn't be read).
#[derive(Debug, Clone)]
pub struct Resolved {
    pub reference: Reference,
    pub markdown: Option<String>,
}

/// What a message's references add to its prompt.
#[derive(Debug, Default)]
pub struct Content {
    /// Before the user's text: embedded resources.
    pub before: Vec<Value>,
    /// After it: the details as text (agents without embedded context) and notes.
    pub after: Vec<Value>,
    /// For the transcript.
    pub chips: Vec<Reference>,
}

fn token_of(service: WorkService, id: &str) -> String {
    format!("{}#{id}", service.as_str())
}

fn service_label(service: WorkService) -> &'static str {
    match service {
        WorkService::Github => "GitHub",
        WorkService::Gitlab => "GitLab",
        WorkService::Linear | WorkService::LinearProject => "Linear",
    }
}

// ── tokens in text ──────────────────────────────────────────────────────────

/// A reference token found in a message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Token {
    pub service: WorkService,
    /// Canonical: `owner/repo#9`, `group/proj!45`, `ENG-123`.
    pub id: String,
    /// GitLab's `!`/`#` say; GitHub's number could be either.
    pub kind: Option<Kind>,
    /// Byte range of the whole token in the text.
    pub start: usize,
    pub end: usize,
}

impl Token {
    pub fn text(&self) -> String {
        token_of(self.service, &self.id)
    }
}

const PREFIXES: [(&str, WorkService); 3] = [("github#", WorkService::Github), ("gitlab#", WorkService::Gitlab), ("linear#", WorkService::Linear)];

/// A token starts a word, or follows an opening bracket or quote (not a backtick: code stays code).
fn starts_word(text: &str, at: usize) -> bool {
    text[..at].chars().next_back().is_none_or(|c| c.is_whitespace() || "([{<\"'".contains(c))
}

/// What may follow a token: the end, a space, or punctuation.
fn ends_word(c: Option<char>) -> bool {
    c.is_none_or(|c| c.is_whitespace() || ".,;:!?)]}>\"'".contains(c))
}

fn take(s: &str, ok: impl Fn(char) -> bool) -> &str {
    &s[..s.find(|c: char| !ok(c)).unwrap_or(s.len())]
}

/// The id at the start of `rest` (after `github#` etc.), and how many bytes it takes.
fn id_at(service: WorkService, rest: &str) -> Option<(String, Option<Kind>, usize)> {
    if service == WorkService::Linear {
        let team = take(rest, |c| c.is_ascii_alphanumeric() || c == '_');
        let tail = rest[team.len()..].strip_prefix('-')?;
        let n = take(tail, |c| c.is_ascii_digit());
        let len = team.len() + 1 + n.len();
        let id = &rest[..len];
        return (work_items::linear_identifier(id) && ends_word(rest[len..].chars().next())).then(|| (id.to_uppercase(), Some(Kind::Issue), len));
    }
    let path = take(rest, |c| c.is_ascii_alphanumeric() || "_.-/".contains(c));
    let sep = rest[path.len()..].chars().next()?;
    let kind = match (service, sep) {
        (WorkService::Github, '#') => None,
        (WorkService::Gitlab, '#') => Some(Kind::Issue),
        (WorkService::Gitlab, '!') => Some(Kind::Mr),
        _ => return None,
    };
    let digits = take(&rest[path.len() + 1..], |c| c.is_ascii_digit());
    let len = path.len() + 1 + digits.len();
    let n: u64 = digits.parse().ok().filter(|n| *n > 0 && digits.len() <= 9)?;
    let valid = match service {
        WorkService::Github => work_items::github_repo(path).is_some(),
        _ => work_items::gitlab_project(path),
    };
    (valid && ends_word(rest[len..].chars().next())).then(|| (format!("{path}{sep}{n}"), kind, len))
}

/// Every reference token in `text`, in order.
pub fn tokens(text: &str) -> Vec<Token> {
    // ASCII lowercasing keeps every byte offset.
    let lower = text.to_ascii_lowercase();
    let mut out = vec![];
    let mut at = 0;
    while let Some(rel) = lower[at..].find('#') {
        let hash = at + rel;
        at = hash + 1;
        let Some((prefix, service)) = PREFIXES.iter().find(|(p, _)| lower[..=hash].ends_with(p)) else { continue };
        let start = hash + 1 - prefix.len();
        if !starts_word(text, start) {
            continue;
        }
        if let Some((id, kind, len)) = id_at(*service, &text[hash + 1..]) {
            out.push(Token { service: *service, id, kind, start, end: hash + 1 + len });
            at = hash + 1 + len;
        }
    }
    out
}

/// A GitHub, GitLab or Linear link to a PR, MR or issue, as a token.
/// `gitlab_base` is the connected GitLab instance (its links are read against it).
pub fn parse_link(input: &str, gitlab_base: Option<&str>) -> Option<Token> {
    let raw = input.trim().trim_start_matches('<').trim_end_matches('>');
    let url = reqwest::Url::parse(raw).ok().filter(|u| matches!(u.scheme(), "https" | "http"))?;
    let host = url.host_str()?.to_lowercase();
    let segs: Vec<&str> = url.path_segments().map(|s| s.filter(|p| !p.is_empty()).collect()).unwrap_or_default();
    let found = |service, id: String, kind| Some(Token { service, end: id.len(), id, kind, start: 0 });
    match (host.as_str(), segs.as_slice()) {
        ("github.com" | "www.github.com", [o, r, which @ ("issues" | "pull"), n, ..]) => {
            let id = format!("{o}/{r}#{n}");
            let kind = if *which == "pull" { Kind::Pr } else { Kind::Issue };
            return work_items::check_id(WorkService::Github, &id).ok().and_then(|id| found(WorkService::Github, id, Some(kind)));
        }
        ("linear.app", [_, "issue", key, ..]) => {
            return work_items::check_id(WorkService::Linear, key).ok().and_then(|id| found(WorkService::Linear, id, Some(Kind::Issue)));
        }
        _ => {}
    }
    // GitLab, on the connected instance (gitlab.com when none is): `/<group>/<project>/-/(issues|merge_requests)/<iid>`.
    let dash = segs.iter().position(|s| *s == "-")?;
    let [_, which @ ("issues" | "merge_requests"), iid, ..] = &segs[dash..] else { return None };
    let origin = url.origin().ascii_serialization();
    let path = work_items::gitlab_relative(gitlab_base.unwrap_or("https://gitlab.com"), &origin, &segs[..dash].join("/")).ok()?;
    let (sep, kind) = if *which == "issues" { ('#', Kind::Issue) } else { ('!', Kind::Mr) };
    let n: u64 = iid.parse().ok().filter(|n| *n > 0)?;
    work_items::gitlab_project(&path).then(|| found(WorkService::Gitlab, format!("{path}{sep}{n}"), Some(kind)))?
}

// ── states ──────────────────────────────────────────────────────────────────

fn github_state(state: &str, draft: bool) -> &'static str {
    match state.to_uppercase().as_str() {
        "OPEN" if draft => "draft",
        "OPEN" => "open",
        "MERGED" => "merged",
        _ => "closed",
    }
}

fn gitlab_state(state: &str, draft: bool) -> &'static str {
    match state {
        "opened" if draft => "draft",
        "opened" => "open",
        "merged" => "merged",
        _ => "closed",
    }
}

fn linear_state(kind: &str) -> &'static str {
    match kind {
        "completed" => "done",
        "canceled" => "canceled",
        _ => "open",
    }
}

// ── reading one reference ───────────────────────────────────────────────────

const GITHUB_ITEM_QUERY: &str = "query($o: String!, $r: String!, $n: Int!) { repository(owner: $o, name: $r) { nameWithOwner \
    issueOrPullRequest(number: $n) { __typename \
    ... on Issue { number title url body state stateReason createdAt updatedAt author { login } assignees(first: 5) { nodes { login } } \
      labels(first: 20) { nodes { name } } comments(last: 3) { nodes { author { login } body createdAt } } } \
    ... on PullRequest { number } } } }";

/// A GitHub issue from GraphQL in the shape `brief_block` reads.
fn github_issue_shape(repo: &str, i: &Value) -> Value {
    let state = i["state"].as_str().unwrap_or("OPEN");
    let label = match (state, i["stateReason"].as_str()) {
        ("CLOSED", Some("NOT_PLANNED")) => "Not planned",
        ("CLOSED", _) => "Closed",
        _ => "Open",
    };
    json!({
        "repo": repo, "number": i["number"], "ref": format!("{repo}#{}", i["number"]),
        "title": i["title"], "url": i["url"], "body": i["body"], "state": state.to_lowercase(), "stateLabel": label,
        "author": i["author"]["login"], "assignee": i["assignees"]["nodes"][0]["login"],
        "labels": strings(&i["labels"]["nodes"]),
        "comments": i["comments"]["nodes"].as_array().into_iter().flatten()
            .map(|c| json!({ "author": c["author"]["login"], "body": c["body"], "at": c["createdAt"] })).collect::<Vec<_>>(),
        "updatedAt": i["updatedAt"],
    })
}

fn files_block(out: &mut String, files: &[(String, Option<u64>, Option<u64>)], total: Option<u64>) {
    let total = total.unwrap_or(files.len() as u64);
    let _ = write!(out, "\n## Changed files ({total})\n\n");
    for (path, add, del) in files.iter().take(MAX_FILES) {
        match (add, del) {
            (Some(a), Some(d)) => {
                let _ = writeln!(out, "- {path} (+{a} −{d})");
            }
            _ => {
                let _ = writeln!(out, "- {path}");
            }
        }
    }
    let shown = files.len().min(MAX_FILES) as u64;
    if total > shown {
        let _ = writeln!(out, "- … and {} more", total - shown);
    }
}

/// A GitHub PR (as `sources::github_pr` shapes it) as Markdown.
pub(crate) fn pr_markdown(repo: &str, p: &Value) -> String {
    let id = format!("{repo}#{}", p["number"]);
    let mut out =
        format!("# {id} {}\n\n**Source:** GitHub pull request: {}\n", s(&p["title"]).unwrap_or_default().trim(), s(&p["url"]).unwrap_or_default());
    let mut facts = vec![format!("**State:** {}", s(&p["stateLabel"]).unwrap_or_default())];
    if let Some(a) = s(&p["author"]) {
        facts.push(format!("**Author:** {a}"));
    }
    facts.push(format!("**Branch:** {} → {}", s(&p["head"]).unwrap_or_default(), s(&p["base"]).unwrap_or_default()));
    facts.push(format!("**Review:** {}", s(&p["reviewLabel"]).unwrap_or_else(|| "none".into())));
    if let Some(c) = s(&p["checksSummary"]["text"]) {
        facts.push(format!("**Checks:** {c}"));
    }
    let labels = strings(&p["labels"]);
    if !labels.is_empty() {
        facts.push(format!("**Labels:** {}", labels.join(", ")));
    }
    out.push_str(&facts.join(" · "));
    let _ = writeln!(out, "\n**Changes:** +{} −{}", p["additions"].as_u64().unwrap_or(0), p["deletions"].as_u64().unwrap_or(0));
    let files: Vec<_> = p["files"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|f| Some((s(&f["path"])?, f["additions"].as_u64(), f["deletions"].as_u64())))
        .collect();
    files_block(&mut out, &files, p["changedFiles"].as_u64());
    let body = s(&p["body"]).map_or_else(|| "_No description._".into(), |b| clip(&b, BODY_CHARS));
    let _ = write!(out, "\n## Description\n\n{body}\n");
    let reviews: Vec<String> = p["reviews"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| r["body"].as_str().is_some_and(|b| !b.trim().is_empty()))
        .rev()
        .take(REVIEWS)
        .map(|r| {
            format!(
                "**{}** ({}): {}",
                r["author"].as_str().unwrap_or("someone"),
                r["state"].as_str().unwrap_or(""),
                clip(r["body"].as_str().unwrap_or(""), REF_COMMENT_CHARS)
            )
        })
        .collect();
    if !reviews.is_empty() {
        let _ = write!(out, "\n## Latest reviews\n\n{}\n", reviews.into_iter().rev().collect::<Vec<_>>().join("\n\n"));
    }
    out
}

/// A GitLab MR (its REST JSON, approvals and diffs) as Markdown.
pub(crate) fn mr_markdown(id: &str, mr: &Value, approvals: &Value, diffs: &Value) -> String {
    let mut out = format!(
        "# {id} {}\n\n**Source:** GitLab merge request: {}\n",
        s(&mr["title"]).unwrap_or_default().trim(),
        s(&mr["web_url"]).unwrap_or_default()
    );
    let state = gitlab_state(mr["state"].as_str().unwrap_or(""), mr["draft"] == true);
    let mut facts = vec![format!("**State:** {state}")];
    if let Some(a) = s(&mr["author"]["name"]).or_else(|| s(&mr["author"]["username"])) {
        facts.push(format!("**Author:** {a}"));
    }
    facts.push(format!("**Branch:** {} → {}", s(&mr["source_branch"]).unwrap_or_default(), s(&mr["target_branch"]).unwrap_or_default()));
    let approved_by: Vec<String> = approvals["approved_by"].as_array().into_iter().flatten().filter_map(|a| s(&a["user"]["name"])).collect();
    let review = if !approved_by.is_empty() {
        format!("approved by {}", approved_by.join(", "))
    } else if let Some(left) = approvals["approvals_left"].as_u64().filter(|n| *n > 0) {
        format!("{left} approval{} needed", if left == 1 { "" } else { "s" })
    } else {
        s(&mr["detailed_merge_status"]).map_or_else(|| "none".into(), |m| m.replace('_', " "))
    };
    facts.push(format!("**Review:** {review}"));
    let labels = strings(&mr["labels"]);
    if !labels.is_empty() {
        facts.push(format!("**Labels:** {}", labels.join(", ")));
    }
    out.push_str(&facts.join(" · "));
    out.push('\n');
    let files: Vec<_> = diffs
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|d| {
            let path = s(&d["new_path"]).or_else(|| s(&d["old_path"]))?;
            let text = d["diff"].as_str().unwrap_or("");
            let count = |m: char| text.lines().filter(|l| l.starts_with(m) && !l.starts_with(&m.to_string().repeat(3))).count() as u64;
            Some((path, Some(count('+')), Some(count('-'))))
        })
        .collect();
    let total = mr["changes_count"].as_str().and_then(|c| c.trim_end_matches('+').parse().ok()).or(Some(files.len() as u64));
    files_block(&mut out, &files, total);
    let body = s(&mr["description"]).map_or_else(|| "_No description._".into(), |b| clip(&b, BODY_CHARS));
    let _ = write!(out, "\n## Description\n\n{body}\n");
    out
}

/// Read one reference: its row and its details as Markdown.
pub(crate) async fn read(i: &Integrations, token: &Token) -> Result<(Reference, String), String> {
    let (path, number) = match token.service {
        WorkService::Linear | WorkService::LinearProject => ("", 0),
        _ => {
            let (path, number) = token.id.rsplit_once(['#', '!']).ok_or_else(|| format!("`{}` has no number", token.id))?;
            (path, number.parse::<u64>().map_err(|_| format!("`{}` has no number", token.id))?)
        }
    };
    let row = |kind, id: &str, title: &Value, url: &Value, state: &str, status: Option<String>, scope: &str, updated: &Value| Reference {
        service: token.service,
        kind,
        token: token_of(token.service, id),
        id: id.to_owned(),
        title: s(title).unwrap_or_default(),
        url: s(url).unwrap_or_default(),
        state: state.to_owned(),
        status,
        scope: scope.to_owned(),
        updated_at: s(updated),
        error: None,
    };
    match token.service {
        WorkService::Github => {
            let (owner, name) = work_items::github_repo(path).ok_or_else(|| format!("`{path}` isn't a GitHub repo"))?;
            let data = i.github_graphql(GITHUB_ITEM_QUERY, json!({ "o": owner, "r": name, "n": number })).await?;
            let repo = s(&data["repository"]["nameWithOwner"]).unwrap_or_else(|| path.to_owned());
            let item = &data["repository"]["issueOrPullRequest"];
            let id = format!("{repo}#{number}");
            match item["__typename"].as_str() {
                Some("PullRequest") => {
                    let pr = crate::sources::github_pr(i, (owner, name), number).await?;
                    let state = github_state(pr["state"].as_str().unwrap_or(""), pr["draft"] == true);
                    Ok((row(Kind::Pr, &id, &pr["title"], &pr["url"], state, None, &repo, &pr["updatedAt"]), pr_markdown(&repo, &pr)))
                }
                Some("Issue") => {
                    let shaped = github_issue_shape(&repo, item);
                    let state = github_state(item["state"].as_str().unwrap_or(""), false);
                    let status = (shaped["stateLabel"] == "Not planned").then(|| "Not planned".to_owned());
                    let md = work_items::brief_block_with(WorkService::Github, &shaped, &CAPS);
                    Ok((row(Kind::Issue, &id, &shaped["title"], &shaped["url"], state, status, &repo, &shaped["updatedAt"]), md))
                }
                _ => Err(format!("GitHub: no issue or pull request #{number} in {repo}")),
            }
        }
        WorkService::Gitlab if token.kind == Some(Kind::Mr) => {
            if !work_items::gitlab_project(path) {
                return Err(format!("`{path}` isn't a GitLab project"));
            }
            let base = format!("/projects/{}/merge_requests/{number}", work_items::gitlab_path(path));
            let mr = i.gitlab_get(&base).await?;
            // Approvals and files fill in the details; the MR still goes without them.
            let (approvals, diffs) = (format!("{base}/approvals"), format!("{base}/diffs?per_page={MAX_FILES}"));
            let (approvals, diffs) = tokio::join!(i.gitlab_get(&approvals), i.gitlab_get(&diffs));
            let id = s(&mr["references"]["full"]).filter(|r| r.contains('!')).unwrap_or_else(|| token.id.clone());
            let scope = id.rsplit_once('!').map_or(path, |(p, _)| p).to_owned();
            let state = gitlab_state(mr["state"].as_str().unwrap_or(""), mr["draft"] == true);
            let md = mr_markdown(&id, &mr, &approvals.unwrap_or_default(), &diffs.unwrap_or_default());
            Ok((row(Kind::Mr, &id, &mr["title"], &mr["web_url"], state, None, &scope, &mr["updated_at"]), md))
        }
        WorkService::Gitlab => {
            let item = work_items::gitlab_issue(i, path, number).await?;
            let id = s(&item["ref"]).unwrap_or_else(|| token.id.clone());
            let state = gitlab_state(item["state"].as_str().unwrap_or(""), false);
            let scope = s(&item["project"]).unwrap_or_else(|| path.to_owned());
            let md = work_items::brief_block_with(WorkService::Gitlab, &item, &CAPS);
            Ok((row(Kind::Issue, &id, &item["title"], &item["url"], state, None, &scope, &item["updatedAt"]), md))
        }
        WorkService::Linear | WorkService::LinearProject => {
            let item = work_items::linear_issue(i, &token.id).await?;
            let id = s(&item["id"]).unwrap_or_else(|| token.id.clone());
            let state = linear_state(item["stateType"].as_str().unwrap_or(""));
            let scope = s(&item["teamKey"]).unwrap_or_else(|| id.split('-').next().unwrap_or_default().to_owned());
            let md = work_items::brief_block_with(WorkService::Linear, &item, &CAPS);
            Ok((row(Kind::Issue, &id, &item["title"], &item["url"], state, s(&item["state"]), &scope, &item["updatedAt"]), md))
        }
    }
}

/// A reference that couldn't be read, as its chip.
fn failed(t: &Token, error: String) -> Resolved {
    let kind = t.kind.unwrap_or(if t.service == WorkService::Github { Kind::Pr } else { Kind::Issue });
    let scope = t.id.rsplit_once(['#', '!']).map_or_else(|| t.id.split('-').next().unwrap_or_default().to_owned(), |(p, _)| p.to_owned());
    Resolved {
        reference: Reference {
            service: t.service,
            kind,
            id: t.id.clone(),
            token: t.text(),
            title: String::new(),
            url: String::new(),
            state: String::new(),
            status: None,
            scope,
            updated_at: None,
            error: Some(error),
        },
        markdown: None,
    }
}

/// Every reference in `text` read, in order, each once; at most [`MAX_REFERENCES`]
/// (the rest are marked, not read). In parallel, each within its own time.
pub async fn resolve_text(i: &'static Integrations, text: &str) -> Vec<Resolved> {
    let mut seen = std::collections::HashSet::new();
    let unique: Vec<Token> = tokens(text).into_iter().filter(|t| seen.insert(t.text().to_lowercase())).collect();
    let mut set = tokio::task::JoinSet::new();
    for (n, t) in unique.iter().take(MAX_REFERENCES).cloned().enumerate() {
        set.spawn(async move {
            let out = match tokio::time::timeout(RESOLVE_TIMEOUT, read(i, &t)).await {
                Ok(Ok((reference, md))) => Resolved { reference, markdown: Some(md) },
                Ok(Err(e)) => failed(&t, e),
                Err(_) => failed(&t, format!("{} didn't answer within {RESOLVE_TIMEOUT:?}", service_label(t.service))),
            };
            (n, out)
        });
    }
    let mut out: Vec<Option<Resolved>> = vec![None; unique.len().min(MAX_REFERENCES)];
    while let Some(done) = set.join_next().await {
        if let Ok((n, r)) = done {
            out[n] = Some(r);
        }
    }
    let mut out: Vec<Resolved> = out.into_iter().zip(&unique).map(|(r, t)| r.unwrap_or_else(|| failed(t, "the read stopped".into()))).collect();
    out.extend(unique.iter().skip(MAX_REFERENCES).map(|t| failed(t, format!("not read: a message reads at most {MAX_REFERENCES} references"))));
    out
}

/// The blocks a message's references add, for an agent that does (`embedded`)
/// or doesn't take embedded resources. All of their text together stays within
/// [`TOTAL_CHARS`]; what's cut says so.
/// The live component in yaah's pack that shows this item, with the props it takes: the agent
/// is told so it can render the item instead of retelling it (`components/*.json`).
pub fn viewer(r: &Reference) -> Option<(&'static str, Value)> {
    let split = |sep: char| r.id.rsplit_once(sep).and_then(|(scope, n)| Some((scope.to_owned(), n.parse::<u64>().ok()?)));
    match (r.service, r.kind) {
        (WorkService::Linear, _) => Some(("linear-issue", json!({ "id": r.id }))),
        (WorkService::Github, Kind::Pr) => split('#').map(|(repo, number)| ("pr-view", json!({ "repo": repo, "number": number }))),
        (WorkService::Github, _) => split('#').map(|(repo, number)| ("github-issue", json!({ "repo": repo, "number": number }))),
        (WorkService::Gitlab, Kind::Issue) => split('#').map(|(project, iid)| ("gitlab-issue", json!({ "project": project, "iid": iid }))),
        (WorkService::Gitlab | WorkService::LinearProject, _) => None,
    }
}

/// The hint that goes with a referenced item: which live component shows it, and how.
fn viewer_hint(r: &Reference) -> Option<String> {
    let (name, props) = viewer(r)?;
    Some(format!(
        "To show {} to the user, render yaah's live `{name}` component with `ui_render` and props `{props}`; it reads the item itself and stays current, so don't retell what it shows.",
        r.token
    ))
}

pub fn content(resolved: &[Resolved], embedded: bool) -> Content {
    let mut out = Content::default();
    let mut left = TOTAL_CHARS;
    for r in resolved {
        let reference = &r.reference;
        out.chips.push(reference.clone());
        let Some(md) = &r.markdown else {
            let why = reference.error.as_deref().unwrap_or("unknown error");
            out.after
                .push(json!({ "type": "text", "text": format!("[yaah couldn't read {}: {why}. Its details aren't attached.]", reference.token) }));
            continue;
        };
        let len = md.chars().count();
        let md = if len <= left {
            md.clone()
        } else {
            format!("{}\n\n_(cut: a message's references carry at most {TOTAL_CHARS} characters)_", clip(md, left))
        };
        left = left.saturating_sub(len);
        // Which live component shows it: the agent renders that rather than retelling the item.
        let md = match viewer_hint(reference) {
            Some(hint) => format!("{md}\n\n{hint}"),
            None => md,
        };
        if embedded {
            let uri = if reference.url.starts_with("https://") {
                reference.url.clone()
            } else {
                format!("{}://{}", reference.service.as_str(), reference.id)
            };
            out.before.push(json!({ "type": "resource", "resource": { "uri": uri, "mimeType": "text/markdown", "text": md } }));
        } else {
            let from = service_label(reference.service);
            out.after.push(json!({ "type": "text", "text": format!("Referenced {} (read by yaah from {from}):\n\n{md}", reference.token) }));
        }
    }
    out
}

// ── suggestions ─────────────────────────────────────────────────────────────

/// Where the chat works: its repos on GitHub and GitLab (from its clones'
/// `origin`s and its project's link), and its project's Linear team.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Scope {
    pub github: Vec<String>,
    pub gitlab: Vec<String>,
    pub linear_team: Option<String>,
}

impl Scope {
    /// From the chat's folders (repo roots), the GitLab host connected, and the project's link (`service`, `id`).
    pub fn of(roots: &[std::path::PathBuf], gitlab_host: &str, link: Option<(&str, &str)>) -> Self {
        let mut scope = Self::default();
        let add = |list: &mut Vec<String>, path: &str| {
            let path = path.to_lowercase();
            if !list.contains(&path) {
                list.push(path);
            }
        };
        for root in roots.iter().filter(|r| !r.to_string_lossy().contains("/.yaah/projects/")) {
            let Some((host, path)) = crate::repos::describe(root).and_then(|r| r.origin).and_then(|o| crate::repos::remote_host_path(&o)) else {
                continue;
            };
            if host == "github.com" && work_items::github_repo(&path).is_some() {
                add(&mut scope.github, &path);
            } else if host == gitlab_host && work_items::gitlab_project(&path) {
                add(&mut scope.gitlab, &path);
            }
        }
        match link {
            Some(("github", id)) => {
                if let Some((p, _)) = id.rsplit_once('#') {
                    add(&mut scope.github, p);
                }
            }
            Some(("gitlab", id)) => {
                if let Some((p, _)) = id.rsplit_once('#') {
                    add(&mut scope.gitlab, p);
                }
            }
            Some(("linear", id)) => scope.linear_team = id.split_once('-').map(|(t, _)| t.to_uppercase()),
            _ => {}
        }
        scope
    }

    fn key(&self) -> String {
        format!("{}|{}|{}", self.github.join(","), self.gitlab.join(","), self.linear_team.as_deref().unwrap_or(""))
    }

    fn here(&self, r: &Reference) -> bool {
        let scope = r.scope.to_lowercase();
        match r.service {
            WorkService::Github => self.github.contains(&scope),
            WorkService::Gitlab => self.gitlab.contains(&scope),
            _ => self.linear_team.as_deref().is_some_and(|t| t.eq_ignore_ascii_case(&r.scope)),
        }
    }
}

/// Where a candidate came from, best first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Tier {
    /// In the chat's repos (or its project's Linear team).
    Here,
    /// Assigned to, opened by, or involving the user.
    Yours,
    Elsewhere,
}

#[derive(Debug, Clone)]
pub(crate) struct Candidate {
    pub reference: Reference,
    pub tier: Tier,
    /// The service found it for this query (it may match on text the row doesn't show).
    pub found: bool,
}

/// `fuzzyScore` from `src/lib/fuzzy.ts`: 0 is no match, higher is better.
fn fuzzy(query: &str, target: &str) -> f64 {
    let q = query.trim().to_lowercase();
    let t = target.to_lowercase();
    if q.is_empty() {
        return 1.0;
    }
    if t.is_empty() {
        return 0.0;
    }
    #[allow(clippy::cast_precision_loss, reason = "titles are short")]
    let len = |s: &str| s.chars().count() as f64;
    if t == q {
        return 1000.0;
    }
    if t.starts_with(&q) {
        return 500.0 - len(&t);
    }
    if let Some(at) = t.find(&q) {
        return 300.0 - len(&t[..at]);
    }
    let (qc, mut qi, mut last, mut bonus): (Vec<char>, usize, Option<usize>, f64) = (q.chars().collect(), 0, None, 0.0);
    for (ti, c) in t.chars().enumerate() {
        if qi < qc.len() && c == qc[qi] {
            if last.is_some_and(|l| l + 1 == ti) {
                bonus += 5.0;
            }
            last = Some(ti);
            qi += 1;
        }
    }
    if qi == qc.len() { 50.0 + bonus - len(&t) / 10.0 } else { 0.0 }
}

/// A substring or prefix match, rather than letters scattered through a title.
const STRONG: f64 = 200.0;

/// The query names this item exactly: its id, token or number (`12`, `#12`, `!12`).
fn exact(query: &str, r: &Reference) -> bool {
    let q = query.trim();
    if q.eq_ignore_ascii_case(&r.id) || q.eq_ignore_ascii_case(&r.token) {
        return true;
    }
    let n = q.trim_start_matches(['#', '!']);
    !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()) && r.id.rsplit(['#', '!', '-']).next() == Some(n)
}

/// Candidates deduped and ordered: an exact id first; then real matches before
/// loose ones; then the chat's repos, yours, the rest; then the closer match;
/// then the most recently updated. Recent items must match the query; what the
/// service found for it stays even when it matched on text the row doesn't show.
pub(crate) fn rank(candidates: Vec<Candidate>, query: &str, limit: usize) -> Vec<Reference> {
    let q = query.trim();
    let mut best: Vec<Candidate> = vec![];
    for c in candidates {
        let key = c.reference.token.to_lowercase();
        match best.iter_mut().find(|b| b.reference.token.to_lowercase() == key) {
            Some(b) => {
                b.tier = b.tier.min(c.tier);
                b.found |= c.found;
            }
            None => best.push(c),
        }
    }
    let mut scored: Vec<(bool, bool, Tier, f64, Reference)> = best
        .into_iter()
        .filter_map(|c| {
            let r = &c.reference;
            let score = [&r.id, &r.title, &r.scope, &r.token].iter().map(|f| fuzzy(q, f)).fold(0.0, f64::max);
            let named = exact(q, r);
            (score > 0.0 || c.found).then_some((!named, score < STRONG && !q.is_empty(), c.tier, score, c.reference))
        })
        .collect();
    scored.sort_by(|a, b| {
        (a.0, a.1, a.2)
            .cmp(&(b.0, b.1, b.2))
            .then(b.3.total_cmp(&a.3))
            .then_with(|| b.4.updated_at.as_deref().unwrap_or("").cmp(a.4.updated_at.as_deref().unwrap_or("")))
    });
    scored.into_iter().take(limit).map(|s| s.4).collect()
}

/// What a typed query is: trimmed, one line, no quotes (they'd end GitHub's search string), capped.
fn clean(query: &str) -> String {
    let q: String = query.chars().filter(|c| !c.is_control() && *c != '"' && *c != '\\').take(QUERY_CHARS).collect();
    q.trim().to_owned()
}

/// A number (`12`, `#12`, `!12`): looked up in the chat's repos.
fn number(q: &str) -> Option<u64> {
    let n = q.trim_start_matches(['#', '!']);
    (n.len() <= 9).then(|| n.parse().ok()).flatten().filter(|n| *n > 0)
}

/// Worth asking the service about: long enough, or an id or number.
fn searchable(q: &str) -> bool {
    q.chars().count() >= MIN_SEARCH || number(q).is_some()
}

fn candidate(r: Reference, scope: &Scope, yours: bool, found: bool) -> Candidate {
    let tier = if scope.here(&r) {
        Tier::Here
    } else if yours {
        Tier::Yours
    } else {
        Tier::Elsewhere
    };
    Candidate { reference: r, tier, found }
}

// GitHub: one GraphQL search for the chat's repos and one for yours, in one request.

const GITHUB_FIELDS: &str = "__typename ... on Issue { number title url state stateReason updatedAt repository { nameWithOwner } } \
    ... on PullRequest { number title url state isDraft updatedAt repository { nameWithOwner } }";

fn github_row(n: &Value) -> Option<Reference> {
    let repo = n["repository"]["nameWithOwner"].as_str()?;
    let number = n["number"].as_u64()?;
    let pr = n["__typename"] == "PullRequest";
    let id = format!("{repo}#{number}");
    Some(Reference {
        service: WorkService::Github,
        kind: if pr { Kind::Pr } else { Kind::Issue },
        token: token_of(WorkService::Github, &id),
        id,
        title: s(&n["title"]).unwrap_or_default(),
        url: s(&n["url"]).unwrap_or_default(),
        state: github_state(n["state"].as_str().unwrap_or(""), n["isDraft"] == true).to_owned(),
        status: (n["stateReason"] == "NOT_PLANNED").then(|| "Not planned".to_owned()),
        scope: repo.to_owned(),
        updated_at: s(&n["updatedAt"]),
        error: None,
    })
}

async fn github_candidates(i: &Integrations, scope: &Scope, q: &str) -> Result<Vec<Candidate>, String> {
    let found = !q.is_empty();
    // `owner/repo#12` and numbers: the item itself, from its repo or the chat's.
    let direct: Vec<(String, u64)> = match (work_items::split_ref(q), number(q)) {
        (Some((repo, n)), _) if work_items::github_repo(repo).is_some() => vec![(repo.to_owned(), n)],
        (_, Some(n)) => scope.github.iter().take(GITHUB_REPOS).map(|r| (r.clone(), n)).collect(),
        _ => vec![],
    };
    let mut out = vec![];
    if !direct.is_empty() {
        let (mut vars, mut fields, mut params) = (json!({}), String::new(), vec![]);
        for (k, (repo, n)) in direct.iter().enumerate() {
            let Some((o, r)) = work_items::github_repo(repo) else { continue };
            vars[format!("o{k}")] = json!(o);
            vars[format!("r{k}")] = json!(r);
            vars[format!("n{k}")] = json!(n);
            params.push(format!("$o{k}: String!, $r{k}: String!, $n{k}: Int!"));
            let _ = write!(fields, " d{k}: repository(owner: $o{k}, name: $r{k}) {{ issueOrPullRequest(number: $n{k}) {{ {GITHUB_FIELDS} }} }}");
        }
        // A missing repo or number fails the request: nothing to add then.
        if let Ok(data) = i.github_graphql(&format!("query({}) {{{fields} }}", params.join(", ")), vars).await {
            out.extend(
                (0..direct.len()).filter_map(|k| github_row(&data[format!("d{k}")]["issueOrPullRequest"])).map(|r| candidate(r, scope, false, true)),
            );
        }
        if work_items::split_ref(q).is_some() {
            return Ok(out);
        }
    }
    let repos: Vec<String> = scope.github.iter().take(GITHUB_REPOS).map(|r| format!("repo:{r}")).collect();
    let words = if found { format!("{q} ") } else { String::new() };
    let mine = if found { format!("{words}involves:@me sort:updated-desc") } else { "involves:@me is:open archived:false sort:updated-desc".into() };
    let mut vars = json!({ "mine": mine, "first": PER_SEARCH });
    let mut query = format!("query($mine: String!, $first: Int!{}) {{ ", if repos.is_empty() { "" } else { ", $here: String!" });
    if !repos.is_empty() {
        vars["here"] = json!(format!("{words}{} sort:updated-desc", repos.join(" ")));
        let _ = write!(query, "here: search(query: $here, type: ISSUE, first: $first) {{ nodes {{ {GITHUB_FIELDS} }} }} ");
    }
    let _ = write!(query, "mine: search(query: $mine, type: ISSUE, first: $first) {{ nodes {{ {GITHUB_FIELDS} }} }} }}");
    let data = i.github_graphql(&query, vars).await?;
    for (alias, yours) in [("here", false), ("mine", true)] {
        out.extend(data[alias]["nodes"].as_array().into_iter().flatten().filter_map(github_row).map(|r| candidate(r, scope, yours, found)));
    }
    Ok(out)
}

// GitLab: its REST API, per project of the chat's and across yours.

fn gitlab_row(v: &Value, kind: Kind) -> Option<Reference> {
    let sep = if kind == Kind::Mr { '!' } else { '#' };
    let id = s(&v["references"]["full"]).filter(|r| r.contains(sep))?;
    let scope = id.rsplit_once(sep)?.0.to_owned();
    Some(Reference {
        service: WorkService::Gitlab,
        kind,
        token: token_of(WorkService::Gitlab, &id),
        id,
        title: s(&v["title"]).unwrap_or_default(),
        url: s(&v["web_url"]).unwrap_or_default(),
        state: gitlab_state(v["state"].as_str().unwrap_or(""), v["draft"] == true).to_owned(),
        status: None,
        scope,
        updated_at: s(&v["updated_at"]),
        error: None,
    })
}

fn encode(q: &str) -> String {
    reqwest::Url::parse_with_params("http://x/", [("search", q)]).map(|u| u.query().unwrap_or_default().to_owned()).unwrap_or_default()
}

async fn gitlab_candidates(i: &'static Integrations, scope: &Scope, q: &str) -> Result<Vec<Candidate>, String> {
    let found = !q.is_empty();
    let search = if found { format!("&{}", encode(q)) } else { String::new() };
    let page = format!("order_by=updated_at&sort=desc&per_page={PER_SEARCH}{search}");
    // (path, kind, yours, single item)
    let mut reads: Vec<(String, Kind, bool, bool)> = vec![];
    let direct = q.rsplit_once(['#', '!']).filter(|(p, _)| work_items::gitlab_project(p)).and_then(|(p, n)| Some((p, n.parse::<u64>().ok()?)));
    if let Some((p, n)) = direct {
        let kind = if q.contains('!') { Kind::Mr } else { Kind::Issue };
        let what = if kind == Kind::Mr { "merge_requests" } else { "issues" };
        reads.push((format!("/projects/{}/{what}/{n}", work_items::gitlab_path(p)), kind, false, true));
    } else {
        for p in scope.gitlab.iter().take(GITLAB_REPOS) {
            let project = format!("/projects/{}", work_items::gitlab_path(p));
            if let Some(n) = number(q) {
                // `!12` is a merge request, `#12` an issue, `12` either.
                if !q.starts_with('#') {
                    reads.push((format!("{project}/merge_requests/{n}"), Kind::Mr, false, true));
                }
                if !q.starts_with('!') {
                    reads.push((format!("{project}/issues/{n}"), Kind::Issue, false, true));
                }
            } else {
                reads.push((format!("{project}/merge_requests?{page}"), Kind::Mr, false, false));
                reads.push((format!("{project}/issues?{page}"), Kind::Issue, false, false));
            }
        }
        if number(q).is_none() {
            let open = if found { "" } else { "&state=opened" };
            reads.push((format!("/merge_requests?scope=created_by_me{open}&{page}"), Kind::Mr, true, false));
            reads.push((format!("/issues?scope=assigned_to_me{open}&{page}"), Kind::Issue, true, false));
        }
    }
    let mut set = tokio::task::JoinSet::new();
    for (n, (path, kind, yours, single)) in reads.into_iter().enumerate() {
        set.spawn(async move { (n, kind, yours, single, i.gitlab_get(&path).await) });
    }
    let mut answers = vec![];
    while let Some(done) = set.join_next().await {
        answers.extend(done.ok());
    }
    answers.sort_by_key(|a| a.0);
    let mut out = vec![];
    for (_, kind, yours, single, answer) in answers {
        match (answer, single) {
            // A number that isn't there (or isn't an MR as well as an issue) is just not a match.
            (Err(_), true) => {}
            (Err(e), false) => return Err(e),
            (Ok(v), true) => out.extend(gitlab_row(&v, kind).map(|r| candidate(r, scope, yours, true))),
            (Ok(v), false) => {
                out.extend(v.as_array().into_iter().flatten().filter_map(|v| gitlab_row(v, kind)).map(|r| candidate(r, scope, yours, found)));
            }
        }
    }
    Ok(out)
}

// Linear: one GraphQL request.

const LINEAR_FIELDS: &str = "identifier title url updatedAt state { name type } team { key }";

fn linear_row(n: &Value) -> Option<Reference> {
    let id = s(&n["identifier"])?;
    Some(Reference {
        service: WorkService::Linear,
        kind: Kind::Issue,
        token: token_of(WorkService::Linear, &id),
        scope: s(&n["team"]["key"]).unwrap_or_else(|| id.split('-').next().unwrap_or_default().to_owned()),
        id,
        title: s(&n["title"]).unwrap_or_default(),
        url: s(&n["url"]).unwrap_or_default(),
        state: linear_state(n["state"]["type"].as_str().unwrap_or("")).to_owned(),
        status: s(&n["state"]["name"]),
        updated_at: s(&n["updatedAt"]),
        error: None,
    })
}

async fn linear_candidates(i: &Integrations, scope: &Scope, q: &str) -> Result<Vec<Candidate>, String> {
    let found = !q.is_empty();
    let open = json!({ "type": { "nin": ["completed", "canceled"] } });
    let mut lists: Vec<(&str, Value, bool)> = vec![];
    if found {
        lists.push(("found", json!({ "title": { "containsIgnoreCase": q } }), false));
        if let Some((team, n)) = q.split_once('-').filter(|_| work_items::linear_identifier(q)) {
            lists.push((
                "exact",
                json!({ "team": { "key": { "eq": team.to_uppercase() } }, "number": { "eq": n.parse::<u64>().unwrap_or(0) } }),
                false,
            ));
        } else if let (Some(team), Some(n)) = (&scope.linear_team, number(q)) {
            lists.push(("exact", json!({ "team": { "key": { "eq": team } }, "number": { "eq": n } }), false));
        }
    } else {
        lists.push(("assigned", json!({ "state": open, "assignee": { "isMe": { "eq": true } } }), true));
        lists.push(("created", json!({ "state": open, "creator": { "isMe": { "eq": true } } }), true));
        if let Some(team) = &scope.linear_team {
            lists.push(("team", json!({ "team": { "key": { "eq": team } } }), false));
        }
    }
    let params: Vec<String> = lists.iter().map(|(k, ..)| format!("${k}: IssueFilter")).collect();
    let mut fields = String::new();
    for (k, ..) in &lists {
        let _ = write!(fields, " {k}: issues(filter: ${k}, first: $first, orderBy: updatedAt) {{ nodes {{ {LINEAR_FIELDS} }} }}");
    }
    let mut vars = json!({ "first": PER_SEARCH });
    for (k, filter, _) in &lists {
        vars[*k] = filter.clone();
    }
    let data = i.linear(&format!("query({}, $first: Int) {{{fields} }}", params.join(", ")), vars).await?;
    Ok(lists
        .iter()
        .flat_map(|(k, _, yours)| {
            data[*k]["nodes"].as_array().into_iter().flatten().filter_map(linear_row).map(|r| candidate(r, scope, *yours, found)).collect::<Vec<_>>()
        })
        .collect())
}

/// Recent lists and searches, reused for [`CACHE_FOR`].
#[derive(Default)]
pub struct Cache {
    entries: Mutex<HashMap<String, (Instant, Vec<Candidate>)>>,
}

impl Cache {
    fn get(&self, key: &str) -> Option<Vec<Candidate>> {
        let map = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        map.get(key).filter(|(at, _)| at.elapsed() < CACHE_FOR).map(|(_, v)| v.clone())
    }

    fn put(&self, key: String, value: Vec<Candidate>) {
        let mut map = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        map.retain(|_, (at, _)| at.elapsed() < CACHE_FOR);
        if map.len() >= CACHE_SIZE
            && let Some(oldest) = map.iter().min_by_key(|(_, (at, _))| *at).map(|(k, _)| k.clone())
        {
            map.remove(&oldest);
        }
        map.insert(key, (Instant::now(), value));
    }
}

fn cache() -> &'static Cache {
    static CACHE: OnceLock<Cache> = OnceLock::new();
    CACHE.get_or_init(Cache::default)
}

async fn candidates(i: &'static Integrations, service: WorkService, scope: &Scope, q: &str) -> Result<Vec<Candidate>, String> {
    match service {
        WorkService::Github => github_candidates(i, scope, q).await,
        WorkService::Gitlab => gitlab_candidates(i, scope, q).await,
        _ => linear_candidates(i, scope, q).await,
    }
}

/// One service's recent items and, for a query, what it finds for it (cached).
async fn from_service(i: &'static Integrations, service: WorkService, scope: &Scope, q: &str, cache: &Cache) -> (Vec<Candidate>, Vec<QueueError>) {
    let (mut out, mut errors) = (vec![], vec![]);
    let queries = if searchable(q) { vec!["", q] } else { vec![""] };
    for query in queries {
        let key = format!("{}|{}|{}", service.as_str(), scope.key(), query.to_lowercase());
        if let Some(hit) = cache.get(&key) {
            out.extend(hit);
            continue;
        }
        match work_items::within(service, SEARCH_TIMEOUT, candidates(i, service, scope, query)).await {
            Ok(found) => {
                cache.put(key, found.clone());
                out.extend(found);
            }
            Err(e) => errors.push(e),
        }
    }
    (out, errors)
}

/// What the composer lists for `query` after `#` (every connected service) or
/// `github#`, `gitlab#`, `linear#` (`only`). A pasted link is looked up as is.
pub async fn suggest(i: &'static Integrations, scope: &Scope, only: Option<WorkService>, query: &str, cache: &Cache) -> Suggestions {
    let q = clean(query);
    let services = [WorkService::Github, WorkService::Gitlab, WorkService::Linear];
    let connected: Vec<WorkService> = services.into_iter().filter(|s| only.is_none_or(|o| o == *s) && i.connected(s.as_str())).collect();
    let mut out = Suggestions { connected: connected.clone(), ..Suggestions::default() };
    let gitlab_base = i.connected("gitlab").then(|| i.gitlab_base_url());
    if let Some(t) = parse_link(&q, gitlab_base.as_deref()) {
        if connected.contains(&t.service) {
            match work_items::within(t.service, RESOLVE_TIMEOUT, read(i, &t)).await {
                Ok((r, _)) => out.items.push(r),
                Err(e) => out.errors.push(e),
            }
        }
        return out;
    }
    // Any other link isn't something to search for.
    if q.starts_with("https://") || q.starts_with("http://") {
        return out;
    }
    let read = |s: WorkService| {
        let on = connected.contains(&s);
        let q = &q;
        async move {
            if !on {
                return (vec![], vec![]);
            }
            // A slow service doesn't hold the list: the others show, and it says it didn't answer.
            if let Ok(found) = tokio::time::timeout(SUGGEST_TIMEOUT, from_service(i, s, scope, q, cache)).await {
                found
            } else {
                let message = format!("{}: no answer in {} s", service_label(s), SUGGEST_TIMEOUT.as_secs());
                (vec![], vec![work_items::QueueError { service: s, kind: work_items::ErrorKind::Other, message }])
            }
        }
    };
    let (gh, gl, lin) = tokio::join!(read(WorkService::Github), read(WorkService::Gitlab), read(WorkService::Linear));
    let mut all = vec![];
    for (found, errors) in [gh, gl, lin] {
        all.extend(found);
        out.errors.extend(errors);
    }
    out.items = rank(all, &q, LIMIT);
    out
}

// ── commands ────────────────────────────────────────────────────────────────

/// The composer's `#` list for a chat: `service` is `github`, `gitlab`, `linear`, or none for all.
#[tauri::command]
pub async fn reference_suggestions(
    hub: tauri::State<'_, std::sync::Arc<crate::session::Hub>>,
    projects: tauri::State<'_, crate::projects::Projects>,
    session_id: String,
    service: Option<String>,
    query: String,
) -> Result<Suggestions, String> {
    let only = match service.as_deref().unwrap_or("") {
        "" => None,
        "github" => Some(WorkService::Github),
        "gitlab" => Some(WorkService::Gitlab),
        "linear" => Some(WorkService::Linear),
        other => return Err(format!("unknown service `{other}`; one of github, gitlab, linear")),
    };
    let i = Integrations::user();
    let roots = hub.session_roots(&session_id);
    let link = hub.session_info(&session_id).ok().and_then(|s| s.project_id).and_then(|p| projects.get(&p).ok()).and_then(|p| p.link);
    let host = reqwest::Url::parse(&i.gitlab_base_url()).ok().and_then(|u| u.host_str().map(str::to_lowercase)).unwrap_or_default();
    let scope = tokio::task::spawn_blocking(move || Scope::of(&roots, &host, link.as_ref().map(|l| (l.service.as_str(), l.id.as_str()))))
        .await
        .map_err(|e| e.to_string())?;
    Ok(suggest(i, &scope, only, &query, cache()).await)
}

#[cfg(test)]
mod tests;
