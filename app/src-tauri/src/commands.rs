//! The Tauri commands for agents, logins, projects, repos and chats. Each is a
//! thin call into the module that owns the logic.
#![allow(clippy::needless_pass_by_value, reason = "Tauri hands commands their arguments and state by value")]

use crate::agents::{self, AgentsFile, Draft, PresetInfo, ProfileInfo, Report, Store};
use crate::login::{self, Logins};
use crate::projects::{Project, Projects, Status};
use crate::session::{self, ChatTarget, Emit, Hub, Page, SessionInfo, Transcript};
use crate::{accounts, agent_conformance, agent_install, agent_versions, files, repos, settings};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

/// UI events, sent through the app.
pub fn emitter(app: AppHandle) -> Emit {
    Arc::new(move |event: &str, payload: serde_json::Value| {
        let _ = app.emit(event, payload);
    })
}

// ── Agents & login ──────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentList {
    profiles: Vec<ProfileInfo>,
    default_id: Option<String>,
}

fn agent_list(hub: &Hub, file: AgentsFile) -> AgentList {
    let default_id = file.default_id();
    let profiles = file.profiles.into_iter().map(|p| hub.info(p)).collect();
    AgentList { profiles, default_id }
}

/// Saved agent profiles (Claude accounts are migrated in on first run). Reads
/// files, so off the main thread.
#[tauri::command]
pub async fn list_agents(hub: State<'_, Arc<Hub>>) -> Result<AgentList, String> {
    let hub = hub.inner().clone();
    tauri::async_runtime::spawn_blocking(move || agent_list(&hub, Store::user().load())).await.map_err(|e| e.to_string())
}

/// Known ACP agents, with what is installed on this machine.
#[tauri::command]
pub fn list_agent_presets() -> Vec<PresetInfo> {
    agents::presets()
}

/// Create or update a profile. An edited profile's running agent is stopped
/// so its next chat starts with the new command.
#[tauri::command]
pub async fn save_agent(app: AppHandle, hub: State<'_, Arc<Hub>>, draft: Draft) -> Result<ProfileInfo, String> {
    let (profile, replaced) = Store::user().save(&draft)?;
    if replaced {
        hub.drop_agent(&profile.id).await;
    }
    let _ = app.emit("accounts-changed", ());
    Ok(hub.info(profile))
}

#[tauri::command]
pub async fn remove_agent(app: AppHandle, hub: State<'_, Arc<Hub>>, id: String) -> Result<(), String> {
    Store::user().remove(&id)?;
    hub.drop_agent(&id).await;
    let _ = app.emit("accounts-changed", ());
    Ok(())
}

#[tauri::command]
pub fn set_default_agent(app: AppHandle, id: String) -> Result<(), String> {
    Store::user().set_default(&id)?;
    let _ = app.emit("accounts-changed", ());
    Ok(())
}

/// Start the agent a draft describes, run ACP `initialize`, and report what it
/// said. Nothing is logged in and no session is opened. A saved profile keeps the report.
#[tauri::command]
pub async fn test_agent(app: AppHandle, draft: Draft) -> Result<Report, String> {
    let profile = draft.to_profile(&[])?;
    let report = agents::test(&profile).await?;
    if let Some(id) = &draft.id
        && Store::user().find(id).is_some_and(|p| p.same_command(&profile))
    {
        Store::user().record_report(id, &report);
        let _ = app.emit("accounts-changed", ());
    }
    Ok(report)
}

/// What changed when a hold was set or released.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionChange {
    presets: Vec<PresetInfo>,
    /// Profiles whose running agent still runs the old version: the UI offers to restart them.
    running: Vec<String>,
}

/// "Hold at this version" (`version`) or "Release hold" (`None`) for an npm-based
/// preset. A change of what runs installs it in the background; running agents
/// keep their version until they restart.
#[tauri::command]
pub fn hold_agent_version(hub: State<'_, Arc<Hub>>, preset: String, version: Option<String>) -> Result<VersionChange, String> {
    let p = agents::preset(&preset).ok_or_else(|| format!("unknown agent preset {preset}"))?;
    let versions = agent_versions::Versions::user();
    let before = versions.active(p, &settings::agent_versions());
    settings::set_agent_version(&preset, version.as_deref())?;
    let after = versions.active(p, &settings::agent_versions());
    let mut running = vec![];
    if let Some(spec) = after.filter(|a| Some(a) != before.as_ref()) {
        if agent_install::installed(versions.root(), &spec).is_none() {
            agent_install::ensure_in_background(spec);
        }
        running = hub.running_with_preset(&preset);
    }
    Ok(VersionChange { presets: agents::presets(), running })
}

