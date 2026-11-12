//! The Tauri commands for the component library, live sources, settings, integrations,
//! projects from tracker items, MCP servers and skills. Each is a thin call into the
//! module that owns the logic.
#![allow(clippy::needless_pass_by_value, reason = "Tauri hands commands their arguments and state by value")]

use crate::integrations::Integrations;
use crate::keychain::SecretString;
use crate::projects::{Project, Projects};
use crate::session::{ChatTarget, Hub};
use crate::ui_libraries::{LibraryExport, LibraryInfo, LibraryPreview, LibrarySource, LibraryUpdate, Manifest};
use crate::ui_library::{Component, Library, Prepared};
use crate::work_items::{self, Started, WorkItem, WorkQueue};
use crate::{agents, integrations, mcp_oauth, mcp_servers, path_env, providers, repos, settings, skills, sources};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

// ── UI component library ────────────────────────────────────────────────────

/// Async and off the async workers: it reads every component file, and the
/// main thread (which runs sync commands) must never wait on that.
#[tauri::command]
pub async fn list_components(library: State<'_, Arc<Library>>) -> Result<Vec<Component>, String> {
    let library = library.inner().clone();
    tauri::async_runtime::spawn_blocking(move || library.list()).await.map_err(|e| e.to_string())?
}

/// Render-ready tree for a library component with the given props (previews).
#[tauri::command]
pub async fn preview_component(library: State<'_, Arc<Library>>, name: String, props: serde_json::Value) -> Result<Prepared, String> {
    let library = library.inner().clone();
    tauri::async_runtime::spawn_blocking(move || library.prepare(Some(&name), props, None).map_err(|errs| errs.join("\n")))
        .await
        .map_err(|e| e.to_string())?
}

// ── Component libraries (installed beside yaah's own and the user's) ────────
// Every change emits "libraries-changed" so open views reload.

fn libraries_changed(app: &AppHandle) {
    let _ = app.emit("libraries-changed", ());
    // The skills agents get list the components available.
    if let Some(guide) = tauri::Manager::try_state::<Arc<crate::agent_guide::Guide>>(app) {
        guide.sync_in_background();
    }
}

