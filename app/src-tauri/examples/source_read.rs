//! Read a source from the command line:
//! `cargo run --example source_read -- '{"kind":"docker.stats"}'`
//! What is connected (no tokens):
//! `cargo run --example source_read -- --integrations`
//! Save a database connection (tested first), as the app's dialog does:
//! `cargo run --example source_read -- --add-connection shop postgres://…`
#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--integrations") {
        return println!("{}", serde_json::to_string_pretty(&yaah_lib::integrations::status()).unwrap());
    }
    if args.first().map(String::as_str) == Some("--add-connection") {
        let (Some(name), Some(url)) = (args.get(1), args.get(2)) else {
            return eprintln!("usage: --add-connection <name> <url>");
        };
        match yaah_lib::sources::add_connection(name, url).await {
            Ok(info) => println!("{}", serde_json::to_string_pretty(&info).unwrap()),
            Err(e) => eprintln!("error: {e}"),
        }
        return;
    }
    let arg = args.first().cloned().unwrap_or_else(|| r#"{"kind":"system"}"#.into());
    let source: serde_json::Value = serde_json::from_str(&arg).expect("a JSON source");
    let s = yaah_lib::sources::Sources::new();
    match s.read(&source).await {
        Ok(v) => println!("{}", serde_json::to_string_pretty(&v).unwrap()),
        Err(e) => eprintln!("error: {e}"),
    }
}
