//! Agent profiles: which ACP agent yaah runs for a chat, and how.
//!
//! A profile is a command line (plus env) that starts an agent speaking ACP on
//! stdio. Presets fill it in for known agents; "custom" takes any command.
//! Profiles live in `~/.config/yaah/agents.json` (mode 0600, since env may
//! hold API keys).
//!
//! Chats store the profile id as `account_id`. Before profiles existed an
//! account was a Claude Code config dir (`accounts.rs`), so the first load
//! turns those into Claude profiles with the same ids, and any id that is
//! still a Claude config dir resolves to one even without a saved profile.

use crate::accounts;
use crate::acp::{self, Connection};
use crate::session::INITIALIZE_TIMEOUT;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const CLAUDE: &str = "claude";
pub const CUSTOM: &str = "custom";

// ── Profiles ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    /// Stored in chats as `account_id`.
    pub id: String,
    pub label: String,
    /// A preset id (see [`PRESETS`]) or `custom`.
    pub preset: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Claude only: `CLAUDE_CONFIG_DIR`. `None` is Claude Code's default (`~/.claude`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_dir: Option<String>,
    /// What the agent said in its last `initialize`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report: Option<Report>,
}

impl Profile {
    pub fn is_claude(&self) -> bool {
        self.preset == CLAUDE
    }

    /// Environment to start the agent with.
    fn spawn_env(&self) -> Vec<(String, String)> {
        let mut env: Vec<(String, String)> = self.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        if let Some(dir) = &self.config_dir {
            env.push(("CLAUDE_CONFIG_DIR".into(), dir.clone()));
        }
        env
    }

    /// Inherited variables to drop: for Claude an API key in yaah's own
    /// environment would override the profile's login, unless the profile sets one.
    fn env_remove(&self) -> Option<&'static str> {
        (self.is_claude() && !self.env.contains_key("ANTHROPIC_API_KEY")).then_some("ANTHROPIC_API_KEY")
    }

    /// The agent's command line with its environment, ready to start (no shell involved).
    pub fn process(&self) -> tokio::process::Command {
        let mut cmd = crate::path_env::tokio_command(&self.command);
        cmd.args(&self.args);
        if let Some(k) = self.env_remove() {
            cmd.env_remove(k);
        }
        cmd.envs(self.spawn_env());
        cmd
    }

    /// Whether `other` starts the same agent the same way (so what it reported still holds).
    pub fn same_command(&self, other: &Profile) -> bool {
        self.command == other.command && self.args == other.args && self.env == other.env
    }

    pub fn command_line(&self) -> String {
        join_args(std::iter::once(&self.command).chain(&self.args))
    }

    /// A Claude profile made from a pre-profile account (a Claude Code config dir).
    fn from_claude_account(a: &accounts::Account) -> Self {
        let preset = preset(CLAUDE).expect("claude preset");
        let (command, args) = preset.command(None);
        Profile {
            id: a.id.clone(),
            label: if a.id == accounts::DEFAULT_ID { "Claude".into() } else { format!("Claude ({})", a.label) },
            preset: CLAUDE.into(),
            command,
            args,
            env: BTreeMap::new(),
            config_dir: a.config_dir.clone(),
            report: None,
        }
    }
}

/// What the setup screen sends to save or test a profile.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    /// Set when editing an existing profile.
    #[serde(default)]
    pub id: Option<String>,
    pub label: String,
    pub preset: String,
    /// Command and arguments, shell-style (quotes group words).
    pub command_line: String,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub config_dir: Option<String>,
}

impl Draft {
    /// Validate and turn into a profile. A new profile gets an id from its label
    /// that isn't in `taken`.
    pub fn to_profile(&self, taken: &[String]) -> Result<Profile, String> {
        let label = self.label.trim();
        if label.is_empty() {
            return Err("give the agent a name".into());
        }
        let mut words = split_args(&self.command_line)?.into_iter();
        let command = words.next().ok_or("enter the command that starts the agent")?;
        if let Some(bad) = self.env.keys().find(|k| !valid_env_name(k)) {
            return Err(format!("`{bad}` isn't a valid environment variable name"));
        }
        let is_claude = self.preset == CLAUDE;
        if !is_claude && self.preset != CUSTOM && preset(&self.preset).is_none() {
            return Err(format!("unknown preset {}", self.preset));
        }
        let config_dir = if is_claude { self.config_dir.as_deref().map(str::trim).filter(|d| !d.is_empty()).map(expand_home) } else { None };
        let id = match &self.id {
            Some(id) => id.clone(),
            None => unique_id(label, taken),
        };
        Ok(Profile {
            id,
            label: label.to_owned(),
            preset: self.preset.clone(),
            command,
            args: words.collect(),
            env: self.env.iter().filter(|(k, _)| !k.is_empty()).map(|(k, v)| (k.clone(), v.clone())).collect(),
            config_dir,
            report: None,
        })
    }
}

