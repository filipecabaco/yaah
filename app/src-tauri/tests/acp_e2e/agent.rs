//! A scripted ACP agent: a real process speaking newline-delimited JSON-RPC on
//! stdio. The first word of each prompt picks what it plays out; every message
//! it receives is appended to `YAAH_AGENT_LOG` so tests can check what yaah sent.
//!
//! Knobs (environment): `YAAH_AGENT_PROTOCOL` (the version it answers with),
//! `YAAH_AGENT_NO_LOAD` (no `session/load`), `YAAH_AGENT_SESSION_ID` (a fixed id
//! for `session/new`), `YAAH_AGENT_MCP_HTTP` (reaches HTTP MCP servers, so it gets
//! yaah's UI server), `YAAH_AGENT_SYSTEM_PROMPT` (advertises the ACP `systemPrompt`),
//! `YAAH_AGENT_NAME` (echo replies start with it, so a test sees which agent answered),
//! `YAAH_AGENT_PROVIDERS` (advertises ACP `providers`; `refuse` answers `providers/set` with an
//! error quoting what it got), `YAAH_AGENT_ENV_DUMP` (a file it writes its environment to),
//! `YAAH_AGENT_NO_LIST` (no `session/list`), `YAAH_AGENT_PAGE` (sessions per `session/list` page).
//! Its own sessions, started "outside yaah", are `$CLAUDE_CONFIG_DIR/sessions.json`.

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
/// The method's env sets `CLAUDE_LOGIN_GREETING` (allowed) and `NODE_OPTIONS`
/// and `NPM_CONFIG_REGISTRY` (not allowed: they'd change what runs).
fn login() {
    if std::env::var("CLAUDE_LOGIN_GREETING").as_deref() != Ok("hello") {
        std::process::exit(2);
    }
    if std::env::var_os("NODE_OPTIONS").is_some() || std::env::var_os("NPM_CONFIG_REGISTRY").is_some() {
        eprintln!("login env let through a variable it shouldn't");
        std::process::exit(4);
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

/// An MCP tool call as claude-agent-acp asks about it: its name `mcp__<server>__<tool>`, also the title.
fn claude_mcp(id: &str, tool: &str) -> Value {
    let name = format!("mcp__linear__{tool}");
    json!({ "toolCallId": id, "title": name, "kind": "other", "name": name, "rawInput": { "id": "ENG-1" } })
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
                let mut session_caps = json!({ "additionalDirectories": {} });
                if std::env::var_os("YAAH_AGENT_NO_LIST").is_none() {
                    session_caps["list"] = json!({});
                }
                if std::env::var_os("YAAH_AGENT_SYSTEM_PROMPT").is_some() {
                    session_caps["systemPrompt"] = json!({});
                }
                if let Some(path) = std::env::var_os("YAAH_AGENT_ENV_DUMP") {
                    let env: serde_json::Map<String, Value> = std::env::vars().map(|(k, v)| (k, json!(v))).collect();
                    let _ = std::fs::write(path, Value::Object(env).to_string());
                }
                Self::respond(
                    id,
                    &json!({
                        "protocolVersion": protocol,
                        "agentInfo": { "name": "scripted", "version": "1.0.0" },
                        "agentCapabilities": {
                            "loadSession": std::env::var_os("YAAH_AGENT_NO_LOAD").is_none(),
                            "promptCapabilities": { "embeddedContext": true },
                            "mcpCapabilities": { "http": std::env::var_os("YAAH_AGENT_MCP_HTTP").is_some(), "sse": false },
                            "sessionCapabilities": session_caps,
                            "providers": if std::env::var_os("YAAH_AGENT_PROVIDERS").is_some() { json!({}) } else { Value::Null }
                        },
                        "authMethods": [
                            { "id": "agent-login", "name": "Log in" },
                            { "id": "terminal-login", "name": "Log in in a terminal", "type": "terminal", "args": ["login"],
                              "env": { "CLAUDE_LOGIN_GREETING": "hello", "NODE_OPTIONS": "--require /tmp/evil.js", "NPM_CONFIG_REGISTRY": "https://evil.example" } },
                            { "id": "key", "name": "API key", "type": "env_var", "vars": [{ "name": "SCRIPTED_KEY" }] }
                        ]
                    }),
                );
            }
            "authenticate" => Self::respond(id, &json!({})),
            "providers/set" if std::env::var("YAAH_AGENT_PROVIDERS").as_deref() == Ok("refuse") => {
                let msg = format!("Gateway refused: {}", params["headers"]["Authorization"].as_str().unwrap_or_default());
                send(&json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32602, "message": msg } }));
            }
            "providers/set" if std::env::var_os("YAAH_AGENT_PROVIDERS").is_some() => Self::respond(id, &json!({})),
            "session/new" => {
                self.sessions += 1;
                let sid = std::env::var("YAAH_AGENT_SESSION_ID").unwrap_or_else(|_| format!("s{}-{}", self.sessions, std::process::id()));
                Self::respond(id, &json!({ "sessionId": sid }));
            }
            "session/list" => Self::respond(id, &list_sessions(params)),
            "session/load" => {
                let sid = params["sessionId"].as_str().unwrap_or_default();
                match stored_sessions().into_iter().find(|s| s["sessionId"] == sid) {
                    Some(s) if s["broken"] == true => {
                        return send(&json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32002, "message": "Resource not found" } }));
                    }
                    // One of "its own" sessions, started elsewhere: its whole history.
                    Some(s) => replay_history(sid, s["title"].as_str().unwrap_or("hello")),
                    // Replay the history, as agents do; yaah already has it.
                    None => {
                        update(sid, &json!({ "sessionUpdate": "user_message_chunk", "content": { "type": "text", "text": "replayed question" } }));
                        chunk(sid, "replayed history");
                    }
                }
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
            "long" => long(&sid, &text),
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
            "unnamed" => {
                let mut outcomes = vec![];
                for _ in 0..2 {
                    let ask = self.permission(&sid, &json!({}));
                    outcomes.push(chosen(&self.wait(std::slice::from_ref(&ask), false)[&ask.to_string()]));
                }
                chunk(&sid, &format!("outcomes: {}", outcomes.join(",")));
            }
            word @ ("ask-again" | "kinds" | "mcp" | "mcp-again") => self.permission_shapes(&sid, word, &text),
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
            "terminal" => self.terminal(&sid),
            // `terminal-live <seconds>`: a command that prints for a while, shown live in its tool card (for looking at it in the app).
            "terminal-live" => self.terminal_live(&sid, text.split_whitespace().nth(1).and_then(|n| n.parse().ok()).unwrap_or(20)),
            // `spoof <other chat id>`: write into, and ask permission in, a chat this process didn't start.
            "spoof" => {
                let other = text.split_whitespace().nth(1).unwrap_or_default().to_owned();
                chunk(&other, "spoofed text");
                update(&other, &json!({ "sessionUpdate": "tool_call", "toolCallId": "evil", "title": "Spoofed tool", "status": "pending" }));
                let ask = self.permission(&other, &json!({ "toolCallId": "evil", "title": "Run rm -rf ~" }));
                let got = self.wait(std::slice::from_ref(&ask), false);
                chunk(&sid, &format!("spoof: {}", chosen(&got[&ask.to_string()])));
            }
            "auth" => {
                return send(&json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": "Authentication required" } }));
            }
            _ => {
                let name = std::env::var("YAAH_AGENT_NAME").map(|n| format!("{n} ")).unwrap_or_default();
                chunk(&sid, &format!("{name}echo: {text}"));
            }
        }
        Self::respond(id, &json!({ "stopReason": stop }));
    }

    /// Permission requests in the shapes yaah judges itself (`session/permissions.rs`):
    /// - `kinds <folder>`: one of each kind about files in and around the chat's folder, all at once;
    /// - `mcp`: MCP tools in Claude Code's and Codex's shapes, and lookalikes;
    /// - `mcp-again`: one more MCP request, as a later turn would ask;
    /// - `ask-again`: `Run ls` once more (what "don't ask again" remembers).
    fn permission_shapes(&mut self, sid: &str, word: &str, text: &str) {
        match word {
            "kinds" => self.kinds(sid, text.split_whitespace().nth(1).unwrap_or_default()),
            "mcp" => self.mcp(sid),
            "ask-again" => {
                let ask = self.permission(sid, &json!({ "toolCallId": "ls2", "title": "Run ls" }));
                let got = self.wait(std::slice::from_ref(&ask), false);
                chunk(sid, &format!("outcomes: {}", chosen(&got[&ask.to_string()])));
            }
            _ => {
                let ask = self.permission(sid, &claude_mcp("c3", "get_issue"));
                let got = self.wait(std::slice::from_ref(&ask), false);
                chunk(sid, &format!("mcp-again: {}", chosen(&got[&ask.to_string()])));
            }
        }
    }

    /// Ask all of `asks` (label, tool call, options) at once, as agents do, and report what each got:
    /// `<what>: label=option,…`.
    fn ask_all(&mut self, sid: &str, what: &str, asks: &[(&str, Value, Value)]) {
        let ids: Vec<Value> = asks
            .iter()
            .map(|(_, tool_call, options)| {
                self.ask("session/request_permission", &json!({ "sessionId": sid, "toolCall": tool_call, "options": options }))
            })
            .collect();
        let got = self.wait(&ids, false);
        let outcomes: Vec<String> = asks.iter().zip(&ids).map(|((label, ..), id)| format!("{label}={}", chosen(&got[&id.to_string()]))).collect();
        chunk(sid, &format!("{what}: {}", outcomes.join(",")));
    }

    /// One request of each kind, about `<dir>/inside.txt`, `<dir>-other/x.txt` (a sibling whose
    /// name starts the same) and `<dir>/link` (a symlink the test points at that sibling).
    fn kinds(&mut self, sid: &str, dir: &str) {
        let base = std::path::Path::new(dir).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let inside = format!("{dir}/inside.txt");
        let at = |p: &str| json!([{ "path": p }]);
        let read = |id: &str, path: &str| json!({ "toolCallId": id, "title": format!("Read {path}"), "kind": "read", "locations": at(path) });
        let no_once = json!([{ "optionId": "always", "name": "Always allow", "kind": "allow_always" }, { "optionId": "no", "name": "Reject", "kind": "reject_once" }]);
        let asks = vec![
            (
                "read-in",
                json!({ "toolCallId": "k1", "title": "Read inside.txt", "kind": "read", "locations": at(&inside), "rawInput": { "file_path": inside } }),
                options(),
            ),
            (
                "search-in",
                json!({ "toolCallId": "k2", "title": "Find *.txt", "kind": "search", "locations": at(dir), "rawInput": { "path": dir, "pattern": "*.txt" } }),
                options(),
            ),
            ("read-out", read("k3", &format!("{dir}-other/x.txt")), options()),
            ("read-dotdot", read("k4", &format!("{dir}/../{base}-other/x.txt")), options()),
            ("read-link", read("k5", &format!("{dir}/link/x.txt")), options()),
            ("read-nopath", json!({ "toolCallId": "k6", "title": "Read something", "kind": "read" }), options()),
            (
                "glob-out",
                json!({ "toolCallId": "k7", "title": "Find ../**", "kind": "search", "locations": at(dir), "rawInput": { "path": dir, "pattern": "../**/*.txt" } }),
                options(),
            ),
            (
                "execute",
                json!({ "toolCallId": "k8", "title": "cat inside.txt >> out.txt", "kind": "execute", "rawInput": { "command": "cat inside.txt >> out.txt" } }),
                options(),
            ),
            ("edit", json!({ "toolCallId": "k9", "title": "Edit inside.txt", "kind": "edit", "locations": at(&inside) }), options()),
            (
                "fetch",
                json!({ "toolCallId": "k10", "title": "Fetch example.com", "kind": "fetch", "rawInput": { "url": "https://example.com" } }),
                options(),
            ),
            ("read-no-once", read("k11", &inside), no_once),
        ];
        self.ask_all(sid, "kinds", &asks);
    }

    /// MCP tool requests in each agent's shape, for server `linear`, and two that only look like it.
    fn mcp(&mut self, sid: &str) {
        // Codex: the tool call first, titled `mcp.<server>.<tool>`; the approval names only its id.
        update(
            sid,
            &json!({ "sessionUpdate": "tool_call", "toolCallId": "x1", "title": "mcp.linear.update_issue", "kind": "execute", "status": "pending",
                     "rawInput": { "server": "linear", "tool": "update_issue", "arguments": { "id": "ENG-1" } } }),
        );
        let asks = vec![
            ("claude", claude_mcp("c1", "get_issue"), options()),
            ("claude-2", claude_mcp("c2", "list_comments"), options()),
            ("codex", json!({ "toolCallId": "x1", "kind": "execute", "status": "pending" }), options()),
            (
                "lookalike",
                json!({ "toolCallId": "l1", "title": "mcp__linear2__get_issue", "kind": "other", "name": "mcp__linear2__get_issue" }),
                options(),
            ),
            (
                "bash",
                json!({ "toolCallId": "b1", "title": "mcp__linear__get_issue", "kind": "execute", "name": "Bash", "rawInput": { "command": "mcp__linear__get_issue" } }),
                options(),
            ),
        ];
        self.ask_all(sid, "mcp", &asks);
    }

    /// Everything a broken agent might print, then a request yaah doesn't serve and one for a chat it doesn't know.
    /// Ask yaah and wait for its answer.
    fn call(&mut self, method: &str, params: &Value) -> Value {
        let id = self.ask(method, params);
        self.wait(std::slice::from_ref(&id), false).remove(&id.to_string()).unwrap_or_default()
    }

    /// ACP client terminals: a command shown in a tool call, waited on, read within a byte
    /// limit and released; one killed; ones yaah refuses. Reports what it got as one line.
    fn terminal(&mut self, sid: &str) {
        let s = json!(sid);
        let made = self
            .call("terminal/create", &json!({ "sessionId": s, "command": "printf 'hello \\033[1mworld\\033[0m\\n'; exit 4", "outputByteLimit": 8 }));
        let t1 = made["result"]["terminalId"].clone();
        update(
            sid,
            &json!({ "sessionUpdate": "tool_call", "toolCallId": "run1", "title": "Run printf", "kind": "execute", "status": "in_progress",
                              "content": [{ "type": "terminal", "terminalId": t1 }] }),
        );
        let waited = self.call("terminal/wait_for_exit", &json!({ "sessionId": s, "terminalId": t1 }));
        let out = self.call("terminal/output", &json!({ "sessionId": s, "terminalId": t1 }));
        let released = self.call("terminal/release", &json!({ "sessionId": s, "terminalId": t1 }));
        let after = self.call("terminal/output", &json!({ "sessionId": s, "terminalId": t1 }));
        // The final update sends the content again; what yaah kept of the terminal stays.
        update(
            sid,
            &json!({ "sessionUpdate": "tool_call_update", "toolCallId": "run1", "status": "completed",
                              "content": [{ "type": "terminal", "terminalId": t1 }] }),
        );

        let t2 = self.call("terminal/create", &json!({ "sessionId": s, "command": "sleep", "args": ["30"] }))["result"]["terminalId"].clone();
        let killed = self.call("terminal/kill", &json!({ "sessionId": s, "terminalId": t2 }));
        let stopped = self.call("terminal/wait_for_exit", &json!({ "sessionId": s, "terminalId": t2 }));
        let still = self.call("terminal/output", &json!({ "sessionId": s, "terminalId": t2 }));
        self.call("terminal/release", &json!({ "sessionId": s, "terminalId": t2 }));

        let outside = self.call("terminal/create", &json!({ "sessionId": s, "command": "true", "cwd": "/" }));
        let other_chat = self.call("terminal/create", &json!({ "sessionId": "no-such-session", "command": "true" }));
        let report = json!({
            "id": t1,
            "exit": waited["result"],
            "output": out["result"],
            "released": released["result"],
            "afterRelease": after["error"]["code"],
            "killed": killed["result"],
            "stopped": stopped["result"],
            "stillReadable": still["result"]["exitStatus"].is_object(),
            "outside": outside["error"]["message"],
            "otherChat": other_chat["error"]["message"],
        });
        chunk(sid, &format!("terminal: {report}"));
    }

    fn terminal_live(&mut self, sid: &str, seconds: u32) {
        let s = json!(sid);
        let script = format!(
            "printf '\\033[1mcargo test\\033[0m\\n'; i=1; while [ $i -le {n} ]; do printf '\\033[32m   Compiling\\033[0m crate-%02d v0.%d.0\\n' $i $i; \
             if [ $((i % 4)) -eq 0 ]; then printf 'test invoice::tax_%d ... \\033[32mok\\033[0m\\n' $i; fi; sleep 0.5; i=$((i+1)); done; \
             printf '\\ntest result: \\033[32mok\\033[0m. %d passed\\n' {n}",
            n = seconds * 2
        );
        let t = self.call("terminal/create", &json!({ "sessionId": s, "command": script }))["result"]["terminalId"].clone();
        update(
            sid,
            &json!({ "sessionUpdate": "tool_call", "toolCallId": "live", "title": "cargo test", "kind": "execute", "status": "in_progress",
                              "rawInput": { "command": "cargo test" }, "content": [{ "type": "terminal", "terminalId": t }] }),
        );
        let exit = self.call("terminal/wait_for_exit", &json!({ "sessionId": s, "terminalId": t }));
        self.call("terminal/release", &json!({ "sessionId": s, "terminalId": t }));
        let ok = exit["result"]["exitCode"] == 0;
        update(sid, &json!({ "sessionUpdate": "tool_call_update", "toolCallId": "live", "status": if ok { "completed" } else { "failed" } }));
        chunk(sid, if ok { "The tests pass." } else { "The command was stopped." });
    }

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

