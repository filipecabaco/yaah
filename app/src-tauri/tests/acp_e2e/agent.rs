//! A scripted ACP agent: a real process speaking newline-delimited JSON-RPC on
//! stdio. The first word of each prompt picks what it plays out; every message
//! it receives is appended to `YAAH_AGENT_LOG` so tests can check what yaah sent.
//!
//! Knobs (environment): `YAAH_AGENT_PROTOCOL` (the version it answers with),
//! `YAAH_AGENT_NO_LOAD` (no `session/load`), `YAAH_AGENT_SESSION_ID` (a fixed id
//! for `session/new`).

use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, Write};

/// Set in the agent's environment to run this binary as the agent.
pub const ENV: &str = "YAAH_SCRIPTED_AGENT";

struct Agent {
    input: std::io::Lines<std::io::StdinLock<'static>>,
    log: Option<std::fs::File>,
    next_id: u64,
    sessions: u64,
}

pub fn run() {
    if std::env::args().nth(1).as_deref() == Some("login") {
        return login();
    }
    let log = std::env::var_os("YAAH_AGENT_LOG").and_then(|p| std::fs::OpenOptions::new().create(true).append(true).open(p).ok());
    let mut agent = Agent { input: std::io::stdin().lock().lines(), log, next_id: 1000, sessions: 0 };
    eprintln!("scripted agent {} up", std::process::id());
    // Not JSON-RPC: clients skip stray stdout lines.
    raw(b"scripted agent starting\n");
    while let Some(msg) = agent.recv() {
        agent.handle(&msg);
    }
}

/// A terminal login: shows a link, reads a code, succeeds on the right one.
fn login() {
    if std::env::var("YAAH_LOGIN_GREETING").as_deref() != Ok("hello") {
        std::process::exit(2);
    }
    raw(b"\x1b[1mOpen\x1b[0m \x1b]8;;https://example.com/login?c=1\x1b\\this link\x1b]8;;\x1b\\ to sign in\n");
    eprintln!("Paste the code: https://example.com/fallback");
    let mut code = String::new();
    let _ = std::io::stdin().read_line(&mut code);
    std::process::exit(i32::from(code.trim() != "let-me-in"));
}

fn raw(bytes: &[u8]) {
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(bytes);
    let _ = out.flush();
}

fn send(msg: &Value) {
    raw(format!("{msg}\n").as_bytes());
}

fn update(sid: &str, update: &Value) {
    send(&json!({ "jsonrpc": "2.0", "method": "session/update", "params": { "sessionId": sid, "update": update } }));
}