fn valid_env_name(k: &str) -> bool {
    let mut chars = k.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn expand_home(p: &str) -> String {
    match p.strip_prefix("~/") {
        Some(rest) => accounts::home().join(rest).to_string_lossy().into_owned(),
        None if p == "~" => accounts::home().to_string_lossy().into_owned(),
        None => p.to_owned(),
    }
}

fn unique_id(label: &str, taken: &[String]) -> String {
    let mut slug = String::new();
    for c in label.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_end_matches('-');
    let base = if slug.is_empty() { "agent" } else { slug };
    // One of the first `taken.len() + 1` candidates is free.
    (1..=taken.len() + 1)
        .map(|n| if n == 1 { base.to_owned() } else { format!("{base}-{n}") })
        .find(|id| !taken.contains(id))
        .unwrap_or_else(|| base.to_owned())
}

// ── Store ───────────────────────────────────────────────────────────────────

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsFile {
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default)]
    pub profiles: Vec<Profile>,
}

impl AgentsFile {
    /// The default profile id: the saved one if it still exists, else the first.
    pub fn default_id(&self) -> Option<String> {
        self.default.clone().filter(|d| self.profiles.iter().any(|p| &p.id == d)).or_else(|| self.profiles.first().map(|p| p.id.clone()))
    }
}

/// Profiles on disk. One per app; tests point it at a temp file.
pub struct Store {
    path: PathBuf,
    /// Serialises read-modify-write of the file.
    lock: Mutex<()>,
}

/// Claude accounts worth migrating: logged in, or a config dir yaah or Claude Code made.
fn existing_claude_accounts() -> Vec<accounts::Account> {
    let has_default = accounts::home().join(".claude").is_dir() || accounts::home().join(".claude.json").is_file();
    accounts::discover().into_iter().filter(|a| a.config_dir.is_some() || has_default || a.email.is_some()).collect()
}

static USER: std::sync::OnceLock<Store> = std::sync::OnceLock::new();

impl Store {
    pub fn at(path: PathBuf) -> Self {
        Self { path, lock: Mutex::new(()) }
    }

    /// `~/.config/yaah/agents.json`.
    pub fn user() -> &'static Store {
        USER.get_or_init(|| Store::at(accounts::home().join(".config/yaah/agents.json")))
    }

    /// Read the file; when there is none yet, migrate Claude accounts into it.
    pub fn load(&self) -> AgentsFile {
        let _g = self.lock.lock().unwrap();
        self.load_with(existing_claude_accounts)
    }

    fn load_with(&self, claude_accounts: impl FnOnce() -> Vec<accounts::Account>) -> AgentsFile {
        if let Ok(raw) = std::fs::read_to_string(&self.path) {
            return serde_json::from_str(&raw).unwrap_or_else(|e| {
                eprintln!("[agents] {} is unreadable, ignoring it: {e}", self.path.display());
                AgentsFile::default()
            });
        }
        let file = migrate(&claude_accounts());
        if !file.profiles.is_empty()
            && let Err(e) = self.write(&file)
        {
            eprintln!("[agents] could not save migrated profiles: {e}");
        }
        file
    }

    /// 0600: env may hold API keys.
    fn write(&self, file: &AgentsFile) -> Result<(), String> {
        crate::json_file::write(&self.path, file, true)
    }

    fn update<T>(&self, f: impl FnOnce(&mut AgentsFile) -> Result<T, String>) -> Result<T, String> {
        let _g = self.lock.lock().unwrap();
        let mut file = self.load_with(existing_claude_accounts);
        let out = f(&mut file)?;
        self.write(&file)?;
        Ok(out)
    }

    /// A profile by id. An id that isn't saved but is a Claude config dir (a chat
    /// from before profiles, or a removed profile) still resolves.
    pub fn find(&self, id: &str) -> Option<Profile> {
        self.load().profiles.into_iter().find(|p| p.id == id).or_else(|| accounts::find(id).map(|a| Profile::from_claude_account(&a)))
    }

    /// Create or replace a profile. Returns it and whether it replaced one.
    pub fn save(&self, draft: &Draft) -> Result<(Profile, bool), String> {
        self.update(|file| {
            let taken: Vec<String> = file.profiles.iter().map(|p| p.id.clone()).collect();
            let mut profile = draft.to_profile(&taken)?;
            if let Some(dir) = &profile.config_dir {
                accounts::prepare_config_dir(Path::new(dir))?;
            }
            let existing = file.profiles.iter().position(|p| p.id == profile.id);
            match existing {
                Some(i) => {
                    // Same command: what the agent reported still holds.
                    let old = &file.profiles[i];
                    if old.same_command(&profile) {
                        profile.report.clone_from(&old.report);
                    }
                    file.profiles[i] = profile.clone();
                }
                None => file.profiles.push(profile.clone()),
            }
            if file.default.is_none() {
                file.default = Some(profile.id.clone());
            }
            Ok((profile, existing.is_some()))
        })
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        self.update(|file| {
            let before = file.profiles.len();
            file.profiles.retain(|p| p.id != id);
            if file.profiles.len() == before {
                return Err(format!("no agent {id}"));
            }
            if file.default.as_deref() == Some(id) {
                file.default = file.profiles.first().map(|p| p.id.clone());
            }
            Ok(())
        })
    }

    pub fn set_default(&self, id: &str) -> Result<(), String> {
        self.update(|file| {
            if !file.profiles.iter().any(|p| p.id == id) {
                return Err(format!("no agent {id}"));
            }
            file.default = Some(id.to_owned());
            Ok(())
        })
    }

    /// Remember what the agent reported. A profile that isn't saved (a Claude
    /// fallback) is left alone.
    pub fn record_report(&self, id: &str, report: &Report) {
        let res = self.update(|file| {
            if let Some(p) = file.profiles.iter_mut().find(|p| p.id == id) {
                p.report = Some(report.clone());
            }
            Ok(())
        });
        if let Err(e) = res {
            eprintln!("[agents] could not save report for {id}: {e}");
        }
    }
}

