//! Inlining local files into rendered UI.
//!
//! Agents refer to screenshots and built pages by path. When UI is rendered,
//! any value that is the absolute path of an image or HTML file inside the
//! chat's folders (or the system temp folder) becomes a `data:` URL, so the
//! transcript holds a self-contained snapshot and the webview needs no file
//! access.

use base64::Engine;
use serde_json::Value;
use std::path::{Path, PathBuf};

const MAX_BYTES: u64 = 10 * 1024 * 1024;

fn mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "html" | "htm" => "text/html;charset=utf-8",
        _ => return None,
    })
}

/// Replace qualifying path strings anywhere in `value`: images become data URLs,
/// HTML files become whatever `serve_html` returns (a URL serving the file's
/// folder). Returns the refused paths, with the reason, for the agent.
pub fn inline(value: &mut Value, roots: &[PathBuf], serve_html: &dyn Fn(&Path) -> String) -> Vec<String> {
    let roots: Vec<PathBuf> = roots.iter().chain(std::iter::once(&std::env::temp_dir())).filter_map(|r| r.canonicalize().ok()).collect();
    let mut refused = vec![];
    walk(value, &roots, serve_html, &mut refused);
    refused
}

fn walk(value: &mut Value, roots: &[PathBuf], serve_html: &dyn Fn(&Path) -> String, refused: &mut Vec<String>) {
    match value {
        Value::String(s) if s.starts_with('/') && mime(Path::new(s.as_str())).is_some() => match resolve(s, roots, serve_html) {
            Ok(url) => *s = url,
            Err(reason) => refused.push(format!("{s}: {reason}")),
        },
        Value::Array(items) => items.iter_mut().for_each(|v| walk(v, roots, serve_html, refused)),
        Value::Object(map) => map.values_mut().for_each(|v| walk(v, roots, serve_html, refused)),
        _ => {}
    }
}

fn resolve(path: &str, roots: &[PathBuf], serve_html: &dyn Fn(&Path) -> String) -> Result<String, String> {
    let real = Path::new(path).canonicalize().map_err(|_| "no such file".to_owned())?;
    if !roots.iter().any(|r| real.starts_with(r)) {
        return Err("outside this chat's folders and the temp folder".into());
    }
    if mime(&real).is_some_and(|m| m.starts_with("text/html")) {
        return Ok(serve_html(&real));
    }
    let meta = std::fs::metadata(&real).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if meta.len() > MAX_BYTES {
        return Err(format!("larger than {} MB", MAX_BYTES / 1024 / 1024));
    }
    let bytes = std::fs::read(&real).map_err(|e| e.to_string())?;
    let mime = mime(&real).expect("checked by caller");
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn inlines_files_inside_roots_only() {
        let root = std::env::temp_dir().join(format!("yaah-inline-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let page = root.join("index.html");
        std::fs::write(&page, "<h1>hi</h1>").unwrap();

        let mut v = json!({ "src": page.to_string_lossy(), "other": "/etc/hosts.png", "text": "/not/a/file" });
        std::fs::write(root.join("shot.png"), [137u8, 80, 78, 71]).unwrap();
        v["shot"] = json!(root.join("shot.png").to_string_lossy());
        let refused = inline(&mut v, std::slice::from_ref(&root), &|p| format!("served:{}", p.display()));
        assert!(v["src"].as_str().unwrap().starts_with("served:"), "html is served, not inlined");
        assert!(v["shot"].as_str().unwrap().starts_with("data:image/png;base64,"));
        assert_eq!(v["text"], "/not/a/file", "paths without a known extension are left alone");
        assert_eq!(refused.len(), 1, "{refused:?}");
        std::fs::remove_dir_all(root).unwrap();
    }
}
