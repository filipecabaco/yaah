//! Per-agent translation of a model-provider binding (`providers::Binding`)
//! into how that agent is started: environment, inherited variables to drop,
//! files in the profile's own folder and, for Claude Code, an ACP
//! `providers/set` call. See `docs/research/model-providers-contract.md`.
//!
//! [`route`] is pure: it gets the resolved provider (secret included), the
//! binding and the profile's folder, and says what to do. [`for_profile`]
//! resolves the binding at spawn (`agents::spawn`); nothing here is ever
//! written into `Profile.env`.
//!
//! - **Secrets** go only to the process that needs them: the OpenRouter key is
//!   set for an OpenRouter route and dropped from what a Bedrock route inherits.
//!   A Bedrock route carries no secret at all, only the AWS profile name and
//!   region (the agent's AWS SDK finds the credentials, SSO included).
//! - Nothing secret ever goes in argv, and [`Route`]'s `Debug` redacts it.
//! - Presets without a route ([`unsupported`]) say why, and the UI shows it.
//!
//! | agent | Bedrock | OpenRouter |
//! |---|---|---|
//! | goose | `GOOSE_PROVIDER=aws_bedrock`, `GOOSE_MODEL`, `AWS_PROFILE`, `AWS_REGION` | `GOOSE_PROVIDER=openrouter`, `GOOSE_MODEL`, `OPENROUTER_API_KEY` |
//! | OpenCode 2 | `OPENCODE_CONFIG_CONTENT` (`amazon-bedrock` with profile and region), `AWS_PROFILE`, `AWS_REGION` | `OPENCODE_CONFIG_CONTENT` (`openrouter`, attribution headers), `OPENROUTER_API_KEY` |
//! | Claude Code | `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_PROFILE`, `AWS_REGION`, model env | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY=""`, model env (or `providers/set`) |

use crate::agents::{self, Profile};
use crate::providers::{Binding, Kind, ResolvedProvider};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

/// OpenRouter's OpenAI-compatible API. Each agent derives its own base from it.
pub const OPENROUTER_API: &str = "https://openrouter.ai/api/v1";
/// OpenRouter's app attribution, sent where the agent takes custom headers (Claude Code, OpenCode; goose sends its own).
pub const ATTRIBUTION: [(&str, &str); 2] = [("HTTP-Referer", "https://filipecabaco.github.io/yaah/"), ("X-OpenRouter-Title", "yaah")];
/// The provider id claude-agent-acp's `providers/list` reports (its only one).
pub const CLAUDE_PROVIDER_ID: &str = "main";
/// Bedrock's cross-region inference profile geographies (`us.anthropic.…`).
const GEOGRAPHIES: &[&str] = &["us", "us-gov", "eu", "apac", "global", "jp", "au", "ca"];

/// The presets that have a route.
pub const SUPPORTED: &[&str] = &[agents::CLAUDE, "goose", "opencode"];

// ── How Claude Code reaches OpenRouter ──────────────────────────────────────

/// Claude Code reaches OpenRouter through env vars, or through ACP's
/// `providers/set` when the adapter advertises `agentCapabilities.providers`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaudeOpenRouter {
    Env,
    ProvidersSet,
}

/// The default: env. Checked on the conformance stub with claude-agent-acp
/// 0.99.1 (`examples/conformance.rs`, the `prov-set` row), `providers/set`
/// doesn't work for OpenRouter yet: the model calls carry the adapter's
/// placeholder `Bearer acp-proxy`, not our `Authorization` header, and the
/// headers (key included) reach the Claude CLI's command line as
/// `ANTHROPIC_CUSTOM_HEADERS` in its settings argument. Switch only once that
/// row passes.
pub const CLAUDE_OPENROUTER: ClaudeOpenRouter = ClaudeOpenRouter::Env;

static CLAUDE_VIA_PROVIDERS_SET: AtomicBool = AtomicBool::new(matches!(CLAUDE_OPENROUTER, ClaudeOpenRouter::ProvidersSet));

/// Switch how Claude Code profiles bound to OpenRouter start from now on (tests, a future setting).
pub fn set_claude_openrouter(via: ClaudeOpenRouter) {
    CLAUDE_VIA_PROVIDERS_SET.store(via == ClaudeOpenRouter::ProvidersSet, Ordering::Relaxed);
}

pub fn claude_openrouter() -> ClaudeOpenRouter {
    if CLAUDE_VIA_PROVIDERS_SET.load(Ordering::Relaxed) { ClaudeOpenRouter::ProvidersSet } else { ClaudeOpenRouter::Env }
}

// ── Routes ──────────────────────────────────────────────────────────────────

/// Where each provider's API is. Real by default; the conformance suite points them at its stub.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoints {
    /// OpenRouter's OpenAI-compatible base (`…/api/v1`).
    pub openrouter: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self { openrouter: OPENROUTER_API.to_owned() }
    }
}

