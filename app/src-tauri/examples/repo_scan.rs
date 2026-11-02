//! Prints what the repo picker would list. Usage: `cargo run --example repo_scan`
fn main() {
    let t = std::time::Instant::now();
    let roots = yaah_lib::repos::roots();
    let repos = yaah_lib::repos::scan(&roots);
    println!("roots={roots:?} repos={} in {:?}", repos.len(), t.elapsed());
    for r in repos.iter().take(12) {
        println!("  {:<28} {:<36} {}", r.name, r.remote.as_deref().unwrap_or("-"), r.branch.as_deref().unwrap_or("-"));
    }
}
