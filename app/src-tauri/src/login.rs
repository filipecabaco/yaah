//! Logging an agent profile in from the UI, through ACP's `authMethods`.
//!
//! - `agent` methods (no `type`): we send ACP `authenticate` and the agent does
//!   the rest itself, often in a browser.
//! - `terminal` methods (we advertise `auth.terminal`): extra args to run the
//!   *same agent command* with, as a separate process (never through a shell).
//!   For claude-agent-acp that is `--cli auth login --claudeai`, which opens the
//!   browser, finishes through a callback, and falls back to printing a URL and
//!   reading a pasted code on stdin. We run it with the profile's env, stream its
//!   output to the UI, and let the UI write a code to its stdin.
//! - `env_var` methods: the user sets the variables on the profile; nothing to run.
//!
//! Events: `login-output` and `login-url` while it runs, `login-done` at the end.

use crate::agents::{self, AuthMethod};
use crate::session::{Emit, Hub};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncRead, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::sync::oneshot;

/// Login output lines are cut to this.
const MAX_LINE: usize = 16 << 10;

struct Running {
    /// Terminal logins only: where a pasted code goes.
    stdin: Option<Arc<tokio::sync::Mutex<ChildStdin>>>,
    cancel: oneshot::Sender<()>,
}

/// Logins in progress, one per profile at most.
#[derive(Default, Clone)]
pub struct Logins {
    running: Arc<Mutex<HashMap<String, Running>>>,
}

type Work = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;

/// The login methods this profile's agent offers.
pub async fn methods(hub: &Hub, account_id: &str) -> Result<Vec<AuthMethod>, String> {
    Ok(agents::auth_methods(&hub.auth_methods(account_id).await?))
}

impl Logins {
    /// Start logging `account_id` in with one of its agent's methods. Returns
    /// once it has started; how it ends arrives as `login-done`.
    pub async fn start(&self, hub: Arc<Hub>, emit: Emit, account_id: &str, method_id: &str) -> Result<(), String> {
        let profile = hub.profile(account_id)?;
        let methods = hub.auth_methods(account_id).await?;
        let method = methods.iter().find(|m| m["id"] == method_id).ok_or_else(|| format!("agent does not offer login method {method_id}"))?;
        let kind = method["type"].as_str().unwrap_or("agent");
        if !matches!(kind, "agent" | "terminal") {
            let vars = agents::auth_methods(std::slice::from_ref(method)).first().map(|m| m.vars.join(", ")).unwrap_or_default();
            return Err(if vars.is_empty() {
                format!("yaah can't run `{kind}` logins; set the agent's credentials in its environment instead")
            } else {
                format!("Set {vars} in this agent's environment (Manage agents), then start a chat.")
            });
        }

        // Claim the profile before starting anything, so two clicks can't start two logins.
        let (cancel, cancelled) = oneshot::channel();
        {
            let mut running = self.running.lock().unwrap();
            if running.contains_key(account_id) {
                return Err("a login is already running for this agent".into());
            }
            running.insert(account_id.to_owned(), Running { stdin: None, cancel });
        }
        let terminal = kind == "terminal";
        let work: Work = if terminal {
            let mut cmd = profile.process();
            cmd.args(method["args"].as_array().into_iter().flatten().filter_map(Value::as_str))
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            for (k, v) in method["env"].as_object().into_iter().flatten() {
                if let Some(v) = v.as_str()
                    && agent_may_set(k)
                {
                    cmd.env(k, v);
                }
            }
            let mut child = match cmd.spawn() {
                Ok(child) => child,
                Err(e) => {
                    self.running.lock().unwrap().remove(account_id);
                    return Err(format!("failed to start login: {e}"));
                }
            };
            if let Some(r) = self.running.lock().unwrap().get_mut(account_id) {
                r.stdin = child.stdin.take().map(|s| Arc::new(tokio::sync::Mutex::new(s)));
            }
            if let Some(out) = child.stdout.take() {
                stream(emit.clone(), account_id.to_owned(), out);
            }
            if let Some(err) = child.stderr.take() {
                stream(emit.clone(), account_id.to_owned(), err);
            }
            Box::pin(async move {
                match child.wait().await {
                    Ok(s) if s.success() => Ok(()),
                    Ok(s) => Err(format!("login exited with {s}")),
                    Err(e) => Err(e.to_string()),
                }
            })
        } else {
            let (hub, id, method_id) = (hub.clone(), account_id.to_owned(), method_id.to_owned());
            Box::pin(async move { hub.authenticate(&id, &method_id).await })
        };

        let running = self.running.clone();
        let account_id = account_id.to_owned();
        tauri::async_runtime::spawn(async move {
            // Dropping `work` on cancel kills a terminal login (kill_on_drop) or stops waiting on `authenticate`.
            let outcome = tokio::select! {
                res = work => res,
                _ = cancelled => Err("login cancelled".into()),
            };
            running.lock().unwrap().remove(&account_id);
            if outcome.is_ok() {
                hub.logged_in(&account_id);
            }
            // After a terminal login the running agent may have cached "not logged in",
            // and an agent stuck in a failed or cancelled `authenticate` is stopped:
            // either way the next chat starts a fresh one.
            if terminal || outcome.is_err() {
                hub.drop_agent(&account_id).await;
            }
            emit("login-done", json!({ "accountId": account_id, "ok": outcome.is_ok(), "message": outcome.err() }));
            emit("accounts-changed", Value::Null);
        });
        Ok(())
    }

