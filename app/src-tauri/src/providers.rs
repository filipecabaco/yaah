//! Model providers: OpenRouter and Amazon Bedrock, for the agents that can run
//! on them (Claude Code, Goose, OpenCode). See
//! `docs/research/model-providers-contract.md`.
//!
//! - `~/.config/yaah/providers.json` (0600) holds the non-secret part: id,
//!   kind, label, the Bedrock profile/region/prefix and the last check.
//! - The OpenRouter key lives in the OS keychain (`keychain.rs`), service
//!   `dev.yaah.app`, account `provider:<id>`. Nothing secret is written to JSON,
//!   logged, or returned to the UI.
//! - Bedrock has no secret: an AWS profile (SSO included) from `~/.aws/config`,
//!   checked and listed through the `aws` CLI (never a shell).
//! - Model lists are cached for a day under `~/.yaah/providers/`.
//!
//! An agent profile binds to a provider with a [`Binding`]; `agent_routes.rs`
//! turns it into that agent's env at spawn, through [`resolve`].

use crate::agents::Profile;
use crate::json_file::JsonFile;
use crate::keychain::{self, Keychain, SecretString};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Duration;

const OPENROUTER_API: &str = "https://openrouter.ai/api/v1";
const HTTP_TIMEOUT: Duration = Duration::from_secs(20);
/// One `aws` call (STS, a Bedrock listing).
const AWS_TIMEOUT: Duration = Duration::from_secs(30);
/// `aws sso login` waits on the user in a browser.
const SSO_LOGIN_TIMEOUT: Duration = Duration::from_mins(10);
/// Model lists are kept this long.
const MODELS_TTL: u64 = 24 * 60 * 60;
/// OpenRouter's full model list is a few MB.
const MAX_RESPONSE: usize = 32 << 20;
const INSTALL_AWS: &str = "Install AWS CLI v2 (https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), then test again.";
/// What a failed Bedrock check offers to do: run `aws sso login --profile P`.
pub const SSO_LOGIN: &str = "ssoLogin";

// ── Data ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Openrouter,
    Bedrock,
}

impl Kind {
    pub fn label(self) -> &'static str {
        match self {
            Kind::Openrouter => "OpenRouter",
            Kind::Bedrock => "Bedrock",
        }
    }
}

/// Which AWS profile and region a Bedrock provider uses. No secret: the AWS
/// CLI and SDKs find the credentials (SSO included) from the profile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bedrock {
    pub profile: String,
    pub region: String,
    /// Cross-region inference profile geography (`us`, `eu`, `apac`, `global`…);
    /// model ids are offered with it. `None`: any the region offers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
}

/// The last "Test" of a provider.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub ok: bool,
    /// What happened, in words.
    pub detail: String,
    /// Who the credential is: OpenRouter's key label, the AWS account.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<String>,
    /// Something that fixes a failure: [`SSO_LOGIN`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
}

impl Check {
    fn failed(detail: impl Into<String>) -> Self {
        Self { ok: false, detail: detail.into(), identity: None, action: None }
    }
}

/// A provider as saved in `providers.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub kind: Kind,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bedrock: Option<Bedrock>,
    /// Unix seconds of the last check.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check: Option<Check>,
}

impl Provider {
    /// Its last check passed.
    pub fn ready(&self) -> bool {
        self.check.as_ref().is_some_and(|c| c.ok)
    }

    /// One line for where an account's email would go:
    /// "Bedrock · us-east-1 · work", "OpenRouter · my key".
    pub fn summary(&self) -> String {
        match (&self.kind, &self.bedrock) {
            (Kind::Bedrock, Some(b)) => format!("Bedrock · {} · {}", b.region, b.profile),
            (kind, _) => {
                let who = self.check.as_ref().filter(|c| c.ok).and_then(|c| c.identity.as_deref()).unwrap_or(&self.label);
                format!("{} · {who}", kind.label())
            }
        }
    }

    /// The model cache is only good for the settings it was listed with.
    fn fingerprint(&self) -> String {
        match &self.bedrock {
            Some(b) => format!("bedrock:{}:{}:{}", b.profile, b.region, b.prefix.as_deref().unwrap_or("")),
            None => format!("{:?}", self.kind).to_lowercase(),
        }
    }
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct ProvidersFile {
    #[serde(default)]
    pub providers: Vec<Provider>,
}

/// An agent profile's model provider and models (`agents::Profile.provider`).
/// Translated into the agent's env at spawn; never written into `Profile.env`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub provider_id: String,
    pub model: String,
    /// A cheaper model for background work, where the agent takes one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub small_model: Option<String>,
}

/// Everything an agent's route needs from a provider, the secret included.
/// Its `Debug` never shows the secret.
#[derive(Debug, Clone)]
pub struct ResolvedProvider {
    pub id: String,
    pub kind: Kind,
    pub label: String,
    /// Bedrock only.
    pub bedrock: Option<Bedrock>,
    /// OpenRouter: the API key. Bedrock: `None`.
    pub secret: Option<SecretString>,
}

/// What the UI is shown. Never a secret: only whether there is one.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub id: String,
    pub kind: Kind,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bedrock: Option<Bedrock>,
    pub has_secret: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub check: Option<Check>,
    /// See [`Provider::summary`].
    pub summary: String,
}

/// What Settings sends to save a provider. An omitted `secret` keeps the stored one.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    #[serde(default)]
    pub id: Option<String>,
    pub kind: Kind,
    pub label: String,
    #[serde(default)]
    pub bedrock: Option<Bedrock>,
    #[serde(default)]
    pub secret: Option<SecretString>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_length: Option<u64>,
    /// Takes tool calls (agents need them).
    pub tools: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelList {
    pub models: Vec<Model>,
    /// Unix seconds when the list was fetched.
    pub cached_at: u64,
}

/// The cache file: the unfiltered list and the settings it was listed with.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedModels {
    fingerprint: String,
    #[serde(flatten)]
    list: ModelList,
}

/// A profile in `~/.aws/config` / `~/.aws/credentials`. Names, regions and
/// whether it signs in through SSO; never a credential.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AwsProfile {
    pub name: String,
    pub region: Option<String>,
    pub sso: bool,
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn account(id: &str) -> String {
    format!("provider:{id}")
}

// ── The store ───────────────────────────────────────────────────────────────

pub struct Store {
    file: JsonFile,
    keychain: Arc<dyn Keychain>,
    /// `~/.yaah/providers/`: model lists.
    cache_dir: PathBuf,
    /// Send `https://<host>/…` to `<base>/<host>/…` instead (tests' local server).
    base: Option<String>,
    aws: Aws,
    /// `~/.aws/config` and `~/.aws/credentials` (or `AWS_CONFIG_FILE` / `AWS_SHARED_CREDENTIALS_FILE`).
    aws_config: PathBuf,
    aws_credentials: PathBuf,
    /// Profiles with an `aws sso login` running.
    sso_running: Mutex<HashSet<String>>,
}

/// A provider with its secret, for an agent's route at spawn. Reads the
/// keychain (blocking, briefly).
pub fn resolve(provider_id: &str) -> Result<ResolvedProvider, String> {
    Store::user().resolve(provider_id)
}

