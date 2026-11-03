//! Terminals: a shell or a command in a pseudo-terminal (`portable-pty`), for
//! terminal panes and for agents' commands (ACP `terminal/*`, `acp_terminals.rs`).
//!
//! Rust only moves bytes, so the UI's terminal engine can change without touching
//! this: what the program prints goes to each view as raw bytes ([`Frame::Data`],
//! a Tauri channel per view in the app), batched every [`BATCH`]; keys come back
//! as bytes ([`Term::write`]); a view's size goes to the PTY ([`Term::resize`]).
//!
//! - **Scrollback.** The last [`SCROLLBACK`] bytes stay here, so a view that
//!   mounts again (a pane re-rendered, a tool card scrolled back into view) gets
//!   what it missed on [`Terminals::attach`], then the live stream.
//! - **Backpressure.** Each view acknowledges the bytes it has drawn
//!   ([`Terminals::ack`]). While one is more than [`HIGH_WATER`] behind, the reader
//!   stops reading the PTY, so a program printing faster than the UI draws is held
//!   up by the kernel's PTY buffer instead of filling memory. A view that hasn't
//!   acknowledged anything for [`STALL`] no longer holds it up.
//! - **Agents' terminals** also keep their output as plain text (escape sequences
//!   and carriage returns removed), at most the `outputByteLimit` the agent asked
//!   for, cut from the start at a character boundary; that is what `terminal/output`
//!   answers with. Once released, their last bytes are kept for the app's lifetime
//!   ([`RETIRED_BYTES`] in all), so the tool card that showed one can replay it.
//! - **Processes.** Every terminal's process is a session leader on its PTY. Closing
//!   (a pane closed, the app quitting) drops the PTY, which hangs up its programs,
//!   sends SIGHUP then SIGKILL to the process, and SIGKILL to what's left of its
//!   process group.
//!
//! Commands run as an argv, never through a shell of ours: a shell pane runs the
//! user's login shell (`$SHELL -l`), and an agent's command without arguments runs
//! as `/bin/sh -c <command>`, as ACP clients do. Every one gets the login-shell PATH
//! (`path_env`), `TERM=xterm-256color`, and a cwd that is checked to be a folder.

use crate::session::Emit;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use serde_json::json;
use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

/// The bytes kept per terminal for a view that attaches later.
pub const SCROLLBACK: usize = 256 << 10;
/// What a view gets at most this often: one message per batch, not one per read.
pub const BATCH: Duration = Duration::from_millis(16);
/// A view this far behind (bytes sent, not yet acknowledged) pauses the reader.
pub const HIGH_WATER: usize = 1 << 20;
/// A batch goes out early once this much is waiting.
const FLUSH_AT: usize = 64 << 10;
/// Read but not yet sent to a view, at most: the pump sends it within a batch. Below the
/// scrollback, so nothing is read that a view would miss.
const UNSENT_MAX: usize = SCROLLBACK / 2;
/// A view that acknowledged nothing for this long no longer pauses the reader.
pub const STALL: Duration = Duration::from_secs(2);
/// After the process exits, how long its last output gets to arrive.
const EXIT_DRAIN: Duration = Duration::from_millis(250);
/// The text an agent's terminal keeps when the agent sets no `outputByteLimit`.
pub const DEFAULT_OUTPUT_LIMIT: usize = 1 << 20;
/// The most an agent's terminal keeps, whatever limit it asks for.
pub const MAX_OUTPUT_LIMIT: usize = 16 << 20;
/// Released agents' terminals' bytes kept, in all; the oldest go first.
pub const RETIRED_BYTES: usize = 32 << 20;
/// Terminals running at once.
pub const MAX_TERMINALS: usize = 128;
const READ_CHUNK: usize = 32 << 10;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// How a terminal's process ended. ACP's `TerminalExitStatus`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitStatus {
    pub exit_code: Option<u32>,
    /// `SIGKILL`, `SIGHUP`, … when a signal ended it.
    pub signal: Option<String>,
}

impl ExitStatus {
    fn from_pty(s: &portable_pty::ExitStatus) -> Self {
        match s.signal() {
            Some(sig) => Self { exit_code: None, signal: Some(signal_name(sig)) },
            None => Self { exit_code: Some(s.exit_code()), signal: None },
        }
    }
}

/// `strsignal`'s words ("Killed: 9" on macOS, "Killed" on Linux) as a signal's name.
fn signal_name(text: &str) -> String {
    let t = text.to_ascii_lowercase();
    let known = [
        ("hangup", "SIGHUP"),
        ("interrupt", "SIGINT"),
        ("quit", "SIGQUIT"),
        ("killed", "SIGKILL"),
        ("terminated", "SIGTERM"),
        ("broken pipe", "SIGPIPE"),
        ("abort", "SIGABRT"),
        ("segmentation", "SIGSEGV"),
    ];
    known.iter().find(|(words, _)| t.contains(words)).map_or_else(|| text.to_owned(), |(_, name)| (*name).to_owned())
}

