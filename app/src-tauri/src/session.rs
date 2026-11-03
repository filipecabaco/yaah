//! Sessions and transcripts.
//!
//! Rust owns the transcript (Principle 3): ACP `session/update` chunks are
//! merged here into display entries and pushed to the UI. The UI only renders
//! what it is sent (`docs/research/streaming-contract.md`):
//! - `session-entry` `{ sessionId, index, entry }`: a new entry, or any change that isn't a text append;
//! - `session-append` `{ sessionId, index, field, text, len }`: text added to a message or thought,
//!   coalesced to one emit per chat every [`COALESCE`], `len` in UTF-16 code units;
//! - `session-draft` `{ sessionId, index, draft, draftBy }`: a form's unsent values changed.
//!
//! Each chat has its own lock, so one chat's save or emit never waits on another's.
//! Transcripts are saved lazily on a thread of their own, and read from disk
//! only when a chat is first opened (startup reads each chat's info only).
//!
//! Everything an agent sends is untrusted: ids become file names only when
//! they're plain, and a permission answer only ever goes back to the process
//! that asked.

use crate::acp::{self, Connection, Incoming, Responder};
use crate::agent_guide::{self, Guide};
use crate::agents::{self, Profile, Report, Store};
use crate::projects::Project;
use crate::ui_mcp;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak, mpsc};
use std::time::{Duration, Instant};

/// "Resume a session…": an agent's own sessions (`session/list`), brought in as chats.
mod resume;
pub use resume::{AgentSession, AgentSessions, project_for_cwd};
/// `ui_request_folders`: the agent asks to add folders to the chat, the user answers inline.
mod folder_request;
/// ACP `terminal/*`: which chat a request is for, and keeping a released terminal's output.
mod terminal_chats;
use terminal_chats::TerminalChats;

/// Sends an event to the UI. The app wires this to `AppHandle::emit`; tests to a channel.
pub type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// The Claude preset's adapter. Pinned so a new release can't change behaviour under us.
pub const ADAPTER_PACKAGE: &str = "@agentclientprotocol/claude-agent-acp@0.99.1";
/// First run of an npx-launched agent downloads it, so allow for that.
pub const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(180);
const TITLE_MAX_CHARS: usize = 60;
/// Titles yaah makes up when the agent names nothing. Too vague to remember a
/// "don't ask again" by: it would answer requests the user never saw.
const UNNAMED_REQUEST: &str = "The agent wants to run a tool";
const UNNAMED_TOOL: &str = "Tool call";
const REMEMBERED: &str = "(you said don't ask again)";
/// At most one `session-append` per chat this often (about 30 a second).
pub const COALESCE: Duration = Duration::from_millis(33);
/// A changed transcript is written this long after its first unsaved change.
pub const SAVE_DELAY: Duration = Duration::from_millis(750);
/// Entries `get_entries` returns when not told how many: the end of the chat.
pub const PAGE: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Entry {
    User {
        text: String,
        /// Names of context sent alongside the text (e.g. the project brief).
        attachments: Vec<String>,
    },
    Agent {
        text: String,
        message_id: Option<String>,
    },
    Thought {
        text: String,
        message_id: Option<String>,
    },
    Tool {
        tool_call_id: String,
        title: String,
        kind: Option<String>,
        status: Option<String>,
        content: Value,
        locations: Value,
        raw_input: Value,
    },
    Plan {
        entries: Value,
    },
    Permission {
        request_id: Value,
        tool_call_id: Option<String>,
        title: String,
        options: Value,
        /// Name of the chosen option, or "cancelled". `None` while waiting.
        chosen: Option<String>,
    },
    /// UI the agent rendered via the UI MCP server. `tree` is a snapshot with
    /// library components expanded, so later library edits don't change it.
    Ui {
        /// Agent-chosen id: rendering again with the same id updates this entry in place
        /// (live status panels, progress).
        #[serde(default)]
        ui_id: Option<String>,
        title: Option<String>,
        component: Option<String>,
        version: Option<u32>,
        tree: Value,
        props: Value,
        /// Set when the agent is waiting on this UI (`ui_ask`) for the user's answer.
        #[serde(default)]
        ask_id: Option<String>,
        /// What the user submitted from this UI's form; once set the form is locked.
        #[serde(default)]
        answer: Option<Value>,
        /// Unsent form values that the user and the agent both edit: field → value.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        draft: Option<Value>,
        /// Who changed each draft field last: "user" or "agent".
        #[serde(default, skip_serializing_if = "Option::is_none")]
        draft_by: Option<Value>,
    },
    Error {
        message: String,
        /// Set when logging this account in would fix the error.
        login_account: Option<String>,
    },
    /// Things the agent wants the user to know that aren't part of its reply
    /// (ACP `notice` updates): an MCP server that didn't start, one that needs
    /// signing in. Notices in a row collect into one entry.
    Notices {
        items: Vec<Notice>,
    },
    /// The user moved the chat to another agent (`Hub::switch_agent`): the next
    /// prompt goes to it in a fresh ACP session, with the conversation handed off.
    Switch {
        /// The agent profile the chat uses from here on.
        account_id: String,
        /// Its label, as it was when switching ("Codex (work)").
        label: String,
        /// The label of the agent it took over from, when known.
        from: Option<String>,
    },
    /// The user added folders to the chat as it went (`Hub::add_dirs`): to its
    /// project, so every chat there gets them, or to this chat only. The agent
    /// works in them from the next prompt on.
    AddedDirs {
        /// The folders added, absolute.
        paths: Vec<String>,
        /// `"project"` or `"chat"`: what they were added to.
        to: String,
    },
    /// The agent asked to add folders to the chat (`ui_request_folders`) and
    /// waits for the user's Add / Not now ([`Hub::request_folders`]).
    FolderRequest {
        /// The folders asked for, absolute.
        paths: Vec<String>,
        /// Why, in the agent's words.
        reason: String,
        /// The waiting tool call's ask, as `ui_ask`'s.
        ask_id: Option<String>,
        /// `"added"`, `"declined"` or `"cancelled"`; `None` while waiting.
        answer: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    /// "info", "warning" or "error".
    pub severity: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The MCP server it is about, when it is about one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_server: Option<String>,
}

/// How far a new chat got (`session-starting` events): the agent's process starting and
/// `initialize` (only when it wasn't running), then `session/new`: with the MCP servers it
/// starts meanwhile, when it has any.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StartStage {
    Agent,
    McpServers,
    Session,
}

impl Entry {
    fn error(message: impl Into<String>) -> Self {
        Entry::Error { message: message.into(), login_account: None }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    /// `None` for a quick chat that belongs to no project.
    #[serde(default)]
    pub project_id: Option<String>,
    /// Unix seconds; 0 for chats saved before this existed.
    #[serde(default)]
    pub created_at: u64,
    pub account_id: String,
    pub cwd: String,
    pub additional_dirs: Vec<String>,
    pub title: String,
    pub running: bool,
    pub stop_reason: Option<String>,
    /// Slash commands the agent offers in this chat (ACP `available_commands_update`):
    /// `[{ name, description, input?: { hint } }]`.
    #[serde(default)]
    pub commands: Vec<Value>,
    /// The chat's ACP session id at its current agent, when it isn't `session_id`:
    /// after a switch the agent picks a new one, while the chat keeps its id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_session_id: Option<String>,
    /// Set by a switch to another agent: the label of the agent it takes over from.
    /// While set, the next prompt starts a fresh ACP session and hands the
    /// conversation off; cleared once that prompt goes out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff_from: Option<String>,
    /// A quick chat's own folders besides its cwd (chosen when it started, or added
    /// as it went); they are in `additional_dirs` too. Empty for project chats,
    /// whose folders come from the project.
    #[serde(default)]
    pub extra_dirs: Vec<String>,
    /// The chat's folders changed since its agent session was opened: the next
    /// prompt reopens it with them first (`session/load`, or a fresh session and a
    /// hand-off for an agent that can't load). Cleared once that is done.
    #[serde(default, skip_serializing_if = "is_false")]
    pub dirs_changed: bool,
}

#[allow(clippy::trivially_copy_pass_by_ref, reason = "serde's skip_serializing_if passes a reference")]
fn is_false(b: &bool) -> bool {
    !*b
}

impl SessionInfo {
    /// The id the chat's agent knows it by (ACP `sessionId`).
    pub fn agent_session(&self) -> &str {
        self.agent_session_id.as_deref().unwrap_or(&self.session_id)
    }
}

/// A chat as the UI gets it, and as it is saved on disk.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub info: SessionInfo,
    pub entries: Vec<Entry>,
}

/// Part of a transcript (`get_entries`): `entries` are those at `from..`, of `total`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    #[serde(serialize_with = "shared_entries")]
    pub entries: Vec<Arc<Entry>>,
    pub from: usize,
    pub total: usize,
}

/// Entries as a JSON list, without copying them out of their `Arc`s.
fn shared_entries<S: serde::Serializer>(entries: &[Arc<Entry>], s: S) -> Result<S::Ok, S::Error> {
    s.collect_seq(entries.iter().map(|e| &**e))
}

/// A `ui_ask` waiting on the user: its chat, and where the answer goes (`None` = cancelled).
type PendingAsk = (String, mpsc::Sender<Option<Value>>);

/// Where a new chat runs.
pub enum ChatTarget<'a> {
    Project(&'a Project),
    /// A quick chat in one folder (picked, or a fresh scratch folder).
    Folder(String),
}

/// A running agent and what it told us in `initialize`.
#[derive(Clone)]
struct Agent {
    conn: Arc<Connection>,
    /// Which start of the profile's agent this is; a chat is attached to one.
    generation: u64,
    auth_methods: Vec<Value>,
    caps: Report,
    /// Claude Code reads `_meta.claudeCode` options in `session/new`.
    claude: bool,
    /// The profile's preset: some agents get extras from yaah's UI guide (`agent_guide::plan`).
    preset: String,
}

/// The project brief, attached to the first prompt of a chat.
struct Brief {
    path: String,
    text: String,
}

/// A chat, behind a lock of its own.
type Cell = Arc<Mutex<Session>>;

struct Session {
    info: SessionInfo,
    /// The transcript. Entries are shared so a snapshot for the saver is a cheap
    /// copy of pointers; a change copies only the entry it touches, and only
    /// while a snapshot still holds it (`Session::entry_mut`).
    entries: Vec<Arc<Entry>>,
    /// False while only the info has been read from disk; the entries are
    /// read the first time anything needs them (`Session::ensure_loaded`).
    loaded: bool,
    tool_index: HashMap<String, usize>,
    plan_index: Option<usize>,
    /// Taken (sent) with the first prompt.
    brief: Option<Brief>,
    /// yaah's UI guide, for an agent that can only get it with the first prompt. Taken then.
    guide: Option<String>,
    /// The agent generation that knows this session. `None` after a restart; a
    /// prompt to another generation reattaches first with `session/load`.
    attached: Option<u64>,
    /// True while `session/load` replays history we already have.
    replaying: bool,
    /// Set while an imported session's `session/load` runs: its replay is the transcript,
    /// so it is recorded rather than ignored (`resume.rs`).
    importing: Option<resume::Import>,
    /// Where the transcript is saved; `None` keeps it in memory only.
    save_to: Option<PathBuf>,
    /// Permission requests the user said "don't ask again" to, by request title
    /// (a tool name or an exact command): the option kind to answer with. For this
    /// chat only; the agent may also remember it its own way.
    remembered: HashMap<String, String>,
    /// Permission requests still waiting, by entry index, with the process that
    /// asked (its generation, and where answers go): the answer goes there and nowhere else.
    waiting: HashMap<usize, (u64, Responder)>,
    /// The chat's token on the UI MCP server, once one was handed out (runtime
    /// only). A hand-off to another agent reuses it, so its UI calls reach this chat.
    ui_token: Option<String>,
    /// Entries that wait for the running turn to end, so they don't land in the
    /// middle of the agent's reply (folders added mid-turn).
    after_turn: Vec<Entry>,
    /// This chat's own cell, for the threads that flush appends and save.
    me: Weak<Mutex<Session>>,
    stream: Stream,
    saving: Saving,
}

/// Appends on their way to the UI.
#[derive(Default)]
struct Stream {
    /// Text appended since the last `session-append`, not sent yet.
    pending: Option<Append>,
    /// When the last `session-append` went out.
    last: Option<Instant>,
    /// The append flusher has this chat on its list.
    scheduled: bool,
    /// The entry last appended to and its text's length in UTF-16 code units,
    /// so an append doesn't count the whole text again.
    text_len: Option<(usize, usize)>,
}

/// Whether the transcript needs writing.
#[derive(Default)]
struct Saving {
    /// Changed since it was last written.
    dirty: bool,
    /// The saver has this chat on its list.
    scheduled: bool,
}

/// Text appended to one entry and not sent yet.
struct Append {
    index: usize,
    text: String,
    /// The field's whole length after the append, in UTF-16 code units (what JS's `length` counts).
    len: usize,
}

/// The name of the field appends go to: messages and thoughts both keep their text in `text`.
const TEXT_FIELD: &str = "text";

impl Session {
    fn new(info: SessionInfo, entries: Vec<Entry>, save_to: Option<PathBuf>) -> Self {
        let entries: Vec<Arc<Entry>> = entries.into_iter().map(Arc::new).collect();
        Self {
            info,
            tool_index: index_tools(&entries),
            entries,
            loaded: true,
            plan_index: None,
            brief: None,
            guide: None,
            attached: None,
            replaying: false,
            importing: None,
            save_to,
            remembered: HashMap::new(),
            waiting: HashMap::new(),
            ui_token: None,
            after_turn: vec![],
            me: Weak::new(),
            stream: Stream::default(),
            saving: Saving::default(),
        }
    }

    /// A chat restored from `path` whose entries haven't been read yet.
    fn unloaded(info: SessionInfo, path: PathBuf) -> Self {
        Self { loaded: false, ..Self::new(info, vec![], Some(path)) }
    }

    /// Read the entries from disk if they haven't been yet. A turn that was
    /// running when the app stopped is already marked stopped (`load_sessions`);
    /// here unanswered permission prompts are marked cancelled. A transcript
    /// that can't be read is left on disk as it is and not saved over.
    fn ensure_loaded(&mut self) {
        if self.loaded {
            return;
        }
        self.loaded = true;
        let Some(path) = &self.save_to else { return };
        match read_entries(path) {
            Ok(mut entries) => {
                for e in &mut entries {
                    if let Entry::Permission { chosen: chosen @ None, .. } = e {
                        *chosen = Some("cancelled (app restarted)".into());
                    }
                }
                self.entries = entries.into_iter().map(Arc::new).collect();
                self.tool_index = index_tools(&self.entries);
            }
            Err(e) => {
                eprintln!("[sessions] could not read {}: {e}", path.display());
                self.entries = vec![Arc::new(Entry::error(format!(
                    "Couldn't read this chat's saved transcript ({e}). The file was left as it is, and this chat won't be saved over it."
                )))];
                self.save_to = None;
            }
        }
    }

    /// The entry at `index`, to change. Copied first only if a snapshot being saved still holds it.
    fn entry_mut(&mut self, index: usize) -> Option<&mut Entry> {
        self.entries.get_mut(index).map(Arc::make_mut)
    }

    /// Answer the waiting permission requests from the agent generations `from`
    /// picks with `cancelled` (ACP requires it on cancel) and mark them `why`.
    /// Returns the entries that changed.
    fn cancel_waiting(&mut self, why: &str, from: impl Fn(u64) -> bool) -> Vec<usize> {
        let mut picked: Vec<usize> = self.waiting.iter().filter(|(_, (g, _))| from(*g)).map(|(i, _)| *i).collect();
        picked.sort_unstable();
        picked
            .into_iter()
            .filter_map(|i| {
                let (_, responder) = self.waiting.remove(&i)?;
                let Some(Entry::Permission { request_id, chosen, .. }) = self.entry_mut(i) else { return None };
                *chosen = Some(why.to_owned());
                responder.ok(request_id.clone(), outcome(None));
                Some(i)
            })
            .collect()
    }
}

fn index_tools(entries: &[Arc<Entry>]) -> HashMap<String, usize> {
    entries
        .iter()
        .enumerate()
        .filter_map(|(i, e)| match &**e {
            Entry::Tool { tool_call_id, .. } => Some((tool_call_id.clone(), i)),
            _ => None,
        })
        .collect()
}

/// Find saved chats, reading only each one's info (the entries wait until the
/// chat is opened). Turns that were running when the app stopped are marked
/// stopped. Files that aren't a chat are skipped.
fn load_sessions(dir: &Path) -> HashMap<String, Session> {
    let Ok(files) = std::fs::read_dir(dir) else { return HashMap::new() };
    files
        .filter_map(Result::ok)
        .map(|f| f.path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .filter_map(|path| {
            let mut info = read_info(&path).inspect_err(|e| eprintln!("[sessions] skipping {}: {e}", path.display())).ok()?;
            info.running = false;
            Some((info.session_id.clone(), Session::unloaded(info, path)))
        })
        .collect()
}

/// A saved chat's info, read from the start of its file. Reading stops once it
/// has the info: a chat is saved with its info first, so the entries are never read.
fn read_info(path: &Path) -> Result<SessionInfo, String> {
    use serde::de::{DeserializeSeed, Error, IgnoredAny, MapAccess, Visitor};

    struct InfoOnly<'a>(&'a mut Option<SessionInfo>);
    const GOT_IT: &str = "stopped after the info";

    impl<'de> DeserializeSeed<'de> for InfoOnly<'_> {
        type Value = ();
        fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
            d.deserialize_map(self)
        }
    }

    impl<'de> Visitor<'de> for InfoOnly<'_> {
        type Value = ();
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("a saved chat")
        }
        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
            while let Some(key) = map.next_key::<String>()? {
                if key == "info" {
                    *self.0 = Some(map.next_value()?);
                    // An error is the only way to stop serde_json before the end of the object.
                    return Err(A::Error::custom(GOT_IT));
                }
                map.next_value::<IgnoredAny>()?;
            }
            Ok(())
        }
    }

    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut de = serde_json::Deserializer::from_reader(std::io::BufReader::new(file));
    let mut info = None;
    let res = InfoOnly(&mut info).deserialize(&mut de);
    info.ok_or_else(|| res.err().map_or_else(|| "no info".to_owned(), |e| e.to_string()))
}

/// A saved chat's entries.
fn read_entries(path: &Path) -> Result<Vec<Entry>, String> {
    #[derive(Deserialize)]
    struct Saved {
        entries: Vec<Entry>,
    }
    let raw = std::fs::read(path).map_err(|e| e.to_string())?;
    serde_json::from_slice::<Saved>(&raw).map(|s| s.entries).map_err(|e| e.to_string())
}

/// Runs `run` on chats at the times they're handed in, on a thread of its own.
/// A chat already gone by then is skipped. When the sender side is dropped the
/// thread runs everything still due, then ends.
struct Timer(Option<mpsc::Sender<(Instant, Weak<Mutex<Session>>)>>);

impl Timer {
    fn start(name: &str, run: impl Fn(&Mutex<Session>) + Send + 'static) -> Self {
        let (tx, rx) = mpsc::channel::<(Instant, Weak<Mutex<Session>>)>();
        let started = std::thread::Builder::new().name(name.into()).spawn(move || {
            let mut due: Vec<(Instant, Weak<Mutex<Session>>)> = vec![];
            loop {
                let next = due.iter().map(|(t, _)| *t).min();
                let got = match next {
                    None => rx.recv().map_err(|_| mpsc::RecvTimeoutError::Disconnected),
                    Some(t) => rx.recv_timeout(t.saturating_duration_since(Instant::now())),
                };
                let done = match got {
                    Ok(item) => {
                        due.push(item);
                        false
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => false,
                    Err(mpsc::RecvTimeoutError::Disconnected) => true,
                };
                let now = Instant::now();
                let (ready, later): (Vec<_>, Vec<_>) = due.drain(..).partition(|(t, _)| done || *t <= now);
                due = later;
                for (_, chat) in ready {
                    if let Some(chat) = chat.upgrade() {
                        run(&chat);
                    }
                }
                if done {
                    return;
                }
            }
        });
        if let Err(e) = &started {
            eprintln!("[sessions] {name} thread not started: {e}");
        }
        Self(started.is_ok().then_some(tx))
    }

    /// Run on `chat` at `when`. False if there's no thread to do it.
    fn at(&self, when: Instant, chat: Weak<Mutex<Session>>) -> bool {
        self.0.as_ref().is_some_and(|tx| tx.send((when, chat)).is_ok())
    }
}

/// Send the text appended since the last `session-append`, if any.
fn send_appends(app: &Emit, s: &mut Session) {
    let Some(a) = s.stream.pending.take() else { return };
    s.stream.last = Some(Instant::now());
    app("session-append", json!({ "sessionId": s.info.session_id, "index": a.index, "field": TEXT_FIELD, "text": a.text, "len": a.len }));
}

/// Write a chat's transcript if it changed since it was last written. The
/// snapshot is taken under the chat's lock (a copy of pointers); serialising
/// and writing happen after it is released. `io` keeps writes of one file in
/// the order their snapshots were taken.
fn write_session(io: &Mutex<()>, chat: &Mutex<Session>) {
    #[derive(Serialize)]
    struct Saved<'a> {
        info: &'a SessionInfo,
        #[serde(serialize_with = "shared_entries")]
        entries: &'a [Arc<Entry>],
    }
    let _io = io.lock().unwrap();
    let (path, info, entries) = {
        let mut s = chat.lock().unwrap();
        s.saving.scheduled = false;
        if !s.saving.dirty {
            return;
        }
        s.saving.dirty = false;
        let Some(path) = s.save_to.clone() else { return };
        (path, s.info.clone(), s.entries.clone())
    };
    let bytes = serde_json::to_vec(&Saved { info: &info, entries: &entries });
    drop(entries); // the chat's next change to these entries needn't copy them
    let res = bytes.map_err(|e| e.to_string()).and_then(|bytes| write_private(&path, &bytes).map_err(|e| e.to_string()));
    if let Err(e) = res {
        eprintln!("[sessions] could not save {}: {e}", path.display());
    }
}

/// Write a file only its owner can read (chats can hold secrets), atomically: a
/// crash leaves the old file or the new one. (`json_file::write` does the same
/// for values; transcripts arrive here already serialised.)
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    // Created fresh and 0600 from the start, so the contents are never readable by others, even briefly.
    let _ = std::fs::remove_file(&tmp);
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp)?;
    f.write_all(bytes)?;
    std::fs::rename(&tmp, path)
}

/// What the agents' reader tasks and the Hub share.
///
/// Locks: the chats map is only held to find, add or remove a chat, never
/// while waiting on a chat's lock. A chat's lock may be held while taking the
/// map's (deleting). The saver takes `io` and then one chat's lock; nothing
/// takes `io` while holding a chat's lock.
struct Shared {
    app: Emit,
    sessions: Mutex<HashMap<String, Cell>>,
    /// ACP session id → chat id, for chats whose agent knows them by another id
    /// (after a switch to another agent). Taken only on its own, never with a chat's lock held
    /// first and `sessions` after it.
    aliases: Mutex<HashMap<String, String>>,
    /// Profiles whose agent answered "authentication required" since their last login.
    needs_login: Mutex<HashSet<String>>,
    /// What each profile's running agent last said it is signed in with (`_auth/status_update`).
    auth_status: Mutex<HashMap<String, agents::AuthStatus>>,
    profiles: &'static Store,
    /// Sends a chat's coalesced appends once its interval is up.
    flusher: Timer,
    /// Writes a chat's transcript a moment after it changes.
    saver: Timer,
    /// Held while writing or deleting a transcript.
    io: Arc<Mutex<()>>,
    /// [`COALESCE`] and [`SAVE_DELAY`], in microseconds; tests change them.
    coalesce_us: AtomicU64,
    save_delay_us: AtomicU64,
    /// Terminal panes' shells and agents' commands (`terminals.rs`, `acp_terminals.rs`).
    terminals: Arc<crate::terminals::Terminals>,
}

