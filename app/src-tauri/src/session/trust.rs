//! The user's permission choices that aren't one chat's own, and where each
//! applies (`permissions.rs` is the rule; this is the state it is asked with).
//!
//! Scopes, narrowest first (`permissions::Scope`):
//! - **this chat**: `SessionInfo.trusted_mcp_servers` and `.remembered`, saved with the chat.
//! - **this project**: `trustedMcpServers` in `projects.json` (`projects.rs`).
//! - **quick chats**: every chat without a project whose folder is a scratch folder
//!   (`~/.yaah/scratch/<id>`) shares one scope, as if they were one standing project:
//!   `quickChats { trustedMcpServers, remembered }` in `settings.json`. A quick chat
//!   has no scope of its own ("this chat" is quick chats). Values a quick chat kept
//!   itself before this existed are moved there once, when the app starts
//!   ([`Hub::migrate_quick_chats`]: a union, and a "don't ask" wins over an "allow"
//!   for the same request).
//! - **all chats**: `trustedMcpServers` in `settings.json`, listed in Settings → Chat.
//!
//! Also here: Settings → Chat's switches (`trustReadOnly`, `allowWebSearch`).
//! Nothing here writes anywhere but yaah's own `settings.json`.

use super::permissions::{self, AgentDirs, Auto, McpServer, OwnDirs, Scope};
use super::{Entry, Hub, Session, SessionInfo, Shared, outcome, remembered_option};
use crate::json_file::JsonFile;
use crate::projects::Project;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashMap};
use std::path::{Component, Path, PathBuf};

const WEB_SEARCH_KEY: &str = "allowWebSearch";
const EVERYWHERE_KEY: &str = "trustedMcpServers";
const QUICK_KEY: &str = "quickChats";

/// What permission requests yaah may answer itself, beyond a chat's own choices.
/// The app reads it from `settings.json` and `projects.json` (`Hub::set_permission_file`,
/// `Hub::load_project_trust`); a Hub in a test reads no file unless given one.
pub(super) struct Trust {
    /// Allow reads and searches inside a chat's folders (Settings → Chat). On unless turned off.
    pub(super) read_only: bool,
    /// Allow web searches (Settings → Chat). Off unless turned on.
    pub(super) web_search: bool,
    /// Trusted MCP servers by project id.
    pub(super) projects: HashMap<String, Vec<String>>,
    /// Trusted MCP servers in all chats.
    pub(super) everywhere: Vec<String>,
    /// The scope every quick chat shares.
    pub(super) quick: QuickChats,
    /// Where quick chats' scratch folders are made (`commands::new_quick_chat`).
    scratch: PathBuf,
    /// `settings.json`, where the above is kept; `None`: in memory only (tests).
    file: Option<&'static JsonFile>,
}

impl Default for Trust {
    fn default() -> Self {
        Self {
            read_only: true,
            web_search: false,
            projects: HashMap::new(),
            everywhere: vec![],
            quick: QuickChats::default(),
            scratch: crate::accounts::home().join(".yaah/scratch"),
            file: None,
        }
    }
}

/// The trust and "don't ask again" choices quick chats share.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickChats {
    /// MCP server ids.
    #[serde(default)]
    pub trusted_mcp_servers: Vec<String>,
    /// Request title → `allow_always` or `reject_always`, as `SessionInfo.remembered`.
    #[serde(default)]
    pub remembered: BTreeMap<String, String>,
}

/// Server ids as saved, kept only if they are ids, each once.
fn server_ids(v: Option<&Value>) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for id in v.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
        if McpServer::new(id).is_some() && !out.iter().any(|o| o == id) {
            out.push(id.to_owned());
        }
    }
    out
}

fn quick_in(s: &Map<String, Value>) -> QuickChats {
    let q = s.get(QUICK_KEY);
    let remembered = q
        .and_then(|q| q.get("remembered"))
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(title, kind)| Some((title.clone(), kind.as_str().filter(|k| matches!(*k, "allow_always" | "reject_always"))?.to_owned())))
        .collect();
    QuickChats { trusted_mcp_servers: server_ids(q.and_then(|q| q.get("trustedMcpServers"))), remembered }
}

/// Add `kind` for `title`: a "don't ask" (`reject_always`) wins over an "allow" either way.
fn merge_remembered(into: &mut BTreeMap<String, String>, title: String, kind: String) {
    into.entry(title)
        .and_modify(|k| {
            if kind == "reject_always" {
                k.clone_from(&kind);
            }
        })
        .or_insert(kind);
}