/// "Check for updates": read the latest versions now and install newer ones of
/// the agents in use as candidates (they run once verified).
#[tauri::command]
pub async fn check_agent_updates() -> Result<Vec<PresetInfo>, String> {
    let in_use = agents::presets_in_use(&Store::user().load());
    agent_versions::Versions::user().check(agent_versions::REGISTRY, true, &in_use).await?;
    Ok(agents::presets())
}

/// What "Verify now" found, and the presets as they stand after it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verification {
    report: agent_conformance::SuiteReport,
    presets: Vec<PresetInfo>,
}

/// "Verify now": the conformance suite (tier A and `npm audit`) on `version` of
/// an npm-based preset, installing it first if needed. A candidate that passes
/// is promoted; a tracked version that fails is marked failed.
#[tauri::command]
pub async fn verify_agent_version(preset: String, version: String) -> Result<Verification, String> {
    let report = agent_conformance::verify(agent_versions::Versions::user(), &preset, &version).await?;
    Ok(Verification { report, presets: agents::presets() })
}

/// Restart these profiles' agents: the next chat starts a fresh process (with the version that should run now).
#[tauri::command]
pub async fn restart_agents(app: AppHandle, hub: State<'_, Arc<Hub>>, ids: Vec<String>) -> Result<(), String> {
    for id in ids {
        hub.drop_agent(&id).await;
    }
    let _ = app.emit("accounts-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn login_methods(hub: State<'_, Arc<Hub>>, account_id: String) -> Result<Vec<agents::AuthMethod>, String> {
    login::methods(&hub, &account_id).await
}

#[tauri::command]
pub async fn start_login(
    app: AppHandle,
    hub: State<'_, Arc<Hub>>,
    logins: State<'_, Logins>,
    account_id: String,
    method_id: String,
) -> Result<(), String> {
    logins.start(hub.inner().clone(), emitter(app), &account_id, &method_id).await
}

#[tauri::command]
pub async fn submit_login_code(logins: State<'_, Logins>, account_id: String, code: String) -> Result<(), String> {
    logins.submit_code(&account_id, &code).await
}

#[tauri::command]
pub fn cancel_login(logins: State<'_, Logins>, account_id: String) {
    logins.cancel(&account_id);
}

// ── Projects ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_projects(projects: State<'_, Projects>) -> Result<Vec<Project>, String> {
    projects.list()
}

#[tauri::command]
pub fn create_project(
    projects: State<'_, Projects>,
    name: String,
    dirs: Vec<String>,
    agent_id: Option<String>,
    statement_of_work: Option<String>,
) -> Result<Project, String> {
    let agent_id = crate::projects::agent_choice(agent_id.as_deref(), |a| Store::user().find(a).is_some())?;
    let new = crate::projects::NewProject { agent_id, statement_of_work: statement_of_work.unwrap_or_default() };
    projects.create_with(&name, &dirs, new)
}

#[tauri::command]
pub fn rename_project(projects: State<'_, Projects>, id: String, name: String) -> Result<Project, String> {
    let name = name.trim().to_owned();
    if name.is_empty() {
        return Err("name can't be empty".into());
    }
    projects.update(&id, |p| {
        p.name = name;
        Ok(())
    })
}

#[tauri::command]
pub fn set_project_status(projects: State<'_, Projects>, id: String, status: Status) -> Result<Project, String> {
    projects.update(&id, |p| {
        p.status = status;
        Ok(())
    })
}

/// Adding or removing a project's folder reaches every chat in it from that chat's next prompt (`Hub::sync_project`).
#[tauri::command]
pub fn add_project_dir(hub: State<'_, Arc<Hub>>, projects: State<'_, Projects>, id: String, dir: String) -> Result<Project, String> {
    projects.add_dir(&id, &dir).inspect(|p| hub.sync_project(p))
}

#[tauri::command]
pub fn add_project_dirs(hub: State<'_, Arc<Hub>>, projects: State<'_, Projects>, id: String, dirs: Vec<String>) -> Result<Project, String> {
    projects.add_dirs(&id, &dirs).inspect(|p| hub.sync_project(p))
}

#[tauri::command]
pub fn remove_project_dir(hub: State<'_, Arc<Hub>>, projects: State<'_, Projects>, id: String, dir: String) -> Result<Project, String> {
    projects.remove_dir(&id, &dir).inspect(|p| hub.sync_project(p))
}

#[tauri::command]
pub fn delete_project(projects: State<'_, Projects>, id: String) -> Result<(), String> {
    projects.delete(&id)
}

#[tauri::command]
pub fn read_brief(projects: State<'_, Projects>, id: String) -> Result<String, String> {
    projects.read_brief(&id)
}

#[tauri::command]
pub fn write_brief(projects: State<'_, Projects>, id: String, text: String) -> Result<(), String> {
    projects.write_brief(&id, &text)
}

// ── Repos ───────────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoList {
    roots: Vec<String>,
    repos: Vec<repos::Repo>,
}