impl Endpoints {
    /// The origin goose appends `api/v1/…` to.
    fn openrouter_host(&self) -> &str {
        self.openrouter.trim_end_matches('/').trim_end_matches("/v1").trim_end_matches("/api")
    }

    /// The Anthropic-style base Claude Code appends `/v1/messages` to (`…/api`).
    fn openrouter_anthropic(&self) -> &str {
        self.openrouter.trim_end_matches('/').trim_end_matches("/v1")
    }
}

/// How to start one agent on a provider.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct Route {
    /// Set in the agent's environment (after the profile's own env: the binding wins).
    pub env: BTreeMap<String, String>,
    /// Dropped from what it inherits from yaah, before `env` is applied.
    pub env_remove: BTreeSet<String>,
    /// Written before it starts: (path inside the profile's folder, contents).
    pub files: Vec<(PathBuf, String)>,
    /// Params for ACP `providers/set`, sent after `initialize` when the agent advertises `providers`.
    pub providers_set: Option<Value>,
    /// Which `env` values are secret (redacted in `Debug`).
    secrets: BTreeSet<String>,
}

impl Route {
    fn set(&mut self, k: &str, v: impl Into<String>) {
        self.env.insert(k.to_owned(), v.into());
    }

    fn secret(&mut self, k: &str, v: &str) {
        self.set(k, v);
        self.secrets.insert(k.to_owned());
    }

    fn remove(&mut self, keys: &[&str]) {
        self.env_remove.extend(keys.iter().map(|k| (*k).to_owned()));
    }

    /// The names of the variables that hold a secret.
    pub fn secret_vars(&self) -> &BTreeSet<String> {
        &self.secrets
    }

    /// The secret values this route hands the agent (env and `providers/set`), to check none leaks.
    pub fn secret_values(&self) -> Vec<&str> {
        let mut out: Vec<&str> = self.secrets.iter().filter_map(|k| self.env.get(k)).map(String::as_str).collect();
        if let Some(auth) = self.providers_set.as_ref().and_then(|p| p["headers"]["Authorization"].as_str()) {
            out.push(auth.trim_start_matches("Bearer "));
        }
        out
    }

    /// Write [`Self::files`] (folders 0700, files 0600: they're the agent's own config).
    pub fn write_files(&self) -> Result<(), String> {
        for (path, body) in &self.files {
            if let Some(parent) = path.parent() {
                create_private_dir(parent)?;
            }
            write_private(path, body.as_bytes()).map_err(|e| format!("can't write {}: {e}", path.display()))?;
        }
        Ok(())
    }
}

/// Replace `path` with `bytes`, mode 0600, never through a planted link.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let tmp = path.with_extension(format!("tmp-{}", crate::random::token()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let written = options.open(&tmp).and_then(|mut f| f.write_all(bytes)).and_then(|()| std::fs::rename(&tmp, path));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

#[cfg(unix)]
fn create_private_dir(dir: &Path) -> Result<(), String> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir).map_err(|e| format!("can't create {}: {e}", dir.display()))
}

#[cfg(not(unix))]
fn create_private_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("can't create {}: {e}", dir.display()))
}

impl std::fmt::Debug for Route {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let env: BTreeMap<&str, &str> =
            self.env.iter().map(|(k, v)| (k.as_str(), if self.secrets.contains(k) { "<redacted>" } else { v.as_str() })).collect();
        let set = self.providers_set.as_ref().map(|p| {
            let mut p = p.clone();
            if p["headers"]["Authorization"].is_string() {
                p["headers"]["Authorization"] = json!("<redacted>");
            }
            p
        });
        f.debug_struct("Route")
            .field("env", &env)
            .field("env_remove", &self.env_remove)
            .field("files", &self.files.iter().map(|(p, _)| p).collect::<Vec<_>>())
            .field("providers_set", &set)
            .finish()
    }
}

/// Why a binding can't run: shown as is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unsupported(pub String);

impl std::fmt::Display for Unsupported {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Why `preset` can't run on a model provider, or `None` when it can.
pub fn unsupported(preset: &str) -> Option<String> {
    if SUPPORTED.contains(&preset) {
        return None;
    }
    let name = agents::preset(preset).map_or("A custom agent", |p| p.label);
    Some(format!("{name} can't run on a model provider through yaah yet. Claude Code, goose and OpenCode can."))
}

/// The model providers `preset` can run on (`providers::Kind` names), for the UI: empty when it has no route.
pub fn providers(preset: &str) -> Vec<&'static str> {
    if unsupported(preset).is_none() { vec!["openrouter", "bedrock"] } else { vec![] }
}

