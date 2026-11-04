//! Minimal ACP (Agent Client Protocol) v1 client over stdio.
//!
//! ACP is JSON-RPC 2.0 framed as newline-delimited JSON on the agent's
//! stdin/stdout. This module only does transport: spawning the agent,
//! correlating request ids, and handing agent-initiated messages to a
//! callback. Session semantics live in `session.rs`.
//!
//! Everything the agent writes is untrusted: lines are bounded, anything that
//! isn't a JSON-RPC message is skipped, and nothing it sends can panic the reader.

use serde_json::{Map, Value, json};
use std::collections::{HashMap, VecDeque};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Notify, mpsc, oneshot};

pub const PROTOCOL_VERSION: u64 = 1;

/// JSON-RPC error code ACP uses for "authentication required".
pub const AUTH_REQUIRED: i64 = -32000;
/// The agent doesn't know the resource asked for: for `session/load`, a session it no longer has
/// (claude-agent-acp: a session stored under another profile's config dir, or deleted).
pub const RESOURCE_NOT_FOUND: i64 = -32002;
const METHOD_NOT_FOUND: i64 = -32601;
const STDERR_TAIL_LINES: usize = 40;
/// The longest message read from an agent's stdout; longer ones are skipped.
pub const MAX_MESSAGE: usize = 64 << 20;
/// Stderr lines are cut to this (they only feed logs and error messages).
const MAX_STDERR_LINE: usize = 16 << 10;

#[derive(Debug, Clone)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} (code {})", self.message, self.code)
    }
}

/// A message the agent sent us that is not a response to one of our requests.
pub enum Incoming {
    Notification { method: String, params: Value },
    Request { id: Value, method: String, params: Value },
}

/// Handle for answering agent-initiated requests. Answers go to the process
/// that asked; once it has exited they go nowhere.
#[derive(Clone)]
pub struct Responder(mpsc::UnboundedSender<String>);

impl Responder {
    /// A responder whose answers land in the returned channel, as the lines the agent would read.
    #[cfg(test)]
    pub fn for_test() -> (Self, mpsc::UnboundedReceiver<String>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Self(tx), rx)
    }

    /// Returns false if the agent has exited.
    pub fn ok(&self, id: Value, result: Value) -> bool {
        self.send(&message([("id", id), ("result", result)]))
    }

    pub fn err(&self, id: Value, code: i64, text: &str) -> bool {
        self.send(&message([("id", id), ("error", json!({ "code": code, "message": text }))]))
    }

    pub fn method_not_found(&self, id: Value, method: &str) -> bool {
        self.err(id, METHOD_NOT_FOUND, &format!("client does not support {method}"))
    }

    fn send(&self, msg: &Value) -> bool {
        self.0.send(msg.to_string()).is_ok()
    }
}

type PendingMap = HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>;
type StderrTail = Arc<Mutex<VecDeque<String>>>;

pub struct Connection {
    next_id: AtomicU64,
    alive: Arc<AtomicBool>,
    pending: Arc<Mutex<PendingMap>>,
    responder: Responder,
    stderr_tail: StderrTail,
    /// Tells the writer to close the agent's stdin ([`Connection::shutdown`]).
    close_stdin: Arc<Notify>,
    /// Held so the agent is killed when the connection is dropped; taken by [`Connection::shutdown`].
    child: Mutex<Option<Child>>,
}

