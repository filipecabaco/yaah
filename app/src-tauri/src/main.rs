// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `yaah --version` answers before Tauri starts, so it works headless (install.sh's checks, no display).
    if matches!(std::env::args().nth(1).as_deref(), Some("--version" | "-V")) {
        println!("yaah {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    yaah_lib::run();
}
