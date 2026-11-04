//! Where trust applies, as the chat header, permission cards and Settings → Chat
//! show it (`session/trust.rs`). Trusting from a card is `commands::trust_mcp_server`.
#![allow(clippy::needless_pass_by_value, reason = "Tauri hands commands their arguments and state by value")]

use crate::session::{Hub, PermissionSettings, TrustView};
use std::sync::Arc;
use tauri::State;

/// A chat's trust scope (`project`, `quickChats` or `chat`), where its cards offer
/// to trust a server, and every server trusted for it with the scope that trusts it.
#[tauri::command]
pub fn trust_scope(hub: State<'_, Arc<Hub>>, session_id: String) -> Result<TrustView, String> {
    hub.trust_scope(&session_id)
}

/// Settings → Chat: the permission switches and the servers trusted in all chats.
#[tauri::command]
pub fn permission_settings(hub: State<'_, Arc<Hub>>) -> PermissionSettings {
    hub.permission_settings()
}

/// Settings → Chat, "Allow web searches without asking".
#[tauri::command]
pub fn set_allow_web_search(hub: State<'_, Arc<Hub>>, enabled: bool) -> Result<(), String> {
    hub.set_allow_web_search(enabled)
}

/// Settings → Chat, a server's Remove: it no longer runs without asking in all chats.
#[tauri::command]
pub fn untrust_mcp_server_everywhere(hub: State<'_, Arc<Hub>>, server: String) -> Result<PermissionSettings, String> {
    hub.untrust_everywhere(&server)
}

/// A quick chat's header: stop trusting a server in every quick chat.
#[tauri::command]
pub fn untrust_quick_chat_mcp_server(hub: State<'_, Arc<Hub>>, server: String) -> Result<(), String> {
    hub.untrust_quick_chats(&server)
}