fn chunk(sid: &str, text: &str) {
    update(sid, &json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": text } }));
}

fn options() -> Value {
    json!([
        { "optionId": "always", "name": "Always allow", "kind": "allow_always" },
        { "optionId": "once", "name": "Allow", "kind": "allow_once" },
        { "optionId": "no", "name": "Reject", "kind": "reject_once" }
    ])
}

/// The option a permission response chose, or "cancelled".
fn chosen(response: &Value) -> String {
    let outcome = &response["result"]["outcome"];
    outcome["optionId"].as_str().or(outcome["outcome"].as_str()).unwrap_or("?").to_owned()
}

impl Agent {
    fn recv(&mut self) -> Option<Value> {
        loop {
            let line = self.input.next()?.ok()?;
            if let Some(log) = &mut self.log {
                let _ = writeln!(log, "{}", json!({ "pid": std::process::id(), "line": line }));
            }
            if let Ok(v) = serde_json::from_str(&line) {
                return Some(v);
            }
        }
    }

    fn respond(id: &Value, result: &Value) {
        send(&json!({ "jsonrpc": "2.0", "id": id, "result": result }));
    }

    /// Ask yaah something; returns the id to wait on.
    fn ask(&mut self, method: &str, params: &Value) -> Value {
        self.next_id += 1;
        let id = json!(self.next_id);
        send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        id
    }

    fn permission(&mut self, sid: &str, tool_call: &Value) -> Value {
        self.ask("session/request_permission", &json!({ "sessionId": sid, "toolCall": tool_call, "options": options() }))
    }

    /// Read until every id in `ids` is answered (and, with `until_cancel`, a
    /// `session/cancel` arrived). Returns the responses by id.
    fn wait(&mut self, ids: &[Value], until_cancel: bool) -> HashMap<String, Value> {
        let (mut got, mut cancelled) = (HashMap::new(), false);
        while got.len() < ids.len() || (until_cancel && !cancelled) {
            let Some(msg) = self.recv() else { std::process::exit(0) };
            if msg["method"] == "session/cancel" {
                cancelled = true;
            } else if msg.get("method").is_none() && ids.contains(&msg["id"]) {
                got.insert(msg["id"].to_string(), msg);
            }
        }
        got
    }

    fn handle(&mut self, msg: &Value) {
        let id = &msg["id"];
        let params = &msg["params"];
        match msg["method"].as_str().unwrap_or_default() {
            "initialize" => {
                let protocol: u64 = std::env::var("YAAH_AGENT_PROTOCOL").ok().and_then(|v| v.parse().ok()).unwrap_or(1);
                Self::respond(
                    id,
                    &json!({
                        "protocolVersion": protocol,
                        "agentInfo": { "name": "scripted", "version": "1.0.0" },
                        "agentCapabilities": {
                            "loadSession": std::env::var_os("YAAH_AGENT_NO_LOAD").is_none(),
                            "promptCapabilities": { "embeddedContext": true },
                            "mcpCapabilities": { "http": false, "sse": false },
                            "sessionCapabilities": { "additionalDirectories": {} }
                        },
                        "authMethods": [
                            { "id": "agent-login", "name": "Log in" },
                            { "id": "terminal-login", "name": "Log in in a terminal", "type": "terminal", "args": ["login"], "env": { "YAAH_LOGIN_GREETING": "hello" } },
                            { "id": "key", "name": "API key", "type": "env_var", "vars": [{ "name": "SCRIPTED_KEY" }] }
                        ]
                    }),
                );
            }
            "authenticate" => Self::respond(id, &json!({})),
            "session/new" => {
                self.sessions += 1;
                let sid = std::env::var("YAAH_AGENT_SESSION_ID").unwrap_or_else(|_| format!("s{}-{}", self.sessions, std::process::id()));
                Self::respond(id, &json!({ "sessionId": sid }));
            }
            "session/load" => {
                // Replay the history, as agents do; yaah already has it.
                let sid = params["sessionId"].as_str().unwrap_or_default();
                update(sid, &json!({ "sessionUpdate": "user_message_chunk", "content": { "type": "text", "text": "replayed question" } }));
                chunk(sid, "replayed history");
                Self::respond(id, &json!({}));
            }
            "session/prompt" => self.prompt(id, params),
            "session/cancel" => {}
            method if !id.is_null() && !method.is_empty() => {
                send(&json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "no such method" } }));
            }
            _ => {}
        }
    }

    fn prompt(&mut self, id: &Value, params: &Value) {
        let sid = params["sessionId"].as_str().unwrap_or_default().to_owned();
        let text = params["prompt"].as_array().and_then(|b| b.iter().rev().find_map(|b| b["text"].as_str())).unwrap_or_default().to_owned();
        let mut stop = "end_turn";
        match text.split_whitespace().next().unwrap_or_default() {
            "stream" => {
                update(&sid, &json!({ "sessionUpdate": "agent_thought_chunk", "content": { "type": "text", "text": "Thinking" } }));
                update(&sid, &json!({ "sessionUpdate": "agent_thought_chunk", "content": { "type": "text", "text": " hard" } }));
                for part in ["Hello ", "world"] {
                    update(&sid, &json!({ "sessionUpdate": "agent_message_chunk", "messageId": "m1", "content": { "type": "text", "text": part } }));
                }
                update(
                    &sid,
                    &json!({ "sessionUpdate": "tool_call", "toolCallId": "t1", "title": "Read notes.md", "kind": "read", "status": "pending" }),
                );
                update(
                    &sid,
                    &json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed", "title": null,
                            "content": [{ "type": "content", "content": { "type": "text", "text": "notes" } }], "locations": [{ "path": "/tmp/notes.md" }] }),
                );
                update(&sid, &json!({ "sessionUpdate": "plan", "entries": [{ "content": "read", "status": "in_progress" }] }));
                update(&sid, &json!({ "sessionUpdate": "plan", "entries": [{ "content": "read", "status": "completed" }] }));
                update(
                    &sid,
                    &json!({ "sessionUpdate": "available_commands_update", "availableCommands": [{ "name": "review", "description": "Review" }] }),
                );
                update(
                    &sid,
                    &json!({ "sessionUpdate": "agent_message_chunk", "messageId": "m2", "content": { "type": "resource_link", "name": "notes", "uri": "file:///tmp/notes.md" } }),
                );
                update(&sid, &json!({ "sessionUpdate": "current_mode_update", "currentModeId": "code" }));
            }
            "permissions" => {
                // Several at once, as agents do, then one more after the answers.
                update(&sid, &json!({ "sessionUpdate": "tool_call", "toolCallId": "ls", "title": "Run ls", "status": "pending" }));
                let mut ids: Vec<Value> = (0..3).map(|_| self.permission(&sid, &json!({ "toolCallId": "ls", "title": "Run ls" }))).collect();
                ids.push(self.permission(&sid, &json!({ "toolCallId": "rm", "title": "Run rm -rf build" })));
                let mut got = self.wait(&ids, false);
                // By tool call id only: the title comes from the tool call yaah already has.
                let later = self.permission(&sid, &json!({ "toolCallId": "ls" }));
                got.extend(self.wait(std::slice::from_ref(&later), false));
                ids.push(later);
                let outcomes: Vec<String> = ids.iter().map(|i| chosen(&got[&i.to_string()])).collect();
                chunk(&sid, &format!("outcomes: {}", outcomes.join(",")));
            }
            "ask-again" => {
                let ask = self.permission(&sid, &json!({ "toolCallId": "ls2", "title": "Run ls" }));
                let got = self.wait(std::slice::from_ref(&ask), false);
                chunk(&sid, &format!("outcomes: {}", chosen(&got[&ask.to_string()])));
            }
            "unnamed" => {
                let mut outcomes = vec![];
                for _ in 0..2 {
                    let ask = self.permission(&sid, &json!({}));
                    outcomes.push(chosen(&self.wait(std::slice::from_ref(&ask), false)[&ask.to_string()]));
                }
                chunk(&sid, &format!("outcomes: {}", outcomes.join(",")));
            }
            "notices" => {
                let notice = json!({ "sessionUpdate": "notice", "severity": "warning", "title": "MCP server \"github\" failed to start", "description": "exit 1" });
                update(&sid, &notice);
                update(
                    &sid,
                    &json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "**Linear needs sign-in:** open settings" },
                            "_meta": { "claudeCode": { "kind": "mcpServerStatus", "status": "failed", "server": "linear" } } }),
                );
                update(&sid, &notice);
                update(&sid, &json!({ "sessionUpdate": "notice", "title": "Indexing done" }));
                chunk(&sid, "ready");
            }
            "wait" => {
                chunk(&sid, "working");
                let ask = self.permission(&sid, &json!({ "toolCallId": "deploy", "title": "Deploy" }));
                let got = self.wait(std::slice::from_ref(&ask), true);
                chunk(&sid, &format!("outcomes: {}", chosen(&got[&ask.to_string()])));
                stop = "cancelled";
            }
            "crash" => {
                chunk(&sid, "bye");
                eprintln!("scripted agent: crashing on purpose");
                std::process::exit(3);
            }
            "garbage" => self.garbage(&sid),
            "auth" => {
                return send(&json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": "Authentication required" } }));
            }
            _ => chunk(&sid, &format!("echo: {text}")),
        }
        Self::respond(id, &json!({ "stopReason": stop }));
    }

    /// Everything a broken agent might print, then a request yaah doesn't serve and one for a chat it doesn't know.
    fn garbage(&mut self, sid: &str) {
        raw(b"not json\n\xff\xfe not utf-8\n[1,2,3]\n42\n{\"jsonrpc\":\"2.0\"}\n{\"jsonrpc\":\"2.0\",\"id\":999999,\"result\":{}}\n");
        raw(b"{\"jsonrpc\":\"2.0\",\"id\":\"str\",\"error\":{}}\n");
        // One message over the reader's limit is skipped whole.
        let mut huge = vec![b'x'; 64 << 20];
        huge.extend_from_slice(b"\n");
        raw(&huge);
        update("no-such-session", &json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "lost" } }));
        send(&json!({ "jsonrpc": "2.0", "method": "session/update", "params": { "sessionId": sid } }));
        send(&json!({ "jsonrpc": "2.0", "method": "session/update", "params": "nonsense" }));
        update(sid, &json!({ "sessionUpdate": "tool_call", "title": "no id" }));
        update(sid, &json!({ "sessionUpdate": "agent_message_chunk", "content": "a string, not a block" }));
        update(sid, &json!({ "sessionUpdate": 7 }));
        let fs = self.ask("fs/read_text_file", &json!({ "sessionId": sid, "path": "/etc/passwd" }));
        let lost = self.permission("no-such-session", &json!({ "title": "Run ls" }));
        self.ask("session/request_permission", &json!({ "sessionId": sid, "options": "not a list" }));
        let got = self.wait(&[fs.clone(), lost.clone()], false);
        chunk(sid, &format!("fs: {}; lost: {}", got[&fs.to_string()]["error"]["code"], chosen(&got[&lost.to_string()])));
    }
}
