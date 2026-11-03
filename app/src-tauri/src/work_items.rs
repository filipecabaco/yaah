//! Projects from tracker items: a GitHub issue, a Linear issue, a Linear project
//! or a GitLab issue becomes a yaah project that remembers it.
//!
//! - The queue: the user's open items from every connected service, read in
//!   parallel; one service failing (or slow) never hides the others.
//! - Resolving: a pasted URL or id (`owner/repo#12`, `ENG-142`, …) to its item.
//! - Starting: a project named after the item, its status from the item's, a
//!   `link` to it, the item in the brief (between markers, so the user's own
//!   text survives a refresh), the matching local clone added for GitHub and
//!   GitLab issues, and a chat opened with a drafted (never sent) prompt.
//!
//! Read-only toward every tracker: only GETs and GraphQL queries go out. Item
//! text is the tracker's, so it is written into the brief as data (with the
//! block markers defused), never interpreted.
//!
//! The same fetchers feed the live sources `github.issue`, `github.issues`,
//! `gitlab.issue`, `gitlab.issues` and `linear.project`.

use crate::integrations::{self, Integrations};
use crate::projects::{Project, ProjectLink, Projects, Status};
use crate::repos;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fmt::Write;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Each service gets this long to answer the queue.
const SERVICE_TIMEOUT: Duration = Duration::from_secs(15);
const QUEUE_SIZE: u64 = 50;
/// Comments in the brief: the newest ones, oldest of them first.
const BRIEF_COMMENTS: usize = 10;
const COMMENT_CHARS: usize = 2_000;
const DESCRIPTION_CHARS: usize = 20_000;
/// Comments a live issue view keeps.
const SOURCE_COMMENTS: usize = 30;
/// GitHub's comment pages hold 100: a last page shorter than this reads the one before too.
const GITHUB_SHORT_PAGE: u64 = 30;
const NAME_CHARS: usize = 80;
const GITHUB_JSON: &str = "application/vnd.github+json";

// ── types (camelCase JSON, shared with the frontend) ────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkService {
    Github,
    Linear,
    LinearProject,
    Gitlab,
}