/// Pre-profile Claude accounts become Claude profiles with the same ids.
pub fn migrate(claude_accounts: &[accounts::Account]) -> AgentsFile {
    let profiles: Vec<Profile> = claude_accounts.iter().map(Profile::from_claude_account).collect();
    AgentsFile { default: profiles.first().map(|p| p.id.clone()), profiles }
}

// ── What the UI is shown ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInfo {
    #[serde(flatten)]
    pub profile: Profile,
    pub command_line: String,
    pub preset_label: String,
    /// Claude: the logged-in account's email.
    pub email: Option<String>,
    /// `Some(false)` when the agent needs a login; `None` when we can't tell yet.
    pub logged_in: Option<bool>,
    /// The command was found on PATH.
    pub installed: bool,
}

pub fn info(profile: Profile, needs_login: bool) -> ProfileInfo {
    let email = profile.is_claude().then(|| accounts::email_for(profile.config_dir.as_deref())).flatten();
    let logged_in = if needs_login {
        Some(false)
    } else if profile.is_claude() {
        Some(email.is_some())
    } else {
        None
    };
    ProfileInfo {
        command_line: profile.command_line(),
        preset_label: preset(&profile.preset).map_or("Custom", |p| p.label).to_owned(),
        installed: which(&profile.command).is_some(),
        email,
        logged_in,
        profile,
    }
}

// ── Presets ─────────────────────────────────────────────────────────────────

/// A known ACP agent. Commands come from each agent's docs and the ACP
/// registry (github.com/agentclientprotocol/registry); `docs` links the source.
#[derive(Debug)]
pub struct Preset {
    pub id: &'static str,
    pub label: &'static str,
    pub blurb: &'static str,
    /// Executables that run the agent, in order of preference.
    pub bins: &'static [&'static str],
    pub args: &'static [&'static str],
    /// npm package to run through `npx -y` when no binary is installed.
    pub npx: Option<&'static str>,
    pub env: &'static [(&'static str, &'static str)],
    pub docs: &'static str,
    /// How to install it, shown when it isn't found.
    pub install: &'static str,
}

