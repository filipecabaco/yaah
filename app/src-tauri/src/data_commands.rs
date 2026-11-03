//! The Tauri commands for the component library, live sources, settings, integrations,
//! projects from tracker items, MCP servers and skills. Each is a thin call into the
//! module that owns the logic.
#![allow(clippy::needless_pass_by_value, reason = "Tauri hands commands their arguments and state by value")]

use crate::integrations::Integrations;
use crate::projects::{Project, Projects};
use crate::session::{ChatTarget, Hub};
use crate::ui_libraries::{LibraryExport, LibraryInfo, LibraryPreview, LibrarySource, LibraryUpdate, Manifest};
use crate::ui_library::{Component, Library, Prepared};
use crate::work_items::{self, Started, WorkItem, WorkQueue};
use crate::{agents, integrations, mcp_servers, path_env, repos, settings, skills, sources};
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

#[tauri::command]
pub async fn read_source(sources: State<'_, Arc<sources::Sources>>, source: serde_json::Value) -> Result<serde_json::Value, String> {
    sources.read(&source).await
}

// ── Settings → General ───────────────────────────────────────────────────────

#[tauri::command]
pub fn general_settings() -> serde_json::Value {
    settings::general()
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

#[tauri::command]
pub fn set_theme(light: String, dark: String) -> Result<(), String> {
    settings::set_theme(&light, &dark)
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
    let chat = |project: Project| async move {
        let account = account.ok_or("no agent is set up: add one in Settings → Agents, then start a chat in the project")?;
        hub.new_session(ChatTarget::Project(&project), &account).await.map(|info| info.session_id)
    };
    let roots = tauri::async_runtime::spawn_blocking(repos::roots).await.map_err(|e| e.to_string())?;
    let started = work_items::start(Integrations::user(), &projects, &service, &id, roots, chat).await?;
    if !started.existing {
        projects_changed(&app, &started.project.id);
    }
    Ok(started)
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

/// Connect to a (possibly unsaved) server and list its tools.
#[tauri::command]
pub async fn test_mcp_server(draft: mcp_servers::Draft) -> Result<mcp_servers::TestReport, String> {
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