impl WorkService {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Github => "github",
            Self::Linear => "linear",
            Self::LinearProject => "linear-project",
            Self::Gitlab => "gitlab",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        [Self::Github, Self::Linear, Self::LinearProject, Self::Gitlab].into_iter().find(|w| w.as_str() == s)
    }

    /// The integration it reads through.
    fn connection(self) -> &'static str {
        match self {
            Self::Github => "github",
            Self::Linear | Self::LinearProject => "linear",
            Self::Gitlab => "gitlab",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Github => "GitHub issue",
            Self::Linear => "Linear issue",
            Self::LinearProject => "Linear project",
            Self::Gitlab => "GitLab issue",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Relation {
    Assigned,
    Created,
    Lead,
    Member,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItem {
    pub service: WorkService,
    pub id: String,
    pub title: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee: Option<String>,
    pub labels: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relation: Option<Relation>,
    /// `owner/repo` or `group/proj` for GitHub and GitLab issues.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    /// The yaah project already linked to it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    /// What the project's status is read from: Linear's state type, GitHub's
    /// state (or `not planned`), GitLab's state.
    #[serde(skip)]
    state_key: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    Auth,
    Forbidden,
    NotFound,
    RateLimited,
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueError {
    pub service: WorkService,
    pub kind: ErrorKind,
    pub message: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkQueue {
    pub items: Vec<WorkItem>,
    pub errors: Vec<QueueError>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    pub project: Project,
    /// A project already followed this item; nothing was created.
    pub existing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_id: Option<String>,
    /// The composer's text for the new chat (not sent).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub draft: Option<String>,
    /// Local clones added to the project's folders.
    pub added_repos: Vec<String>,
    /// Why no chat was opened (the project was still created).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_error: Option<String>,
}

// ── errors ──────────────────────────────────────────────────────────────────

/// What kind of failure an integration's error is, from the wording
/// `integrations.rs` and the APIs use for 401, 403, 404 and 429.
pub fn error_kind(message: &str) -> ErrorKind {
    let m = message.to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| m.contains(w));
    if has(&["isn't connected", "needs reconnecting", "refused the credential", "http 401", "authentication required", "unauthorized"]) {
        ErrorKind::Auth
    } else if has(&["rate limit", "http 429", "ratelimited", "too many requests"]) {
        ErrorKind::RateLimited
    } else if has(&["forbidden", "http 403"]) {
        ErrorKind::Forbidden
    } else if has(&["not found", "http 404", "could not find", "no such"]) {
        ErrorKind::NotFound
    } else {
        ErrorKind::Other
    }
}

// ── status ──────────────────────────────────────────────────────────────────

/// A project's status from an item's state (name or type, any case).
pub fn project_status(state: &str) -> Status {
    let s = state.trim().to_lowercase().replace(['_', '-'], " ");
    match s.as_str() {
        "done" | "closed" | "completed" | "merged" | "fixed" | "resolved" => Status::Done,
        "canceled" | "cancelled" | "archived" | "wontfix" | "won't fix" | "wont fix" | "not planned" | "duplicate" => Status::Archived,
        "backlog" | "todo" | "to do" | "unstarted" | "triage" | "open" | "opened" | "planned" => Status::Planning,
        _ => Status::Ongoing,
    }
}

// ── ids and pasted input ────────────────────────────────────────────────────

/// One path segment of a GitHub repo or a GitLab group/project.
fn path_part(p: &str) -> bool {
    !p.is_empty() && !p.starts_with('.') && p.len() <= 100 && p.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
}

/// `owner/repo` (exactly two parts).
fn github_repo(s: &str) -> Option<(&str, &str)> {
    let (o, r) = s.split_once('/')?;
    (path_part(o) && path_part(r)).then_some((o, r))
}

/// `group/sub/project` (two or more parts).
fn gitlab_project(s: &str) -> bool {
    let parts: Vec<&str> = s.split('/').collect();
    (2..=20).contains(&parts.len()) && parts.iter().all(|p| path_part(p))
}

/// `<path>#<n>`.
fn split_ref(id: &str) -> Option<(&str, u64)> {
    let (path, n) = id.trim().rsplit_once('#')?;
    let n = n.parse().ok().filter(|n| *n > 0)?;
    Some((path, n))
}

/// `ENG-142`.
fn linear_identifier(s: &str) -> bool {
    let Some((team, n)) = s.split_once('-') else { return false };
    team.starts_with(|c: char| c.is_ascii_alphabetic())
        && team.len() <= 16
        && team.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !n.is_empty()
        && n.len() <= 9
        && n.chars().all(|c| c.is_ascii_digit())
}

fn uuid(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    parts.iter().map(|p| p.len()).eq([8, 4, 4, 4, 12]) && parts.iter().all(|p| p.chars().all(|c| c.is_ascii_hexdigit()))
}

/// A Linear project's slug id: the hex tail of `refunds-v2-3f9a1c2b7d4e`, or the slug id itself.
fn linear_project_id(segment: &str) -> Option<String> {
    let id = segment.rsplit('-').next().unwrap_or(segment);
    let ok = !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric());
    if uuid(segment) {
        return Some(segment.to_lowercase());
    }
    ok.then(|| id.to_owned())
}

/// An item id that is well-formed for its service, normalised (Linear keys upper case).
pub fn check_id(service: WorkService, id: &str) -> Result<String, String> {
    let id = id.trim();
    let ok = match service {
        WorkService::Github => split_ref(id).is_some_and(|(p, _)| github_repo(p).is_some()),
        WorkService::Gitlab => split_ref(id).is_some_and(|(p, _)| gitlab_project(p)),
        WorkService::Linear => linear_identifier(id) || uuid(id),
        WorkService::LinearProject => linear_project_id(id).is_some_and(|p| p == id || uuid(id)),
    };
    if !ok {
        let want = match service {
            WorkService::Github => "`owner/repo#12`",
            WorkService::Gitlab => "`group/project#7`",
            WorkService::Linear => "an issue id like `ENG-142`",
            WorkService::LinearProject => "a project's slug id (the end of its URL)",
        };
        return Err(format!("`{id}` isn't a {}: expected {want}", service.label()));
    }
    Ok(if service == WorkService::Linear && !uuid(id) { id.to_uppercase() } else { id.to_owned() })
}

/// What a pasted URL or id names. `service` is `None` for a bare `owner/repo#12`,
/// which could be GitHub or GitLab.
#[derive(Debug, PartialEq)]
pub struct Parsed {
    pub service: Option<WorkService>,
    pub id: String,
    /// For a GitLab URL: its `scheme://host[:port]`, to check against the connection.
    pub origin: Option<String>,
}

pub const EXPECTED: &str = "expected a GitHub or GitLab issue URL or `owner/repo#12`, a Linear issue (`ENG-142` or its URL) or a Linear project URL";

pub fn parse_input(input: &str) -> Result<Parsed, String> {
    let raw = input.trim().trim_start_matches('<').trim_end_matches('>').trim();
    let nope = || format!("`{raw}` isn't something yaah can start from: {EXPECTED}");
    if raw.is_empty() {
        return Err(format!("paste a URL or id: {EXPECTED}"));
    }
    let with_scheme = if raw.starts_with("github.com/") || raw.starts_with("linear.app/") { format!("https://{raw}") } else { raw.to_owned() };
    if with_scheme.starts_with("https://") || with_scheme.starts_with("http://") {
        let url = reqwest::Url::parse(&with_scheme).map_err(|_| nope())?;
        let host = url.host_str().unwrap_or_default().to_lowercase();
        let segs: Vec<&str> = url.path_segments().map(|s| s.filter(|p| !p.is_empty()).collect()).unwrap_or_default();
        let item = |service, id: String| Ok(Parsed { service: Some(service), id, origin: None });
        match (host.as_str(), segs.as_slice()) {
            ("github.com" | "www.github.com", [o, r, "issues", n, ..]) => {
                let id = format!("{o}/{r}#{n}");
                return check_id(WorkService::Github, &id).map(|id| Parsed { service: Some(WorkService::Github), id, origin: None });
            }
            ("github.com" | "www.github.com", [_, _, "pull", ..]) => return Err("that's a pull request; paste an issue".into()),
            ("linear.app", [_, "issue", key, ..]) => return item(WorkService::Linear, check_id(WorkService::Linear, key)?),
            ("linear.app", [_, "project", slug, ..]) => {
                return item(WorkService::LinearProject, linear_project_id(slug).ok_or_else(nope)?);
            }
            _ => {}
        }
        // GitLab, any host: `/<group>/<project>/-/issues/<iid>`.
        if let Some(dash) = segs.iter().position(|s| *s == "-")
            && let [_, "issues", iid, ..] = &segs[dash..]
        {
            let id = format!("{}#{iid}", segs[..dash].join("/"));
            let origin = url.origin().ascii_serialization();
            return check_id(WorkService::Gitlab, &id).map(|id| Parsed { service: Some(WorkService::Gitlab), id, origin: Some(origin) });
        }
        return Err(nope());
    }
    if linear_identifier(raw) || uuid(raw) {
        return Ok(Parsed { service: Some(WorkService::Linear), id: check_id(WorkService::Linear, raw)?, origin: None });
    }
    if let Some((path, _)) = split_ref(raw) {
        if github_repo(path).is_some() {
            return Ok(Parsed { service: None, id: raw.to_owned(), origin: None });
        }
        if gitlab_project(path) {
            return Ok(Parsed { service: Some(WorkService::Gitlab), id: raw.to_owned(), origin: None });
        }
    }
    Err(nope())
}

/// A GitLab URL's project path, relative to the connected instance at `base`.
fn gitlab_relative(base: &str, origin: &str, id: &str) -> Result<String, String> {
    let base_url = reqwest::Url::parse(base).map_err(|e| e.to_string())?;
    if !base_url.origin().ascii_serialization().eq_ignore_ascii_case(origin) {
        return Err(format!("that issue is on {origin}, but GitLab is connected to {base}: change it in Settings → Integrations"));
    }
    // An instance under a path (`https://host/gitlab`) puts it before the group.
    let prefix = base_url.path().trim_matches('/');
    let id = if prefix.is_empty() { id } else { id.strip_prefix(prefix).and_then(|r| r.strip_prefix('/')).unwrap_or(id) };
    Ok(id.to_owned())
}

// ── shared bits of shaping ──────────────────────────────────────────────────

fn s(v: &Value) -> Option<String> {
    v.as_str().filter(|s| !s.is_empty()).map(str::to_owned)
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().into_iter().flatten().filter_map(|x| x.as_str().or(x["name"].as_str()).map(str::to_owned)).collect()
}

/// `text` cut to `max` characters, marked when cut.
fn clip(text: &str, max: usize) -> String {
    let text = text.trim();
    match text.char_indices().nth(max) {
        Some((at, _)) => format!("{}…", text[..at].trim_end()),
        None => text.to_owned(),
    }
}

/// Comments, oldest first, keeping the newest `keep`.
fn newest(mut comments: Vec<Value>, keep: usize) -> Vec<Value> {
    comments.sort_by(|a, b| a["at"].as_str().unwrap_or("").cmp(b["at"].as_str().unwrap_or("")));
    let skip = comments.len().saturating_sub(keep);
    comments.split_off(skip)
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

async fn github_json(i: &Integrations, path: &str, require_auth: bool) -> Result<Value, String> {
    let text = i.github_get(path, GITHUB_JSON, require_auth).await?;
    serde_json::from_str(&text).map_err(|_| "GitHub: the answer wasn't JSON".to_owned())
}

fn gitlab_path(project: &str) -> String {
    project.replace('/', "%2F")
}

// ── GitHub issues ───────────────────────────────────────────────────────────

fn github_state_label(i: &Value) -> &'static str {
    match (i["state"].as_str(), i["state_reason"].as_str()) {
        (Some("closed"), Some("not_planned")) => "Not planned",
        (Some("closed"), _) => "Closed",
        _ => "Open",
    }
}

/// `owner/repo` of an issue from the API (its canonical spelling).
fn github_issue_repo(i: &Value) -> Option<String> {
    if let Some(full) = i["repository"]["full_name"].as_str() {
        return Some(full.to_owned());
    }
    let url = i["repository_url"].as_str()?;
    let mut parts = url.rsplit('/');
    let (r, o) = (parts.next()?, parts.next()?);
    Some(format!("{o}/{r}"))
}

fn github_row(i: &Value, relation: Option<Relation>) -> Option<WorkItem> {
    let repo = github_issue_repo(i)?;
    let number = i["number"].as_u64()?;
    let label = github_state_label(i);
    Some(WorkItem {
        service: WorkService::Github,
        id: format!("{repo}#{number}"),
        title: s(&i["title"]).unwrap_or_default(),
        url: s(&i["html_url"]).unwrap_or_default(),
        status: Some(label.to_owned()),
        assignee: s(&i["assignee"]["login"]).or_else(|| s(&i["assignees"][0]["login"])),
        labels: strings(&i["labels"]),
        relation,
        repo: Some(repo),
        project_id: None,
        updated_at: s(&i["updated_at"]),
        state_key: Some(label.to_lowercase()),
    })
}

async fn github_queue(i: &Integrations) -> Result<Vec<WorkItem>, String> {
    let mut groups = vec![];
    for (filter, relation) in [("assigned", Relation::Assigned), ("created", Relation::Created)] {
        let path = format!("/issues?filter={filter}&state=open&sort=updated&per_page={QUEUE_SIZE}");
        let rows = github_json(i, &path, true).await?;
        groups.push(
            rows.as_array().into_iter().flatten().filter(|r| r.get("pull_request").is_none()).filter_map(|r| github_row(r, Some(relation))).collect(),
        );
    }
    Ok(merge(groups))
}

/// A GitHub issue shaped for display and the brief, with its newest comments.
async fn github_issue(i: &Integrations, repo: &str, number: u64) -> Result<Value, String> {
    let (o, r) = github_repo(repo).ok_or_else(|| format!("`{repo}` isn't a repo; use \"owner/name\""))?;
    let issue = github_json(i, &format!("/repos/{o}/{r}/issues/{number}"), false).await?;
    // Comments come oldest first: read the last page (and the one before when it's short).
    let count = issue["comments"].as_u64().unwrap_or(0);
    let mut comments: Vec<Value> = vec![];
    if count > 0 {
        let last = count.div_ceil(100).max(1);
        let pages = if count % 100 != 0 && count % 100 < GITHUB_SHORT_PAGE && last > 1 { vec![last - 1, last] } else { vec![last] };
        for page in pages {
            let rows = github_json(i, &format!("/repos/{o}/{r}/issues/{number}/comments?per_page=100&page={page}"), false).await?;
            comments.extend(
                rows.as_array().into_iter().flatten().map(|c| json!({ "author": c["user"]["login"], "body": c["body"], "at": c["created_at"] })),
            );
        }
    }
    Ok(shape_github_issue(&issue, &newest(comments, SOURCE_COMMENTS)))
}

fn shape_github_issue(i: &Value, comments: &[Value]) -> Value {
    let repo = github_issue_repo(i).unwrap_or_default();
    json!({
        "repo": repo, "number": i["number"], "ref": format!("{repo}#{}", i["number"]),
        "title": i["title"], "url": i["html_url"], "body": i["body"],
        "state": i["state"], "stateLabel": github_state_label(i),
        "author": i["user"]["login"],
        "assignee": i["assignee"]["login"].as_str().or(i["assignees"][0]["login"].as_str()),
        "assignees": i["assignees"].as_array().into_iter().flatten().map(|a| a["login"].clone()).collect::<Vec<_>>(),
        "labels": strings(&i["labels"]),
        "milestone": i["milestone"]["title"],
        "commentCount": i["comments"],
        "comments": comments,
        "createdAt": i["created_at"], "updatedAt": i["updated_at"], "closedAt": i["closed_at"],
        "isPullRequest": i.get("pull_request").is_some(),
    })
}

async fn github_issues_source(i: &Integrations, repo: &str, state: &str, limit: u64) -> Result<Value, String> {
    let (o, r) = github_repo(repo).ok_or_else(|| format!("`{repo}` isn't a repo; use \"owner/name\""))?;
    if !matches!(state, "open" | "closed" | "all") {
        return Err(format!("state `{state}` isn't one of open, closed, all"));
    }
    let rows =
        github_json(i, &format!("/repos/{o}/{r}/issues?state={state}&sort=updated&direction=desc&per_page={}", limit.clamp(1, 100)), false).await?;
    Ok(rows
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| r.get("pull_request").is_none())
        .map(|i| {
            json!({
                "number": i["number"], "title": i["title"], "url": i["html_url"],
                "state": i["state"], "stateLabel": github_state_label(i), "author": i["user"]["login"],
                "assignee": i["assignee"]["login"], "labels": strings(&i["labels"]),
                "comments": i["comments"], "updatedAt": i["updated_at"],
            })
        })
        .collect())
}

// ── GitLab issues ───────────────────────────────────────────────────────────

fn gitlab_state_label(state: &str) -> &'static str {
    if state == "closed" { "Closed" } else { "Open" }
}