/// What a view of a terminal is sent: bytes as printed, then how it ended.
pub enum Frame<'a> {
    Data(&'a [u8]),
    Exit(&'a ExitStatus),
}

/// Where a view's frames go. Returns false once the view is gone, which detaches it.
pub type Sink = Box<dyn Fn(Frame<'_>) -> bool + Send + Sync>;

/// Who a terminal belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Owner {
    /// A terminal pane's shell: the UI opens, writes to and closes it.
    User,
    /// An agent's command (ACP `terminal/create`): only the agent process that
    /// created it (by its generation) for that chat can read, wait on, kill or
    /// release it. The UI only watches it, and can stop it.
    Agent { generation: u64, chat: String },
}

/// What to run, where.
#[derive(Debug, Clone)]
pub struct Spec {
    pub program: OsString,
    pub args: Vec<OsString>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
    /// How it's shown: the shell's name, or the command line.
    pub title: String,
}

impl Spec {
    /// The user's login shell (`shell`, else `$SHELL`) in `cwd`.
    pub fn login_shell(cwd: PathBuf, shell: Option<&str>, cols: u16, rows: u16) -> Result<Self, String> {
        let shell = match shell {
            Some(s) => {
                let p = Path::new(s);
                if !p.is_absolute() || crate::path_env::which(s).is_none() {
                    return Err(format!("{s} isn't a program yaah can start as a shell"));
                }
                p.to_path_buf()
            }
            None => default_shell(),
        };
        let title = shell.file_name().map_or_else(|| "shell".into(), |n| n.to_string_lossy().into_owned());
        Ok(Self { program: shell.into_os_string(), args: vec!["-l".into()], cwd, env: vec![], cols, rows, title })
    }

    /// An agent's command: `command` with `args`, or `/bin/sh -c command` when it has none.
    pub fn command(cwd: PathBuf, command: &str, args: &[String], env: Vec<(String, String)>, cols: u16, rows: u16) -> Result<Self, String> {
        if command.trim().is_empty() {
            return Err("no command to run".into());
        }
        if command.contains('\0') || args.iter().any(|a| a.contains('\0')) {
            return Err("a command can't contain NUL".into());
        }
        if let Some((k, _)) = env.iter().find(|(k, _)| k.is_empty() || k.contains(['=', '\0'])) {
            return Err(format!("not an environment variable name: {k:?}"));
        }
        let title = if args.is_empty() {
            command.to_owned()
        } else {
            crate::agents::join_args(std::iter::once(command).chain(args.iter().map(String::as_str)))
        };
        let (program, args): (OsString, Vec<OsString>) = if args.is_empty() {
            ("/bin/sh".into(), vec!["-c".into(), command.into()])
        } else {
            (command.into(), args.iter().map(OsString::from).collect())
        };
        Ok(Self { program, args, cwd, env, cols, rows, title })
    }
}

/// `$SHELL`, else the platform's usual one.
pub fn default_shell() -> PathBuf {
    std::env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute() && p.is_file())
        .unwrap_or_else(|| PathBuf::from(if cfg!(target_os = "macos") { "/bin/zsh" } else { "/bin/sh" }))
}

/// `path` if it is an absolute path to an existing folder, resolved (symlinks, `..`).
pub fn checked_dir(path: &str) -> Result<PathBuf, String> {
    if path.contains('\0') {
        return Err("not a folder".into());
    }
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err(format!("{path} isn't an absolute path"));
    }
    let real = p.canonicalize().map_err(|_| format!("{path} doesn't exist"))?;
    if !real.is_dir() {
        return Err(format!("{path} isn't a folder"));
    }
    Ok(real)
}

/// Strips escape sequences as bytes arrive, keeping text, newlines and tabs.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum Strip {
    #[default]
    Ground,
    Esc,
    Csi,
    /// OSC, DCS, SOS, PM, APC: up to BEL or ST.
    Str,
    StrEsc,
}

impl Strip {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) {
        use Strip::{Csi, Esc, Ground, Str, StrEsc};
        for &b in input {
            *self = match (*self, b) {
                // ESC starts a sequence; intermediates, as in `ESC ( B`, continue one.
                (Ground, 0x1b) | (Esc, 0x20..=0x2f) => Esc,
                (Ground, b'\n' | b'\t') => {
                    out.push(b);
                    Ground
                }
                (Ground, b) if b < 0x20 || b == 0x7f => Ground,
                (Ground, b) => {
                    out.push(b);
                    Ground
                }
                (Esc, b'[') => Csi,
                (Esc, b']' | b'P' | b'X' | b'^' | b'_') => Str,
                (Esc | Csi, 0x40..=0x7e) | (Esc, _) | (Str, 0x07) | (StrEsc, b'\\') => Ground,
                (Csi, _) => Csi,
                (Str, 0x1b) => StrEsc,
                (Str | StrEsc, _) => Str,
            };
        }
    }
}

/// An agent terminal's output as text, at most `limit` bytes of it.
struct Output {
    text: Vec<u8>,
    limit: usize,
    truncated: bool,
    strip: Strip,
}

impl Output {
    fn new(limit: usize) -> Self {
        Self { text: Vec::new(), limit, truncated: false, strip: Strip::default() }
    }

    fn push(&mut self, bytes: &[u8]) {
        self.strip.feed(bytes, &mut self.text);
        // Cut now and then, not on every read.
        if self.text.len() > self.limit + (self.limit / 4).max(4096) {
            self.cut();
        }
    }

    fn cut(&mut self) {
        if self.text.len() <= self.limit {
            return;
        }
        let mut from = self.text.len() - self.limit;
        // Never start inside a character.
        while from < self.text.len() && (self.text[from] & 0xC0) == 0x80 {
            from += 1;
        }
        self.text.drain(..from);
        self.truncated = true;
    }

    /// The text, without a character the program hasn't finished printing.
    fn read(&mut self) -> (String, bool) {
        self.cut();
        let end = match std::str::from_utf8(&self.text) {
            Err(e) if e.error_len().is_none() => e.valid_up_to(),
            Ok(_) | Err(_) => self.text.len(),
        };
        (String::from_utf8_lossy(&self.text[..end]).into_owned(), self.truncated)
    }
}

struct Viewer {
    id: u64,
    sink: Sink,
    /// The stream offset it has been sent up to.
    upto: u64,
    /// Bytes sent and not acknowledged yet.
    inflight: usize,
    last_ack: Instant,
}

struct State {
    /// The last [`SCROLLBACK`] bytes.
    scrollback: VecDeque<u8>,
    /// Bytes read from the PTY so far.
    total: u64,
    /// Up to where every view has been sent what was read.
    sent: u64,
    /// Agents' terminals: their output as text.
    output: Option<Output>,
    exit: Option<ExitStatus>,
    exited_at: Option<Instant>,
    /// The PTY read end of file (every program holding it is gone).
    eof: bool,
    /// The views were told how it ended: nothing more comes.
    finished: bool,
    viewers: Vec<Viewer>,
    next_viewer: u64,
    cols: u16,
    rows: u16,
}