impl Connection {
    /// Start `cmd` with piped stdio and start the reader/writer tasks.
    ///
    /// `on_incoming` runs on the reader task for every notification or
    /// request from the agent. `on_exit` runs once when the agent's stdout
    /// closes, with the tail of its stderr.
    pub fn spawn<F, E>(mut cmd: Command, on_incoming: F, on_exit: E) -> Result<Arc<Self>, String>
    where
        F: Fn(Incoming, &Responder) + Send + Sync + 'static,
        E: FnOnce(String) + Send + 'static,
    {
        let program = cmd.as_std().get_program().to_string_lossy().into_owned();
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|e| format!("failed to start `{program}`: {e}"))?;
        let (Some(mut stdin), Some(stdout), Some(stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take()) else {
            return Err(format!("`{program}` started without piped stdio"));
        };

        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        let responder = Responder(tx);
        let pending: Arc<Mutex<PendingMap>> = Arc::default();
        let stderr_tail = StderrTail::default();
        let alive = Arc::new(AtomicBool::new(true));
        let close_stdin = Arc::new(Notify::new());

        // Writer: one JSON message per line, until the agent stops reading or we close its stdin.
        let closing = close_stdin.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let mut line = tokio::select! {
                    biased;
                    () = closing.notified() => break,
                    next = rx.recv() => match next {
                        Some(line) => line,
                        None => break,
                    },
                };
                line.push('\n');
                if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
                    break;
                }
            }
            // `stdin` drops here: the agent reads end of input.
        });

        // Stderr: keep a tail for error messages, mirror to our stderr.
        let tail = stderr_tail.clone();
        tauri::async_runtime::spawn(async move {
            let (mut stderr, mut buf) = (BufReader::new(stderr), Vec::new());
            while let Ok(Some(_)) = read_line(&mut stderr, &mut buf, MAX_STDERR_LINE).await {
                let line = String::from_utf8_lossy(&buf).into_owned();
                eprintln!("[agent] {line}");
                let mut t = tail.lock().unwrap();
                if t.len() == STDERR_TAIL_LINES {
                    t.pop_front();
                }
                t.push_back(line);
            }
        });

        // Reader: route responses to waiters, everything else to `on_incoming`.
        let (reader_pending, reader_responder, tail, reader_alive) = (pending.clone(), responder.clone(), stderr_tail.clone(), alive.clone());
        tauri::async_runtime::spawn(async move {
            let (mut stdout, mut buf) = (BufReader::new(stdout), Vec::new());
            while let Ok(Some(cut)) = read_line(&mut stdout, &mut buf, MAX_MESSAGE).await {
                if cut {
                    eprintln!("[acp] skipping a message over {MAX_MESSAGE} bytes from the agent");
                    continue;
                }
                match serde_json::from_slice::<Value>(&buf) {
                    Ok(Value::Object(msg)) => route(msg, &reader_pending, &reader_responder, &on_incoming),
                    _ => eprintln!("[acp] ignoring non-JSON-RPC line from agent: {}", preview(&buf)),
                }
            }

            let tail = join_tail(&tail);
            let reason = if tail.is_empty() { "agent process exited".to_string() } else { format!("agent process exited:\n{tail}") };
            // Mark dead before draining so `request` can't park a waiter nobody will answer.
            reader_alive.store(false, Ordering::SeqCst);
            for (_, waiter) in reader_pending.lock().unwrap().drain() {
                let _ = waiter.send(Err(RpcError { code: -1, message: reason.clone() }));
            }
            on_exit(reason);
        });

        Ok(Arc::new(Self { next_id: AtomicU64::new(1), alive, pending, responder, stderr_tail, close_stdin, child: Mutex::new(Some(child)) }))
    }

    /// The agent's process id, while yaah still holds it.
    pub fn pid(&self) -> Option<u32> {
        self.child.lock().unwrap().as_ref().and_then(Child::id)
    }

    /// Stop the agent the way ACP expects: close its stdin and wait up to
    /// `timeout` for it to exit on its own. Returns its exit status; an agent
    /// still running after that is killed and the error says so. Either way it
    /// is reaped, so no zombie is left. Only the first call waits.
    pub async fn shutdown(&self, timeout: Duration) -> Result<std::process::ExitStatus, String> {
        self.close_stdin.notify_one();
        let Some(mut child) = self.child.lock().unwrap().take() else { return Err("already shut down".into()) };
        match tokio::time::timeout(timeout, child.wait()).await {
            Ok(Ok(status)) => Ok(status),
            Ok(Err(e)) => Err(format!("couldn't wait for the agent: {e}")),
            Err(_) => {
                let _ = child.kill().await;
                Err(format!("still running {timeout:?} after its stdin closed; killed"))
            }
        }
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        let dropped = || RpcError { code: -1, message: "agent process is not running".into() };
        self.pending.lock().unwrap().insert(id, tx);
        let sent = self.responder.send(&message([("id", id.into()), ("method", method.into()), ("params", params)]));
        if !sent || !self.is_alive() {
            self.pending.lock().unwrap().remove(&id);
            return Err(dropped());
        }
        rx.await.unwrap_or_else(|_| Err(dropped()))
    }

    pub fn notify(&self, method: &str, params: Value) {
        self.responder.send(&message([("method", method.into()), ("params", params)]));
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    pub fn responder(&self) -> &Responder {
        &self.responder
    }

    pub fn stderr_tail(&self) -> String {
        join_tail(&self.stderr_tail)
    }
}

