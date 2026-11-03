//! "Open in terminal": the user's own terminal app, in a folder.
//!
//! macOS prefers Ghostty when it's installed, then iTerm, then Terminal.app
//! (`open -a <app> <folder>`); Linux `$TERMINAL`, then `x-terminal-emulator`,
//! gnome-terminal or konsole, started in the folder. Settings → General can pick
//! one of the apps found (`terminalApp` in `settings.json`; "system" is that order).
//!
//! The folder is checked (absolute, an existing folder, resolved) and always goes
//! to the program as one argument or as its working directory: no shell sees it.

use crate::terminals::checked_dir;
use serde::Serialize;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// "Pick for me": the first app found, in the order above.
pub const SYSTEM: &str = "system";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TerminalApp {
    pub id: String,
    pub label: String,
}

/// How an app is started in a folder.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Launch {
    /// macOS: `open -a <name> <folder>`.
    MacApp(&'static str),
    /// A program started in the folder, with the folder passed as its flag says.
    Program { argv: Vec<String>, dir_flag: DirFlag },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DirFlag {
    /// Only the working directory.
    None,
    /// `--working-directory=<folder>` (gnome-terminal).
    WorkingDirectoryEq,
    /// `--workdir <folder>` (konsole).
    Workdir,
}

struct Candidate {
    id: &'static str,
    label: &'static str,
    launch: Launch,
}

const MAC: &[(&str, &str, &str)] = &[("ghostty", "Ghostty", "Ghostty"), ("iterm", "iTerm", "iTerm"), ("terminal", "Terminal", "Terminal")];

fn mac_installed(app: &str) -> bool {
    let bundle = format!("{app}.app");
    let mut places = vec![PathBuf::from("/Applications"), PathBuf::from("/System/Applications/Utilities"), PathBuf::from("/Applications/Utilities")];
    places.push(crate::accounts::home().join("Applications"));
    places.iter().any(|p| p.join(&bundle).is_dir())
}

/// The apps found on this machine, most preferred first.
fn candidates() -> Vec<Candidate> {
    if cfg!(target_os = "macos") {
        return MAC
            .iter()
            .filter(|(_, _, app)| mac_installed(app))
            .map(|&(id, label, app)| Candidate { id, label, launch: Launch::MacApp(app) })
            .collect();
    }
    let mut out = vec![];
    if let Some(argv) = std::env::var("TERMINAL").ok().and_then(|t| crate::agents::split_args(&t).ok()).filter(|a| !a.is_empty())
        && crate::path_env::which(&argv[0]).is_some()
    {
        out.push(Candidate { id: "env", label: "$TERMINAL", launch: Launch::Program { argv, dir_flag: DirFlag::None } });
    }
    for (id, label, bin, dir_flag) in [
        ("x-terminal-emulator", "Default terminal", "x-terminal-emulator", DirFlag::None),
        ("gnome-terminal", "GNOME Terminal", "gnome-terminal", DirFlag::WorkingDirectoryEq),
        ("konsole", "Konsole", "konsole", DirFlag::Workdir),
    ] {
        if crate::path_env::which(bin).is_some() {
            out.push(Candidate { id, label, launch: Launch::Program { argv: vec![bin.into()], dir_flag } });
        }
    }
    out
}

/// What Settings → General offers: "System default", then each app found.
pub fn detected() -> Vec<TerminalApp> {
    let found = candidates();
    let first = found.first().map_or_else(|| "System default".into(), |c| format!("System default ({})", c.label));
    std::iter::once(TerminalApp { id: SYSTEM.into(), label: first })
        .chain(found.into_iter().map(|c| TerminalApp { id: c.id.into(), label: c.label.into() }))
        .collect()
}

/// The program, its args and its working directory to open `dir` with `launch`.
fn argv(launch: &Launch, dir: &Path) -> (OsString, Vec<OsString>) {
    match launch {
        Launch::MacApp(app) => ("open".into(), vec!["-a".into(), (*app).into(), dir.into()]),
        Launch::Program { argv, dir_flag } => {
            let mut args: Vec<OsString> = argv[1..].iter().map(OsString::from).collect();
            match dir_flag {
                DirFlag::None => {}
                DirFlag::WorkingDirectoryEq => {
                    let mut flag = OsString::from("--working-directory=");
                    flag.push(dir);
                    args.push(flag);
                }
                DirFlag::Workdir => {
                    args.push("--workdir".into());
                    args.push(dir.into());
                }
            }
            (argv[0].clone().into(), args)
        }
    }
}

/// Open `dir` in the terminal app `choice` names (or the system default when it's
/// "system", unknown, or no longer installed).
pub fn open(choice: &str, dir: &str) -> Result<(), String> {
    let dir = checked_dir(dir)?;
    let found = candidates();
    let app = found.iter().find(|c| c.id == choice).or_else(|| found.first()).ok_or("no terminal app found; install one, or set $TERMINAL")?;
    let (program, args) = argv(&app.launch, &dir);
    crate::path_env::command(&program)
        .args(&args)
        .current_dir(&dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("couldn't start {}: {e}", app.label))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_folder_is_one_argument_never_a_shell_string() {
        let nasty = Path::new("/tmp/a b; rm -rf ~ $(touch x) `id` 'q'");
        let (p, args) = argv(&Launch::MacApp("Ghostty"), nasty);
        assert_eq!(p, "open");
        assert_eq!(args, [OsString::from("-a"), "Ghostty".into(), nasty.as_os_str().into()]);

        let gnome = Launch::Program { argv: vec!["gnome-terminal".into()], dir_flag: DirFlag::WorkingDirectoryEq };
        let (p, args) = argv(&gnome, nasty);
        assert_eq!(p, "gnome-terminal");
        assert_eq!(args, [OsString::from(format!("--working-directory={}", nasty.display()))]);

        let konsole = Launch::Program { argv: vec!["konsole".into()], dir_flag: DirFlag::Workdir };
        assert_eq!(argv(&konsole, nasty).1, [OsString::from("--workdir"), nasty.as_os_str().into()]);

        // $TERMINAL is split into words like a command line (no shell), and gets the folder as its cwd.
        let env = Launch::Program { argv: crate::agents::split_args("kitty --single-instance").unwrap(), dir_flag: DirFlag::None };
        let (p, args) = argv(&env, nasty);
        assert_eq!((p, args), (OsString::from("kitty"), vec![OsString::from("--single-instance")]));
    }

    #[test]
    fn only_real_folders_open() {
        assert!(open(SYSTEM, "relative").is_err());
        assert!(open(SYSTEM, "/definitely/not/a/folder/yaah").is_err());
        assert!(open(SYSTEM, "/etc/hosts").unwrap_err().contains("isn't a folder"));
    }

    #[test]
    fn system_default_comes_first() {
        let apps = detected();
        assert_eq!(apps[0].id, SYSTEM);
        if cfg!(target_os = "macos") {
            // Terminal.app ships with macOS; preference order is kept.
            let ids: Vec<&str> = apps[1..].iter().map(|a| a.id.as_str()).collect();
            assert!(ids.contains(&"terminal"), "{ids:?}");
            let order = ["ghostty", "iterm", "terminal"];
            let ranks: Vec<usize> = ids.iter().filter_map(|i| order.iter().position(|o| o == i)).collect();
            assert!(ranks.windows(2).all(|w| w[0] < w[1]), "{ids:?}");
        }
    }
}
