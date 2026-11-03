//! The Tauri commands for terminals: shell panes (`terminals.rs`), views of any
//! terminal (an agent's too), and "Open in terminal" (`terminal_apps.rs`). Thin
//! calls into those modules.
//!
//! Output reaches a view over the Tauri channel it attaches with: raw bytes (an
//! `ArrayBuffer` in JS) for what the program printed, and a JSON `{ exit }` when it
//! ends. The view acknowledges what it has drawn (`terminal_ack`) so a fast
//! program waits for the UI ([`crate::terminals::HIGH_WATER`]).
#![allow(clippy::needless_pass_by_value, reason = "Tauri hands commands their arguments and state by value")]

use crate::session::Hub;
use crate::terminals::{self, Attached, Frame, Owner, Spec};
use crate::{settings, terminal_apps};
use serde::Serialize;
use serde_json::json;
use std::sync::Arc;
use tauri::State;
use tauri::ipc::{Channel, InvokeResponseBody};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    id: String,
    /// The folder it runs in, resolved.
    cwd: String,
    title: String,
}

/// A shell pane's shell: the login shell in `cwd` (else where the last one opened, or home).
#[tauri::command]
pub fn terminal_open(hub: State<'_, Arc<Hub>>, cwd: Option<String>, cols: u16, rows: u16, shell: Option<String>) -> Result<Opened, String> {
    let dir = match cwd.as_deref().filter(|c| !c.is_empty()) {
        Some(c) => terminals::checked_dir(c)?,
        None => settings::terminal_dir(),
    };
    let term = hub.terminals().open(Spec::login_shell(dir.clone(), shell.as_deref(), cols, rows)?, Owner::User, None)?;
    if let Err(e) = settings::set_terminal_dir(&dir) {
        eprintln!("[terminals] couldn't remember the folder: {e}");
    }
    Ok(Opened { id: term.id.clone(), cwd: dir.to_string_lossy().into_owned(), title: term.title.clone() })
}

/// Watch terminal `id`: its scrollback and live output go to `channel`.
#[tauri::command]
pub fn terminal_attach(hub: State<'_, Arc<Hub>>, id: String, channel: Channel<InvokeResponseBody>) -> Result<Attached, String> {
    hub.terminals().attach(
        &id,
        Box::new(move |frame| match frame {
            Frame::Data(bytes) => channel.send(InvokeResponseBody::Raw(bytes.to_vec())).is_ok(),
            Frame::Exit(exit) => channel.send(InvokeResponseBody::Json(json!({ "exit": exit }).to_string())).is_ok(),
        }),
    )
}

#[tauri::command]
pub fn terminal_detach(hub: State<'_, Arc<Hub>>, id: String, viewer: u64) {
    hub.terminals().detach(&id, viewer);
}

/// The view drew `bytes` more of what it was sent.
#[tauri::command]
pub fn terminal_ack(hub: State<'_, Arc<Hub>>, id: String, viewer: u64, bytes: usize) {
    hub.terminals().ack(&id, viewer, bytes);
}

/// Keys and pastes. Off the main thread: a program that isn't reading can make a write wait.
#[tauri::command]
pub async fn terminal_write(hub: State<'_, Arc<Hub>>, id: String, data: String) -> Result<(), String> {
    let terms = hub.terminals().clone();
    tauri::async_runtime::spawn_blocking(move || terms.write(&id, data.as_bytes())).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn terminal_resize(hub: State<'_, Arc<Hub>>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    hub.terminals().resize(&id, cols, rows)
}

/// Close a shell pane's shell (an agent's terminal is its agent's to release).
#[tauri::command]
pub fn terminal_close(hub: State<'_, Arc<Hub>>, id: String) {
    hub.terminals().close(&id);
}

/// Stop the program in a terminal (a tool card's Stop); the terminal stays, readable.
#[tauri::command]
pub fn terminal_kill(hub: State<'_, Arc<Hub>>, id: String) -> Result<(), String> {
    hub.terminals().kill(&id)
}

/// Where a new terminal pane opens when nothing says where.
#[tauri::command]
pub fn terminal_default_dir() -> String {
    settings::terminal_dir().to_string_lossy().into_owned()
}

/// "Open in terminal": the user's terminal app, in `dir`.
#[tauri::command]
pub fn open_in_terminal(dir: String) -> Result<(), String> {
    terminal_apps::open(&settings::terminal_app(), &dir)
}

#[tauri::command]
pub fn set_terminal_app(id: String) -> Result<(), String> {
    settings::set_terminal_app(&id)
}
