//! `ui_request_folders`: the agent asks to add folders to the chat (to read git
//! data in a repo outside it, say). The request shows inline as an
//! [`Entry::FolderRequest`] ("Add" / "Not now") and the tool call waits on it
//! like `ui_ask`. "Add" goes through the add-repos flow ([`Hub::add_dirs`]), so
//! the folders join the chat, or its project, exactly as `/repos` would add them.

use super::{Entry, Hub};
use serde_json::{Value, json};
use std::sync::mpsc;

impl Hub {
    /// Show the agent's request for `paths` in the chat, waiting on the user.
    /// The receiver gets `Some({ "added": bool })`, or `None` if the turn is stopped.
    pub fn request_folders(&self, session_id: &str, paths: Vec<String>, reason: String) -> Result<(String, mpsc::Receiver<Option<Value>>), String> {
        let (ask_id, answers) = self.register_ask(session_id);
        let pushed = self.shared.with(session_id, |s| {
            self.shared.push(s, Entry::FolderRequest { paths, reason, ask_id: Some(ask_id.clone()), answer: None });
            self.shared.save(s);
        });
        match pushed {
            Ok(()) => Ok((ask_id, answers)),
            Err(e) => {
                self.drop_ask(&ask_id);
                Err(e)
            }
        }
    }

    /// The user answered the folder request at `index`. With `add`, its folders
    /// are added first (`add_dirs`, the add-repos flow); if that fails the request
    /// stays open, so they can try again or say not now. The waiting tool call
    /// then hears the answer.
    pub fn answer_folders(
        &self,
        session_id: &str,
        index: usize,
        add: bool,
        add_dirs: impl FnOnce(&[String]) -> Result<(), String>,
    ) -> Result<(), String> {
        let pending = |s: &mut super::Session| match s.entries.get(index).map(|e| &**e) {
            Some(Entry::FolderRequest { answer: None, paths, ask_id, .. }) => Ok((paths.clone(), ask_id.clone())),
            Some(Entry::FolderRequest { .. }) => Err("this request was already answered".to_owned()),
            _ => Err("no folder request at that index".to_owned()),
        };
        let (paths, _) = self.shared.with(session_id, pending)??;
        // Outside the chat's lock: adding takes it (and the project's) itself.
        if add {
            add_dirs(&paths)?;
        }
        let ask_id = self.shared.with(session_id, |s| {
            let (_, ask_id) = pending(s)?;
            if let Some(Entry::FolderRequest { answer, .. }) = s.entry_mut(index) {
                *answer = Some(if add { "added" } else { "declined" }.to_owned());
            }
            self.shared.emit_entry(s, index);
            self.shared.save(s);
            Ok::<_, String>(ask_id)
        })??;
        if let Some(id) = ask_id
            && let Some((_, tx)) = self.asks.lock().unwrap().remove(&id)
        {
            let _ = tx.send(Some(json!({ "added": add })));
        }
        Ok(())
    }
}