/// The agent's own folder for a profile: `~/.yaah/profiles/<id>` (goose's root, OpenCode's config and data).
pub fn profile_dir(profile_id: &str) -> PathBuf {
    let safe = !profile_id.is_empty()
        && profile_id.len() <= 100
        && !profile_id.starts_with('.')
        && profile_id.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    let name = if safe {
        profile_id.to_owned()
    } else {
        use sha2::{Digest, Sha256};
        format!("{:x}", Sha256::digest(profile_id.as_bytes()))
    };
    crate::accounts::home().join(".yaah/profiles").join(name)
}

/// What a route depends on besides the binding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Options {
    pub endpoints: Endpoints,
    pub claude_openrouter: ClaudeOpenRouter,
}

impl Options {
    /// The real endpoints (or the ones [`set_endpoints`] gave) and [`claude_openrouter`].
    pub fn current() -> Self {
        let endpoints = ENDPOINTS.lock().unwrap_or_else(PoisonError::into_inner).clone().unwrap_or_default();
        Self { endpoints, claude_openrouter: claude_openrouter() }
    }
}

impl Default for Options {
    fn default() -> Self {
        Self { endpoints: Endpoints::default(), claude_openrouter: CLAUDE_OPENROUTER }
    }
}

/// How `preset` starts on `provider` with `binding`'s models, its own files under `profile_dir`.
pub fn route(preset: &str, provider: &ResolvedProvider, binding: &Binding, profile_dir: &Path) -> Result<Route, Unsupported> {
    route_with(preset, provider, binding, profile_dir, &Options::current())
}

/// [`route`] with explicit [`Options`].
pub fn route_with(preset: &str, provider: &ResolvedProvider, binding: &Binding, profile_dir: &Path, opts: &Options) -> Result<Route, Unsupported> {
    let endpoints = &opts.endpoints;
    if let Some(why) = unsupported(preset) {
        return Err(Unsupported(why));
    }
    let model = binding.model.trim();
    if model.is_empty() {
        return Err(Unsupported(format!("choose a model for {}", provider.label)));
    }
    let target = match provider.kind {
        Kind::Openrouter => {
            let key = provider.secret.as_ref().map(crate::keychain::SecretString::expose).filter(|k| !k.is_empty());
            Target::OpenRouter {
                key: key.ok_or_else(|| Unsupported(format!("\"{}\" has no API key; add it in Settings → Model providers", provider.label)))?,
            }
        }
        Kind::Bedrock => {
            let b = provider.bedrock.as_ref().ok_or_else(|| Unsupported(format!("\"{}\" has no AWS profile and region", provider.label)))?;
            if b.profile.trim().is_empty() || b.region.trim().is_empty() {
                return Err(Unsupported(format!("\"{}\" needs an AWS profile and a region", provider.label)));
            }
            Target::Bedrock {
                profile: b.profile.trim(),
                region: b.region.trim(),
                prefix: b.prefix.as_deref().map(str::trim).filter(|p| !p.is_empty()),
            }
        }
    };
    let small = binding.small_model.as_deref().map(str::trim).filter(|m| !m.is_empty());
    let mut r = Route::default();
    match preset {
        "goose" => goose(&mut r, &target, model, profile_dir, endpoints),
        "opencode" => opencode(&mut r, &target, model, small, profile_dir, endpoints),
        _ => claude(&mut r, &target, model, small, endpoints, opts.claude_openrouter),
    }
    Ok(r)
}