impl State {
    /// Whether the reader should wait: a view far behind on what it was sent, or more
    /// read than a view has been sent yet than the scrollback holds (it would never get it).
    fn lagging(&self) -> bool {
        self.viewers.iter().any(|v| {
            let unsent = usize::try_from(self.total - v.upto).unwrap_or(usize::MAX);
            unsent > UNSENT_MAX || (v.inflight + unsent > HIGH_WATER && v.last_ack.elapsed() < STALL)
        })
    }

    /// The scrollback from stream offset `from` on (or from its start, if `from` scrolled out).
    fn since(&self, from: u64) -> Vec<u8> {
        let start = self.total - self.scrollback.len() as u64;
        let skip = usize::try_from(from.saturating_sub(start)).unwrap_or(usize::MAX).min(self.scrollback.len());
        self.scrollback.range(skip..).copied().collect()
    }

    /// Send what was read since the last flush to every view.
    fn flush(&mut self) {
        if self.total == self.sent {
            return;
        }
        let mut chunks: HashMap<u64, Vec<u8>> = HashMap::new();
        let total = self.total;
        let ups: Vec<u64> = self.viewers.iter().map(|v| v.upto).collect();
        for from in ups {
            if from < total {
                chunks.entry(from).or_insert_with(|| self.since(from));
            }
        }
        self.viewers.retain_mut(|v| {
            let Some(bytes) = chunks.get(&v.upto) else { return true };
            v.upto = total;
            v.inflight += bytes.len();
            (v.sink)(Frame::Data(bytes))
        });
        self.sent = total;
    }
}

/// One terminal: its PTY, its process and what it printed.
pub struct Term {
    pub id: String,
    pub owner: Owner,
    pub cwd: PathBuf,
    pub title: String,
    pub pid: Option<u32>,
    /// Taken (dropped) on close, which hangs up the PTY.
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    state: Mutex<State>,
    changed: Condvar,
    opened: Instant,
}

/// What a view gets when it attaches.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attached {
    pub id: String,
    /// This view, for [`Terminals::ack`] and [`Terminals::detach`].
    pub viewer: u64,
    pub cwd: String,
    pub title: String,
    /// An agent's command (read-only to the UI) rather than a shell pane.
    pub agent: bool,
    pub cols: u16,
    pub rows: u16,
    pub exit: Option<ExitStatus>,
    /// False for a released agent terminal replayed from what was kept.
    pub live: bool,
}