fn gitlab_ref(i: &Value) -> Option<String> {
    s(&i["references"]["full"]).filter(|r| r.contains('#'))
}

fn gitlab_row(i: &Value, relation: Option<Relation>) -> Option<WorkItem> {
    let id = gitlab_ref(i)?;
    let state = i["state"].as_str().unwrap_or("opened");
    Some(WorkItem {
        service: WorkService::Gitlab,
        repo: id.rsplit_once('#').map(|(p, _)| p.to_owned()),
        id,
        title: s(&i["title"]).unwrap_or_default(),
        url: s(&i["web_url"]).unwrap_or_default(),
        status: Some(gitlab_state_label(state).to_owned()),
        assignee: s(&i["assignee"]["name"]).or_else(|| s(&i["assignees"][0]["name"])),
        labels: strings(&i["labels"]),
        relation,
        project_id: None,
        updated_at: s(&i["updated_at"]),
        state_key: Some(state.to_owned()),
    })
}

async fn gitlab_queue(i: &Integrations) -> Result<Vec<WorkItem>, String> {
    let mut groups = vec![];
    for (scope, relation) in [("assigned_to_me", Relation::Assigned), ("created_by_me", Relation::Created)] {
        let rows = i.gitlab_get(&format!("/issues?scope={scope}&state=opened&order_by=updated_at&sort=desc&per_page={QUEUE_SIZE}")).await?;
        groups.push(rows.as_array().into_iter().flatten().filter_map(|r| gitlab_row(r, Some(relation))).collect());
    }
    Ok(merge(groups))
}