/// A JSON-RPC 2.0 message. The values are moved in, so a large result or params isn't copied.
fn message<const N: usize>(fields: [(&str, Value); N]) -> Value {
    let jsonrpc = ("jsonrpc".to_owned(), Value::from("2.0"));
    Value::Object(std::iter::once(jsonrpc).chain(fields.into_iter().map(|(k, v)| (k.to_owned(), v))).collect())
}

fn join_tail(tail: &Mutex<VecDeque<String>>) -> String {
    tail.lock().unwrap().iter().map(String::as_str).collect::<Vec<_>>().join("\n")
}

/// The start of a line, for logs.
fn preview(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).chars().take(200).collect()
}

fn route<F>(mut msg: Map<String, Value>, pending: &Mutex<PendingMap>, responder: &Responder, on_incoming: &F)
where
    F: Fn(Incoming, &Responder),
{
    let method = match msg.remove("method") {
        Some(Value::String(m)) => Some(m),
        _ => None,
    };
    let id = msg.remove("id").filter(|v| !v.is_null());
    match (method, id) {
        (Some(method), Some(id)) => on_incoming(Incoming::Request { id, method, params: msg.remove("params").unwrap_or_default() }, responder),
        (Some(method), None) => on_incoming(Incoming::Notification { method, params: msg.remove("params").unwrap_or_default() }, responder),
        (None, Some(id)) => {
            let Some(waiter) = id.as_u64().and_then(|id| pending.lock().unwrap().remove(&id)) else {
                eprintln!("[acp] response for unknown id {id}");
                return;
            };
            let result = match msg.remove("error") {
                Some(err) => Err(RpcError {
                    code: err.get("code").and_then(Value::as_i64).unwrap_or(0),
                    message: err.get("message").and_then(Value::as_str).unwrap_or("unknown error").to_owned(),
                }),
                None => Ok(msg.remove("result").unwrap_or_default()),
            };
            let _ = waiter.send(result);
        }
        (None, None) => eprintln!("[acp] ignoring a message with neither method nor id"),
    }
}

/// Read one `\n`-terminated line into `buf` (without the newline), keeping at
/// most `max` bytes; the rest of a longer line is skipped. Returns `None` at
/// end of input, else whether the line was cut. Bytes, not text: invalid UTF-8
/// from a child is the caller's to judge, not a reason to stop reading.
pub async fn read_line<R: AsyncBufRead + Unpin>(r: &mut R, buf: &mut Vec<u8>, max: usize) -> std::io::Result<Option<bool>> {
    buf.clear();
    let (mut cut, mut any) = (false, false);
    loop {
        let chunk = r.fill_buf().await?;
        if chunk.is_empty() {
            return Ok(any.then_some(cut));
        }
        any = true;
        let newline = chunk.iter().position(|&b| b == b'\n');
        let line = &chunk[..newline.unwrap_or(chunk.len())];
        let room = max.saturating_sub(buf.len());
        cut |= line.len() > room;
        buf.extend_from_slice(&line[..line.len().min(room)]);
        let used = newline.map_or(chunk.len(), |i| i + 1);
        r.consume(used);
        if newline.is_some() {
            return Ok(Some(cut));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(input: &[u8], max: usize) -> Vec<(String, bool)> {
        tauri::async_runtime::block_on(async {
            let mut r = BufReader::with_capacity(4, input);
            let (mut buf, mut out) = (Vec::new(), vec![]);
            while let Some(cut) = read_line(&mut r, &mut buf, max).await.unwrap() {
                out.push((String::from_utf8_lossy(&buf).into_owned(), cut));
            }
            out
        })
    }

    #[test]
    fn lines_are_bounded_and_bytes_are_kept() {
        let got = lines(b"short\nmuch too long a line\n\xff\xfe\nlast", 8);
        assert_eq!(
            got,
            [("short".into(), false), ("much too".into(), true), ("\u{fffd}\u{fffd}".into(), false), ("last".into(), false)],
            "a long line is cut, invalid UTF-8 doesn't end the stream, and a last line without a newline still counts"
        );
        assert_eq!(lines(b"", 8), Vec::<(String, bool)>::new());
        assert_eq!(lines(b"\n", 8), [(String::new(), false)]);
    }
}