impl Trust {
    fn load(&mut self, s: &Map<String, Value>) {
        self.web_search = s.get(WEB_SEARCH_KEY).and_then(Value::as_bool).unwrap_or(false);
        self.everywhere = server_ids(s.get(EVERYWHERE_KEY));
        self.quick = quick_in(s);
    }

    fn write(&self, key: &str, value: Value) -> Result<(), String> {
        let Some(file) = self.file else { return Ok(()) };
        file.update(|all: &mut Map<String, Value>| {
            all.insert(key.to_owned(), value);
            Ok(())
        })
    }

    fn write_quick(&self, quick: &QuickChats) -> Result<(), String> {
        self.write(QUICK_KEY, serde_json::to_value(quick).map_err(|e| e.to_string())?)
    }

    /// A chat without a project in a scratch folder of its own.
    fn is_quick(&self, info: &SessionInfo) -> bool {
        let cwd = Path::new(&info.cwd);
        info.project_id.is_none() && cwd != self.scratch && cwd.starts_with(&self.scratch) && !cwd.components().any(|c| c == Component::ParentDir)
    }

    /// The scope a chat's own choices are kept in: its project, quick chats, or itself.
    pub(super) fn scope_of(&self, info: &SessionInfo) -> Scope {
        if info.project_id.is_some() {
            Scope::Project
        } else if self.is_quick(info) {
            Scope::QuickChats
        } else {
            Scope::Chat
        }
    }

    /// Where the card offers to trust a server from a chat in `here`.
    fn offered(here: Scope) -> Vec<Scope> {
        match here {
            Scope::Project => vec![Scope::Chat, Scope::Project, Scope::Everywhere],
            Scope::QuickChats => vec![Scope::QuickChats, Scope::Everywhere],
            Scope::Chat | Scope::Everywhere => vec![Scope::Chat, Scope::Everywhere],
        }
    }

    /// The servers trusted for a chat, by scope, narrowest first.
    pub(super) fn trusted_for(&self, info: &SessionInfo) -> Vec<(Scope, Vec<String>)> {
        let mut out = vec![];
        match self.scope_of(info) {
            Scope::QuickChats => out.push((Scope::QuickChats, self.quick.trusted_mcp_servers.clone())),
            here => {
                out.push((Scope::Chat, info.trusted_mcp_servers.clone()));
                if here == Scope::Project
                    && let Some(p) = &info.project_id
                {
                    out.push((Scope::Project, self.projects.get(p).cloned().unwrap_or_default()));
                }
            }
        }
        out.push((Scope::Everywhere, self.everywhere.clone()));
        out
    }
}

/// A chat's trust as its header and permission cards show it (`trust_scope`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrustView {
    /// Where the chat's own choices go: `project`, `quickChats` or `chat`.
    pub here: Scope,
    /// Where a permission card offers to trust a server, narrowest first.
    pub offered: Vec<Scope>,
    /// Every server whose tools run without asking here, with the scope that trusts it.
    pub servers: Vec<TrustedServer>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrustedServer {
    pub id: String,
    pub label: String,
    pub scope: Scope,
}

/// Settings → Chat's permissions block.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionSettings {
    pub trust_read_only: bool,
    pub allow_web_search: bool,
    /// MCP servers trusted in all chats.
    pub trusted_everywhere: Vec<McpServer>,
}

impl Shared {
    /// Whether yaah answers a request in chat `s` itself, and how: the option
    /// to pick, its name, and why. Only ever an `allow_once` option.
    pub(super) fn auto_answer(&self, s: &Session, req: &permissions::Request, options: &Value) -> Option<(String, String, Auto)> {
        let (read_only, web_search, trusted) = {
            let t = self.trust.lock().unwrap();
            (t.read_only, t.web_search, t.trusted_for(&s.info))
        };
        let roots: Vec<PathBuf> = std::iter::once(&s.info.cwd).chain(&s.info.additional_dirs).map(PathBuf::from).collect();
        let own = (read_only && matches!(req.kind, Some("read" | "search"))).then(|| self.own_dirs(s)).flatten();
        let policy = permissions::Policy { read_only, roots: &roots, own: own.as_ref(), trusted: &trusted, web_search };
        let auto = permissions::decide(req, &policy)?;
        let (id, name) = permissions::allow_once(options)?;
        Some((id, name, auto))
    }