/// A GitLab issue shaped for display and the brief, with its newest notes by people.
async fn gitlab_issue(i: &Integrations, project: &str, iid: u64) -> Result<Value, String> {
    if !gitlab_project(project) {
        return Err(format!("`{project}` isn't a GitLab project; use \"group/project\""));
    }
    let base = format!("/projects/{}/issues/{iid}", gitlab_path(project));
    let issue = i.gitlab_get(&base).await?;
    let notes = i.gitlab_get(&format!("{base}/notes?sort=desc&order_by=created_at&per_page=100")).await?;
    let comments: Vec<Value> = notes
        .as_array()
        .into_iter()
        .flatten()
        .filter(|n| n["system"] != true)
        .map(|n| json!({ "author": n["author"]["name"].as_str().or(n["author"]["username"].as_str()), "body": n["body"], "at": n["created_at"] }))
        .collect();
    Ok(shape_gitlab_issue(&issue, project, &newest(comments, SOURCE_COMMENTS)))
}

fn shape_gitlab_issue(i: &Value, project: &str, comments: &[Value]) -> Value {
    let reference = gitlab_ref(i).unwrap_or_else(|| format!("{project}#{}", i["iid"]));
    let state = i["state"].as_str().unwrap_or("opened");
    json!({
        "project": reference.rsplit_once('#').map_or(project, |(p, _)| p), "iid": i["iid"], "ref": reference,
        "title": i["title"], "url": i["web_url"], "description": i["description"],
        "state": state, "stateLabel": gitlab_state_label(state),
        "author": i["author"]["name"],
        "assignee": i["assignee"]["name"].as_str().or(i["assignees"][0]["name"].as_str()),
        "assignees": i["assignees"].as_array().into_iter().flatten().map(|a| a["name"].clone()).collect::<Vec<_>>(),
        "labels": strings(&i["labels"]),
        "milestone": i["milestone"]["title"], "dueDate": i["due_date"],
        "commentCount": i["user_notes_count"],
        "comments": comments,
        "createdAt": i["created_at"], "updatedAt": i["updated_at"], "closedAt": i["closed_at"],
    })
}