fn micros(d: Duration) -> u64 {
    u64::try_from(d.as_micros()).unwrap_or(u64::MAX)
}

impl Shared {
    fn new(app: Emit, sessions: HashMap<String, Session>, profiles: &'static Store) -> Self {
        let io = Arc::<Mutex<()>>::default();
        let flusher = Timer::start("yaah-appends", {
            let app = app.clone();
            move |chat| {
                let mut s = chat.lock().unwrap();
                s.stream.scheduled = false;
                send_appends(&app, &mut s);
            }
        });
        let saver = Timer::start("yaah-sessions", {
            let io = io.clone();
            move |chat| write_session(&io, chat)
        });
        let aliases = sessions.values().filter_map(|s| Some((s.info.agent_session_id.clone()?, s.info.session_id.clone()))).collect();
        Self {
            terminals: crate::terminals::Terminals::new(app.clone()),
            app,
            sessions: Mutex::new(sessions.into_iter().map(|(id, s)| (id, cell(s))).collect()),
            aliases: Mutex::new(aliases),
            needs_login: Mutex::default(),
            auth_status: Mutex::default(),
            profiles,
            flusher,
            saver,
            io,
            coalesce_us: AtomicU64::new(micros(COALESCE)),
            save_delay_us: AtomicU64::new(micros(SAVE_DELAY)),
        }
    }

    /// A chat by its id, or by the ACP session id its current agent knows it by.
    fn chat(&self, session_id: &str) -> Option<Cell> {
        if let Some(chat) = self.sessions.lock().unwrap().get(session_id) {
            return Some(chat.clone());
        }
        let id = self.aliases.lock().unwrap().get(session_id).cloned()?;
        self.sessions.lock().unwrap().get(&id).cloned()
    }

    /// Whether `acp_id` would name a chat other than `chat_id` (as its id or its agent's).
    fn taken_by_another(&self, acp_id: &str, chat_id: &str) -> bool {
        (acp_id != chat_id && self.sessions.lock().unwrap().contains_key(acp_id))
            || self.aliases.lock().unwrap().get(acp_id).is_some_and(|c| c != chat_id)
    }

    fn chats(&self) -> Vec<Cell> {
        self.sessions.lock().unwrap().values().cloned().collect()
    }

    /// Run `f` on a session under its own lock, its entries loaded.
    fn with<R>(&self, session_id: &str, f: impl FnOnce(&mut Session) -> R) -> Result<R, String> {
        let chat = self.chat(session_id).ok_or("unknown session")?;
        let mut s = chat.lock().unwrap();
        s.ensure_loaded();
        Ok(f(&mut s))
    }

    /// Run `f` on a session's info, without reading its entries.
    fn with_info<R>(&self, session_id: &str, f: impl FnOnce(&SessionInfo) -> R) -> Result<R, String> {
        let chat = self.chat(session_id).ok_or("unknown session")?;
        let s = chat.lock().unwrap();
        Ok(f(&s.info))
    }

    fn flush_appends(&self, s: &mut Session) {
        send_appends(&self.app, s);
    }

    /// Every other event of a chat sends its pending appends first, so the UI sees changes in order.
    fn emit_entry(&self, s: &mut Session, index: usize) {
        self.flush_appends(s);
        (self.app)("session-entry", json!({ "sessionId": s.info.session_id, "index": index, "entry": &*s.entries[index] }));
    }

    fn emit_info(&self, s: &mut Session) {
        self.flush_appends(s);
        (self.app)("session-info", serde_json::to_value(&s.info).unwrap_or_default());
    }

    /// A form's unsent values changed: just those, not the whole UI entry (which can hold images).
    fn emit_draft(&self, s: &mut Session, index: usize) {
        self.flush_appends(s);
        if let Entry::Ui { draft, draft_by, .. } = &*s.entries[index] {
            (self.app)("session-draft", json!({ "sessionId": s.info.session_id, "index": index, "draft": draft, "draftBy": draft_by }));
        }
    }

    fn push(&self, s: &mut Session, entry: Entry) -> usize {
        s.entries.push(Arc::new(entry));
        let i = s.entries.len() - 1;
        self.emit_entry(s, i);
        i
    }

    /// Add `text` to the message or thought at `index` and tell the UI with a
    /// `session-append`: now if the last one went out at least [`COALESCE`] ago,
    /// otherwise joined with what follows and sent when the interval is up (or
    /// sooner, before any other change to the chat).
    fn append(&self, s: &mut Session, index: usize, text: &str) {
        if text.is_empty() {
            return;
        }
        let before = match (s.stream.text_len, s.entries.get(index).map(|e| &**e)) {
            (Some((i, len)), _) if i == index => len,
            (_, Some(Entry::Agent { text, .. } | Entry::Thought { text, .. })) => text.encode_utf16().count(),
            _ => return,
        };
        let Some(Entry::Agent { text: t, .. } | Entry::Thought { text: t, .. }) = s.entry_mut(index) else { return };
        t.push_str(text);
        let len = before + text.encode_utf16().count();
        s.stream.text_len = Some((index, len));
        match &mut s.stream.pending {
            Some(p) if p.index == index => {
                p.text.push_str(text);
                p.len = len;
            }
            _ => {
                self.flush_appends(s);
                s.stream.pending = Some(Append { index, text: text.to_owned(), len });
            }
        }
        // While a flush is scheduled it is left to send this too, even if it's a little late,
        // so a chat never gets two appends within one interval.
        if s.stream.scheduled {
            return;
        }
        let interval = Duration::from_micros(self.coalesce_us.load(Ordering::Relaxed));
        match s.stream.last.map(|t| t + interval).filter(|due| *due > Instant::now()) {
            None => self.flush_appends(s),
            Some(due) => {
                s.stream.scheduled = self.flusher.at(due, s.me.clone());
                if !s.stream.scheduled {
                    self.flush_appends(s);
                }
            }
        }
    }

    /// Mark the transcript changed; the saver writes it in a moment.
    fn save(&self, s: &mut Session) {
        self.save_after(s, Duration::from_micros(self.save_delay_us.load(Ordering::Relaxed)));
    }

    /// Mark the transcript changed and have the saver write it now (a turn ended).
    fn save_now(&self, s: &mut Session) {
        self.save_after(s, Duration::ZERO);
    }

    fn save_after(&self, s: &mut Session, delay: Duration) {
        if s.save_to.is_none() {
            return;
        }
        s.saving.dirty = true;
        if s.saving.scheduled && !delay.is_zero() {
            return;
        }
        // Without the saver thread the change waits for the next flush (on exit at the latest).
        s.saving.scheduled = self.saver.at(Instant::now() + delay, s.me.clone());
    }

    /// Write every changed transcript now.
    fn flush_saves(&self) {
        for chat in self.chats() {
            write_session(&self.io, &chat);
        }
    }

    fn profile(&self, id: &str) -> Result<Profile, String> {
        self.profiles.find(id).ok_or_else(|| format!("unknown agent {id}; add it again in Manage agents"))
    }

    fn not_logged_in(&self, account_id: &str) -> String {
        let label = self.profiles.find(account_id).map_or_else(|| account_id.to_owned(), |a| a.label);
        format!("Agent \"{label}\" is not logged in.")
    }

    /// claude-agent-acp's `_auth/status_update`: what the agent is signed in
    /// with. External (Bedrock…), gateway or API-key auth means it can chat
    /// without a claude.ai login; `-32000` stays the backstop.
    fn auth_status_update(&self, account_id: &str, params: &Value) {
        let Some(status) = agents::AuthStatus::from_update(params) else { return };
        let ready = status.ready();
        let changed = self.auth_status.lock().unwrap().insert(account_id.to_owned(), status.clone()).as_ref() != Some(&status);
        let cleared = ready && self.needs_login.lock().unwrap().remove(account_id);
        if changed || cleared {
            (self.app)("accounts-changed", Value::Null);
        }
    }

    fn mark_needs_login(&self, account_id: &str) {
        if self.needs_login.lock().unwrap().insert(account_id.to_owned()) {
            (self.app)("accounts-changed", Value::Null);
        }
    }

    /// An ACP error, in words; an auth error also flags the profile for login.
    fn rpc_error(&self, account_id: &str, e: &acp::RpcError, what: &str) -> String {
        if e.code == acp::AUTH_REQUIRED {
            self.mark_needs_login(account_id);
            self.not_logged_in(account_id)
        } else {
            format!("{what}: {e}")
        }
    }
}

impl Drop for Shared {
    /// Whatever changed after the Hub's last flush (a turn ending as the app closes) is still written.
    fn drop(&mut self) {
        self.flush_saves();
    }
}

#[cfg(test)]
impl Shared {
    /// Add a chat as if it had been started or restored.
    fn insert(&self, session: Session) -> Cell {
        let id = session.info.session_id.clone();
        let chat = cell(session);
        self.sessions.lock().unwrap().insert(id, chat.clone());
        chat
    }
}

/// A session in a cell of its own, which knows itself (for the flusher and saver).
fn cell(session: Session) -> Cell {
    Arc::new_cyclic(|me| {
        let mut session = session;
        session.me = me.clone();
        Mutex::new(session)
    })
}

pub struct Hub {
    shared: Arc<Shared>,
    /// Running agents, one per profile, shared by that profile's sessions.
    agents: Mutex<HashMap<String, Agent>>,
    /// One per profile, held while its agent starts, so two chats can't start two
    /// processes, and a slow start (npx downloading) holds up no other profile.
    starting: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    generations: AtomicU64,
    /// Port of the UI MCP server (`ui_mcp.rs`), if it started.
    ui_port: OnceLock<u16>,
    /// That server, to close a deleted chat's previews and refuse its tokens.
    ui_host: OnceLock<Weak<ui_mcp::UiHost>>,
    /// UI MCP URL token → session id. Registered before `session/new` (the agent
    /// connects to MCP servers while creating the session), so `None` until it returns.
    ui_tokens: Mutex<HashMap<String, Option<String>>>,
    /// `ui_ask` calls waiting on the user: ask id → (session id, where the answer goes;
    /// `None` means cancelled).
    asks: Mutex<HashMap<String, PendingAsk>>,
    /// Where transcripts are saved (`~/.yaah/sessions`); `None` in tests.
    store: Option<PathBuf>,
    /// What agents are told about yaah's UI (`agent_guide.rs`); unset, they're told nothing.
    guide: OnceLock<Arc<Guide>>,
}

impl Hub {
    /// A hub that keeps transcripts in memory only.
    pub fn new(app: Emit) -> Self {
        Self::open(app, None, Store::user())
    }

    /// A hub that saves transcripts in `dir` and restores the ones already there.
    pub fn with_store(app: Emit, dir: PathBuf) -> Self {
        Self::open(app, Some(dir), Store::user())
    }

    /// A hub over the agent profiles in `profiles`, saving transcripts in `store`
    /// (and restoring the ones there) when it is given. Only each saved chat's
    /// info is read now; its entries are read when it is first opened.
    pub fn open(app: Emit, store: Option<PathBuf>, profiles: &'static Store) -> Self {
        let sessions = store.as_deref().map(load_sessions).unwrap_or_default();
        if let Some(dir) = &store {
            eprintln!("[sessions] found {} chats in {}", sessions.len(), dir.display());
        }
        Self {
            shared: Arc::new(Shared::new(app, sessions, profiles)),
            agents: Mutex::default(),
            starting: Mutex::default(),
            generations: AtomicU64::new(1),
            ui_port: OnceLock::new(),
            ui_host: OnceLock::new(),
            ui_tokens: Mutex::default(),
            asks: Mutex::default(),
            store,
            guide: OnceLock::new(),
        }
    }

    /// Write every transcript change not written yet. Saves happen in the
    /// background a moment after a change; call this before the app exits.
    pub fn flush(&self) {
        self.shared.flush_saves();
    }

    /// Change how often appends are sent ([`COALESCE`]) and how long a change
    /// waits to be written ([`SAVE_DELAY`]). For tests and benchmarks.
    pub fn set_timings(&self, coalesce: Duration, save_delay: Duration) {
        self.shared.coalesce_us.store(micros(coalesce), Ordering::Relaxed);
        self.shared.save_delay_us.store(micros(save_delay), Ordering::Relaxed);
    }

    /// Called once the UI MCP server is listening.
    pub fn set_ui_port(&self, port: u16) {
        let _ = self.ui_port.set(port);
    }

    /// Called by `ui_mcp::start` with the server serving this hub's chats.
    pub fn set_ui_host(&self, host: Weak<ui_mcp::UiHost>) {
        let _ = self.ui_host.set(host);
    }

    /// Teach new and reattached chats' agents about yaah's UI with `guide`.
    pub fn set_guide(&self, guide: Arc<Guide>) {
        let _ = self.guide.set(guide);
    }

    /// Terminal panes' shells and agents' commands (`terminals.rs`).
    pub fn terminals(&self) -> &Arc<crate::terminals::Terminals> {
        &self.shared.terminals
    }

    pub fn guide(&self) -> Option<&Arc<Guide>> {
        self.guide.get()
    }

    /// For a known UI MCP token: the chat it belongs to, once that chat exists.
    pub fn ui_session(&self, token: &str) -> Option<Option<String>> {
        self.ui_tokens.lock().unwrap().get(token).cloned()
    }

    /// Register a `ui_ask`; the receiver gets the answer, or `None` if cancelled.
    pub fn register_ask(&self, session_id: &str) -> (String, mpsc::Receiver<Option<Value>>) {
        let (tx, rx) = mpsc::channel();
        let id = random_token();
        self.asks.lock().unwrap().insert(id.clone(), (session_id.to_owned(), tx));
        (id, rx)
    }

    /// Forget an ask that ended without an answer (timeout).
    pub fn drop_ask(&self, ask_id: &str) {
        self.asks.lock().unwrap().remove(ask_id);
    }

    fn cancel_asks(&self, session_id: &str) {
        let cancelled: HashMap<String, mpsc::Sender<Option<Value>>> = {
            let mut asks = self.asks.lock().unwrap();
            let ids: Vec<String> = asks.iter().filter(|(_, (sid, _))| sid == session_id).map(|(id, _)| id.clone()).collect();
            ids.into_iter().filter_map(|id| asks.remove(&id).map(|(_, tx)| (id, tx))).collect()
        };
        if cancelled.is_empty() {
            return;
        }
        let _ = self.shared.with(session_id, |s| {
            let asked: Vec<usize> = (0..s.entries.len())
                .filter(|&i| match &*s.entries[i] {
                    Entry::Ui { ask_id: Some(a), answer: None, .. } | Entry::FolderRequest { ask_id: Some(a), answer: None, .. } => {
                        cancelled.contains_key(a)
                    }
                    _ => false,
                })
                .collect();
            for i in asked {
                match s.entry_mut(i) {
                    Some(Entry::Ui { answer, .. }) => *answer = Some(json!({ "$cancelled": true })),
                    Some(Entry::FolderRequest { answer, .. }) => *answer = Some("cancelled".into()),
                    _ => {}
                }
                self.shared.emit_entry(s, i);
            }
            self.shared.save(s);
        });
        for tx in cancelled.into_values() {
            let _ = tx.send(None);
        }
    }

    /// The user submitted the form in the UI entry at `index`. If the agent is
    /// waiting on it (`ui_ask`) the answer goes straight back into that tool call,
    /// so the agent carries on in the same turn; otherwise it becomes the next message.
    pub async fn answer_ui(&self, session_id: &str, index: usize, values: Value) -> Result<(), String> {
        let (ask, title) = self.shared.with(session_id, |s| {
            let Some(Entry::Ui { ask_id, answer, title, component, .. }) = s.entry_mut(index) else {
                return Err("no UI at that index".to_owned());
            };
            if answer.is_some() {
                return Err("this form was already answered".into());
            }
            *answer = Some(values.clone());
            let ask = ask_id.clone();
            let title = title.clone().or_else(|| component.clone()).unwrap_or_else(|| "the form".into());
            self.shared.emit_entry(s, index);
            self.shared.save(s);
            Ok((ask, title))
        })??;
        if let Some(id) = ask
            && let Some((_, tx)) = self.asks.lock().unwrap().remove(&id)
        {
            let _ = tx.send(Some(values));
            return Ok(());
        }
        let summary = values
            .as_object()
            .map(|o| {
                o.iter().map(|(k, v)| format!("- {k}: {}", v.as_str().map_or_else(|| v.to_string(), str::to_owned))).collect::<Vec<_>>().join("\n")
            })
            .unwrap_or_default();
        let text = format!("My answers to \"{title}\":\n{summary}\n\n```json\n{}\n```", serde_json::to_string_pretty(&values).unwrap_or_default());
        self.prompt(session_id, text, vec![]).await
    }

    /// Change fields of a form that hasn't been sent yet. The user (as they type)
    /// and the agent (`ui_set_values`) edit the same draft; the last write to a
    /// field wins, and each field remembers who wrote it so the UI can say so.
    /// The UI gets only the draft (`session-draft`), not the whole entry again.
    pub fn edit_form(&self, session_id: &str, form: FormRef<'_>, values: &Value, by: &str) -> Result<Value, String> {
        let changes = values.as_object().ok_or("values must be an object of field → value")?;
        self.shared.with(session_id, |s| {
            let index = form.find(&s.entries)?;
            let Some(Entry::Ui { tree, answer, draft, draft_by, .. }) = s.entry_mut(index) else {
                return Err("no form at that index".to_owned());
            };
            if answer.is_some() {
                return Err("this form was already sent, so it's locked; render a new one to ask again".into());
            }
            let fields = form_fields(tree);
            let unknown: Vec<&String> = changes.keys().filter(|k| !fields.iter().any(|(n, _)| n == *k)).collect();
            if !unknown.is_empty() {
                let known: Vec<&str> = fields.iter().map(|(n, _)| n.as_str()).collect();
                return Err(format!("this form has no field {unknown:?}; its fields are {known:?}"));
            }
            let values = draft.get_or_insert_with(|| json!({}));
            let who = draft_by.get_or_insert_with(|| json!({}));
            for (k, v) in changes {
                values[k] = v.clone();
                who[k] = json!(by);
            }
            self.shared.emit_draft(s, index);
            self.shared.save(s);
            Ok(form_state(&s.entries[index]))
        })?
    }

    /// Where a form stands: its fields, current values (defaults overlaid with the
    /// draft), who changed what, and whether it was sent.
    pub fn form(&self, session_id: &str, form: FormRef<'_>) -> Result<Value, String> {
        self.shared.with(session_id, |s| Ok(form_state(&s.entries[form.find(&s.entries)?])))?
    }

    /// The folders a chat works in: its cwd and additional roots.
    pub fn session_roots(&self, session_id: &str) -> Vec<PathBuf> {
        self.shared.with_info(session_id, |i| std::iter::once(&i.cwd).chain(&i.additional_dirs).map(PathBuf::from).collect()).unwrap_or_default()
    }

    /// Add a UI entry to a chat's transcript (from the UI MCP server).
    /// An entry with a `ui_id` already in the chat replaces it; returns whether it did.
    pub fn push_ui(&self, session_id: &str, mut entry: Entry) -> bool {
        self.shared
            .with(session_id, |s| {
                let existing = match &entry {
                    Entry::Ui { ui_id: Some(id), .. } => {
                        s.entries.iter().rposition(|e| matches!(&**e, Entry::Ui { ui_id: Some(other), .. } if other == id))
                    }
                    _ => None,
                };
                let Some(i) = existing else {
                    self.shared.push(s, entry);
                    self.shared.save(s);
                    return false;
                };
                // Re-rendering a form keeps what was typed into it so far.
                if let (
                    Entry::Ui { answer: None, draft: Some(d), draft_by: Some(b), .. },
                    Entry::Ui { draft: new_draft @ None, draft_by: new_by, .. },
                ) = (&*s.entries[i], &mut entry)
                {
                    *new_draft = Some(d.clone());
                    *new_by = Some(b.clone());
                }
                s.entries[i] = Arc::new(entry);
                self.shared.emit_entry(s, i);
                self.shared.save(s);
                true
            })
            .unwrap_or(false)
    }

    /// Start a chat. In a project: cwd is its first folder, the other folders and
    /// the project's context folder are additional roots, and its brief goes with
    /// the first prompt. In a folder: a quick chat with just that folder.
    pub async fn new_session(&self, target: ChatTarget<'_>, account_id: &str) -> Result<SessionInfo, String> {
        self.new_session_with(target, account_id, &[], None).await
    }

