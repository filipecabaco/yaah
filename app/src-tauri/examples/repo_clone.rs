//! Usage: `cargo run --example repo_clone -- <owner/repo|url> <root>`
#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [source, root] = args.as_slice() else {
        return eprintln!("usage: repo_clone <owner/repo|url> <root>");
    };
    println!("{:?}", yaah_lib::repos::clone(source, root).await);
}
