//! A stand-in model provider for the conformance suite's provider mode
//! (`agent_conformance::run_provider_checks`): a local `tiny_http` server that
//! answers the way OpenRouter does, so an agent started on its translated route
//! (`agent_routes`) runs a real turn without a network or a real key.
//!
//! It speaks, under `/api/v1` (OpenRouter's layout):
//!
//! - `OpenAI` Chat Completions (`POST /chat/completions`, streamed or not);
//! - `OpenAI` Responses (`POST /responses`, streamed or not);
//! - Anthropic Messages (`POST /messages`, and `/messages/count_tokens`), which
//!   Claude Code reaches at `ANTHROPIC_BASE_URL=…/api`;
//! - OpenRouter's `GET /models` and `GET /key`.
//!
//! A turn is scripted: the first model call that offers tools gets one tool
//! call back (a tool from [`Stub::start`]'s plan when the agent offers it, else
//! a read-only one built from the tool's schema); once a tool result comes back
//! the answer is plain text. Every request is recorded ([`Seen`]): the model it
//! asked for, its `Authorization`, the attribution headers, the tools offered.

use serde_json::{Value, json};
use std::fmt::Write as _;
use std::io::Read;
use std::sync::{Arc, Mutex};

/// The key the stub's routes carry: never real, so a leak check can look for it.
pub const STUB_KEY: &str = "sk-or-v1-yaah-conformance-stub-0000";
/// The model id a provider-mode run binds to.
pub const STUB_MODEL: &str = "yaah/stub-model";
/// What the stub says once the tool ran.
pub const DONE_TEXT: &str = "done: the stub saw the tool result";
const MAX_BODY: u64 = 32 << 20;

/// One request the stub answered.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Seen {
    pub method: String,
    pub path: String,
    /// `chat`, `responses`, `messages`, `count_tokens`, `models`, `key`, or `other`.
    pub api: String,
    pub model: Option<String>,
    pub authorization: Option<String>,
    pub x_api_key: Option<String>,
    pub referer: Option<String>,
    pub title: Option<String>,
    pub stream: bool,
    /// The tools the request offered.
    pub tools: Vec<String>,
    /// The tool the stub called back, if it did.
    pub called: Option<String>,
    /// The request carried a tool result (so the stub answered with text).
    pub tool_result: bool,
}

/// A tool call to make when the agent offers a tool by that name.
#[derive(Debug, Clone)]
pub struct Plan {
    pub tool: String,
    pub args: Value,
}

impl Plan {
    pub fn new(tool: &str, args: Value) -> Self {
        Self { tool: tool.to_owned(), args }
    }
}

/// The running stub. Stops when dropped.
pub struct Stub {
    base: String,
    seen: Arc<Mutex<Vec<Seen>>>,
    server: Arc<tiny_http::Server>,
}

impl Stub {
    /// Start on a free port of 127.0.0.1. `plan` names the tools to call, in
    /// order of preference; `cwd` is the folder a schema-built call points at.
    pub fn start(plan: Vec<Plan>, cwd: &str) -> Result<Self, String> {
        let server = Arc::new(tiny_http::Server::http("127.0.0.1:0").map_err(|e| e.to_string())?);
        let addr = server.server_addr().to_ip().ok_or("the stub has no IP address")?;
        let base = format!("http://{addr}");
        let seen: Arc<Mutex<Vec<Seen>>> = Arc::default();
        let (srv, log, cwd) = (server.clone(), seen.clone(), cwd.to_owned());
        std::thread::spawn(move || {
            for req in srv.incoming_requests() {
                let (plan, log, cwd) = (plan.clone(), log.clone(), cwd.clone());
                // Agents send model calls side by side (titles, token counts): one thread each.
                std::thread::spawn(move || answer(req, &plan, &cwd, &log));
            }
        });
        Ok(Self { base, seen, server })
    }

    /// OpenRouter's OpenAI-compatible base, as `agent_routes::Endpoints::openrouter` takes it.
    pub fn openrouter_base(&self) -> String {
        format!("{}/api/v1", self.base)
    }

