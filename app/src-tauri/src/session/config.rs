//! A chat's model, effort and the agent's other session settings: ACP session
//! config options. See `docs/research/model-effort.md`.
//!
//! - **What the agent offers** comes from `configOptions` in the `session/new`,
//!   `session/load` and `session/set_config_option` responses and in
//!   `config_option_update` notifications (each the full set, replacing what came
//!   before). An agent without them may still send the older unstable `models`
//!   (`{ availableModels, currentModelId }`, changed with `session/set_model`), as
//!   Gemini CLI does; that becomes one option with [`Source::Models`].
//! - **Which is which** is decided here: the composer's Model picker is the first
//!   option of category `model`, its Effort picker the first of `thought_level`
//!   ([`Role`]); categories are only hints in ACP, so an id such as `model` or
//!   `reasoning_effort` stands in when an agent sends none. Other options (mode,
//!   fast mode, goose's provider…) are kept and listed, not shown yet.
//! - **A change** must be a value the agent offered, and is refused while a turn
//!   runs. It goes to the agent at once when the chat is attached, and the chat
//!   then shows what the agent answers; otherwise it is kept and sent when the
//!   next message reopens the session.
//! - **The chat keeps the user's picks** (`choices`, with the chat). After every
//!   `session/load` (a restart, the agent restarted, folders added) the picks the
//!   agent didn't keep are sent again, one at a time in the order the agent lists
//!   its options, so a model goes before the effort levels that depend on it.
//! - **New chats** start with the profile's defaults (Settings → Agents, "New chats
//!   start with"; `agentConfigDefaults` in `settings.json`), when the agent offers
//!   them. A profile bound to a model provider takes its model from the binding,
//!   so it has no model default.
//!
//! Everything an agent sends is untrusted: lists and texts are capped.

use super::{Agent, Hub, SessionInfo};
use crate::acp::{Connection, RpcError};
use crate::json_file::JsonFile;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

/// Past these an agent's list is cut (an OpenRouter-backed agent can list hundreds of models).
const MAX_OPTIONS: usize = 32;
const MAX_CHOICES: usize = 2000;
const MAX_TEXT: usize = 300;
/// The key in `settings.json`: profile id → option id → value.
const DEFAULTS_KEY: &str = "agentConfigDefaults";
/// Ids that mean a model or an effort level when an agent gives no category.
const MODEL_IDS: &[&str] = &["model"];
const EFFORT_IDS: &[&str] = &["effort", "reasoning_effort", "thinking_effort", "thought_level", "reasoning", "thinking"];

/// Where an option came from, and so how it is changed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    /// ACP `configOptions`, changed with `session/set_config_option`.
    #[default]
    Config,
    /// The older unstable `models` field, changed with `session/set_model`.
    Models,
}

impl Source {
    #[allow(clippy::trivially_copy_pass_by_ref, reason = "serde's skip_serializing_if passes a reference")]
    fn is_config(&self) -> bool {
        *self == Source::Config
    }
}

/// What the composer shows an option as.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Model,
    Effort,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    #[default]
    Select,
    /// `current` is "true" or "false". yaah doesn't advertise boolean options, so
    /// agents send a select instead; one that sends a boolean anyway gets it listed, not changed.
    Boolean,
}

/// One value of a select option.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Choice {
    pub value: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The name of the group it is listed under, for an agent that groups its values.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

/// A session setting the agent offers, as it last said.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigOption {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// ACP's category: `model`, `thought_level`, `mode`, `model_config`, another, or none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default)]
    pub kind: Kind,
    /// The value in use; always one of `choices` for a select.
    pub current: String,
    #[serde(default)]
    pub choices: Vec<Choice>,
    #[serde(default, skip_serializing_if = "Source::is_config")]
    pub source: Source,
    /// Set on the one model option and the one effort option the composer shows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<Role>,
}

impl ConfigOption {
    fn offers(&self, value: &str) -> bool {
        self.kind == Kind::Select && self.choices.iter().any(|c| c.value == value)
    }
}

/// A chat's settings: what its agent offers and what the user picked.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatConfig {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<ConfigOption>,
    /// Option id → the value the user picked (or the profile's default the chat started
    /// with), sent again when the agent doesn't keep it.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub choices: BTreeMap<String, String>,
}