    /// Feed a code pasted in the UI to the login process.
    pub async fn submit_code(&self, account_id: &str, code: &str) -> Result<(), String> {
        let stdin =
            self.running.lock().unwrap().get(account_id).and_then(|r| r.stdin.clone()).ok_or("no terminal login is running for this agent")?;
        let mut stdin = stdin.lock().await;
        stdin.write_all(format!("{}\n", code.trim()).as_bytes()).await.map_err(|e| format!("could not send code: {e}"))?;
        stdin.flush().await.map_err(|e| e.to_string())
    }

    pub fn cancel(&self, account_id: &str) {
        if let Some(r) = self.running.lock().unwrap().remove(account_id) {
            let _ = r.cancel.send(());
        }
    }
}

/// Forward each output line to the UI, and any URL in it as `login-url`.
fn stream(emit: Emit, account_id: String, out: impl AsyncRead + Unpin + Send + 'static) {
    tauri::async_runtime::spawn(async move {
        let (mut out, mut buf) = (BufReader::new(out), Vec::new());
        while let Ok(Some(_)) = crate::acp::read_line(&mut out, &mut buf, MAX_LINE).await {
            let (text, mut urls) = strip_escapes(&String::from_utf8_lossy(&buf));
            urls.extend(text.split_whitespace().filter(|w| w.starts_with("https://")).map(str::to_owned));
            if let Some(url) = urls.into_iter().next() {
                emit("login-url", json!({ "accountId": account_id, "url": url }));
            }
            if !text.trim().is_empty() {
                emit("login-output", json!({ "accountId": account_id, "line": text }));
            }
        }
    });
}

/// Drop ANSI CSI/OSC sequences, collecting OSC 8 hyperlink targets.
fn strip_escapes(s: &str) -> (String, Vec<String>) {
    let mut out = String::with_capacity(s.len());
    let mut urls = vec![];
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        match chars.next() {
            // CSI: ESC [ params final-byte(@..~)
            Some('[') => {
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            // OSC: ESC ] payload (BEL | ESC \)
            Some(']') => {
                let mut payload = String::new();
                while let Some(c) = chars.next() {
                    if c == '\x07' {
                        break;
                    }
                    if c == '\x1b' {
                        chars.next_if_eq(&'\\');
                        break;
                    }
                    payload.push(c);
                }
                // OSC 8 ; params ; URI
                if let Some((_, uri)) = payload.strip_prefix("8;").and_then(|p| p.split_once(';'))
                    && !uri.is_empty()
                {
                    urls.push(uri.to_owned());
                }
            }
            _ => {}
        }
    }
    (out, urls)
}

#[cfg(test)]
mod tests {
    use super::strip_escapes;

    #[test]
    fn strips_osc8_and_keeps_link() {
        let s = "visit: \x1b]8;;https://example.com/a?b=c\x1b\\https://example.com/a?b=c\x1b]8;;\x1b\\";
        let (text, urls) = strip_escapes(s);
        assert_eq!(text, "visit: https://example.com/a?b=c");
        assert_eq!(urls, vec!["https://example.com/a?b=c"]);
    }

    #[test]
    fn strips_csi_colours() {
        let (text, urls) = strip_escapes("\x1b[1;32mok\x1b[0m done");
        assert_eq!(text, "ok done");
        assert_eq!(urls, Vec::<String>::new());
    }
}

/// Whether a login method may set `name` for the login process. The method comes from
/// the agent, so it may only configure the agent's own login, never change which
/// programs run, what gets loaded into them, where they fetch from or whom they
/// trust (`PATH`, `NODE_OPTIONS`, `NPM_CONFIG_*`, `HTTPS_PROXY`, `SSL_CERT_FILE`,
/// `GIT_*`, `DYLD_*`…). Hence an allowlist: the agents' own prefixes and a few
/// terminal settings. claude-agent-acp's terminal logins set no variables at all.
fn agent_may_set(name: &str) -> bool {
    const PREFIXES: &[&str] = &["CLAUDE_", "ANTHROPIC_", "GEMINI_", "LC_"];
    const NAMES: &[&str] = &["FORCE_COLOR", "NO_COLOR", "TERM", "LANG"];
    // Case matters: on Unix `npm_config_x` and `NPM_CONFIG_X` are different
    // variables, and lower-case ones are read too.
    NAMES.contains(&name) || PREFIXES.iter().any(|p| name.len() > p.len() && name.starts_with(p))
}

#[cfg(test)]
mod env_tests {
    #[test]
    fn agents_only_set_their_own_login_variables() {
        for blocked in [
            "PATH",
            "path",
            "DYLD_INSERT_LIBRARIES",
            "LD_PRELOAD",
            "NODE_OPTIONS",
            "NODE_EXTRA_CA_CERTS",
            "NPM_CONFIG_REGISTRY",
            "npm_config_registry",
            "HTTPS_PROXY",
            "https_proxy",
            "SSL_CERT_FILE",
            "GIT_SSH_COMMAND",
            "BASH_ENV",
            "HOME",
            "claude_config_dir",
            "CLAUDE_",
            "TERMINFO",
            "LANGUAGE_X",
        ] {
            assert!(!super::agent_may_set(blocked), "{blocked}");
        }
        for ok in [
            "CLAUDE_CONFIG_DIR",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "ANTHROPIC_BASE_URL",
            "GEMINI_API_KEY",
            "FORCE_COLOR",
            "NO_COLOR",
            "TERM",
            "LANG",
            "LC_ALL",
        ] {
            assert!(super::agent_may_set(ok), "{ok}");
        }
    }
}