/// Runs `f` on a blocking thread: these read and write many files.
async fn blocking<T: Send + 'static>(
    library: &State<'_, Arc<Library>>,
    f: impl FnOnce(&Library) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let library = library.inner().clone();
    tauri::async_runtime::spawn_blocking(move || f(&library)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn list_libraries(library: State<'_, Arc<Library>>) -> Result<Vec<LibraryInfo>, String> {
    blocking(&library, Library::list_libraries).await
}

/// Fetch into staging and validate; installs nothing.
#[tauri::command]
pub async fn inspect_library(library: State<'_, Arc<Library>>, source: LibrarySource) -> Result<LibraryPreview, String> {
    library.inner().clone().inspect(source).await
}

#[tauri::command]
pub async fn install_library(app: AppHandle, library: State<'_, Arc<Library>>, staging_id: String) -> Result<LibraryInfo, String> {
    let info = blocking(&library, move |l| l.install(&staging_id)).await?;
    libraries_changed(&app);
    Ok(info)
}

#[tauri::command]
pub async fn update_library(app: AppHandle, library: State<'_, Arc<Library>>, id: String) -> Result<LibraryUpdate, String> {
    let updated = library.inner().clone().update(&id).await?;
    libraries_changed(&app);
    Ok(updated)
}

#[tauri::command]
pub async fn set_library_enabled(app: AppHandle, library: State<'_, Arc<Library>>, id: String, enabled: bool) -> Result<LibraryInfo, String> {
    let info = blocking(&library, move |l| l.set_enabled(&id, enabled)).await?;
    libraries_changed(&app);
    Ok(info)
}

#[tauri::command]
pub async fn remove_library(app: AppHandle, library: State<'_, Arc<Library>>, id: String) -> Result<(), String> {
    blocking(&library, move |l| l.remove(&id)).await?;
    libraries_changed(&app);
    Ok(())
}

/// Copy yaah's or an installed library's component into the user's collection.
#[tauri::command]
pub async fn copy_component(app: AppHandle, library: State<'_, Arc<Library>>, name: String, new_name: Option<String>) -> Result<Component, String> {
    let copy = blocking(&library, move |l| l.copy_component(&name, new_name.as_deref())).await?;
    libraries_changed(&app);
    Ok(copy)
}

/// Write local components out as a library folder, `<dir>/<name>/`.
#[tauri::command]
pub async fn export_library(
    library: State<'_, Arc<Library>>,
    dir: String,
    manifest: Manifest,
    components: Vec<String>,
) -> Result<LibraryExport, String> {
    blocking(&library, move |l| l.export(&dir, &manifest, &components)).await
}

// ── Sources and data connections ────────────────────────────────────────────

/// Read a source for the UI. `session` is the chat the UI is in: git sources
/// read that chat's folder, or another of its folders named by `repo` (the
/// folders are looked up here, so the page can't reach any other).
#[tauri::command]
pub async fn read_source(
    sources: State<'_, Arc<sources::Sources>>,
    hub: State<'_, Arc<Hub>>,
    source: serde_json::Value,
    session: Option<String>,
) -> Result<serde_json::Value, String> {
    let roots = session.map(|id| hub.session_roots(&id)).unwrap_or_default();
    sources.read_in(&source, &roots).await
}

/// Kinds of file the system would run, install or follow rather than show:
/// "Open in editor" refuses them (an agent can write any file into the chat's folder).
const RUNNABLE: &[&str] = &[
    "app",
    "command",
    "tool",
    "terminal",
    "workflow",
    "action",
    "pkg",
    "mpkg",
    "dmg",
    "scpt",
    "scptd",
    "applescript",
    "prefpane",
    "webloc",
    "inetloc",
    "fileloc",
    "desktop",
    "appimage",
    "deb",
    "rpm",
    "jar",
    "exe",
    "bat",
    "cmd",
];

/// `path` (relative to the chat's folder, or absolute) as a regular file inside
/// one of the chat's `roots` that opening won't run.
pub(crate) fn editable_file(roots: &[std::path::PathBuf], path: &str) -> Result<std::path::PathBuf, String> {
    let root = roots.first().ok_or("this chat has no folder")?;
    let wanted = std::path::Path::new(path);
    let full = if wanted.is_absolute() { wanted.to_path_buf() } else { root.join(wanted) };
    let real = full.canonicalize().map_err(|_| format!("{path} doesn't exist in the chat's folder (deleted, or not checked out)"))?;
    let inside = roots.iter().filter_map(|r| r.canonicalize().ok()).any(|r| real.starts_with(r));
    if !inside {
        return Err(format!("{path} isn't in the chat's folders"));
    }
    let meta = std::fs::metadata(&real).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err(format!("{path} isn't a file"));
    }
    let ext = real.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
    #[cfg(unix)]
    let executable = {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    };
    #[cfg(not(unix))]
    let executable = false;
    if executable || RUNNABLE.contains(&ext.as_str()) {
        return Err(format!("{path} would run rather than open; open it from your editor"));
    }
    Ok(real)
}