impl ChatConfig {
    pub fn is_empty(&self) -> bool {
        self.options.is_empty() && self.choices.is_empty()
    }

    fn option(&self, id: &str) -> Option<&ConfigOption> {
        self.options.iter().find(|o| o.id == id)
    }

    /// The agent changed a setting (`value` for `id`): its answer when it sent one
    /// (the full set), else that option alone takes the value. The pick is what
    /// the agent now has, which may be how it spells the value.
    fn applied(&mut self, id: &str, value: &str, answer: Option<Vec<ConfigOption>>) {
        match answer {
            Some(options) => self.options = options,
            None => {
                if let Some(o) = self.options.iter_mut().find(|o| o.id == id) {
                    value.clone_into(&mut o.current);
                }
            }
        }
        let now = self.option(id).map_or_else(|| value.to_owned(), |o| o.current.clone());
        self.choices.insert(id.to_owned(), now);
    }

    /// The picks follow what the agent has now, for every option it still lists:
    /// it may have moved one when another changed (Claude's effort levels follow
    /// the model) or refused one. Picks for options it no longer lists are kept.
    fn sync_choices(&mut self) {
        let options = &self.options;
        for (id, value) in &mut self.choices {
            if let Some(o) = options.iter().find(|o| &o.id == id) {
                value.clone_from(&o.current);
            }
        }
    }

    /// The next pick to send, in the agent's order: one it offers and doesn't have,
    /// not tried yet.
    fn next_to_send(&self, tried: &BTreeSet<String>) -> Option<(ConfigOption, String)> {
        self.options.iter().find_map(|o| {
            let want = self.choices.get(&o.id)?;
            (!tried.contains(&o.id) && *want != o.current && o.offers(want)).then(|| (o.clone(), want.clone()))
        })
    }
}

// ── Parsing ─────────────────────────────────────────────────────────────────

fn text(v: &Value) -> Option<String> {
    let s = v.as_str()?.trim();
    (!s.is_empty()).then(|| s.chars().take(MAX_TEXT).collect())
}

fn choice(v: &Value, group: Option<&str>) -> Option<Choice> {
    let value = text(&v["value"])?;
    Some(Choice {
        name: text(&v["name"]).unwrap_or_else(|| value.clone()),
        value,
        description: text(&v["description"]),
        group: group.map(str::to_owned),
    })
}

/// One entry of `configOptions`, or `None` when it isn't one yaah can use.
fn parse_option(v: &Value) -> Option<ConfigOption> {
    let id = text(&v["id"])?;
    let name = text(&v["name"]).unwrap_or_else(|| id.clone());
    let (kind, current, mut choices) = match v["type"].as_str() {
        Some("boolean") => (Kind::Boolean, v["currentValue"].as_bool()?.to_string(), vec![]),
        // A select, also when an older agent leaves the type out.
        Some("select") | None => {
            let mut choices = vec![];
            for item in v["options"].as_array()? {
                // Ungrouped values, or groups of them (`{ group, name, options }`).
                match item["options"].as_array() {
                    Some(inner) => {
                        let group = text(&item["name"]).or_else(|| text(&item["group"]));
                        choices.extend(inner.iter().filter_map(|c| choice(c, group.as_deref())));
                    }
                    None => choices.extend(choice(item, None)),
                }
                if choices.len() >= MAX_CHOICES {
                    break;
                }
            }
            choices.truncate(MAX_CHOICES);
            (Kind::Select, text(&v["currentValue"])?, choices)
        }
        Some(_) => return None,
    };
    let mut seen = BTreeSet::new();
    choices.retain(|c| seen.insert(c.value.clone()));
    // ACP says the current value is one of the options; list it when an agent forgets to.
    if kind == Kind::Select && !choices.iter().any(|c| c.value == current) {
        choices.insert(0, Choice { value: current.clone(), name: current.clone(), description: None, group: None });
    }
    Some(ConfigOption {
        id,
        name,
        description: text(&v["description"]),
        category: text(&v["category"]),
        kind,
        current,
        choices,
        source: Source::Config,
        role: None,
    })
}