    /// [`Hub::new_session`], with folders chosen up front. A quick chat keeps them
    /// as its own (`extra_dirs`), checked like [`Hub::add_dirs`]'s. A project's go
    /// to the project before the chat starts (`commands::new_session`), so they
    /// are ignored here.
    ///
    /// With `start` (an id the UI picked), how far it got goes to the UI as `session-starting`
    /// events ([`StartStage`]) while the agent starts and `session/new` runs.
    pub async fn new_session_with(
        &self,
        target: ChatTarget<'_>,
        account_id: &str,
        extra_dirs: &[String],
        start: Option<&str>,
    ) -> Result<SessionInfo, String> {
        let account = self.shared.profile(account_id)?;
        let stage = |stage: StartStage, servers: &[String]| {
            if let Some(id) = start {
                (self.shared.app)("session-starting", json!({ "startId": id, "stage": stage, "servers": servers }));
            }
        };
        let (cwd, additional_dirs, extra_dirs, project) = match target {
            ChatTarget::Project(p) => (p.cwd(), p.additional_dirs(), vec![], Some(p)),
            ChatTarget::Folder(dir) => {
                let extra = new_dirs(&dir, &[], extra_dirs)?;
                (dir, extra.clone(), extra, None)
            }
        };
        if self.live_agent(&account.id).is_none() {
            stage(StartStage::Agent, &[]);
        }
        let agent = self.agent(&account).await?;
        if !additional_dirs.is_empty() && !agent.caps.additional_dirs {
            return Err("this agent can't work across several folders (no additionalDirectories support)".into());
        }
        let mut params = json!({ "cwd": cwd, "mcpServers": [] });
        if !additional_dirs.is_empty() {
            params["additionalDirectories"] = json!(additional_dirs);
        }
        let ui_token = random_token();
        let guide = self.add_ui_server(&agent, &ui_token, None, &mut params);
        let servers = crate::mcp_servers::inject(&mut params, agent.caps.mcp_http, agent.caps.mcp_sse, &account);
        // The agent starts its MCP servers while it opens the session, in the one `session/new`.
        stage(if servers.is_empty() { StartStage::Session } else { StartStage::McpServers }, &servers);

        let res = agent.conn.request("session/new", params).await;
        let session_id = res
            .map_err(|e| self.shared.rpc_error(&account.id, &e, "session/new failed"))
            .and_then(|r| {
                r.get("sessionId")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .map(str::to_owned)
                    .ok_or_else(|| "session/new returned no sessionId".into())
            })
            .inspect_err(|_| {
                self.ui_tokens.lock().unwrap().remove(&ui_token);
            })?;

        let brief = project.and_then(|p| {
            let path = p.brief_path();
            std::fs::read_to_string(&path).ok().filter(|t| has_content(t)).map(|text| Brief { path: path.to_string_lossy().into_owned(), text })
        });
        let info = SessionInfo {
            session_id: session_id.clone(),
            project_id: project.map(|p| p.id.clone()),
            created_at: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs()),
            account_id: account.id,
            cwd,
            additional_dirs,
            title: "New chat".into(),
            running: false,
            stop_reason: None,
            commands: vec![],
            agent_session_id: None,
            handoff_from: None,
            extra_dirs,
            dirs_changed: false,
        };
        let mut session = Session::new(info.clone(), vec![], self.store.as_ref().map(|d| d.join(file_name(&session_id))));
        session.brief = brief;
        session.guide = guide;
        session.attached = Some(agent.generation);
        session.ui_token = Some(ui_token.clone());
        let chat = cell(session);
        let taken = {
            // An agent may only start new chats: an id yaah already has is another chat
            // (perhaps another agent's), which this one would take over and overwrite.
            let mut sessions = self.shared.sessions.lock().unwrap();
            let taken = sessions.contains_key(&session_id) || self.shared.aliases.lock().unwrap().contains_key(&session_id);
            if !taken {
                sessions.insert(session_id.clone(), chat.clone());
            }
            taken
        };
        let mut tokens = self.ui_tokens.lock().unwrap();
        if taken {
            tokens.remove(&ui_token);
            return Err(format!("the agent started a chat with the id of one yaah already has ({session_id}); refused"));
        }
        if let Some(slot) = tokens.get_mut(&ui_token) {
            *slot = Some(session_id);
        }
        drop(tokens);
        let mut s = chat.lock().unwrap();
        self.shared.save(&mut s);
        self.shared.emit_info(&mut s);
        Ok(info)
    }

    /// Give a chat its own URL on the UI MCP server (in `session/new` or
    /// `session/load` params). The token is registered first because the agent
    /// connects while the request is still running. Only for agents that can
    /// reach HTTP MCP servers (`mcpCapabilities.http`); others chat without UI tools.
    /// The agent is also told about the UI (`agent_guide.rs`); returns the guide
    /// when it has to go with the chat's first prompt.
    fn add_ui_server(&self, agent: &Agent, token: &str, session_id: Option<&str>, params: &mut Value) -> Option<String> {
        let (Some(port), true) = (self.ui_port.get(), agent.caps.mcp_http) else { return None };
        self.ui_tokens.lock().unwrap().insert(token.to_owned(), session_id.map(str::to_owned));
        params["mcpServers"] = json!([{
            "type": "http",
            "name": ui_mcp::SERVER_NAME,
            "url": format!("http://127.0.0.1:{port}/mcp/{token}"),
            "headers": [],
        }]);
        if agent.claude {
            // Claude Code: rendering into the chat shouldn't need a permission prompt each time.
            // Only the UI tools, by name: `source_read` (databases, Docker logs) still asks.
            params["_meta"] = json!({ "claudeCode": { "options": { "allowedTools": ui_mcp::allowed_tools() } } });
        }
        let traits = agent_guide::Traits { preset: &agent.preset, ui: true, system_prompt: agent.caps.system_prompt };
        self.guide.get().and_then(|g| g.deliver(&traits, params))
    }

    /// Reconnect a chat `agent` doesn't know (restored from disk, or its agent
    /// restarted), or reopen one whose folders changed, with `session/load` and
    /// the chat's folders as they are now. The agent replays the history as
    /// updates; we already have it, so those are ignored.
    async fn attach(&self, session_id: &str, agent: &Agent, account: &Profile) -> Result<(), String> {
        if !agent.caps.load_session {
            return Err("This agent can't reopen earlier chats. Start a new chat to continue.".into());
        }
        let (agent_session, cwd, additional_dirs) = self.shared.with(session_id, |s| {
            s.replaying = true;
            // Folders added from here on change it again, for the prompt after.
            s.info.dirs_changed = false;
            (s.info.agent_session().to_owned(), s.info.cwd.clone(), s.info.additional_dirs.clone())
        })?;
        let mut params = json!({ "sessionId": agent_session, "cwd": cwd, "mcpServers": [] });
        if !additional_dirs.is_empty() && agent.caps.additional_dirs {
            params["additionalDirectories"] = json!(additional_dirs);
        }
        // A reattached chat already had the first-prompt guide, if that was its route.
        let _ = self.add_ui_server(agent, &random_token(), Some(session_id), &mut params);
        crate::mcp_servers::inject(&mut params, agent.caps.mcp_http, agent.caps.mcp_sse, account);

        let res = agent.conn.request("session/load", params).await;
        let _ = self.shared.with(session_id, |s| {
            s.replaying = false;
            s.attached = res.is_ok().then_some(agent.generation);
            self.shared.save(s);
        });
        res.map(|_| ()).map_err(|e| self.shared.rpc_error(&account.id, &e, "Couldn't reopen this chat"))
    }

    /// Move a chat to another agent profile. The chat keeps its id and its
    /// transcript; its next prompt goes to the new agent in a fresh ACP session,
    /// with the conversation so far handed off ([`handoff_text`]).
    ///
    /// Switching back to an agent the chat used before also hands off: its old
    /// session is never reopened, since it missed what was said after the switch.
    /// Switching again before prompting keeps the agent the hand-off is from
    /// (the one in between never said anything).
    pub fn switch_agent(&self, session_id: &str, account_id: &str) -> Result<SessionInfo, String> {
        let to = self.shared.profile(account_id)?;
        self.shared.with(session_id, |s| {
            if s.info.running {
                return Err("Wait for the turn to end (or stop it) before switching agents.".to_owned());
            }
            if s.info.account_id == to.id {
                return Err(format!("This chat already uses {}.", to.label));
            }
            let from = self.shared.profiles.find(&s.info.account_id).map(|p| p.label);
            if s.info.handoff_from.is_none() {
                s.info.handoff_from = Some(from.clone().unwrap_or_else(|| s.info.account_id.clone()));
            }
            s.info.account_id.clone_from(&to.id);
            s.info.commands.clear();
            s.attached = None;
            s.brief = None;
            s.guide = None;
            self.shared.push(s, Entry::Switch { account_id: to.id.clone(), label: to.label.clone(), from });
            self.shared.emit_info(s);
            self.shared.save(s);
            Ok(s.info.clone())
        })?
    }

    /// Start the chat afresh with `agent` after a switch: `session/new` with the
    /// chat's folders, MCP servers (yaah's UI server at the chat's own token) and
    /// yaah's guide, and the project brief again. The new session id is recorded
    /// so this agent's updates reach the chat and later prompts (and reloads) use it.
    async fn hand_off(&self, session_id: &str, agent: &Agent, account: &Profile) -> Result<(), String> {
        let (cwd, additional_dirs, project_id, token) = self.shared.with(session_id, |s| {
            // The fresh session gets the folders as they are now.
            s.info.dirs_changed = false;
            (s.info.cwd.clone(), s.info.additional_dirs.clone(), s.info.project_id.clone(), s.ui_token.clone())
        })?;
        if !additional_dirs.is_empty() && !agent.caps.additional_dirs {
            return Err(format!(
                "{} can't work across several folders (no additionalDirectories support), and this chat uses {}. Switch to another agent.",
                account.label,
                additional_dirs.len() + 1
            ));
        }
        let mut params = json!({ "cwd": cwd, "mcpServers": [] });
        if !additional_dirs.is_empty() {
            params["additionalDirectories"] = json!(additional_dirs);
        }
        let token = token.unwrap_or_else(random_token);
        let guide = self.add_ui_server(agent, &token, Some(session_id), &mut params);
        crate::mcp_servers::inject(&mut params, agent.caps.mcp_http, agent.caps.mcp_sse, account);

        let res = agent.conn.request("session/new", params).await;
        let acp_id = res.map_err(|e| self.shared.rpc_error(&account.id, &e, "session/new failed")).and_then(|r| {
            r.get("sessionId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| "session/new returned no sessionId".to_owned())
        })?;
        if self.shared.taken_by_another(&acp_id, session_id) {
            return Err(format!("the agent started a session with the id of another chat yaah has ({acp_id}); refused"));
        }
        {
            let mut aliases = self.shared.aliases.lock().unwrap();
            aliases.retain(|_, chat| chat != session_id);
            if acp_id != session_id {
                aliases.insert(acp_id.clone(), session_id.to_owned());
            }
        }
        let brief = project_id.and_then(|id| project_brief(&id, &additional_dirs));
        self.shared.with(session_id, |s| {
            s.info.agent_session_id = (acp_id != session_id).then_some(acp_id);
            s.attached = Some(agent.generation);
            s.ui_token = Some(token);
            s.guide = guide;
            s.brief = brief;
            self.shared.save(s);
        })
    }

    /// The agent profile with this id.
    pub fn profile(&self, account_id: &str) -> Result<Profile, String> {
        self.shared.profile(account_id)
    }

    /// Login methods the profile's agent offers (ACP `authMethods`).
    pub async fn auth_methods(&self, account_id: &str) -> Result<Vec<Value>, String> {
        let account = self.shared.profile(account_id)?;
        Ok(self.agent(&account).await?.auth_methods)
    }

    /// Log in with an `agent`-type method: the agent does the work (often in a
    /// browser) and answers ACP `authenticate` when it's done.
    pub async fn authenticate(&self, account_id: &str, method_id: &str) -> Result<(), String> {
        let account = self.shared.profile(account_id)?;
        let agent = self.agent(&account).await?;
        agent.conn.request("authenticate", json!({ "methodId": method_id })).await.map_err(|e| format!("login failed: {e}"))?;
        self.logged_in(account_id);
        Ok(())
    }

    /// Whether the profile's agent asked for a login since its last one.
    pub fn needs_login(&self, account_id: &str) -> bool {
        self.shared.needs_login.lock().unwrap().contains(account_id)
    }

    /// What the profile's agent last reported it is signed in with.
    pub fn auth_status(&self, account_id: &str) -> Option<agents::AuthStatus> {
        self.shared.auth_status.lock().unwrap().get(account_id).cloned()
    }

    /// The profile as the UI is shown it, with its login state.
    pub fn info(&self, profile: Profile) -> agents::ProfileInfo {
        let (needs_login, reported) = (self.needs_login(&profile.id), self.auth_status(&profile.id));
        agents::info(profile, needs_login, reported.as_ref())
    }

    /// A login finished: stop asking for one.
    pub fn logged_in(&self, account_id: &str) {
        if self.shared.needs_login.lock().unwrap().remove(account_id) {
            (self.shared.app)("accounts-changed", Value::Null);
        }
    }

    /// Profiles whose agent process is running and was started from `preset`.
    pub fn running_with_preset(&self, preset: &str) -> Vec<String> {
        let agents = self.agents.lock().unwrap();
        agents.iter().filter(|(_, a)| a.preset == preset && a.conn.is_alive()).map(|(id, _)| id.clone()).collect()
    }

    /// Forget the profile's agent so the next chat starts one that sees fresh
    /// credentials (or an edited command). Its chats reattach to the new one.
    /// A turn still running keeps the old process until it ends.
    pub async fn drop_agent(&self, account_id: &str) {
        let gate = self.start_gate(account_id);
        let _starting = gate.lock().await;
        self.agents.lock().unwrap().remove(account_id);
        // The next agent reports its own sign-in.
        self.shared.auth_status.lock().unwrap().remove(account_id);
    }

    /// File a chat under a project, or under none. Its agent session keeps its
    /// folders; new chats in the project get the project's.
    pub fn set_session_project(&self, session_id: &str, project_id: Option<String>) -> Result<SessionInfo, String> {
        self.shared.with(session_id, |s| {
            s.info.project_id = project_id;
            self.shared.emit_info(s);
            self.shared.save(s);
            s.info.clone()
        })
    }

    /// Add folders to a chat as it goes (`add_chat_dirs`). Each must be an
    /// absolute path to a folder; ones the chat already has (its cwd included) and
    /// repeats are left out, and with nothing new nothing changes.
    ///
    /// In a project (`add_to_project` adds them there and returns the project; `None`
    /// when it no longer exists) they join the project, so this chat and every other
    /// chat in it get them ([`Hub::sync_project`]). Otherwise they are this chat's own
    /// (`extra_dirs`). Either way the agent works in them from the next prompt on: that
    /// prompt reopens the session with them first. Mid-turn the change waits for that
    /// prompt too, and the transcript's notice ([`Entry::AddedDirs`]) for the turn to end.
    pub fn add_dirs(
        &self,
        session_id: &str,
        paths: &[String],
        add_to_project: impl FnOnce(&str, &[String]) -> Result<Option<Project>, String>,
    ) -> Result<SessionInfo, String> {
        let (cwd, have, project_id, account_id) =
            self.shared.with_info(session_id, |i| (i.cwd.clone(), i.additional_dirs.clone(), i.project_id.clone(), i.account_id.clone()))?;
        let added = new_dirs(&cwd, &have, paths)?;
        if added.is_empty() {
            return self.session_info(session_id);
        }
        // What the agent said in `initialize` last time it ran; an agent not run yet is checked when it starts.
        if let Some(agent) = self.shared.profiles.find(&account_id)
            && agent.report.is_some_and(|r| !r.additional_dirs)
        {
            return Err(format!(
                "{} can't work across several folders (no additionalDirectories support). Switch to another agent first.",
                agent.label
            ));
        }
        let project = match &project_id {
            Some(id) => add_to_project(id, &added)?,
            None => None,
        };
        let to = match &project {
            Some(p) => {
                self.sync_project(p);
                "project"
            }
            None => "chat",
        };
        self.shared.with(session_id, |s| {
            if project.is_none() {
                for dir in &added {
                    if *dir != s.info.cwd && !s.info.additional_dirs.contains(dir) {
                        s.info.additional_dirs.push(dir.clone());
                    }
                    if !s.info.extra_dirs.contains(dir) {
                        s.info.extra_dirs.push(dir.clone());
                    }
                }
                s.info.dirs_changed = true;
            }
            let notice = Entry::AddedDirs { paths: added, to: to.to_owned() };
            if s.info.running {
                s.after_turn.push(notice);
            } else {
                self.shared.push(s, notice);
            }
            self.shared.emit_info(s);
            self.shared.save(s);
            s.info.clone()
        })
    }

    /// A project's folders changed: every chat in it gets them as they are now
    /// ([`project_chat_dirs`]), from its next prompt on. Chats whose folders
    /// already match are left alone. The UI hears that the project changed.
    pub fn sync_project(&self, project: &Project) {
        (self.shared.app)("projects-changed", json!({ "projectId": project.id }));
        for chat in self.shared.chats() {
            let mut s = chat.lock().unwrap();
            if s.info.project_id.as_deref() != Some(project.id.as_str()) {
                continue;
            }
            let dirs = project_chat_dirs(project, &s.info.cwd, &s.info.extra_dirs);
            if dirs == s.info.additional_dirs {
                continue;
            }
            // The whole chat is written with its info: read the entries first, if they weren't yet.
            s.ensure_loaded();
            s.info.additional_dirs = dirs;
            s.info.dirs_changed = true;
            self.shared.emit_info(&mut s);
            self.shared.save(&mut s);
        }
    }

    pub fn rename_session(&self, session_id: &str, title: &str) -> Result<SessionInfo, String> {
        let title = title.trim();
        if title.is_empty() {
            return Err("title can't be empty".into());
        }
        self.shared.with(session_id, |s| {
            s.info.title = truncate(title, TITLE_MAX_CHARS);
            self.shared.emit_info(s);
            self.shared.save(s);
            s.info.clone()
        })
    }

    /// Forget a chat and delete its saved transcript. The agent's own record
    /// (e.g. Claude Code's) is left alone.
    pub fn delete_session(&self, session_id: &str) -> Result<(), String> {
        let chat = self.shared.chat(session_id).ok_or("unknown session")?;
        let path = {
            // Under the chat's lock, so nothing changes or saves it in between.
            let mut s = chat.lock().unwrap();
            if s.info.running {
                return Err("stop the chat before deleting it".into());
            }
            let mut sessions = self.shared.sessions.lock().unwrap();
            if !sessions.get(session_id).is_some_and(|c| Arc::ptr_eq(c, &chat)) {
                return Err("unknown session".into());
            }
            sessions.remove(session_id);
            s.saving.dirty = false;
            s.save_to.take()
        };
        self.ui_tokens.lock().unwrap().retain(|_, sid| sid.as_deref() != Some(session_id));
        self.shared.aliases.lock().unwrap().retain(|_, chat| chat != session_id);
        self.shared.terminals.release_chat(session_id);
        // Tokens an agent process still holds stop working too, and the chat's previews close.
        if let Some(host) = self.ui_host.get().and_then(Weak::upgrade) {
            host.revoke(session_id);
        }
        if let Some(path) = path {
            // After any write of it already under way, so a save can't bring the file back.
            let _io = self.shared.io.lock().unwrap();
            if let Err(e) = std::fs::remove_file(&path)
                && e.kind() != std::io::ErrorKind::NotFound
            {
                eprintln!("[sessions] could not delete {}: {e}", path.display());
            }
        }
        Ok(())
    }

    /// Every chat's info. Reads no transcript.
    pub fn list_sessions(&self) -> Vec<SessionInfo> {
        self.shared.chats().iter().map(|c| c.lock().unwrap().info.clone()).collect()
    }

    /// A chat's info, without reading its transcript.
    pub fn session_info(&self, session_id: &str) -> Result<SessionInfo, String> {
        self.shared.with_info(session_id, SessionInfo::clone)
    }

    /// The whole transcript (read from disk if the chat wasn't opened yet).
    pub fn transcript(&self, session_id: &str) -> Result<Transcript, String> {
        self.shared.with(session_id, |s| Transcript { info: s.info.clone(), entries: s.entries.iter().map(|e| (**e).clone()).collect() })
    }

    /// Up to `limit` entries (default [`PAGE`]) from `from` on; without `from`,
    /// the last ones. Reads the transcript from disk if the chat wasn't opened yet.
    pub fn entries(&self, session_id: &str, from: Option<usize>, limit: Option<usize>) -> Result<Page, String> {
        let limit = limit.unwrap_or(PAGE);
        self.shared.with(session_id, |s| {
            let total = s.entries.len();
            let from = from.map_or_else(|| total.saturating_sub(limit), |f| f.min(total));
            let end = from.saturating_add(limit).min(total);
            Page { entries: s.entries[from..end].to_vec(), from, total }
        })
    }

    /// Start a prompt turn. Returns immediately; progress arrives as events.
    /// `mentions` are absolute paths of files the user referenced with @; they go
    /// to the agent as ACP `resource_link` blocks (baseline in every agent).
    /// Starts the chat's agent if it isn't running, and reattaches the chat to it.
    pub async fn prompt(&self, session_id: &str, text: String, mentions: Vec<String>) -> Result<(), String> {
        const BUSY: &str = "a turn is already running in this session";
        let (account_id, attached, handoff, dirs_changed) = self
            .shared
            .with(session_id, |s| {
                (!s.info.running).then(|| (s.info.account_id.clone(), s.attached, s.info.handoff_from.is_some(), s.info.dirs_changed))
            })?
            .ok_or(BUSY)?;
        let account = self.shared.profile(&account_id)?;
        let agent = self.agent(&account).await?;
        if handoff {
            self.hand_off(session_id, &agent, &account).await?;
        } else if dirs_changed && !agent.caps.load_session {
            // Folders were added and this agent can't reopen the session with them:
            // a fresh one, handed the conversation as a switch would.
            self.shared.with(session_id, |s| {
                s.info.handoff_from.get_or_insert_with(|| account.label.clone());
            })?;
            self.hand_off(session_id, &agent, &account).await?;
        } else if dirs_changed || attached != Some(agent.generation) {
            self.attach(session_id, &agent, &account).await?;
        }

        let blocks = self.shared.with(session_id, |s| {
            if s.info.running {
                return Err(BUSY);
            }
            s.info.running = true;
            s.info.stop_reason = None;
            s.plan_index = None;
            if s.entries.is_empty() {
                s.info.title = truncate(text.lines().next().unwrap_or_default(), TITLE_MAX_CHARS);
            }
            let mut blocks = vec![];
            let mut attachments = vec![];
            if let Some(brief) = s.brief.take() {
                let uri = format!("file://{}", brief.path);
                // Embed the text when the agent accepts it; a link is the ACP baseline otherwise.
                blocks.push(if agent.caps.embedded_context {
                    json!({ "type": "resource", "resource": { "uri": uri, "mimeType": "text/markdown", "text": brief.text } })
                } else {
                    json!({ "type": "resource_link", "uri": uri, "name": "project.md" })
                });
                attachments.push("project.md".to_owned());
            }
            if let Some(guide) = s.guide.take() {
                // An agent with no other way to hear about yaah's UI reads it first.
                blocks.insert(0, json!({ "type": "text", "text": guide }));
                attachments.insert(0, agent_guide::ATTACHMENT.to_owned());
            }
            // The first prompt to an agent the chat was switched to: what was said so far.
            if let Some(from) = s.info.handoff_from.take() {
                blocks.push(json!({ "type": "text", "text": handoff_text(&from, &s.entries) }));
                attachments.push(format!("hand-off from {from}"));
            }
            for path in mentions.iter().filter(|p| Path::new(p).is_absolute()) {
                let name = Path::new(path).file_name().map_or_else(|| path.clone(), |n| n.to_string_lossy().into_owned());
                blocks.push(json!({ "type": "resource_link", "uri": format!("file://{path}"), "name": name }));
                attachments.push(name);
            }
            blocks.push(json!({ "type": "text", "text": text }));
            self.shared.push(s, Entry::User { text, attachments });
            self.shared.emit_info(s);
            self.shared.save(s);
            Ok((blocks, s.info.agent_session().to_owned()))
        })??;

        let (blocks, agent_session) = blocks;
        let shared = self.shared.clone();
        let sid = session_id.to_owned();
        tauri::async_runtime::spawn(async move {
            let res = agent.conn.request("session/prompt", json!({ "sessionId": agent_session, "prompt": blocks })).await;
            let (stop, error) = match res {
                Ok(v) => (v.get("stopReason").and_then(Value::as_str).map(str::to_owned), None),
                // claude-agent-acp accepts session/new without a login and only fails here.
                Err(e) if e.code == acp::AUTH_REQUIRED => {
                    shared.mark_needs_login(&account_id);
                    (None, Some(Entry::Error { message: shared.not_logged_in(&account_id), login_account: Some(account_id) }))
                }
                Err(e) => (None, Some(Entry::error(e.to_string()))),
            };
            finish_turn(&shared, &sid, stop, error);
        });
        Ok(())
    }

    /// Stop the running turn: waiting permission requests are answered
    /// `cancelled`, the agent is told, and a waiting `ui_ask` is released.
    pub fn cancel(&self, session_id: &str) -> Result<(), String> {
        let (account_id, agent_session) = self.shared.with(session_id, |s| {
            for i in s.cancel_waiting("cancelled", |_| true) {
                self.shared.emit_entry(s, i);
            }
            (s.info.account_id.clone(), s.info.agent_session().to_owned())
        })?;
        if let Some(agent) = self.live_agent(&account_id) {
            agent.conn.notify("session/cancel", json!({ "sessionId": agent_session }));
        }
        self.cancel_asks(session_id);
        Ok(())
    }

    /// The user answered the permission request at `index` (`None` = cancelled).
    /// "Don't ask again" also answers the same request already waiting in this
    /// chat (the agent often asks several at once), and later ones, the same way.
    pub fn respond_permission(&self, session_id: &str, index: usize, option_id: Option<&str>) -> Result<(), String> {
        self.shared.with(session_id, |s| {
            let Some(Entry::Permission { request_id, options, chosen, title, .. }) = s.entry_mut(index) else {
                return Err("no permission request at that index".to_owned());
            };
            if chosen.is_some() {
                return Err("permission request already answered".into());
            }
            *chosen = Some(match option_id {
                Some(id) => option_name(options, id).unwrap_or_else(|| id.to_owned()),
                None => "cancelled".into(),
            });
            let kind = option_id.and_then(|id| option_kind(options, id));
            let (request_id, title) = (request_id.clone(), title.clone());
            let sent = s.waiting.remove(&index).is_some_and(|(_, r)| r.ok(request_id, outcome(option_id)));
            self.shared.emit_entry(s, index);

            if let Some(kind @ ("allow_always" | "reject_always")) = kind.as_deref()
                && title != UNNAMED_REQUEST
                && title != UNNAMED_TOOL
            {
                s.remembered.insert(title.clone(), kind.to_owned());
                let same: Vec<(usize, Value, String, String)> = (0..s.entries.len())
                    .filter_map(|i| match &*s.entries[i] {
                        Entry::Permission { request_id, options, chosen: None, title: t, .. } if *t == title => {
                            remembered_option(options, kind).map(|(id, name)| (i, request_id.clone(), id, name))
                        }
                        _ => None,
                    })
                    .collect();
                for (i, request_id, id, name) in same {
                    if let Some(Entry::Permission { chosen, .. }) = s.entry_mut(i) {
                        *chosen = Some(format!("{name} {REMEMBERED}"));
                    }
                    if let Some((_, r)) = s.waiting.remove(&i) {
                        r.ok(request_id, outcome(Some(&id)));
                    }
                    self.shared.emit_entry(s, i);
                }
            }
            self.shared.save(s);
            if sent { Ok(()) } else { Err("agent process is not running".into()) }
        })?
    }

    fn start_gate(&self, account_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.starting.lock().unwrap().entry(account_id.to_owned()).or_default().clone()
    }

    fn live_agent(&self, account_id: &str) -> Option<Agent> {
        self.agents.lock().unwrap().get(account_id).filter(|a| a.conn.is_alive()).cloned()
    }

    /// Get or start the agent process for a profile and run `initialize`.
    async fn agent(&self, account: &Profile) -> Result<Agent, String> {
        if let Some(a) = self.live_agent(&account.id) {
            return Ok(a);
        }
        let gate = self.start_gate(&account.id);
        let _starting = gate.lock().await;
        if let Some(a) = self.live_agent(&account.id) {
            return Ok(a);
        }

        // Claude Code: `ui_ask` holds its MCP call open until the user answers a form.
        let extra_env = if account.is_claude() { vec![("MCP_TOOL_TIMEOUT", ui_mcp::ASK_TIMEOUT.as_millis().to_string())] } else { vec![] };
        let generation = self.generations.fetch_add(1, Ordering::Relaxed);
        let (shared, exit_shared) = (self.shared.clone(), self.shared.clone());
        let account_id = account.id.clone();
        // A binary agent yaah installs (goose, OpenCode) is downloaded first; a provider binding becomes its route.
        agents::prepare(account).await?;
        let (conn, route) = agents::spawn_routed(
            account,
            move |msg, responder| match msg {
                Incoming::Notification { method, params } if agents::AuthStatus::is_update(&method) => {
                    shared.auth_status_update(&account_id, &params);
                }
                msg => handle_incoming(&shared, generation, msg, responder),
            },
            move |_| on_exit(&exit_shared, generation),
            &extra_env,
        )?;

        let init = agents::initialize(&conn).await?;
        let caps = Report::from_initialize(&init);
        self.shared.profiles.record_report(&account.id, &caps);
        (self.shared.app)("accounts-changed", Value::Null);
        if !caps.compatible {
            return Err(format!("agent negotiated unsupported ACP protocol version {:?}", caps.protocol_version));
        }
        // Claude on OpenRouter through ACP `providers/set`, before any `session/new`.
        crate::agent_routes::providers_set(&conn, &init, route.as_ref()).await?;

        let agent = Agent {
            conn,
            generation,
            auth_methods: init["authMethods"].as_array().cloned().unwrap_or_default(),
            caps,
            claude: account.is_claude(),
            preset: account.preset.clone(),
        };
        self.agents.lock().unwrap().insert(account.id.clone(), agent.clone());
        Ok(agent)
    }
}