impl Store {
    pub fn user() -> &'static Store {
        static USER: OnceLock<Store> = OnceLock::new();
        USER.get_or_init(|| {
            let home = crate::accounts::home();
            let env_path = |var: &str, default: PathBuf| std::env::var_os(var).filter(|v| !v.is_empty()).map_or(default, PathBuf::from);
            Store {
                file: JsonFile::new(home.join(".config/yaah/providers.json"), true),
                keychain: keychain::system(),
                cache_dir: home.join(".yaah/providers"),
                base: None,
                aws: Aws { path: None },
                aws_config: env_path("AWS_CONFIG_FILE", home.join(".aws/config")),
                aws_credentials: env_path("AWS_SHARED_CREDENTIALS_FILE", home.join(".aws/credentials")),
                sso_running: Mutex::default(),
            }
        })
    }

    pub fn load(&self) -> ProvidersFile {
        self.file.read()
    }

    pub fn get(&self, id: &str) -> Option<Provider> {
        self.load().providers.into_iter().find(|p| p.id == id)
    }

    fn info(&self, p: Provider) -> ProviderInfo {
        // A keychain that can't be read shows as "no key"; saving or testing says why.
        let has_secret = p.kind == Kind::Openrouter && self.keychain.get(&account(&p.id)).is_ok_and(|s| s.is_some());
        ProviderInfo {
            summary: p.summary(),
            id: p.id,
            kind: p.kind,
            label: p.label,
            bedrock: p.bedrock,
            has_secret,
            checked_at: p.checked_at,
            check: p.check,
        }
    }

    /// Every provider, for Settings. Reads the keychain (whether each has a key).
    pub fn list(&self) -> Vec<ProviderInfo> {
        self.load().providers.into_iter().map(|p| self.info(p)).collect()
    }

    /// Create or edit a provider. A new or changed secret goes to the keychain
    /// first: if that fails nothing is saved. Changing the key or the AWS
    /// settings clears the last check and the cached model list.
    pub fn save(&self, draft: &Draft) -> Result<ProviderInfo, String> {
        let label = draft.label.trim().to_owned();
        if label.is_empty() {
            return Err("give the provider a name".into());
        }
        let bedrock = match draft.kind {
            Kind::Bedrock => Some(valid_bedrock(draft.bedrock.as_ref().ok_or("choose an AWS profile and region")?)?),
            Kind::Openrouter => None,
        };
        let secret = match (draft.kind, &draft.secret) {
            (Kind::Openrouter, Some(s)) if !s.expose().trim().is_empty() => Some(SecretString::new(s.expose().trim())),
            _ => None,
        };
        let saved = self.file.update(|file: &mut ProvidersFile| {
            let existing = match &draft.id {
                Some(id) => Some(file.providers.iter().position(|p| &p.id == id).ok_or_else(|| format!("no model provider {id}"))?),
                None => None,
            };
            let id = if let Some(i) = existing {
                file.providers[i].id.clone()
            } else {
                let taken: Vec<String> = file.providers.iter().map(|p| p.id.clone()).collect();
                crate::agents::unique_id(&label, &taken)
            };
            if let Some(i) = existing
                && file.providers[i].kind != draft.kind
            {
                return Err("a provider can't change kind; add a new one instead".into());
            }
            if draft.kind == Kind::Openrouter {
                match &secret {
                    Some(s) => self.keychain.set(&account(&id), s)?,
                    None if existing.is_none() => return Err("paste your OpenRouter API key".into()),
                    None => {}
                }
            }
            let mut provider = Provider { id, kind: draft.kind, label: label.clone(), bedrock: bedrock.clone(), checked_at: None, check: None };
            match existing {
                Some(i) => {
                    let old = &file.providers[i];
                    // Same credential: the last check still holds.
                    if secret.is_none() && old.bedrock == provider.bedrock {
                        provider.checked_at = old.checked_at;
                        provider.check.clone_from(&old.check);
                    }
                    file.providers[i] = provider.clone();
                }
                None => file.providers.push(provider.clone()),
            }
            Ok(provider)
        })?;
        if saved.check.is_none() {
            self.forget_models(&saved.id);
        }
        Ok(self.info(saved))
    }

    /// Remove a provider, its key and its cached models. Refused while an agent
    /// profile is bound to it.
    pub fn delete(&self, id: &str, profiles: &[Profile]) -> Result<(), String> {
        self.file.update(|file: &mut ProvidersFile| {
            let i = file.providers.iter().position(|p| p.id == id).ok_or_else(|| format!("no model provider {id}"))?;
            let users: Vec<&str> =
                profiles.iter().filter(|p| p.provider.as_ref().is_some_and(|b| b.provider_id == id)).map(|p| p.label.as_str()).collect();
            if !users.is_empty() {
                return Err(format!(
                    "\"{}\" is used by {}. Choose another model provider for {} first.",
                    file.providers[i].label,
                    users.join(", "),
                    if users.len() == 1 { "it" } else { "them" }
                ));
            }
            if file.providers[i].kind == Kind::Openrouter {
                self.keychain.delete(&account(id))?;
            }
            file.providers.remove(i);
            Ok(())
        })?;
        self.forget_models(id);
        Ok(())
    }

    /// The provider with its secret (see [`resolve`]).
    pub fn resolve(&self, id: &str) -> Result<ResolvedProvider, String> {
        let p = self.get(id).ok_or_else(|| format!("the model provider {id} was removed; choose another in the agent's settings"))?;
        let secret = match p.kind {
            Kind::Openrouter => Some(
                self.keychain.get(&account(id))?.ok_or_else(|| format!("\"{}\" has no API key; add it in Settings → Model providers", p.label))?,
            ),
            Kind::Bedrock => None,
        };
        Ok(ResolvedProvider { id: p.id, kind: p.kind, label: p.label, bedrock: p.bedrock, secret })
    }

    /// The secret, read off the async workers (a keychain may block on a prompt).
    async fn secret(&self, id: &str) -> Result<Option<SecretString>, String> {
        let (keychain, account) = (self.keychain.clone(), account(id));
        tokio::task::spawn_blocking(move || keychain.get(&account)).await.map_err(|e| e.to_string())?
    }

    fn url(&self, real: &str) -> String {
        match &self.base {
            Some(base) => format!("{base}/{}", real.trim_start_matches("https://")),
            None => real.to_owned(),
        }
    }

    /// "Test": check the credential works, and remember the result.
    pub async fn test(&self, id: &str) -> Result<ProviderInfo, String> {
        let p = self.get(id).ok_or_else(|| format!("no model provider {id}"))?;
        let check = match (&p.kind, &p.bedrock) {
            (Kind::Openrouter, _) => match self.secret(id).await? {
                Some(key) => self.openrouter_key(&key).await,
                None => Check::failed("No API key saved. Paste your OpenRouter key and save."),
            },
            (Kind::Bedrock, Some(b)) => self.aws.caller_identity(b).await,
            (Kind::Bedrock, None) => Check::failed("Choose an AWS profile and region."),
        };
        let saved = self.file.update(|file: &mut ProvidersFile| {
            let p = file.providers.iter_mut().find(|p| p.id == id).ok_or_else(|| format!("no model provider {id}"))?;
            p.check = Some(check);
            p.checked_at = Some(now());
            Ok(p.clone())
        })?;
        Ok(self.info(saved))
    }

    /// `GET /api/v1/key`: the key's label, limit and what's left.
    async fn openrouter_key(&self, key: &SecretString) -> Check {
        let res =
            crate::integrations::http().get(self.url(&format!("{OPENROUTER_API}/key"))).bearer_auth(key.expose()).timeout(HTTP_TIMEOUT).send().await;
        let resp = match res {
            Ok(r) => r,
            Err(e) => return Check::failed(format!("Couldn't reach OpenRouter: {}", e.without_url())),
        };
        let status = resp.status();
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Check::failed(format!("OpenRouter refused the key ({}). Check it at openrouter.ai/settings/keys.", status.as_u16()));
        }
        if !status.is_success() {
            return Check::failed(format!("OpenRouter answered {status}."));
        }
        let body: Value = match crate::integrations::read_capped(resp, MAX_RESPONSE).await.map(|b| serde_json::from_slice(&b)) {
            Ok(Ok(v)) => v,
            _ => return Check::failed("OpenRouter's answer wasn't readable."),
        };
        let d = &body["data"];
        let label = d["label"].as_str().filter(|l| !l.is_empty()).map(str::to_owned);
        let mut parts = vec![match &label {
            Some(l) => format!("Key \"{l}\" works"),
            None => "The key works".to_owned(),
        }];
        match (d["limit_remaining"].as_f64(), d["limit"].as_f64()) {
            (Some(left), Some(limit)) => parts.push(format!("${left:.2} of ${limit:.2} left")),
            _ => parts.push("no spending limit".to_owned()),
        }
        if d["is_free_tier"].as_bool() == Some(true) {
            parts.push("free tier".to_owned());
        }
        Check { ok: true, detail: parts.join(" · "), identity: label, action: None }
    }

    /// The provider's models for an agent preset, from the cache when it's
    /// less than a day old (and was listed with the same settings).
    pub async fn models(&self, id: &str, preset: &str, refresh: bool) -> Result<ModelList, String> {
        let p = self.get(id).ok_or_else(|| format!("no model provider {id}"))?;
        let fingerprint = p.fingerprint();
        let path = self.cache_dir.join(format!("{id}.models.json"));
        let cached = (!refresh)
            .then(|| std::fs::read(&path).ok())
            .flatten()
            .and_then(|b| serde_json::from_slice::<CachedModels>(&b).ok())
            .filter(|c| c.fingerprint == fingerprint && now().saturating_sub(c.list.cached_at) < MODELS_TTL);
        let list = if let Some(c) = cached {
            c.list
        } else {
            let models = match (&p.kind, &p.bedrock) {
                (Kind::Openrouter, _) => self.openrouter_models(id).await?,
                (Kind::Bedrock, Some(b)) => self.aws.models(b).await?,
                (Kind::Bedrock, None) => return Err("choose an AWS profile and region first".into()),
            };
            let entry = CachedModels { fingerprint, list: ModelList { models, cached_at: now() } };
            if let Err(e) = crate::json_file::write(&path, &entry, false) {
                eprintln!("[providers] {e}");
            }
            entry.list
        };
        Ok(ModelList { models: for_preset(list.models, preset), cached_at: list.cached_at })
    }

    fn forget_models(&self, id: &str) {
        let _ = std::fs::remove_file(self.cache_dir.join(format!("{id}.models.json")));
    }

    /// `GET /api/v1/models?supported_parameters=tools` (the key is sent when there is one).
    async fn openrouter_models(&self, id: &str) -> Result<Vec<Model>, String> {
        let mut req = crate::integrations::http().get(self.url(&format!("{OPENROUTER_API}/models?supported_parameters=tools"))).timeout(HTTP_TIMEOUT);
        if let Ok(Some(key)) = self.secret(id).await {
            req = req.bearer_auth(key.expose());
        }
        let resp = req.send().await.map_err(|e| format!("Couldn't reach OpenRouter: {}", e.without_url()))?;
        if !resp.status().is_success() {
            return Err(format!("OpenRouter answered {} listing models", resp.status()));
        }
        let body: Value = serde_json::from_slice(&crate::integrations::read_capped(resp, MAX_RESPONSE).await?)
            .map_err(|_| "OpenRouter's model list wasn't readable".to_owned())?;
        Ok(body["data"]
            .as_array()
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .filter_map(|m| {
                let id = m["id"].as_str()?.to_owned();
                let tools = m["supported_parameters"].as_array().is_some_and(|p| p.iter().any(|x| x == "tools"));
                Some(Model { label: m["name"].as_str().unwrap_or(&id).to_owned(), context_length: m["context_length"].as_u64(), tools, id })
            })
            .collect())
    }

    /// Profiles in the AWS config and credentials files (names and regions only).
    pub fn aws_profiles(&self) -> Vec<AwsProfile> {
        let read = |p: &Path| std::fs::read_to_string(p).unwrap_or_default();
        aws_profiles(&read(&self.aws_config), &read(&self.aws_credentials))
    }

    /// Run `aws sso login --profile P` (the CLI opens the browser), then test
    /// the provider again. One at a time per profile.
    pub async fn sso_login(&self, id: &str) -> Result<ProviderInfo, String> {
        let p = self.get(id).ok_or_else(|| format!("no model provider {id}"))?;
        let b = p.bedrock.ok_or("only Bedrock providers sign in with AWS SSO")?;
        if !self.sso_running.lock().unwrap_or_else(PoisonError::into_inner).insert(b.profile.clone()) {
            return Err(format!("an AWS SSO login for {} is already open in your browser", b.profile));
        }
        let res = self.aws.run(&["sso", "login", "--profile", &b.profile], SSO_LOGIN_TIMEOUT).await;
        self.sso_running.lock().unwrap_or_else(PoisonError::into_inner).remove(&b.profile);
        res.map_err(|e| e.message(&b.profile))?;
        self.test(id).await
    }
}