    /// The chat's agent's own folders for it (`permissions::own_dirs`): Claude Code's
    /// saved tool results for this session, under the profile's `CLAUDE_CONFIG_DIR`.
    pub(super) fn own_dirs(&self, s: &Session) -> Option<OwnDirs> {
        let profile = self.profiles.find(&s.info.account_id)?;
        // As the agent is started (`Profile::spawn_env`): the profile's config dir wins over its env, then yaah's own.
        let config_dir =
            profile.config_dir.clone().or_else(|| profile.env.get("CLAUDE_CONFIG_DIR").cloned()).or_else(|| std::env::var("CLAUDE_CONFIG_DIR").ok());
        permissions::own_dirs(&AgentDirs {
            preset: &profile.preset,
            claude_config_dir: config_dir.as_deref(),
            home: &crate::accounts::home(),
            cwd: &s.info.cwd,
            session: s.info.agent_session(),
        })
    }

    /// A "don't ask again" for `title` that applies in `s`: its kind and where it was said.
    pub(super) fn remembered(&self, s: &Session, title: &str) -> Option<(String, Scope)> {
        if let Some(kind) = s.info.remembered.get(title) {
            return Some((kind.clone(), Scope::Chat));
        }
        let t = self.trust.lock().unwrap();
        if t.scope_of(&s.info) != Scope::QuickChats {
            return None;
        }
        t.quick.remembered.get(title).map(|k| (k.clone(), Scope::QuickChats))
    }

    /// Keep a "don't ask again": with the chat, or (a quick chat) in quick chats. Returns where.
    pub(super) fn remember(&self, s: &mut Session, title: &str, kind: &str) -> Scope {
        let mut t = self.trust.lock().unwrap();
        if t.scope_of(&s.info) != Scope::QuickChats {
            drop(t);
            s.info.remembered.insert(title.to_owned(), kind.to_owned());
            return Scope::Chat;
        }
        let mut quick = t.quick.clone();
        quick.remembered.insert(title.to_owned(), kind.to_owned());
        match t.write_quick(&quick) {
            Ok(()) => t.quick = quick,
            // Not saved: it still holds until the app quits, as a chat's own did before it was saved.
            Err(e) => {
                eprintln!("[permissions] quick chats' choices not saved: {e}");
                t.quick = quick;
            }
        }
        drop(t);
        self.trust_changed();
        Scope::QuickChats
    }

    fn trust_changed(&self) {
        (self.app)("trust-changed", json!({}));
    }
}

impl Hub {
    /// Keep the trust that isn't a chat's own in `file` (`settings.json`): read it
    /// now, and move quick chats' own choices into their shared scope.
    pub fn set_permission_file(&self, file: &'static JsonFile) {
        {
            let mut t = self.shared.trust.lock().unwrap();
            t.file = Some(file);
            t.load(&file.read());
        }
        let moved = self.migrate_quick_chats();
        if moved > 0 {
            eprintln!("[permissions] moved {moved} quick chats' trusted servers and choices into the quick chats' scope");
        }
    }

    /// [`Hub::set_permission_file`] with a file of its own, for tests.
    #[cfg(test)]
    pub(super) fn use_permission_file_at(&self, path: PathBuf) {
        self.set_permission_file(Box::leak(Box::new(JsonFile::new(path, false))));
    }

    /// Where quick chats' scratch folders are, for tests.
    #[cfg(test)]
    pub(super) fn set_scratch_root(&self, dir: PathBuf) {
        self.shared.trust.lock().unwrap().scratch = dir;
    }

    /// Quick chats that kept trusted servers or "don't ask again" choices themselves
    /// (before quick chats shared a scope): add them to the shared scope (a union;
    /// for the same request a "don't ask" wins), save it, then write those chats
    /// without them so they move once. Returns how many chats had some.
    pub fn migrate_quick_chats(&self) -> usize {
        let quick_chats: Vec<_> = self
            .shared
            .chats()
            .into_iter()
            .filter(|chat| {
                let s = chat.lock().unwrap();
                let has_some = !s.info.trusted_mcp_servers.is_empty() || !s.info.remembered.is_empty();
                has_some && self.shared.trust.lock().unwrap().scope_of(&s.info) == Scope::QuickChats
            })
            .collect();
        if quick_chats.is_empty() {
            return 0;
        }
        let mut merged = self.shared.trust.lock().unwrap().quick.clone();
        for chat in &quick_chats {
            let s = chat.lock().unwrap();
            for id in &s.info.trusted_mcp_servers {
                if McpServer::new(id).is_some() && !merged.trusted_mcp_servers.contains(id) {
                    merged.trusted_mcp_servers.push(id.clone());
                }
            }
            for (title, kind) in &s.info.remembered {
                merge_remembered(&mut merged.remembered, title.clone(), kind.clone());
            }
        }
        {
            let mut t = self.shared.trust.lock().unwrap();
            if let Err(e) = t.write_quick(&merged) {
                // Left with the chats, to try again next start.
                eprintln!("[permissions] quick chats' choices not moved: {e}");
                return 0;
            }
            t.quick = merged;
        }
        for chat in &quick_chats {
            let mut s = chat.lock().unwrap();
            s.info.trusted_mcp_servers.clear();
            s.info.remembered.clear();
            // A chat is only written with its entries read.
            s.ensure_loaded();
            self.shared.save(&mut s);
        }
        self.shared.trust_changed();
        quick_chats.len()
    }