/// Open a file from a chat (a diff's "Open in editor") with the system's app for it.
#[tauri::command]
pub fn open_in_editor(app: AppHandle, hub: State<'_, Arc<Hub>>, session: String, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let file = editable_file(&hub.session_roots(&session), &path)?;
    app.opener().open_path(file.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

// ── Settings → General ───────────────────────────────────────────────────────

/// Reads settings files, so off the main thread.
#[tauri::command]
pub async fn general_settings() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(settings::general).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_appearance(appearance: String) -> Result<(), String> {
    settings::set_appearance(&appearance)
}

/// How cards of one kind of tool open in chats; no `mode` restores the default.
#[tauri::command]
pub fn set_tool_card(key: String, mode: Option<String>) -> Result<(), String> {
    settings::set_tool_card(&key, mode.as_deref())
}

/// Settings → Chat, "Group consecutive tool calls".
#[tauri::command]
pub fn set_group_tool_calls(enabled: bool) -> Result<(), String> {
    settings::set_group_tool_calls(enabled)
}

#[tauri::command]
pub fn set_theme(light: String, dark: String) -> Result<(), String> {
    settings::set_theme(&light, &dark)
}

/// The font families installed on this machine (fonts.rs): scanned once, then kept.
#[tauri::command]
pub async fn installed_fonts() -> Result<crate::fonts::Installed, String> {
    tauri::async_runtime::spawn_blocking(|| crate::fonts::installed().clone()).await.map_err(|e| e.to_string())
}

/// Save the interface and code fonts and sizes; what the UI should apply comes back.
#[tauri::command]
pub async fn set_fonts(fonts: settings::Fonts) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || settings::set_fonts(&fonts)).await.map_err(|e| e.to_string())?
}

/// ⌘= / ⌘- / ⌘0: sizes a step bigger (1), smaller (-1) or back to the default (0).
#[tauri::command]
pub async fn step_font_size(step: i8) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || settings::step_font_size(step)).await.map_err(|e| e.to_string())?
}

/// A dropped-in VS Code theme, by file name (never a path).
#[tauri::command]
pub fn read_custom_theme(name: String) -> Result<serde_json::Value, String> {
    settings::read_theme(&name)
}

/// Show one of yaah's own data folders (only those listed in Settings → General).
#[tauri::command]
pub fn reveal_data_dir(path: String) -> Result<(), String> {
    let known = settings::general()["dataDirs"].as_array().into_iter().flatten().any(|d| d["path"] == path.as_str());
    if !known {
        return Err("not one of yaah's folders".into());
    }
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    path_env::command(opener).arg(&path).spawn().map_err(|e| format!("{opener}: {e}"))?;
    Ok(())
}

// ── window layout (split panes, sidebar) ─────────────────────────────────────

/// The split panes and the sidebar as last left, without panes on chats or projects deleted since.
#[tauri::command]
pub fn window_layout(hub: State<'_, Arc<Hub>>, projects: State<'_, Projects>) -> Result<serde_json::Value, String> {
    let chats: std::collections::HashSet<String> = hub.list_sessions().into_iter().map(|s| s.session_id).collect();
    let projects: std::collections::HashSet<String> = projects.list()?.into_iter().map(|p| p.id).collect();
    Ok(settings::window_layout(|id| chats.contains(id), |id| projects.contains(id)))
}

/// Saved as the UI sends it, once checked (`layout.rs`). Shells whose terminal pane
/// is gone from it are closed (`Terminals::retain_in_layout`).
#[tauri::command]
pub fn set_layout(hub: State<'_, Arc<Hub>>, layout: crate::layout::Layout) -> Result<(), String> {
    let shells = layout.terminal_ids().into_iter().map(str::to_owned).collect();
    settings::set_layout(layout)?;
    hub.terminals().retain_in_layout(shells);
    Ok(())
}

#[tauri::command]
pub fn set_sidebar(collapsed: bool, width: u32) -> Result<(), String> {
    settings::set_sidebar(collapsed, width)
}

// ── integrations (Settings → Integrations) ──────────────────────────────────

#[tauri::command]
pub fn integrations_status() -> Vec<serde_json::Value> {
    integrations::status()
}

/// Start connecting a service; how it ends arrives as an "integration-changed" event.
/// `base_url` is GitLab's instance (a self-managed one); omitted means gitlab.com.
#[tauri::command]
pub async fn integration_connect(app: AppHandle, service: String, base_url: Option<String>) -> Result<serde_json::Value, String> {
    let notify: integrations::Notify = Arc::new(move |v| {
        let _ = app.emit("integration-changed", v);
    });
    integrations::connect(&service, base_url.as_deref(), notify).await
}

#[tauri::command]
pub async fn integration_set_key(app: AppHandle, service: String, key: String, base_url: Option<String>) -> Result<serde_json::Value, String> {
    let r = integrations::set_key(&service, &key, base_url.as_deref()).await?;
    let _ = app.emit("integration-changed", serde_json::json!({ "service": service, "ok": true }));
    Ok(r)
}