async fn gitlab_issues_source(i: &Integrations, source: &Value) -> Result<Value, String> {
    let state = match source["state"].as_str().unwrap_or("opened") {
        "open" | "opened" => "opened",
        "closed" => "closed",
        "all" => "all",
        other => return Err(format!("state `{other}` isn't one of opened, closed, all")),
    };
    let limit = source["limit"].as_u64().unwrap_or(30).clamp(1, 100);
    let project = source["project"].as_str();
    let scope = source["scope"].as_str().unwrap_or(if project.is_some() { "all" } else { "assigned_to_me" });
    if !matches!(scope, "assigned_to_me" | "created_by_me" | "all") {
        return Err(format!("scope `{scope}` isn't one of assigned_to_me, created_by_me, all"));
    }
    let query = format!("state={state}&scope={scope}&order_by=updated_at&sort=desc&per_page={limit}");
    let path = match project {
        Some(p) if gitlab_project(p) => format!("/projects/{}/issues?{query}", gitlab_path(p)),
        Some(p) => return Err(format!("`{p}` isn't a GitLab project; use \"group/project\"")),
        None => format!("/issues?{query}"),
    };
    let rows = i.gitlab_get(&path).await?;
    Ok(rows
        .as_array()
        .into_iter()
        .flatten()
        .map(|i| {
            let state = i["state"].as_str().unwrap_or("opened");
            json!({
                "iid": i["iid"], "ref": gitlab_ref(i), "title": i["title"], "url": i["web_url"],
                "state": state, "stateLabel": gitlab_state_label(state), "author": i["author"]["name"],
                "assignee": i["assignee"]["name"], "labels": strings(&i["labels"]), "updatedAt": i["updated_at"],
            })
        })
        .collect())
}

// ── Linear issues and projects ──────────────────────────────────────────────

const LINEAR_QUEUE_ROW: &str = "identifier title url updatedAt state { name type } assignee { name } labels { nodes { name } }";

fn linear_row(i: &Value, relation: Option<Relation>) -> Option<WorkItem> {
    Some(WorkItem {
        service: WorkService::Linear,
        id: s(&i["identifier"])?,
        title: s(&i["title"]).unwrap_or_default(),
        url: s(&i["url"]).unwrap_or_default(),
        status: s(&i["state"]["name"]),
        assignee: s(&i["assignee"]["name"]),
        labels: strings(&i["labels"]["nodes"]),
        relation,
        repo: None,
        project_id: None,
        updated_at: s(&i["updatedAt"]),
        state_key: s(&i["state"]["type"]),
    })
}

async fn linear_queue(i: &Integrations) -> Result<Vec<WorkItem>, String> {
    let open = json!({ "type": { "nin": ["completed", "canceled"] } });
    let q = format!(
        "query($a: IssueFilter, $c: IssueFilter, $first: Int) {{ \
         assigned: issues(filter: $a, first: $first, orderBy: updatedAt) {{ nodes {{ {LINEAR_QUEUE_ROW} }} }} \
         created: issues(filter: $c, first: $first, orderBy: updatedAt) {{ nodes {{ {LINEAR_QUEUE_ROW} }} }} }}"
    );
    let vars = json!({
        "a": { "state": open, "assignee": { "isMe": { "eq": true } } },
        "c": { "state": open, "creator": { "isMe": { "eq": true } } },
        "first": QUEUE_SIZE,
    });
    let data = i.linear(&q, vars).await?;
    let group = |k: &str, r| data[k]["nodes"].as_array().into_iter().flatten().filter_map(|n| linear_row(n, Some(r))).collect();
    Ok(merge(vec![group("assigned", Relation::Assigned), group("created", Relation::Created)]))
}

async fn linear_issue(i: &Integrations, id: &str) -> Result<Value, String> {
    let id = integrations::linear_key(&json!(id), "issue id")?;
    let data = i.linear(integrations::ISSUE_QUERY, json!({ "id": id })).await?;
    if data["issue"].is_null() {
        return Err(format!("Linear: issue {id} not found"));
    }
    let mut issue = integrations::shape_issue(&data["issue"]);
    issue["comments"] = Value::Array(newest(issue["comments"].as_array().cloned().unwrap_or_default(), SOURCE_COMMENTS));
    Ok(issue)
}

fn linear_project_row(p: &Value, me: &Value) -> Option<WorkItem> {
    let lead = !me.is_null() && p["lead"]["id"] == *me;
    Some(WorkItem {
        service: WorkService::LinearProject,
        id: s(&p["slugId"])?,
        title: s(&p["name"]).unwrap_or_default(),
        url: s(&p["url"]).unwrap_or_default(),
        status: s(&p["status"]["name"]),
        assignee: s(&p["lead"]["name"]),
        labels: vec![],
        relation: Some(if lead { Relation::Lead } else { Relation::Member }),
        repo: None,
        project_id: None,
        updated_at: s(&p["updatedAt"]),
        state_key: s(&p["status"]["type"]),
    })
}

async fn linear_projects_queue(i: &Integrations) -> Result<Vec<WorkItem>, String> {
    let q = "query($filter: ProjectFilter, $first: Int) { viewer { id } \
             projects(filter: $filter, first: $first, orderBy: updatedAt) { nodes { slugId name url updatedAt status { name type } lead { id name } } } }";
    let filter = json!({
        "or": [{ "lead": { "isMe": { "eq": true } } }, { "members": { "some": { "isMe": { "eq": true } } } }],
        "status": { "type": { "nin": ["completed", "canceled"] } },
    });
    let data = i.linear(q, json!({ "filter": filter, "first": QUEUE_SIZE })).await?;
    let me = &data["viewer"]["id"];
    Ok(merge(vec![data["projects"]["nodes"].as_array().into_iter().flatten().filter_map(|p| linear_project_row(p, me)).collect()]))
}

const PROJECT_QUERY: &str = "query($id: String!) { project(id: $id) { id slugId name description content url progress startDate targetDate updatedAt \
    status { name type } lead { name } teams { nodes { key name } } \
    issues(first: 100) { nodes { identifier title state { name type } assignee { name } } } } }";