impl Term {
    fn spawn(
        id: String,
        spec: Spec,
        owner: Owner,
        output_limit: Option<usize>,
        on_finish: Box<dyn FnOnce(&Term) + Send>,
    ) -> Result<Arc<Self>, String> {
        let size = PtySize { rows: spec.rows.max(1), cols: spec.cols.max(1), pixel_width: 0, pixel_height: 0 };
        let pair = native_pty_system().openpty(size).map_err(|e| format!("couldn't open a terminal: {e}"))?;
        let mut cmd = CommandBuilder::new(&spec.program);
        cmd.args(&spec.args);
        cmd.cwd(&spec.cwd);
        cmd.env("PATH", crate::path_env::path());
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "yaah");
        cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
        // Apps started from Finder have no locale; a shell without one mangles UTF-8.
        if std::env::var_os("LANG").is_none() && std::env::var_os("LC_ALL").is_none() && std::env::var_os("LC_CTYPE").is_none() {
            cmd.env("LANG", "en_US.UTF-8");
        }
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("couldn't start {}: {e}", spec.program.to_string_lossy()))?;
        // Only the child holds the PTY's other end now, so its exit ends our reads.
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let term = Arc::new(Self {
            id,
            owner,
            cwd: spec.cwd,
            title: spec.title,
            pid: child.process_id(),
            killer: Mutex::new(child.clone_killer()),
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(writer)),
            state: Mutex::new(State {
                scrollback: VecDeque::new(),
                total: 0,
                sent: 0,
                output: output_limit.map(|l| Output::new(l.clamp(1, MAX_OUTPUT_LIMIT))),
                exit: None,
                exited_at: None,
                eof: false,
                finished: false,
                viewers: vec![],
                next_viewer: 1,
                cols: size.cols,
                rows: size.rows,
            }),
            changed: Condvar::new(),
            opened: Instant::now(),
        });
        let named = |what: &str| std::thread::Builder::new().name(format!("yaah-term-{what}"));
        let t = term.clone();
        named("read").spawn(move || t.read_loop(reader)).map_err(|e| e.to_string())?;
        let t = term.clone();
        named("wait")
            .spawn(move || {
                let status = child.wait().map_or(ExitStatus { exit_code: None, signal: None }, |s| ExitStatus::from_pty(&s));
                let mut st = lock(&t.state);
                st.exit = Some(status);
                st.exited_at = Some(Instant::now());
                t.changed.notify_all();
            })
            .map_err(|e| e.to_string())?;
        let t = term.clone();
        named("pump")
            .spawn(move || {
                t.pump();
                on_finish(&t);
            })
            .map_err(|e| e.to_string())?;
        Ok(term)
    }

    fn read_loop(&self, mut reader: Box<dyn Read + Send>) {
        let mut buf = vec![0u8; READ_CHUNK];
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            let mut st = lock(&self.state);
            let bytes = &buf[..n];
            st.scrollback.extend(bytes);
            let over = st.scrollback.len().saturating_sub(SCROLLBACK);
            st.scrollback.drain(..over);
            st.total += n as u64;
            if let Some(out) = &mut st.output {
                out.push(bytes);
            }
            self.changed.notify_all();
            // A view far behind holds up reading, so the program waits on the PTY instead of us buffering.
            while st.lagging() {
                st = self.changed.wait_timeout(st, Duration::from_millis(50)).unwrap_or_else(PoisonError::into_inner).0;
            }
        }
        lock(&self.state).eof = true;
        self.changed.notify_all();
    }

    /// Sends what was read to the views, a batch at a time, then how it ended.
    fn pump(&self) {
        loop {
            let mut st = lock(&self.state);
            loop {
                if st.total > st.sent {
                    break;
                }
                if let Some(at) = st.exited_at
                    && (st.eof || at.elapsed() >= EXIT_DRAIN)
                {
                    st.flush();
                    st.finished = true;
                    let exit = st.exit.clone().unwrap_or(ExitStatus { exit_code: None, signal: None });
                    st.viewers.retain(|v| (v.sink)(Frame::Exit(&exit)));
                    self.changed.notify_all();
                    return;
                }
                let wait = st.exited_at.map_or(Duration::from_secs(1), |at| EXIT_DRAIN.saturating_sub(at.elapsed()).max(Duration::from_millis(5)));
                st = self.changed.wait_timeout(st, wait).unwrap_or_else(PoisonError::into_inner).0;
            }
            // Collect for a batch, or less when a lot came in already (a program printing as fast as it can).
            let deadline = Instant::now() + BATCH;
            loop {
                let now = Instant::now();
                if now >= deadline || st.total - st.sent >= FLUSH_AT as u64 {
                    break;
                }
                st = self.changed.wait_timeout(st, deadline - now).unwrap_or_else(PoisonError::into_inner).0;
            }
            st.flush();
            self.changed.notify_all();
        }
    }

    fn attach(&self, sink: Sink) -> Attached {
        let mut st = lock(&self.state);
        let id = st.next_viewer;
        st.next_viewer += 1;
        let total = st.total;
        let backlog: Vec<u8> = st.scrollback.iter().copied().collect();
        let mut alive = backlog.is_empty() || sink(Frame::Data(&backlog));
        if alive && st.finished {
            alive = sink(Frame::Exit(st.exit.as_ref().unwrap_or(&ExitStatus { exit_code: None, signal: None })));
        }
        if alive && !st.finished {
            st.viewers.push(Viewer { id, sink, upto: total, inflight: backlog.len(), last_ack: Instant::now() });
        }
        Attached {
            id: self.id.clone(),
            viewer: id,
            cwd: self.cwd.to_string_lossy().into_owned(),
            title: self.title.clone(),
            agent: matches!(self.owner, Owner::Agent { .. }),
            cols: st.cols,
            rows: st.rows,
            exit: st.finished.then(|| st.exit.clone()).flatten(),
            live: true,
        }
    }

    fn detach(&self, viewer: u64) {
        lock(&self.state).viewers.retain(|v| v.id != viewer);
        self.changed.notify_all();
    }

    fn ack(&self, viewer: u64, bytes: usize) {
        let mut st = lock(&self.state);
        if let Some(v) = st.viewers.iter_mut().find(|v| v.id == viewer) {
            v.inflight = v.inflight.saturating_sub(bytes);
            v.last_ack = Instant::now();
        }
        self.changed.notify_all();
    }

    /// Type into it.
    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        let mut w = lock(&self.writer);
        let w = w.as_mut().ok_or("this terminal is closed")?;
        w.write_all(data).and_then(|()| w.flush()).map_err(|e| format!("couldn't write to the terminal: {e}"))
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let (cols, rows) = (cols.clamp(2, 1000), rows.clamp(1, 500));
        let m = lock(&self.master);
        let m = m.as_ref().ok_or("this terminal is closed")?;
        m.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
        let mut st = lock(&self.state);
        st.cols = cols;
        st.rows = rows;
        Ok(())
    }

    /// Stop its process: SIGHUP, then SIGKILL, and its process group after it. Returns at once.
    pub fn kill(&self) {
        let mut killer = lock(&self.killer).clone_killer();
        let pid = self.pid;
        let _ = std::thread::Builder::new().name("yaah-term-kill".into()).spawn(move || {
            let _ = killer.kill();
            // The process was a session (and group) leader; what it started may still be in its group.
            // Its id can't be reused while that group has members.
            if let Some(pid) = pid {
                let _ = crate::path_env::command("kill").args(["-KILL", "--", &format!("-{pid}")]).stderr(std::process::Stdio::null()).status();
            }
        });
    }

    /// Hang up the PTY and stop the process.
    fn close(&self) {
        lock(&self.writer).take();
        lock(&self.master).take();
        if !lock(&self.state).finished {
            self.kill();
        }
    }

    pub fn exit(&self) -> Option<ExitStatus> {
        let st = lock(&self.state);
        if st.finished { st.exit.clone() } else { None }
    }

    /// Wait until its process has exited and its output is in (or `timeout` passes).
    pub fn wait(&self, timeout: Option<Duration>) -> Option<ExitStatus> {
        let st = lock(&self.state);
        let st = match timeout {
            Some(t) => self.changed.wait_timeout_while(st, t, |s| !s.finished).unwrap_or_else(PoisonError::into_inner).0,
            None => self.changed.wait_while(st, |s| !s.finished).unwrap_or_else(PoisonError::into_inner),
        };
        if st.finished { st.exit.clone() } else { None }
    }

    /// An agent's terminal: its output as text so far, and whether the start was cut.
    pub fn output(&self) -> (String, bool) {
        lock(&self.state).output.as_mut().map_or_else(|| (String::new(), false), Output::read)
    }

    /// The bytes it keeps (the scrollback) and how many it read in all.
    pub fn scrollback(&self) -> (Vec<u8>, u64) {
        let st = lock(&self.state);
        (st.scrollback.iter().copied().collect(), st.total)
    }

    pub fn age(&self) -> Duration {
        self.opened.elapsed()
    }
}

impl Drop for Term {
    fn drop(&mut self) {
        // The last reference gone (the app quitting): nothing may outlive it.
        self.close();
    }
}

/// A released agent terminal's last bytes, for its tool card.
struct Retired {
    title: String,
    cwd: String,
    bytes: Vec<u8>,
    exit: Option<ExitStatus>,
}

/// Every terminal, by id.
pub struct Terminals {
    terms: Mutex<HashMap<String, Arc<Term>>>,
    retired: Mutex<(VecDeque<String>, HashMap<String, Retired>, usize)>,
    /// User terminals in the last layout the UI saved (`retain_in_layout`).
    in_layout: Mutex<HashSet<String>>,
    emit: Emit,
}

impl Terminals {
    pub fn new(emit: Emit) -> Arc<Self> {
        Arc::new(Self { terms: Mutex::default(), retired: Mutex::default(), in_layout: Mutex::default(), emit })
    }