    /// How chat `session_id`'s trust is scoped, and what is trusted for it.
    pub fn trust_scope(&self, session_id: &str) -> Result<TrustView, String> {
        let info = self.shared.with_info(session_id, Clone::clone)?;
        let t = self.shared.trust.lock().unwrap();
        let here = t.scope_of(&info);
        let servers = t
            .trusted_for(&info)
            .into_iter()
            .flat_map(|(scope, ids)| {
                ids.into_iter().filter_map(move |id| McpServer::new(&id).map(|m| TrustedServer { id: m.id, label: m.label, scope }))
            })
            .collect();
        Ok(TrustView { here, offered: Trust::offered(here), servers })
    }

    /// Settings → Chat's permission switches and the servers trusted in all chats.
    pub fn permission_settings(&self) -> PermissionSettings {
        let t = self.shared.trust.lock().unwrap();
        PermissionSettings {
            trust_read_only: t.read_only,
            allow_web_search: t.web_search,
            trusted_everywhere: t.everywhere.iter().filter_map(|id| McpServer::new(id)).collect(),
        }
    }

    /// "Always allow tools from <server>" on a permission card, in `scope`: this
    /// chat, its project (`add_to_project` stores it there and returns the project),
    /// quick chats or all chats; `scope` must be one the chat offers
    /// ([`TrustView::offered`]). That covers every tool of the server. Its requests
    /// waiting now in the chats it covers are answered with `allow_once`, and later
    /// ones the same way without asking.
    pub fn trust_server(
        &self,
        session_id: &str,
        index: usize,
        scope: Scope,
        add_to_project: impl FnOnce(&str, &str) -> Result<Project, String>,
    ) -> Result<(), String> {
        let (server, info) = self.shared.with(session_id, |s| match s.entries.get(index).map(|e| &**e) {
            Some(Entry::Permission { mcp_server: Some(m), .. }) => Ok((m.clone(), s.info.clone())),
            Some(Entry::Permission { .. }) => Err("yaah can't tell which MCP server this request is for".to_owned()),
            _ => Err("no permission request at that index".to_owned()),
        })??;
        let here = self.shared.trust.lock().unwrap().scope_of(&info);
        if !Trust::offered(here).contains(&scope) {
            return Err(format!("this chat can't trust a server {}", scope.words()));
        }
        let covers: Box<dyn Fn(&SessionInfo) -> bool> = match scope {
            Scope::Chat => {
                self.shared.with(session_id, |s| {
                    if !s.info.trusted_mcp_servers.contains(&server.id) {
                        s.info.trusted_mcp_servers.push(server.id.clone());
                        self.shared.emit_info(s);
                        self.shared.save(s);
                    }
                })?;
                self.shared.trust_changed();
                Box::new(|i| i.session_id == info.session_id)
            }
            Scope::Project => {
                let p = info.project_id.clone().ok_or("this chat has no project")?;
                let project = add_to_project(&p, &server.id)?;
                self.set_project_trust(&project);
                Box::new(move |i| i.project_id.as_deref() == Some(&p))
            }
            Scope::QuickChats => {
                {
                    let mut t = self.shared.trust.lock().unwrap();
                    if !t.quick.trusted_mcp_servers.contains(&server.id) {
                        let mut quick = t.quick.clone();
                        quick.trusted_mcp_servers.push(server.id.clone());
                        t.write_quick(&quick)?;
                        t.quick = quick;
                    }
                }
                self.shared.trust_changed();
                Box::new(|i| self.shared.trust.lock().unwrap().scope_of(i) == Scope::QuickChats)
            }
            Scope::Everywhere => {
                {
                    let mut t = self.shared.trust.lock().unwrap();
                    if !t.everywhere.contains(&server.id) {
                        let mut all = t.everywhere.clone();
                        all.push(server.id.clone());
                        t.write(EVERYWHERE_KEY, json!(all))?;
                        t.everywhere = all;
                    }
                }
                self.shared.trust_changed();
                Box::new(|_| true)
            }
        };
        for chat in self.shared.chats() {
            let mut s = chat.lock().unwrap();
            if covers(&s.info) {
                self.answer_trusted(&mut s, &server, scope);
            }
        }
        Ok(())
    }