/// Git repos under the workspace roots. Walks the disk, so off the main thread.
#[tauri::command]
pub async fn list_repos() -> Result<RepoList, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let roots = repos::roots();
        let repos = repos::scan(&roots);
        RepoList { roots, repos }
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_workspace_roots(roots: Vec<String>) -> Result<Vec<String>, String> {
    repos::set_roots(roots)
}

#[tauri::command]
pub async fn clone_repo(source: String, root: String) -> Result<repos::Repo, String> {
    repos::clone(&source, &root).await
}

// ── Chats ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn new_session(
    hub: State<'_, Arc<Hub>>,
    projects: State<'_, Projects>,
    project_id: String,
    account_id: String,
    extra_dirs: Option<Vec<String>>,
    start_id: Option<String>,
) -> Result<SessionInfo, String> {
    // Repos chosen up front join the project, so its other chats get them too.
    let project = match extra_dirs.filter(|d| !d.is_empty()) {
        Some(dirs) => projects.add_dirs(&project_id, &dirs).inspect(|p| hub.sync_project(p))?,
        None => projects.get(&project_id)?,
    };
    hub.new_session_with(ChatTarget::Project(&project), &account_id, &[], start_id.as_deref()).await
}

/// A chat outside any project: in `dir`, or a fresh scratch folder for quick work,
/// with `extra_dirs` (repos chosen up front) as its own.
#[tauri::command]
pub async fn new_quick_chat(
    hub: State<'_, Arc<Hub>>,
    account_id: String,
    dir: Option<String>,
    extra_dirs: Option<Vec<String>>,
    start_id: Option<String>,
) -> Result<SessionInfo, String> {
    let extra_dirs = extra_dirs.unwrap_or_default();
    // Checked before a scratch folder is made for nothing.
    session::new_dirs("/", &[], &extra_dirs)?;
    let dir = match dir {
        Some(d) if std::path::Path::new(&d).is_dir() => d,
        Some(d) => return Err(format!("{d} is not a folder")),
        None => {
            let d = accounts::home().join(".yaah/scratch").join(&session::random_token()[..12]);
            std::fs::create_dir_all(&d).map_err(|e| format!("create {}: {e}", d.display()))?;
            d.to_string_lossy().into_owned()
        }
    };
    hub.new_session_with(ChatTarget::Folder(dir), &account_id, &extra_dirs, start_id.as_deref()).await
}

/// Add repos to a chat as it goes: to its project when it has one (every chat there
/// gets them), else to the chat alone. The agent gets them from the next prompt on.
#[tauri::command]
pub async fn add_chat_dirs(
    hub: State<'_, Arc<Hub>>,
    projects: State<'_, Projects>,
    session_id: String,
    paths: Vec<String>,
) -> Result<SessionInfo, String> {
    add_dirs(&hub, &projects, &session_id, &paths)
}

fn add_dirs(hub: &Hub, projects: &Projects, session_id: &str, paths: &[String]) -> Result<SessionInfo, String> {
    hub.add_dirs(session_id, paths, |project_id, dirs| match projects.get(project_id) {
        Ok(_) => projects.add_dirs(project_id, dirs).map(Some),
        // Filed under a project that's gone: the chat keeps them itself.
        Err(_) => Ok(None),
    })
}

/// The user's answer to the agent's `ui_request_folders` at `index`: `add` adds the
/// folders as "Add repositories…" does, then the waiting agent hears it.
#[tauri::command]
pub async fn answer_folder_request(
    hub: State<'_, Arc<Hub>>,
    projects: State<'_, Projects>,
    session_id: String,
    index: usize,
    add: bool,
) -> Result<SessionInfo, String> {
    hub.answer_folders(&session_id, index, add, |paths| add_dirs(&hub, &projects, &session_id, paths).map(|_| ()))?;
    hub.session_info(&session_id)
}

/// File a chat under a project (or none, with `project_id` null).
#[tauri::command]
pub fn set_chat_project(
    hub: State<'_, Arc<Hub>>,
    projects: State<'_, Projects>,
    session_id: String,
    project_id: Option<String>,
) -> Result<SessionInfo, String> {
    if let Some(id) = &project_id {
        projects.get(id)?;
    }
    hub.set_session_project(&session_id, project_id)
}

/// A quick chat that grew: make a project from its folder (and the repos added to
/// it) and file the chat under it.
#[tauri::command]
pub fn promote_chat(
    hub: State<'_, Arc<Hub>>,
    projects: State<'_, Projects>,
    session_id: String,
    name: String,
) -> Result<(Project, SessionInfo), String> {
    let info = hub.session_info(&session_id)?;
    let dirs: Vec<String> = std::iter::once(info.cwd).chain(info.extra_dirs.into_iter().filter(|d| std::path::Path::new(d).is_dir())).collect();
    let project = projects.create(&name, &dirs)?;
    let info = hub.set_session_project(&session_id, Some(project.id.clone()))?;
    Ok((project, info))
}