async fn linear_project(i: &Integrations, id: &str) -> Result<Value, String> {
    let id = integrations::linear_key(&json!(id), "project id")?;
    let data = i.linear(PROJECT_QUERY, json!({ "id": id })).await?;
    if data["project"].is_null() {
        return Err(format!("Linear: project {id} not found"));
    }
    Ok(shape_linear_project(&data["project"]))
}

fn shape_linear_project(p: &Value) -> Value {
    let issues: Vec<Value> = p["issues"]["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|i| {
            json!({
                "id": i["identifier"], "title": i["title"], "state": i["state"]["name"], "stateType": i["state"]["type"],
                "assignee": i["assignee"]["name"], "done": integrations::done_type(i["state"]["type"].as_str().unwrap_or("")),
            })
        })
        .collect();
    let done = issues.iter().filter(|i| i["done"] == true).count();
    // The long write-up when there is one, else the one-line summary.
    let description = s(&p["content"]).or_else(|| s(&p["description"]));
    json!({
        "id": p["slugId"], "uuid": p["id"], "name": p["name"], "url": p["url"],
        "description": description, "summary": p["description"],
        "state": p["status"]["name"], "stateType": p["status"]["type"],
        "progressPct": (p["progress"].as_f64().unwrap_or(0.0) * 100.0).round(),
        "lead": p["lead"]["name"],
        "teams": integrations::names(&p["teams"], "name"),
        "startDate": p["startDate"], "targetDate": p["targetDate"], "updatedAt": p["updatedAt"],
        "issueCount": issues.len(), "issuesDone": done, "issues": issues,
    })
}

// ── one item, any service ───────────────────────────────────────────────────

/// The item's shaped JSON (as its live source returns it).
async fn fetch(i: &Integrations, service: WorkService, id: &str) -> Result<Value, String> {
    match service {
        WorkService::Github => {
            let (repo, n) = split_ref(id).ok_or_else(|| format!("`{id}` isn't `owner/repo#12`"))?;
            github_issue(i, repo, n).await
        }
        WorkService::Gitlab => {
            let (project, n) = split_ref(id).ok_or_else(|| format!("`{id}` isn't `group/project#7`"))?;
            gitlab_issue(i, project, n).await
        }
        WorkService::Linear => linear_issue(i, id).await,
        WorkService::LinearProject => linear_project(i, id).await,
    }
}

/// The queue's view of a fetched item.
fn item_of(service: WorkService, v: &Value) -> WorkItem {
    let str_of = |k: &str| s(&v[k]);
    let (id, status, state_key, repo, assignee) = match service {
        WorkService::Github => {
            let label = str_of("stateLabel");
            (str_of("ref"), label.clone(), label.map(|l| l.to_lowercase()), str_of("repo"), str_of("assignee"))
        }
        WorkService::Gitlab => (str_of("ref"), str_of("stateLabel"), str_of("state"), str_of("project"), str_of("assignee")),
        WorkService::Linear => (str_of("id"), str_of("state"), str_of("stateType"), None, str_of("assignee").filter(|a| a != "Unassigned")),
        WorkService::LinearProject => (str_of("id"), str_of("state"), str_of("stateType"), None, str_of("lead")),
    };
    WorkItem {
        service,
        id: id.unwrap_or_default(),
        title: str_of(if service == WorkService::LinearProject { "name" } else { "title" }).unwrap_or_default(),
        url: str_of("url").unwrap_or_default(),
        status,
        assignee,
        labels: strings(&v["labels"]),
        relation: None,
        repo,
        project_id: None,
        updated_at: str_of("updatedAt"),
        state_key,
    }
}

// ── the brief block ─────────────────────────────────────────────────────────

/// The item as Markdown for the project's brief (without the markers).
pub fn brief_block(service: WorkService, v: &Value) -> String {
    let item = item_of(service, v);
    let heading = match service {
        WorkService::LinearProject => item.title.clone(),
        _ => format!("{} {}", item.id, item.title),
    };
    let mut out = format!("# {}\n\n**Source:** {}: {}\n", heading.trim(), service.label(), item.url);
    let mut facts = vec![];
    if let Some(st) = &item.status {
        facts.push(format!("**Status:** {st}"));
    }
    if service == WorkService::LinearProject {
        facts.push(format!("**Progress:** {}%", v["progressPct"].as_f64().unwrap_or(0.0)));
        if let Some(lead) = s(&v["lead"]) {
            facts.push(format!("**Lead:** {lead}"));
        }
        let teams = strings(&v["teams"]);
        if !teams.is_empty() {
            facts.push(format!("**Teams:** {}", teams.join(", ")));
        }
    } else if let Some(a) = &item.assignee {
        facts.push(format!("**Assignee:** {a}"));
    }
    if !item.labels.is_empty() {
        facts.push(format!("**Labels:** {}", item.labels.join(", ")));
    }
    if !facts.is_empty() {
        out.push_str(&facts.join(" · "));
        out.push('\n');
    }
    let description = s(&v["description"]).or_else(|| s(&v["body"])).map(|d| clip(&d, DESCRIPTION_CHARS));
    let _ = write!(out, "\n## Description\n\n{}\n", description.unwrap_or_else(|| "_No description._".into()));
    if service == WorkService::LinearProject {
        let issues: Vec<String> = v["issues"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|i| {
                let who = i["assignee"].as_str().unwrap_or("unassigned");
                format!(
                    "- {} {} ({}, {who})",
                    i["id"].as_str().unwrap_or("?"),
                    i["title"].as_str().unwrap_or("").trim(),
                    i["state"].as_str().unwrap_or("?")
                )
            })
            .collect();
        if !issues.is_empty() {
            let _ = write!(out, "\n## Issues\n\n{}\n", issues.join("\n"));
        }
    } else {
        let comments = newest(v["comments"].as_array().cloned().unwrap_or_default(), BRIEF_COMMENTS);
        if !comments.is_empty() {
            let lines: Vec<String> = comments
                .iter()
                .map(|c| {
                    let date = c["at"].as_str().and_then(|a| a.get(..10)).unwrap_or("?");
                    format!("**{}**, {date}: {}", c["author"].as_str().unwrap_or("someone"), clip(c["body"].as_str().unwrap_or(""), COMMENT_CHARS))
                })
                .collect();
            let _ = write!(out, "\n## Recent comments\n\n{}\n", lines.join("\n\n"));
        }
    }
    // The item's text can't open or close the block it sits in.
    out.replace("yaah:source:", "yaah-source:")
}