pub const PRESETS: &[Preset] = &[
    Preset {
        id: CLAUDE,
        label: "Claude Code",
        blurb: "Anthropic's Claude Code, through the ACP adapter.",
        bins: &[],
        args: &[],
        npx: Some(crate::session::ADAPTER_PACKAGE),
        env: &[],
        docs: "https://github.com/agentclientprotocol/claude-agent-acp",
        install: "Needs Node.js (npx); the adapter is downloaded on first run.",
    },
    Preset {
        id: "gemini",
        label: "Gemini CLI",
        blurb: "Google's Gemini CLI in ACP mode.",
        bins: &["gemini"],
        args: &["--acp"],
        npx: Some("@google/gemini-cli@0.66.0"),
        env: &[],
        docs: "https://github.com/google-gemini/gemini-cli",
        install: "npm install -g @google/gemini-cli",
    },
    Preset {
        id: "codex",
        label: "Codex",
        blurb: "OpenAI Codex, through the codex-acp adapter (it bundles Codex).",
        bins: &["codex-acp"],
        args: &[],
        npx: Some("@agentclientprotocol/codex-acp@2.5.0"),
        env: &[],
        docs: "https://github.com/agentclientprotocol/codex-acp",
        install: "npm install -g @agentclientprotocol/codex-acp",
    },
    Preset {
        id: "opencode",
        label: "OpenCode",
        blurb: "OpenCode's built-in ACP server.",
        bins: &["opencode"],
        args: &["acp"],
        npx: None,
        env: &[],
        docs: "https://opencode.ai/docs/acp/",
        install: "See opencode.ai for install options.",
    },
    Preset {
        id: "goose",
        label: "goose",
        blurb: "Block's goose, using your goose providers and extensions.",
        bins: &["goose"],
        args: &["acp"],
        npx: None,
        env: &[],
        docs: "https://github.com/block/goose/blob/main/documentation/docs/guides/goose-cli-commands.md",
        install: "See block.github.io/goose for install options.",
    },
    Preset {
        id: "copilot",
        label: "GitHub Copilot",
        blurb: "GitHub Copilot CLI's ACP server (public preview).",
        bins: &["copilot"],
        args: &["--acp"],
        npx: Some("@github/copilot@1.0.105"),
        env: &[],
        docs: "https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/",
        install: "npm install -g @github/copilot",
    },
    Preset {
        id: "cursor",
        label: "Cursor",
        blurb: "Cursor's agent CLI in ACP mode.",
        bins: &["cursor-agent", "agent"],
        args: &["acp"],
        npx: None,
        env: &[],
        docs: "https://cursor.com/docs/cli/acp",
        install: "See cursor.com/docs/cli for install options.",
    },
    Preset {
        id: "kiro",
        label: "Kiro CLI",
        blurb: "Amazon's Kiro CLI in ACP mode.",
        bins: &["kiro-cli"],
        args: &["acp"],
        npx: None,
        env: &[],
        docs: "https://kiro.dev/docs/cli/acp/",
        install: "See kiro.dev/docs/cli for install options.",
    },
    Preset {
        id: "qwen",
        label: "Qwen Code",
        blurb: "Alibaba's Qwen Code in ACP mode.",
        bins: &["qwen"],
        args: &["--acp"],
        npx: Some("@qwen-code/qwen-code@0.26.5"),
        env: &[],
        docs: "https://github.com/agentclientprotocol/registry/blob/main/qwen-code/agent.json",
        install: "npm install -g @qwen-code/qwen-code",
    },
    Preset {
        id: "auggie",
        label: "Auggie",
        blurb: "Augment Code's CLI in ACP mode.",
        bins: &["auggie"],
        args: &["--acp"],
        npx: Some("@augmentcode/auggie@0.36.0"),
        env: &[("AUGMENT_DISABLE_AUTO_UPDATE", "1")],
        docs: "https://github.com/agentclientprotocol/registry/blob/main/auggie/agent.json",
        install: "npm install -g @augmentcode/auggie",
    },
    Preset {
        id: "cline",
        label: "Cline",
        blurb: "Cline's CLI in ACP mode.",
        bins: &["cline"],
        args: &["--acp"],
        npx: Some("cline@3.0.74"),
        env: &[],
        docs: "https://github.com/agentclientprotocol/registry/blob/main/cline/agent.json",
        install: "npm install -g cline",
    },
    Preset {
        id: "kimi",
        label: "Kimi CLI",
        blurb: "Moonshot's Kimi CLI in ACP mode.",
        bins: &["kimi"],
        args: &["acp"],
        npx: None,
        env: &[],
        docs: "https://github.com/agentclientprotocol/registry/blob/main/kimi/agent.json",
        install: "See github.com/MoonshotAI/kimi-cli for install options.",
    },
    Preset {
        id: "vibe",
        label: "Mistral Vibe",
        blurb: "Mistral's Vibe, through its vibe-acp binary.",
        bins: &["vibe-acp"],
        args: &[],
        npx: None,
        env: &[],
        docs: "https://github.com/agentclientprotocol/registry/blob/main/mistral-vibe/agent.json",
        install: "See github.com/mistralai/mistral-vibe for install options.",
    },
];

pub fn preset(id: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.id == id)
}