impl Drop for Hub {
    fn drop(&mut self) {
        self.flush();
    }
}

/// Messages from agent process `generation`. It only speaks for the chats
/// attached to it: one process (another profile's agent, say) can't write into
/// or ask permission in a chat it didn't start or load.
fn handle_incoming(shared: &Shared, generation: u64, msg: Incoming, responder: &Responder) {
    match msg {
        Incoming::Notification { method, params } if method == "session/update" => {
            let Some(sid) = params.get("sessionId").and_then(Value::as_str) else { return };
            let _ = shared.with(sid, |s| {
                // While `session/load` replays, the chat isn't attached yet; replays are ignored anyway,
                // except an import's, which is the chat's history.
                if s.attached == Some(generation) || s.importing.as_ref().is_some_and(|i| i.generation == generation) {
                    apply_update(shared, s, &params["update"]);
                    shared.save(s);
                }
            });
        }
        Incoming::Notification { .. } => {}
        Incoming::Request { id, method, mut params } if method == "session/request_permission" => {
            let sid = params.get("sessionId").and_then(Value::as_str).unwrap_or_default().to_owned();
            let options = params.get_mut("options").map(Value::take).filter(Value::is_array).unwrap_or_else(|| json!([]));
            let tool_call = &params["toolCall"];
            let asked = shared.with(&sid, |s| {
                if s.attached != Some(generation) {
                    return false;
                }
                upsert_tool(shared, s, tool_call);
                let tool_call_id = tool_call.get("toolCallId").and_then(Value::as_str).map(str::to_owned);
                let title = tool_call
                    .get("title")
                    .and_then(Value::as_str)
                    .or_else(|| tool_call_id.as_deref().and_then(|t| tool_title(s, t)))
                    .unwrap_or(UNNAMED_REQUEST)
                    .to_owned();
                // The user already said "don't ask again" to exactly this in this chat: answer it the same way,
                // and still show it, marked, so nothing happens unseen.
                let remembered = s.remembered.get(&title).and_then(|kind| remembered_option(&options, kind));
                let chosen = remembered.map(|(option_id, name)| {
                    responder.ok(id.clone(), outcome(Some(&option_id)));
                    format!("{name} {REMEMBERED}")
                });
                let waiting = chosen.is_none();
                let i = shared.push(s, Entry::Permission { request_id: id.clone(), tool_call_id, title, options, chosen });
                if waiting {
                    s.waiting.insert(i, (generation, responder.clone()));
                }
                shared.save(s);
                true
            });
            if !asked.unwrap_or(false) {
                responder.ok(id, outcome(None));
            }
        }
        Incoming::Request { id, method, params } if crate::acp_terminals::handles(&method) => {
            crate::acp_terminals::handle(&shared.terminals, &TerminalChats { shared, generation }, generation, id, &method, &params, responder);
        }
        // fs/* is not advertised in our capabilities.
        Incoming::Request { id, method, .. } => {
            responder.method_not_found(id, &method);
        }
    }
}

/// The result of a `session/request_permission`: the chosen option, or `None` for cancelled.
fn outcome(option_id: Option<&str>) -> Value {
    match option_id {
        Some(id) => json!({ "outcome": { "outcome": "selected", "optionId": id } }),
        None => json!({ "outcome": { "outcome": "cancelled" } }),
    }
}

/// Add a notice, joining the notices just before it (and skipping one already shown there).
fn push_notice(shared: &Shared, s: &mut Session, notice: Notice) {
    if let Some(i) = s.entries.len().checked_sub(1)
        && let Entry::Notices { items } = &*s.entries[i]
    {
        if !items.contains(&notice) {
            if let Some(Entry::Notices { items }) = s.entry_mut(i) {
                items.push(notice);
            }
            shared.emit_entry(s, i);
        }
        return;
    }
    shared.push(s, Entry::Notices { items: vec![notice] });
}

/// codex-acp reports MCP startup as failed tool calls titled `mcp__<server>__startup` (ids
/// `mcp_startup.…`): a server it didn't start because Codex's config already has one by that
/// name, or one that failed or was cancelled. They are notices, not tool calls: the first an
/// info line, the others in the chat's MCP notices.
fn mcp_startup_notice(update: &Value) -> Option<Notice> {
    let title = update["title"].as_str().unwrap_or_default();
    let server = title.strip_prefix("mcp__").and_then(|t| t.strip_suffix("__startup"));
    let by_id = update["toolCallId"].as_str().is_some_and(|id| id.starts_with("mcp_startup."));
    let failed_startup = server.is_some() && update["status"] == "failed";
    if !by_id && !failed_startup {
        return None;
    }
    let server = server.or_else(|| update["toolCallId"].as_str()?.strip_prefix("mcp_startup.")?.split('.').next()).unwrap_or("?").to_owned();
    let message = update["content"].as_array().into_iter().flatten().filter_map(|c| c["content"]["text"].as_str()).collect::<Vec<_>>().join("\n");
    let quoted = format!("MCP server \"{server}\"");
    let notice = |severity: &str, title: String, description: Option<String>| Notice {
        severity: severity.into(),
        title,
        description,
        mcp_server: Some(server.clone()),
    };
    if message.contains("already defines an MCP server with this name") {
        return Some(notice("info", format!("Codex uses its own {server}"), None));
    }
    if message.contains("startup was cancelled") {
        return Some(notice("warning", format!("{quoted} startup was cancelled"), None));
    }
    // "[codex-acp forwarded startup error] MCP server `x` failed to start: <why>"
    let why = message.split_once("failed to start:").map_or(message.as_str(), |(_, w)| w).trim();
    Some(notice("warning", format!("{quoted} didn't start"), Some(why.to_owned()).filter(|w| !w.is_empty())))
}

fn apply_update(shared: &Shared, s: &mut Session, update: &Value) {
    if s.replaying {
        return;
    }
    let kind = update.get("sessionUpdate").and_then(Value::as_str).unwrap_or_default();
    let claude_meta = &update["_meta"]["claudeCode"];
    // The bold-label text some agents send in place of a notice (no notice support on our side, or an older agent).
    if kind == "agent_message_chunk" && claude_meta["kind"] == "mcpServerStatus" {
        let text = content_text(&update["content"]);
        let (title, description) = match text.trim().strip_prefix("**").and_then(|t| t.split_once(":**")) {
            Some((t, d)) => (t.to_owned(), Some(d.trim().to_owned()).filter(|d| !d.is_empty())),
            None => (text.trim().trim_matches('*').to_owned(), None),
        };
        let severity = if claude_meta["status"] == "failed" { "warning" } else { "info" };
        let mcp_server = claude_meta["server"].as_str().map(str::to_owned);
        return push_notice(shared, s, Notice { severity: severity.into(), title, description, mcp_server });
    }
    if matches!(kind, "tool_call" | "tool_call_update")
        && let Some(notice) = mcp_startup_notice(update)
    {
        return push_notice(shared, s, notice);
    }
    match kind {
        "notice" => {
            let title = update["title"].as_str().unwrap_or("Notice").to_owned();
            // The server name, when the title is about one: `MCP server "x" …`.
            let mcp_server = title.strip_prefix("MCP server \"").and_then(|r| r.split_once('"')).map(|(n, _)| n.to_owned());
            let notice = Notice {
                severity: update["severity"].as_str().unwrap_or("info").to_owned(),
                title,
                description: update["description"].as_str().map(str::to_owned),
                mcp_server,
            };
            push_notice(shared, s, notice);
        }
        "agent_message_chunk" | "agent_thought_chunk" => {
            let thought = kind == "agent_thought_chunk";
            let text = content_text(&update["content"]);
            let message_id = update.get("messageId").and_then(Value::as_str);
            // Chunks of the same message (or thought) join the entry they continue, and go to the UI as appends.
            let continued = s.entries.len().checked_sub(1).filter(|&i| match &*s.entries[i] {
                Entry::Agent { message_id: m, .. } => !thought && same_message(m.as_deref(), message_id),
                Entry::Thought { message_id: m, .. } => thought && same_message(m.as_deref(), message_id),
                _ => false,
            });
            if let Some(i) = continued {
                shared.append(s, i, &text);
            } else {
                let message_id = message_id.map(str::to_owned);
                let len = text.encode_utf16().count();
                let i = shared.push(s, if thought { Entry::Thought { text, message_id } } else { Entry::Agent { text, message_id } });
                s.stream.text_len = Some((i, len));
            }
        }
        "tool_call" | "tool_call_update" => upsert_tool(shared, s, update),
        "plan" => {
            let entry = Entry::Plan { entries: update.get("entries").cloned().unwrap_or_else(|| json!([])) };
            match s.plan_index {
                Some(i) => {
                    s.entries[i] = Arc::new(entry);
                    shared.emit_entry(s, i);
                }
                None => s.plan_index = Some(shared.push(s, entry)),
            }
        }
        // user_message_chunk only appears when replaying a loaded session: skipped, unless it's an import's.
        "user_message_chunk" if s.importing.is_some() => resume::user_chunk(shared, s, update),
        "available_commands_update" => {
            s.info.commands = update.get("availableCommands").and_then(Value::as_array).cloned().unwrap_or_default();
            // An import's chat reaches the UI once it is in (`Hub::import_agent_session`).
            if s.importing.is_none() {
                shared.emit_info(s);
            }
        }
        // current_mode_update, config options, etc. are not rendered yet.
        _ => {}
    }
}

/// Insert a tool call, or merge the non-null fields of an update into it.
fn upsert_tool(shared: &Shared, s: &mut Session, update: &Value) {
    let Some(id) = update.get("toolCallId").and_then(Value::as_str) else { return };
    let field = |k: &str| update.get(k).filter(|v| !v.is_null()).cloned();
    let str_field = |k: &str| update.get(k).and_then(Value::as_str).map(str::to_owned);

    let Some(&i) = s.tool_index.get(id) else {
        let entry = Entry::Tool {
            tool_call_id: id.to_owned(),
            title: str_field("title").unwrap_or_else(|| UNNAMED_TOOL.into()),
            kind: str_field("kind"),
            status: str_field("status"),
            content: field("content").unwrap_or_else(|| json!([])),
            locations: field("locations").unwrap_or_else(|| json!([])),
            raw_input: field("rawInput").unwrap_or_default(),
        };
        let i = shared.push(s, entry);
        s.tool_index.insert(id.to_owned(), i);
        return;
    };
    // The whole tool entry goes again (`session-entry`): updates replace fields wholesale, so a diff would save little.
    if let Some(Entry::Tool { title, kind, status, content, locations, raw_input, .. }) = s.entry_mut(i) {
        if let Some(v) = str_field("title") {
            *title = v;
        }
        for (slot, key) in [(kind, "kind"), (status, "status")] {
            if let Some(v) = str_field(key) {
                *slot = Some(v);
            }
        }
        for (slot, key) in [(content, "content"), (locations, "locations"), (raw_input, "rawInput")] {
            if let Some(mut v) = field(key) {
                // A released terminal's kept output stays when the agent sends the content again.
                terminal_chats::carry_kept(slot, &mut v);
                *slot = v;
            }
        }
    }
    shared.emit_entry(s, i);
}

/// A turn ended: what's left of its text goes to the UI before the chat stops
/// running, and the transcript is written now rather than in a moment.
fn finish_turn(shared: &Shared, sid: &str, stop: Option<String>, error: Option<Entry>) {
    let _ = shared.with(sid, |s| {
        s.info.running = false;
        s.info.stop_reason = stop;
        if let Some(entry) = error {
            shared.push(s, entry);
        }
        for entry in std::mem::take(&mut s.after_turn) {
            shared.push(s, entry);
        }
        shared.emit_info(s);
        shared.save_now(s);
    });
}

/// An agent process ended. Its running turns end on their own (their
/// `session/prompt` fails with the exit reason); what it still asked can't be
/// answered, even in chats that moved on to a newer process.
fn on_exit(shared: &Shared, generation: u64) {
    eprintln!("[acp] agent #{generation} exited");
    // The commands it ran in terminals go with it.
    shared.terminals.release_generation(generation);
    // One chat at a time, and without reading transcripts: a chat not opened yet has nothing waiting.
    for chat in shared.chats() {
        let s = &mut *chat.lock().unwrap();
        if s.attached == Some(generation) {
            s.attached = None;
        }
        let changed = s.cancel_waiting("cancelled (the agent stopped)", |g| g == generation);
        for &i in &changed {
            shared.emit_entry(s, i);
        }
        if !changed.is_empty() {
            shared.save(s);
        }
    }
}

/// Which form: by transcript index (the app) or by the id the agent rendered it with.
#[derive(Clone, Copy)]
pub enum FormRef<'a> {
    Index(usize),
    UiId(&'a str),
}

impl FormRef<'_> {
    fn find(&self, entries: &[Arc<Entry>]) -> Result<usize, String> {
        let is_form = |e: &Entry| matches!(e, Entry::Ui { tree, .. } if !form_fields(tree).is_empty());
        match self {
            FormRef::Index(i) => entries.get(*i).filter(|e| is_form(e)).map(|_| *i).ok_or_else(|| "no form at that index".into()),
            FormRef::UiId(id) => entries
                .iter()
                .rposition(|e| matches!(&**e, Entry::Ui { ui_id: Some(other), .. } if other == id))
                .filter(|i| is_form(&entries[*i]))
                .ok_or_else(|| format!("no form rendered with id `{id}`; render one with ui_render and an `id` first")),
        }
    }
}

/// Nodes whose value lives in the UI entry's draft. `diffreview` keeps its viewed ticks there (by range), so they survive re-renders.
const INPUTS: &[&str] = &["textfield", "choice", "select", "slider", "rank", "toggle", "diffreview"];

/// The input fields in a UI tree, with their literal defaults, in order.
pub fn form_fields(tree: &Value) -> Vec<(String, Value)> {
    fn walk(node: &Value, out: &mut Vec<(String, Value)>) {
        let Some(o) = node.as_object() else { return };
        if o.get("type").and_then(Value::as_str).is_some_and(|t| INPUTS.contains(&t))
            && let Some(name) = o.get("props").and_then(|p| p["name"].as_str())
            && !out.iter().any(|(n, _)| n == name)
        {
            let default = o["props"].get("default").filter(|d| !d.as_str().is_some_and(|s| s.contains("{{"))).cloned().unwrap_or_default();
            out.push((name.to_owned(), default));
        }
        for key in ["children", "else"] {
            for kid in o.get(key).and_then(Value::as_array).into_iter().flatten() {
                walk(kid, out);
            }
        }
        if let Some(inner) = o.get("tree") {
            walk(inner, out); // an expanded library component
        }
    }
    let mut out = vec![];
    walk(tree, &mut out);
    out
}

fn form_state(entry: &Entry) -> Value {
    let Entry::Ui { tree, answer, draft, draft_by, .. } = entry else { return Value::Null };
    let fields = form_fields(tree);
    let values: serde_json::Map<String, Value> =
        fields.iter().map(|(name, default)| (name.clone(), draft.as_ref().and_then(|d| d.get(name)).unwrap_or(default).clone())).collect();
    json!({
        "fields": fields.iter().map(|(n, _)| n).collect::<Vec<_>>(),
        "values": answer.clone().filter(|a| a.get("$cancelled").is_none()).unwrap_or(Value::Object(values)),
        "editedBy": draft_by.clone().unwrap_or_else(|| json!({})),
        "sent": answer.is_some(),
    })
}

/// 128 random bits as hex, from the OS-seeded hasher keys.
pub fn random_token() -> String {
    crate::random::token()
}

/// The file a chat is saved in. The agent chose its id, so only a plain one is
/// used as is (no separators, not hidden, not huge); any other is hashed. The id
/// itself is read back from the file, not its name.
fn file_name(id: &str) -> String {
    use sha2::{Digest, Sha256};
    let plain = (1..=128).contains(&id.len()) && !id.starts_with('.') && id.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    if plain { format!("{id}.json") } else { format!("{:x}.json", Sha256::digest(id)) }
}

/// A project's brief, found through the chat's folders (the project's context
/// folder, `~/.yaah/projects/<id>`, is one of them), when it says something.
fn project_brief(project_id: &str, dirs: &[String]) -> Option<Brief> {
    let dir = dirs
        .iter()
        .map(Path::new)
        .find(|d| d.file_name().is_some_and(|n| n == project_id) && d.parent().is_some_and(|p| p.ends_with(".yaah/projects")))?;
    let path = dir.join("project.md");
    let text = std::fs::read_to_string(&path).ok().filter(|t| has_content(t))?;
    Some(Brief { path: path.to_string_lossy().into_owned(), text })
}

/// The folders in `paths` a chat in `cwd` with `have` doesn't have yet, in order.
/// Each must be an absolute path to an existing folder (a trailing `/` is dropped);
/// any that isn't fails the whole call. Repeats, the cwd and folders in `have` are left out.
pub fn new_dirs(cwd: &str, have: &[String], paths: &[String]) -> Result<Vec<String>, String> {
    let trim = |d: &str| match d.trim_end_matches('/') {
        "" => "/".to_owned(),
        t => t.to_owned(),
    };
    let cwd = trim(cwd);
    let have: Vec<String> = have.iter().map(|d| trim(d)).collect();
    let mut out: Vec<String> = vec![];
    for path in paths {
        let dir = crate::projects::validate_dir(path.trim())?;
        if dir != cwd && !have.contains(&dir) && !out.contains(&dir) {
            out.push(dir);
        }
    }
    Ok(out)
}

/// The folders besides `cwd` a chat in `project` works in: the project's own
/// (its first one too, for a chat that runs elsewhere), its context folder, and
/// the chat's own `extra` ones, each once and in that order.
pub fn project_chat_dirs(project: &Project, cwd: &str, extra: &[String]) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let all = std::iter::once(project.cwd()).chain(project.additional_dirs()).chain(extra.iter().cloned());
    for dir in all {
        if dir != cwd && !out.contains(&dir) {
            out.push(dir);
        }
    }
    out
}

/// At most this many characters of conversation go to an agent taking over a chat.
pub const HANDOFF_MAX_CHARS: usize = 40_000;