/// The older unstable `models`: `{ availableModels: [{ modelId, name, description }], currentModelId }`.
fn parse_models(v: &Value) -> Option<ConfigOption> {
    let current = text(&v["currentModelId"])?;
    let options: Vec<Value> = v["availableModels"]
        .as_array()?
        .iter()
        .map(|m| json!({ "value": m["modelId"], "name": m["name"], "description": m["description"] }))
        .collect();
    let mut model = parse_option(&json!({ "id": "model", "name": "Model", "category": "model", "currentValue": current, "options": options }))?;
    model.source = Source::Models;
    Some(model)
}

/// The settings an ACP response or `config_option_update` carries, with the
/// composer's model and effort marked. Empty when it carries none.
pub fn offered(v: &Value) -> Vec<ConfigOption> {
    let mut options: Vec<ConfigOption> =
        v["configOptions"].as_array().map(|a| a.iter().filter_map(parse_option).take(MAX_OPTIONS).collect()).unwrap_or_default();
    let mut ids = BTreeSet::new();
    options.retain(|o| ids.insert(o.id.clone()));
    let has_model = |options: &[ConfigOption]| options.iter().any(|o| o.category.as_deref() == Some("model") || o.id == "model");
    if !has_model(&options)
        && let Some(models) = parse_models(&v["models"])
    {
        options.push(models);
    }
    mark_roles(&mut options);
    options
}

fn mark_roles(options: &mut [ConfigOption]) {
    for (role, category, ids) in [(Role::Model, "model", MODEL_IDS), (Role::Effort, "thought_level", EFFORT_IDS)] {
        let selects = || options.iter().enumerate().filter(|(_, o)| o.kind == Kind::Select && o.role.is_none());
        let pick = selects()
            .find(|(_, o)| o.category.as_deref() == Some(category))
            .or_else(|| selects().find(|(_, o)| o.category.is_none() && ids.contains(&o.id.as_str())))
            .map(|(i, _)| i);
        if let Some(i) = pick {
            options[i].role = Some(role);
        }
    }
}

/// The option `id` if it is one `value` can be set on: a select the agent offers with that value.
pub fn check<'a>(options: &'a [ConfigOption], id: &str, value: &str) -> Result<&'a ConfigOption, String> {
    let option = options.iter().find(|o| o.id == id).ok_or_else(|| format!("This agent doesn't offer a setting called {id}."))?;
    if option.kind != Kind::Select {
        return Err(format!("yaah can't change {} yet.", option.name));
    }
    if !option.offers(value) {
        return Err(format!("{value} isn't one of the values the agent offers for {}.", option.name));
    }
    Ok(option)
}

/// Send one change to the agent. Returns the full set it answered with, if any
/// (`session/set_model` answers nothing).
async fn send(conn: &Connection, acp_session: &str, option: &ConfigOption, value: &str) -> Result<Option<Vec<ConfigOption>>, RpcError> {
    match option.source {
        Source::Config => {
            let answer =
                conn.request("session/set_config_option", json!({ "sessionId": acp_session, "configId": option.id, "value": value })).await?;
            Ok(answer["configOptions"].is_array().then(|| offered(&answer)))
        }
        Source::Models => {
            conn.request("session/set_model", json!({ "sessionId": acp_session, "modelId": value })).await?;
            Ok(None)
        }
    }
}

// ── Defaults (Settings → Agents) ────────────────────────────────────────────

fn defaults_in(file: &JsonFile, profile: &str) -> BTreeMap<String, String> {
    let all: Map<String, Value> = file.read();
    let Some(Value::Object(mine)) = all.get(DEFAULTS_KEY).and_then(|d| d.get(profile)) else { return BTreeMap::new() };
    mine.iter().filter_map(|(k, v)| Some((k.clone(), text(v)?))).collect()
}

fn write_default(file: &JsonFile, profile: &str, id: &str, value: Option<&str>) -> Result<(), String> {
    file.update(|all: &mut Map<String, Value>| {
        let defaults = all.entry(DEFAULTS_KEY).or_insert_with(|| json!({}));
        if !defaults.is_object() {
            *defaults = json!({});
        }
        let Some(defaults) = defaults.as_object_mut() else { return Ok(()) };
        let mine = defaults.entry(profile).or_insert_with(|| json!({}));
        if !mine.is_object() {
            *mine = json!({});
        }
        if let Some(mine) = mine.as_object_mut() {
            match value {
                Some(v) => mine.insert(id.to_owned(), json!(v)),
                None => mine.remove(id),
            };
        }
        if defaults.get(profile).and_then(Value::as_object).is_some_and(Map::is_empty) {
            defaults.remove(profile);
        }
        Ok(())
    })
}