#[tauri::command]
pub fn integration_disconnect(app: AppHandle, service: String) -> Result<(), String> {
    integrations::disconnect(&service)?;
    let _ = app.emit("integration-changed", serde_json::json!({ "service": service, "ok": true }));
    Ok(())
}

// ── projects from tracker items (work_items.rs) ─────────────────────────────
// Read-only toward every tracker. Changes to projects emit "projects-changed".

fn projects_changed(app: &AppHandle, project_id: &str) {
    let _ = app.emit("projects-changed", serde_json::json!({ "projectId": project_id }));
}

/// The user's open items from every connected service.
#[tauri::command]
pub async fn work_queue(projects: State<'_, Projects>) -> Result<WorkQueue, String> {
    let list = projects.list()?;
    Ok(work_items::queue(Integrations::user(), &list).await)
}

/// A pasted URL or id (`owner/repo#12`, `ENG-142`, a Linear project URL, …).
#[tauri::command]
pub async fn resolve_work_item(projects: State<'_, Projects>, input: String) -> Result<WorkItem, String> {
    let list = projects.list()?;
    work_items::resolve(Integrations::user(), &list, &input).await
}

/// A project from an item (or the one already following it), with a chat opened
/// in it and the prompt drafted, not sent.
#[tauri::command]
pub async fn start_project_from_item(
    app: AppHandle,
    hub: State<'_, Arc<Hub>>,
    projects: State<'_, Projects>,
    service: String,
    id: String,
    account_id: Option<String>,
) -> Result<Started, String> {
    let hub = hub.inner().clone();
    let account = account_id.filter(|a| !a.is_empty()).or_else(|| agents::Store::user().load().default_id());
    // The project keeps the agent its first chat starts with.
    let keep = account.clone();
    let chat = |project: Project| async move {
        let account = account.ok_or("no agent is set up: add one in Settings → Agents, then start a chat in the project")?;
        hub.new_session(ChatTarget::Project(&project), &account).await.map(|info| info.session_id)
    };
    let roots = tauri::async_runtime::spawn_blocking(repos::roots).await.map_err(|e| e.to_string())?;
    let started = work_items::start(Integrations::user(), &projects, &service, &id, roots, keep, chat).await?;
    if !started.existing {
        projects_changed(&app, &started.project.id);
    }
    Ok(started)
}

/// The agent new chats in a project start with; none (or empty) leaves it to the sidebar's.
#[tauri::command]
pub fn set_project_agent(projects: State<'_, Projects>, id: String, agent_id: Option<String>) -> Result<Project, String> {
    let agent = crate::projects::agent_choice(agent_id.as_deref(), |a| agents::Store::user().find(a).is_some())?;
    projects.set_agent(&id, agent)
}

/// Fetch the item again and rewrite the brief's block (never the status or name).
#[tauri::command]
pub async fn refresh_project_link(app: AppHandle, projects: State<'_, Projects>, project_id: String) -> Result<Project, String> {
    let project = work_items::refresh(Integrations::user(), &projects, &project_id).await?;
    projects_changed(&app, &project_id);
    Ok(project)
}

#[tauri::command]
pub async fn unlink_project(app: AppHandle, projects: State<'_, Projects>, project_id: String) -> Result<Project, String> {
    let project = work_items::unlink(&projects, &project_id)?;
    projects_changed(&app, &project_id);
    Ok(project)
}

#[tauri::command]
pub fn list_connections() -> Vec<sources::ConnectionInfo> {
    sources::list_connections()
}

#[tauri::command]
pub async fn add_connection(name: String, url: String) -> Result<sources::ConnectionInfo, String> {
    sources::add_connection(&name, &url).await
}

#[tauri::command]
pub fn remove_connection(name: String) -> Result<(), String> {
    sources::remove_connection(&name)
}

// ── Skills (Settings → Skills) ──────────────────────────────────────────────