    pub fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    /// The model calls (not listings or token counts).
    pub fn model_calls(&self) -> Vec<Seen> {
        self.seen().into_iter().filter(|s| matches!(s.api.as_str(), "chat" | "responses" | "messages")).collect()
    }
}

impl Drop for Stub {
    fn drop(&mut self) {
        self.server.unblock();
    }
}

fn header(req: &tiny_http::Request, name: &'static str) -> Option<String> {
    req.headers().iter().find(|h| h.field.equiv(name)).map(|h| h.value.as_str().to_owned())
}

fn answer(mut req: tiny_http::Request, plan: &[Plan], cwd: &str, log: &Mutex<Vec<Seen>>) {
    let path = req.url().split('?').next().unwrap_or_default().to_owned();
    let mut seen = Seen {
        method: req.method().as_str().to_owned(),
        path: path.clone(),
        authorization: header(&req, "authorization"),
        x_api_key: header(&req, "x-api-key"),
        referer: header(&req, "http-referer"),
        title: header(&req, "x-openrouter-title").or_else(|| header(&req, "x-title")),
        ..Seen::default()
    };
    let mut raw = vec![];
    let _ = req.as_reader().take(MAX_BODY).read_to_end(&mut raw);
    let body: Value = serde_json::from_slice(&raw).unwrap_or(Value::Null);
    let api = match path.trim_end_matches('/') {
        p if p.ends_with("/chat/completions") => "chat",
        p if p.ends_with("/responses") => "responses",
        p if p.ends_with("/messages/count_tokens") => "count_tokens",
        p if p.ends_with("/messages") => "messages",
        p if p.ends_with("/models") => "models",
        p if p.ends_with("/key") || p.ends_with("/auth/key") => "key",
        _ => "other",
    };
    api.clone_into(&mut seen.api);
    seen.model = body["model"].as_str().map(str::to_owned);
    seen.stream = body["stream"].as_bool().unwrap_or(false);
    let (status, content_type, out) = match api {
        "models" => (200, "application/json", models().to_string()),
        "key" => (
            200,
            "application/json",
            json!({ "data": { "label": "yaah conformance stub", "limit": null, "limit_remaining": null, "usage": 0, "is_free_tier": false } })
                .to_string(),
        ),
        "count_tokens" => (200, "application/json", json!({ "input_tokens": 42 }).to_string()),
        "chat" | "responses" | "messages" => {
            let offered = tools(api, &body);
            seen.tools = offered.iter().map(|(n, _)| n.clone()).collect();
            seen.tool_result = has_tool_result(api, &body);
            let call = if seen.tool_result { None } else { pick(&offered, plan, cwd) };
            seen.called = call.as_ref().map(|(n, _)| n.clone());
            let model = seen.model.clone().unwrap_or_else(|| STUB_MODEL.to_owned());
            let reply = Reply { model: &model, call: call.as_ref().map(|(n, a)| (n.as_str(), a)) };
            match (api, seen.stream) {
                ("chat", true) => (200, "text/event-stream", reply.chat_stream()),
                ("chat", false) => (200, "application/json", reply.chat().to_string()),
                ("responses", true) => (200, "text/event-stream", reply.responses_stream()),
                ("responses", false) => (200, "application/json", reply.response().to_string()),
                (_, true) => (200, "text/event-stream", reply.messages_stream()),
                _ => (200, "application/json", reply.message().to_string()),
            }
        }
        _ => (404, "application/json", json!({ "error": { "message": format!("the stub doesn't serve {path}") } }).to_string()),
    };
    log.lock().unwrap().push(seen);
    let ct = tiny_http::Header::from_bytes("content-type", content_type).expect("a header");
    let _ = req.respond(tiny_http::Response::from_string(out).with_status_code(status).with_header(ct));
}