    /// Start `spec`. When it ends, the UI gets `terminal-exit { id, exitCode, signal }`.
    pub fn open(self: &Arc<Self>, spec: Spec, owner: Owner, output_limit: Option<usize>) -> Result<Arc<Term>, String> {
        if lock(&self.terms).len() >= MAX_TERMINALS {
            return Err(format!("{MAX_TERMINALS} terminals are open already; close one first"));
        }
        let id = format!("t{}", crate::session::random_token());
        let to_ui = self.emit.clone();
        let on_finish = Box::new(move |t: &Term| {
            let status = t.exit();
            to_ui(
                "terminal-exit",
                json!({ "id": t.id, "exitCode": status.as_ref().and_then(|e| e.exit_code), "signal": status.and_then(|e| e.signal) }),
            );
        });
        let term = Term::spawn(id.clone(), spec, owner, output_limit, on_finish)?;
        lock(&self.terms).insert(id, term.clone());
        Ok(term)
    }

    pub fn get(&self, id: &str) -> Option<Arc<Term>> {
        lock(&self.terms).get(id).cloned()
    }

    /// An agent's terminal, if `generation`'s process created it for `chat`.
    pub fn owned(&self, id: &str, generation: u64, chat: &str) -> Option<Arc<Term>> {
        self.get(id).filter(|t| t.owner == Owner::Agent { generation, chat: chat.to_owned() })
    }

    /// Start a view of terminal `id`: `sink` gets the scrollback, then the live
    /// output and the exit. A released agent terminal is replayed from what was kept.
    pub fn attach(&self, id: &str, sink: Sink) -> Result<Attached, String> {
        if let Some(t) = self.get(id) {
            return Ok(t.attach(sink));
        }
        let retired = lock(&self.retired);
        let r = retired.1.get(id).ok_or("that terminal has closed")?;
        if sink(Frame::Data(&r.bytes)) {
            sink(Frame::Exit(r.exit.as_ref().unwrap_or(&ExitStatus { exit_code: None, signal: None })));
        }
        Ok(Attached {
            id: id.to_owned(),
            viewer: 0,
            cwd: r.cwd.clone(),
            title: r.title.clone(),
            agent: true,
            cols: 0,
            rows: 0,
            exit: r.exit.clone(),
            live: false,
        })
    }

    pub fn detach(&self, id: &str, viewer: u64) {
        if let Some(t) = self.get(id) {
            t.detach(viewer);
        }
    }

    pub fn ack(&self, id: &str, viewer: u64, bytes: usize) {
        if let Some(t) = self.get(id) {
            t.ack(viewer, bytes);
        }
    }