#[tauri::command]
pub async fn list_skills() -> Result<skills::Overview, String> {
    tauri::async_runtime::spawn_blocking(skills::overview).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn skills_lookup(input: String) -> Result<skills::Lookup, String> {
    skills::lookup(&input, &skills::known_dirs()).await
}

#[tauri::command]
pub async fn skills_install(request: skills::InstallRequest) -> Result<Vec<skills::Installed>, String> {
    skills::install(request).await
}

#[tauri::command]
pub async fn skills_update(dir: String) -> Result<skills::Updated, String> {
    skills::update(&dir).await
}

#[tauri::command]
pub fn skills_remove(dir: String) -> Result<(), String> {
    skills::remove(&dir)
}

// ── MCP servers (Settings → MCP servers) ────────────────────────────────────
// Handed to every agent in session/new and session/load; see mcp_servers.rs.

#[tauri::command]
pub fn list_mcp_servers() -> mcp_servers::McpList {
    mcp_servers::list()
}

#[tauri::command]
pub fn save_mcp_server(draft: mcp_servers::Draft) -> Result<mcp_servers::ServerInfo, String> {
    mcp_servers::Store::user().save(&draft).map(mcp_servers::info_now)
}

#[tauri::command]
pub fn remove_mcp_server(name: String) -> Result<(), String> {
    mcp_servers::Store::user().remove(&name)
}

#[tauri::command]
pub fn set_mcp_server_enabled(name: String, enabled: bool) -> Result<mcp_servers::ServerInfo, String> {
    mcp_servers::Store::user().set_enabled(&name, enabled).map(mcp_servers::info_now)
}

/// One server as `/mcp` shows it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub name: String,
    pub transport: mcp_servers::Transport,
    /// `connected`, `needs-login`, `failed` or `disabled`.
    pub state: &'static str,
    pub tools: Vec<mcp_servers::Tool>,
    pub detail: Option<String>,
    /// Whether yaah holds a login for it (HTTP servers only).
    pub logged_in: bool,
    pub enabled: bool,
}

/// Connect to every saved server (in parallel, each within the test's time limit) and say how it went.
#[tauri::command]
pub async fn mcp_status() -> Vec<McpStatus> {
    mcp_oauth::refresh_due().await;
    let mut set = tokio::task::JoinSet::new();
    for (i, server) in mcp_servers::Store::user().list().into_iter().enumerate() {
        set.spawn(async move {
            let logged_in = server.transport == mcp_servers::Transport::Http && mcp_oauth::logged_in(&server.name, &server.url);
            let (state, tools, detail) = if server.enabled {
                match mcp_servers::test(&server).await {
                    Ok(r) => ("connected", r.tools, None),
                    Err(e) if e.contains("HTTP 401") && server.transport == mcp_servers::Transport::Http => ("needs-login", vec![], Some(e)),
                    Err(e) => ("failed", vec![], Some(e)),
                }
            } else {
                ("disabled", vec![], None)
            };
            (i, McpStatus { name: server.name, transport: server.transport, state, tools, detail, logged_in, enabled: server.enabled })
        });
    }
    let mut all = vec![];
    while let Some(Ok(one)) = set.join_next().await {
        all.push(one);
    }
    all.sort_by_key(|(i, _)| *i);
    all.into_iter().map(|(_, s)| s).collect()
}

/// Log in to an HTTP MCP server: the browser opens on its authorization page; resolves when it is done.
#[tauri::command]
pub async fn mcp_login(app: AppHandle, name: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let server = mcp_servers::Store::user().list().into_iter().find(|s| s.name == name).ok_or("That server isn't saved any more.")?;
    if server.transport != mcp_servers::Transport::Http {
        return Err("Only HTTP servers can log in.".into());
    }
    mcp_oauth::login(&server.name, &server.url, |url| app.opener().open_url(url, None::<&str>).map_err(|e| format!("couldn't open the browser: {e}")))
        .await
}