fn project_name(service: WorkService, item: &WorkItem) -> String {
    let name = match service {
        WorkService::Linear => format!("{} {}", item.id, item.title),
        WorkService::Github | WorkService::Gitlab => format!("#{} {}", item.id.rsplit_once('#').map_or("", |(_, n)| n), item.title),
        WorkService::LinearProject => item.title.clone(),
    };
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    match name.char_indices().nth(NAME_CHARS) {
        Some((at, _)) => name[..at].trim_end().to_owned(),
        None => name,
    }
}

fn draft(service: WorkService, item: &WorkItem) -> String {
    match service {
        WorkService::LinearProject => format!("Plan the work for {}", item.title),
        _ => format!("Work on {}: {}", item.id, item.title),
    }
}

// ── queue ───────────────────────────────────────────────────────────────────

/// Groups merged in order (an item in an earlier group wins: assigned before
/// created), deduped by service and id, newest update first.
pub fn merge(groups: Vec<Vec<WorkItem>>) -> Vec<WorkItem> {
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<WorkItem> = groups.into_iter().flatten().filter(|i| seen.insert((i.service, i.id.to_lowercase()))).collect();
    // Stable: equal times keep their order. Items without a time go last.
    out.sort_by(|a, b| b.updated_at.as_deref().unwrap_or("").cmp(a.updated_at.as_deref().unwrap_or("")));
    out
}

/// Every linked item's project, by (service, lowercased id).
fn links(projects: &[Project]) -> HashMap<(String, String), String> {
    projects.iter().filter_map(|p| p.link.as_ref().map(|l| ((l.service.clone(), l.id.to_lowercase()), p.id.clone()))).collect()
}

fn tag(items: &mut [WorkItem], projects: &[Project]) {
    let links = links(projects);
    for item in items {
        item.project_id = links.get(&(item.service.as_str().to_owned(), item.id.to_lowercase())).cloned();
    }
}

async fn within<T>(service: WorkService, limit: Duration, f: impl Future<Output = Result<T, String>>) -> Result<T, QueueError> {
    let fail = |message: String| QueueError { service, kind: error_kind(&message), message };
    match tokio::time::timeout(limit, f).await {
        Ok(r) => r.map_err(fail),
        Err(_) => Err(fail(format!("{} didn't answer within {limit:?}", service.label()))),
    }
}

/// The user's open items from every connected service, read in parallel.
pub(crate) async fn queue(i: &Integrations, projects: &[Project]) -> WorkQueue {
    queue_within(i, projects, SERVICE_TIMEOUT).await
}

async fn queue_within(i: &Integrations, projects: &[Project], limit: Duration) -> WorkQueue {
    let on = |s: WorkService| i.connected(s.connection());
    let (gh, gl, lin) = (on(WorkService::Github), on(WorkService::Gitlab), on(WorkService::Linear));
    let (github, linear, linear_projects, gitlab) = tokio::join!(
        async { if gh { within(WorkService::Github, limit, github_queue(i)).await } else { Ok(vec![]) } },
        async { if lin { within(WorkService::Linear, limit, linear_queue(i)).await } else { Ok(vec![]) } },
        async { if lin { within(WorkService::LinearProject, limit, linear_projects_queue(i)).await } else { Ok(vec![]) } },
        async { if gl { within(WorkService::Gitlab, limit, gitlab_queue(i)).await } else { Ok(vec![]) } },
    );
    let mut queue = WorkQueue::default();
    let mut groups = vec![];
    for read in [github, linear, linear_projects, gitlab] {
        match read {
            Ok(items) => groups.push(items),
            Err(failed) => queue.errors.push(failed),
        }
    }
    queue.items = merge(groups);
    tag(&mut queue.items, projects);
    queue
}

// ── resolve, start, refresh, unlink ─────────────────────────────────────────

/// Which service a pasted URL or id is, and its canonical id there.
fn locate(i: &Integrations, input: &str) -> Result<(WorkService, String), String> {
    let p = parse_input(input)?;
    let service = p.service.unwrap_or_else(|| {
        // `owner/repo#12` is GitHub's unless only GitLab is connected.
        if i.connected("gitlab") && !i.connected("github") { WorkService::Gitlab } else { WorkService::Github }
    });
    let id = match (&p.origin, service) {
        // Not connected: the read says so, rather than naming gitlab.com as the instance.
        (Some(origin), WorkService::Gitlab) if i.connected("gitlab") => gitlab_relative(&i.gitlab_base_url(), origin, &p.id)?,
        _ => p.id,
    };
    Ok((service, id))
}

/// A pasted URL or id, fetched.
pub(crate) async fn resolve(i: &Integrations, projects: &[Project], input: &str) -> Result<WorkItem, String> {
    let (service, id) = locate(i, input)?;
    let v = fetch(i, service, &id).await?;
    if v["isPullRequest"] == true {
        return Err(format!("{id} is a pull request; paste an issue"));
    }
    let mut item = item_of(service, &v);
    tag(std::slice::from_mut(&mut item), projects);
    Ok(item)
}

