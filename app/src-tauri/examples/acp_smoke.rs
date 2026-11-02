//! Headless check of the ACP client against claude-agent-acp.
//! Usage: `cargo run --example acp_smoke -- <account-id> [prompt]`
use serde_json::{Value, json};
use yaah_lib::{accounts, acp, path_env, session};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut args = std::env::args().skip(1);
    let account_id = args.next().unwrap_or_else(|| "default".into());
    let prompt = args.next();
    let Some(account) = accounts::find(&account_id) else {
        return eprintln!("unknown account {account_id}");
    };
    println!("account: {} email={:?} dir={:?}", account.id, account.email, account.config_dir);

    let mut cmd = path_env::tokio_command("npx");
    cmd.args(["-y", session::ADAPTER_PACKAGE]).env_remove("ANTHROPIC_API_KEY");
    if let Some(dir) = &account.config_dir {
        cmd.env("CLAUDE_CONFIG_DIR", dir);
    }
    let conn = acp::Connection::spawn(
        cmd,
        |msg, responder| match msg {
            acp::Incoming::Notification { params, .. } => {
                let u = &params["update"];
                match u["sessionUpdate"].as_str() {
                    Some("agent_message_chunk") => print!("{}", u["content"]["text"].as_str().unwrap_or("")),
                    Some(other) => println!("\n<update {other}>"),
                    None => {}
                }
            }
            acp::Incoming::Request { id, method, .. } => {
                println!("\n<request {method}> -> cancelled");
                responder.ok(id, json!({ "outcome": { "outcome": "cancelled" } }));
            }
        },
        |reason| eprintln!("exit: {reason}"),
    );
    let conn = match conn {
        Ok(c) => c,
        Err(e) => return eprintln!("spawn: {e}"),
    };

    let init = conn
        .request("initialize", json!({ "protocolVersion": 1, "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false, "auth": { "terminal": true } } }))
        .await;
    let init = match init {
        Ok(v) => v,
        Err(e) => return eprintln!("initialize: {e}"),
    };
    println!("initialize: protocolVersion={} authMethods={}", init["protocolVersion"], init["authMethods"]);
    println!(
        "caps: additionalDirectories={} embeddedContext={}",
        init["agentCapabilities"]["sessionCapabilities"]["additionalDirectories"], init["agentCapabilities"]["promptCapabilities"]["embeddedContext"]
    );

    let cwd = std::env::var("YAAH_CWD").unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().into_owned());
    let extra: Vec<String> = std::env::var("YAAH_EXTRA_DIRS").map(|v| v.split(':').map(str::to_owned).collect()).unwrap_or_default();
    let sid = match conn.request("session/new", json!({ "cwd": cwd, "mcpServers": [], "additionalDirectories": extra })).await {
        Ok(v) => v["sessionId"].as_str().unwrap_or_default().to_owned(),
        Err(e) => return println!("session/new error: {e}"),
    };
    println!("session: {sid}");

    if let Some(text) = prompt {
        let mut blocks = vec![];
        if let Ok(brief) = std::env::var("YAAH_BRIEF") {
            blocks.push(json!({ "type": "resource", "resource": { "uri": "file:///tmp/project.md", "mimeType": "text/markdown", "text": brief } }));
        }
        blocks.push(json!({ "type": "text", "text": text }));
        let res = conn.request("session/prompt", json!({ "sessionId": sid, "prompt": blocks })).await;
        println!("\nprompt result: {:?}", res.map(|v: Value| v["stopReason"].clone()));
    }
}