/// What Settings → Agents shows under "New chats start with" for one profile.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefaults {
    /// The profile's model and effort options, as its newest chat last saw them;
    /// empty until it has had a chat.
    pub options: Vec<ConfigOption>,
    /// Option id → the value new chats start with.
    pub defaults: BTreeMap<String, String>,
    /// The model a provider binding gives the profile: then it has no model default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_model: Option<String>,
}

impl Hub {
    /// Where profile defaults are kept (the app's `settings.json`). Unset, there are none.
    pub(crate) fn set_config_defaults(&self, file: &'static JsonFile) {
        let _ = self.config_defaults.set(file);
    }

    /// [`Hub::set_config_defaults`] with a file of its own, for tests.
    pub fn use_config_defaults_at(&self, path: PathBuf) {
        self.set_config_defaults(Box::leak(Box::new(JsonFile::new(path, false))));
    }

    fn profile_defaults(&self, profile: &str) -> BTreeMap<String, String> {
        self.config_defaults.get().map(|f| defaults_in(f, profile)).unwrap_or_default()
    }

    /// The model and effort options of `account_id`'s newest chat that has any.
    fn known_options(&self, account_id: &str) -> Vec<ConfigOption> {
        let mut newest: Option<(u64, Vec<ConfigOption>)> = None;
        for chat in self.shared.chats() {
            let s = chat.lock().unwrap();
            let info = &s.info;
            if info.account_id == account_id && !info.config.options.is_empty() && newest.as_ref().is_none_or(|(at, _)| info.created_at >= *at) {
                newest = Some((info.created_at, info.config.options.clone()));
            }
        }
        newest.map(|(_, o)| o).unwrap_or_default().into_iter().filter(|o| o.role.is_some()).collect()
    }

    /// Settings → Agents: what a profile's new chats start with.
    pub fn agent_defaults(&self, account_id: &str) -> Result<AgentDefaults, String> {
        let profile = self.shared.profile(account_id)?;
        let options = self.known_options(account_id);
        let provider_model = profile.provider.map(|b| b.model);
        let mut defaults = self.profile_defaults(account_id);
        if provider_model.is_some() {
            defaults.retain(|id, _| options.iter().find(|o| &o.id == id).is_none_or(|o| o.role != Some(Role::Model)));
        }
        Ok(AgentDefaults { options, defaults, provider_model })
    }

    /// Set (or clear, with `None`) what a profile's new chats start with. The value
    /// must be one its agent offered in its newest chat.
    pub fn set_agent_default(&self, account_id: &str, id: &str, value: Option<&str>) -> Result<AgentDefaults, String> {
        let profile = self.shared.profile(account_id)?;
        let file = self.config_defaults.get().ok_or("Defaults can't be saved here.")?;
        if let Some(value) = value {
            let options = self.known_options(account_id);
            let option = check(&options, id, value)?;
            if option.role == Some(Role::Model)
                && let Some(binding) = &profile.provider
            {
                return Err(format!(
                    "{}'s model comes from its model provider ({}); change it in Settings → Model providers.",
                    profile.label, binding.model
                ));
            }
        }
        write_default(file, account_id, id, value)?;
        self.agent_defaults(account_id)
    }

    /// Change a chat's setting `id` to `value`. Refused mid-turn and for a value the
    /// agent didn't offer. An attached chat's agent gets it now and the chat shows
    /// what the agent answers; otherwise it goes when the next message reopens the session.
    pub async fn set_chat_config(&self, session_id: &str, id: &str, value: &str) -> Result<SessionInfo, String> {
        let (account_id, attached, acp_session, option) = self.shared.with(session_id, |s| {
            if s.info.running {
                return Err("Wait for the turn to end (or stop it) before changing this.".to_owned());
            }
            let option = check(&s.info.config.options, id, value)?.clone();
            Ok((s.info.account_id.clone(), s.attached, s.info.agent_session().to_owned(), option))
        })??;
        let answer = match self.live_agent(&account_id).filter(|a| attached == Some(a.generation)) {
            Some(agent) => send(&agent.conn, &acp_session, &option, value)
                .await
                .map_err(|e| self.shared.rpc_error(&account_id, &e, &format!("Couldn't change {}", option.name.to_lowercase())))?,
            None => None,
        };
        self.shared.with(session_id, |s| {
            s.info.config.applied(id, value, answer);
            s.info.config.sync_choices();
            self.shared.emit_info(s);
            self.shared.save(s);
            s.info.clone()
        })
    }