/// How an HTTP MCP server at `url` wants to be signed in to, found by asking it (a few seconds):
/// "none" (it answered without a login), "oauth" (yaah can log in through the browser) or
/// "manual" (it wants a login yaah can't register itself for: an Authorization header instead).
#[tauri::command]
pub async fn mcp_sign_in_kind(url: String) -> Result<&'static str, String> {
    match mcp_oauth::discover(url.trim()).await {
        Ok(e) if e.registration.is_some() => Ok("oauth"),
        Ok(_) => Ok("manual"),
        Err(e) if e == mcp_oauth::NO_LOGIN_WANTED => Ok("none"),
        Err(e) => Err(e),
    }
}

/// Forget the login of an HTTP MCP server.
#[tauri::command]
pub fn mcp_logout(name: String) -> Result<(), String> {
    mcp_oauth::logout(&name)
}

/// Connect to a (possibly unsaved) server and list its tools.
#[tauri::command]
pub async fn test_mcp_server(draft: mcp_servers::Draft) -> Result<mcp_servers::TestReport, String> {
    // Settings sends secrets back masked when they weren't edited: test with the stored ones.
    let draft = mcp_servers::Store::user().unmask(&draft)?;
    mcp_servers::test(&draft.to_server()?).await
}

#[tauri::command]
pub fn mcp_import_candidates() -> Vec<mcp_servers::Candidate> {
    mcp_servers::import_candidates()
}

#[tauri::command]
pub fn import_mcp_servers(picks: Vec<mcp_servers::ImportPick>) -> Result<Vec<mcp_servers::ServerInfo>, String> {
    Ok(mcp_servers::import(&picks)?.into_iter().map(mcp_servers::info_now).collect())
}

// ── Model providers (Settings → Model providers) ────────────────────────────
// OpenRouter and Bedrock for Claude Code, Goose and OpenCode; see providers.rs.
// The keychain can block (an OS prompt), so it's read off the async workers.
// Changes emit "providers-changed" (and "accounts-changed": readiness follows the checks).

fn providers_changed(app: &AppHandle) {
    let _ = app.emit("providers-changed", ());
    let _ = app.emit("accounts-changed", ());
}

async fn off_workers<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// Profiles bound to a provider: their agents restart with its new settings.
async fn restart_bound(hub: &Hub, provider_id: &str) {
    let bound: Vec<String> = agents::Store::user()
        .load()
        .profiles
        .into_iter()
        .filter(|p| p.provider.as_ref().is_some_and(|b| b.provider_id == provider_id))
        .map(|p| p.id)
        .collect();
    for id in bound {
        hub.drop_agent(&id).await;
    }
}

/// Every provider; never a secret, only whether there is one.
#[tauri::command]
pub async fn list_providers() -> Result<Vec<providers::ProviderInfo>, String> {
    off_workers(|| Ok(providers::Store::user().list())).await
}

/// Create (no `id`) or edit a provider. An omitted `secret` keeps the stored one.
#[tauri::command]
pub async fn save_provider(
    app: AppHandle,
    hub: State<'_, Arc<Hub>>,
    id: Option<String>,
    kind: providers::Kind,
    label: String,
    bedrock: Option<providers::Bedrock>,
    secret: Option<SecretString>,
) -> Result<providers::ProviderInfo, String> {
    let draft = providers::Draft { id, kind, label, bedrock, secret };
    let info = off_workers(move || providers::Store::user().save(&draft)).await?;
    restart_bound(&hub, &info.id).await;
    providers_changed(&app);
    Ok(info)
}

/// Refused while an agent profile is bound to it.
#[tauri::command]
pub async fn delete_provider(app: AppHandle, id: String) -> Result<(), String> {
    off_workers(move || providers::Store::user().delete(&id, &agents::Store::user().load().profiles)).await?;
    providers_changed(&app);
    Ok(())
}

/// OpenRouter: `GET /api/v1/key`. Bedrock: `aws sts get-caller-identity`. The result is kept as the provider's `check`.
#[tauri::command]
pub async fn test_provider(app: AppHandle, id: String) -> Result<providers::ProviderInfo, String> {
    let info = providers::Store::user().test(&id).await?;
    providers_changed(&app);
    Ok(info)
}