    /// Answer the requests waiting in `s` for `server`'s tools, now that it is trusted in `scope`.
    fn answer_trusted(&self, s: &mut Session, server: &McpServer, scope: Scope) {
        let mut same: Vec<usize> = s
            .waiting
            .keys()
            .copied()
            .filter(
                |&i| matches!(s.entries.get(i).map(|e| &**e), Some(Entry::Permission { mcp_server: Some(m), chosen: None, .. }) if m.id == server.id),
            )
            .collect();
        if same.is_empty() {
            // Nothing to write (and a chat whose entries weren't read must not be written).
            return;
        }
        same.sort_unstable();
        for i in same {
            let Some(Entry::Permission { request_id, options, chosen, answer, auto, .. }) = s.entry_mut(i) else { continue };
            let Some((option_id, name)) = permissions::allow_once(options) else { continue };
            *chosen = Some(name);
            *answer = Some("allow_once".into());
            *auto = Some(Auto::trusted(server, scope));
            let request_id = request_id.clone();
            if let Some((_, r)) = s.waiting.remove(&i) {
                r.ok(request_id, outcome(Some(&option_id)));
            }
            self.shared.emit_entry(s, i);
        }
        self.shared.save(s);
    }

    /// A "don't ask again" said in quick chat `except`: the same request waiting in
    /// the other quick chats is answered the same way (with its one-off option).
    pub(super) fn replay_in_quick_chats(&self, except: &str, title: &str, kind: &str) {
        for chat in self.shared.chats() {
            let mut s = chat.lock().unwrap();
            if s.info.session_id == except || self.shared.trust.lock().unwrap().scope_of(&s.info) != Scope::QuickChats {
                continue;
            }
            let mut same: Vec<usize> = s
                .waiting
                .keys()
                .copied()
                .filter(|&i| matches!(s.entries.get(i).map(|e| &**e), Some(Entry::Permission { title: t, chosen: None, .. }) if t == title))
                .collect();
            if same.is_empty() {
                continue;
            }
            same.sort_unstable();
            for i in same {
                let Some(Entry::Permission { request_id, options, chosen, answer, auto, .. }) = s.entry_mut(i) else { continue };
                let Some((id, name, once)) = remembered_option(options, kind) else { continue };
                *chosen = Some(format!("{name} {}", super::REMEMBERED));
                *answer = Some(once.to_owned());
                *auto = Some(Auto::remembered_in(Scope::QuickChats));
                let request_id = request_id.clone();
                if let Some((_, r)) = s.waiting.remove(&i) {
                    r.ok(request_id, outcome(Some(&id)));
                }
                self.shared.emit_entry(&mut s, i);
            }
            self.shared.save(&mut s);
        }
    }

    /// Stop trusting `server` in this chat: its own list, or (a quick chat) quick chats'.
    pub fn untrust_chat_server(&self, session_id: &str, server: &str) -> Result<SessionInfo, String> {
        let info = self.shared.with(session_id, |s| {
            s.info.trusted_mcp_servers.retain(|t| t != server);
            self.shared.emit_info(s);
            self.shared.save(s);
            s.info.clone()
        })?;
        if self.shared.trust.lock().unwrap().scope_of(&info) == Scope::QuickChats {
            self.untrust_quick_chats(server)?;
        } else {
            self.shared.trust_changed();
        }
        Ok(info)
    }

    /// Stop trusting `server` in quick chats.
    pub fn untrust_quick_chats(&self, server: &str) -> Result<(), String> {
        {
            let mut t = self.shared.trust.lock().unwrap();
            let mut quick = t.quick.clone();
            quick.trusted_mcp_servers.retain(|s| s != server);
            t.write_quick(&quick)?;
            t.quick = quick;
        }
        self.shared.trust_changed();
        Ok(())
    }