    /// The UI typing into a shell pane. Agents' terminals don't take the UI's keys.
    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        self.user(id)?.write(data)
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        self.user(id)?.resize(cols, rows)
    }

    fn user(&self, id: &str) -> Result<Arc<Term>, String> {
        match self.get(id) {
            Some(t) if t.owner == Owner::User => Ok(t),
            Some(_) => Err("that terminal is an agent's; it's read-only here".into()),
            None => Err("that terminal has closed".into()),
        }
    }

    /// Close a shell pane's terminal. An agent's terminal stays (its agent releases it).
    pub fn close(&self, id: &str) {
        let mut terms = lock(&self.terms);
        if terms.get(id).is_some_and(|t| t.owner == Owner::User)
            && let Some(t) = terms.remove(id)
        {
            drop(terms);
            t.close();
        }
    }

    /// Stop a terminal's process without releasing it (ACP `terminal/kill`, the card's Stop).
    pub fn kill(&self, id: &str) -> Result<(), String> {
        self.get(id).ok_or("that terminal has closed")?.kill();
        Ok(())
    }

    /// An agent is done with its terminal (ACP `terminal/release`): its process is
    /// stopped and its last bytes are kept for its tool card. Returns them.
    pub fn release(&self, id: &str) -> Option<(Vec<u8>, Option<ExitStatus>)> {
        let t = lock(&self.terms).remove(id)?;
        // How it ended, if it has; one still running is stopped now, and its exit isn't waited for.
        let exit = t.exit();
        t.close();
        let (bytes, _) = t.scrollback();
        self.retire(&t, bytes.clone(), exit.clone());
        Some((bytes, exit))
    }

    fn retire(&self, t: &Term, bytes: Vec<u8>, exit: Option<ExitStatus>) {
        let mut guard = lock(&self.retired);
        let (order, kept, size) = &mut *guard;
        *size += bytes.len();
        order.push_back(t.id.clone());
        kept.insert(t.id.clone(), Retired { title: t.title.clone(), cwd: t.cwd.to_string_lossy().into_owned(), bytes, exit });
        while *size > RETIRED_BYTES
            && let Some(old) = order.pop_front()
        {
            if let Some(r) = kept.remove(&old) {
                *size -= r.bytes.len();
            }
        }
    }

    /// Kept bytes of a released terminal, if they're still kept.
    pub fn retired(&self, id: &str) -> Option<Vec<u8>> {
        lock(&self.retired).1.get(id).map(|r| r.bytes.clone())
    }

    fn take_where(&self, f: impl Fn(&Term) -> bool) -> Vec<Arc<Term>> {
        let mut terms = lock(&self.terms);
        let ids: Vec<String> = terms.values().filter(|t| f(t)).map(|t| t.id.clone()).collect();
        ids.iter().filter_map(|id| terms.remove(id)).collect()
    }

    /// An agent process ended: the commands it started go too.
    pub fn release_generation(&self, generation: u64) {
        for t in self.take_where(|t| matches!(&t.owner, Owner::Agent { generation: g, .. } if *g == generation)) {
            t.close();
            let (bytes, _) = t.scrollback();
            self.retire(&t, bytes, t.exit());
        }
    }

    /// A chat was deleted: its agent's commands go, with what was kept of them.
    pub fn release_chat(&self, chat: &str) {
        for t in self.take_where(|t| matches!(&t.owner, Owner::Agent { chat: c, .. } if c == chat)) {
            t.close();
        }
    }

    /// The UI saved its layout: shell panes no longer in it were closed. One opened
    /// in the last few seconds may not have reached a saved layout yet, so it stays.
    #[allow(clippy::needless_pass_by_value, reason = "the set becomes the one kept for the next save")]
    pub fn retain_in_layout(&self, ids: HashSet<String>) {
        const GRACE: Duration = Duration::from_secs(10);
        let previous = std::mem::replace(&mut *lock(&self.in_layout), ids.clone());
        let gone = self.take_where(|t| t.owner == Owner::User && !ids.contains(&t.id) && (previous.contains(&t.id) || t.age() > GRACE));
        for t in gone {
            t.close();
        }
    }

    /// The app is quitting: every terminal's process goes.
    pub fn close_all(&self) {
        let all: Vec<Arc<Term>> = lock(&self.terms).drain().map(|(_, t)| t).collect();
        for t in &all {
            lock(&t.writer).take();
            lock(&t.master).take();
            let _ = lock(&t.killer).kill();
        }
    }

    /// Running terminals whose owner `f` picks.
    pub fn count(&self, f: impl Fn(&Owner) -> bool) -> usize {
        lock(&self.terms).values().filter(|t| f(&t.owner)).count()
    }

    pub fn len(&self) -> usize {
        lock(&self.terms).len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Drop for Terminals {
    fn drop(&mut self) {
        self.close_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn terminals() -> Arc<Terminals> {
        Terminals::new(Arc::new(|_, _| {}))
    }

    fn tmp() -> PathBuf {
        checked_dir(&std::env::temp_dir().to_string_lossy()).unwrap()
    }

    fn sh(script: &str) -> Spec {
        Spec::command(tmp(), "/bin/sh", &["-c".into(), script.into()], vec![], 80, 24).unwrap()
    }

    /// A view collecting what it's sent.
    #[derive(Default)]
    struct Seen {
        data: Mutex<Vec<u8>>,
        exit: Mutex<Option<ExitStatus>>,
        frames: AtomicUsize,
    }

    fn view(seen: &Arc<Seen>) -> Sink {
        let seen = seen.clone();
        Box::new(move |f| {
            seen.frames.fetch_add(1, Ordering::Relaxed);
            match f {
                Frame::Data(d) => lock(&seen.data).extend_from_slice(d),
                Frame::Exit(e) => *lock(&seen.exit) = Some(e.clone()),
            }
            true
        })
    }

    fn until(what: &str, f: impl Fn() -> bool) {
        let started = Instant::now();
        while !f() {
            assert!(started.elapsed() < Duration::from_secs(10), "timed out waiting until {what}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn text(seen: &Seen) -> String {
        String::from_utf8_lossy(&lock(&seen.data)).into_owned()
    }

    fn alive(pid: u32) -> bool {
        std::process::Command::new("kill").args(["-0", &pid.to_string()]).stderr(std::process::Stdio::null()).status().is_ok_and(|s| s.success())
    }

    #[test]
    fn a_command_prints_through_the_pty_and_exits_with_its_code() {
        let ts = terminals();
        let t = ts.open(sh("echo hello; printf 'tty:'; test -t 1 && echo yes; echo \"$TERM\"; exit 3"), Owner::User, None).unwrap();
        let seen = Arc::new(Seen::default());
        ts.attach(&t.id, view(&seen)).unwrap();
        assert_eq!(t.wait(Some(Duration::from_secs(10))), Some(ExitStatus { exit_code: Some(3), signal: None }));
        until("the exit reaches the view", || lock(&seen.exit).is_some());
        let out = text(&seen);
        assert!(out.contains("hello\r\n"), "the PTY turns \\n into \\r\\n: {out:?}");
        assert!(out.contains("tty:yes"), "stdout is a terminal: {out:?}");
        assert!(out.contains("xterm-256color"), "{out:?}");
        assert_eq!(*lock(&seen.exit), Some(ExitStatus { exit_code: Some(3), signal: None }));

        // A view that comes later gets the scrollback and the exit at once.
        let late = Arc::new(Seen::default());
        let info = ts.attach(&t.id, view(&late)).unwrap();
        assert_eq!(text(&late), out);
        assert_eq!(info.exit, Some(ExitStatus { exit_code: Some(3), signal: None }));
        assert!(!info.agent && info.live);
    }

    #[test]
    fn typing_goes_to_the_program_and_resizing_reaches_it() {
        let ts = terminals();
        let t = ts.open(sh("read line; echo \"got:$line\"; read go; stty size"), Owner::User, None).unwrap();
        let seen = Arc::new(Seen::default());
        ts.attach(&t.id, view(&seen)).unwrap();
        ts.write(&t.id, b"hi there\r").unwrap();
        until("the line is read", || text(&seen).contains("got:hi there"));
        ts.resize(&t.id, 100, 40).unwrap();
        ts.write(&t.id, b"\r").unwrap();
        until("stty prints the new size", || text(&seen).contains("40 100"));
        assert_eq!(t.wait(Some(Duration::from_secs(10))).and_then(|e| e.exit_code), Some(0));
        assert!(ts.write("nope", b"x").is_err());
    }

    #[test]
    fn closing_stops_the_process_and_what_it_started() {
        let ts = terminals();
        let t = ts.open(sh("sleep 30 & echo \"child:$!\"; wait"), Owner::User, None).unwrap();
        let seen = Arc::new(Seen::default());
        ts.attach(&t.id, view(&seen)).unwrap();
        until("the child's pid is printed", || text(&seen).contains("child:") && text(&seen).trim_end().ends_with(|c: char| c.is_ascii_digit()));
        let child: u32 = text(&seen).split("child:").nth(1).unwrap().trim().parse().unwrap();
        let shell = t.pid.unwrap();
        assert!(alive(child) && alive(shell));
        ts.close(&t.id);
        until("both are gone", || !alive(child) && !alive(shell));
        until("the view hears it ended", || lock(&seen.exit).is_some());
        assert!(ts.get(&t.id).is_none() && ts.is_empty());
        let exit = lock(&seen.exit).clone().unwrap();
        assert!(exit.signal.is_some() || exit.exit_code != Some(0), "{exit:?}");
    }

    #[test]
    fn kill_reports_the_signal_and_quitting_closes_everything() {
        let ts = terminals();
        let t = ts.open(sh("sleep 30"), Owner::User, None).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        ts.kill(&t.id).unwrap();
        let exit = t.wait(Some(Duration::from_secs(10))).unwrap();
        // SIGHUP first; SIGKILL for a program that ignores it.
        assert!(matches!(exit.signal.as_deref(), Some("SIGHUP" | "SIGKILL")), "{exit:?}");
        assert_eq!(exit.exit_code, None);
        assert!(ts.get(&t.id).is_some(), "killed, not closed: its output can still be read");

        let others: Vec<Arc<Term>> = (0..3).map(|_| ts.open(sh("sleep 30"), Owner::User, None).unwrap()).collect();
        let pids: Vec<u32> = others.iter().map(|t| t.pid.unwrap()).collect();
        ts.close_all();
        until("every process is gone", || pids.iter().all(|p| !alive(*p)));
        assert!(ts.is_empty());
    }

    #[test]
    fn the_scrollback_keeps_the_last_256_kb() {
        let ts = terminals();
        // 600 KB of x, then an end marker.
        let t = ts.open(sh("head -c 600000 /dev/zero | tr '\\0' x; echo END"), Owner::User, None).unwrap();
        t.wait(Some(Duration::from_secs(20))).unwrap();
        let (bytes, total) = t.scrollback();
        assert_eq!(bytes.len(), SCROLLBACK);
        assert!(total >= 600_000, "{total}");
        assert!(String::from_utf8_lossy(&bytes).trim_end().ends_with("END"));
        let late = Arc::new(Seen::default());
        ts.attach(&t.id, view(&late)).unwrap();
        assert_eq!(lock(&late.data).len(), SCROLLBACK, "a late view gets only what's kept");
    }

    #[test]
    fn views_get_batches_not_reads() {
        let ts = terminals();
        let t = ts.open(sh("i=0; while [ $i -lt 2000 ]; do echo line $i; i=$((i+1)); done"), Owner::User, None).unwrap();
        let seen = Arc::new(Seen::default());
        ts.attach(&t.id, view(&seen)).unwrap();
        t.wait(Some(Duration::from_secs(20))).unwrap();
        until("the exit arrives", || lock(&seen.exit).is_some());
        assert!(text(&seen).contains("line 1999"));
        assert!(seen.frames.load(Ordering::Relaxed) < 200, "{} frames for 2000 lines", seen.frames.load(Ordering::Relaxed));
    }

    #[test]
    fn a_view_far_behind_pauses_the_reader_until_it_catches_up() {
        let ts = terminals();
        let t = ts.open(sh("yes"), Owner::User, None).unwrap();
        let seen = Arc::new(Seen::default());
        let v = ts.attach(&t.id, view(&seen)).unwrap();
        // Never acknowledging, the view stops the reading a little past the high-water mark.
        until("the view is past the mark", || lock(&seen.data).len() > HIGH_WATER);
        std::thread::sleep(Duration::from_millis(300));
        let held = t.scrollback().1;
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(t.scrollback().1, held, "nothing more is read while the view is behind");
        // Catching up lets it carry on.
        ts.ack(&t.id, v.viewer, lock(&seen.data).len());
        until("reading resumes", || t.scrollback().1 > held + 64 * 1024);
        // A view that stops acknowledging altogether holds it up for STALL at most.
        let stalled_at = t.scrollback().1;
        std::thread::sleep(STALL + Duration::from_millis(500));
        assert!(t.scrollback().1 > stalled_at + 64 * 1024, "a stalled view no longer holds the reader");
        ts.close(&t.id);
    }

    #[test]
    fn a_view_that_keeps_up_misses_nothing_however_fast_the_program() {
        let ts = terminals();
        // About 1.3 MB, five times the scrollback, printed as fast as the PTY takes it.
        let t = ts.open(sh("seq 1 200000"), Owner::User, None).unwrap();
        let seen = Arc::new(Seen::default());
        let v = ts.attach(&t.id, view(&seen)).unwrap();
        let (acker, done) = (seen.clone(), Arc::new(std::sync::atomic::AtomicBool::new(false)));
        let (tid, stop) = (t.id.clone(), done.clone());
        let ts2 = ts.clone();
        let acking = std::thread::spawn(move || {
            let mut drawn = 0;
            while !stop.load(Ordering::Relaxed) {
                let n = lock(&acker.data).len();
                ts2.ack(&tid, v.viewer, n - drawn);
                drawn = n;
                std::thread::sleep(Duration::from_millis(5));
            }
        });
        until("the exit arrives", || lock(&seen.exit).is_some());
        done.store(true, Ordering::Relaxed);
        acking.join().unwrap();
        let out = text(&seen);
        let lines: Vec<&str> = out.split("\r\n").filter(|l| !l.is_empty()).collect();
        assert_eq!(lines.len(), 200_000, "every line reaches the view");
        assert_eq!((lines[0], lines[199_999]), ("1", "200000"));
    }

    #[test]
    fn folders_are_checked() {
        assert!(checked_dir("relative/path").is_err());
        assert!(checked_dir("/definitely/not/here/yaah").is_err());
        let file = std::env::temp_dir().join(format!("yaah-term-file-{}", crate::session::random_token()));
        std::fs::write(&file, "x").unwrap();
        assert!(checked_dir(&file.to_string_lossy()).unwrap_err().contains("isn't a folder"));
        std::fs::remove_file(file).unwrap();
        // `..` and symlinks resolve, so a later prefix check compares real paths.
        let dotted = format!("{}/./", tmp().display());
        assert_eq!(checked_dir(&dotted).unwrap(), tmp());

        let ts = terminals();
        let t = ts.open(Spec::command(tmp(), "pwd", &[], vec![], 80, 24).unwrap(), Owner::User, None).unwrap();
        t.wait(Some(Duration::from_secs(10))).unwrap();
        assert!(String::from_utf8_lossy(&t.scrollback().0).contains(&*tmp().to_string_lossy()));
    }

    #[test]
    fn a_login_shell_gets_the_login_path_and_term() {
        let ts = terminals();
        let shell = Spec::login_shell(tmp(), Some("/bin/sh"), 80, 24).unwrap();
        assert_eq!(shell.args, ["-l"]);
        assert!(Spec::login_shell(tmp(), Some("sh"), 80, 24).is_err(), "a shell is named by its absolute path");
        assert!(Spec::login_shell(tmp(), Some("/nonexistent/shell"), 80, 24).is_err());
        let t = ts.open(shell, Owner::User, None).unwrap();
        let seen = Arc::new(Seen::default());
        ts.attach(&t.id, view(&seen)).unwrap();
        ts.write(&t.id, b"printf 'P=%s|T=%s\\n' \"$PATH\" \"$TERM\"; exit\r").unwrap();
        t.wait(Some(Duration::from_secs(10))).unwrap();
        let out = text(&seen);
        assert!(out.contains("|T=xterm-256color"), "{out:?}");
        // A login shell's profile may reorder PATH (macOS's path_helper does), but it keeps every folder.
        let got = out.split("\nP=").nth(1).and_then(|r| r.split('|').next()).unwrap_or_default();
        let got: HashSet<&str> = got.split(':').collect();
        let login = crate::path_env::path().to_string_lossy().into_owned();
        let missing: Vec<&str> = login.split(':').filter(|d| !got.contains(d)).collect();
        assert!(missing.is_empty(), "the shell lost {missing:?} from the login PATH");
    }

    #[test]
    fn agents_get_their_output_as_text_within_their_limit() {
        let ts = terminals();
        let owner = Owner::Agent { generation: 7, chat: "c1".into() };
        let t = ts.open(sh("printf '\\033[31mred\\033[0m\\r\\n\\033]0;title\\007plain é\\n'"), owner.clone(), Some(64)).unwrap();
        t.wait(Some(Duration::from_secs(10))).unwrap();
        assert_eq!(t.output(), ("red\nplain é\n".into(), false), "escapes and carriage returns go");
        assert!(ts.owned(&t.id, 7, "c1").is_some());
        assert!(ts.owned(&t.id, 8, "c1").is_none() && ts.owned(&t.id, 7, "c2").is_none(), "only the process and chat that made it");
        assert!(ts.write(&t.id, b"x").is_err(), "the UI can't type into an agent's command");

        // A limit cuts from the start, never inside a character: "é" is two bytes.
        let t = ts.open(sh("printf 'abcé'"), owner.clone(), Some(2)).unwrap();
        t.wait(Some(Duration::from_secs(10))).unwrap();
        assert_eq!(t.output(), ("é".into(), true));
        let t = ts.open(sh("printf 'abcdé'"), owner, Some(1)).unwrap();
        t.wait(Some(Duration::from_secs(10))).unwrap();
        assert_eq!(t.output(), (String::new(), true), "a cut inside é starts after it");

        // Released: gone, but its bytes are kept for a replay.
        let id = t.id.clone();
        let (bytes, exit) = ts.release(&id).unwrap();
        assert!(String::from_utf8_lossy(&bytes).contains("abcdé"));
        assert_eq!(exit.and_then(|e| e.exit_code), Some(0));
        assert!(ts.get(&id).is_none());
        let seen = Arc::new(Seen::default());
        let info = ts.attach(&id, view(&seen)).unwrap();
        assert!(!info.live && info.agent);
        assert!(text(&seen).contains("abcdé") && lock(&seen.exit).is_some());
    }

    #[test]
    fn strip_handles_sequences_split_across_reads() {
        let mut s = Strip::default();
        let mut out = vec![];
        for part in [&b"a\x1b"[..], b"[3", b"1mb\x1b]8;;http://x", b"\x1b", b"\\c\x1b(Bd"] {
            s.feed(part, &mut out);
        }
        assert_eq!(String::from_utf8(out).unwrap(), "abcd");
    }

    #[test]
    fn panes_not_in_the_saved_layout_are_closed() {
        let ts = terminals();
        let kept = ts.open(sh("sleep 30"), Owner::User, None).unwrap();
        let fresh = ts.open(sh("sleep 30"), Owner::User, None).unwrap();
        let agent = ts.open(sh("sleep 30"), Owner::Agent { generation: 1, chat: "c".into() }, Some(10)).unwrap();
        ts.retain_in_layout([kept.id.clone()].into());
        assert!(ts.get(&fresh.id).is_some(), "just opened: it may not be in a saved layout yet");
        assert!(ts.get(&agent.id).is_some(), "agents' terminals aren't the layout's");
        // The pane closes: the next save no longer has it.
        ts.retain_in_layout(HashSet::new());
        assert!(ts.get(&kept.id).is_none());
        ts.close(&agent.id);
        assert!(ts.get(&agent.id).is_some(), "the UI can't close an agent's terminal");
        ts.release_generation(1);
        assert!(ts.get(&agent.id).is_none());
        ts.close_all();
    }

    #[test]
    fn signals_get_their_names() {
        assert_eq!(signal_name("Killed: 9"), "SIGKILL");
        assert_eq!(signal_name("Hangup"), "SIGHUP");
        assert_eq!(signal_name("Terminated: 15"), "SIGTERM");
        assert_eq!(signal_name("Odd: 99"), "Odd: 99");
    }

    #[test]
    fn commands_are_argvs() {
        let s = Spec::command(tmp(), "ls", &["-la".into(), "a b".into()], vec![], 80, 24).unwrap();
        assert_eq!(s.program, "ls");
        assert_eq!(s.args, ["-la", "a b"]);
        assert_eq!(s.title, "ls -la 'a b'");
        let s = Spec::command(tmp(), "npm test && echo ok", &[], vec![], 80, 24).unwrap();
        assert_eq!((s.program.to_string_lossy().as_ref(), s.args.len()), ("/bin/sh", 2));
        assert!(Spec::command(tmp(), " ", &[], vec![], 80, 24).is_err());
        assert!(Spec::command(tmp(), "x\0y", &[], vec![], 80, 24).is_err());
        assert!(Spec::command(tmp(), "env", &[], vec![("A=B".into(), "c".into())], 80, 24).is_err());
    }
}
