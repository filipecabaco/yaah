//! A chat's model and effort (`session/config.rs`) against the scripted agent
//! with settings (`agent_config.rs`): what reaches the agent, what comes back,
//! and what survives a reload.

use super::{ACCOUNT, Fixture, last_agent_text, waiting_permissions};
use yaah_lib::session::{ChatConfig, SessionInfo};

fn config(f: &Fixture, sid: &str) -> ChatConfig {
    f.hub.session_info(sid).unwrap().config
}

fn current(f: &Fixture, sid: &str, id: &str) -> String {
    config(f, sid).options.iter().find(|o| o.id == id).map(|o| o.current.clone()).unwrap_or_default()
}

fn set(f: &Fixture, sid: &str, id: &str, value: &str) -> Result<SessionInfo, String> {
    tauri::async_runtime::block_on(f.hub.set_chat_config(sid, id, value))
}

/// The `configId=value` of each `session/set_config_option` the agent got.
fn sets(f: &Fixture) -> Vec<String> {
    f.requests("session/set_config_option").iter().map(|p| format!("{}={}", p["configId"].as_str().unwrap(), p["value"].as_str().unwrap())).collect()
}

pub fn model_and_effort_reach_the_agent_and_come_back_after_a_reload() {
    let mut f = Fixture::new(&[("YAAH_AGENT_CONFIG", "options")]);
    let sid = f.chat();
    let c = config(&f, &sid);
    let shown: Vec<_> = c.options.iter().map(|o| (o.id.as_str(), o.current.as_str(), o.role.is_some())).collect();
    assert_eq!(shown, [("mode", "ask", false), ("model", "fast", true), ("effort", "low", true)], "from session/new");

    let err = set(&f, &sid, "model", "gpt-9").unwrap_err();
    assert!(err.contains("isn't one of the values"), "{err}");
    assert!(sets(&f).is_empty(), "refused before anything was sent");

    // The agent's answer is the chat's state: the smart model has more effort levels.
    let info = set(&f, &sid, "model", "smart").unwrap();
    let effort = info.config.options.iter().find(|o| o.id == "effort").unwrap();
    assert_eq!(effort.choices.iter().map(|c| c.value.as_str()).collect::<Vec<_>>(), ["low", "high", "max"]);
    set(&f, &sid, "effort", "max").unwrap();
    assert_eq!(last_agent_text(&f.turn(&sid, "config")), "config: smart/max", "applies to the next message");

    // Back to fast, which has no max: the agent drops it to low and the chat follows.
    set(&f, &sid, "model", "fast").unwrap();
    assert_eq!((current(&f, &sid, "effort"), config(&f, &sid).choices["effort"].clone()), ("low".into(), "low".into()));
    set(&f, &sid, "model", "smart").unwrap();
    set(&f, &sid, "effort", "max").unwrap();

    // A restart: the agent forgets on session/load; the chat's picks go again, model first.
    f.restart();
    let saved = config(&f, &sid);
    assert_eq!((saved.choices["model"].as_str(), saved.choices["effort"].as_str()), ("smart", "max"), "kept with the chat");
    let before = sets(&f).len();
    assert_eq!(last_agent_text(&f.turn(&sid, "config")), "config: smart/max");
    assert_eq!(sets(&f)[before..], ["model=smart", "effort=max"], "re-applied after session/load, in the agent's order");
    assert_eq!(f.requests("session/load").len(), 1);
}

pub fn changes_wait_for_the_turn_and_a_detached_chat_sends_them_with_its_next_message() {
    let mut f = Fixture::new(&[("YAAH_AGENT_CONFIG", "options")]);
    let sid = f.chat();
    f.prompt(&sid, "wait");
    f.until(&sid, "the permission request", |t| waiting_permissions(t).first().copied());
    let err = set(&f, &sid, "model", "smart").unwrap_err();
    assert!(err.contains("Wait for the turn"), "{err}");
    f.hub.cancel(&sid).unwrap();
    f.finished(&sid);

    // After a restart nothing runs yet: the pick is kept and shown, and goes with the next message.
    f.restart();
    let info = set(&f, &sid, "model", "smart").unwrap();
    assert_eq!(info.config.options.iter().find(|o| o.id == "model").unwrap().current, "smart");
    assert!(sets(&f).is_empty(), "no agent was started for it");
    assert_eq!(last_agent_text(&f.turn(&sid, "config")), "config: smart/low");
    assert_eq!(sets(&f), ["model=smart"]);
}

pub fn the_older_models_field_goes_through_set_model() {
    let mut f = Fixture::new(&[("YAAH_AGENT_CONFIG", "models")]);
    let sid = f.chat();
    let c = config(&f, &sid);
    assert_eq!(c.options.len(), 1, "only a model, no effort");
    set(&f, &sid, "model", "smart").unwrap();
    assert_eq!(f.requests("session/set_model").last().unwrap()["modelId"], "smart");
    assert_eq!(current(&f, &sid, "model"), "smart", "session/set_model answers nothing: the chat takes the value");
    f.restart();
    assert_eq!(last_agent_text(&f.turn(&sid, "config")), "config: smart/low", "sent again after session/load");
    assert_eq!(f.requests("session/set_model").len(), 2);
}

pub fn new_chats_start_with_the_profiles_defaults() {
    let f = Fixture::new(&[("YAAH_AGENT_CONFIG", "options")]);
    f.hub.use_config_defaults_at(f.dir.join("settings.json"));
    assert!(f.hub.agent_defaults(ACCOUNT).unwrap().options.is_empty(), "nothing known before its first chat");
    assert!(f.hub.set_agent_default(ACCOUNT, "model", Some("smart")).is_err());

    f.chat();
    let d = f.hub.agent_defaults(ACCOUNT).unwrap();
    assert_eq!(d.options.iter().map(|o| o.id.as_str()).collect::<Vec<_>>(), ["model", "effort"], "model and effort only");
    f.hub.set_agent_default(ACCOUNT, "model", Some("smart")).unwrap();
    assert!(f.hub.set_agent_default(ACCOUNT, "effort", Some("max")).is_err(), "fast, the newest chat's model, has no max");
    let d = f.hub.set_agent_default(ACCOUNT, "effort", Some("high")).unwrap();
    assert_eq!(d.defaults.len(), 2);

    let sid = f.chat();
    assert_eq!((current(&f, &sid, "model"), current(&f, &sid, "effort")), ("smart".into(), "high".into()));
    assert_eq!(last_agent_text(&f.turn(&sid, "config")), "config: smart/high");

    let d = f.hub.set_agent_default(ACCOUNT, "model", None).unwrap();
    assert_eq!(d.defaults.keys().collect::<Vec<_>>(), ["effort"]);
    let sid = f.chat();
    assert_eq!(current(&f, &sid, "model"), "fast", "cleared: the agent's own default");
}
