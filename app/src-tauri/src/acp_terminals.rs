//! The ACP client's terminal methods (`clientCapabilities.terminal: true`): an
//! agent runs a command in a terminal yaah shows, through the same PTY layer as
//! terminal panes (`terminals.rs`). The agent still asks permission before it
//! runs anything (`session/request_permission`), as it does for its own commands.
//!
//! - `terminal/create { sessionId, command, args?, env?, cwd?, outputByteLimit? }`
//!   → `{ terminalId }`. The command runs as an argv (`/bin/sh -c command` when it
//!   has no args), in the chat's folder or `cwd`, which must be one of the chat's
//!   folders or inside one.
//! - `terminal/output` → `{ output, truncated, exitStatus? }`: the output as text,
//!   escape sequences removed, at most `outputByteLimit` bytes (cut from the start
//!   at a character boundary).
//! - `terminal/wait_for_exit` → `{ exitCode, signal }`, once it has exited.
//! - `terminal/kill` stops it and keeps the terminal; `terminal/release` stops it
//!   and frees it, and its last bytes stay with the tool call that showed it.
//!
//! A terminal answers only to the agent process that created it, for that chat:
//! another chat's id, or another process's (a restarted agent), is unknown.

use crate::acp::Responder;
use crate::terminals::{self, ExitStatus, Owner, Spec, Terminals};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const CREATE: &str = "terminal/create";
const INVALID_PARAMS: i64 = -32602;
/// The size of an agent command's PTY; programs lay out their output for it.
pub const COLS: u16 = 120;
pub const ROWS: u16 = 24;
/// An agent's terminals per chat at once (released ones don't count).
pub const MAX_PER_CHAT: usize = 32;

/// Whether `method` is one of the terminal methods this module answers.
pub fn handles(method: &str) -> bool {
    matches!(method, "terminal/create" | "terminal/output" | "terminal/wait_for_exit" | "terminal/kill" | "terminal/release")
}

/// What the methods need to know about chats, from `session.rs`.
pub trait Chats {
    /// For an ACP session id the asking process speaks for: the chat's id and its
    /// folders (its cwd first). `None` for a chat it didn't start or load.
    fn chat(&self, acp_session: &str) -> Option<(String, Vec<PathBuf>)>;
    /// A released terminal's last bytes, kept with the tool call that shows it.
    fn keep(&self, chat: &str, terminal_id: &str, bytes: &[u8], exit: Option<&ExitStatus>);
}

/// Answer one terminal request from agent process `generation`.
pub fn handle(terms: &Arc<Terminals>, chats: &dyn Chats, generation: u64, id: Value, method: &str, params: &Value, responder: &Responder) {
    let bad = |msg: &str| {
        responder.err(id.clone(), INVALID_PARAMS, msg);
    };
    let Some(sid) = params["sessionId"].as_str() else { return bad("sessionId is required") };
    let Some((chat, roots)) = chats.chat(sid) else { return bad("unknown session") };
    if method == CREATE {
        match create(terms, generation, &chat, &roots, params) {
            Ok(terminal_id) => {
                responder.ok(id, json!({ "terminalId": terminal_id }));
            }
            Err(e) => bad(&e),
        }
        return;
    }
    let Some(terminal_id) = params["terminalId"].as_str() else { return bad("terminalId is required") };
    let Some(term) = terms.owned(terminal_id, generation, &chat) else { return bad("unknown terminal") };
    match method {
        "terminal/output" => {
            let (output, truncated) = term.output();
            let mut result = json!({ "output": output, "truncated": truncated });
            if let Some(exit) = term.exit() {
                result["exitStatus"] = json!(exit);
            }
            responder.ok(id, result);
        }
        "terminal/wait_for_exit" => {
            let responder = responder.clone();
            // Off the agent's reader: other messages (and this terminal's own kill) go on meanwhile.
            let waited = std::thread::Builder::new().name("yaah-term-wait-exit".into()).spawn({
                let id = id.clone();
                move || {
                    let exit = term.wait(None).unwrap_or(ExitStatus { exit_code: None, signal: None });
                    responder.ok(id, json!(exit));
                }
            });
            if waited.is_err() {
                bad("couldn't wait for the terminal");
            }
        }
        "terminal/kill" => {
            term.kill();
            responder.ok(id, json!({}));
        }
        "terminal/release" => {
            let tid = term.id.clone();
            drop(term);
            if let Some((bytes, exit)) = terms.release(&tid) {
                chats.keep(&chat, &tid, &bytes, exit.as_ref());
            }
            responder.ok(id, json!({}));
        }
        other => {
            responder.method_not_found(id, other);
        }
    }
}