/// What an agent taking over a chat is told: the conversation so far, oldest
/// first. Messages in full; tool calls, UI and switches as one line each;
/// thoughts, plans, permissions and notices left out. Past [`HANDOFF_MAX_CHARS`]
/// the newest entries are kept and the omission is noted.
pub fn handoff_text(from: &str, entries: &[Arc<Entry>]) -> String {
    use std::fmt::Write;
    let lines: Vec<String> = entries
        .iter()
        .filter_map(|e| match &**e {
            Entry::User { text, .. } => Some(format!("User: {}", text.trim())),
            Entry::Agent { text, .. } if !text.trim().is_empty() => Some(format!("Agent: {}", text.trim())),
            Entry::Tool { title, status, .. } => {
                Some(format!("[tool] {} ({})", truncate(title.lines().next().unwrap_or_default(), 200), status.as_deref().unwrap_or("unknown")))
            }
            Entry::Ui { title, component, .. } => Some(format!("[UI] {}", title.as_deref().or(component.as_deref()).unwrap_or("UI"))),
            Entry::Switch { label, .. } => Some(format!("[switched to {label}]")),
            Entry::AddedDirs { paths, to } => Some(format!("[added {} to this {to}]", paths.join(", "))),
            Entry::Error { message, .. } => Some(format!("[error] {}", truncate(message.lines().next().unwrap_or_default(), 200))),
            _ => None,
        })
        .collect();
    let mut kept: Vec<String> = vec![];
    let mut size = 0;
    for line in lines.iter().rev() {
        let n = line.chars().count() + 2;
        if size + n > HANDOFF_MAX_CHARS {
            // The newest entry alone is too long: keep its end.
            if kept.is_empty() {
                let tail: String = line.chars().skip(n - HANDOFF_MAX_CHARS).collect();
                kept.push(format!("…{tail}"));
            }
            break;
        }
        size += n;
        kept.push(line.clone());
    }
    kept.reverse();
    let mut out = format!("You're taking over this chat from {from}. The conversation so far:\n\n");
    let left_out = lines.len() - kept.len();
    if left_out > 0 {
        let what = if left_out == 1 { "entry" } else { "entries" };
        let _ = write!(out, "({left_out} earlier {what} left out)\n\n");
    }
    if kept.is_empty() {
        out.push_str("(nothing yet)");
    }
    out.push_str(&kept.join("\n\n"));
    out
}

/// A brief is worth sending once it says more than its `# Title` line.
fn has_content(brief: &str) -> bool {
    brief.lines().any(|l| !l.trim().is_empty() && !l.trim_start().starts_with("# "))
}

fn same_message(current: Option<&str>, incoming: Option<&str>) -> bool {
    match (current, incoming) {
        (Some(a), Some(b)) => a == b,
        _ => true,
    }
}

fn tool_title<'a>(s: &'a Session, tool_call_id: &str) -> Option<&'a str> {
    match s.tool_index.get(tool_call_id).map(|&i| &*s.entries[i]) {
        Some(Entry::Tool { title, .. }) => Some(title),
        _ => None,
    }
}

fn option_with<'a>(options: &'a Value, option_id: &str) -> Option<&'a Value> {
    options.as_array()?.iter().find(|o| o["optionId"] == option_id)
}

fn option_kind(options: &Value, option_id: &str) -> Option<String> {
    option_with(options, option_id)?["kind"].as_str().map(str::to_owned)
}

fn option_name(options: &Value, option_id: &str) -> Option<String> {
    option_with(options, option_id)?["name"].as_str().map(str::to_owned)
}

/// The option that carries out a remembered choice: the same kind, else its one-off form.
fn remembered_option(options: &Value, kind: &str) -> Option<(String, String)> {
    let once = if kind == "allow_always" { "allow_once" } else { "reject_once" };
    let list = options.as_array()?;
    let o = list.iter().find(|o| o["kind"] == kind).or_else(|| list.iter().find(|o| o["kind"] == once))?;
    Some((o["optionId"].as_str()?.to_owned(), o["name"].as_str().unwrap_or(kind).to_owned()))
}

/// Plain-text rendering of an ACP `ContentBlock`.
fn content_text(block: &Value) -> String {
    let s = |k: &str| block.get(k).and_then(Value::as_str).unwrap_or_default();
    match s("type") {
        "text" => s("text").to_owned(),
        "resource_link" => format!("[{}]({})", s("name"), s("uri")),
        "resource" => block["resource"].get("text").or_else(|| block["resource"].get("uri")).and_then(Value::as_str).unwrap_or_default().to_owned(),
        "image" => "[image]".into(),
        "audio" => "[audio]".into(),
        _ => String::new(),
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_owned() } else { s.chars().take(max - 1).collect::<String>() + "…" }
}

#[cfg(test)]
fn test_info(id: &str) -> SessionInfo {
    SessionInfo {
        session_id: id.into(),
        project_id: None,
        created_at: 0,
        account_id: "default".into(),
        cwd: std::env::temp_dir().to_string_lossy().into(),
        additional_dirs: vec![],
        title: "t".into(),
        running: true,
        stop_reason: None,
        commands: vec![],
        agent_session_id: None,
        handoff_from: None,
        extra_dirs: vec![],
        dirs_changed: false,
    }
}

/// Drives a real chat through the Hub, against a real agent and account.
/// Spends a little of the account's usage, so it is opt-in:
///
/// `YAAH_LIVE_ACCOUNT=default cargo test --lib live_chat -- --ignored --nocapture`
///
/// Set `YAAH_RECORD=<file>` to save every event the UI would receive.
#[cfg(test)]
mod live_tests {
    use super::*;
    use crate::projects::Status;
    use crate::ui_library::{Bundled, Library, LocalDir};
    use std::path::PathBuf;
    use std::sync::mpsc;

    struct Run {
        events: Vec<Value>,
        entries: Vec<Entry>,
        root: PathBuf,
    }

    /// What the unattended harness may approve: writes inside the test folder
    /// and a few read-only or screenshot commands. Everything else is rejected.
    fn harness_allows(title: &str, root: &std::path::Path) -> bool {
        // On macOS the temp folder is /var/… but agents see and write /private/var/…: accept both spellings.
        let real = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        let roots = [root.to_string_lossy().into_owned(), real.to_string_lossy().into_owned()];
        if let Some(path) = title.strip_prefix("Write ").or_else(|| title.strip_prefix("Edit ")) {
            // Absolute paths must be inside the test folder; relative ones are relative to it.
            let inside = roots.iter().any(|r| path.starts_with(r.as_str())) || !(path.starts_with('/') || path.starts_with('~'));
            return inside && !path.contains("..");
        }
        let chained = [";", "&&", "||", "|", "`", "$(", ">", "<"].iter().any(|c| title.contains(c));
        let safe_git = ["git add -N", "git diff", "git status", "git log", "git show", "git branch"].iter().any(|p| title.starts_with(p));
        // Read-only looks around the test folder, and running its own tests.
        let read_only = ["find ", "wc ", "ls", "cat ", "tree", "node --test"].iter().any(|p| title.starts_with(p));
        let screenshot = title.contains("Google Chrome") && title.contains("--headless") && title.contains("--screenshot");
        !chained && (safe_git || read_only || screenshot)
    }

    /// Fill every input in a form: first option, middle of a slider, reversed ranking, some text.
    fn auto_answer(tree: &Value) -> Value {
        fn walk(n: &Value, out: &mut serde_json::Map<String, Value>) {
            if let Some(a) = n.as_array() {
                return a.iter().for_each(|x| walk(x, out));
            }
            let Some(o) = n.as_object() else { return };
            let p = &o.get("props").cloned().unwrap_or_default();
            if let Some(name) = p["name"].as_str() {
                let first = || p["options"].get(0).and_then(|x| x.get("value")).cloned().unwrap_or(Value::Null);
                let v = match o.get("type").and_then(Value::as_str).unwrap_or_default() {
                    "choice" if p["multiple"] == true => json!([first()]),
                    "choice" | "select" => first(),
                    "slider" => json!(f64::midpoint(p["min"].as_f64().unwrap_or(0.0), p["max"].as_f64().unwrap_or(100.0))),
                    "rank" => Value::Array(
                        p["items"].as_array().cloned().unwrap_or_default().iter().rev().filter_map(|i| i.get("value").cloned()).collect(),
                    ),
                    "toggle" => json!(true),
                    _ => json!("Something I can show friends; I like tinkering with hardware."),
                };
                out.insert(name.to_owned(), v);
            }
            for k in ["children", "else", "tree"] {
                if let Some(c) = o.get(k) {
                    walk(c, out);
                }
            }
        }
        let mut out = serde_json::Map::new();
        walk(tree, &mut out);
        Value::Object(out)
    }

    /// Run one prompt in a fresh project. Permission requests go through
    /// `harness_allows`; nothing outside it is approved.
    /// With `ui`, the UI MCP server runs against a library in a temp folder.
    fn run_chat(prompt: &str, ui: bool) -> (Run, Arc<Library>) {
        run_chat_in(prompt, ui, None)
    }

    /// Like `run_chat`, but in `dir` (kept afterwards) when given.
    fn run_chat_in(prompt: &str, ui: bool, dir: Option<PathBuf>) -> (Run, Arc<Library>) {
        run_turns(&[prompt], ui, dir, |_, _, _| {})
    }

    /// Several prompts in one chat; `between(hub, session, turn)` runs before each
    /// prompt after the first, as the user acting in the UI between messages.
    fn run_turns(prompts: &[&str], ui: bool, dir: Option<PathBuf>, between: impl Fn(&Hub, &str, usize)) -> (Run, Arc<Library>) {
        let account = std::env::var("YAAH_LIVE_ACCOUNT").unwrap_or_else(|_| "default".into());
        let ui = if ui { Ui::On } else { Ui::Off };
        run_turns_as(Store::user(), &account, prompts, ui, dir, between, |_, _, _, _| {})
    }

    /// How a live chat gets yaah's UI server.
    #[derive(Clone, Copy, PartialEq)]
    enum Ui {
        Off,
        On,
        /// Advertised at a port nothing listens on: the MCP server can't start.
        Dead,
    }

    /// [`run_turns`] as `account` from `profiles`, with `on_event(hub, session, event, payload)`
    /// called on every event the UI would get (to act mid-turn, say).
    fn run_turns_as(
        profiles: &'static Store,
        account: &str,
        prompts: &[&str],
        ui: Ui,
        dir: Option<PathBuf>,
        between: impl Fn(&Hub, &str, usize),
        on_event: impl Fn(&Hub, &str, &str, &Value),
    ) -> (Run, Arc<Library>) {
        let (tx, rx) = mpsc::channel::<(String, Value)>();
        let tx = Mutex::new(tx);
        let hub = Arc::new(Hub::open(
            Arc::new(move |name: &str, payload: Value| {
                let _ = tx.lock().unwrap().send((name.to_owned(), payload));
            }),
            None,
            profiles,
        ));
        let ui_on = ui == Ui::On;

        let root = dir.unwrap_or_else(|| std::env::temp_dir().join(format!("yaah-live-{}-{}", std::process::id(), random_token())));
        let (repo, ctx) = (root.join("repo"), root.join("ctx"));
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&ctx).unwrap();
        // As in the app: the components yaah ships, then what agents build.
        let library = Arc::new(Library::with_sources(vec![Box::new(Bundled::new()), Box::new(LocalDir::new(root.join("components")))]));
        if ui == Ui::Dead {
            // A port that was free a moment ago: the agent is told about a server that isn't there.
            let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
            hub.set_ui_port(free);
        }
        if ui_on {
            let host = Arc::new(ui_mcp::UiHost::new(hub.clone(), library.clone(), Arc::new(crate::sources::Sources::new())));
            hub.set_ui_port(ui_mcp::start(host).unwrap());
            // As in the app, the agent is told about the UI; its skills go in the test folder, not ~/.yaah.
            let lib = library.clone();
            hub.set_guide(Arc::new(Guide::new(root.join("yaah-home"), move || agent_guide::component_names(&lib), || true)));
        }
        let project = Project {
            id: "live".into(),
            name: "live".into(),
            dirs: vec![repo.to_string_lossy().into()],
            status: Status::Ongoing,
            created_at: 0,
            context_dir: ctx.to_string_lossy().into(),
            link: None,
            agent_id: None,
        };

        let mut events = vec![];
        let sid = tauri::async_runtime::block_on(async {
            let info = hub.new_session(ChatTarget::Project(&project), account).await.expect("new_session");
            hub.prompt(&info.session_id, prompts[0].to_string(), vec![]).await.unwrap();
            let mut started = false;
            let mut turn = 0;
            loop {
                let (name, payload) = rx.recv_timeout(Duration::from_secs(300)).expect("agent went quiet");
                on_event(&hub, &info.session_id, &name, &payload);
                events.push(json!({ "event": name, "payload": payload }));
                let entry = &payload["entry"];
                // Answer forms the agent is waiting on (ui_ask) the way a person would.
                if name == "session-entry" && entry["type"] == "ui" && !entry["askId"].is_null() && entry["answer"].is_null() {
                    let values = auto_answer(&entry["tree"]);
                    println!("answering form: {values}");
                    let index = usize::try_from(payload["index"].as_u64().unwrap()).unwrap();
                    hub.answer_ui(&info.session_id, index, values).await.unwrap();
                }
                if name == "session-entry" && entry["type"] == "permission" && entry["chosen"].is_null() {
                    let options = entry["options"].as_array().unwrap();
                    let title = entry["title"].as_str().unwrap_or_default();
                    let kind = if harness_allows(title, &root) { "allow_once" } else { "reject_once" };
                    let choice = options.iter().find(|o| o["kind"] == kind);
                    println!("permission: {title} -> {}", choice.map_or("cancelled", |o| o["name"].as_str().unwrap_or("?")));
                    let index = usize::try_from(payload["index"].as_u64().unwrap()).unwrap();
                    let option = choice.and_then(|o| o["optionId"].as_str()).map(str::to_owned);
                    hub.respond_permission(&info.session_id, index, option.as_deref()).unwrap();
                }
                if name == "session-info" {
                    if payload["running"] == true {
                        started = true;
                    } else if started {
                        println!("stopReason: {}", payload["stopReason"]);
                        turn += 1;
                        let Some(next) = prompts.get(turn) else { break };
                        between(&hub, &info.session_id, turn);
                        started = false;
                        hub.prompt(&info.session_id, next.to_string(), vec![]).await.unwrap();
                    }
                }
            }
            info.session_id
        });