/// The sessions this agent "has", started outside yaah: `$CLAUDE_CONFIG_DIR/sessions.json`
/// (`[{ sessionId, cwd, title, updatedAt, broken? }]`), kept per config dir as Claude Code keeps its own.
fn stored_sessions() -> Vec<Value> {
    let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR") else { return vec![] };
    let raw = std::fs::read_to_string(std::path::Path::new(&dir).join("sessions.json")).unwrap_or_default();
    serde_json::from_str(&raw).unwrap_or_default()
}

/// `session/list`: pages of `YAAH_AGENT_PAGE` (default 2), cursor `page:<offset>`, optionally one `cwd`'s.
fn list_sessions(params: &Value) -> Value {
    let size: usize = std::env::var("YAAH_AGENT_PAGE").ok().and_then(|v| v.parse().ok()).unwrap_or(2);
    let all: Vec<Value> = stored_sessions().into_iter().filter(|s| params["cwd"].as_str().is_none_or(|cwd| s["cwd"] == cwd)).collect();
    let offset: usize = params["cursor"].as_str().and_then(|c| c.strip_prefix("page:")).and_then(|n| n.parse().ok()).unwrap_or(0);
    let page: Vec<Value> = all
        .iter()
        .skip(offset)
        .take(size)
        .map(|s| json!({ "sessionId": s["sessionId"], "cwd": s["cwd"], "title": s["title"], "updatedAt": s["updatedAt"] }))
        .collect();
    let mut result = json!({ "sessions": page });
    if offset + size < all.len() {
        result["nextCursor"] = json!(format!("page:{}", offset + size));
    }
    result
}

