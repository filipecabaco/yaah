//! The diff pane's command: the working tree's changes of the repository a folder is in
//! (`sources/git.rs` `working_view`). Read-only; the folder is checked like a terminal's.
#![allow(clippy::needless_pass_by_value, reason = "Tauri hands commands their arguments by value")]

use crate::sources::git;
use crate::terminals;

/// `mode`: `all` (against HEAD), `staged`, `unstaged` or `branch` (against the merge base with `base`).
/// `since`: the fingerprint the pane last saw; when nothing changed only that comes back (`unchanged`).
#[tauri::command]
pub async fn diff_pane_read(cwd: String, mode: String, base: Option<String>, since: Option<String>) -> Result<serde_json::Value, String> {
    let dir = terminals::checked_dir(&cwd)?;
    git::working_view(&dir, &mode, base.as_deref(), since.as_deref()).await
}
