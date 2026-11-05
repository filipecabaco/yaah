//! "Resume a session…": sessions an agent started outside yaah (in the Claude Code or
//! Codex CLI, say), listed with ACP `session/list` on the profile's own agent process
//! (so each profile sees its own config dir's sessions), and brought in as a chat with
//! `session/load`. Unlike a reattach, an import keeps the agent's replay: it is the
//! chat's history (messages, thoughts, tool calls, plans). The chat then carries on in
//! that same ACP session.

use super::{
    Entry, Hub, Session, SessionInfo, Shared, TITLE_MAX_CHARS, cell, content_text, file_name, has_content, project_chat_dirs, random_token,
    same_message, truncate,
};
use crate::projects::{Project, Status};
use serde::Serialize;
use serde_json::{Value, json};
use std::path::Path;

/// One of an agent's sessions, as "Resume a session…" lists it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    /// The agent's ACP session id.
    pub session_id: String,
    /// The agent's title for it, when it has one (one line, at most [`LIST_TITLE_MAX_CHARS`]).
    pub title: Option<String>,
    /// Its working directory (absolute).
    pub cwd: String,
    /// Last activity, in Unix seconds (from the agent's ISO 8601 `updatedAt`).
    pub updated_at: Option<u64>,
    /// The yaah chat that already holds this session, if one does: resuming opens it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub already_in_yaah: Option<String>,
}

/// A page of an agent's sessions; `next_cursor` asks for the next one.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessions {
    pub sessions: Vec<AgentSession>,
    pub next_cursor: Option<String>,
}

/// An import in progress: which agent process's replay to record, and the user message
/// it is in (chunks of one message join one entry).
pub(super) struct Import {
    pub(super) generation: u64,
    user_message: Option<String>,
}

/// Titles in the list are cut to this many characters.
const LIST_TITLE_MAX_CHARS: usize = 120;
/// What an imported chat is called when neither the agent nor its history names it.
const UNTITLED: &str = "Resumed chat";

impl Hub {
    /// A page of the sessions the profile's agent has (ACP `session/list`), newest first
    /// as the agent orders them, optionally only those in `cwd`. Starts the profile's agent
    /// if it isn't running. Sessions yaah already has as a chat say which.
    pub async fn list_agent_sessions(&self, account_id: &str, cwd: Option<&str>, cursor: Option<&str>) -> Result<AgentSessions, String> {
        let account = self.shared.profile(account_id)?;
        let cwd = cwd.map(str::trim).filter(|c| !c.is_empty());
        if let Some(cwd) = cwd
            && !Path::new(cwd).is_absolute()
        {
            return Err(format!("{cwd} isn't an absolute path."));
        }
        let agent = self.agent(&account).await?;
        if agent.caps.list_sessions != Some(true) {
            return Err(format!("{} can't list its sessions.", account.label));
        }
        let mut params = json!({});
        if let Some(cwd) = cwd {
            params["cwd"] = json!(cwd);
        }
        if let Some(cursor) = cursor.filter(|c| !c.is_empty()) {
            params["cursor"] = json!(cursor);
        }
        let res =
            agent.conn.request("session/list", params).await.map_err(|e| self.shared.rpc_error(&account.id, &e, "Couldn't list its sessions"))?;
        let (mut sessions, next_cursor) = parse_sessions(&res);
        for s in &mut sessions {
            s.already_in_yaah = self.chat_with_agent_session(&s.session_id);
        }
        Ok(AgentSessions { sessions, next_cursor })
    }