fn valid_bedrock(b: &Bedrock) -> Result<Bedrock, String> {
    let profile = b.profile.trim();
    // Passed to `aws` as its own argument; a leading `-` would read as a flag.
    if profile.is_empty() || profile.starts_with('-') || profile.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(format!("`{profile}` isn't an AWS profile name"));
    }
    let region = b.region.trim();
    let mut parts = region.split('-');
    let ok_region = parts.next().is_some_and(|p| p.len() >= 2 && p.chars().all(|c| c.is_ascii_lowercase()))
        && region.split('-').count() >= 3
        && region.rsplit('-').next().is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
        && region.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !ok_region {
        return Err(format!("`{region}` isn't an AWS region (e.g. us-east-1)"));
    }
    let prefix = b.prefix.as_deref().map(str::trim).filter(|p| !p.is_empty());
    if let Some(p) = prefix
        && !(p.len() <= 8 && p.chars().all(|c| c.is_ascii_lowercase() || c == '-'))
    {
        return Err(format!("`{p}` isn't an inference profile prefix (us, eu, apac, global)"));
    }
    Ok(Bedrock { profile: profile.to_owned(), region: region.to_owned(), prefix: prefix.map(str::to_owned) })
}

/// The models an agent preset can use: Claude Code only runs Anthropic models;
/// the others need tool calls.
fn for_preset(models: Vec<Model>, preset: &str) -> Vec<Model> {
    models.into_iter().filter(|m| if preset == crate::agents::CLAUDE { is_anthropic(&m.id) } else { m.tools }).collect()
}

