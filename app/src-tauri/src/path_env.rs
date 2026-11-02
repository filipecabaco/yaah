//! The PATH yaah finds and starts programs with.
//!
//! Apps launched from Finder or a desktop launcher get a minimal PATH, so
//! `npx`, `docker` or an agent installed through mise/nvm in shell rc files
//! isn't found. yaah reads an interactive login shell's PATH once at startup
//! and gives it to every child process it starts, without changing its own
//! environment (which would need `unsafe` `set_var`).

use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

static LOGIN_PATH: OnceLock<OsString> = OnceLock::new();

/// How long the login shell gets to print its PATH. Startup waits on it, and rc
/// files can be slow or wait on something that never comes.
const SHELL_TIMEOUT: Duration = Duration::from_secs(5);
const MARK: &str = "__YAAH_PATH__";

/// Read the login shell's PATH. Call once at startup; later calls do nothing.
pub fn adopt_login_shell() {
    if let Some(path) = std::env::var_os("SHELL").and_then(|shell| login_shell_path(&shell, SHELL_TIMEOUT)) {
        let _ = LOGIN_PATH.set(path);
    }
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

/// The PATH children get: the login shell's, else our own.
pub fn path() -> OsString {
    LOGIN_PATH.get().cloned().or_else(|| std::env::var_os("PATH")).unwrap_or_default()
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
}