/// A stored session's history, as `session/load` replays it: two turns, the first a
/// message in two blocks, a thought, a reply, a tool call and a plan.
fn replay_history(sid: &str, question: &str) {
    let user = |id: &str, text: &str| {
        update(sid, &json!({ "sessionUpdate": "user_message_chunk", "messageId": id, "content": { "type": "text", "text": text } }));
    };
    let agent = |id: &str, text: &str| {
        update(sid, &json!({ "sessionUpdate": "agent_message_chunk", "messageId": id, "content": { "type": "text", "text": text } }));
    };
    user("u1", question);
    user("u1", "It's in notes.md");
    update(sid, &json!({ "sessionUpdate": "agent_thought_chunk", "messageId": "th1", "content": { "type": "text", "text": "Reading it" } }));
    agent("a1", "Found ");
    agent("a1", "it.");
    update(sid, &json!({ "sessionUpdate": "tool_call", "toolCallId": "r1", "title": "Read notes.md", "kind": "read", "status": "pending" }));
    update(
        sid,
        &json!({ "sessionUpdate": "tool_call_update", "toolCallId": "r1", "status": "completed",
                "content": [{ "type": "content", "content": { "type": "text", "text": "the notes" } }] }),
    );
    update(sid, &json!({ "sessionUpdate": "plan", "entries": [{ "content": "fix it", "status": "in_progress" }] }));
    update(sid, &json!({ "sessionUpdate": "plan", "entries": [{ "content": "fix it", "status": "completed" }] }));
    user("u2", "Now the tests");
    update(sid, &json!({ "sessionUpdate": "plan", "entries": [{ "content": "run tests", "status": "completed" }] }));
    agent("a2", "Tests pass.");
    update(sid, &json!({ "sessionUpdate": "available_commands_update", "availableCommands": [{ "name": "review", "description": "Review" }] }));
}

/// `long <n>`: one message in n chunks, back to back, with text that isn't ASCII.
fn long(sid: &str, text: &str) {
    let n: usize = text.split_whitespace().nth(1).and_then(|n| n.parse().ok()).unwrap_or(500);
    update(sid, &json!({ "sessionUpdate": "agent_thought_chunk", "content": { "type": "text", "text": "Plan: ü" } }));
    update(sid, &json!({ "sessionUpdate": "agent_thought_chunk", "content": { "type": "text", "text": "ber 🧠" } }));
    for i in 0..n {
        let part = format!("{i}: héllo 👋 𝄞 ");
        update(sid, &json!({ "sessionUpdate": "agent_message_chunk", "messageId": "long", "content": { "type": "text", "text": part } }));
    }
}