    /// After `session/new`, `session/load` or a hand-off: take the settings the agent
    /// offers (`offered`; `None` keeps the chat's), then send the chat's picks it
    /// doesn't have, a new session's from the profile's defaults when it has none.
    /// A pick the agent refuses is left at what the agent has; the chat goes on.
    pub(super) async fn settle_config(
        &self,
        session_id: &str,
        agent: &Agent,
        offered: Option<Vec<ConfigOption>>,
        new: bool,
    ) -> Result<SessionInfo, String> {
        let defaults = if new { self.profile_defaults(&self.shared.with_info(session_id, |i| i.account_id.clone())?) } else { BTreeMap::new() };
        let bound = new && self.shared.with_info(session_id, |i| self.shared.profile(&i.account_id).is_ok_and(|p| p.provider.is_some()))?;
        let acp_session = self.shared.with(session_id, |s| {
            if let Some(options) = offered {
                s.info.config.options = options;
            }
            let config = &mut s.info.config;
            if new && config.choices.is_empty() {
                // A provider binding gives a bound profile its model.
                config.choices =
                    defaults.into_iter().filter(|(id, _)| !(bound && config.option(id).is_some_and(|o| o.role == Some(Role::Model)))).collect();
            }
            s.info.agent_session().to_owned()
        })?;
        let mut tried = BTreeSet::new();
        while let Some((option, value)) = self.shared.with_info(session_id, |i| i.config.next_to_send(&tried))? {
            tried.insert(option.id.clone());
            match send(&agent.conn, &acp_session, &option, &value).await {
                Ok(answer) => self.shared.with(session_id, |s| s.info.config.applied(&option.id, &value, answer))?,
                Err(e) => eprintln!("[config] {session_id}: the agent refused {} = {value}: {e}", option.id),
            }
        }
        self.shared.with(session_id, |s| {
            s.info.config.sync_choices();
            self.shared.emit_info(s);
            self.shared.save(s);
            s.info.clone()
        })
    }
}

/// For the conformance suite: the settings a `session/new` answer offers, as one
/// line ("model (Model picker, 3 values), effort (Effort picker, 4 values), mode"),
/// empty when it offers none; an error when it sends `configOptions` yaah can't read.
pub fn summary(response: &Value) -> Result<String, String> {
    let options = offered(response);
    let sent = response["configOptions"].as_array().map_or(0, Vec::len);
    if sent > 0 && options.iter().all(|o| o.source != Source::Config) {
        return Err(format!("{sent} configOptions, none of which yaah can read"));
    }
    Ok(options
        .iter()
        .map(|o| {
            let shown = match o.role {
                Some(Role::Model) => "Model picker, ",
                Some(Role::Effort) => "Effort picker, ",
                None => "",
            };
            let via = if o.source == Source::Models { "; older `models`" } else { "" };
            format!("{} ({shown}{} values{via})", o.id, o.choices.len())
        })
        .collect::<Vec<_>>()
        .join(", "))
}

