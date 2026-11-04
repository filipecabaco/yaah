//! The scripted agent's session settings, with `YAAH_AGENT_CONFIG` set:
//! - `options`: ACP `configOptions` (a mode, a model and an effort whose levels
//!   depend on the model), changed with `session/set_config_option`, each change
//!   also announced as a `config_option_update`;
//! - `models`: the older unstable `models` field, changed with `session/set_model`.
//!
//! Either way `session/load` forgets what was set (as an agent that doesn't keep
//! it would), so yaah has to send it again. A prompt starting with `config`
//! answers `config: <model>/<effort>`.

use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Mutex;

const ENV: &str = "YAAH_AGENT_CONFIG";
const DEFAULT: (&str, &str) = ("fast", "low");

static STATE: Mutex<Option<HashMap<String, (String, String)>>> = Mutex::new(None);

fn mode() -> Option<String> {
    std::env::var(ENV).ok()
}

pub fn on() -> bool {
    mode().is_some()
}

fn efforts(model: &str) -> &'static [&'static str] {
    if model == "smart" { &["low", "high", "max"] } else { &["low", "high"] }
}

fn get(sid: &str) -> (String, String) {
    let state = STATE.lock().unwrap();
    state.as_ref().and_then(|s| s.get(sid).cloned()).unwrap_or_else(|| (DEFAULT.0.into(), DEFAULT.1.into()))
}

fn put(sid: &str, model: String, effort: String) {
    STATE.lock().unwrap().get_or_insert_with(HashMap::new).insert(sid.to_owned(), (model, effort));
}

fn options(sid: &str) -> Value {
    let (model, effort) = get(sid);
    let levels: Vec<Value> = efforts(&model).iter().map(|l| json!({ "value": l, "name": l.to_uppercase() })).collect();
    json!([
        { "id": "mode", "name": "Mode", "category": "mode", "type": "select", "currentValue": "ask",
          "options": [{ "value": "ask", "name": "Ask" }, { "value": "auto", "name": "Auto" }] },
        { "id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": model,
          "options": [{ "value": "fast", "name": "Fast" }, { "value": "smart", "name": "Smart", "description": "slower" }] },
        { "id": "effort", "name": "Effort", "category": "thought_level", "type": "select", "currentValue": effort, "options": levels }
    ])
}

/// What `session/new` and `session/load` answer with, settings back at their defaults.
pub fn opened(mut response: Value, sid: &str) -> Value {
    put(sid, DEFAULT.0.into(), DEFAULT.1.into());
    match mode().as_deref() {
        Some("options") => response["configOptions"] = options(sid),
        Some("models") => {
            response["models"] = json!({ "currentModelId": DEFAULT.0, "availableModels": [
                { "modelId": "fast", "name": "Fast" }, { "modelId": "smart", "name": "Smart" }] });
        }
        _ => {}
    }
    response
}

/// `session/set_config_option` or `session/set_model`: the result, or an error message.
pub fn set(method: &str, params: &Value, notify: impl Fn(&str, &Value)) -> Result<Value, String> {
    let sid = params["sessionId"].as_str().unwrap_or_default();
    let (mut model, mut effort) = get(sid);
    if method == "session/set_model" {
        let model = params["modelId"].as_str().filter(|m| ["fast", "smart"].contains(m)).ok_or("unknown model")?;
        put(sid, model.to_owned(), effort);
        return Ok(json!({}));
    }
    let value = params["value"].as_str().ok_or("not a string")?.to_owned();
    match params["configId"].as_str() {
        Some("model") if ["fast", "smart"].contains(&value.as_str()) => {
            model = value;
            // A level the new model doesn't have falls back to low.
            if !efforts(&model).contains(&effort.as_str()) {
                effort = "low".into();
            }
        }
        Some("effort") if efforts(&model).contains(&value.as_str()) => effort = value,
        Some("mode") => {}
        _ => return Err(format!("invalid value {value}")),
    }
    put(sid, model, effort);
    notify(sid, &json!({ "sessionUpdate": "config_option_update", "configOptions": options(sid) }));
    Ok(json!({ "configOptions": options(sid) }))
}

/// `config: <model>/<effort>`, what the agent runs with now.
pub fn describe(sid: &str) -> String {
    let (model, effort) = get(sid);
    format!("config: {model}/{effort}")
}
