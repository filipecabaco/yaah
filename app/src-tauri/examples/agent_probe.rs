//! "Test connection" from the command line: start an agent from a preset (or a
//! saved profile), run ACP `initialize`, print the report, stop it. Never logs
//! in, opens a session or sends a prompt.
//!
//! Usage: `cargo run --example agent_probe -- <preset-or-profile-id>...`
use yaah_lib::agents::{self, Store};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let ids: Vec<String> = std::env::args().skip(1).collect();
    if ids.is_empty() {
        for p in agents::presets() {
            println!("{:<10} {:<8} {}", p.id, p.via, p.draft.command_line);
        }
        return;
    }
    for id in ids {
        let profile = match agents::presets().into_iter().find(|p| p.id == id) {
            Some(p) => p.draft.to_profile(&[]),
            None => Store::user().find(&id).ok_or_else(|| format!("no preset or profile {id}")),
        };
        let profile = match profile {
            Ok(p) => p,
            Err(e) => {
                println!("== {id}: {e}");
                continue;
            }
        };
        println!("== {id}: {}", profile.command_line());
        match agents::test(&profile).await {
            Ok(report) => println!("{}", serde_json::to_string_pretty(&report).unwrap_or_default()),
            Err(e) => println!("error: {e}"),
        }
    }
}