/// Every chat's info (no transcripts), off the main thread.
#[tauri::command]
pub async fn list_sessions(hub: State<'_, Arc<Hub>>) -> Result<Vec<SessionInfo>, String> {
    let hub = hub.inner().clone();
    tauri::async_runtime::spawn_blocking(move || hub.list_sessions()).await.map_err(|e| e.to_string())
}

/// Part of a chat's transcript: `limit` entries (default 200) from `from`, or the last ones.
/// The first call for a chat reads it from disk.
#[tauri::command]
pub async fn get_entries(hub: State<'_, Arc<Hub>>, session_id: String, from: Option<usize>, limit: Option<usize>) -> Result<Page, String> {
    let hub = hub.inner().clone();
    tauri::async_runtime::spawn_blocking(move || hub.entries(&session_id, from, limit)).await.map_err(|e| e.to_string())?
}

/// The whole transcript. `get_entries` pages it.
#[tauri::command]
pub async fn get_transcript(hub: State<'_, Arc<Hub>>, session_id: String) -> Result<Transcript, String> {
    let hub = hub.inner().clone();
    tauri::async_runtime::spawn_blocking(move || hub.transcript(&session_id)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn answer_ui(hub: State<'_, Arc<Hub>>, session_id: String, index: usize, values: serde_json::Value) -> Result<(), String> {
    hub.answer_ui(&session_id, index, values).await
}

/// The user changed fields of a form they haven't sent; the agent can read and edit the same draft.
#[tauri::command]
pub fn edit_ui(hub: State<'_, Arc<Hub>>, session_id: String, index: usize, values: serde_json::Value) -> Result<serde_json::Value, String> {
    hub.edit_form(&session_id, session::FormRef::Index(index), &values, "user")
}

#[tauri::command]
pub async fn send_prompt(hub: State<'_, Arc<Hub>>, session_id: String, text: String, mentions: Option<Vec<String>>) -> Result<(), String> {
    hub.prompt(&session_id, text, mentions.unwrap_or_default()).await
}

/// Move a chat to another agent: its next prompt goes there, with the conversation handed off.
#[tauri::command]
pub fn switch_agent(hub: State<'_, Arc<Hub>>, session_id: String, account_id: String) -> Result<SessionInfo, String> {
    hub.switch_agent(&session_id, &account_id)
}

/// "Resume a session…": a page of the sessions a profile's agent has (ACP `session/list`,
/// on that profile's own agent process), marked when yaah already has one as a chat.
#[tauri::command]
pub async fn list_agent_sessions(
    hub: State<'_, Arc<Hub>>,
    account_id: String,
    cwd: Option<String>,
    cursor: Option<String>,
) -> Result<session::AgentSessions, String> {
    hub.list_agent_sessions(&account_id, cwd.as_deref(), cursor.as_deref()).await
}

/// Bring an agent's session into yaah as a chat, its history replayed into the transcript
/// (or open the chat that already holds it). Filed under the project whose folder holds `cwd`.
#[tauri::command]
pub async fn import_agent_session(
    hub: State<'_, Arc<Hub>>,
    projects: State<'_, Projects>,
    account_id: String,
    session_id: String,
    cwd: String,
    title: Option<String>,
) -> Result<SessionInfo, String> {
    let projects = projects.list()?;
    hub.import_agent_session(&account_id, &session_id, &cwd, title.as_deref(), &projects).await
}

#[tauri::command]
pub fn rename_session(hub: State<'_, Arc<Hub>>, session_id: String, title: String) -> Result<SessionInfo, String> {
    hub.rename_session(&session_id, &title)
}

#[tauri::command]
pub fn delete_session(hub: State<'_, Arc<Hub>>, session_id: String) -> Result<(), String> {
    hub.delete_session(&session_id)
}

/// Files in a chat's folders matching `query`, for @mentions.
#[tauri::command]
pub async fn search_files(
    hub: State<'_, Arc<Hub>>,
    session_id: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<files::FileMatch>, String> {
    let roots: Vec<_> = hub.session_roots(&session_id).into_iter().filter(|r| !r.to_string_lossy().contains("/.yaah/projects/")).collect();
    tauri::async_runtime::spawn_blocking(move || files::search(&roots, &query, limit.unwrap_or(30))).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cancel_turn(hub: State<'_, Arc<Hub>>, session_id: String) -> Result<(), String> {
    hub.cancel(&session_id)
}

#[tauri::command]
pub fn respond_permission(hub: State<'_, Arc<Hub>>, session_id: String, index: usize, option_id: Option<String>) -> Result<(), String> {
    hub.respond_permission(&session_id, index, option_id.as_deref())
}