/// `anthropic/…` on OpenRouter; `anthropic.…` or `us.anthropic.…` on Bedrock.
fn is_anthropic(id: &str) -> bool {
    id.starts_with("anthropic/") || id.split('.').take(2).any(|seg| seg == "anthropic")
}

// ── The aws CLI ─────────────────────────────────────────────────────────────

/// Runs `aws` with arguments (no shell), JSON out, under a timeout.
#[derive(Debug, Clone)]
struct Aws {
    /// The PATH to find `aws` on; `None`: the login shell's (`path_env`).
    path: Option<OsString>,
}

#[derive(Debug, PartialEq)]
enum AwsError {
    /// `aws` isn't installed.
    Missing,
    /// The profile's SSO login has expired (or never happened).
    SsoExpired,
    TimedOut,
    /// Anything else: what the CLI said.
    Failed(String),
}

impl AwsError {
    fn message(&self, profile: &str) -> String {
        match self {
            AwsError::Missing => format!("The AWS CLI isn't installed. {INSTALL_AWS}"),
            AwsError::SsoExpired => {
                format!("The AWS SSO login for profile {profile} has expired. Run `aws sso login --profile {profile}`, then test again.")
            }
            AwsError::TimedOut => "The AWS CLI didn't answer in time.".to_owned(),
            AwsError::Failed(why) => why.clone(),
        }
    }

    fn check(&self, profile: &str) -> Check {
        Check { action: (*self == AwsError::SsoExpired).then(|| SSO_LOGIN.to_owned()), ..Check::failed(self.message(profile)) }
    }
}

/// The CLI's words for an SSO login that has run out or was never done.
fn sso_expired(stderr: &str) -> bool {
    let e = stderr.to_ascii_lowercase();
    e.contains("aws sso login")
        || (e.contains("sso")
            && (e.contains("expired")
                || e.contains("refresh failed")
                || e.contains("invalid")
                || (e.contains("token") && e.contains("does not exist"))))
}

/// The CLI's error, short: its last non-empty lines.
fn cli_error(stderr: &str, code: Option<i32>) -> String {
    let lines: Vec<&str> = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let text = lines[lines.len().saturating_sub(3)..].join(" ");
    if text.is_empty() {
        return format!("The AWS CLI failed (exit {}).", code.map_or_else(|| "signal".to_owned(), |c| c.to_string()));
    }
    let mut short: String = text.chars().take(400).collect();
    if short.len() < text.len() {
        short.push('…');
    }
    short
}

impl Aws {
    fn command(&self, args: &[&str]) -> tokio::process::Command {
        let mut c = crate::path_env::tokio_command("aws");
        if let Some(path) = &self.path {
            c.env("PATH", path);
        }
        // Never page or prompt: there is no terminal.
        c.args(args).env("AWS_PAGER", "").env("AWS_CLI_AUTO_PROMPT", "off");
        c.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        c
    }

    /// Run `aws <args>`; its stdout on success.
    async fn run(&self, args: &[&str], timeout: Duration) -> Result<String, AwsError> {
        let child = self.command(args).spawn().map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => AwsError::Missing,
            _ => AwsError::Failed(format!("couldn't start the AWS CLI: {e}")),
        })?;
        let out = tokio::time::timeout(timeout, child.wait_with_output())
            .await
            .map_err(|_| AwsError::TimedOut)?
            .map_err(|e| AwsError::Failed(format!("the AWS CLI failed: {e}")))?;
        if out.status.success() {
            return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
        }
        let stderr = String::from_utf8_lossy(&out.stderr);
        Err(if sso_expired(&stderr) { AwsError::SsoExpired } else { AwsError::Failed(cli_error(&stderr, out.status.code())) })
    }

    /// `aws <args> --profile P --region R --output json`.
    async fn json(&self, b: &Bedrock, args: &[&str]) -> Result<Value, AwsError> {
        let mut all = args.to_vec();
        all.extend(["--profile", &b.profile, "--region", &b.region, "--output", "json"]);
        let out = self.run(&all, AWS_TIMEOUT).await?;
        serde_json::from_str(&out).map_err(|_| AwsError::Failed("the AWS CLI's answer wasn't JSON".into()))
    }

    /// `aws sts get-caller-identity`: the account and ARN the profile signs in as.
    async fn caller_identity(&self, b: &Bedrock) -> Check {
        match self.json(b, &["sts", "get-caller-identity"]).await {
            Ok(v) => {
                let account = v["Account"].as_str().map(str::to_owned);
                let arn = v["Arn"].as_str().unwrap_or("?");
                Check {
                    ok: true,
                    detail: format!("Signed in as {arn} (account {}) in {}", account.as_deref().unwrap_or("?"), b.region),
                    identity: account,
                    action: None,
                }
            }
            Err(e) => e.check(&b.profile),
        }
    }

    /// Inference profiles plus on-demand text models. A model that has an
    /// inference profile is only offered through it (newer Claude models only
    /// run that way). Either listing may be refused alone (permissions).
    async fn models(&self, b: &Bedrock) -> Result<Vec<Model>, String> {
        let (profiles, foundation) = tokio::join!(
            self.json(b, &["bedrock", "list-inference-profiles"]),
            self.json(b, &["bedrock", "list-foundation-models", "--by-output-modality", "TEXT", "--by-inference-type", "ON_DEMAND"]),
        );
        let (profiles, foundation) = match (profiles, foundation) {
            (Err(e), _) | (_, Err(e)) if matches!(e, AwsError::Missing | AwsError::SsoExpired) => return Err(e.message(&b.profile)),
            (Err(e), Err(_)) => return Err(e.message(&b.profile)),
            (p, f) => (p.unwrap_or_default(), f.unwrap_or_default()),
        };
        Ok(bedrock_models(&profiles, &foundation, b.prefix.as_deref()))
    }
}