/// `GET /models`: OpenRouter's shape (also what Anthropic-style clients read: `data[].id`).
fn models() -> Value {
    json!({ "data": [{
        "id": STUB_MODEL, "name": "yaah stub", "created": 0, "context_length": 200_000,
        "architecture": { "input_modalities": ["text"], "output_modalities": ["text"] },
        "pricing": { "prompt": "0", "completion": "0" },
        "supported_parameters": ["tools", "tool_choice", "max_tokens", "temperature"],
        "top_provider": { "context_length": 200_000, "max_completion_tokens": 32_000 }
    }], "has_more": false })
}

/// (name, JSON schema) of each tool a request offers.
fn tools(api: &str, body: &Value) -> Vec<(String, Value)> {
    body["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| {
            let (name, schema) = match api {
                "chat" => (t["function"]["name"].as_str()?, &t["function"]["parameters"]),
                "messages" => (t["name"].as_str()?, &t["input_schema"]),
                _ => (
                    t["name"].as_str().or(t["function"]["name"].as_str())?,
                    if t["parameters"].is_null() { &t["function"]["parameters"] } else { &t["parameters"] },
                ),
            };
            Some((name.to_owned(), schema.clone()))
        })
        .collect()
}

fn has_tool_result(api: &str, body: &Value) -> bool {
    let list = |k: &str| body[k].as_array().cloned().unwrap_or_default();
    match api {
        "chat" => list("messages").iter().any(|m| m["role"] == "tool"),
        "messages" => list("messages").iter().any(|m| m["content"].as_array().is_some_and(|c| c.iter().any(|b| b["type"] == "tool_result"))),
        _ => list("input").iter().any(|i| i["type"] == "function_call_output"),
    }
}

/// The plan's first tool the agent offers; else a read-only-looking one with arguments from its schema.
fn pick(offered: &[(String, Value)], plan: &[Plan], cwd: &str) -> Option<(String, Value)> {
    if let Some(p) = plan.iter().find(|p| offered.iter().any(|(n, _)| *n == p.tool)) {
        return Some((p.tool.clone(), p.args.clone()));
    }
    let lower = |n: &str| n.to_ascii_lowercase();
    let readish = ["glob", "list", "ls", "read", "view", "tree"];
    let (name, schema) = offered.iter().find(|(n, _)| readish.iter().any(|r| lower(n).contains(r)))?;
    let mut args = serde_json::Map::new();
    for req in schema["required"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        let prop = &schema["properties"][req];
        let k = req.to_ascii_lowercase();
        let v = match prop["type"].as_str().unwrap_or("string") {
            "number" | "integer" => json!(1),
            "boolean" => json!(false),
            "array" => json!([]),
            "object" => json!({}),
            _ if k.contains("pattern") || k.contains("glob") => json!("*"),
            _ if k.contains("path") || k.contains("dir") || k.contains("file") => json!(cwd),
            _ => json!("."),
        };
        args.insert(req.to_owned(), v);
    }
    Some((name.clone(), Value::Object(args)))
}

/// One scripted answer: a tool call, or [`DONE_TEXT`].
struct Reply<'a> {
    model: &'a str,
    call: Option<(&'a str, &'a Value)>,
}

fn sse(events: &[(Option<&str>, Value)]) -> String {
    let mut out = String::new();
    for (event, data) in events {
        if let Some(e) = event {
            let _ = writeln!(out, "event: {e}");
        }
        let _ = write!(out, "data: {data}\n\n");
    }
    out
}

const USAGE_IN: u64 = 12;
const USAGE_OUT: u64 = 7;