enum Target<'a> {
    OpenRouter { key: &'a str },
    Bedrock { profile: &'a str, region: &'a str, prefix: Option<&'a str> },
}

/// Inherited credentials that would beat an AWS profile in the AWS SDK's chain, or bypass it.
const AWS_OVERRIDES: &[&str] =
    &["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "AWS_DEFAULT_PROFILE"];

impl Target<'_> {
    /// The AWS part every Bedrock route shares: the profile, the region, nothing that overrides them, and no OpenRouter key.
    fn aws(&self, r: &mut Route) {
        if let Target::Bedrock { profile, region, .. } = self {
            r.set("AWS_PROFILE", *profile);
            r.set("AWS_REGION", *region);
            r.remove(AWS_OVERRIDES);
            r.remove(&["OPENROUTER_API_KEY"]);
        }
    }

    /// A Bedrock model id with the provider's geography, unless it has one (or is an ARN).
    fn bedrock_model(&self, model: &str) -> String {
        match self {
            Target::Bedrock { prefix: Some(prefix), .. }
                if !model.starts_with("arn:") && !GEOGRAPHIES.iter().any(|g| model.starts_with(&format!("{g}."))) =>
            {
                format!("{prefix}.{model}")
            }
            _ => model.to_owned(),
        }
    }
}

fn goose(r: &mut Route, target: &Target<'_>, model: &str, dir: &Path, endpoints: &Endpoints) {
    // Its config, secrets and sessions in the profile's folder; no OS keychain (the key comes in the env).
    r.set("GOOSE_PATH_ROOT", dir.to_string_lossy());
    r.set("GOOSE_DISABLE_KEYRING", "1");
    match target {
        Target::OpenRouter { key } => {
            r.set("GOOSE_PROVIDER", "openrouter");
            r.set("GOOSE_MODEL", model);
            r.secret("OPENROUTER_API_KEY", key);
            if endpoints.openrouter == OPENROUTER_API {
                r.remove(&["OPENROUTER_HOST"]);
            } else {
                r.set("OPENROUTER_HOST", endpoints.openrouter_host());
            }
        }
        Target::Bedrock { .. } => {
            r.set("GOOSE_PROVIDER", "aws_bedrock");
            // goose doesn't add the geography itself.
            r.set("GOOSE_MODEL", target.bedrock_model(model));
            target.aws(r);
        }
    }
}

fn opencode(r: &mut Route, target: &Target<'_>, model: &str, small: Option<&str>, dir: &Path, endpoints: &Endpoints) {
    // OpenCode 2's `providers` config (OPENCODE_CONFIG_CONTENT ranks above every file but managed settings).
    // Its own config and data folders, so a credential saved with `opencode auth` can't win over the binding.
    r.set("OPENCODE_CONFIG_DIR", dir.join("config").to_string_lossy());
    r.set("XDG_DATA_HOME", dir.join("data").to_string_lossy());
    let headers: serde_json::Map<String, Value> = ATTRIBUTION.iter().map(|(k, v)| ((*k).to_owned(), json!(v))).collect();
    let config = match target {
        Target::OpenRouter { key } => {
            r.secret("OPENROUTER_API_KEY", key);
            // The key is in the env: a project's opencode.json mustn't be able to point a provider elsewhere.
            r.set("OPENCODE_DISABLE_PROJECT_CONFIG", "1");
            json!({
                "model": format!("openrouter/{model}"),
                // Titles on the binding's small model (else its model), never OpenCode's own pick for the provider.
                "agents": { "title": { "model": format!("openrouter/{}", small.unwrap_or(model)) } },
                "providers": { "openrouter": {
                    "settings": { "baseURL": endpoints.openrouter },
                    "headers": headers,
                    "models": models(&[model, small.unwrap_or(model)])
                } }
            })
        }
        Target::Bedrock { profile, region, .. } => {
            target.aws(r);
            let (model, small) = (target.bedrock_model(model), target.bedrock_model(small.unwrap_or(model)));
            json!({
                "model": format!("amazon-bedrock/{model}"),
                "agents": { "title": { "model": format!("amazon-bedrock/{small}") } },
                "providers": { "amazon-bedrock": {
                    "settings": { "profile": profile, "region": region },
                    "models": models(&[&model, &small])
                } }
            })
        }
    };
    r.set("OPENCODE_CONFIG_CONTENT", config.to_string());
}

/// OpenCode `models` entries for these ids (declared, so ids its catalog lacks still resolve).
fn models(ids: &[&str]) -> Value {
    Value::Object(ids.iter().map(|id| ((*id).to_owned(), json!({}))).collect())
}

fn claude(r: &mut Route, target: &Target<'_>, model: &str, small: Option<&str>, endpoints: &Endpoints, via: ClaudeOpenRouter) {
    let model_env = |r: &mut Route, model: &str, small: &str| {
        r.set("ANTHROPIC_MODEL", model);
        // The aliases the model picker offers stay on the provider.
        r.set("ANTHROPIC_DEFAULT_OPUS_MODEL", model);
        r.set("ANTHROPIC_DEFAULT_SONNET_MODEL", model);
        r.set("ANTHROPIC_DEFAULT_HAIKU_MODEL", small);
    };
    match target {
        Target::Bedrock { .. } => {
            r.set("CLAUDE_CODE_USE_BEDROCK", "1");
            target.aws(r);
            r.remove(&["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_BEDROCK_BASE_URL", "CLAUDE_CODE_USE_VERTEX"]);
            let model = target.bedrock_model(model);
            let small = small.map_or_else(|| model.clone(), |s| target.bedrock_model(s));
            model_env(r, &model, &small);
        }
        Target::OpenRouter { key } => {
            r.remove(&["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_BEDROCK_BASE_URL", "AWS_BEARER_TOKEN_BEDROCK"]);
            model_env(r, model, small.unwrap_or(model));
            let base = endpoints.openrouter_anthropic();
            match via {
                ClaudeOpenRouter::Env => {
                    r.set("ANTHROPIC_BASE_URL", base);
                    r.secret("ANTHROPIC_AUTH_TOKEN", key);
                    // Empty, as OpenRouter documents: an inherited key would win over the token.
                    r.set("ANTHROPIC_API_KEY", "");
                    r.set("ANTHROPIC_CUSTOM_HEADERS", ATTRIBUTION.iter().map(|(k, v)| format!("{k}: {v}")).collect::<Vec<_>>().join("\n"));
                }
                ClaudeOpenRouter::ProvidersSet => {
                    // The key goes over ACP only: never in the env the agent (and its shell) can read.
                    r.remove(&["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]);
                    let mut headers = serde_json::Map::new();
                    headers.insert("Authorization".into(), json!(format!("Bearer {key}")));
                    headers.extend(ATTRIBUTION.iter().map(|(k, v)| ((*k).to_owned(), json!(v))));
                    r.providers_set = Some(json!({ "providerId": CLAUDE_PROVIDER_ID, "apiType": "anthropic", "baseUrl": base, "headers": headers }));
                }
            }
        }
    }
}

// ── At spawn ────────────────────────────────────────────────────────────────

type Resolver = Arc<dyn Fn(&str) -> Result<ResolvedProvider, String> + Send + Sync>;

static RESOLVER: Mutex<Option<Resolver>> = Mutex::new(None);
static ENDPOINTS: Mutex<Option<Endpoints>> = Mutex::new(None);

/// Resolve bindings with `f` instead of the provider store (the end-to-end tests' providers).
pub fn set_resolver(f: Option<Resolver>) {
    *RESOLVER.lock().unwrap_or_else(PoisonError::into_inner) = f;
}

/// Point routes at other endpoints (a local stub), or back at the real ones with `None`.
pub fn set_endpoints(e: Option<Endpoints>) {
    *ENDPOINTS.lock().unwrap_or_else(PoisonError::into_inner) = e;
}

fn resolve(id: &str) -> Result<ResolvedProvider, String> {
    let custom = RESOLVER.lock().unwrap_or_else(PoisonError::into_inner).clone();
    match custom {
        Some(f) => f(id),
        None => crate::providers::resolve(id),
    }
}

/// The route of a profile bound to a provider (`None` when it isn't), with the
/// provider and its secret read now. An error says why it can't start.
pub fn for_profile(profile: &Profile) -> Result<Option<Route>, String> {
    let Some(binding) = &profile.provider else { return Ok(None) };
    if let Some(why) = unsupported(&profile.preset) {
        return Err(why);
    }
    let provider = resolve(&binding.provider_id)?;
    route(&profile.preset, &provider, binding, &profile_dir(&profile.id)).map(Some).map_err(|u| u.0)
}

/// How long the agent gets to apply `providers/set` (claude-agent-acp lists the gateway's models first).
pub const PROVIDERS_SET_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Send the route's `providers/set` after `initialize` (`init` is its result),
/// before any `session/new`. Nothing to do without one. The agent must
/// advertise `agentCapabilities.providers`; the params (they hold the key) are
/// never logged or put in an error.
pub async fn providers_set(conn: &crate::acp::Connection, init: &Value, route: Option<&Route>) -> Result<(), String> {
    let Some(params) = route.and_then(|r| r.providers_set.clone()) else { return Ok(()) };
    if init.pointer("/agentCapabilities/providers").is_none_or(Value::is_null) {
        return Err("this agent version doesn't take a model provider over ACP (no `providers` capability); update it, or use the env route".into());
    }
    match tokio::time::timeout(PROVIDERS_SET_TIMEOUT, conn.request("providers/set", params)).await {
        Err(_) => Err(format!("the agent didn't apply the model provider within {PROVIDERS_SET_TIMEOUT:?}")),
        // The agent's message may quote what it was sent: only its code and first line go further.
        Ok(Err(e)) => {
            Err(format!("the agent refused the model provider (code {}): {}", e.code, redact(e.message.lines().next().unwrap_or_default(), route)))
        }
        Ok(Ok(_)) => Ok(()),
    }
}

/// `text` with any of the route's secrets blanked out.
fn redact(text: &str, route: Option<&Route>) -> String {
    route.into_iter().flat_map(Route::secret_values).filter(|s| !s.is_empty()).fold(text.to_owned(), |t, s| t.replace(s, "<redacted>"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keychain::SecretString;
    use crate::providers::Bedrock;

    const KEY: &str = "sk-or-v1-secret-key-for-tests";

    fn openrouter() -> ResolvedProvider {
        ResolvedProvider { id: "or".into(), kind: Kind::Openrouter, label: "My key".into(), bedrock: None, secret: Some(SecretString::new(KEY)) }
    }

    fn bedrock(prefix: Option<&str>) -> ResolvedProvider {
        ResolvedProvider {
            id: "aws".into(),
            kind: Kind::Bedrock,
            label: "Work AWS".into(),
            bedrock: Some(Bedrock { profile: "work-sso".into(), region: "eu-west-1".into(), prefix: prefix.map(str::to_owned) }),
            secret: None,
        }
    }

    fn binding(model: &str, small: Option<&str>) -> Binding {
        Binding { provider_id: "x".into(), model: model.into(), small_model: small.map(str::to_owned) }
    }

    fn dir() -> PathBuf {
        PathBuf::from("/home/u/.yaah/profiles/p1")
    }

    /// Defaults, never the process-wide switch (tests run in parallel).
    fn route(preset: &str, provider: &ResolvedProvider, binding: &Binding, dir: &Path) -> Result<Route, Unsupported> {
        route_with(preset, provider, binding, dir, &Options::default())
    }

    fn env(r: &Route) -> BTreeMap<&str, &str> {
        r.env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect()
    }

    fn removed(r: &Route) -> Vec<&str> {
        r.env_remove.iter().map(String::as_str).collect()
    }

    /// No value but the ones named holds the key, and nothing else mentions it.
    fn key_only_in(r: &Route, vars: &[&str]) {
        let holding: Vec<&str> = r.env.iter().filter(|(_, v)| v.contains(KEY)).map(|(k, _)| k.as_str()).collect();
        assert_eq!(holding, vars, "{r:?}");
        assert!(r.files.iter().all(|(_, body)| !body.contains(KEY)), "no key in files");
        assert!(!format!("{r:?}").contains(KEY), "Debug redacts it");
    }

    #[test]
    fn goose_on_openrouter_and_bedrock() {
        let r = route("goose", &openrouter(), &binding("anthropic/claude-sonnet-4.6", Some("ignored")), &dir()).unwrap();
        assert_eq!(
            env(&r),
            BTreeMap::from([
                ("GOOSE_PATH_ROOT", "/home/u/.yaah/profiles/p1"),
                ("GOOSE_DISABLE_KEYRING", "1"),
                ("GOOSE_PROVIDER", "openrouter"),
                ("GOOSE_MODEL", "anthropic/claude-sonnet-4.6"),
                ("OPENROUTER_API_KEY", KEY),
            ])
        );
        assert_eq!(removed(&r), ["OPENROUTER_HOST"], "an inherited host can't redirect the key");
        key_only_in(&r, &["OPENROUTER_API_KEY"]);
        assert_eq!(r.secret_values(), [KEY]);
        assert!(r.files.is_empty() && r.providers_set.is_none());

        let r = route("goose", &bedrock(Some("us")), &binding("anthropic.claude-sonnet-4-6", None), &dir()).unwrap();
        assert_eq!(
            env(&r),
            BTreeMap::from([
                ("GOOSE_PATH_ROOT", "/home/u/.yaah/profiles/p1"),
                ("GOOSE_DISABLE_KEYRING", "1"),
                ("GOOSE_PROVIDER", "aws_bedrock"),
                ("GOOSE_MODEL", "us.anthropic.claude-sonnet-4-6"),
                ("AWS_PROFILE", "work-sso"),
                ("AWS_REGION", "eu-west-1"),
            ])
        );
        for k in ["OPENROUTER_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK"] {
            assert!(r.env_remove.contains(k), "{k}");
        }
        assert!(r.secret_vars().is_empty() && r.secret_values().is_empty(), "a Bedrock route carries no secret");
    }

    #[test]
    fn opencode_on_openrouter_and_bedrock() {
        let r = route("opencode", &openrouter(), &binding("openai/gpt-5.5", None), &dir()).unwrap();
        let e = env(&r);
        assert_eq!(e["OPENROUTER_API_KEY"], KEY);
        assert_eq!(e["OPENCODE_CONFIG_DIR"], "/home/u/.yaah/profiles/p1/config");
        assert_eq!(e["XDG_DATA_HOME"], "/home/u/.yaah/profiles/p1/data", "its own credential store");
        assert_eq!(e["OPENCODE_DISABLE_PROJECT_CONFIG"], "1");
        let config: Value = serde_json::from_str(e["OPENCODE_CONFIG_CONTENT"]).unwrap();
        assert_eq!(
            config,
            json!({
                "model": "openrouter/openai/gpt-5.5",
                "agents": { "title": { "model": "openrouter/openai/gpt-5.5" } },
                "providers": { "openrouter": {
                    "settings": { "baseURL": "https://openrouter.ai/api/v1" },
                    "headers": { "HTTP-Referer": "https://filipecabaco.github.io/yaah/", "X-OpenRouter-Title": "yaah" },
                    "models": { "openai/gpt-5.5": {} }
                } }
            })
        );
        key_only_in(&r, &["OPENROUTER_API_KEY"]);

        let r = route("opencode", &bedrock(Some("eu")), &binding("eu.anthropic.claude-haiku-4-5", None), &dir()).unwrap();
        let e = env(&r);
        assert_eq!((e["AWS_PROFILE"], e["AWS_REGION"]), ("work-sso", "eu-west-1"));
        assert!(!e.contains_key("OPENROUTER_API_KEY") && r.env_remove.contains("OPENROUTER_API_KEY"));
        assert!(!e.contains_key("OPENCODE_DISABLE_PROJECT_CONFIG"), "no secret in the env: project config stays");
        let config: Value = serde_json::from_str(e["OPENCODE_CONFIG_CONTENT"]).unwrap();
        assert_eq!(config["model"], "amazon-bedrock/eu.anthropic.claude-haiku-4-5", "already prefixed: unchanged");
        assert_eq!(config["providers"]["amazon-bedrock"]["settings"], json!({ "profile": "work-sso", "region": "eu-west-1" }));
        assert_eq!(config["agents"]["title"]["model"], "amazon-bedrock/eu.anthropic.claude-haiku-4-5", "titles on the binding too");
        assert_eq!(r.secret_values(), Vec::<&str>::new());
    }

    #[test]
    fn claude_on_bedrock_and_openrouter_env() {
        let r = route(agents::CLAUDE, &bedrock(Some("us")), &binding("anthropic.claude-opus-4-6", Some("us.anthropic.claude-haiku-4-5")), &dir())
            .unwrap();
        assert_eq!(
            env(&r),
            BTreeMap::from([
                ("CLAUDE_CODE_USE_BEDROCK", "1"),
                ("AWS_PROFILE", "work-sso"),
                ("AWS_REGION", "eu-west-1"),
                ("ANTHROPIC_MODEL", "us.anthropic.claude-opus-4-6"),
                ("ANTHROPIC_DEFAULT_OPUS_MODEL", "us.anthropic.claude-opus-4-6"),
                ("ANTHROPIC_DEFAULT_SONNET_MODEL", "us.anthropic.claude-opus-4-6"),
                ("ANTHROPIC_DEFAULT_HAIKU_MODEL", "us.anthropic.claude-haiku-4-5"),
            ])
        );
        for k in
            ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "OPENROUTER_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_BEARER_TOKEN_BEDROCK"]
        {
            assert!(r.env_remove.contains(k), "{k}");
        }
        assert!(r.secret_values().is_empty() && r.providers_set.is_none());

        let r = route(agents::CLAUDE, &openrouter(), &binding("anthropic/claude-sonnet-4.6", None), &dir()).unwrap();
        let e = env(&r);
        assert_eq!(e["ANTHROPIC_BASE_URL"], "https://openrouter.ai/api");
        assert_eq!(e["ANTHROPIC_AUTH_TOKEN"], KEY);
        assert_eq!(e["ANTHROPIC_API_KEY"], "", "set empty, not inherited");
        assert_eq!(e["ANTHROPIC_DEFAULT_HAIKU_MODEL"], "anthropic/claude-sonnet-4.6", "no small model: the same one");
        assert_eq!(e["ANTHROPIC_CUSTOM_HEADERS"], "HTTP-Referer: https://filipecabaco.github.io/yaah/\nX-OpenRouter-Title: yaah");
        assert!(r.env_remove.contains("CLAUDE_CODE_USE_BEDROCK") && !e.contains_key("AWS_PROFILE"));
        key_only_in(&r, &["ANTHROPIC_AUTH_TOKEN"]);
        assert!(r.providers_set.is_none(), "env by default");
    }

    #[test]
    fn claude_on_openrouter_through_providers_set_keeps_the_key_out_of_the_env() {
        let opts = Options { claude_openrouter: ClaudeOpenRouter::ProvidersSet, ..Options::default() };
        let r = route_with(agents::CLAUDE, &openrouter(), &binding("anthropic/claude-sonnet-4.6", None), &dir(), &opts).unwrap();
        key_only_in(&r, &[]);
        for k in ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"] {
            assert!(r.env_remove.contains(k) && !r.env.contains_key(k), "{k}");
        }
        assert_eq!(env(&r)["ANTHROPIC_MODEL"], "anthropic/claude-sonnet-4.6");
        let set = r.providers_set.clone().unwrap();
        assert_eq!(
            set,
            json!({ "providerId": "main", "apiType": "anthropic", "baseUrl": "https://openrouter.ai/api", "headers": {
                "Authorization": format!("Bearer {KEY}"), "HTTP-Referer": "https://filipecabaco.github.io/yaah/", "X-OpenRouter-Title": "yaah"
            } })
        );
        assert_eq!(r.secret_values(), [KEY]);
        assert!(!format!("{r:?}").contains(KEY));
    }

    #[test]
    fn endpoints_point_every_agent_at_one_openrouter_style_base() {
        let stub = Options { endpoints: Endpoints { openrouter: "http://127.0.0.1:4567/api/v1".into() }, ..Options::default() };
        let b = binding("yaah/stub-model", None);
        let goose = route_with("goose", &openrouter(), &b, &dir(), &stub).unwrap();
        assert_eq!(goose.env["OPENROUTER_HOST"], "http://127.0.0.1:4567", "goose appends api/v1/…");
        let oc = route_with("opencode", &openrouter(), &b, &dir(), &stub).unwrap();
        assert!(oc.env["OPENCODE_CONFIG_CONTENT"].contains(r#""baseURL":"http://127.0.0.1:4567/api/v1""#));
        let claude = route_with(agents::CLAUDE, &openrouter(), &b, &dir(), &stub).unwrap();
        assert_eq!(claude.env["ANTHROPIC_BASE_URL"], "http://127.0.0.1:4567/api", "Claude appends /v1/messages");
    }

    #[test]
    fn unsupported_bindings_say_why() {
        for preset in ["codex", "gemini", "copilot", "cursor", "kiro", agents::CUSTOM] {
            let err = route(preset, &openrouter(), &binding("m", None), &dir()).unwrap_err();
            assert!(err.0.contains("can't run on a model provider") && err.0.contains("goose"), "{preset}: {err}");
        }
        assert_eq!(unsupported("codex").unwrap(), "Codex can't run on a model provider through yaah yet. Claude Code, goose and OpenCode can.");
        assert!(SUPPORTED.iter().all(|p| unsupported(p).is_none()));
        let err = route("goose", &openrouter(), &binding("  ", None), &dir()).unwrap_err();
        assert!(err.0.contains("choose a model"), "{err}");
        let no_key = ResolvedProvider { secret: None, ..openrouter() };
        assert!(route("goose", &no_key, &binding("m", None), &dir()).unwrap_err().0.contains("no API key"));
        let no_profile = ResolvedProvider { bedrock: None, ..bedrock(None) };
        assert!(route(agents::CLAUDE, &no_profile, &binding("m", None), &dir()).unwrap_err().0.contains("AWS profile"));
    }

    #[test]
    fn bedrock_models_get_the_providers_geography_once() {
        let t = Target::Bedrock { profile: "p", region: "r", prefix: Some("apac") };
        assert_eq!(t.bedrock_model("anthropic.claude-sonnet-4-6"), "apac.anthropic.claude-sonnet-4-6");
        for kept in ["us.anthropic.claude-sonnet-4-6", "global.anthropic.claude-opus-4-6", "arn:aws:bedrock:eu-west-1:1:inference-profile/x"] {
            assert_eq!(t.bedrock_model(kept), kept);
        }
        let none = Target::Bedrock { profile: "p", region: "r", prefix: None };
        assert_eq!(none.bedrock_model("anthropic.claude-sonnet-4-6"), "anthropic.claude-sonnet-4-6");
    }

    #[test]
    fn profile_folders_are_plain_names_under_yaah() {
        assert!(profile_dir("goose-openrouter").ends_with(".yaah/profiles/goose-openrouter"));
        for odd in ["../escape", "a/b", "", ".hidden"] {
            let d = profile_dir(odd);
            let name = d.file_name().unwrap().to_string_lossy().into_owned();
            assert!(name.len() == 64 && d.parent().unwrap().ends_with(".yaah/profiles"), "{odd} → {}", d.display());
        }
    }

    #[test]
    fn a_profiles_binding_is_resolved_at_spawn() {
        let profile = |preset: &str, bound: bool| {
            let draft = agents::Draft { label: "P".into(), preset: preset.into(), command_line: "goose acp".into(), ..agents::Draft::default() };
            let mut p = draft.to_profile(&[]).unwrap();
            p.provider = bound.then(|| Binding { provider_id: "or".into(), model: "m/x".into(), small_model: None });
            p
        };
        set_resolver(Some(Arc::new(|id: &str| if id == "or" { Ok(openrouter()) } else { Err(format!("the model provider {id} was removed")) })));
        let got = for_profile(&profile("goose", true));
        let unbound = for_profile(&profile("goose", false));
        let codex = for_profile(&profile("codex", true));
        let mut gone = profile("goose", true);
        gone.provider.as_mut().unwrap().provider_id = "gone".into();
        let gone = for_profile(&gone);
        set_resolver(None);
        let r = got.unwrap().unwrap();
        assert_eq!((r.env["GOOSE_PROVIDER"].as_str(), r.env["GOOSE_MODEL"].as_str()), ("openrouter", "m/x"));
        assert!(r.env["GOOSE_PATH_ROOT"].ends_with(".yaah/profiles/p"), "{}", r.env["GOOSE_PATH_ROOT"]);
        assert!(unbound.unwrap().is_none());
        assert!(codex.unwrap_err().contains("Codex can't run on a model provider"));
        assert!(gone.unwrap_err().contains("was removed"));
    }

    #[test]
    fn files_are_written_privately() {
        use std::os::unix::fs::PermissionsExt;
        let root = crate::agent_install::tests::temp_dir("route-files");
        let mut r = Route::default();
        r.files.push((root.join("p1/config/config.yaml"), "GOOSE_PROVIDER: openrouter\n".into()));
        r.write_files().unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(std::fs::read_to_string(root.join("p1/config/config.yaml")).unwrap(), "GOOSE_PROVIDER: openrouter\n");
        assert_eq!((mode(&root.join("p1/config/config.yaml")), mode(&root.join("p1/config"))), (0o600, 0o700));
        std::fs::remove_dir_all(root).unwrap();
    }
}