        let entries = hub.transcript(&sid).unwrap().entries;
        for e in &entries {
            let v = serde_json::to_value(e).unwrap();
            let text = v["text"].as_str().or(v["title"].as_str()).or(v["component"].as_str()).unwrap_or_default();
            println!("  {:<10} {:<10} {}", v["type"].as_str().unwrap(), v["status"].as_str().unwrap_or(""), text.replace('\n', " "));
        }
        if let Ok(path) = std::env::var("YAAH_RECORD") {
            std::fs::write(&path, serde_json::to_string_pretty(&events).unwrap()).unwrap();
        }
        (Run { events, entries, root }, library)
    }

    /// `YAAH_LIVE_ACCOUNT=default cargo test --lib live_chat -- --ignored --nocapture`
    #[test]
    #[ignore = "talks to a real agent and spends some of the account's usage"]
    fn live_chat_with_permission() {
        let (run, _) = run_chat(
            "Use your Write tool to create hello.txt in the current directory containing exactly `hi from yaah`, then reply with one short sentence.",
            false,
        );
        let written = std::fs::read_to_string(run.root.join("repo/hello.txt")).unwrap_or_default();
        std::fs::remove_dir_all(&run.root).unwrap();
        assert_eq!(written.trim(), "hi from yaah", "the file the agent was asked to write");
        assert!(run.entries.iter().any(|e| matches!(e, Entry::Tool { status: Some(s), .. } if s == "completed")));
        assert!(run.entries.iter().any(|e| matches!(e, Entry::Agent { text, .. } if !text.is_empty())));
        assert_ne!(run.events.len(), 0);
    }

    /// Many kinds of dynamic UI in one chat: data table, charts, map, cron
    /// timers, and a live panel for parallel sub-agents updated in place.
    /// `YAAH_LIVE_ACCOUNT=default cargo test --lib live_scenarios -- --ignored --nocapture`
    #[test]
    #[ignore = "talks to a real agent and spends some of the account's usage"]
    fn live_scenarios() {
        let now = std::process::Command::new("date").args(["-u", "+%Y-%m-%dT%H:%M:%SZ"]).output().unwrap();
        let now = String::from_utf8_lossy(&now.stdout).trim().to_owned();
        let prompt = format!(
            "The current time is {now} (UTC). Show each of these as UI in this chat with the yaah UI tools, one render per item, \
             and build reusable library components wherever the shape would come up again:\n\
             1. Data: the 20 most populous urban areas (city, country, continent, population in millions) as a table.\n\
             2. Charts: total population of those cities by continent as a bar chart, and world population per decade 1950-2020 (billions) as a line chart.\n\
             3. Map: the same 20 cities as map markers, labelled with name and population.\n\
             4. Schedules: four cron jobs, nightly backup `0 2 * * *`, hourly sync `0 * * * *`, health check `*/15 * * * *` and weekly report `0 9 * * 1`, \
                each with its next run as a live countdown (work the next runs out from the current time above).\n\
             5. Sub-agents: launch three sub-agents in parallel, each answering from its own knowledge in two sentences (no tools): what ACP (Agent Client Protocol) is, what MCP is, and what Tauri is. \
                Before launching them, render a status panel with id `subagents` showing each as running with a live elapsed timer since now; when they finish, \
                render it again with the same id to mark each done with its answer.\n\
             Keep prose to a sentence per item."
        );
        let (run, library) = run_chat(&prompt, true);
        let components = library.list().unwrap();
        for c in &components {
            println!("component {} v{} uses {:?}", c.name, c.version, c.uses);
        }
        let uis: Vec<_> = run.entries.iter().filter(|e| matches!(e, Entry::Ui { .. })).collect();
        println!("ui entries: {}, events: {}", uis.len(), run.events.len());
        let updated_in_place = run.events.iter().filter(|e| e["payload"]["entry"]["uiId"] == "subagents").count();
        println!("subagents panel renders: {updated_in_place}");
        std::fs::remove_dir_all(&run.root).unwrap();
        assert!(uis.len() >= 4, "most scenarios were rendered");
    }

    /// A small repo with history on two branches, a merge, a failing test and
    /// uncommitted work, for the yaah pack's command views.
    fn pack_repo(repo: &std::path::Path) {
        std::fs::create_dir_all(repo).unwrap();
        let sh = |script: &str| {
            let out = std::process::Command::new("sh").arg("-c").arg(script).current_dir(repo).output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        };
        let write = |path: &str, text: &str| {
            let p = repo.join(path);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        };
        let git = "git -c user.name='Ada Lovelace' -c user.email=ada@example.com";
        sh("git init -q -b main");
        write("package.json", "{ \"name\": \"shop\", \"type\": \"module\" }\n");
        write("src/orders.js", "export const total = (items) => items.reduce((n, i) => n + i.price * i.qty, 0);\n");
        write("README.md", "# shop\n");
        sh(&format!("git add . && {git} commit -qm 'Initial commit'"));
        write(
            "src/billing/refund.js",
            "// Refund the items given, in cents.\nexport const refund = (order, items) => order.total; // BUG: ignores items\n",
        );
        write(
            "test/refund.test.js",
            "import test from 'node:test';\nimport assert from 'node:assert';\nimport { refund } from '../src/billing/refund.js';\nimport { total } from '../src/orders.js';\n\ntest('totals an order', () => assert.equal(total([{ price: 1499, qty: 2 }, { price: 2001, qty: 1 }]), 4999));\ntest('refunds a whole order', () => assert.equal(refund({ total: 4999 }, null), 4999));\ntest('refunds part of an order', () => assert.equal(refund({ total: 4999 }, [{ price: 1499, qty: 1 }]), 1499));\n",
        );
        sh(&format!("git checkout -qb feat/refunds && git add . && {git} commit -qm 'Add refunds' && git checkout -q main"));
        write("src/orders.js", "// Order totals, in cents.\nexport const total = (items) => items.reduce((n, i) => n + i.price * i.qty, 0);\n");
        sh(&format!(
            "git add . && {git} commit -qm 'Document units' && {git} merge -q --no-ff feat/refunds -m 'Merge feat/refunds' && {git} tag v0.2.0"
        ));
        sh(&format!(
            "git checkout -qb spike/cache && echo '// TODO cache' > src/cache.js && git add . && {git} commit -qm 'Try a cache' && git checkout -q main"
        ));
        write("README.md", "# shop\n\nRefunds are in src/billing.\n");
        write("notes.md", "refund edge cases\n");
    }

    /// The yaah pack with real Claude: test results, the tree pointing at a
    /// file, git graph and status, live system/Docker/database views, and a bug
    /// report the user and the agent fill in together across two turns.
    /// Needs the `shop` connection (see `examples/source_read.rs --add-connection`).
    /// `YAAH_LIVE_ACCOUNT=default cargo test --lib live_pack -- --ignored --nocapture`
    #[test]
    #[ignore = "talks to a real agent and spends some of the account's usage"]
    fn live_pack() {
        let root = std::env::temp_dir().join(format!("yaah-pack-{}", random_token()));
        pack_repo(&root.join("repo"));
        let first = "Use the yaah UI tools and the components yaah provides. Run each command in the current directory as written, without cd or pipes. \
            Keep prose to a sentence per item.\n\
            1. Run the tests with `node --test --test-reporter=spec` and show the results.\n\
            2. List the files with `find . -type f -not -path './.git/*'` and show the tree, pointing me at where the refund code lives.\n\
            3. Show the history of all branches with `git log --graph --all --format=\"%h%d %s (%an, %ar)\"`.\n\
            4. Show `git status --porcelain=v1 -b`.\n\
            5. Show this machine's CPU and memory, live.\n\
            6. Show what is running in Docker.\n\
            7. From the `shop` database connection, show revenue by product category as a chart (look at the schema first).\n\
            8. Then let's write a bug report about the failing test together: render a form with id `bug` (title, steps to reproduce, \
               severity as a select of minor/major/critical, area), fill in what you can from the failure with ui_set_values, and ask me to finish it.";
        let second = "I've edited the bug report form. Read what's there now and tell me in one sentence if anything is still missing.";
        let (run, _) = run_turns(&[first, second], true, Some(root.clone()), |hub, sid, _| {
            // The user changes the agent's title and fills in the area, without sending.
            let changed = hub.edit_form(sid, FormRef::UiId("bug"), &json!({ "title": "Partial refunds return the whole order" }), "user");
            println!("user edited the form: {changed:?}");
        });
        let ui_tools: Vec<String> = run
            .entries
            .iter()
            .filter_map(|e| match e {
                Entry::Tool { title, .. } if title.contains("yaah-ui") || title.starts_with("ui_") || title.contains("source_read") => {
                    Some(title.clone())
                }
                _ => None,
            })
            .collect();
        println!("ui tool calls: {ui_tools:?}");
        let components: Vec<String> = run
            .entries
            .iter()
            .filter_map(|e| match e {
                Entry::Ui { component: Some(c), .. } => Some(c.clone()),
                _ => None,
            })
            .collect();
        println!("components rendered: {components:?}");
        let form = run.entries.iter().rev().find_map(|e| match e {
            Entry::Ui { ui_id: Some(id), draft, draft_by, .. } if id == "bug" => Some((draft.clone(), draft_by.clone())),
            _ => None,
        });
        println!("bug form: {form:?}");
        std::fs::remove_dir_all(&root).ok();
        assert!(components.iter().any(|c| c == "test-report"), "test output shown with test-report");
        assert!(ui_tools.iter().any(|t| t.contains("ui_set_values")), "the agent filled the form");
        assert!(ui_tools.iter().any(|t| t.contains("ui_get_values")), "the agent read the user's edits");
        let (draft, by) = form.expect("a form with id `bug`");
        assert_eq!(by.unwrap()["title"], "user", "the user's title won");
        assert!(draft.unwrap().as_object().unwrap().len() >= 2);
    }

    /// The agent asks with a form (`ui_ask`), gets the answer, and carries on in the same turn.
    /// `YAAH_LIVE_ACCOUNT=default cargo test --lib live_ask -- --ignored --nocapture`
    #[test]
    #[ignore = "talks to a real agent and spends some of the account's usage"]
    fn live_ask_collaborates_in_one_turn() {
        let (run, _) = run_chat(
            "I want to start a small side project this weekend. Before suggesting anything, ask me about my preferences \
             (language, how much time I have, what kind of project, what matters most to me) using the yaah UI, \
             then recommend exactly one project in two sentences.",
            true,
        );
        let ask = run.entries.iter().position(|e| matches!(e, Entry::Ui { ask_id: Some(_), answer: Some(_), .. }));
        let users = run.entries.iter().filter(|e| matches!(e, Entry::User { .. })).count();
        if let Some(Entry::Ui { tree, answer, .. }) = ask.map(|i| &run.entries[i]) {
            println!("form: {}", serde_json::to_string(tree).unwrap().chars().take(600).collect::<String>());
            println!("answer: {}", answer.as_ref().unwrap());
        }
        std::fs::remove_dir_all(&run.root).unwrap();
        let ask = ask.expect("the agent asked with ui_ask and got an answer");
        assert_eq!(users, 1, "the answer went back into the same turn, not as a new message");
        assert!(
            run.entries.iter().skip(ask).any(|e| matches!(e, Entry::Agent { text, .. } if text.len() > 40)),
            "the agent carried on after the answer"
        );
    }

    /// A chat survives an app restart: the transcript is restored from disk and
    /// the agent still has the context after `session/load`.
    /// `YAAH_LIVE_ACCOUNT=default cargo test --lib live_restart -- --ignored --nocapture`
    #[test]
    #[ignore = "talks to a real agent and spends some of the account's usage"]
    fn live_restart_keeps_history() {
        let account = std::env::var("YAAH_LIVE_ACCOUNT").unwrap_or_else(|_| "default".into());
        let store = std::env::temp_dir().join(format!("yaah-restart-{}", random_token()));
        let repo = store.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let project = Project {
            id: "live".into(),
            name: "live".into(),
            dirs: vec![repo.to_string_lossy().into()],
            status: Status::Ongoing,
            created_at: 0,
            context_dir: repo.to_string_lossy().into(),
            link: None,
            agent_id: None,
        };
        let quiet: Emit = Arc::new(|_: &str, _: Value| {});
        let ask = |hub: &Hub, sid: &str, text: &str| {
            tauri::async_runtime::block_on(hub.prompt(sid, text.into(), vec![])).unwrap();
            while hub.transcript(sid).unwrap().info.running {
                std::thread::sleep(Duration::from_millis(200));
            }
        };

        let sid = {
            let hub = Hub::with_store(quiet.clone(), store.join("sessions"));
            let info = tauri::async_runtime::block_on(hub.new_session(ChatTarget::Project(&project), &account)).unwrap();
            ask(&hub, &info.session_id, "Remember the codeword PELICAN-42. Reply with just: ok");
            info.session_id
        }; // the first hub (and its agent process) is dropped: an app restart

        let hub = Hub::with_store(quiet, store.join("sessions"));
        let before = hub.transcript(&sid).expect("restored from disk").entries.len();
        ask(&hub, &sid, "What was the codeword? Reply with just the codeword.");
        let entries = hub.transcript(&sid).unwrap().entries;
        for e in &entries {
            let v = serde_json::to_value(e).unwrap();
            println!("  {:<6} {}", v["type"].as_str().unwrap(), v["text"].as_str().or(v["message"].as_str()).unwrap_or_default());
        }
        std::fs::remove_dir_all(&store).unwrap();
        let users = entries.iter().filter(|e| matches!(e, Entry::User { .. })).count();
        assert_eq!(users, 2, "the replayed history wasn't added twice");
        assert!(entries.len() > before);
        assert!(
            entries.iter().skip(before).any(|e| matches!(e, Entry::Agent { text, .. } if text.contains("PELICAN-42"))),
            "the agent kept the context across the restart"
        );
    }

    /// The agent builds a todo page, then presents it with UI: markdown summary,
    /// git diff, screenshot and live preview. Keeps the project in `YAAH_LIVE_DIR`.
    /// `YAAH_LIVE_DIR=/tmp/x YAAH_LIVE_ACCOUNT=default cargo test --lib live_showcase -- --ignored --nocapture`
    #[test]
    #[ignore = "talks to a real agent and spends some of the account's usage"]
    fn live_showcase() {
        let dir = PathBuf::from(std::env::var("YAAH_LIVE_DIR").expect("set YAAH_LIVE_DIR"));
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let status = std::process::Command::new("git").args(["init", "-q"]).current_dir(&repo).status().unwrap();
        assert!(status.success());
        let (run, library) = run_chat_in(
            "Build a small todo web page in the current folder: one self-contained index.html (HTML, CSS and JS) where I can add, complete, delete and filter todos, saved in localStorage. \
             Then present the work in this chat with the yaah UI tools, so I can review it without leaving the chat: \
             (1) a short markdown summary of what you built; \
             (2) the git diff of your changes (the repo has no commits yet: run `git add -N .` and then `git diff`); \
             (3) a screenshot of the page: take it with headless Chrome (/Applications/Google Chrome.app) at 1200x800 and save it as screenshot.png in this folder; \
             (4) a live browser preview of index.html. \
             Build reusable library components where they'd help next time (for example a review panel that combines these), then render them.",
            true,
            Some(dir.clone()),
        );
        let components = library.list().unwrap();
        println!("library: {:?}", components.iter().map(|c| format!("{} v{}", c.name, c.version)).collect::<Vec<_>>());
        let uis = run.entries.iter().filter(|e| matches!(e, Entry::Ui { .. })).count();
        println!("ui entries: {uis}, total events: {}", run.events.len());
        assert!(repo.join("index.html").is_file(), "the page was built");
        assert!(uis > 0, "the work was presented as UI");
    }

    /// The agent finds the UI tools, builds a library component and renders it.
    /// `YAAH_LIVE_ACCOUNT=default cargo test --lib live_ui -- --ignored --nocapture`
    #[test]
    #[ignore = "talks to a real agent and spends some of the account's usage"]
    fn live_ui_builds_and_renders_a_component() {
        let (run, library) = run_chat(
            "Three services: api (healthy, 42ms p95), worker (degraded, queue depth 1.2k), billing (down since 09:14). \
             Show me their status as UI in this chat. This overview will come up again, so build a reusable library component for it, then render it with this data. \
             Keep any prose to one sentence.",
            true,
        );
        let components = library.list().unwrap();
        println!("library: {:?}", components.iter().map(|c| format!("{} v{}", c.name, c.version)).collect::<Vec<_>>());
        let rendered: Vec<&Entry> = run.entries.iter().filter(|e| matches!(e, Entry::Ui { .. })).collect();
        if let Some(Entry::Ui { component, tree, .. }) = rendered.last() {
            println!("rendered {component:?}: {}", serde_json::to_string(tree).unwrap().chars().take(400).collect::<String>());
        }
        std::fs::remove_dir_all(&run.root).unwrap();
        assert!(!components.is_empty(), "the agent saved a component to the library");
        assert!(rendered.iter().any(|e| matches!(e, Entry::Ui { component: Some(_), .. })), "a library component was rendered in the chat");
        assert!(
            !run.entries.iter().any(|e| matches!(e, Entry::Permission { title, .. } if title.contains("ui_"))),
            "UI tools ran without permission prompts"
        );
    }

    include!("live_ui_review.rs");
    include!("live_adapter_tests.rs");

    /// How long a chat takes to open with `YAAH_LIVE_ACCOUNT`'s agent (meant for Codex): spawn,
    /// `initialize`, `session/new`, then what it reports about MCP startup in the next 30 s (`YAAH_LIVE_WAIT`).
    /// Three fresh processes: the servers yaah passed in 0.3.0 (Codex's own names again), the
    /// ones it passes now, and none. No prompt is sent; the profile is only read.
    ///
    /// ```sh
    /// YAAH_LIVE_ACCOUNT=codex cargo test --lib live_session_start_timing -- --ignored --nocapture
    /// ```
    ///
    /// `YAAH_LIVE_ROUNDS=3` runs the three that many times.
    #[test]
    #[ignore = "starts the real agent"]
    fn live_session_start_timing() {
        let account = std::env::var("YAAH_LIVE_ACCOUNT").unwrap_or_else(|_| "codex".into());
        let profile = Store::user().find(&account).unwrap_or_else(|| panic!("YAAH_LIVE_ACCOUNT={account} names no agent"));
        let cwd = std::env::temp_dir().join(format!("yaah-live-timing-{}", random_token()));
        std::fs::create_dir_all(&cwd).unwrap();
        let env_num = |k: &str, d: u64| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
        let (rounds, wait) = (env_num("YAAH_LIVE_ROUNDS", 1), env_num("YAAH_LIVE_WAIT", 30));
        let variants = ["0.3.0 (duplicates)", "now (deduplicated)", "no servers"];
        for variant in (0..rounds).flat_map(|_| variants) {
            tauri::async_runtime::block_on(async {
                let t0 = Instant::now();
                let log: Arc<Mutex<Vec<String>>> = Arc::default();
                let seen = log.clone();
                let (conn, _) = agents::spawn_routed(
                    &profile,
                    move |msg, responder| {
                        let at = t0.elapsed().as_secs_f64();
                        match msg {
                            Incoming::Notification { method, params } => {
                                let u = &params["update"];
                                if u["sessionUpdate"] == "tool_call" || u["sessionUpdate"] == "notice" {
                                    let what = u["title"].as_str().unwrap_or_default().to_owned();
                                    seen.lock().unwrap().push(format!("{at:6.2}s {method} {} {what} {}", u["sessionUpdate"], u["status"]));
                                }
                            }
                            Incoming::Request { id, method, .. } => {
                                seen.lock().unwrap().push(format!("{at:6.2}s request {method}"));
                                responder.err(id, -32601, "not in this test");
                            }
                        }
                    },
                    |_| {},
                    &[],
                )
                .expect("spawn");
                let init = agents::initialize(&conn).await.expect("initialize");
                let t_init = t0.elapsed();
                let caps = Report::from_initialize(&init);
                let mut params = json!({ "cwd": cwd, "mcpServers": [] });
                let starting = match variant {
                    "0.3.0 (duplicates)" => {
                        let mine: Vec<_> = crate::mcp_servers::Store::user().list().into_iter().filter(|s| s.for_profile(&profile.id)).collect();
                        params["mcpServers"] = json!(crate::mcp_servers::for_agent(&mine, caps.mcp_http, caps.mcp_sse).0);
                        vec![]
                    }
                    "now (deduplicated)" => crate::mcp_servers::inject(&mut params, caps.mcp_http, caps.mcp_sse, &profile),
                    _ => vec![],
                };
                let given: Vec<&str> = params["mcpServers"].as_array().unwrap().iter().filter_map(|s| s["name"].as_str()).collect();
                println!("\n== {variant}: passing {given:?}; starting {starting:?}");
                let t1 = Instant::now();
                let res = conn.request("session/new", params.clone()).await;
                let t_new = t1.elapsed();
                println!(
                    "spawn + initialize {:.2}s, session/new {:.2}s ({})",
                    t_init.as_secs_f64(),
                    t_new.as_secs_f64(),
                    if res.is_ok() { "ok" } else { "failed" }
                );
                tokio::time::sleep(Duration::from_secs(wait)).await;
                for line in log.lock().unwrap().iter() {
                    println!("  {line}");
                }
                let _ = conn.shutdown(Duration::from_secs(5)).await;
            });
        }
        std::fs::remove_dir_all(&cwd).ok();
    }
}

#[cfg(test)]
mod persistence_tests {
    use super::*;

    #[test]
    /// (A chat id no other test uses: deleting a chat revokes its id on every UI server in the process.)
    fn restores_saved_chats_as_stopped() {
        let dir = std::env::temp_dir().join(format!("yaah-sessions-{}", random_token()));
        let entries = vec![
            Entry::User { text: "hi".into(), attachments: vec![] },
            Entry::Tool {
                tool_call_id: "t1".into(),
                title: "Write x".into(),
                kind: None,
                status: Some("pending".into()),
                content: json!([]),
                locations: json!([]),
                raw_input: Value::Null,
            },
            Entry::Permission { request_id: json!(3), tool_call_id: Some("t1".into()), title: "Write x".into(), options: json!([]), chosen: None },
        ];
        let hub = Hub::open(Arc::new(|_: &str, _: Value| {}), Some(dir.clone()), Store::user());
        let mut saved = Session::new(test_info("restored-1"), entries, Some(dir.join("restored-1.json")));
        saved.saving.dirty = true;
        hub.shared.insert(saved);
        hub.flush();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join("restored-1.json")).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "chats can hold secrets");
        }
        std::fs::write(dir.join("broken.json"), "{").unwrap();

        let mut restored = load_sessions(&dir);
        assert_eq!(restored.len(), 1, "an unreadable file is skipped");
        let s = restored.get_mut("restored-1").unwrap();
        assert!(!s.info.running, "a turn can't still be running after a restart");
        assert!(!s.loaded && s.entries.is_empty(), "entries wait until the chat is opened");
        s.ensure_loaded();
        assert!(s.attached.is_none(), "restored chats reattach on their next prompt");
        assert_eq!(s.tool_index.get("t1"), Some(&1), "tool calls can still be updated");
        assert!(matches!(&*s.entries[2], Entry::Permission { chosen: Some(c), .. } if c.contains("cancelled")));

        // Deleting goes through the same queue, so a save still waiting can't bring the file back.
        let hub = Hub::open(Arc::new(|_: &str, _: Value| {}), Some(dir.clone()), Store::user());
        assert_eq!(hub.rename_session("restored-1", "  renamed  ").unwrap().title, "renamed");
        assert!(hub.rename_session("restored-1", " ").is_err());
        hub.delete_session("restored-1").unwrap();
        assert!(hub.delete_session("restored-1").is_err(), "already gone");
        hub.flush();
        assert!(!dir.join("restored-1.json").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn only_plain_ids_become_file_names() {
        assert_eq!(file_name("0198c2a4-7d1e-7c3a-9f00-abc_def.1"), "0198c2a4-7d1e-7c3a-9f00-abc_def.1.json");
        for odd in ["", ".hidden", "../../.claude", "a/b", "a\\b", "sess:1", &"x".repeat(129)] {
            let name = file_name(odd);
            let hash = name.strip_suffix(".json").unwrap_or_default();
            assert!(hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()), "{odd} -> {name}");
        }
    }
}

#[cfg(test)]
mod ask_tests {
    use super::*;
    use crate::ui_library::{Library, LocalDir};
    use std::io::{Read, Write};

