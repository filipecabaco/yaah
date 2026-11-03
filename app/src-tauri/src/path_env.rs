//! The PATH yaah finds and starts programs with.
//!
//! Apps launched from Finder or a desktop launcher get a minimal PATH, so
//! `npx`, `docker` or an agent installed through mise/nvm in shell rc files
//! isn't found. yaah reads an interactive login shell's PATH once at startup
//! and gives it to every child process it starts, without changing its own
//! environment (which would need `unsafe` `set_var`).
//!
//! The shell is read in the background ([`start_login_shell`]): launch doesn't
//! wait for the rc files (0.7–1.3 s on a typical setup). Only something that
//! needs the PATH (spawning a program, looking one up) waits for it, and at
//! most [`SHELL_TIMEOUT`].

use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Condvar, LazyLock, Mutex, PoisonError};
use std::time::Duration;

/// How long the login shell gets to print its PATH. Spawns wait on it, and rc
/// files can be slow or wait on something that never comes.
const SHELL_TIMEOUT: Duration = Duration::from_secs(5);
const MARK: &str = "__YAAH_PATH__";

/// Where the login shell's PATH is: not asked for, being read, or read (`None`: it gave none).
enum State {
    Idle,
    Reading,
    Done(Option<OsString>),
}

/// The login shell's PATH, read once in the background.
pub struct LoginPath {
    state: Mutex<State>,
    ready: Condvar,
}

impl LoginPath {
    fn new() -> Arc<Self> {
        Arc::new(Self { state: Mutex::new(State::Idle), ready: Condvar::new() })
    }

    /// Start reading `shell`'s PATH on a thread of its own; returns at once. Later calls do nothing.
    fn start(self: &Arc<Self>, shell: Option<OsString>, timeout: Duration) {
        {
            let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            if !matches!(*state, State::Idle) {
                return;
            }
            *state = State::Reading;
        }
        let me = self.clone();
        let read = move || {
            let path = shell.and_then(|shell| login_shell_path(&shell, timeout));
            *me.state.lock().unwrap_or_else(PoisonError::into_inner) = State::Done(path);
            me.ready.notify_all();
        };
        if std::thread::Builder::new().name("yaah-login-path".into()).spawn(read).is_err() {
            *self.state.lock().unwrap_or_else(PoisonError::into_inner) = State::Done(None);
            self.ready.notify_all();
        }
    }

    /// The login shell's PATH, waiting for it while it's being read; `None` if
    /// it was never asked for or gave none.
    fn get(&self) -> Option<OsString> {
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        // The reader gives up after its own timeout; this one is only a backstop.
        let (state, _) = self
            .ready
            .wait_timeout_while(state, SHELL_TIMEOUT + Duration::from_secs(1), |s| matches!(s, State::Reading))
            .unwrap_or_else(PoisonError::into_inner);
        match &*state {
            State::Done(p) => p.clone(),
            _ => None,
        }
    }

    /// The PATH children get: the login shell's, else our own.
    fn path(&self) -> OsString {
        self.get().or_else(|| std::env::var_os("PATH")).unwrap_or_default()
    }
}

static LOGIN: LazyLock<Arc<LoginPath>> = LazyLock::new(LoginPath::new);

/// Start reading the login shell's PATH in the background. Call once at startup.
pub fn start_login_shell() {
    LOGIN.start(std::env::var_os("SHELL"), SHELL_TIMEOUT);
}

/// Read the login shell's PATH and wait for it. Later calls do nothing.
pub fn adopt_login_shell() {
    start_login_shell();
    let _ = LOGIN.get();
}

/// Run `shell -ilc` to print its PATH between two marks. The command is a fixed
/// string, so nothing of ours is interpreted by the shell.
fn login_shell_path(shell: &OsStr, timeout: Duration) -> Option<OsString> {
    let mut child = std::process::Command::new(shell)
        .args(["-ilc", &format!("printf '{MARK}%s{MARK}' \"$PATH\"")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        // Stop at the closing mark: something the rc files started in the background may keep stdout open.
        let (mut out, mut chunk) = (Vec::new(), [0u8; 4096]);
        while let Ok(n @ 1..) = stdout.read(&mut chunk) {
            out.extend_from_slice(&chunk[..n]);
            if String::from_utf8_lossy(&out).matches(MARK).count() >= 2 {
                break;
            }
        }
        let _ = tx.send(out);
    });
    let out = rx.recv_timeout(timeout);
    // Done or out of time: either way the shell has nothing more to give.
    let _ = child.kill();
    let _ = child.wait();
    String::from_utf8_lossy(&out.ok()?).split(MARK).nth(1).filter(|p| !p.is_empty()).map(OsString::from)
}

/// The PATH children get: the login shell's (waiting while it is read), else our own.
pub fn path() -> OsString {
    LOGIN.path()
}

