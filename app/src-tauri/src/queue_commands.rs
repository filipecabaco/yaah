//! The Tauri commands for a chat's message queue (`session/queue.rs`). Thin calls
//! into the Hub, which owns the queue, its order, sending and pausing; these only
//! add the composer's staged attachments, which live beside the Hub.
#![allow(clippy::needless_pass_by_value, reason = "Tauri hands commands their arguments and state by value")]

use crate::attachments::{Attachment, Staged, Staging};
use crate::session::{Hub, SessionInfo};
use serde::Serialize;
use std::sync::Arc;
use tauri::State;

/// Remove a queued message (and the images only it held).
#[tauri::command]
pub fn queue_remove(hub: State<'_, Arc<Hub>>, staging: State<'_, Staging>, session_id: String, id: String) -> Result<SessionInfo, String> {
    hub.queue_remove(&session_id, &id, &|image| staging.holds_image(&session_id, image))
}

/// What Edit puts back in the composer: the text, the `@` mentions, and the attachments staged again.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditedMessage {
    pub text: String,
    pub mentions: Vec<String>,
    pub attachments: Vec<Attachment>,
    /// Attachments that no longer fit beside what the composer already holds.
    pub refused: Vec<crate::attachments::Refused>,
}

/// Edit: take a queued message out of the queue and hand it back to the composer.
#[tauri::command]
pub fn queue_edit(hub: State<'_, Arc<Hub>>, staging: State<'_, Staging>, session_id: String, id: String) -> Result<EditedMessage, String> {
    let item = hub.queue_take(&session_id, &id)?;
    let Staged { added, refused } = staging.restage(&session_id, item.files);
    Ok(EditedMessage { text: item.text, mentions: item.mentions, attachments: added, refused })
}

/// Move a queued message to `to` (0 = next).
#[tauri::command]
pub fn queue_move(hub: State<'_, Arc<Hub>>, session_id: String, id: String, to: usize) -> Result<SessionInfo, String> {
    hub.queue_move(&session_id, &id, to)
}

/// Clear queue (⌘K): every message not already on its way.
#[tauri::command]
pub fn queue_clear(hub: State<'_, Arc<Hub>>, staging: State<'_, Staging>, session_id: String) -> Result<SessionInfo, String> {
    hub.queue_clear(&session_id, &|image| staging.holds_image(&session_id, image))
}

/// Resume queue: it sends again (the first message at once when no turn runs).
#[tauri::command]
pub fn queue_resume(hub: State<'_, Arc<Hub>>, session_id: String) -> Result<SessionInfo, String> {
    hub.queue_resume(&session_id)
}

/// Join all: unite every waiting message into one, so the next send takes them together.
#[tauri::command]
pub fn queue_merge(hub: State<'_, Arc<Hub>>, session_id: String) -> Result<SessionInfo, String> {
    hub.queue_merge(&session_id)
}

/// Send now: stop the running turn and send this message next.
#[tauri::command]
pub fn queue_send_now(hub: State<'_, Arc<Hub>>, session_id: String, id: String) -> Result<SessionInfo, String> {
    hub.queue_send_now(&session_id, &id)
}