    /// POST one MCP tools/call to the UI server and return the response body.
    fn call(port: u16, token: &str, name: &str, args: &Value) -> String {
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": name, "arguments": args } }).to_string();
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(
            s,
            "POST /mcp/{token} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        out
    }

    fn wait_for_ask(hub: &Hub, sid: &str) -> usize {
        for _ in 0..200 {
            let entries = hub.transcript(sid).unwrap().entries;
            if let Some(i) = entries.iter().rposition(|e| matches!(e, Entry::Ui { ask_id: Some(_), answer: None, .. })) {
                return i;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("the ask never showed up in the chat");
    }

    #[test]
    fn ui_ask_waits_for_the_users_answer() {
        let hub = Arc::new(Hub::new(Arc::new(|_: &str, _: Value| {})));
        let info = test_info("s1");
        hub.shared.insert(Session::new(info, vec![], None));
        hub.ui_tokens.lock().unwrap().insert("tok".into(), Some("s1".into()));
        let dir = std::env::temp_dir().join(format!("yaah-ask-{}", random_token()));
        let library = Arc::new(Library::with_sources(vec![Box::new(LocalDir::new(dir))]));
        let port = ui_mcp::start(Arc::new(ui_mcp::UiHost::new(hub.clone(), library, Arc::new(crate::sources::Sources::new())))).unwrap();

        let form = json!({ "type": "form", "children": [
            { "type": "choice", "props": { "name": "stack", "label": "Stack", "options": [{ "value": "rust", "label": "Rust" }, { "value": "elixir", "label": "Elixir" }] } },
            { "type": "slider", "props": { "name": "budget", "label": "Budget", "min": 0, "max": 100 } }
        ]});

        // A render without a form is refused.
        assert!(call(port, "tok", "ui_ask", &json!({ "tree": { "type": "text", "props": { "text": "hi" } } })).contains("needs a `form`"));

        // The call blocks until the user answers; the answer comes back as the tool result.
        let waiting = std::thread::spawn({
            let form = form.clone();
            move || call(port, "tok", "ui_ask", &json!({ "tree": form, "title": "Pick a stack" }))
        });
        let index = wait_for_ask(&hub, "s1");
        assert!(!waiting.is_finished(), "ui_ask returned before the user answered");
        tauri::async_runtime::block_on(hub.answer_ui("s1", index, json!({ "stack": "elixir", "budget": 40 }))).unwrap();
        let reply = waiting.join().unwrap();
        assert!(reply.contains("The user answered") && reply.contains("elixir") && reply.contains("40"), "{reply}");
        assert!(tauri::async_runtime::block_on(hub.answer_ui("s1", index, json!({}))).is_err(), "a form answers once");
        assert!(matches!(&hub.transcript("s1").unwrap().entries[index], Entry::Ui { answer: Some(a), .. } if a["stack"] == "elixir"));

        // Stop releases a waiting ask and locks its form.
        let waiting = std::thread::spawn(move || call(port, "tok", "ui_ask", &json!({ "tree": form })));
        let index = wait_for_ask(&hub, "s1");
        hub.cancel("s1").unwrap();
        assert!(waiting.join().unwrap().contains("cancelled"));
        assert!(matches!(&hub.transcript("s1").unwrap().entries[index], Entry::Ui { answer: Some(a), .. } if a["$cancelled"] == true));
    }

    /// The user and the agent fill one form: both edit the draft, each sees the
    /// other's changes, the last write to a field wins, and sending locks it.
    #[test]
    fn user_and_agent_edit_one_form() {
        let hub = Arc::new(Hub::new(Arc::new(|_: &str, _: Value| {})));
        let info = test_info("s2");
        hub.shared.insert(Session::new(info, vec![], None));
        hub.ui_tokens.lock().unwrap().insert("tok2".into(), Some("s2".into()));
        let dir = std::env::temp_dir().join(format!("yaah-form-{}", random_token()));
        let library = Arc::new(Library::with_sources(vec![Box::new(LocalDir::new(dir))]));
        let port = ui_mcp::start(Arc::new(ui_mcp::UiHost::new(hub.clone(), library, Arc::new(crate::sources::Sources::new())))).unwrap();

        let form = json!({ "type": "form", "children": [
            { "type": "textfield", "props": { "name": "title", "label": "Title" } },
            { "type": "select", "props": { "name": "priority", "label": "Priority", "default": "low", "options": [{ "value": "low" }, { "value": "high" }] } },
            { "type": "toggle", "props": { "name": "notify", "label": "Notify" } }
        ]});
        assert!(call(port, "tok2", "ui_render", &json!({ "tree": form, "id": "ticket" })).contains("Rendered"));
        let index = hub.transcript("s2").unwrap().entries.len() - 1;

        // Before anyone types: the defaults.
        let state = call(port, "tok2", "ui_get_values", &json!({ "id": "ticket" }));
        assert!(state.contains(r#"\"priority\":\"low\""#) && state.contains(r#"\"sent\":false"#), "{state}");

        // The user types; the agent sees it and fills in more.
        hub.edit_form("s2", FormRef::Index(index), &json!({ "title": "Refunds fail" }), "user").unwrap();
        let state = call(port, "tok2", "ui_get_values", &json!({ "id": "ticket" }));
        assert!(state.contains("Refunds fail") && state.contains(r#"\"title\":\"user\""#), "{state}");
        let set = call(
            port,
            "tok2",
            "ui_set_values",
            &json!({ "id": "ticket", "values": { "priority": "high", "title": "Refunds fail for partial orders" } }),
        );
        assert!(set.contains("marked as yours"), "{set}");
        // A field that isn't in the form is refused with the ones that are.
        assert!(
            call(port, "tok2", "ui_set_values", &json!({ "id": "ticket", "values": { "owner": "ada" } }))
                .contains(r#"its fields are [\"title\", \"priority\", \"notify\"]"#)
        );

        // The user changes the agent's title back: the last write wins, and says who.
        let state = hub.edit_form("s2", FormRef::Index(index), &json!({ "title": "Refunds fail", "notify": true }), "user").unwrap();
        assert_eq!(state["values"], json!({ "title": "Refunds fail", "priority": "high", "notify": true }));
        assert_eq!(state["editedBy"], json!({ "title": "user", "priority": "agent", "notify": "user" }));

        // Re-rendering the same form keeps the draft.
        call(port, "tok2", "ui_render", &json!({ "tree": form, "id": "ticket" }));
        assert_eq!(hub.form("s2", FormRef::UiId("ticket")).unwrap()["values"]["priority"], "high");

        // Sending locks it for both.
        tauri::async_runtime::block_on(async {
            // No agent is connected, so the follow-up prompt fails; the answer is stored first.
            let _ = hub.answer_ui("s2", index, json!({ "title": "Refunds fail", "priority": "high", "notify": true })).await;
        });
        assert!(call(port, "tok2", "ui_set_values", &json!({ "id": "ticket", "values": { "notify": false } })).contains("already sent"));
        assert!(hub.edit_form("s2", FormRef::Index(index), &json!({ "notify": false }), "user").is_err());
        assert!(call(port, "tok2", "ui_get_values", &json!({ "id": "ticket" })).contains(r#"\"sent\":true"#));
    }
}

#[cfg(test)]
mod permission_tests {
    use super::*;

    fn fetch_request(id: i64, title: &str) -> Entry {
        Entry::Permission {
            request_id: json!(id),
            tool_call_id: None,
            title: title.into(),
            options: json!([
                { "optionId": "a", "name": "Yes, and don't ask again for Fetch commands", "kind": "allow_always" },
                { "optionId": "o", "name": "Yes", "kind": "allow_once" },
                { "optionId": "r", "name": "No", "kind": "reject_once" }
            ]),
            chosen: None,
        }
    }

    /// "Don't ask again" answers the same request already waiting, leaves others alone,
    /// and is remembered for this chat.
    #[test]
    fn dont_ask_again_answers_the_waiting_ones() {
        let hub = Hub::new(Arc::new(|_: &str, _: Value| {}));
        let info = test_info("p");
        let entries = vec![
            fetch_request(1, "mcp__fetch__fetch"),
            fetch_request(2, "mcp__fetch__fetch"),
            fetch_request(3, "rm -rf build"),
            fetch_request(4, "mcp__fetch__fetch"),
            fetch_request(5, UNNAMED_REQUEST),
            fetch_request(6, UNNAMED_REQUEST),
        ];
        hub.shared.insert(Session::new(info, entries, None));
        // No agent is running, so sending fails after the choice is recorded.
        assert!(hub.respond_permission("p", 0, Some("a")).is_err());
        assert!(hub.respond_permission("p", 0, Some("a")).unwrap_err().contains("already answered"));
        assert!(hub.respond_permission("p", 99, None).is_err());
        // A request the agent didn't name is too vague to remember.
        let _ = hub.respond_permission("p", 4, Some("a"));
        let t = hub.transcript("p").unwrap().entries;
        assert!(matches!(&t[5], Entry::Permission { chosen: None, .. }), "an unnamed request still asks");
        assert!(!hub.shared.chat("p").unwrap().lock().unwrap().remembered.contains_key(UNNAMED_REQUEST));
        let chosen = |i: usize| match &t[i] {
            Entry::Permission { chosen, .. } => chosen.clone(),
            _ => None,
        };
        assert_eq!(chosen(0).as_deref(), Some("Yes, and don't ask again for Fetch commands"));
        assert!(chosen(1).unwrap().ends_with("(you said don't ask again)"));
        assert_eq!(chosen(2), None, "a different request still asks");
        assert!(chosen(3).unwrap().ends_with("(you said don't ask again)"));
        assert_eq!(hub.shared.chat("p").unwrap().lock().unwrap().remembered["mcp__fetch__fetch"], "allow_always");
        assert_eq!(
            remembered_option(&json!([{ "optionId": "x", "name": "Yes", "kind": "allow_once" }]), "allow_always"),
            Some(("x".into(), "Yes".into()))
        );
    }
}

/// Streaming to the UI (`docs/research/streaming-contract.md`): appends, coalescing, ordering, drafts.
#[cfg(test)]
mod stream_tests {
    use super::*;

    type Events = Arc<Mutex<Vec<(Instant, String, Value)>>>;

    fn recorder() -> (Emit, Events) {
        let events: Events = Arc::default();
        let sink = events.clone();
        (Arc::new(move |name: &str, payload: Value| sink.lock().unwrap().push((Instant::now(), name.to_owned(), payload))), events)
    }

    /// A hub with one attached, running chat `s`.
    fn hub(coalesce: Duration) -> (Hub, Events) {
        let (emit, events) = recorder();
        let hub = Hub::new(emit);
        hub.set_timings(coalesce, SAVE_DELAY);
        let mut s = Session::new(test_info("s"), vec![], None);
        s.attached = Some(1);
        hub.shared.insert(s);
        (hub, events)
    }

    fn update(hub: &Hub, update: &Value) {
        hub.shared.with("s", |s| apply_update(&hub.shared, s, update)).unwrap();
    }

    /// `_auth/status_update` from claude-agent-acp: external, gateway and API-key auth count as signed in.
    #[test]
    fn auth_status_updates_mark_the_profile_ready() {
        let (hub, events) = hub(COALESCE);
        let changes = || events.lock().unwrap().iter().filter(|(_, n, _)| n == "accounts-changed").count();
        hub.shared.mark_needs_login("bedrock");
        let before = changes();
        hub.shared.auth_status_update("bedrock", &json!({ "authStatus": { "kind": "external", "label": "AWS Bedrock" } }));
        assert!(!hub.needs_login("bedrock"), "a ready kind clears the login request");
        assert_eq!(hub.auth_status("bedrock").map(|s| s.kind).as_deref(), Some("external"));
        assert_eq!(changes(), before + 1);
        // The same again changes nothing; a different one is told.
        hub.shared.auth_status_update("bedrock", &json!({ "authStatus": { "kind": "external", "label": "AWS Bedrock" } }));
        assert_eq!(changes(), before + 1);
        hub.shared.auth_status_update("bedrock", &json!({ "authStatus": { "kind": "none", "label": "Not logged in" } }));
        assert_eq!(changes(), before + 2);
        assert!(!hub.auth_status("bedrock").unwrap().ready());
        // `none` doesn't itself ask for a login: the agent's -32000 does.
        assert!(!hub.needs_login("bedrock"));
        hub.shared.auth_status_update("bedrock", &json!({ "nothing": true }));
        assert_eq!(hub.auth_status("bedrock").map(|s| s.kind).as_deref(), Some("none"), "malformed updates are ignored");
        for kind in ["gateway", "api_key"] {
            hub.shared.mark_needs_login(kind);
            hub.shared.auth_status_update(kind, &json!({ "authStatus": { "kind": kind } }));
            assert!(!hub.needs_login(kind) && hub.auth_status(kind).unwrap().ready(), "{kind}");
        }
    }

    /// codex-acp's MCP startup reports, as it sends them (`McpStartupReporter`).
    fn codex_startup(server: &str, message: &str) -> Value {
        json!({
            "sessionUpdate": "tool_call",
            "toolCallId": format!("mcp_startup.{server}.6f1c"),
            "kind": "other",
            "title": format!("mcp__{server}__startup"),
            "status": "failed",
            "content": [{ "type": "content", "content": { "type": "text", "text": message } }],
        })
    }

    #[test]
    fn codex_mcp_startup_reports_are_notices_not_failed_tool_calls() {
        let (hub, _) = hub(COALESCE);
        update(
            &hub,
            &codex_startup(
                "chrome-devtools",
                "[codex-acp] MCP server `chrome-devtools` was not started, because the Codex config already defines an MCP server with this name. Codex uses its own entry, or no server if that entry is disabled.",
            ),
        );
        update(&hub, &codex_startup("rea", "[codex-acp forwarded startup error] MCP server `rea` failed to start: handshake timed out after 30s"));
        update(&hub, &codex_startup("fetch", "[codex-acp forwarded startup error] MCP server `fetch` startup was cancelled."));
        // An ordinary tool call stays one.
        update(&hub, &json!({ "sessionUpdate": "tool_call", "toolCallId": "t1", "title": "mcp__fetch__fetch", "status": "failed" }));
        let entries = hub.shared.with("s", |s| s.entries.iter().map(|e| serde_json::to_value(&**e).unwrap()).collect::<Vec<_>>()).unwrap();
        assert_eq!(entries.len(), 2, "{entries:#?}");
        assert_eq!(
            entries[0],
            json!({ "type": "notices", "items": [
                { "severity": "info", "title": "Codex uses its own chrome-devtools", "mcpServer": "chrome-devtools" },
                { "severity": "warning", "title": "MCP server \"rea\" didn't start", "description": "handshake timed out after 30s", "mcpServer": "rea" },
                { "severity": "warning", "title": "MCP server \"fetch\" startup was cancelled", "mcpServer": "fetch" },
            ] })
        );
        assert_eq!(entries[1]["type"], "tool");
    }

    fn chunk(hub: &Hub, text: &str, thought: bool) {
        let kind = if thought { "agent_thought_chunk" } else { "agent_message_chunk" };
        update(hub, &json!({ "sessionUpdate": kind, "messageId": "m1", "content": { "type": "text", "text": text } }));
    }

    fn names(events: &Events) -> Vec<String> {
        events.lock().unwrap().iter().map(|(_, n, v)| format!("{n}:{}", v["index"])).collect()
    }

    fn utf16(s: &str) -> usize {
        s.encode_utf16().count()
    }

    /// What the UI builds from the events, by the contract's rules: an append
    /// applies only when the shown text plus it is `len` long (UTF-16).
    fn replay(events: &Events) -> Vec<Value> {
        let mut entries: Vec<Value> = vec![];
        for (_, name, v) in events.lock().unwrap().iter() {
            let Some(i) = v["index"].as_u64().and_then(|i| usize::try_from(i).ok()) else { continue };
            match name.as_str() {
                "session-entry" => {
                    if entries.len() <= i {
                        entries.resize(i + 1, Value::Null);
                    }
                    entries[i] = v["entry"].clone();
                }
                "session-append" => {
                    let field = v["field"].as_str().unwrap();
                    let shown = entries[i][field].as_str().expect("an append to a text field the UI has").to_owned();
                    let text = v["text"].as_str().unwrap();
                    assert_eq!(utf16(&shown) + utf16(text), usize::try_from(v["len"].as_u64().unwrap()).unwrap(), "in sync: {v}");
                    entries[i][field] = json!(shown + text);
                }
                "session-draft" => {
                    entries[i]["draft"] = v["draft"].clone();
                    entries[i]["draftBy"] = v["draftBy"].clone();
                }
                _ => {}
            }
        }
        entries
    }

    fn transcript_values(hub: &Hub) -> Vec<Value> {
        hub.transcript("s").unwrap().entries.iter().map(|e| serde_json::to_value(e).unwrap()).collect()
    }

    /// Within the interval appends wait and join; any other change sends them first; the turn's end sends the rest.
    #[test]
    fn appends_join_and_go_out_before_any_other_change() {
        let (hub, events) = hub(Duration::from_secs(3600));
        chunk(&hub, "Hé", true);
        assert_eq!(names(&events), ["session-entry:0"], "a thought that starts is a whole entry");
        chunk(&hub, "llo 👋", true);
        assert_eq!(names(&events), ["session-entry:0", "session-append:0"], "the first append goes at once");
        let first = events.lock().unwrap()[1].2.clone();
        // "Héllo 👋": 7 characters, 11 bytes, 8 UTF-16 code units (the emoji is a surrogate pair).
        assert_eq!(first, json!({ "sessionId": "s", "index": 0, "field": "text", "text": "llo 👋", "len": 8 }));

        for t in [" a", " b", " ç"] {
            chunk(&hub, t, true);
        }
        assert_eq!(events.lock().unwrap().len(), 2, "appends within the interval wait");

        // A message starts: the waiting thought text goes first, joined into one append.
        chunk(&hub, "Answer", false);
        assert_eq!(names(&events)[2..], ["session-append:0", "session-entry:1"]);
        assert_eq!(events.lock().unwrap()[2].2["text"], " a b ç");
        assert_eq!(events.lock().unwrap()[2].2["len"], utf16("Héllo 👋 a b ç"));

        // A tool call (not an append) sends the waiting text before it.
        chunk(&hub, " part", false);
        update(&hub, &json!({ "sessionUpdate": "tool_call", "toolCallId": "t1", "title": "Read x", "status": "pending" }));
        assert_eq!(names(&events)[4..], ["session-append:1", "session-entry:2"]);
        update(&hub, &json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed" }));
        assert_eq!(names(&events)[6..], ["session-entry:2"], "tool updates send the tool entry");

        // The same message after the tool call is a new entry; the turn's end sends what's waiting, then the info.
        chunk(&hub, "More", false);
        chunk(&hub, "…𝄞", false);
        assert_eq!(names(&events)[7..], ["session-entry:3"]);
        finish_turn(&hub.shared, "s", Some("end_turn".into()), None);
        assert_eq!(names(&events)[8..], ["session-append:3", "session-info:null"]);
        assert_eq!(events.lock().unwrap()[8].2["len"], utf16("More…𝄞"));
        assert_eq!(events.lock().unwrap()[9].2["running"], false);

        assert_eq!(replay(&events), transcript_values(&hub), "the UI's copy, built from the events, is the transcript");
    }

    #[test]
    fn with_no_interval_every_chunk_is_its_own_append() {
        let (hub, events) = hub(Duration::ZERO);
        let parts = ["a", "ß", "ﬃ", "🙂", " ", "z"];
        for p in parts {
            chunk(&hub, p, false);
        }
        let n = names(&events);
        assert_eq!(n.len(), parts.len());
        assert!(n[1..].iter().all(|e| e == "session-append:0"), "{n:?}");
        assert_eq!(events.lock().unwrap().last().unwrap().2["len"], utf16(&parts.concat()));
        assert_eq!(replay(&events), transcript_values(&hub));
    }

    /// Text that waits goes out on its own when the interval is up, and a chat
    /// never gets more than about one append per interval.
    #[test]
    fn waiting_text_goes_out_after_the_interval_and_no_faster() {
        let (hub, events) = hub(COALESCE);
        chunk(&hub, "start", false);
        chunk(&hub, " one", false);
        chunk(&hub, " two", false);
        let started = Instant::now();
        while events.lock().unwrap().len() < 3 {
            assert!(started.elapsed() < Duration::from_secs(5), "the waiting append never went out");
            std::thread::sleep(Duration::from_millis(2));
        }
        let ev = events.lock().unwrap().clone();
        assert_eq!((ev[2].1.as_str(), ev[2].2["text"].as_str()), ("session-append", Some(" two")));
        assert!(ev[2].0 - ev[1].0 >= COALESCE.saturating_sub(Duration::from_millis(2)), "sent before the interval was up");

        // 300 chunks over about half a second: one append per interval at most.
        events.lock().unwrap().clear();
        let started = Instant::now();
        let mut sent = String::new();
        for i in 0..300 {
            let t = format!(" {i}é");
            chunk(&hub, &t, false);
            sent.push_str(&t);
            std::thread::sleep(Duration::from_micros(1500));
        }
        let took = started.elapsed();
        finish_turn(&hub.shared, "s", None, None);
        let appends = events.lock().unwrap().iter().filter(|(_, n, _)| n == "session-append").count();
        let most = usize::try_from(took.as_millis() / COALESCE.as_millis()).unwrap() + 2;
        assert!((1..=most).contains(&appends), "{appends} appends in {took:?} (at most {most})");
        let text: String =
            events.lock().unwrap().iter().filter(|(_, n, _)| n == "session-append").map(|(_, _, v)| v["text"].as_str().unwrap().to_owned()).collect();
        assert_eq!(text, sent, "nothing lost or repeated");
    }

    /// Typing in a form sends the draft, not the UI entry with its inlined image.
    #[test]
    fn form_edits_send_only_the_draft() {
        let (hub, events) = hub(COALESCE);
        let image = format!("data:image/png;base64,{}", "A".repeat(200_000));
        let tree = json!({ "type": "form", "children": [
            { "type": "image", "props": { "src": image } },
            { "type": "textfield", "props": { "name": "title", "label": "Title" } },
            { "type": "toggle", "props": { "name": "notify", "label": "Notify" } }
        ]});
        let ui = Entry::Ui {
            ui_id: Some("f".into()),
            title: None,
            component: None,
            version: None,
            tree,
            props: json!({}),
            ask_id: None,
            answer: None,
            draft: None,
            draft_by: None,
        };
        assert!(!hub.push_ui("s", ui));
        let before = events.lock().unwrap().len();

        hub.edit_form("s", FormRef::Index(0), &json!({ "title": "Refunds" }), "user").unwrap();
        hub.edit_form("s", FormRef::UiId("f"), &json!({ "notify": true }), "agent").unwrap();
        let ev = events.lock().unwrap()[before..].to_vec();
        assert_eq!(ev.iter().map(|(_, n, _)| n.as_str()).collect::<Vec<_>>(), ["session-draft", "session-draft"]);
        assert_eq!(
            ev[1].2,
            json!({ "sessionId": "s", "index": 0, "draft": { "title": "Refunds", "notify": true }, "draftBy": { "title": "user", "notify": "agent" } })
        );
        assert!(ev.iter().all(|(_, _, v)| v.to_string().len() < 300), "no image in a draft event");
        assert_eq!(replay(&events)[0]["draft"], json!({ "title": "Refunds", "notify": true }));
    }
}

/// Each chat has its own lock: saving or reading one never holds up another.
#[cfg(test)]
mod lock_tests {
    use super::*;

    fn chunk() -> Value {
        json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "token " } })
    }

    fn big_entries(n: usize) -> Vec<Entry> {
        (0..n)
            .map(|i| Entry::Tool {
                tool_call_id: format!("t{i}"),
                title: "Read src/session.rs".into(),
                kind: Some("read".into()),
                status: Some("completed".into()),
                content: json!([{ "type": "content", "content": { "type": "text", "text": "x".repeat(4000) } }]),
                locations: json!([]),
                raw_input: json!({}),
            })
            .collect()
    }

    #[test]
    fn one_chat_saving_a_huge_transcript_never_holds_up_another() {
        let dir = std::env::temp_dir().join(format!("yaah-locks-{}", random_token()));
        let hub = Arc::new(Hub::open(Arc::new(|_: &str, _: Value| {}), Some(dir.clone()), Store::user()));
        hub.set_timings(Duration::ZERO, Duration::ZERO);
        let mut form = big_entries(3000); // about 12 MB
        form.push(Entry::Ui {
            ui_id: Some("f".into()),
            title: None,
            component: None,
            version: None,
            tree: json!({ "type": "form", "children": [{ "type": "textfield", "props": { "name": "a" } }] }),
            props: json!({}),
            ask_id: None,
            answer: None,
            draft: None,
            draft_by: None,
        });
        let a = hub.shared.insert(Session::new(test_info("a"), form, Some(dir.join("a.json"))));
        let mut b = Session::new(test_info("b"), vec![], None);
        b.attached = Some(1);
        hub.shared.insert(b);
        let stream_b = |n: usize| -> Vec<Duration> {
            (0..n)
                .map(|_| {
                    let t = Instant::now();
                    hub.shared.with("b", |s| apply_update(&hub.shared, s, &chunk())).unwrap();
                    let took = t.elapsed();
                    std::thread::sleep(Duration::from_micros(500));
                    took
                })
                .collect()
        };

        // Chat A is held for half a second (as a slow save would): chat B streams on regardless.
        let (held_tx, held_rx) = mpsc::channel();
        let holder = std::thread::spawn({
            let a = a.clone();
            move || {
                let _a = a.lock().unwrap();
                held_tx.send(()).unwrap();
                std::thread::sleep(Duration::from_millis(500));
            }
        });
        held_rx.recv().unwrap();
        let lat = stream_b(100);
        assert!(!holder.is_finished(), "chat A was held the whole time");
        let worst = lat.iter().max().unwrap();
        assert!(*worst < Duration::from_millis(100), "chat B waited {worst:?} on chat A");
        holder.join().unwrap();

        // Real work on chat A: form edits saved at once, and its whole transcript read, back to back.
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let done = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let worker = std::thread::spawn({
            let (hub, stop, done) = (hub.clone(), stop.clone(), done.clone());
            move || {
                let mut slowest = Duration::ZERO;
                let mut i = 0;
                while !stop.load(Ordering::Relaxed) {
                    i += 1;
                    let t = Instant::now();
                    hub.edit_form("a", FormRef::UiId("f"), &json!({ "a": format!("v{i}") }), "user").unwrap();
                    hub.flush();
                    std::hint::black_box(hub.transcript("a").unwrap());
                    slowest = slowest.max(t.elapsed());
                    done.store(i, Ordering::Relaxed);
                }
                (i, slowest)
            }
        });
        // Chat B streams for as long as chat A takes to do a few full save+read rounds: on a slow CI runner one
        // round can outlast hundreds of chunks, so a fixed chunk count could finish before A did any work at all.
        let started = Instant::now();
        let mut lat = stream_b(200);
        while done.load(Ordering::Relaxed) < 3 && started.elapsed() < Duration::from_secs(60) {
            lat.extend(stream_b(100));
        }
        stop.store(true, Ordering::Relaxed);
        let (rounds, slowest) = worker.join().unwrap();
        lat.sort();
        let p99 = lat[lat.len() * 99 / 100];
        assert!(rounds >= 3, "chat A did {rounds} save+read rounds while chat B streamed");
        // A blocked lock would put chat B behind a whole save+read of A (tens to hundreds of ms); allow CI noise below that.
        assert!(p99 < Duration::from_millis(50), "chat B p99 {p99:?} while each save+read of A took up to {slowest:?}");
        assert!(p99 < slowest, "chat B p99 {p99:?} should stay below one save+read of A ({slowest:?})");
        let saved: Value = serde_json::from_slice(&std::fs::read(dir.join("a.json")).unwrap()).unwrap();
        assert_eq!(saved["entries"].as_array().unwrap().len(), 3001);
        assert!(saved["entries"][3000]["draft"]["a"].as_str().is_some_and(|v| v.starts_with('v')));
        std::fs::remove_dir_all(dir).ok();
    }
}

/// Lazy saves and lazy loading.
#[cfg(test)]
mod lazy_tests {
    use super::*;

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("yaah-lazy-{}", random_token()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn quiet() -> Emit {
        Arc::new(|_: &str, _: Value| {})
    }

    fn saved_title(path: &Path) -> Option<String> {
        let v: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
        v["info"]["title"].as_str().map(str::to_owned)
    }

    fn wait_for(what: &str, f: impl Fn() -> bool) {
        let started = Instant::now();
        while !f() {
            assert!(started.elapsed() < Duration::from_secs(5), "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn a_change_is_written_a_moment_later_once_per_burst() {
        let dir = temp();
        let path = dir.join("s.json");
        let hub = Hub::open(quiet(), Some(dir.clone()), Store::user());
        hub.set_timings(COALESCE, Duration::from_millis(300));
        let mut info = test_info("lazy-deleted");
        info.running = false;
        hub.shared.insert(Session::new(info, vec![], Some(path.clone())));
        let started = Instant::now();
        for i in 0..20 {
            hub.rename_session("lazy-deleted", &format!("title {i}")).unwrap();
        }
        assert!(!path.exists(), "not written straight away");
        wait_for("the save", || saved_title(&path).is_some());
        assert!(started.elapsed() >= Duration::from_millis(250), "written after the delay");
        assert_eq!(saved_title(&path).as_deref(), Some("title 19"), "the burst's last state, in one write");

        // Deleting while a save waits: the file stays gone.
        hub.rename_session("lazy-deleted", "again").unwrap();
        hub.delete_session("lazy-deleted").unwrap();
        std::thread::sleep(Duration::from_millis(500));
        assert!(!path.exists(), "a waiting save didn't bring the file back");
        std::fs::remove_dir_all(dir).ok();
    }

    /// Nothing is lost on exit: what's still waiting is written by the flush (and by dropping the Hub).
    #[test]
    fn changes_survive_an_exit() {
        let dir = temp();
        let hub = Hub::open(quiet(), Some(dir.clone()), Store::user());
        hub.set_timings(COALESCE, Duration::from_secs(3600));
        let mut s = Session::new(test_info("s"), vec![], Some(dir.join("s.json")));
        s.attached = Some(1);
        hub.shared.insert(s);
        let update = json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "kept " } });
        for _ in 0..3 {
            hub.shared.with("s", |s| apply_update(&hub.shared, s, &update)).unwrap();
            hub.shared.with("s", |s| hub.shared.save(s)).unwrap();
        }
        hub.rename_session("s", "Kept").unwrap();
        assert!(!dir.join("s.json").exists(), "nothing written yet: the delay is an hour");
        drop(hub); // the app exits

        let hub = Hub::open(quiet(), Some(dir.clone()), Store::user());
        let t = hub.transcript("s").unwrap();
        assert_eq!(t.info.title, "Kept");
        assert!(!t.info.running, "restored as stopped");
        assert!(matches!(&t.entries[..], [Entry::Agent { text, .. }] if text == "kept kept kept "));
        std::fs::remove_dir_all(dir).ok();
    }

    /// The end of a turn writes the transcript now, not after the delay.
    #[test]
    fn a_turn_end_writes_at_once() {
        let dir = temp();
        let path = dir.join("s.json");
        let hub = Hub::open(quiet(), Some(dir.clone()), Store::user());
        hub.set_timings(COALESCE, Duration::from_secs(3600));
        let mut s = Session::new(test_info("s"), vec![], Some(path.clone()));
        s.attached = Some(1);
        hub.shared.insert(s);
        let update = json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "done" } });
        hub.shared.with("s", |s| apply_update(&hub.shared, s, &update)).unwrap();
        finish_turn(&hub.shared, "s", Some("end_turn".into()), None);
        wait_for("the turn's save", || std::fs::read_to_string(&path).is_ok_and(|t| t.contains("\"done\"") && t.contains("end_turn")));
        std::fs::remove_dir_all(dir).ok();
    }

    fn write_chat(dir: &Path, id: &str, entries: usize) {
        let entries: Vec<Entry> = (0..entries).map(|i| Entry::User { text: format!("message {i}"), attachments: vec![] }).collect();
        std::fs::write(dir.join(format!("{id}.json")), serde_json::to_vec(&Transcript { info: test_info(id), entries }).unwrap()).unwrap();
    }

    fn loaded(hub: &Hub, id: &str) -> bool {
        hub.shared.chat(id).unwrap().lock().unwrap().loaded
    }

    /// Startup reads infos only: a chat whose entries can't even be parsed is still listed.
    /// Its entries are read when it is first asked for, a page at a time.
    #[test]
    fn startup_reads_infos_and_entries_load_on_first_request() {
        let dir = temp();
        write_chat(&dir, "big", 450);
        let info = serde_json::to_string(&test_info("broken")).unwrap();
        let broken = format!(r#"{{"info":{info},"entries":[{{"type":"user","text":"x","attachments":[]}},{}"#, "!".repeat(10_000));
        std::fs::write(dir.join("broken.json"), &broken).unwrap();
        std::fs::write(dir.join("junk.json"), "not a chat").unwrap();

        let hub = Hub::open(quiet(), Some(dir.clone()), Store::user());
        let mut ids: Vec<String> = hub.list_sessions().into_iter().map(|i| i.session_id).collect();
        ids.sort();
        assert_eq!(ids, ["big", "broken"], "listed without parsing entries; a file with no info is skipped");
        assert!(hub.list_sessions().iter().all(|i| !i.running), "restored as stopped");
        assert!(!loaded(&hub, "big") && !loaded(&hub, "broken"));
        assert_eq!(hub.session_info("big").unwrap().session_id, "big");
        assert!(!loaded(&hub, "big"), "the info alone doesn't read entries");

        let text = |p: &Page, k: usize| match &*p.entries[k] {
            Entry::User { text, .. } => text.clone(),
            _ => String::new(),
        };
        let last = hub.entries("big", None, None).unwrap();
        assert!(loaded(&hub, "big"));
        assert_eq!((last.from, last.total, last.entries.len()), (250, 450, PAGE), "the last page by default");
        assert_eq!(text(&last, 0), "message 250");
        let first = hub.entries("big", Some(0), Some(10)).unwrap();
        assert_eq!((first.from, first.entries.len(), text(&first, 9)), (0, 10, "message 9".into()));
        let tail = hub.entries("big", Some(445), Some(10)).unwrap();
        assert_eq!((tail.from, tail.entries.len(), text(&tail, 4)), (445, 5, "message 449".into()), "cut at the end");
        let past = hub.entries("big", Some(9999), None).unwrap();
        assert_eq!((past.from, past.total, past.entries.len()), (450, 450, 0), "from past the end is the end");
        assert!(hub.entries("big", None, Some(0)).unwrap().entries.is_empty());
        let all = hub.entries("big", None, Some(usize::MAX)).unwrap();
        assert_eq!((all.from, all.entries.len()), (0, 450));
        assert_eq!(serde_json::to_value(&first).unwrap()["entries"][0], json!({ "type": "user", "text": "message 0", "attachments": [] }));
        assert!(hub.entries("nope", None, None).is_err());

        // A transcript that can't be read says so, and the file is never written over.
        let page = hub.entries("broken", None, None).unwrap();
        assert!(matches!(&*page.entries[0], Entry::Error { message, .. } if message.contains("Couldn't read")));
        hub.rename_session("broken", "renamed").unwrap();
        hub.flush();
        assert_eq!(std::fs::read_to_string(dir.join("broken.json")).unwrap(), broken);
        std::fs::remove_dir_all(dir).ok();
    }
}

#[cfg(test)]
mod switch_tests {
    use super::*;
    use crate::agents::{CUSTOM, Draft};

    fn tool(title: &str, status: &str) -> Entry {
        Entry::Tool {
            tool_call_id: title.into(),
            title: title.into(),
            kind: None,
            status: Some(status.into()),
            content: json!([]),
            locations: json!([]),
            raw_input: Value::Null,
        }
    }

    fn shared(entries: Vec<Entry>) -> Vec<Arc<Entry>> {
        entries.into_iter().map(Arc::new).collect()
    }

    #[test]
    fn the_handoff_keeps_messages_and_one_liners_in_order() {
        let entries = shared(vec![
            Entry::User { text: "  Fix the build  ".into(), attachments: vec!["project.md".into()] },
            Entry::Thought { text: "secret musing".into(), message_id: None },
            Entry::Agent { text: "Looking.".into(), message_id: None },
            tool("cargo build", "failed"),
            Entry::Plan { entries: json!([{ "content": "a plan step" }]) },
            Entry::Permission { request_id: json!(1), tool_call_id: None, title: "Run rm".into(), options: json!([]), chosen: Some("Allow".into()) },
            Entry::Ui {
                ui_id: None,
                title: Some("Build errors".into()),
                component: None,
                version: None,
                tree: json!({}),
                props: json!({}),
                ask_id: None,
                answer: None,
                draft: None,
                draft_by: None,
            },
            Entry::Ui {
                ui_id: None,
                title: None,
                component: Some("pr-view".into()),
                version: Some(1),
                tree: json!({}),
                props: json!({}),
                ask_id: None,
                answer: None,
                draft: None,
                draft_by: None,
            },
            Entry::Notices { items: vec![] },
            Entry::Switch { account_id: "codex".into(), label: "Codex (work)".into(), from: Some("Claude".into()) },
        ]);
        let text = handoff_text("Claude", &entries);
        assert_eq!(
            text,
            "You're taking over this chat from Claude. The conversation so far:\n\n\
             User: Fix the build\n\n\
             Agent: Looking.\n\n\
             [tool] cargo build (failed)\n\n\
             [UI] Build errors\n\n\
             [UI] pr-view\n\n\
             [switched to Codex (work)]"
        );
        assert!(!text.contains("secret musing") && !text.contains("a plan step") && !text.contains("Run rm"));
        assert!(handoff_text("Claude", &[]).ends_with("(nothing yet)"));
    }

    #[test]
    fn a_long_handoff_keeps_the_newest_and_says_what_was_left_out() {
        let entries = shared((0..100).map(|i| Entry::User { text: format!("{i:03} {}", "x".repeat(996)), attachments: vec![] }).collect());
        let text = handoff_text("Claude", &entries);
        assert!(text.chars().count() <= HANDOFF_MAX_CHARS + 200, "{}", text.len());
        assert!(text.contains("User: 099 ") && !text.contains("User: 000 "), "the newest stay");
        let kept = text.matches("User: ").count();
        assert!(kept > 30 && kept < 100);
        assert!(text.contains(&format!("({} earlier entries left out)", 100 - kept)));
        let first = text.find("User: ").unwrap();
        assert!(text[first..].starts_with(&format!("User: {:03}", 100 - kept)), "oldest kept first");

        // One message longer than the whole budget keeps its end.
        let huge = shared(vec![
            Entry::User { text: "old".into(), attachments: vec![] },
            Entry::Agent { text: format!("start{}end", "y".repeat(50_000)), message_id: None },
        ]);
        let text = handoff_text("Claude", &huge);
        assert!(text.ends_with("end") && !text.contains("start") && text.contains("(1 earlier entry left out)"));
        assert!(text.chars().count() <= HANDOFF_MAX_CHARS + 200);
    }

    #[test]
    fn infos_round_trip_with_and_without_a_switch() {
        let mut info = test_info("chat-1");
        let plain = serde_json::to_value(&info).unwrap();
        assert!(plain.get("agentSessionId").is_none() && plain.get("handoffFrom").is_none(), "nothing extra for a chat never switched");
        info.agent_session_id = Some("acp-2".into());
        info.handoff_from = Some("Claude".into());
        let v = serde_json::to_value(&info).unwrap();
        assert_eq!((v["agentSessionId"].as_str(), v["handoffFrom"].as_str()), (Some("acp-2"), Some("Claude")));
        let back: SessionInfo = serde_json::from_value(v).unwrap();
        assert_eq!(back.agent_session(), "acp-2");
        // A chat saved before switching existed.
        let old: SessionInfo = serde_json::from_value(plain).unwrap();
        assert_eq!((old.agent_session(), old.handoff_from.as_deref()), ("chat-1", None));
        let entry = serde_json::to_value(Entry::Switch { account_id: "b".into(), label: "B".into(), from: None }).unwrap();
        assert_eq!(entry, json!({ "type": "switch", "accountId": "b", "label": "B", "from": null }));
    }

    #[test]
    fn switching_is_refused_mid_turn_and_to_the_same_agent() {
        let dir = std::env::temp_dir().join(format!("yaah-switch-{}", random_token()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("agents.json"), r#"{ "profiles": [] }"#).unwrap();
        let profiles: &'static Store = Box::leak(Box::new(Store::at(dir.join("agents.json"))));
        let add = |label: &str| {
            let draft = Draft { label: label.into(), preset: CUSTOM.into(), command_line: "true".into(), ..Draft::default() };
            profiles.save(&draft).unwrap().0.id
        };
        let (alpha, beta, gamma) = (add("Alpha"), add("Beta"), add("Gamma"));
        let events: Arc<Mutex<Vec<(String, Value)>>> = Arc::default();
        let sink = events.clone();
        let hub = Hub::open(Arc::new(move |n: &str, v: Value| sink.lock().unwrap().push((n.to_owned(), v))), None, profiles);
        let mut info = test_info("sw");
        info.account_id.clone_from(&alpha);
        info.commands = vec![json!({ "name": "review" })];
        let mut s = Session::new(info, vec![Entry::User { text: "hi".into(), attachments: vec![] }], None);
        s.attached = Some(7);
        hub.shared.insert(s);

        assert!(hub.switch_agent("sw", &beta).unwrap_err().contains("Wait for the turn"), "refused while a turn runs");
        hub.shared.with("sw", |s| s.info.running = false).unwrap();
        assert_eq!(hub.switch_agent("sw", &alpha).unwrap_err(), "This chat already uses Alpha.");
        assert!(hub.switch_agent("sw", "nobody").is_err());
        assert!(hub.switch_agent("nope", &beta).is_err());

        let info = hub.switch_agent("sw", &beta).unwrap();
        assert_eq!((info.account_id.as_str(), info.handoff_from.as_deref()), (beta.as_str(), Some("Alpha")));
        assert!(info.commands.is_empty(), "the new agent sends its own commands");
        hub.shared.with("sw", |s| assert_eq!(s.attached, None)).unwrap();
        let t = hub.transcript("sw").unwrap();
        assert!(
            matches!(&t.entries[1], Entry::Switch { account_id, label, from: Some(f) } if *account_id == beta && label == "Beta" && f == "Alpha")
        );
        let ev = events.lock().unwrap();
        assert!(ev.iter().any(|(n, v)| n == "session-entry" && v["entry"]["type"] == "switch"));
        assert!(ev.iter().any(|(n, v)| n == "session-info" && v["accountId"] == beta.as_str()));
        drop(ev);

        // Again before any prompt: the hand-off is still from the agent that spoke.
        let info = hub.switch_agent("sw", &gamma).unwrap();
        assert_eq!(info.handoff_from.as_deref(), Some("Alpha"));
        assert!(matches!(&hub.transcript("sw").unwrap().entries[2], Entry::Switch { from: Some(f), .. } if f == "Beta"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod dirs_tests {
    use super::*;
    use crate::projects::Status;

    /// A temp folder with `names` made inside it; returns it and their paths.
    fn folders(names: &[&str]) -> (PathBuf, Vec<String>) {
        let root = std::env::temp_dir().join(format!("yaah-dirs-{}", random_token()));
        let paths = names
            .iter()
            .map(|n| {
                std::fs::create_dir_all(root.join(n)).unwrap();
                root.join(n).to_string_lossy().into_owned()
            })
            .collect();
        (root, paths)
    }

    /// A hub over its own agent profiles (one, `Scripted`), saving chats in `root/sessions`.
    fn hub(root: &Path) -> (Hub, String) {
        let profiles: &'static Store = Box::leak(Box::new(Store::at(root.join("agents.json"))));
        std::fs::write(root.join("agents.json"), r#"{ "profiles": [] }"#).unwrap();
        let draft =
            agents::Draft { label: "Scripted".into(), preset: agents::CUSTOM.into(), command_line: "true".into(), ..agents::Draft::default() };
        let id = profiles.save(&draft).unwrap().0.id;
        (Hub::open(Arc::new(|_: &str, _: Value| {}), Some(root.join("sessions")), profiles), id)
    }

    fn chat(hub: &Hub, root: &Path, id: &str, account: &str, cwd: &str, project: Option<&Project>) -> String {
        let mut info = test_info(id);
        info.running = false;
        info.account_id = account.into();
        cwd.clone_into(&mut info.cwd);
        if let Some(p) = project {
            info.project_id = Some(p.id.clone());
            info.additional_dirs = p.additional_dirs();
        }
        hub.shared.insert(Session::new(info, vec![], Some(root.join("sessions").join(file_name(id)))));
        id.to_owned()
    }

    fn project(root: &Path, dirs: &[String]) -> Project {
        let ctx = root.join("ctx");
        std::fs::create_dir_all(&ctx).unwrap();
        Project {
            id: "p1".into(),
            name: "Shop".into(),
            dirs: dirs.to_vec(),
            status: Status::Ongoing,
            created_at: 0,
            context_dir: ctx.to_string_lossy().into_owned(),
            link: None,
            agent_id: None,
        }
    }

    fn added(hub: &Hub, sid: &str) -> Vec<(Vec<String>, String)> {
        hub.transcript(sid)
            .unwrap()
            .entries
            .into_iter()
            .filter_map(|e| if let Entry::AddedDirs { paths, to } = e { Some((paths, to)) } else { None })
            .collect()
    }

    fn never(_: &str, _: &[String]) -> Result<Option<Project>, String> {
        panic!("a quick chat has no project to add to")
    }

    #[test]
    fn new_folders_must_exist_be_folders_and_be_new() {
        let (root, p) = folders(&["cwd", "a", "b"]);
        let (cwd, a, b) = (&p[0], &p[1], &p[2]);
        std::fs::write(root.join("file"), "x").unwrap();

        let got =
            new_dirs(cwd, std::slice::from_ref(b), &[a.clone(), format!("{a}/"), cwd.clone(), format!("{cwd}/"), b.clone(), a.clone()]).unwrap();
        assert_eq!(got, std::slice::from_ref(a), "repeats, the cwd (however it ends) and folders the chat has are left out");
        assert_eq!(new_dirs(&format!("{cwd}/"), &[], std::slice::from_ref(cwd)).unwrap(), Vec::<String>::new(), "the cwd never twice");
        for bad in [root.join("missing").to_string_lossy().into_owned(), root.join("file").to_string_lossy().into_owned(), "relative/dir".into()] {
            assert!(new_dirs(cwd, &[], &[a.clone(), bad.clone()]).is_err(), "{bad} fails the whole call");
        }
        let _ = std::fs::remove_dir_all(root); // the saver may still be writing
    }

    #[test]
    fn a_project_chats_folders_are_the_projects_and_its_own_each_once() {
        let (root, p) = folders(&["repo", "other", "mine"]);
        let project = project(&root, &p[..2]);
        let ctx = project.context_dir.clone();
        assert_eq!(project_chat_dirs(&project, &p[0], &[]), [p[1].clone(), ctx.clone()], "as a new project chat gets them");
        assert_eq!(project_chat_dirs(&project, &p[2], &[p[1].clone()]), [p[0].clone(), p[1].clone(), ctx.clone()], "a chat moved in from elsewhere");
        let _ = std::fs::remove_dir_all(root); // the saver may still be writing
    }

    #[test]
    fn a_quick_chat_keeps_added_folders_as_its_own() {
        let (root, p) = folders(&["cwd", "a", "b"]);
        let (hub, account) = hub(&root);
        let sid = chat(&hub, &root, &format!("quick-{}", random_token()), &account, &p[0], None);

        let info = hub.add_dirs(&sid, &[p[1].clone(), p[1].clone(), p[0].clone()], never).unwrap();
        assert_eq!((info.extra_dirs.clone(), info.additional_dirs.clone()), (vec![p[1].clone()], vec![p[1].clone()]));
        assert!(info.dirs_changed, "the next prompt reopens the session with it");
        assert_eq!(added(&hub, &sid), [(vec![p[1].clone()], "chat".to_owned())]);

        let again = hub.add_dirs(&sid, &[format!("{}/", p[1]), p[0].clone()], never).unwrap();
        assert_eq!(again.extra_dirs, [p[1].clone()], "nothing new");
        assert_eq!(added(&hub, &sid).len(), 1, "and no notice for nothing");
        assert!(hub.add_dirs(&sid, &[p[2].clone(), root.join("nope").to_string_lossy().into_owned()], never).is_err());
        assert_eq!(hub.session_info(&sid).unwrap().extra_dirs, [p[1].clone()], "all or nothing");
        let info = hub.add_dirs(&sid, std::slice::from_ref(&p[2]), never).unwrap();
        assert_eq!(info.extra_dirs, [p[1].clone(), p[2].clone()]);
        assert!(hub.add_dirs("no-such-chat", std::slice::from_ref(&p[2]), never).is_err());
        let _ = std::fs::remove_dir_all(root); // the saver may still be writing
    }

    #[test]
    fn a_project_chat_adds_to_the_project_and_every_chat_in_it_follows() {
        let (root, p) = folders(&["repo", "new", "elsewhere"]);
        let (hub, account) = hub(&root);
        let before = project(&root, &p[..1]);
        let (one, two) = (format!("one-{}", random_token()), format!("two-{}", random_token()));
        chat(&hub, &root, &one, &account, &p[0], Some(&before));
        chat(&hub, &root, &two, &account, &p[0], Some(&before));
        let mut other_project = before.clone();
        other_project.id = "p2".into();
        let other = chat(&hub, &root, &format!("other-{}", random_token()), &account, &p[0], Some(&other_project));
        let quick = chat(&hub, &root, &format!("quick-{}", random_token()), &account, &p[2], None);

        let asked = std::cell::RefCell::new(None);
        let info = hub
            .add_dirs(&one, std::slice::from_ref(&p[1]), |id, dirs| {
                *asked.borrow_mut() = Some((id.to_owned(), dirs.to_vec()));
                let mut after = before.clone();
                after.dirs.extend(dirs.iter().cloned());
                Ok(Some(after))
            })
            .unwrap();
        assert_eq!(asked.take(), Some(("p1".to_owned(), vec![p[1].clone()])), "the folder goes to the project");
        let expected = vec![p[1].clone(), before.context_dir.clone()];
        assert_eq!((info.additional_dirs.clone(), info.extra_dirs.clone(), info.dirs_changed), (expected.clone(), vec![], true));
        let two_info = hub.session_info(&two).unwrap();
        assert_eq!((two_info.additional_dirs, two_info.dirs_changed), (expected, true), "the project's other chat gets it on its next prompt");
        for untouched in [&other, &quick] {
            let i = hub.session_info(untouched).unwrap();
            assert!(!i.dirs_changed && !i.additional_dirs.contains(&p[1]), "{untouched}");
        }
        assert_eq!(added(&hub, &one), [(vec![p[1].clone()], "project".to_owned())]);
        assert!(added(&hub, &two).is_empty(), "the notice is in the chat it was added from");

        // A chat filed under a project that's gone keeps them itself.
        let info = hub.add_dirs(&other, std::slice::from_ref(&p[1]), |_, _| Ok(None)).unwrap();
        assert_eq!(info.extra_dirs, [p[1].clone()]);
        assert_eq!(added(&hub, &other), [(vec![p[1].clone()], "chat".to_owned())]);
        let _ = std::fs::remove_dir_all(root); // the saver may still be writing
    }

    #[test]
    fn added_folders_and_their_notice_survive_a_restart() {
        let (root, p) = folders(&["cwd", "a"]);
        let (hub, account) = hub(&root);
        let sid = chat(&hub, &root, &format!("kept-{}", random_token()), &account, &p[0], None);
        hub.add_dirs(&sid, std::slice::from_ref(&p[1]), never).unwrap();
        hub.flush();
        let profiles = hub.shared.profiles;
        drop(hub);

        let hub = Hub::open(Arc::new(|_: &str, _: Value| {}), Some(root.join("sessions")), profiles);
        let info = hub.session_info(&sid).unwrap();
        assert_eq!((info.extra_dirs, info.additional_dirs, info.dirs_changed), (vec![p[1].clone()], vec![p[1].clone()], true));
        assert_eq!(added(&hub, &sid), [(vec![p[1].clone()], "chat".to_owned())]);
        let saved: Value = serde_json::from_slice(&std::fs::read(root.join("sessions").join(file_name(&sid))).unwrap()).unwrap();
        assert_eq!(saved["entries"][0], json!({ "type": "addedDirs", "paths": [p[1]], "to": "chat" }), "the notice as the UI gets it");
        assert_eq!(saved["info"]["extraDirs"], json!([p[1]]));
        let _ = std::fs::remove_dir_all(root); // the saver may still be writing
    }

    #[test]
    fn mid_turn_the_notice_waits_for_the_turn_to_end() {
        let (root, p) = folders(&["cwd", "a"]);
        let (hub, account) = hub(&root);
        let sid = chat(&hub, &root, &format!("busy-{}", random_token()), &account, &p[0], None);
        hub.shared.with(&sid, |s| s.info.running = true).unwrap();
        let info = hub.add_dirs(&sid, std::slice::from_ref(&p[1]), never).unwrap();
        assert!(info.dirs_changed && info.extra_dirs == [p[1].clone()], "accepted, for the next prompt");
        assert!(added(&hub, &sid).is_empty(), "not in the middle of the reply");
        finish_turn(&hub.shared, &sid, Some("end_turn".into()), None);
        assert_eq!(added(&hub, &sid), [(vec![p[1].clone()], "chat".to_owned())]);
        let _ = std::fs::remove_dir_all(root); // the saver may still be writing
    }

    #[test]
    fn an_agent_that_cant_use_several_folders_is_refused() {
        let (root, p) = folders(&["cwd", "a"]);
        let (hub, account) = hub(&root);
        hub.shared.profiles.record_report(&account, &agents::Report { compatible: true, additional_dirs: false, ..agents::Report::default() });
        let sid = chat(&hub, &root, &format!("single-{}", random_token()), &account, &p[0], None);
        let err = hub.add_dirs(&sid, std::slice::from_ref(&p[1]), never).unwrap_err();
        assert!(err.contains("Scripted can't work across several folders"), "{err}");
        assert_eq!(hub.session_info(&sid).unwrap().extra_dirs, Vec::<String>::new());
        let _ = std::fs::remove_dir_all(root); // the saver may still be writing
    }

    #[test]
    fn the_handoff_mentions_added_folders() {
        let entries = vec![Arc::new(Entry::AddedDirs { paths: vec!["/w/api".into(), "/w/web".into()], to: "project".into() })];
        assert!(handoff_text("Scripted", &entries).contains("[added /w/api, /w/web to this project]"));
    }
}
