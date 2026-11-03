pub mod accounts;
pub mod acp;
pub mod agent_conformance;
pub mod agent_guide;
pub mod agent_install;
pub mod agent_versions;
pub mod agents;
mod commands;
mod data_commands;
mod files;
pub mod integrations;
mod json_file;
pub mod layout;
pub mod login;
pub mod mcp_servers;
pub mod path_env;
pub mod projects;
mod random;
pub mod repos;
pub mod session;
pub mod settings;
pub mod skills;
pub mod sources;
mod ui_files;
mod ui_libraries;
mod ui_library;
pub mod ui_mcp;
mod work_items;

use login::Logins;
use projects::Projects;
use session::Hub;
use std::sync::Arc;
use tauri::{Manager, RunEvent};
use ui_library::Library;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[allow(clippy::too_many_lines, reason = "the list of every command")]
pub fn run() {
    // Read in the background: only spawning a program waits for it (path_env.rs).
    path_env::start_login_shell();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Projects::default())
        .manage(Logins::default())
        .setup(|app| {
            let hub = Arc::new(Hub::with_store(commands::emitter(app.handle().clone()), accounts::home().join(".yaah/sessions")));
            // Both read in the background; their first use waits for them (ui_library.rs, sources.rs).
            let library = Library::local();
            let sources = Arc::new(sources::Sources::new());
            match ui_mcp::start(Arc::new(ui_mcp::UiHost::new(hub.clone(), library.clone(), sources.clone()))) {
                Ok(port) => hub.set_ui_port(port),
                Err(e) => eprintln!("[ui] MCP server not started, chats won't get UI tools: {e}"),
            }
            // What agents are told about yaah's UI (agent_guide.rs): its skills are written now and when the library changes.
            let guide = Arc::new(agent_guide::Guide::for_app(library.clone()));
            guide.sync_in_background();
            hub.set_guide(guide.clone());
            // npm-based agents: drop version folders nothing runs any more, and check for newer versions daily.
            agent_install::cleanup_in_background(agent_versions::Versions::user().keep(&settings::agent_versions()));
            // The conformance suite checks each newer version before it runs (agent_conformance.rs), and audits what runs daily.
            agent_versions::set_verifier(Box::new(agent_conformance::Suite));
            agent_versions::watch();
            agent_conformance::watch_advisories();
            app.manage(guide);
            app.manage(hub);
            app.manage(library);
            app.manage(sources);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_agents,
            commands::list_agent_presets,
            commands::save_agent,
            commands::remove_agent,
            commands::set_default_agent,
            commands::test_agent,
            commands::hold_agent_version,
            commands::check_agent_updates,
            commands::verify_agent_version,
            commands::restart_agents,
            commands::login_methods,
            commands::start_login,
            commands::submit_login_code,
            commands::cancel_login,
            commands::list_projects,
            commands::create_project,
            commands::rename_project,
            commands::set_project_status,
            commands::add_project_dir,
            commands::add_project_dirs,
            commands::list_repos,
            commands::set_workspace_roots,
            commands::clone_repo,
            data_commands::list_components,
            data_commands::read_source,
            data_commands::open_in_editor,
            data_commands::general_settings,
            data_commands::set_appearance,
            data_commands::set_theme,
            data_commands::set_tool_card,
            agent_guide::agent_guide,
            agent_guide::set_teach_agents,
            data_commands::read_custom_theme,
            data_commands::reveal_data_dir,
            data_commands::window_layout,
            data_commands::set_layout,
            data_commands::set_sidebar,
            data_commands::integrations_status,
            data_commands::integration_connect,
            data_commands::integration_set_key,
            data_commands::integration_disconnect,
            data_commands::work_queue,
            data_commands::resolve_work_item,
            data_commands::start_project_from_item,
            data_commands::refresh_project_link,
            data_commands::unlink_project,
            data_commands::set_project_agent,
            data_commands::list_connections,
            data_commands::add_connection,
            data_commands::remove_connection,
            data_commands::list_mcp_servers,
            data_commands::save_mcp_server,
            data_commands::remove_mcp_server,
            data_commands::set_mcp_server_enabled,
            data_commands::test_mcp_server,
            data_commands::mcp_import_candidates,
            data_commands::import_mcp_servers,
            data_commands::list_skills,
            data_commands::skills_lookup,
            data_commands::skills_install,
            data_commands::skills_update,
            data_commands::skills_remove,
            data_commands::preview_component,
            data_commands::list_libraries,
            data_commands::inspect_library,
            data_commands::install_library,
            data_commands::update_library,
            data_commands::set_library_enabled,
            data_commands::remove_library,
            data_commands::copy_component,
            data_commands::export_library,
            commands::remove_project_dir,
            commands::delete_project,
            commands::read_brief,
            commands::write_brief,
            commands::new_session,
            commands::new_quick_chat,
            commands::add_chat_dirs,
            commands::set_chat_project,
            commands::promote_chat,
            commands::list_sessions,
            commands::get_transcript,
            commands::get_entries,
            commands::send_prompt,
            commands::switch_agent,
            commands::answer_ui,
            commands::edit_ui,
            commands::rename_session,
            commands::delete_session,
            commands::search_files,
            commands::cancel_turn,
            commands::respond_permission,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Transcripts are written in the background: finish before the process ends.
            if let RunEvent::Exit = event
                && let Some(hub) = app.try_state::<Arc<Hub>>()
            {
                hub.flush();
            }
        });
}