/// The executable `bin` names: a path when it has a `/`, else the first match on that PATH.
pub fn which(bin: &str) -> Option<PathBuf> {
    if bin.contains('/') {
        let p = PathBuf::from(bin);
        return is_executable(&p).then_some(p);
    }
    std::env::split_paths(&path()).map(|d| d.join(bin)).find(|p| is_executable(p))
}

fn is_executable(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        p.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    p.is_file()
}

/// A command that runs with that PATH (and finds `program` on it).
pub fn command(program: impl AsRef<OsStr>) -> std::process::Command {
    let mut c = std::process::Command::new(program);
    c.env("PATH", path());
    c
}

/// The async form of [`command`].
pub fn tokio_command(program: impl AsRef<OsStr>) -> tokio::process::Command {
    let mut c = tokio::process::Command::new(program);
    c.env("PATH", path());
    c
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn children_find_programs_on_the_path() {
        let sh = which("sh").unwrap();
        assert_eq!(which(&sh.to_string_lossy()), Some(sh.clone()), "a path is checked as is");
        let out = command("sh").args(["-c", "printf %s \"$PATH\""]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), path().to_string_lossy());
        assert!(which("definitely-not-a-program-yaah").is_none());
        assert!(which("/etc/hosts").is_none(), "not executable");
    }

    /// A stand-in login shell: a script that ignores its arguments.
    fn fake_shell(dir: &Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let p = dir.join(name);
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    #[test]
    fn reads_the_login_shell_path_without_waiting_on_it() {
        let dir = std::env::temp_dir().join(format!("yaah-shell-{}", crate::session::random_token()));
        std::fs::create_dir_all(&dir).unwrap();
        let path_of = |body: &str, name: &str| login_shell_path(fake_shell(&dir, name, body).as_os_str(), Duration::from_secs(5));

        let rc_noise = format!("echo 'Welcome!'; printf '{MARK}/opt/bin:/usr/bin{MARK}'");
        assert_eq!(path_of(&rc_noise, "noisy").as_deref(), Some(OsStr::new("/opt/bin:/usr/bin")));
        // A background job holding stdout open doesn't keep us waiting once the PATH is in.
        let started = Instant::now();
        assert!(path_of(&format!("printf '{MARK}/x{MARK}'; sleep 30"), "lingering").is_some());
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(path_of("echo no marks here", "plain"), None);

        // A shell that never answers is given up on.
        let started = Instant::now();
        assert_eq!(login_shell_path(fake_shell(&dir, "stuck", "sleep 30").as_os_str(), Duration::from_millis(200)), None);
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(login_shell_path(OsStr::new("/nonexistent/shell"), Duration::from_secs(1)), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Launch doesn't wait for a slow login shell; the first spawn does, and gets its PATH.
    #[test]
    fn the_login_path_is_read_in_the_background_and_spawns_wait_for_it() {
        let dir = std::env::temp_dir().join(format!("yaah-shell-bg-{}", crate::session::random_token()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        // The login PATH has the real tools plus a folder only it knows about.
        let wanted = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap_or_default());
        let slow = fake_shell(&dir, "slow", &format!("sleep 0.4; printf '{MARK}{wanted}{MARK}'"));

        let login = LoginPath::new();
        let started = Instant::now();
        login.start(Some(slow.into_os_string()), Duration::from_secs(5));
        assert!(started.elapsed() < Duration::from_millis(100), "start returns at once: {:?}", started.elapsed());
        assert!(matches!(*login.state.lock().unwrap(), State::Reading));

        // A spawn right away waits for the shell and runs with its PATH.
        let mut c = std::process::Command::new("/bin/sh");
        c.args(["-c", "printf %s \"$PATH\""]).env("PATH", login.path());
        let out = c.output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), wanted);
        assert!(started.elapsed() >= Duration::from_millis(350), "it waited for the shell: {:?}", started.elapsed());

        // Read once: later calls are immediate, and starting again does nothing.
        let again = Instant::now();
        login.start(Some(OsString::from("/nonexistent/shell")), Duration::from_secs(5));
        assert_eq!(login.get().as_deref(), Some(OsStr::new(&wanted)));
        assert!(again.elapsed() < Duration::from_millis(50));

        // Never started (tests, or no $SHELL): no wait, our own PATH.
        let idle = LoginPath::new();
        let t = Instant::now();
        assert_eq!(idle.get(), None);
        assert_eq!(idle.path(), std::env::var_os("PATH").unwrap_or_default());
        assert!(t.elapsed() < Duration::from_millis(50));

        // A shell that never answers: spawns wait for the timeout, then use our own PATH.
        let stuck = LoginPath::new();
        stuck.start(Some(fake_shell(&dir, "stuck", "sleep 30").into_os_string()), Duration::from_millis(300));
        let t = Instant::now();
        assert_eq!(stuck.get(), None);
        assert!(t.elapsed() < Duration::from_secs(3), "{:?}", t.elapsed());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
