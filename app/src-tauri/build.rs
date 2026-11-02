use std::fmt::Write;
use std::path::Path;

fn main() {
    bundle_components();
    tauri_build::build();
}

/// Components yaah ships live in `components/<name>.json`. Embed every one, so
/// launching a new one is adding a file (`ui_library::Bundled` reads the list).
fn bundle_components() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("components");
    println!("cargo:rerun-if-changed={}", dir.display());
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .map(|it| it.filter_map(Result::ok).map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect())
        .unwrap_or_default();
    files.sort();
    let mut out = String::from("&[\n");
    for f in &files {
        println!("cargo:rerun-if-changed={}", f.display());
        let name = f.file_stem().unwrap_or_default().to_string_lossy();
        let _ = writeln!(out, "    ({name:?}, include_str!({:?})),", f.display().to_string());
    }
    out.push(']');
    let target = Path::new(&std::env::var("OUT_DIR").expect("cargo sets OUT_DIR")).join("bundled_components.rs");
    std::fs::write(target, out).expect("write bundled_components.rs");
}
