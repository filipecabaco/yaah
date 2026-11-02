//! The Tauri commands for the component library, live sources, settings, integrations,
//! MCP servers and skills. Each is a thin call into the module that owns the logic.
#![allow(clippy::needless_pass_by_value, reason = "Tauri hands commands their arguments and state by value")]

use crate::ui_library::{Component, Library, Prepared};
use crate::{integrations, mcp_servers, path_env, settings, skills, sources};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

// ── UI component library ────────────────────────────────────────────────────

#[tauri::command]
pub fn list_components(library: State<'_, Arc<Library>>) -> Result<Vec<Component>, String> {
    library.list()
}

/// Render-ready tree for a library component with the given props (previews).
#[tauri::command]
pub fn preview_component(library: State<'_, Arc<Library>>, name: String, props: serde_json::Value) -> Result<Prepared, String> {
    library.prepare(Some(&name), props, None).map_err(|errs| errs.join("\n"))
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
#[tauri::command]
pub async fn integration_connect(app: AppHandle, service: String) -> Result<serde_json::Value, String> {
    let notify: integrations::Notify = Arc::new(move |v| {
        let _ = app.emit("integration-changed", v);
    });
    integrations::connect(&service, notify).await
}

#[tauri::command]
pub async fn integration_set_key(app: AppHandle, service: String, key: String) -> Result<serde_json::Value, String> {
    let r = integrations::set_key(&service, &key).await?;
    let _ = app.emit("integration-changed", serde_json::json!({ "service": service, "ok": true }));
    Ok(r)
}

#[tauri::command]
pub fn integration_disconnect(app: AppHandle, service: String) -> Result<(), String> {
    integrations::disconnect(&service)?;
    let _ = app.emit("integration-changed", serde_json::json!({ "service": service, "ok": true }));
    Ok(())
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