fn create(terms: &Arc<Terminals>, generation: u64, chat: &str, roots: &[PathBuf], params: &Value) -> Result<String, String> {
    let command = params["command"].as_str().ok_or("command is required")?;
    let args = strings(&params["args"], "args")?;
    let env = match &params["env"] {
        Value::Null => vec![],
        Value::Array(vars) => vars
            .iter()
            .map(|v| match (v["name"].as_str(), v["value"].as_str()) {
                (Some(n), Some(val)) => Ok((n.to_owned(), val.to_owned())),
                _ => Err("env is a list of { name, value }".to_owned()),
            })
            .collect::<Result<_, _>>()?,
        _ => return Err("env is a list of { name, value }".into()),
    };
    let cwd = match params["cwd"].as_str() {
        Some(dir) => within(roots, dir)?,
        None => roots.first().map(|r| r.to_string_lossy().into_owned()).as_deref().map(terminals::checked_dir).ok_or("this chat has no folder")??,
    };
    let limit = match &params["outputByteLimit"] {
        Value::Null => terminals::DEFAULT_OUTPUT_LIMIT,
        v => usize::try_from(v.as_u64().ok_or("outputByteLimit is a number of bytes")?).unwrap_or(usize::MAX),
    };
    let owner = Owner::Agent { generation, chat: chat.to_owned() };
    if terms.count(|o| matches!(o, Owner::Agent { chat: c, .. } if c == chat)) >= MAX_PER_CHAT {
        return Err(format!("this chat already has {MAX_PER_CHAT} terminals open; release some first"));
    }
    let spec = Spec::command(cwd, command, &args, env, COLS, ROWS)?;
    Ok(terms.open(spec, owner, Some(limit))?.id.clone())
}

fn strings(v: &Value, what: &str) -> Result<Vec<String>, String> {
    match v {
        Value::Null => Ok(vec![]),
        Value::Array(items) => items.iter().map(|a| a.as_str().map(str::to_owned).ok_or_else(|| format!("{what} is a list of strings"))).collect(),
        _ => Err(format!("{what} is a list of strings")),
    }
}

/// `dir`, resolved, if it is one of `roots` or inside one (compared as real paths).
pub fn within(roots: &[PathBuf], dir: &str) -> Result<PathBuf, String> {
    let real = terminals::checked_dir(dir)?;
    let inside = roots.iter().filter_map(|r| Path::new(r).canonicalize().ok()).any(|r| real.starts_with(&r));
    if inside { Ok(real) } else { Err(format!("{dir} isn't one of this chat's folders")) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cwd_must_be_inside_the_chats_folders() {
        let base = std::env::temp_dir().join(format!("yaah-acp-term-{}", crate::session::random_token()));
        let (repo, other) = (base.join("repo"), base.join("other"));
        std::fs::create_dir_all(repo.join("src")).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let roots = vec![repo.clone()];
        let real = |p: &Path| p.canonicalize().unwrap();
        assert_eq!(within(&roots, &repo.to_string_lossy()).unwrap(), real(&repo));
        assert_eq!(within(&roots, &repo.join("src").to_string_lossy()).unwrap(), real(&repo.join("src")));
        assert!(within(&roots, &other.to_string_lossy()).is_err());
        // `..` can't climb out: paths are compared once resolved.
        assert!(within(&roots, &repo.join("../other").to_string_lossy()).is_err());
        // Nor can a symlink inside the folder that points out of it.
        std::os::unix::fs::symlink(&other, repo.join("link")).unwrap();
        assert!(within(&roots, &repo.join("link").to_string_lossy()).is_err());
        // A sibling whose name starts the same isn't inside.
        std::fs::create_dir_all(base.join("repo-two")).unwrap();
        assert!(within(&roots, &base.join("repo-two").to_string_lossy()).is_err());
        assert!(within(&roots, "relative").is_err());
        std::fs::remove_dir_all(base).unwrap();
    }
}
