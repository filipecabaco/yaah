// Included inside `session.rs`'s `mod live_tests` (it reuses `run_turns_as`,
// which answers permission requests through `harness_allows`):
//
//     include!("live_adapter_tests.rs");
//
// Tier B of the adapter conformance suite (`agent_conformance::live`): each row
// of `live::CHECKS` against a real, signed-in agent, one fresh chat each.
// Prepared, not active: nothing in the app runs these, and they spend a few
// cheap prompts of the account's usage.
//
//   YAAH_LIVE_ACCOUNT=default cargo test --lib live_adapter -- --ignored --nocapture
//
// With `YAAH_LIVE_CANDIDATE=<version>` they run that installed version of the
// profile's preset (from `~/.yaah/agents`, e.g. one "Check for updates"
// installed) with the profile's own login, which is how they'll gate promotion.

/// The profile tier B runs: `YAAH_LIVE_ACCOUNT`'s own (its config dir, env and
/// login), switched to the candidate's command when `YAAH_LIVE_CANDIDATE` is
/// set, saved in a temp store so the real one is never written.
fn live_adapter_profile() -> (&'static Store, Profile, PathBuf) {
    let account = std::env::var("YAAH_LIVE_ACCOUNT").unwrap_or_else(|_| "default".into());
    let mut profile = Store::user().find(&account).unwrap_or_else(|| panic!("YAAH_LIVE_ACCOUNT={account} names no agent"));
    if let Ok(version) = std::env::var("YAAH_LIVE_CANDIDATE") {
        let (command, args) =
            crate::agent_versions::Versions::user().candidate_command(&profile.preset, &version).expect("the candidate is installed");
        println!("running {} {version}: {command} {args:?}", profile.preset);
        (profile.command, profile.args) = (command, args);
    }
    let dir = std::env::temp_dir().join(format!("yaah-live-adapter-{}", random_token()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = agents::AgentsFile { default: Some(profile.id.clone()), profiles: vec![profile.clone()] };
    crate::json_file::write(&dir.join("agents.json"), &file, true).unwrap();
    let store: &'static Store = Box::leak(Box::new(Store::at(dir.join("agents.json"))));
    (store, profile, dir)
}

fn as_values(entries: &[Entry]) -> Vec<Value> {
    entries.iter().map(|e| serde_json::to_value(e).unwrap()).collect()
}

/// Run one tier B check. `Ok(false)` when it doesn't apply to this agent.
fn run_live_check(check: &crate::agent_conformance::live::LiveCheck) -> Result<bool, String> {
    use crate::agent_conformance::live::{Flow, Transcript};
    let (profiles, profile, store_dir) = live_adapter_profile();
    if !(check.needs)(&crate::agent_conformance::expectations(&profile.preset)) {
        return Ok(false);
    }
    let ui = if check.ui { Ui::On } else { Ui::Off };
    let verdict = match check.flow {
        Flow::Turns | Flow::BrokenMcp | Flow::CancelMidTurn => {
            let ui = if check.flow == Flow::BrokenMcp { Ui::Dead } else { ui };
            let cancelled = std::sync::atomic::AtomicBool::new(false);
            let (run, _) = run_turns_as(profiles, &profile.id, check.prompts, ui, None, |_, _, _| {}, |hub, sid, name, payload| {
                // Cancel once the agent has started answering.
                if check.flow == Flow::CancelMidTurn
                    && name == "session-entry"
                    && payload["entry"]["type"] == "agent"
                    && !cancelled.swap(true, std::sync::atomic::Ordering::SeqCst)
                {
                    println!("cancelling: {:?}", hub.cancel(sid));
                }
            });
            let entries = as_values(&run.entries);
            let verdict = (check.judge)(&Transcript { entries: &entries, events: &run.events, root: &run.root });
            std::fs::remove_dir_all(&run.root).ok();
            verdict
        }
        Flow::Reload => {
            // As `live_restart_keeps_history`, with this profile: the first yaah is dropped, a second reopens the chat.
            let root = std::env::temp_dir().join(format!("yaah-live-reload-{}", random_token()));
            let repo = root.join("repo");
            std::fs::create_dir_all(&repo).unwrap();
            let project = Project {
                id: "live".into(),
                name: "live".into(),
                dirs: vec![repo.to_string_lossy().into()],
                status: Status::Ongoing,
                created_at: 0,
                context_dir: repo.to_string_lossy().into(),
                link: None,
            };
            let quiet: Emit = Arc::new(|_: &str, _: Value| {});
            let ask = |hub: &Hub, sid: &str, text: &str| {
                tauri::async_runtime::block_on(hub.prompt(sid, text.into(), vec![])).unwrap();
                while hub.transcript(sid).unwrap().info.running {
                    std::thread::sleep(Duration::from_millis(200));
                }
            };
            let sid = {
                let hub = Hub::open(quiet.clone(), Some(root.join("sessions")), profiles);
                let info = tauri::async_runtime::block_on(hub.new_session(ChatTarget::Project(&project), &profile.id)).unwrap();
                ask(&hub, &info.session_id, check.prompts[0]);
                info.session_id
            };
            let hub = Hub::open(quiet, Some(root.join("sessions")), profiles);
            ask(&hub, &sid, check.prompts[1]);
            let entries = as_values(&hub.transcript(&sid).unwrap().entries);
            let verdict = (check.judge)(&Transcript { entries: &entries, events: &[], root: &root });
            std::fs::remove_dir_all(&root).ok();
            verdict
        }
    };
    std::fs::remove_dir_all(store_dir).ok();
    verdict.map(|()| true)
}

fn live_adapter_one(name: &str) {
    let check = crate::agent_conformance::live::CHECKS.iter().find(|c| c.name == name).expect("a tier B check");
    match run_live_check(check) {
        Ok(true) => println!("tier B {name}: pass"),
        Ok(false) => println!("tier B {name}: doesn't apply to this agent"),
        Err(e) => panic!("tier B {name}: {e}"),
    }
}

macro_rules! live_adapter_tests {
    ($($test:ident => $name:literal),* $(,)?) => {$(
        #[test]
        #[ignore = "tier B: talks to a real agent and spends some of the account's usage"]
        fn $test() {
            live_adapter_one($name);
        }
    )*};
}

live_adapter_tests! {
    live_adapter_prompt_streams => "prompt streams",
    live_adapter_available_commands => "available commands",
    live_adapter_ui_tool_call => "ui tool call",
    live_adapter_permission_round_trip => "permission round trip",
    live_adapter_cancel_mid_turn => "cancel mid-turn",
    live_adapter_session_load_replays => "session/load replays",
    live_adapter_notices => "notices",
}

/// Every tier B row has a test above.
#[test]
fn every_tier_b_check_has_a_live_test() {
    let names: Vec<&str> = crate::agent_conformance::live::CHECKS.iter().map(|c| c.name).collect();
    let wired = [
        "prompt streams",
        "available commands",
        "ui tool call",
        "permission round trip",
        "cancel mid-turn",
        "session/load replays",
        "notices",
    ];
    assert_eq!(names, wired);
    const { assert!(!crate::agent_conformance::live::ENABLED, "tier B is prepared, not active") };
}