/// A `config_option_update`: the agent's settings changed (the full set). The
/// user's picks stay as they are; they are only sent again after a reload.
pub(super) fn on_update(shared: &super::Shared, s: &mut super::Session, update: &Value) {
    s.info.config.options = offered(update);
    // An import's chat reaches the UI once it is in (`Hub::import_agent_session`).
    if s.importing.is_none() {
        shared.emit_info(s);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Options as claude-agent-acp 0.100 sends them (trimmed): mode, model, effort, fast mode.
    fn claude() -> Value {
        json!({ "configOptions": [
            { "id": "mode", "name": "Mode", "category": "mode", "type": "select", "currentValue": "default",
              "options": [{ "value": "default", "name": "Default" }, { "value": "plan", "name": "Plan" }] },
            { "id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": "default",
              "options": [{ "value": "default", "name": "Default", "description": "Opus 4.6" }, { "value": "sonnet", "name": "Sonnet" }, { "value": "haiku", "name": "Haiku" }] },
            { "id": "effort", "name": "Effort", "category": "thought_level", "type": "select", "currentValue": "default",
              "options": [{ "value": "default", "name": "Default" }, { "value": "low", "name": "Low" }, { "value": "high", "name": "High" }] },
            { "id": "fast", "name": "Fast mode", "category": "model_config", "type": "select", "currentValue": "off",
              "options": [{ "value": "on", "name": "On" }, { "value": "off", "name": "Off" }] }
        ]})
    }

    fn roles(options: &[ConfigOption]) -> Vec<(&str, Option<Role>)> {
        options.iter().map(|o| (o.id.as_str(), o.role)).collect()
    }

    #[test]
    fn config_options_parse_with_the_model_and_effort_marked() {
        let options = offered(&claude());
        assert_eq!(
            roles(&options),
            [("mode", None), ("model", Some(Role::Model)), ("effort", Some(Role::Effort)), ("fast", None)],
            "category decides; mode and fast mode are listed, not shown"
        );
        let model = &options[1];
        assert_eq!((model.current.as_str(), model.choices.len(), model.source), ("default", 3, Source::Config));
        assert_eq!(model.choices[0].description.as_deref(), Some("Opus 4.6"));
    }

    #[test]
    fn codex_and_goose_ids_and_grouped_values_parse() {
        // codex-acp 2.5: `reasoning_effort`; goose 1.57: `thinking_effort` and an uncategorised `provider`.
        let options = offered(&json!({ "configOptions": [
            { "id": "provider", "name": "Provider", "type": "select", "currentValue": "openrouter",
              "options": [{ "value": "openrouter", "name": "OpenRouter" }, { "value": "aws_bedrock", "name": "Bedrock" }] },
            { "id": "model", "name": "Model", "type": "select", "currentValue": "gpt-5.5",
              "options": [{ "group": "openai", "name": "OpenAI", "options": [{ "value": "gpt-5.5", "name": "GPT-5.5" }, { "value": "gpt-5.5-mini", "name": "Mini" }] },
                          { "group": "x", "name": "Other", "options": [{ "value": "o9", "name": "O9" }] }] },
            { "id": "reasoning_effort", "name": "Reasoning effort", "type": "select", "currentValue": "medium",
              "options": [{ "value": "low", "name": "Low" }, { "value": "medium", "name": "Medium" }] }
        ]}));
        assert_eq!(
            roles(&options),
            [("provider", None), ("model", Some(Role::Model)), ("reasoning_effort", Some(Role::Effort))],
            "by id with no category"
        );
        let groups: Vec<_> = options[1].choices.iter().map(|c| (c.value.as_str(), c.group.as_deref())).collect();
        assert_eq!(groups, [("gpt-5.5", Some("OpenAI")), ("gpt-5.5-mini", Some("OpenAI")), ("o9", Some("Other"))]);
    }

    #[test]
    fn the_older_models_field_is_the_fallback() {
        // Gemini CLI 0.63: no configOptions, `models` and `session/set_model`.
        let gemini = json!({ "modes": {}, "models": { "currentModelId": "auto", "availableModels": [
            { "modelId": "auto", "name": "Auto" }, { "modelId": "gemini-2.5-pro", "name": "Gemini 2.5 Pro", "description": "Pro" } ] } });
        let options = offered(&gemini);
        assert_eq!(roles(&options), [("model", Some(Role::Model))]);
        assert_eq!((options[0].source, options[0].choices.len()), (Source::Models, 2));

        let mut both = claude();
        both["models"] = gemini["models"].clone();
        assert!(offered(&both).iter().all(|o| o.source == Source::Config), "configOptions win over models");
        assert!(offered(&json!({})).is_empty() && offered(&json!({ "configOptions": "no" })).is_empty());
    }

    #[test]
    fn untrusted_lists_are_checked_and_capped() {
        let many: Vec<Value> = (0..3000).map(|i| json!({ "value": format!("m{i}"), "name": "x".repeat(1000) })).collect();
        let options = offered(&json!({ "configOptions": [
            { "id": "model", "name": "Model", "category": "model", "currentValue": "elsewhere", "options": many },
            { "id": "model", "name": "Again", "currentValue": "a", "options": [{ "value": "a" }] },
            { "id": "", "name": "No id", "currentValue": "a", "options": [] },
            { "id": "weird", "type": "slider", "currentValue": 3 },
            { "id": "fast", "name": "Fast", "type": "boolean", "currentValue": true },
            { "id": "dup", "name": "Dup", "currentValue": "a", "options": [{ "value": "a" }, { "value": "a", "name": "again" }] }
        ]}));
        assert_eq!(options.iter().map(|o| o.id.as_str()).collect::<Vec<_>>(), ["model", "fast", "dup"], "invalid and repeated ids are skipped");
        let model = &options[0];
        assert_eq!(model.choices.len(), MAX_CHOICES + 1, "capped, and the current value is listed");
        assert_eq!((model.choices[0].value.as_str(), model.choices[1].name.chars().count()), ("elsewhere", MAX_TEXT));
        assert_eq!((options[1].kind, options[1].current.as_str(), options[1].role), (Kind::Boolean, "true", None));
        assert_eq!(options[2].choices.len(), 1);
    }

    #[test]
    fn the_conformance_line_lists_settings_and_fails_on_unreadable_ones() {
        assert_eq!(summary(&claude()).unwrap(), "mode (2 values), model (Model picker, 3 values), effort (Effort picker, 3 values), fast (2 values)");
        assert_eq!(summary(&json!({ "sessionId": "s" })).unwrap(), "");
        let gemini = json!({ "models": { "currentModelId": "auto", "availableModels": [{ "modelId": "auto", "name": "Auto" }] } });
        assert_eq!(summary(&gemini).unwrap(), "model (Model picker, 1 values; older `models`)");
        assert!(summary(&json!({ "configOptions": [{ "id": 3 }] })).unwrap_err().contains("none of which yaah can read"));
    }

    #[test]
    fn only_offered_values_of_selects_can_be_set() {
        let options = offered(&claude());
        assert!(check(&options, "model", "sonnet").is_ok());
        assert!(check(&options, "model", "gpt-5").unwrap_err().contains("isn't one of the values"));
        assert!(check(&options, "temperature", "1").unwrap_err().contains("doesn't offer"));
        let boolean = offered(&json!({ "configOptions": [{ "id": "fast", "name": "Fast", "type": "boolean", "currentValue": false }] }));
        assert!(check(&boolean, "fast", "true").unwrap_err().contains("can't change"));
    }

    #[test]
    fn picks_are_sent_again_in_the_agents_order_until_it_has_them() {
        let mut config = ChatConfig { options: offered(&claude()), choices: BTreeMap::new() };
        config.choices = BTreeMap::from([("effort".into(), "high".into()), ("model".into(), "sonnet".into()), ("mode".into(), "default".into())]);
        let mut tried = BTreeSet::new();
        let (first, value) = config.next_to_send(&tried).unwrap();
        assert_eq!((first.id.as_str(), value.as_str()), ("model", "sonnet"), "the model first: effort levels depend on it; mode already matches");
        tried.insert(first.id.clone());
        // The agent answers with the full set: sonnet has no "high", so its effort list changes.
        let mut answer = claude();
        answer["configOptions"][1]["currentValue"] = json!("sonnet");
        answer["configOptions"][2]["options"] = json!([{ "value": "default", "name": "Default" }, { "value": "low", "name": "Low" }]);
        config.applied("model", "sonnet", Some(offered(&answer)));
        assert_eq!(config.next_to_send(&tried), None, "high isn't offered any more: nothing left to send");
        config.sync_choices();
        assert_eq!(config.choices["effort"], "default", "the pick follows what the agent has");
        assert_eq!(config.choices["model"], "sonnet");
    }

    #[test]
    fn a_change_without_an_answer_moves_that_option_and_picks_for_gone_options_stay() {
        let mut config = ChatConfig {
            options: offered(
                &json!({ "models": { "currentModelId": "auto", "availableModels": [{ "modelId": "auto", "name": "Auto" }, { "modelId": "pro", "name": "Pro" }] } }),
            ),
            choices: BTreeMap::new(),
        };
        config.choices.insert("effort".into(), "high".into());
        config.applied("model", "pro", None);
        config.sync_choices();
        assert_eq!(config.options[0].current, "pro");
        assert_eq!(config.choices, BTreeMap::from([("effort".into(), "high".into()), ("model".into(), "pro".into())]), "no effort option now: kept");
    }

    #[test]
    fn saved_chats_round_trip_and_old_ones_have_none() {
        let config = ChatConfig { options: offered(&claude()), choices: BTreeMap::from([("model".into(), "haiku".into())]) };
        let back: ChatConfig = serde_json::from_value(serde_json::to_value(&config).unwrap()).unwrap();
        assert_eq!(back, config);
        let mut info = serde_json::to_value(super::super::test_info("c1")).unwrap();
        assert!(info.get("config").is_none(), "nothing written for a chat without settings");
        info.as_object_mut().unwrap().remove("config");
        let old: SessionInfo = serde_json::from_value(info).unwrap();
        assert!(old.config.is_empty());
    }

    /// A hub over a temp profile store with one profile, and one chat of it that has
    /// `claude()`'s options (no agent runs); returns the hub, the profile, the chat and the folder.
    fn hub_with_chat() -> (Hub, String, String, PathBuf) {
        use crate::agents::{self, Draft, Store};
        let dir = std::env::temp_dir().join(format!("yaah-config-hub-{}", super::super::random_token()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("agents.json"), r#"{ "profiles": [] }"#).unwrap();
        let profiles: &'static Store = Box::leak(Box::new(Store::at(dir.join("agents.json"))));
        let draft = Draft { label: "Scripted".into(), preset: agents::CUSTOM.into(), command_line: "true".into(), ..Draft::default() };
        let id = profiles.save(&draft).unwrap().0.id;
        let hub = Hub::open(std::sync::Arc::new(|_: &str, _: Value| {}), None, profiles);
        hub.use_config_defaults_at(dir.join("settings.json"));
        let mut info = super::super::test_info("c1");
        info.running = false;
        info.account_id.clone_from(&id);
        info.config.options = offered(&claude());
        hub.shared.insert(super::super::Session::new(info, vec![], None));
        (hub, id, "c1".into(), dir)
    }

    #[test]
    fn a_detached_chat_keeps_a_checked_pick_and_a_bound_profile_has_no_model_default() {
        let (hub, profile, chat, dir) = hub_with_chat();
        let set = |id: &str, v: &str| tauri::async_runtime::block_on(hub.set_chat_config(&chat, id, v));
        assert!(set("model", "gpt-9").is_err());
        let info = set("model", "haiku").unwrap();
        assert_eq!((info.config.option("model").unwrap().current.as_str(), info.config.choices["model"].as_str()), ("haiku", "haiku"));
        hub.shared.with(&chat, |s| s.info.running = true).unwrap();
        assert!(set("effort", "high").unwrap_err().contains("Wait for the turn"));

        hub.set_agent_default(&profile, "effort", Some("high")).unwrap();
        hub.shared
            .profiles
            .set_provider(&profile, Some(crate::providers::Binding { provider_id: "or".into(), model: "m/x".into(), small_model: None }))
            .unwrap();
        let err = hub.set_agent_default(&profile, "model", Some("sonnet")).unwrap_err();
        assert!(err.contains("comes from its model provider (m/x)"), "{err}");
        let d = hub.agent_defaults(&profile).unwrap();
        assert_eq!((d.provider_model.as_deref(), d.defaults.len()), (Some("m/x"), 1));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn defaults_are_kept_per_profile_and_cleared() {
        let dir = std::env::temp_dir().join(format!("yaah-config-{}", super::super::random_token()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = JsonFile::new(dir.join("settings.json"), false);
        std::fs::write(file.path(), r#"{ "appearance": "dark" }"#).unwrap();
        write_default(&file, "claude", "model", Some("sonnet")).unwrap();
        write_default(&file, "claude", "effort", Some("high")).unwrap();
        write_default(&file, "codex", "reasoning_effort", Some("low")).unwrap();
        assert_eq!(defaults_in(&file, "claude"), BTreeMap::from([("effort".into(), "high".into()), ("model".into(), "sonnet".into())]));
        write_default(&file, "codex", "reasoning_effort", None).unwrap();
        let all: Map<String, Value> = file.read();
        assert_eq!(all["appearance"], "dark", "other settings stay");
        assert!(all[DEFAULTS_KEY].get("codex").is_none(), "an emptied profile goes");
        assert!(defaults_in(&file, "nobody").is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }
}