/// The models from `list-inference-profiles` and `list-foundation-models`.
fn bedrock_models(profiles: &Value, foundation: &Value, prefix: Option<&str>) -> Vec<Model> {
    let active = |v: &Value, path: &str| v.pointer(path).and_then(Value::as_str).is_none_or(|s| s == "ACTIVE");
    let mut out: Vec<Model> = profiles["inferenceProfileSummaries"]
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter(|p| active(p, "/status"))
        .filter_map(|p| {
            let id = p["inferenceProfileId"].as_str()?;
            let (geo, base) = id.split_once('.')?;
            if prefix.is_some_and(|want| want != geo) {
                return None;
            }
            Some(Model {
                id: id.to_owned(),
                label: p["inferenceProfileName"].as_str().unwrap_or(id).to_owned(),
                context_length: None,
                tools: bedrock_tools(base),
            })
        })
        .collect();
    let through_profiles: HashSet<String> = out.iter().filter_map(|m| m.id.split_once('.').map(|(_, base)| base.to_owned())).collect();
    let mut direct: Vec<Model> = foundation["modelSummaries"]
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter(|m| active(m, "/modelLifecycle/status"))
        .filter_map(|m| {
            let id = m["modelId"].as_str()?;
            if through_profiles.contains(id) {
                return None;
            }
            let name = m["modelName"].as_str().unwrap_or(id);
            let label = m["providerName"].as_str().map_or_else(|| name.to_owned(), |v| format!("{v} {name}"));
            Some(Model { id: id.to_owned(), label, context_length: None, tools: bedrock_tools(id) })
        })
        .collect();
    out.sort_by(|a, b| a.label.cmp(&b.label));
    direct.sort_by(|a, b| a.label.cmp(&b.label));
    out.extend(direct);
    out
}

/// Whether a Bedrock model (its id without a geography prefix) takes tool
/// calls through Converse. Bedrock doesn't say; these families don't.
fn bedrock_tools(base: &str) -> bool {
    const NO_TOOLS: &[&str] = &[
        "amazon.titan",
        "amazon.nova-sonic",
        "amazon.rerank",
        "anthropic.claude-v2",
        "anthropic.claude-instant",
        "meta.llama2",
        "meta.llama3-8b",
        "meta.llama3-70b",
        "meta.llama3-2-1b",
        "meta.llama3-2-3b",
        "mistral.mistral-7b",
        "mistral.mixtral",
        "cohere.command-text",
        "cohere.command-light",
        "cohere.embed",
        "cohere.rerank",
        "ai21.j2",
        "deepseek.r1",
    ];
    !NO_TOOLS.iter().any(|p| base.starts_with(p))
}

// ── ~/.aws/config and ~/.aws/credentials ────────────────────────────────────