/// The provider's models an agent preset can use (cached for a day; `refresh` skips the cache).
#[tauri::command]
pub async fn provider_models(id: String, preset: String, refresh: Option<bool>) -> Result<providers::ModelList, String> {
    providers::Store::user().models(&id, &preset, refresh.unwrap_or(false)).await
}

/// Profiles in `~/.aws/config` and `~/.aws/credentials`: names, regions, SSO. Never credentials.
#[tauri::command]
pub async fn aws_profiles() -> Vec<providers::AwsProfile> {
    providers::Store::user().aws_profiles()
}

/// Run `aws sso login --profile P` for a Bedrock provider in the background (the
/// CLI opens the browser). When it's done: "provider-sso-login" `{ id, ok,
/// provider? , error? }`, after testing the provider again.
#[tauri::command]
pub async fn provider_sso_login(app: AppHandle, id: String) -> Result<(), String> {
    let store = providers::Store::user();
    match store.get(&id) {
        Some(p) if p.bedrock.is_some() => {}
        Some(_) => return Err("only Bedrock providers sign in with AWS SSO".into()),
        None => return Err(format!("no model provider {id}")),
    }
    tauri::async_runtime::spawn(async move {
        let payload = match store.sso_login(&id).await {
            Ok(info) => serde_json::json!({ "id": id, "ok": info.check.as_ref().is_some_and(|c| c.ok), "provider": info }),
            Err(e) => serde_json::json!({ "id": id, "ok": false, "error": e }),
        };
        let _ = app.emit("provider-sso-login", payload);
        providers_changed(&app);
    });
    Ok(())
}

/// Bind an agent profile to a provider and model, or unbind it (`binding: null`).
/// Its agent restarts with the new route.
#[tauri::command]
pub async fn set_profile_provider(
    app: AppHandle,
    hub: State<'_, Arc<Hub>>,
    account_id: String,
    binding: Option<providers::Binding>,
) -> Result<agents::ProfileInfo, String> {
    if let Some(b) = &binding
        && providers::Store::user().get(&b.provider_id).is_none()
    {
        return Err(format!("no model provider {}", b.provider_id));
    }
    let profile = agents::Store::user().set_provider(&account_id, binding)?;
    hub.drop_agent(&account_id).await;
    // A login the old route asked for doesn't apply to the new one.
    hub.logged_in(&account_id);
    let _ = app.emit("accounts-changed", ());
    Ok(hub.info(profile))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_only_plain_files_inside_the_chat() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("yaah-open-{}", crate::session::random_token()));
        let other = root.with_extension("other");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(root.join("src/main.go"), "package main\n").unwrap();
        std::fs::write(root.join("run.command"), "echo hi\n").unwrap();
        std::fs::write(root.join("tool"), "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(root.join("tool"), std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(other.join("secret.txt"), "x").unwrap();
        std::os::unix::fs::symlink(other.join("secret.txt"), root.join("link.txt")).unwrap();
        let roots = vec![root.clone()];
        assert!(editable_file(&roots, "src/main.go").unwrap().ends_with("src/main.go"));
        assert!(editable_file(&roots, &root.join("src/main.go").to_string_lossy()).is_ok());
        assert!(editable_file(&roots, "../yaah-open-x.other/secret.txt").is_err());
        assert!(editable_file(&roots, &other.join("secret.txt").to_string_lossy()).unwrap_err().contains("isn't in the chat"));
        assert!(editable_file(&roots, "link.txt").unwrap_err().contains("isn't in the chat"), "a link out is followed, then refused");
        assert!(editable_file(&roots, "run.command").unwrap_err().contains("would run"));
        assert!(editable_file(&roots, "tool").unwrap_err().contains("would run"));
        assert!(editable_file(&roots, "src").unwrap_err().contains("isn't a file"));
        assert!(editable_file(&roots, "missing.go").unwrap_err().contains("doesn't exist"));
        assert!(editable_file(&[], "a").is_err());
    }
}
