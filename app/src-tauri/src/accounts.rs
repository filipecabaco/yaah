//! Claude accounts are Claude Code config dirs. Agent profiles (`agents.rs`)
//! replaced them; these are discovered once to migrate them into Claude profiles,
//! and to resolve chats saved with an account id.
//!
//! `~/.claude` is the default login (no `CLAUDE_CONFIG_DIR`). Any other
//! `~/.claude-<name>` that holds a `.claude.json` is treated as a separate
//! account and selected by spawning the agent with `CLAUDE_CONFIG_DIR` set.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub label: String,
    /// `None` means Claude Code's default config location.
    pub config_dir: Option<String>,
    /// Email of the logged-in Claude account, if any.
    pub email: Option<String>,
}

pub const DEFAULT_ID: &str = "default";

pub fn home() -> PathBuf {
    std::env::var_os("HOME").map_or_else(|| PathBuf::from("/"), PathBuf::from)
}

/// Read `oauthAccount.emailAddress` from a Claude Code `.claude.json`.
fn email(claude_json: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(claude_json).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.pointer("/oauthAccount/emailAddress")?.as_str().map(str::to_owned)
}

/// The logged-in email for a Claude config dir (`None` = Claude Code's default).
pub fn email_for(config_dir: Option<&str>) -> Option<String> {
    match config_dir {
        Some(dir) => email(&Path::new(dir).join(".claude.json")),
        None => email(&home().join(".claude.json")),
    }
}

pub fn discover() -> Vec<Account> {
    discover_in(&home())
}

fn discover_in(home: &Path) -> Vec<Account> {
    let mut accounts = vec![Account {
        id: DEFAULT_ID.into(),
        label: "default".into(),
        config_dir: None,
        // Without CLAUDE_CONFIG_DIR, Claude Code keeps this file in $HOME.
        email: email(&home.join(".claude.json")),
    }];

    let Ok(entries) = std::fs::read_dir(home) else {
        return accounts;
    };
    let mut extra: Vec<Account> = entries
        .filter_map(Result::ok)
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let suffix = name.strip_prefix(".claude-")?.to_owned();
            let path = e.path();
            let claude_json = path.join(".claude.json");
            // A `.yaah-account` marker keeps an account added from the UI listed before its first login.
            let known = claude_json.is_file() || path.join(MARKER).is_file();
            (path.is_dir() && known).then(|| Account {
                id: suffix.clone(),
                label: suffix,
                config_dir: Some(path.to_string_lossy().into_owned()),
                email: email(&claude_json),
            })
        })
        .collect();
    extra.sort_by(|a, b| a.label.cmp(&b.label));
    accounts.extend(extra);
    accounts
}

pub fn find(id: &str) -> Option<Account> {
    discover().into_iter().find(|a| a.id == id)
}

const MARKER: &str = ".yaah-account";

/// Make a config dir for a new Claude profile. A `.yaah-account` marker keeps a
/// `~/.claude-<name>` one discoverable before its first login.
pub fn prepare_config_dir(dir: &Path) -> Result<(), String> {
    if dir.join(".claude.json").is_file() || dir.join(MARKER).is_file() {
        return Ok(());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    std::fs::write(dir.join(MARKER), "").map_err(|e| format!("write marker: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovers_config_dirs_in_a_home() {
        let home = std::env::temp_dir().join(format!("yaah-accounts-{}", crate::session::random_token()));
        let write = |rel: &str, text: &str| {
            let p = home.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        };
        write(".claude.json", r#"{ "oauthAccount": { "emailAddress": "me@example.com" } }"#);
        write(".claude-work/.claude.json", r#"{ "oauthAccount": { "emailAddress": "work@example.com" } }"#);
        write(".claude-junk/settings.json", "{}");
        write(".claude-file", "");
        prepare_config_dir(&home.join(".claude-new")).unwrap();
        prepare_config_dir(&home.join(".claude-new")).unwrap();

        let found = discover_in(&home);
        let ids: Vec<(&str, Option<&str>)> = found.iter().map(|a| (a.id.as_str(), a.email.as_deref())).collect();
        assert_eq!(ids, [("default", Some("me@example.com")), ("new", None), ("work", Some("work@example.com"))], "marked or logged-in dirs only");
        assert_eq!(email_for(found[2].config_dir.as_deref()).as_deref(), Some("work@example.com"));
        assert!(discover_in(&home.join("missing")).len() == 1, "the default is always there");
        std::fs::remove_dir_all(home).unwrap();
    }
}
