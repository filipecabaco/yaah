//! Read a source from the command line:
//! `cargo run --example source_read -- '{"kind":"docker.stats"}'`
//! What is connected (no tokens):
//! `cargo run --example source_read -- --integrations`
//! A git source in a folder (the app uses the chat's):
//! `cargo run --example source_read -- --in ~/code/app '{"kind":"git.diff","range":"main...HEAD"}'`
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
    let (cwd, args) = match args.first().map(String::as_str) {
        Some("--in") => (args.get(1).map(std::path::PathBuf::from), args.get(2..).unwrap_or_default().to_vec()),
        _ => (None, args),
    };
    let arg = args.first().cloned().unwrap_or_else(|| r#"{"kind":"system"}"#.into());
    let source: serde_json::Value = serde_json::from_str(&arg).expect("a JSON source");
    let s = yaah_lib::sources::Sources::new();
    // `--in` is the chat's folder; a `repo` in the source can only name that same folder here.
    let roots: Vec<std::path::PathBuf> = cwd.into_iter().collect();
    match s.read_in(&source, &roots).await {
        Ok(v) => println!("{}", serde_json::to_string_pretty(&v).unwrap()),
        Err(e) => eprintln!("error: {e}"),
    }
}