#[allow(clippy::single_match_else, reason = "each answer is a tool call or text, side by side")]
impl Reply<'_> {
    fn args(&self) -> String {
        self.call.map(|(_, a)| a.to_string()).unwrap_or_default()
    }

    fn chat(&self) -> Value {
        let message = match self.call {
            Some((name, _)) => {
                json!({ "role": "assistant", "content": null, "tool_calls": [{ "id": "call_yaah_1", "type": "function", "function": { "name": name, "arguments": self.args() } }] })
            }
            None => json!({ "role": "assistant", "content": DONE_TEXT }),
        };
        json!({
            "id": "gen-yaah-1", "object": "chat.completion", "created": 0, "model": self.model,
            "choices": [{ "index": 0, "message": message, "finish_reason": if self.call.is_some() { "tool_calls" } else { "stop" } }],
            "usage": { "prompt_tokens": USAGE_IN, "completion_tokens": USAGE_OUT, "total_tokens": USAGE_IN + USAGE_OUT }
        })
    }

    fn chat_stream(&self) -> String {
        let chunk = |delta: Value, finish: Value| {
            json!({ "id": "gen-yaah-1", "object": "chat.completion.chunk", "created": 0, "model": self.model,
                    "choices": [{ "index": 0, "delta": delta, "finish_reason": finish }] })
        };
        let mut events = vec![(None, chunk(json!({ "role": "assistant", "content": "" }), Value::Null))];
        match self.call {
            Some((name, _)) => {
                events.push((
                    None,
                    chunk(json!({ "tool_calls": [{ "index": 0, "id": "call_yaah_1", "type": "function", "function": { "name": name, "arguments": "" } }] }), Value::Null),
                ));
                events.push((None, chunk(json!({ "tool_calls": [{ "index": 0, "function": { "arguments": self.args() } }] }), Value::Null)));
                events.push((None, chunk(json!({}), json!("tool_calls"))));
            }
            None => {
                let (a, b) = DONE_TEXT.split_at(5);
                events.push((None, chunk(json!({ "content": a }), Value::Null)));
                events.push((None, chunk(json!({ "content": b }), Value::Null)));
                events.push((None, chunk(json!({}), json!("stop"))));
            }
        }
        let mut usage = chunk(json!({}), Value::Null);
        usage["choices"] = json!([]);
        usage["usage"] = json!({ "prompt_tokens": USAGE_IN, "completion_tokens": USAGE_OUT, "total_tokens": USAGE_IN + USAGE_OUT });
        events.push((None, usage));
        let mut out = sse(&events);
        out.push_str("data: [DONE]\n\n");
        out
    }

    fn response_item(&self) -> Value {
        match self.call {
            Some((name, _)) => {
                json!({ "type": "function_call", "id": "fc_yaah_1", "call_id": "call_yaah_1", "name": name, "arguments": self.args(), "status": "completed" })
            }
            None => json!({ "type": "message", "id": "msg_yaah_1", "role": "assistant", "status": "completed",
                            "content": [{ "type": "output_text", "text": DONE_TEXT, "annotations": [] }] }),
        }
    }

    fn response(&self) -> Value {
        json!({
            "id": "resp_yaah_1", "object": "response", "created_at": 0, "status": "completed", "model": self.model,
            "output": [self.response_item()],
            "usage": { "input_tokens": USAGE_IN, "output_tokens": USAGE_OUT, "total_tokens": USAGE_IN + USAGE_OUT }
        })
    }

    fn responses_stream(&self) -> String {
        let mut created = self.response();
        created["status"] = json!("in_progress");
        created["output"] = json!([]);
        let mut events = vec![(Some("response.created"), json!({ "type": "response.created", "sequence_number": 0, "response": created }))];
        let mut n = 0;
        let mut ev = |events: &mut Vec<(Option<&'static str>, Value)>, kind: &'static str, mut v: Value| {
            n += 1;
            v["type"] = json!(kind);
            v["sequence_number"] = json!(n);
            events.push((Some(kind), v));
        };
        match self.call {
            Some((name, _)) => {
                let mut item = self.response_item();
                item["arguments"] = json!("");
                item["status"] = json!("in_progress");
                ev(&mut events, "response.output_item.added", json!({ "output_index": 0, "item": item }));
                ev(&mut events, "response.function_call_arguments.delta", json!({ "item_id": "fc_yaah_1", "output_index": 0, "delta": self.args() }));
                ev(
                    &mut events,
                    "response.function_call_arguments.done",
                    json!({ "item_id": "fc_yaah_1", "output_index": 0, "name": name, "arguments": self.args() }),
                );
            }
            None => {
                let item = json!({ "type": "message", "id": "msg_yaah_1", "role": "assistant", "status": "in_progress", "content": [] });
                ev(&mut events, "response.output_item.added", json!({ "output_index": 0, "item": item }));
                let part = json!({ "type": "output_text", "text": "", "annotations": [] });
                ev(
                    &mut events,
                    "response.content_part.added",
                    json!({ "item_id": "msg_yaah_1", "output_index": 0, "content_index": 0, "part": part }),
                );
                for d in [&DONE_TEXT[..5], &DONE_TEXT[5..]] {
                    ev(
                        &mut events,
                        "response.output_text.delta",
                        json!({ "item_id": "msg_yaah_1", "output_index": 0, "content_index": 0, "delta": d }),
                    );
                }
                ev(
                    &mut events,
                    "response.output_text.done",
                    json!({ "item_id": "msg_yaah_1", "output_index": 0, "content_index": 0, "text": DONE_TEXT }),
                );
                let done = json!({ "type": "output_text", "text": DONE_TEXT, "annotations": [] });
                ev(
                    &mut events,
                    "response.content_part.done",
                    json!({ "item_id": "msg_yaah_1", "output_index": 0, "content_index": 0, "part": done }),
                );
            }
        }
        ev(&mut events, "response.output_item.done", json!({ "output_index": 0, "item": self.response_item() }));
        ev(&mut events, "response.completed", json!({ "response": self.response() }));
        sse(&events)
    }

    fn message(&self) -> Value {
        let content = match self.call {
            Some((name, args)) => json!([{ "type": "tool_use", "id": "toolu_yaah_1", "name": name, "input": args }]),
            None => json!([{ "type": "text", "text": DONE_TEXT }]),
        };
        json!({
            "id": "msg_yaah_1", "type": "message", "role": "assistant", "model": self.model, "content": content,
            "stop_reason": if self.call.is_some() { "tool_use" } else { "end_turn" }, "stop_sequence": null,
            "usage": { "input_tokens": USAGE_IN, "output_tokens": USAGE_OUT }
        })
    }

    fn messages_stream(&self) -> String {
        let mut start = self.message();
        start["content"] = json!([]);
        start["stop_reason"] = Value::Null;
        start["usage"] = json!({ "input_tokens": USAGE_IN, "output_tokens": 1 });
        let mut events = vec![(Some("message_start"), json!({ "type": "message_start", "message": start }))];
        match self.call {
            Some((name, _)) => {
                events.push((
                    Some("content_block_start"),
                    json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "tool_use", "id": "toolu_yaah_1", "name": name, "input": {} } }),
                ));
                events.push((
                    Some("content_block_delta"),
                    json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "input_json_delta", "partial_json": self.args() } }),
                ));
            }
            None => {
                events.push((
                    Some("content_block_start"),
                    json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } }),
                ));
                for d in [&DONE_TEXT[..5], &DONE_TEXT[5..]] {
                    events.push((
                        Some("content_block_delta"),
                        json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": d } }),
                    ));
                }
            }
        }
        events.push((Some("content_block_stop"), json!({ "type": "content_block_stop", "index": 0 })));
        let stop = if self.call.is_some() { "tool_use" } else { "end_turn" };
        events.push((
            Some("message_delta"),
            json!({ "type": "message_delta", "delta": { "stop_reason": stop, "stop_sequence": null }, "usage": { "output_tokens": USAGE_OUT } }),
        ));
        events.push((Some("message_stop"), json!({ "type": "message_stop" })));
        sse(&events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn post(url: &str, body: Value) -> (u16, String) {
        let resp = crate::integrations::http()
            .post(url)
            .bearer_auth(STUB_KEY)
            .header("HTTP-Referer", "https://filipecabaco.github.io/yaah/")
            .header("X-OpenRouter-Title", "yaah")
            .json(&body)
            .send()
            .await
            .unwrap();
        (resp.status().as_u16(), resp.text().await.unwrap())
    }

    /// The `data:` payloads of an SSE body.
    fn data(sse: &str) -> Vec<Value> {
        sse.lines().filter_map(|l| l.strip_prefix("data: ")).filter(|d| *d != "[DONE]").map(|d| serde_json::from_str(d).unwrap()).collect()
    }

    #[tokio::test]
    async fn each_api_gets_a_tool_call_then_text() {
        let stub = Stub::start(vec![Plan::new("Glob", json!({ "pattern": "*" }))], "/work").unwrap();
        let base = stub.openrouter_base();

        // Chat, streamed: a tool from the schema (the plan's isn't offered), then text once a tool result is in.
        let tools = json!([{ "type": "function", "function": { "name": "read_file", "parameters": { "type": "object", "required": ["path"], "properties": { "path": { "type": "string" } } } } }]);
        let (status, body) = post(
            &format!("{base}/chat/completions"),
            json!({ "model": STUB_MODEL, "stream": true, "tools": tools, "messages": [{ "role": "user", "content": "hi" }] }),
        )
        .await;
        assert_eq!(status, 200);
        assert!(body.ends_with("data: [DONE]\n\n"));
        let chunks = data(&body);
        let call = &chunks[1]["choices"][0]["delta"]["tool_calls"][0];
        assert_eq!(call["function"]["name"], "read_file");
        assert_eq!(chunks[2]["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"], r#"{"path":"/work"}"#);
        let (_, body) = post(
            &format!("{base}/chat/completions"),
            json!({ "model": STUB_MODEL, "tools": tools, "messages": [{ "role": "tool", "tool_call_id": "call_yaah_1", "content": "a.txt" }] }),
        )
        .await;
        let reply: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(reply["choices"][0]["message"]["content"], DONE_TEXT);

        // Anthropic Messages at …/api/v1/messages, streamed: the plan's tool.
        let tools = json!([{ "name": "Glob", "input_schema": { "type": "object" } }, { "name": "Bash", "input_schema": { "type": "object" } }]);
        let (_, body) = post(
            &format!("{base}/messages"),
            json!({ "model": STUB_MODEL, "stream": true, "tools": tools, "messages": [{ "role": "user", "content": "hi" }] }),
        )
        .await;
        let events = data(&body);
        assert_eq!(events[1]["content_block"]["name"], "Glob");
        assert_eq!(events[2]["delta"]["partial_json"], r#"{"pattern":"*"}"#);
        assert_eq!(events[4]["delta"]["stop_reason"], "tool_use");

        // Responses, streamed, after the tool: text.
        let input = json!([{ "type": "function_call_output", "call_id": "call_yaah_1", "output": "a.txt" }]);
        let (_, body) = post(
            &format!("{base}/responses"),
            json!({ "model": STUB_MODEL, "stream": true, "input": input, "tools": [{ "type": "function", "name": "glob" }] }),
        )
        .await;
        let events = data(&body);
        assert_eq!(events.last().unwrap()["response"]["output"][0]["content"][0]["text"], DONE_TEXT);

        // Listings.
        let models: Value = crate::integrations::http().get(format!("{base}/models")).send().await.unwrap().json().await.unwrap();
        assert_eq!(models["data"][0]["id"], STUB_MODEL);
        let key: Value = crate::integrations::http().get(format!("{base}/key")).send().await.unwrap().json().await.unwrap();
        assert!(key["data"]["label"].is_string());

        let seen = stub.model_calls();
        assert_eq!(seen.len(), 4);
        assert!(seen.iter().all(|s| s.model.as_deref() == Some(STUB_MODEL) && s.authorization.as_deref() == Some(&format!("Bearer {STUB_KEY}")[..])));
        assert_eq!(seen.iter().map(|s| s.called.as_deref()).collect::<Vec<_>>(), [Some("read_file"), None, Some("Glob"), None]);
        assert_eq!(seen[0].title.as_deref(), Some("yaah"));
        assert_eq!(stub.seen().len(), 6);
    }
}