impl Preset {
    /// The command to run: an installed binary first, then npx, else the
    /// binary name (so the user sees what to install).
    pub fn command(&self, found_bin: Option<&str>) -> (String, Vec<String>) {
        let args = self.args.iter().map(ToString::to_string);
        match (found_bin, self.npx) {
            (Some(bin), _) => (bin.to_owned(), args.collect()),
            (None, Some(pkg)) => ("npx".into(), ["-y".to_owned(), pkg.to_owned()].into_iter().chain(args).collect()),
            (None, None) => (self.bins.first().copied().unwrap_or(self.id).to_owned(), args.collect()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub blurb: &'static str,
    pub docs: &'static str,
    pub install: &'static str,
    /// "binary" (found on PATH), "npx" (runs through npx), "missing", or "custom".
    pub via: &'static str,
    /// Where the binary (or npx) was found.
    pub path: Option<String>,
    /// A draft to start the setup form from.
    pub draft: Draft,
}

/// Every preset plus "custom", with what's installed here.
pub fn presets() -> Vec<PresetInfo> {
    let mut out: Vec<PresetInfo> = PRESETS
        .iter()
        .map(|p| {
            let found = p.bins.iter().find_map(|b| which(b).map(|path| (*b, path)));
            let npx = p.npx.and_then(|_| which("npx"));
            let (via, path) = match (&found, npx) {
                (Some((_, path)), _) => ("binary", Some(path.clone())),
                (None, Some(npx)) => ("npx", Some(npx)),
                (None, None) => ("missing", None),
            };
            let (command, args) = p.command(found.as_ref().map(|(b, _)| *b));
            PresetInfo {
                id: p.id,
                label: p.label,
                blurb: p.blurb,
                docs: p.docs,
                install: p.install,
                via,
                path,
                draft: Draft {
                    id: None,
                    label: p.label.to_owned(),
                    preset: p.id.to_owned(),
                    command_line: join_args(std::iter::once(&command).chain(&args)),
                    env: p.env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
                    config_dir: None,
                },
            }
        })
        .collect();
    out.push(PresetInfo {
        id: CUSTOM,
        label: "Custom command",
        blurb: "Any agent that speaks ACP on stdio.",
        docs: "https://agentclientprotocol.com/overview/agents",
        install: "",
        via: "custom",
        path: None,
        draft: Draft { label: "My agent".into(), preset: CUSTOM.into(), ..Draft::default() },
    });
    out
}

/// Find an executable on PATH (or check an explicit path, `~/` allowed).
pub fn which(cmd: &str) -> Option<String> {
    crate::path_env::which(&expand_home(cmd)).map(|p| p.to_string_lossy().into_owned())
}

// ── Command lines ───────────────────────────────────────────────────────────

/// Split a command line into words: whitespace separates, '…' and "…" group,
/// backslash escapes (outside single quotes).
pub fn split_args(line: &str) -> Result<Vec<String>, String> {
    let mut words = vec![];
    let mut cur = String::new();
    let mut in_word = false;
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                in_word = true;
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some(c) => cur.push(c),
                        None => return Err("unclosed ' in the command".into()),
                    }
                }
            }
            '"' => {
                in_word = true;
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some('\\') => cur.push(chars.next().ok_or("unfinished \\ in the command")?),
                        Some(c) => cur.push(c),
                        None => return Err("unclosed \" in the command".into()),
                    }
                }
            }
            '\\' => {
                in_word = true;
                cur.push(chars.next().ok_or("unfinished \\ in the command")?);
            }
            c if c.is_whitespace() => {
                if in_word {
                    words.push(std::mem::take(&mut cur));
                    in_word = false;
                }
            }
            c => {
                in_word = true;
                cur.push(c);
            }
        }
    }
    if in_word {
        words.push(cur);
    }
    Ok(words)
}

