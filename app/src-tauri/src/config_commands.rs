//! The Tauri commands for a chat's model and effort (ACP session config options,
//! `session/config.rs`) and a profile's "New chats start with" defaults. Thin
//! calls into the Hub, which checks every value against what the agent offered.
#![allow(clippy::needless_pass_by_value, reason = "Tauri hands commands their arguments and state by value")]

use crate::session::{AgentDefaults, Hub, SessionInfo};
use std::sync::Arc;
use tauri::State;

/// Change one of a chat's settings (`configId`, e.g. its model) to a value its agent offered.
#[tauri::command]
pub async fn set_chat_config(hub: State<'_, Arc<Hub>>, session_id: String, config_id: String, value: String) -> Result<SessionInfo, String> {
    hub.set_chat_config(&session_id, &config_id, &value).await
}

/// Settings → Agents: what a profile's new chats start with, and what it offers.
#[tauri::command]
pub fn agent_config_defaults(hub: State<'_, Arc<Hub>>, account_id: String) -> Result<AgentDefaults, String> {
    hub.agent_defaults(&account_id)
}

/// Set (or clear, with no `value`) what a profile's new chats start with.
#[tauri::command]
pub fn set_agent_config_default(
    hub: State<'_, Arc<Hub>>,
    account_id: String,
    config_id: String,
    value: Option<String>,
) -> Result<AgentDefaults, String> {
    hub.set_agent_default(&account_id, &config_id, value.as_deref())
}