/// Profile names (and regions, and whether they use SSO) from the AWS config
/// and credentials files. Only section headers and the `region` and `sso_*`
/// keys are looked at; credential values are never read out.
pub fn aws_profiles(config: &str, credentials: &str) -> Vec<AwsProfile> {
    let mut found: BTreeMap<String, AwsProfile> = BTreeMap::new();
    let mut current: Option<String> = None;
    for line in config.lines().map(str::trim) {
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some(header) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            let header = header.trim();
            // `[default]` and `[profile x]`; `[sso-session x]`, `[services x]` aren't profiles.
            current = match header.split_once(char::is_whitespace) {
                None if header == "default" => Some("default".to_owned()),
                Some(("profile", name)) if !name.trim().is_empty() => Some(name.trim().to_owned()),
                _ => None,
            };
            if let Some(name) = &current {
                found.entry(name.clone()).or_insert_with(|| AwsProfile { name: name.clone(), region: None, sso: false });
            }
            continue;
        }
        let (Some(name), Some((key, value))) = (&current, line.split_once('=')) else { continue };
        let Some(p) = found.get_mut(name) else { continue };
        match key.trim() {
            "region" => {
                let value = value.split([' ', '\t']).find(|v| !v.is_empty()).unwrap_or_default();
                p.region = Some(value.to_owned()).filter(|v| !v.is_empty());
            }
            "sso_session" | "sso_start_url" | "sso_account_id" | "sso_role_name" => p.sso = true,
            _ => {}
        }
    }
    for line in credentials.lines().map(str::trim) {
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')).map(str::trim).filter(|n| !n.is_empty()) {
            found.entry(name.to_owned()).or_insert_with(|| AwsProfile { name: name.to_owned(), region: None, sso: false });
        }
    }
    let mut out: Vec<AwsProfile> = found.into_values().collect();
    // `default` first, the rest by name.
    out.sort_by_key(|p| (p.name != "default", p.name.clone()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::integrations::tests::mock;
    use crate::keychain::Memory;
    use serde_json::json;
    use std::sync::atomic::Ordering;

    struct Fixture {
        store: Store,
        keychain: Arc<Memory>,
        dir: PathBuf,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn fixture(base: Option<String>, aws_path: Option<PathBuf>) -> Fixture {
        let dir = std::env::temp_dir().join(format!("yaah-providers-{}", crate::random::token()));
        std::fs::create_dir_all(&dir).unwrap();
        let keychain = Arc::new(Memory::default());
        let store = Store {
            file: JsonFile::new(dir.join("providers.json"), true),
            keychain: keychain.clone(),
            cache_dir: dir.join("cache"),
            base,
            aws: Aws { path: Some(aws_path.map_or_else(|| dir.join("no-bin").into_os_string(), PathBuf::into_os_string)) },
            aws_config: dir.join("aws/config"),
            aws_credentials: dir.join("aws/credentials"),
            sso_running: Mutex::default(),
        };
        Fixture { store, keychain, dir }
    }

    fn openrouter(label: &str, key: Option<&str>) -> Draft {
        Draft { id: None, kind: Kind::Openrouter, label: label.into(), bedrock: None, secret: key.map(SecretString::new) }
    }

    fn bedrock(label: &str, profile: &str, region: &str) -> Draft {
        Draft {
            id: None,
            kind: Kind::Bedrock,
            label: label.into(),
            bedrock: Some(Bedrock { profile: profile.into(), region: region.into(), prefix: None }),
            secret: None,
        }
    }

    fn raw_files(dir: &Path) -> String {
        let mut all = String::new();
        for entry in walk(dir) {
            all.push_str(&std::fs::read_to_string(entry).unwrap_or_default());
        }
        all
    }

    fn walk(dir: &Path) -> Vec<PathBuf> {
        let mut out = vec![];
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() { out.extend(walk(&p)) } else { out.push(p) }
        }
        out
    }

    #[test]
    fn the_store_round_trips_with_no_secret_in_json() {
        let f = fixture(None, None);
        let or = f.store.save(&openrouter("OpenRouter", Some("  sk-or-v1-secret  "))).unwrap();
        assert_eq!((or.id.as_str(), or.kind, or.has_secret), ("openrouter", Kind::Openrouter, true));
        let br = f.store.save(&bedrock("Work AWS", "work", "us-east-1")).unwrap();
        assert_eq!((br.id.as_str(), br.has_secret), ("work-aws", false));
        assert_eq!(br.summary, "Bedrock · us-east-1 · work");

        // On disk: 0600, the shape from the contract, and no secret anywhere.
        let path = f.dir.join("providers.json");
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("sk-or-v1-secret"), "{raw}");
        assert!(!raw.contains("secret") && !raw.contains("hasSecret"), "{raw}");
        let v: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["providers"][0], json!({ "id": "openrouter", "kind": "openrouter", "label": "OpenRouter" }));
        assert_eq!(v["providers"][1]["bedrock"], json!({ "profile": "work", "region": "us-east-1" }));
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert_eq!(f.keychain.accounts(), ["provider:openrouter"], "trimmed, under its own account");
        // The UI is never sent the secret.
        assert!(!serde_json::to_string(&f.store.list()).unwrap().contains("sk-or-v1-secret"));

        // The route gets it.
        let r = f.store.resolve("openrouter").unwrap();
        assert_eq!(r.secret.as_ref().map(SecretString::expose), Some("sk-or-v1-secret"));
        assert!(!format!("{r:?}").contains("sk-or-v1-secret"), "Debug is redacted");
        let r = f.store.resolve("work-aws").unwrap();
        assert!(r.secret.is_none());
        assert_eq!(r.bedrock.unwrap().profile, "work");
        assert!(f.store.resolve("nope").unwrap_err().contains("removed"));

        // An edit without a secret keeps the key and the last check; a new key replaces both.
        f.store
            .file
            .update(|file: &mut ProvidersFile| {
                file.providers[0].check = Some(Check { ok: true, detail: "ok".into(), identity: Some("main".into()), action: None });
                Ok(())
            })
            .unwrap();
        let edited = f.store.save(&Draft { id: Some("openrouter".into()), ..openrouter("OpenRouter (personal)", None) }).unwrap();
        assert_eq!((edited.label.as_str(), edited.has_secret, edited.check.is_some()), ("OpenRouter (personal)", true, true));
        assert_eq!(edited.summary, "OpenRouter · main");
        assert_eq!(f.store.resolve("openrouter").unwrap().secret.unwrap().expose(), "sk-or-v1-secret");
        let rekeyed = f.store.save(&Draft { id: Some("openrouter".into()), ..openrouter("OpenRouter", Some("sk-or-v1-new")) }).unwrap();
        assert!(rekeyed.check.is_none(), "a new key hasn't been checked");
        assert_eq!(f.store.resolve("openrouter").unwrap().secret.unwrap().expose(), "sk-or-v1-new");
        assert_eq!(f.store.list().len(), 2);
    }

    #[test]
    fn drafts_are_validated() {
        let f = fixture(None, None);
        assert!(f.store.save(&openrouter("OR", None)).unwrap_err().contains("API key"));
        assert!(f.store.save(&openrouter("OR", Some("   "))).unwrap_err().contains("API key"));
        assert!(f.store.save(&openrouter("  ", Some("k"))).is_err());
        assert!(f.store.save(&bedrock("B", "-x", "us-east-1")).unwrap_err().contains("profile"));
        assert!(f.store.save(&bedrock("B", "two words", "us-east-1")).is_err());
        for bad in ["", "us-east", "US-EAST-1", "us east 1", "us-east-1;"] {
            assert!(f.store.save(&bedrock("B", "work", bad)).unwrap_err().contains("region"), "{bad}");
        }
        let mut d = bedrock("B", "work", "eu-central-1");
        d.bedrock.as_mut().unwrap().prefix = Some("eu; rm".into());
        assert!(f.store.save(&d).is_err());
        d.bedrock.as_mut().unwrap().prefix = Some("eu".into());
        let b = f.store.save(&d).unwrap();
        assert_eq!(b.bedrock.unwrap().prefix.as_deref(), Some("eu"));
        assert!(f.store.save(&Draft { id: Some("b".into()), ..openrouter("B", Some("k")) }).unwrap_err().contains("kind"));
        assert!(f.store.save(&Draft { id: Some("missing".into()), ..openrouter("B", Some("k")) }).is_err());
        assert!(f.keychain.accounts().is_empty(), "nothing failed half-way into the keychain");
    }

    /// No Secret Service (headless Linux): a clear error, and the key isn't written anywhere else.
    #[test]
    fn an_unreachable_keychain_is_an_error_not_a_fallback() {
        let f = fixture(None, None);
        f.keychain.failing.store(true, Ordering::Relaxed);
        let err = f.store.save(&openrouter("OR", Some("sk-or-v1-secret"))).unwrap_err();
        assert!(err.contains("system keychain"), "{err}");
        assert_eq!(f.store.list(), []);
        assert!(!raw_files(&f.dir).contains("sk-or-v1-secret"));
        // Bedrock needs no keychain.
        f.store.save(&bedrock("B", "work", "us-east-1")).unwrap();
        assert!(f.store.resolve("b").is_ok());
    }

    fn bound(label: &str, provider: &str) -> Profile {
        let mut p = crate::agents::Draft { label: label.into(), preset: "goose".into(), command_line: "goose acp".into(), ..Default::default() }
            .to_profile(&[])
            .unwrap();
        p.provider = Some(Binding { provider_id: provider.into(), model: "m".into(), small_model: None });
        p
    }

    #[test]
    fn delete_is_refused_while_a_profile_is_bound() {
        let f = fixture(None, None);
        f.store.save(&openrouter("OR", Some("k"))).unwrap();
        std::fs::create_dir_all(f.dir.join("cache")).unwrap();
        std::fs::write(f.dir.join("cache/or.models.json"), "{}").unwrap();
        let profiles = [bound("Goose · OpenRouter", "or"), bound("OpenCode · OpenRouter", "or"), bound("Other", "elsewhere")];
        let err = f.store.delete("or", &profiles).unwrap_err();
        assert!(err.contains("Goose · OpenRouter, OpenCode · OpenRouter") && !err.contains("Other"), "{err}");
        assert_eq!(f.keychain.accounts(), ["provider:or"], "nothing removed");
        f.store.delete("or", &profiles[2..]).unwrap();
        assert!(f.store.list().is_empty() && f.keychain.accounts().is_empty());
        assert!(!f.dir.join("cache/or.models.json").exists(), "its cached models go too");
        assert!(f.store.delete("or", &[]).is_err());
    }

    /// OpenRouter against a local stand-in (`https://openrouter.ai/…` arrives as `/openrouter.ai/…`).
    #[tokio::test]
    async fn openrouter_key_check_and_models() {
        let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = hits.clone();
        let (base, seen) = mock(move |r| match r.path.as_str() {
            "/openrouter.ai/api/v1/key" if r.auth.as_deref() == Some("Bearer sk-or-good") => (
                200,
                json!({ "data": { "label": "sk-or-v1-abc...def", "limit": 20.0, "limit_remaining": 12.5, "usage": 7.5, "is_free_tier": false } }),
            ),
            "/openrouter.ai/api/v1/key" => (401, json!({ "error": { "message": "No auth credentials found", "code": 401 } })),
            "/openrouter.ai/api/v1/models" => {
                counted.fetch_add(1, Ordering::Relaxed);
                (
                    200,
                    json!({ "data": [
                        { "id": "anthropic/claude-sonnet-4.6", "name": "Anthropic: Claude Sonnet 4.6", "context_length": 1_000_000, "supported_parameters": ["tools", "max_tokens"] },
                        { "id": "openai/gpt-5.1", "name": "OpenAI: GPT-5.1", "context_length": 400_000, "supported_parameters": ["tools"] },
                        { "id": "qwen/qwen3-coder:free", "name": "Qwen3 Coder (free)", "supported_parameters": ["tools"] },
                        { "id": "some/no-tools", "name": "No tools", "supported_parameters": ["max_tokens"] }
                    ] }),
                )
            }
            _ => (404, json!({})),
        });
        let f = fixture(Some(base), None);
        f.store.save(&openrouter("OR", Some("sk-or-good"))).unwrap();
        let info = f.store.test("or").await.unwrap();
        let check = info.check.clone().unwrap();
        assert!(check.ok, "{check:?}");
        assert_eq!(check.detail, "Key \"sk-or-v1-abc...def\" works · $12.50 of $20.00 left");
        assert_eq!(info.summary, "OpenRouter · sk-or-v1-abc...def");
        assert!(info.checked_at.is_some() && f.store.get("or").unwrap().ready());

        // Models: tool-capable for Goose/OpenCode, Anthropic only for Claude.
        let goose = f.store.models("or", "goose", false).await.unwrap();
        let ids = |l: &ModelList| l.models.iter().map(|m| m.id.clone()).collect::<Vec<_>>();
        assert_eq!(ids(&goose), ["anthropic/claude-sonnet-4.6", "openai/gpt-5.1", "qwen/qwen3-coder:free"]);
        assert_eq!(goose.models[0].context_length, Some(1_000_000));
        assert_eq!(goose.models[0].label, "Anthropic: Claude Sonnet 4.6");
        let claude = f.store.models("or", crate::agents::CLAUDE, false).await.unwrap();
        assert_eq!(ids(&claude), ["anthropic/claude-sonnet-4.6"]);
        assert_eq!(hits.load(Ordering::Relaxed), 1, "the second listing came from the day's cache");
        assert_eq!(claude.cached_at, goose.cached_at);
        assert!(seen.lock().unwrap().iter().any(|s| s.starts_with("/openrouter.ai/api/v1/models?supported_parameters=tools")));
        f.store.models("or", "opencode", true).await.unwrap();
        assert_eq!(hits.load(Ordering::Relaxed), 2, "refresh skips the cache");
        assert!(!raw_files(&f.dir).contains("sk-or-good"), "the cache holds no key");

        // A new key: the check is cleared, and a bad one fails.
        f.store.save(&Draft { id: Some("or".into()), ..openrouter("OR", Some("sk-or-bad")) }).unwrap();
        let info = f.store.test("or").await.unwrap();
        let check = info.check.unwrap();
        assert!(!check.ok && check.detail.contains("refused the key (401)"), "{check:?}");
        assert!(!f.store.get("or").unwrap().ready());
    }

    /// A stand-in `aws`: only shell built-ins, on a PATH of its own. It records its arguments.
    fn fake_aws(dir: &Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let script = format!("#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"${{0%/*}}/calls\"\n{body}\n");
        std::fs::write(bin.join("aws"), script).unwrap();
        std::fs::set_permissions(bin.join("aws"), std::fs::Permissions::from_mode(0o755)).unwrap();
        bin
    }

    fn calls(bin: &Path) -> Vec<String> {
        std::fs::read_to_string(bin.join("calls")).unwrap_or_default().lines().map(str::to_owned).collect()
    }

    /// With a `sso-required` file beside it, every call but `sso login` fails as
    /// an expired SSO login until `sso login` has run.
    const FAKE_AWS: &str = r#"
if [ "$1" != sso ] && [ -f "${0%/*}/sso-required" ] && [ ! -f "${0%/*}/logged-in" ]; then
  printf '%s\n' "Error when retrieving token from sso: Token has expired and refresh failed" >&2; exit 255
fi
case "$1 $2" in
  "sts get-caller-identity")
    printf '%s' '{"UserId":"AROA:ada","Account":"123456789012","Arn":"arn:aws:sts::123456789012:assumed-role/Dev/ada"}' ;;
  "sso login") : > "${0%/*}/logged-in"; printf 'Successfully logged into Start URL' ;;
  "bedrock list-inference-profiles")
    printf '%s' '{"inferenceProfileSummaries":[
      {"inferenceProfileId":"us.anthropic.claude-sonnet-4-6","inferenceProfileName":"US Anthropic Claude Sonnet 4.6","status":"ACTIVE","type":"SYSTEM_DEFINED"},
      {"inferenceProfileId":"global.anthropic.claude-sonnet-4-6","inferenceProfileName":"Global Anthropic Claude Sonnet 4.6","status":"ACTIVE"},
      {"inferenceProfileId":"us.amazon.nova-pro-v1:0","inferenceProfileName":"US Nova Pro","status":"ACTIVE"},
      {"inferenceProfileId":"us.meta.llama3-2-1b-instruct-v1:0","inferenceProfileName":"US Llama 3.2 1B","status":"ACTIVE"}
    ]}' ;;
  "bedrock list-foundation-models")
    printf '%s' '{"modelSummaries":[
      {"modelId":"anthropic.claude-sonnet-4-6","modelName":"Claude Sonnet 4.6","providerName":"Anthropic","modelLifecycle":{"status":"ACTIVE"}},
      {"modelId":"anthropic.claude-3-haiku-20240307-v1:0","modelName":"Claude 3 Haiku","providerName":"Anthropic","modelLifecycle":{"status":"ACTIVE"}},
      {"modelId":"amazon.titan-text-express-v1","modelName":"Titan Text G1 - Express","providerName":"Amazon","modelLifecycle":{"status":"ACTIVE"}},
      {"modelId":"mistral.mistral-large-2402-v1:0","modelName":"Mistral Large","providerName":"Mistral AI","modelLifecycle":{"status":"ACTIVE"}},
      {"modelId":"anthropic.claude-v2","modelName":"Claude","providerName":"Anthropic","modelLifecycle":{"status":"LEGACY"}}
    ]}' ;;
  *) printf 'unknown command\n' >&2; exit 2 ;;
esac"#;

    #[tokio::test]
    async fn bedrock_through_the_aws_cli() {
        let dir = std::env::temp_dir().join(format!("yaah-aws-{}", crate::random::token()));
        let bin = fake_aws(&dir, FAKE_AWS);
        let f = fixture(None, Some(bin.clone()));
        f.store.save(&bedrock("Work", "work", "us-east-1")).unwrap();

        let info = f.store.test("work").await.unwrap();
        let check = info.check.unwrap();
        assert!(check.ok, "{check:?}");
        assert_eq!(check.identity.as_deref(), Some("123456789012"));
        assert!(check.detail.contains("arn:aws:sts::123456789012:assumed-role/Dev/ada"), "{}", check.detail);
        assert_eq!(calls(&bin), ["sts get-caller-identity --profile work --region us-east-1 --output json"]);

        // Claude: Anthropic only, inference profiles first; a model with a profile isn't offered bare.
        let claude = f.store.models("work", crate::agents::CLAUDE, false).await.unwrap();
        let ids: Vec<&str> = claude.models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["global.anthropic.claude-sonnet-4-6", "us.anthropic.claude-sonnet-4-6", "anthropic.claude-3-haiku-20240307-v1:0"]);
        let all = calls(&bin);
        assert!(all.contains(&"bedrock list-inference-profiles --profile work --region us-east-1 --output json".to_owned()), "{all:?}");
        assert!(
            all.contains(
                &"bedrock list-foundation-models --by-output-modality TEXT --by-inference-type ON_DEMAND --profile work --region us-east-1 --output json"
                    .to_owned()
            ),
            "{all:?}"
        );
        // Goose: anything that takes tools (no Titan text, no Llama 3.2 1B, nothing legacy).
        let goose = f.store.models("work", "goose", false).await.unwrap();
        let ids: Vec<&str> = goose.models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "global.anthropic.claude-sonnet-4-6",
                "us.anthropic.claude-sonnet-4-6",
                "us.amazon.nova-pro-v1:0",
                "anthropic.claude-3-haiku-20240307-v1:0",
                "mistral.mistral-large-2402-v1:0"
            ]
        );
        assert_eq!(goose.models[3].label, "Anthropic Claude 3 Haiku");

        // A prefix keeps that geography's profiles only (and invalidates the cache).
        let mut d = bedrock("Work", "work", "us-east-1");
        d.id = Some("work".into());
        d.bedrock.as_mut().unwrap().prefix = Some("us".into());
        f.store.save(&d).unwrap();
        let us = f.store.models("work", crate::agents::CLAUDE, false).await.unwrap();
        assert_eq!(us.models[0].id, "us.anthropic.claude-sonnet-4-6");
        assert!(us.models.iter().all(|m| !m.id.starts_with("global.")));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn an_expired_sso_login_offers_aws_sso_login() {
        let dir = std::env::temp_dir().join(format!("yaah-aws-sso-{}", crate::random::token()));
        let bin = fake_aws(&dir, FAKE_AWS);
        // Expired until `aws sso login` runs.
        std::fs::write(bin.join("sso-required"), "").unwrap();
        let f = fixture(None, Some(bin.clone()));
        f.store.save(&bedrock("Work", "work-sso", "eu-west-1")).unwrap();

        let check = f.store.test("work").await.unwrap().check.unwrap();
        assert!(!check.ok);
        assert_eq!(check.action.as_deref(), Some(SSO_LOGIN));
        assert!(check.detail.contains("Run `aws sso login --profile work-sso`"), "{}", check.detail);
        let err = f.store.models("work", "goose", false).await.unwrap_err();
        assert!(err.contains("aws sso login --profile work-sso"), "{err}");

        let info = f.store.sso_login("work").await.unwrap();
        assert!(info.check.unwrap().ok, "tested again after the login");
        assert!(calls(&bin).contains(&"sso login --profile work-sso".to_owned()));
        assert!(f.store.sso_running.lock().unwrap().is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn a_missing_aws_cli_says_how_to_install_it() {
        let f = fixture(None, None);
        f.store.save(&bedrock("Work", "work", "us-east-1")).unwrap();
        let check = f.store.test("work").await.unwrap().check.unwrap();
        assert!(!check.ok && check.action.is_none());
        assert!(check.detail.contains("Install AWS CLI v2"), "{}", check.detail);
        assert!(f.store.models("work", "goose", false).await.unwrap_err().contains("Install AWS CLI v2"));
        assert!(f.store.sso_login("work").await.unwrap_err().contains("Install AWS CLI v2"));
    }

    #[tokio::test]
    async fn other_cli_failures_are_reported_short() {
        let dir = std::env::temp_dir().join(format!("yaah-aws-fail-{}", crate::random::token()));
        let bin = fake_aws(
            &dir,
            r#"printf '\n%s\n' "An error occurred (AccessDenied) when calling the GetCallerIdentity operation: not allowed" >&2; exit 254"#,
        );
        let f = fixture(None, Some(bin));
        f.store.save(&bedrock("Work", "work", "us-east-1")).unwrap();
        let check = f.store.test("work").await.unwrap().check.unwrap();
        assert_eq!(check.detail, "An error occurred (AccessDenied) when calling the GetCallerIdentity operation: not allowed");
        assert!(check.action.is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn sso_errors_are_recognised() {
        for e in [
            "Error when retrieving token from sso: Token has expired and refresh failed",
            "The SSO session associated with this profile has expired or is otherwise invalid. To refresh this SSO session run aws sso login with the corresponding profile.",
            "Error loading SSO Token: Token for my-sso does not exist",
        ] {
            assert!(sso_expired(e), "{e}");
        }
        assert!(!sso_expired(
            "An error occurred (ExpiredToken) when calling the GetCallerIdentity operation: The security token included in the request is expired"
        ));
        assert!(!sso_expired("The config profile (nope) could not be found"));
    }

    #[test]
    fn aws_config_files_give_names_regions_and_sso_only() {
        let config = r"
# a comment
[default]
region = us-east-1
output = json

[profile work-sso]
sso_session = corp
sso_account_id = 123456789012
sso_role_name = Dev
region = eu-west-1   # inline note

[sso-session corp]
sso_start_url = https://corp.awsapps.com/start
sso_region = eu-west-1

[profile legacy-sso]
sso_start_url = https://old.awsapps.com/start

[services local]
bedrock-runtime =
  endpoint_url = http://localhost:4566

[profile keys]
aws_access_key_id = AKIAEXAMPLE
aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
";
        let credentials = "[default]\naws_access_key_id = AKIAOTHER\naws_secret_access_key = topsecret\n\n[only-creds]\naws_access_key_id = AKIA2\n";
        let profiles = aws_profiles(config, credentials);
        let p = |name: &str, region: Option<&str>, sso: bool| AwsProfile { name: name.into(), region: region.map(str::to_owned), sso };
        assert_eq!(
            profiles,
            [
                p("default", Some("us-east-1"), false),
                p("keys", None, false),
                p("legacy-sso", None, true),
                p("only-creds", None, false),
                p("work-sso", Some("eu-west-1"), true),
            ]
        );
        let json = serde_json::to_string(&profiles).unwrap();
        for secret in ["AKIA", "wJalr", "topsecret", "awsapps", "corp"] {
            assert!(!json.contains(secret), "{secret} in {json}");
        }
        assert_eq!(aws_profiles("", ""), []);
    }

    #[test]
    fn aws_profiles_reads_the_configured_files() {
        let f = fixture(None, None);
        std::fs::create_dir_all(f.dir.join("aws")).unwrap();
        std::fs::write(f.dir.join("aws/config"), "[profile a]\nregion = ap-southeast-2\n").unwrap();
        assert_eq!(f.store.aws_profiles(), [AwsProfile { name: "a".into(), region: Some("ap-southeast-2".into()), sso: false }]);
    }

    #[test]
    fn model_filters() {
        assert!(is_anthropic("anthropic/claude-opus-4.1") && is_anthropic("us.anthropic.claude-x") && is_anthropic("anthropic.claude-3"));
        assert!(!is_anthropic("openai/gpt-5") && !is_anthropic("us.amazon.nova-pro-v1:0") && !is_anthropic("meta.anthropic-lookalike.x.y"));
        assert!(bedrock_tools("amazon.nova-pro-v1:0") && !bedrock_tools("amazon.titan-text-lite-v1") && !bedrock_tools("deepseek.r1-v1:0"));
    }
}