/// The inverse of [`split_args`]: quote words that need it.
pub fn join_args<S: AsRef<str>>(words: impl IntoIterator<Item = S>) -> String {
    words
        .into_iter()
        .map(|w| {
            let w = w.as_ref();
            let plain = !w.is_empty() && w.chars().all(|c| c.is_ascii_alphanumeric() || "-_./:=@+,%~".contains(c));
            if plain { w.to_owned() } else { format!("'{}'", w.replace('\'', r"'\''")) }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

// ── initialize ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthMethod {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    /// `agent` (the agent handles it in `authenticate`), `terminal` (we rerun
    /// the agent command with extra args), or `env_var` (set variables).
    pub kind: String,
    /// `env_var`: the variables to set.
    #[serde(default)]
    pub vars: Vec<String>,
}

/// What an agent told us in `initialize`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::struct_excessive_bools, reason = "one flag per capability the agent reports")]
pub struct Report {
    pub name: Option<String>,
    pub title: Option<String>,
    pub version: Option<String>,
    pub protocol_version: Option<u64>,
    /// yaah speaks this protocol version.
    pub compatible: bool,
    pub auth_methods: Vec<AuthMethod>,
    /// Can connect to HTTP MCP servers, so yaah's UI tools work.
    pub mcp_http: bool,
    pub mcp_sse: bool,
    pub load_session: bool,
    pub embedded_context: bool,
    pub image: bool,
    pub audio: bool,
    pub additional_dirs: bool,
    /// Unix seconds.
    pub checked_at: u64,
}

impl Report {
    pub fn from_initialize(init: &Value) -> Self {
        let caps = &init["agentCapabilities"];
        let flag = |p: &str| caps.pointer(p).and_then(Value::as_bool).unwrap_or(false);
        let s = |p: &str| init.pointer(p).and_then(Value::as_str).map(str::to_owned);
        let protocol_version = init["protocolVersion"].as_u64();
        Report {
            name: s("/agentInfo/name"),
            title: s("/agentInfo/title"),
            version: s("/agentInfo/version"),
            protocol_version,
            compatible: protocol_version == Some(acp::PROTOCOL_VERSION),
            auth_methods: auth_methods(init["authMethods"].as_array().map_or(&[], Vec::as_slice)),
            mcp_http: flag("/mcpCapabilities/http"),
            mcp_sse: flag("/mcpCapabilities/sse"),
            load_session: flag("/loadSession"),
            embedded_context: flag("/promptCapabilities/embeddedContext"),
            image: flag("/promptCapabilities/image"),
            audio: flag("/promptCapabilities/audio"),
            additional_dirs: caps.pointer("/sessionCapabilities/additionalDirectories").is_some_and(|v| !v.is_null()),
            checked_at: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs()),
        }
    }
}

/// The login methods in an `initialize` result's `authMethods`.
pub fn auth_methods(raw: &[Value]) -> Vec<AuthMethod> {
    raw.iter().filter_map(auth_method).collect()
}

fn auth_method(m: &Value) -> Option<AuthMethod> {
    let kind = m["type"].as_str().unwrap_or("agent").to_owned();
    // env_var methods have described their variables as `vars: [{name}]`, `varName`, and `name`.
    let vars = match m["vars"].as_array() {
        Some(vars) => vars.iter().filter_map(|v| v["name"].as_str().or(v.as_str()).map(str::to_owned)).collect(),
        None => m["varName"].as_str().map(|v| vec![v.to_owned()]).unwrap_or_default(),
    };
    Some(AuthMethod {
        id: m["id"].as_str().or(m["methodId"].as_str())?.to_owned(),
        name: m["name"].as_str().unwrap_or("Log in").to_owned(),
        description: m["description"].as_str().map(|d| d.trim().to_owned()).filter(|d| !d.is_empty()),
        kind,
        vars,
    })
}

/// Send `initialize` the way yaah always does.
pub async fn initialize(conn: &Connection) -> Result<Value, String> {
    tokio::time::timeout(
        INITIALIZE_TIMEOUT,
        conn.request(
            "initialize",
            json!({
                "protocolVersion": acp::PROTOCOL_VERSION,
                "clientCapabilities": {
                    "fs": { "readTextFile": false, "writeTextFile": false },
                    "terminal": false,
                    // We can rerun the agent command with a method's args (see login.rs),
                    // so the agent may offer `terminal` login methods.
                    "auth": { "terminal": true },
                    // We show `notice` updates (MCP servers that didn't start, …) as their own card.
                    "session": { "notices": {} }
                },
                "clientInfo": { "name": "yaah", "version": env!("CARGO_PKG_VERSION") }
            }),
        ),
    )
    .await
    .map_err(|_| format!("the agent did not answer initialize within {INITIALIZE_TIMEOUT:?}"))?
    .map_err(|e| {
        let tail = conn.stderr_tail();
        if tail.is_empty() { format!("initialize failed: {e}") } else { format!("initialize failed: {e}\n{tail}") }
    })
}

/// Start the agent a profile describes, without registering it anywhere.
pub fn spawn(
    profile: &Profile,
    on_incoming: impl Fn(acp::Incoming, &acp::Responder) + Send + Sync + 'static,
    on_exit: impl FnOnce(String) + Send + 'static,
    extra_env: &[(&str, String)],
) -> Result<std::sync::Arc<Connection>, String> {
    let mut cmd = profile.process();
    cmd.envs(extra_env.iter().map(|(k, v)| (k, v)));
    Connection::spawn(cmd, on_incoming, on_exit)
}

/// "Test connection": start the agent, run `initialize`, report, stop it.
/// Never logs in or opens a session.
pub async fn test(profile: &Profile) -> Result<Report, String> {
    let conn = spawn(
        profile,
        // We advertise nothing the agent could call; refuse anything it asks.
        |msg, responder| {
            if let acp::Incoming::Request { id, method, .. } = msg {
                let _ = responder.method_not_found(id, &method);
            }
        },
        |_| {},
        &[],
    )
    .map_err(|e| format!("{e}. Is it installed and on your PATH?"))?;
    let init = initialize(&conn).await?;
    Ok(Report::from_initialize(&init))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> (Store, PathBuf) {
        let dir = std::env::temp_dir().join(format!("yaah-agents-{}", crate::session::random_token()));
        (Store::at(dir.join("agents.json")), dir)
    }

    fn claude_account(id: &str, dir: Option<&str>) -> accounts::Account {
        accounts::Account { id: id.into(), label: id.into(), config_dir: dir.map(str::to_owned), email: None }
    }

    fn draft(label: &str, preset: &str, line: &str) -> Draft {
        Draft { label: label.into(), preset: preset.into(), command_line: line.into(), ..Draft::default() }
    }

    #[test]
    fn first_load_migrates_claude_accounts_with_their_ids() {
        let (store, dir) = temp_store();
        let file = store.load_with(|| vec![claude_account("default", None), claude_account("work", Some("/h/.claude-work"))]);
        let ids: Vec<&str> = file.profiles.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["default", "work"], "chats store these ids as account_id");
        assert!(file.profiles.iter().all(Profile::is_claude));
        assert_eq!(file.profiles[1].config_dir.as_deref(), Some("/h/.claude-work"));
        assert_eq!(file.profiles[0].command_line(), format!("npx -y {}", crate::session::ADAPTER_PACKAGE));
        assert_eq!(file.default_id().as_deref(), Some("default"));

        // Saved: a second load reads the file and doesn't rediscover.
        let again = store.load_with(|| panic!("should not migrate twice"));
        assert_eq!(again.profiles, file.profiles);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join("agents.json")).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "env may hold API keys");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn no_claude_means_no_profiles_and_no_file() {
        let (store, dir) = temp_store();
        let file = store.load_with(Vec::new);
        assert!(file.profiles.is_empty() && file.default_id().is_none(), "first run shows the setup screen");
        assert!(!dir.join("agents.json").exists());
    }

    #[test]
    fn save_edit_default_and_remove() {
        let (store, dir) = temp_store();
        // An existing, empty file: otherwise the first save migrates this machine's real ~/.claude.
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("agents.json"), r#"{ "profiles": [] }"#).unwrap();
        let _ = store.load_with(Vec::new);
        let mut d = draft("Gemini", "gemini", "gemini --acp");
        d.env.insert("GEMINI_API_KEY".into(), "k".into());
        let (g, replaced) = store.save(&d).unwrap();
        assert!(!replaced);
        assert_eq!((g.id.as_str(), g.command.as_str(), g.args.as_slice()), ("gemini", "gemini", &["--acp".to_owned()][..]));
        assert_eq!(store.load_with(Vec::new).default_id().as_deref(), Some("gemini"), "the first agent becomes the default");

        // Same label again gets its own id.
        let (g2, _) = store.save(&draft("Gemini", "gemini", "npx -y @google/gemini-cli@0.66.0 --acp")).unwrap();
        assert_eq!(g2.id, "gemini-2");
        store.set_default("gemini-2").unwrap();
        assert!(store.set_default("nope").is_err());

        // Reports survive an edit that keeps the command, not one that changes it.
        let report = Report { name: Some("gemini-cli".into()), mcp_http: true, ..Report::default() };
        store.record_report("gemini", &report);
        let edit = Draft { id: Some("gemini".into()), label: "Gemini (work)".into(), ..d.clone() };
        let (edited, replaced) = store.save(&edit).unwrap();
        assert!(replaced);
        assert_eq!(edited.report.as_ref(), Some(&report));
        let (edited, _) = store.save(&Draft { command_line: "gemini --experimental-acp".into(), ..edit }).unwrap();
        assert_eq!(edited.report, None);

        store.remove("gemini-2").unwrap();
        let file = store.load_with(Vec::new);
        assert_eq!(file.profiles.len(), 1);
        assert_eq!(file.default_id().as_deref(), Some("gemini"), "removing the default falls back to another");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn drafts_are_validated() {
        assert!(draft("", CUSTOM, "x").to_profile(&[]).is_err());
        assert!(draft("x", CUSTOM, "   ").to_profile(&[]).is_err());
        assert!(draft("x", "nonsense", "x").to_profile(&[]).is_err());
        let mut d = draft("x", CUSTOM, "x");
        d.env.insert("1BAD".into(), "v".into());
        assert!(d.to_profile(&[]).is_err());
        // Only Claude profiles carry a config dir.
        let d = Draft { config_dir: Some("/tmp/c".into()), ..draft("x", CUSTOM, "x") };
        assert_eq!(d.to_profile(&[]).unwrap().config_dir, None);
        assert_eq!(unique_id("My Agent!", &["my-agent".into()]), "my-agent-2");
        assert_eq!(unique_id("!!!", &[]), "agent");
    }

    #[test]
    fn claude_profiles_drop_an_inherited_api_key_unless_they_set_one() {
        let p = migrate(&[claude_account("work", Some("/h/.claude-work"))]).profiles.remove(0);
        assert_eq!(p.env_remove(), Some("ANTHROPIC_API_KEY"));
        assert!(p.spawn_env().contains(&("CLAUDE_CONFIG_DIR".into(), "/h/.claude-work".into())));
        let envs = |p: &Profile| p.process().as_std().get_envs().map(|(k, v)| (k.to_owned(), v.map(ToOwned::to_owned))).collect::<Vec<_>>();
        assert!(envs(&p).contains(&("ANTHROPIC_API_KEY".into(), None)), "removed from the child");
        let mut with_key = p.clone();
        with_key.env.insert("ANTHROPIC_API_KEY".into(), "k".into());
        assert_eq!(with_key.env_remove(), None);
        assert!(envs(&with_key).contains(&("ANTHROPIC_API_KEY".into(), Some("k".into()))));
        let other = draft("g", "gemini", "gemini --acp").to_profile(&[]).unwrap();
        assert!(other.env_remove().is_none() && other.spawn_env().is_empty());
        assert_eq!(other.process().as_std().get_args().collect::<Vec<_>>(), ["--acp"]);
    }

    #[test]
    fn preset_commands_prefer_a_binary_then_npx() {
        let gemini = preset("gemini").unwrap();
        assert_eq!(gemini.command(Some("gemini")), ("gemini".into(), vec!["--acp".into()]));
        assert_eq!(gemini.command(None), ("npx".into(), vec!["-y".into(), "@google/gemini-cli@0.66.0".into(), "--acp".into()]));
        let codex = preset("codex").unwrap();
        assert_eq!(codex.command(None).1, ["-y", "@agentclientprotocol/codex-acp@2.5.0"]);
        let goose = preset("goose").unwrap();
        assert_eq!(goose.command(None), ("goose".into(), vec!["acp".into()]), "no npx: name the binary to install");
        let claude = preset(CLAUDE).unwrap();
        assert_eq!(claude.command(Some("ignored")).0, "ignored");
        assert_eq!(claude.command(None), ("npx".into(), vec!["-y".into(), crate::session::ADAPTER_PACKAGE.into()]));
        // Every preset's draft round-trips into a profile.
        for p in presets() {
            if p.id != CUSTOM {
                let profile = p.draft.to_profile(&[]).unwrap_or_else(|e| panic!("{}: {e}", p.id));
                assert_eq!(profile.command_line(), p.draft.command_line);
            }
        }
        assert!(presets().iter().any(|p| p.id == CUSTOM));
    }

    #[test]
    fn command_lines_split_and_join() {
        assert_eq!(split_args("npx -y pkg@1 --acp").unwrap(), ["npx", "-y", "pkg@1", "--acp"]);
        assert_eq!(split_args(r#"run "a b" 'c d' e\ f ''"#).unwrap(), ["run", "a b", "c d", "e f", ""]);
        assert!(split_args("x 'open").is_err());
        let words = ["/opt/my agent/bin", "--flag=it's", ""];
        assert_eq!(split_args(&join_args(words)).unwrap(), words);
        assert_eq!(join_args(["gemini", "--acp"]), "gemini --acp");
    }

    #[test]
    fn reads_initialize() {
        let init = json!({
            "protocolVersion": 1,
            "agentInfo": { "name": "gemini-cli", "title": "Gemini CLI", "version": "0.63.0" },
            "agentCapabilities": {
                "loadSession": true,
                "promptCapabilities": { "image": true, "audio": false, "embeddedContext": true },
                "mcpCapabilities": { "http": true, "sse": false },
                "sessionCapabilities": { "additionalDirectories": {} }
            },
            "authMethods": [
                { "id": "oauth-personal", "name": "Log in with Google", "description": null },
                { "id": "login", "name": "Log in", "type": "terminal", "args": ["login"] },
                { "id": "key", "name": "API key", "type": "env_var", "vars": [{ "name": "GEMINI_API_KEY" }] }
            ]
        });
        let r = Report::from_initialize(&init);
        assert_eq!((r.name.as_deref(), r.version.as_deref(), r.protocol_version), (Some("gemini-cli"), Some("0.63.0"), Some(1)));
        assert!(r.compatible && r.mcp_http && !r.mcp_sse && r.load_session && r.embedded_context && r.image && r.additional_dirs);
        let kinds: Vec<&str> = r.auth_methods.iter().map(|m| m.kind.as_str()).collect();
        assert_eq!(kinds, ["agent", "terminal", "env_var"], "no `type` means the agent handles it");
        assert_eq!(r.auth_methods[2].vars, ["GEMINI_API_KEY"]);

        let bare = Report::from_initialize(&json!({ "protocolVersion": 2, "agentCapabilities": {} }));
        assert!(!bare.compatible && !bare.mcp_http && bare.auth_methods.is_empty());
    }
}