/// One start at a time, so a double click can't make two projects for one item.
static STARTING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Start a project from an item, or return the one that already follows it.
/// `roots` are where to look for local clones; `chat` opens a chat in the new
/// project and returns its id.
pub(crate) async fn start<C, F>(
    i: &Integrations,
    projects: &Projects,
    service: &str,
    id: &str,
    roots: Vec<String>,
    chat: C,
) -> Result<Started, String>
where
    C: FnOnce(Project) -> F,
    F: Future<Output = Result<String, String>>,
{
    let service = WorkService::parse(service).ok_or_else(|| format!("unknown service `{service}`; one of github, linear, linear-project, gitlab"))?;
    let id = check_id(service, id)?;
    let one_at_a_time = STARTING.lock().await;
    let existing = |project| Started { project, existing: true, chat_id: None, draft: None, added_repos: vec![], chat_error: None };
    if let Some(p) = projects.linked(service.as_str(), &id)? {
        return Ok(existing(p));
    }
    let v = fetch(i, service, &id).await?;
    if v["isPullRequest"] == true {
        return Err(format!("{id} is a pull request; start from an issue"));
    }
    let item = item_of(service, &v);
    // The API's spelling may differ from what was pasted (`ENG-142` for a UUID, a repo's case).
    if item.id != id
        && let Some(p) = projects.linked(service.as_str(), &item.id)?
    {
        return Ok(existing(p));
    }

    let project = projects.create(&project_name(service, &item), &[])?;
    let at = now();
    let link = ProjectLink {
        service: service.as_str().into(),
        id: item.id.clone(),
        url: item.url.clone(),
        title: item.title.clone(),
        linked_at: at,
        synced_at: at,
    };
    let status = project_status(item.state_key.as_deref().or(item.status.as_deref()).unwrap_or(""));
    let mut project = projects.update(&project.id, |p| {
        p.status = status;
        p.link = Some(link);
        Ok(())
    })?;
    // Linked: another start for this item now finds it. The rest needn't wait in line.
    drop(one_at_a_time);
    // The new brief is just the item: its heading is the title.
    projects.write_brief(&project.id, "")?;
    projects.set_brief_source(&project.id, Some(&brief_block(service, &v)))?;

    let mut added_repos = vec![];
    if let Some(repo) = &item.repo {
        let host = match service {
            WorkService::Gitlab => reqwest::Url::parse(&i.gitlab_base_url()).ok().and_then(|u| u.host_str().map(str::to_owned)).unwrap_or_default(),
            _ => "github.com".into(),
        };
        let (repo, host) = (repo.clone(), host.clone());
        let found = tokio::task::spawn_blocking(move || {
            let all = repos::scan(&roots);
            repos::matching(&all, &host, &repo).into_iter().map(|r| r.path.clone()).collect::<Vec<_>>()
        })
        .await
        .map_err(|e| e.to_string())?;
        if !found.is_empty() {
            project = projects.add_dirs(&project.id, &found)?;
            added_repos = found;
        }
    }

    let (chat_id, chat_error) = match chat(project.clone()).await {
        Ok(id) => (Some(id), None),
        Err(e) => (None, Some(e)),
    };
    Ok(Started { draft: Some(draft(service, &item)), project, existing: false, chat_id, added_repos, chat_error })
}

/// Fetch the item again and rewrite only the brief's block, `link.title` and `link.syncedAt`.
pub(crate) async fn refresh(i: &Integrations, projects: &Projects, project_id: &str) -> Result<Project, String> {
    let project = projects.get(project_id)?;
    let link = project.link.ok_or("this project doesn't follow a tracker item")?;
    let service = WorkService::parse(&link.service).ok_or_else(|| format!("unknown service `{}`", link.service))?;
    let v = fetch(i, service, &link.id).await?;
    let item = item_of(service, &v);
    projects.set_brief_source(project_id, Some(&brief_block(service, &v)))?;
    projects.update(project_id, |p| {
        if let Some(l) = &mut p.link {
            l.title = item.title;
            if !item.url.is_empty() {
                l.url = item.url;
            }
            l.synced_at = now();
        }
        Ok(())
    })
}

/// Stop following the item: drop `link` and the brief's block.
pub(crate) fn unlink(projects: &Projects, project_id: &str) -> Result<Project, String> {
    let project = projects.update(project_id, |p| {
        p.link = None;
        Ok(())
    })?;
    projects.set_brief_source(project_id, None)?;
    Ok(project)
}

// ── live sources ────────────────────────────────────────────────────────────

/// `github.issue`, `github.issues`, `gitlab.issue`, `gitlab.issues` and `linear.project`.
pub(crate) async fn source(kind: &str, source: &Value) -> Result<Value, String> {
    source_with(Integrations::user(), kind, source).await
}

fn number(v: &Value, what: &str) -> Result<u64, String> {
    v.as_u64()
        .or_else(|| v.as_str().and_then(|s| s.trim_start_matches('#').parse().ok()))
        .filter(|n| *n > 0)
        .ok_or_else(|| format!("needs an issue `{what}`"))
}

async fn source_with(i: &Integrations, kind: &str, source: &Value) -> Result<Value, String> {
    let text = |k: &str, hint: &str| source[k].as_str().map(str::trim).filter(|s| !s.is_empty()).ok_or_else(|| format!("{kind} needs `{k}`: {hint}"));
    match kind {
        "github.issue" => github_issue(i, text("repo", "\"owner/name\"")?, number(&source["number"], "number")?).await,
        "github.issues" => {
            let limit = source["limit"].as_u64().unwrap_or(30);
            github_issues_source(i, text("repo", "\"owner/name\"")?, source["state"].as_str().unwrap_or("open"), limit).await
        }
        "gitlab.issue" => gitlab_issue(i, text("project", "\"group/project\"")?, number(&source["iid"], "iid")?).await,
        "gitlab.issues" => gitlab_issues_source(i, source).await,
        "linear.project" => linear_project(i, text("id", "the project's slug id")?).await,
        other => Err(format!("unknown source `{other}`")),
    }
}

#[cfg(test)]
mod tests;