    /// Bring the agent's session `acp_id` (in `cwd`) into yaah as a chat bound to it, and
    /// return the chat. A session yaah already has opens that chat instead; nothing is sent.
    ///
    /// The chat is a quick chat in `cwd`, or a chat of the project one of whose folders
    /// holds `cwd` ([`project_for_cwd`]). `session/load` replays the history, recorded as
    /// the chat's transcript; the next prompt continues the same session. `title` is the
    /// agent's own (from the list); without one the first message names the chat.
    pub async fn import_agent_session(
        &self,
        account_id: &str,
        acp_id: &str,
        cwd: &str,
        title: Option<&str>,
        projects: &[Project],
    ) -> Result<SessionInfo, String> {
        if let Some(chat) = self.chat_with_agent_session(acp_id) {
            return self.session_info(&chat);
        }
        if acp_id.trim().is_empty() {
            return Err("No session to resume.".into());
        }
        let dir = Path::new(cwd);
        if !dir.is_absolute() || !dir.is_dir() {
            return Err(format!("This session's folder, {cwd}, isn't there any more."));
        }
        let account = self.shared.profile(account_id)?;
        let agent = self.agent(&account).await?;
        if !agent.caps.load_session {
            return Err(format!("{} can't reopen its sessions, so they can't be resumed here.", account.label));
        }

        let project = project_for_cwd(projects, cwd);
        let additional_dirs = project.map(|p| project_chat_dirs(p, cwd, &[])).unwrap_or_default();
        let given_title = title.map(one_line).filter(|t| !t.is_empty());
        let info = SessionInfo {
            session_id: acp_id.to_owned(),
            project_id: project.map(|p| p.id.clone()),
            created_at: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs()),
            account_id: account.id.clone(),
            cwd: cwd.to_owned(),
            additional_dirs: additional_dirs.clone(),
            title: given_title.as_deref().map_or_else(|| UNTITLED.to_owned(), |t| truncate(t, TITLE_MAX_CHARS)),
            running: false,
            stop_reason: None,
            commands: vec![],
            agent_session_id: None,
            handoff_from: None,
            extra_dirs: vec![],
            dirs_changed: false,
            remembered: std::collections::BTreeMap::new(),
            trusted_mcp_servers: vec![],
            shell_rules: vec![],
            config: super::ChatConfig::default(),
            queue: super::Queue::default(),
        };
        let token = random_token();
        let mut session = Session::new(info, vec![], self.store.as_ref().map(|d| d.join(file_name(acp_id))));
        session.importing = Some(Import { generation: agent.generation, user_message: None });
        session.ui_token = Some(token.clone());
        // The project's brief goes with the next prompt, as in any new chat of the project.
        session.brief = project.and_then(|p| {
            let path = p.brief_path();
            let text = std::fs::read_to_string(&path).ok().filter(|t| has_content(t))?;
            Some(super::Brief { path: path.to_string_lossy().into_owned(), text })
        });
        let chat = cell(session);
        let raced = {
            let mut map = self.shared.sessions.lock().unwrap();
            let there = map.contains_key(acp_id) || self.shared.aliases.lock().unwrap().contains_key(acp_id);
            if !there {
                map.insert(acp_id.to_owned(), chat.clone());
            }
            there
        };
        if raced {
            // Imported meanwhile (a second click, another pane).
            let chat = self.chat_with_agent_session(acp_id).ok_or("unknown session")?;
            return self.session_info(&chat);
        }

        let mut params = json!({ "sessionId": acp_id, "cwd": cwd, "mcpServers": [] });
        if !additional_dirs.is_empty() && agent.caps.additional_dirs {
            params["additionalDirectories"] = json!(additional_dirs);
        }
        let guide = self.add_ui_server(&agent, &token, Some(acp_id), &mut params);
        crate::mcp_servers::inject(&mut params, agent.caps.mcp_http, agent.caps.mcp_sse, &account);

