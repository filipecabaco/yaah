//! What `acp_terminals.rs` needs from chats: the chat an agent process's
//! terminal request is for (only one it is attached to), its folders, and a
//! place for a released terminal's last bytes: the tool call that showed it,
//! so the card can replay the output after a restart.

use super::{Entry, Shared};
use crate::terminals::ExitStatus;
use base64::Engine;
use serde_json::{Value, json};
use std::path::PathBuf;

/// The output kept with a tool call, at most (the end of it).
pub const KEPT_BYTES: usize = 128 << 10;

pub(super) struct TerminalChats<'a> {
    pub shared: &'a Shared,
    pub generation: u64,
}

impl crate::acp_terminals::Chats for TerminalChats<'_> {
    fn chat(&self, acp_session: &str) -> Option<(String, Vec<PathBuf>)> {
        let chat = self.shared.chat(acp_session)?;
        let s = chat.lock().unwrap();
        (s.attached == Some(self.generation)).then(|| {
            let roots = std::iter::once(&s.info.cwd).chain(&s.info.additional_dirs).map(PathBuf::from).collect();
            (s.info.session_id.clone(), roots)
        })
    }

    fn keep(&self, chat: &str, terminal_id: &str, bytes: &[u8], exit: Option<&ExitStatus>) {
        let tail = &bytes[bytes.len().saturating_sub(KEPT_BYTES)..];
        let kept = base64::engine::general_purpose::STANDARD.encode(tail);
        let _ = self.shared.with(chat, |s| {
            let shows = |content: &Value| content.as_array().is_some_and(|c| c.iter().any(|c| is_terminal(c, terminal_id)));
            let found: Vec<usize> =
                (0..s.entries.len()).filter(|&i| matches!(&*s.entries[i], Entry::Tool { content, .. } if shows(content))).collect();
            for i in found {
                if let Some(Entry::Tool { content, .. }) = s.entry_mut(i) {
                    for c in content.as_array_mut().into_iter().flatten().filter(|c| is_terminal(c, terminal_id)) {
                        c["keptOutput"] = json!(kept);
                        c["exitStatus"] = json!(exit);
                    }
                }
                self.shared.emit_entry(s, i);
            }
            self.shared.save(s);
        });
    }
}

/// `new` content replacing `old`: terminals in both keep what was kept of them.
pub(super) fn carry_kept(old: &Value, new: &mut Value) {
    let Some(old) = old.as_array() else { return };
    for c in new.as_array_mut().into_iter().flatten() {
        let Some(id) = c["terminalId"].as_str().filter(|_| c["type"] == "terminal" && c.get("keptOutput").is_none()) else { continue };
        if let Some(was) = old.iter().find(|o| is_terminal(o, id) && o.get("keptOutput").is_some()) {
            let (kept, exit) = (was["keptOutput"].clone(), was["exitStatus"].clone());
            c["keptOutput"] = kept;
            c["exitStatus"] = exit;
        }
    }
}

fn is_terminal(content: &Value, id: &str) -> bool {
    content["type"] == "terminal" && content["terminalId"] == id
}