    /// Stop trusting `server` in all chats (Settings → Chat): it still runs without
    /// asking where a chat, project or quick chats trust it themselves.
    pub fn untrust_everywhere(&self, server: &str) -> Result<PermissionSettings, String> {
        {
            let mut t = self.shared.trust.lock().unwrap();
            let all: Vec<String> = t.everywhere.iter().filter(|s| *s != server).cloned().collect();
            t.write(EVERYWHERE_KEY, json!(all))?;
            t.everywhere = all;
        }
        self.shared.trust_changed();
        Ok(self.permission_settings())
    }

    /// The MCP servers trusted in `project` changed (or the app started): its chats follow at once.
    pub fn set_project_trust(&self, project: &Project) {
        self.load_project_trust(std::slice::from_ref(project));
        (self.shared.app)("projects-changed", json!({ "projectId": project.id }));
        self.shared.trust_changed();
    }

    /// Each project's trusted MCP servers, as `projects.json` has them (at startup).
    pub fn load_project_trust(&self, projects: &[Project]) {
        let mut t = self.shared.trust.lock().unwrap();
        for p in projects {
            t.projects.insert(p.id.clone(), p.trusted_mcp_servers.clone());
        }
    }

    /// Settings → Chat, "Allow reads in the chat's folders" (`settings::trust_read_only`).
    pub fn set_trust_read_only(&self, on: bool) {
        self.shared.trust.lock().unwrap().read_only = on;
    }

    /// Settings → Chat, "Allow web searches without asking": saved, and followed at once.
    pub fn set_allow_web_search(&self, on: bool) -> Result<(), String> {
        let mut t = self.shared.trust.lock().unwrap();
        t.write(WEB_SEARCH_KEY, json!(on))?;
        t.web_search = on;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_values_are_checked_when_read() {
        let s: Map<String, Value> = serde_json::from_value(json!({
            "allowWebSearch": "yes",
            "trustedMcpServers": ["linear", "linear", "a b", 3, "claude_ai_Linear"],
            "quickChats": { "trustedMcpServers": ["fetch", "../x"], "remembered": { "npm test": "allow_always", "rm -rf /": "allow_once", "x": 1 } }
        }))
        .unwrap();
        let mut t = Trust::default();
        t.load(&s);
        assert!(!t.web_search, "a value that isn't a bool is the default (off)");
        assert_eq!(t.everywhere, ["linear", "claude_ai_Linear"]);
        assert_eq!(t.quick.trusted_mcp_servers, ["fetch"]);
        assert_eq!(t.quick.remembered, BTreeMap::from([("npm test".to_owned(), "allow_always".to_owned())]), "only the `always` kinds");
        t.load(&Map::new());
        assert!(!t.web_search && t.everywhere.is_empty() && t.quick == QuickChats::default());
    }

    #[test]
    fn a_dont_ask_wins_over_an_allow_when_merged() {
        let mut m = BTreeMap::new();
        merge_remembered(&mut m, "x".into(), "allow_always".into());
        merge_remembered(&mut m, "x".into(), "reject_always".into());
        merge_remembered(&mut m, "x".into(), "allow_always".into());
        merge_remembered(&mut m, "y".into(), "allow_always".into());
        assert_eq!(m["x"], "reject_always");
        assert_eq!(m["y"], "allow_always");
    }

    #[test]
    fn quick_chats_are_project_less_chats_in_a_scratch_folder() {
        let t = Trust { scratch: PathBuf::from("/h/.yaah/scratch"), ..Trust::default() };
        let info =
            |cwd: &str, project: Option<&str>| SessionInfo { cwd: cwd.into(), project_id: project.map(Into::into), ..super::super::test_info("c") };
        assert_eq!(t.scope_of(&info("/h/.yaah/scratch/be2cba80a028", None)), Scope::QuickChats);
        assert_eq!(t.scope_of(&info("/h/.yaah/scratch/be2cba80a028/sub", None)), Scope::QuickChats);
        assert_eq!(t.scope_of(&info("/h/.yaah/scratch/be2cba80a028", Some("p"))), Scope::Project);
        for cwd in ["/h/.yaah/scratch", "/h/.yaah/scratch-evil/x", "/h/work/repo", "/h/.yaah/scratch/x/../../../work"] {
            assert_eq!(t.scope_of(&info(cwd, None)), Scope::Chat, "{cwd}");
        }
        assert_eq!(Trust::offered(Scope::QuickChats), [Scope::QuickChats, Scope::Everywhere]);
        assert_eq!(Trust::offered(Scope::Project), [Scope::Chat, Scope::Project, Scope::Everywhere]);
        assert_eq!(Trust::offered(Scope::Chat), [Scope::Chat, Scope::Everywhere]);
    }
}