        let loaded = match agent.conn.request("session/load", params).await {
            Ok(loaded) => loaded,
            Err(e) => {
                // Nothing half-imported stays behind: no chat, no file, no UI token.
                let _ = self.delete_session(acp_id);
                return Err(self.shared.rpc_error(&account.id, &e, "Couldn't reopen this session"));
            }
        };
        self.shared.with(acp_id, |s| {
            // The model and effort it runs with, as the agent says (`session/config.rs`).
            s.info.config.options = super::config::offered(&loaded);
            s.importing = None;
            s.attached = Some(agent.generation);
            s.guide = guide;
            if given_title.is_none()
                && let Some(first) = s.entries.iter().find_map(|e| match &**e {
                    Entry::User { text, .. } => Some(one_line(text)).filter(|t| !t.is_empty()),
                    _ => None,
                })
            {
                s.info.title = truncate(&first, TITLE_MAX_CHARS);
            }
            self.shared.emit_info(s);
            self.shared.save_now(s);
            s.info.clone()
        })
    }

    /// The chat that holds the agent session `acp_id`: one started with that id, or one
    /// whose current agent knows it by that id (after a switch).
    fn chat_with_agent_session(&self, acp_id: &str) -> Option<String> {
        if self.shared.sessions.lock().unwrap().contains_key(acp_id) {
            return Some(acp_id.to_owned());
        }
        self.shared.aliases.lock().unwrap().get(acp_id).cloned()
    }
}

/// A `user_message_chunk` of an import's replay: a new user message (a new turn, so a
/// plan after it is its own), or more of the one just before it.
pub(super) fn user_chunk(shared: &Shared, s: &mut Session, update: &Value) {
    let text = content_text(&update["content"]);
    let message_id = update.get("messageId").and_then(Value::as_str).map(str::to_owned);
    let Some(import) = &mut s.importing else { return };
    let continues = same_message(import.user_message.as_deref(), message_id.as_deref());
    import.user_message = message_id;
    let last = s.entries.len().checked_sub(1).filter(|&i| matches!(&*s.entries[i], Entry::User { .. }));
    match last {
        // In a replay each chunk is a whole content block: blocks of one message are paragraphs.
        Some(i) if continues => {
            if let Some(Entry::User { text: t, .. }) = s.entry_mut(i) {
                if !t.is_empty() && !text.is_empty() {
                    t.push_str("\n\n");
                }
                t.push_str(&text);
            }
            shared.emit_entry(s, i);
        }
        _ => {
            s.plan_index = None;
            shared.push(s, Entry::User { text, attachments: vec![], files: vec![], references: vec![] });
        }
    }
}

/// A `session/list` result's sessions (those without an id or an absolute cwd are
/// skipped, as are repeats) and its next cursor.
fn parse_sessions(result: &Value) -> (Vec<AgentSession>, Option<String>) {
    let mut sessions: Vec<AgentSession> = vec![];
    for s in result["sessions"].as_array().into_iter().flatten() {
        let Some(session_id) = s["sessionId"].as_str().filter(|id| !id.trim().is_empty()) else { continue };
        let Some(cwd) = s["cwd"].as_str().filter(|c| Path::new(c).is_absolute()) else { continue };
        if sessions.iter().any(|x| x.session_id == session_id) {
            continue;
        }
        sessions.push(AgentSession {
            session_id: session_id.to_owned(),
            title: s["title"].as_str().map(one_line).filter(|t| !t.is_empty()).map(|t| truncate(&t, LIST_TITLE_MAX_CHARS)),
            cwd: cwd.to_owned(),
            updated_at: s["updatedAt"].as_str().and_then(unix_seconds),
            already_in_yaah: None,
        });
    }
    let next_cursor = result["nextCursor"].as_str().filter(|c| !c.is_empty()).map(str::to_owned);
    (sessions, next_cursor)
}

/// The project an imported chat in `cwd` belongs to: one with a folder that is `cwd` or
/// holds it. The deepest such folder wins; archived projects only when nothing else fits.
pub fn project_for_cwd<'a>(projects: &'a [Project], cwd: &str) -> Option<&'a Project> {
    let cwd = cwd.trim_end_matches('/');
    let holds = |dir: &str| {
        let dir = dir.trim_end_matches('/');
        !dir.is_empty() && (cwd == dir || cwd.strip_prefix(dir).is_some_and(|rest| rest.starts_with('/')))
    };
    projects
        .iter()
        .filter_map(|p| p.dirs.iter().filter(|d| holds(d)).map(|d| d.trim_end_matches('/').len()).max().map(|depth| (p, depth)))
        .max_by_key(|(p, depth)| (p.status != Status::Archived, *depth))
        .map(|(p, _)| p)
}

/// Text on one line, its runs of whitespace one space.
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// An ISO 8601 / RFC 3339 timestamp (`2026-11-03T10:20:30.123Z`, `…+01:00`) in Unix seconds.
fn unix_seconds(ts: &str) -> Option<u64> {
    let (date, time) = ts.trim().split_once(['T', 't', ' '])?;
    let mut ymd = date.splitn(3, '-').map(str::parse::<i64>);
    let (year, month, day) = (ymd.next()?.ok()?, ymd.next()?.ok()?, ymd.next()?.ok()?);
    // The offset: Z, or ±hh:mm after the seconds.
    let (clock, offset) = if let Some(clock) = time.strip_suffix(['Z', 'z']) {
        (clock, 0)
    } else {
        let at = time.rfind(['+', '-'])?;
        let (clock, zone) = time.split_at(at);
        let sign = if zone.starts_with('-') { -1 } else { 1 };
        let (hours, minutes) = zone[1..].split_once(':').unwrap_or((&zone[1..], "0"));
        (clock, sign * (hours.parse::<i64>().ok()? * 3600 + minutes.parse::<i64>().ok()? * 60))
    };
    let mut hms = clock.splitn(3, ':');
    let (hour, minute) = (hms.next()?.parse::<i64>().ok()?, hms.next()?.parse::<i64>().ok()?);
    let second = hms.next().map_or(Some(0.0), |s| s.parse::<f64>().ok())?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || !(0.0..61.0).contains(&second) {
        return None;
    }
    // Days from the civil date (Howard Hinnant's algorithm).
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    #[allow(clippy::cast_possible_truncation, reason = "whole seconds of a valid time of day")]
    let secs = days * 86_400 + hour * 3600 + minute * 60 + second.trunc() as i64 - offset;
    u64::try_from(secs).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(id: &str, dirs: &[&str], status: Status) -> Project {
        Project {
            id: id.into(),
            name: id.into(),
            dirs: dirs.iter().map(|d| (*d).to_owned()).collect(),
            status,
            created_at: 0,
            context_dir: format!("/home/me/.yaah/projects/{id}"),
            link: None,
            agent_id: None,
            trusted_mcp_servers: vec![],
        }
    }

    /// Read-only, against a real profile (`YAAH_LIVE_ACCOUNT`, default `personal`): starts its
    /// agent as the app does, lists its sessions (`session/list`, a few pages at most) and prints
    /// their titles and counts. It never imports a session or sends a prompt, and writes no chat.
    ///
    /// `YAAH_LIVE_ACCOUNT=personal cargo test --lib live_resume_lists -- --ignored --nocapture`
    #[test]
    #[ignore = "starts a real agent with the user's profile"]
    fn live_resume_lists_a_real_profiles_sessions() {
        const PAGES: usize = 3;
        let account = std::env::var("YAAH_LIVE_ACCOUNT").unwrap_or_else(|_| "personal".into());
        let hub = Hub::with_store(std::sync::Arc::new(|_: &str, _: Value| {}), crate::accounts::home().join(".yaah/sessions"));
        let started = std::time::Instant::now();
        let (mut cursor, mut titles, mut pages) = (None::<String>, vec![], 0);
        let (mut in_yaah, mut untitled) = (0, 0);
        while pages < PAGES {
            let page =
                tauri::async_runtime::block_on(hub.list_agent_sessions(&account, None, cursor.as_deref())).expect("the agent lists its sessions");
            pages += 1;
            for s in &page.sessions {
                in_yaah += usize::from(s.already_in_yaah.is_some());
                untitled += usize::from(s.title.is_none());
                titles.push(s.title.clone().unwrap_or_else(|| "(untitled)".into()));
            }
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        for t in &titles {
            println!("  {t}");
        }
        println!(
            "{account}: {} sessions in {pages} page(s){} in {:.1}s; {in_yaah} already in yaah, {untitled} untitled",
            titles.len(),
            if cursor.is_some() { " (more after)" } else { "" },
            started.elapsed().as_secs_f32()
        );
    }

    #[test]
    fn a_session_list_keeps_what_it_can_use() {
        let (sessions, next) = parse_sessions(&json!({
            "sessions": [
                { "sessionId": "a", "cwd": "/w/api", "title": "  Fix the\n  invoice  rounding ", "updatedAt": "2026-11-03T10:20:30.500Z" },
                { "sessionId": "b", "cwd": "relative/path", "title": "no" },
                { "sessionId": "", "cwd": "/w" },
                { "cwd": "/w" },
                "not a session",
                { "sessionId": "a", "cwd": "/w/again" },
                { "sessionId": "c", "cwd": "/w/web", "title": null, "updatedAt": "yesterday" }
            ],
            "nextCursor": "offset:2"
        }));
        let ids: Vec<&str> = sessions.iter().map(|s| s.session_id.as_str()).collect();
        assert_eq!(ids, ["a", "c"]);
        assert_eq!(sessions[0].title.as_deref(), Some("Fix the invoice rounding"));
        assert_eq!(sessions[0].updated_at, Some(1_793_701_230));
        assert_eq!((sessions[1].title.as_deref(), sessions[1].updated_at), (None, None));
        assert_eq!(next.as_deref(), Some("offset:2"));
        assert_eq!(parse_sessions(&json!({ "sessions": [], "nextCursor": "" })).1, None);
        assert_eq!(parse_sessions(&json!({})).0, []);
    }

    #[test]
    fn timestamps_read_with_any_offset() {
        assert_eq!(unix_seconds("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(unix_seconds("2000-03-01T00:00:00Z"), Some(951_868_800));
        assert_eq!(unix_seconds("2026-11-03T11:20:30+01:00"), unix_seconds("2026-11-03T10:20:30Z"));
        assert_eq!(unix_seconds("2026-11-03T05:20:30-05:00"), unix_seconds("2026-11-03T10:20:30Z"));
        assert_eq!(unix_seconds("2026-11-03T10:20:30.999Z"), unix_seconds("2026-11-03T10:20:30Z"));
        for bad in ["", "2026-11-03", "2026-13-01T00:00:00Z", "2026-11-03T25:00:00Z", "soon", "1969-12-31T23:59:59Z"] {
            assert_eq!(unix_seconds(bad), None, "{bad}");
        }
    }

    #[test]
    fn an_imported_chat_joins_the_project_whose_folder_holds_it() {
        let projects = [
            project("shop", &["/w/shop", "/w/shop-web/"], Status::Ongoing),
            project("api", &["/w/shop/services/api"], Status::Planning),
            project("old", &["/w/legacy"], Status::Archived),
            project("legacy", &["/w/legacy/app"], Status::Archived),
        ];
        let pick = |cwd: &str| project_for_cwd(&projects, cwd).map(|p| p.id.as_str());
        assert_eq!(pick("/w/shop"), Some("shop"));
        assert_eq!(pick("/w/shop/"), Some("shop"));
        assert_eq!(pick("/w/shop/src/billing"), Some("shop"));
        assert_eq!(pick("/w/shop-web"), Some("shop"), "a trailing slash on the project's folder still matches");
        assert_eq!(pick("/w/shop/services/api/src"), Some("api"), "the deepest folder wins");
        assert_eq!(pick("/w/shopfront"), None, "a folder only holds what's inside it");
        assert_eq!(pick("/w/legacy/app/x"), Some("legacy"), "archived projects still count when nothing else fits");
        assert_eq!(pick("/elsewhere"), None);
        let mixed = [project("archived", &["/w/a"], Status::Archived), project("live", &["/w"], Status::Ongoing)];
        assert_eq!(project_for_cwd(&mixed, "/w/a/b").map(|p| p.id.as_str()), Some("live"), "a live project beats an archived one");
    }
}
