//! Fuzzy file search across a chat's folders, for @-mentions in the composer.

use serde::Serialize;
use std::path::{Path, PathBuf};

const SKIP: &[&str] = &[".git", "node_modules", "target", "_build", "deps", "dist", "build", ".next", ".venv", "__pycache__"];
const MAX_FILES: usize = 30_000;
const MAX_DEPTH: usize = 16;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatch {
    /// Absolute path.
    pub path: String,
    /// Path relative to its folder, prefixed with the folder name when the chat has several.
    pub label: String,
}

pub fn search(roots: &[PathBuf], query: &str, limit: usize) -> Vec<FileMatch> {
    let q = query.trim().to_lowercase();
    let several = roots.len() > 1;
    let mut scored = vec![];
    let mut seen = 0;
    for root in roots {
        let prefix = if several { root.file_name().map(|n| format!("{}/", n.to_string_lossy())).unwrap_or_default() } else { String::new() };
        walk(root, root, 0, &mut seen, &mut |path, rel| {
            let label = format!("{prefix}{rel}");
            if let Some(s) = score(&q, &label.to_lowercase()) {
                scored.push((s, FileMatch { path: path.to_string_lossy().into_owned(), label }));
            }
        });
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.label.len().cmp(&b.1.label.len())));
    scored.into_iter().take(limit).map(|(_, m)| m).collect()
}

fn walk(root: &Path, dir: &Path, depth: usize, seen: &mut usize, found: &mut dyn FnMut(&Path, &str)) {
    if depth > MAX_DEPTH || *seen >= MAX_FILES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for e in entries {
        let name = e.file_name();
        let name = name.to_string_lossy();
        let Ok(kind) = e.file_type() else { continue };
        if kind.is_dir() {
            // file_type() doesn't follow symlinks: linked folders (and files) stay out, so the walk stays inside the roots.
            if !SKIP.contains(&name.as_ref()) && (!name.starts_with('.') || name == ".github") {
                walk(root, &e.path(), depth + 1, seen, found);
            }
        } else if kind.is_file() {
            *seen += 1;
            let path = e.path();
            if let Ok(rel) = path.strip_prefix(root) {
                found(&path, &rel.to_string_lossy());
            }
        }
    }
}

/// Subsequence match; file-name hits and contiguous runs rank higher.
fn score(q: &str, target: &str) -> Option<i64> {
    let len = |s: &str| i64::try_from(s.len()).unwrap_or(i64::MAX);
    if q.is_empty() {
        return Some(0);
    }
    let file = target.rsplit('/').next().unwrap_or(target);
    if file.starts_with(q) {
        return Some(10_000 - len(file));
    }
    if let Some(at) = target.find(q) {
        return Some(5_000 - len(&target[..at]));
    }
    let (t, mut qi, mut last, mut bonus) = (target.as_bytes(), 0, usize::MAX - 1, 0i64);
    let qb = q.as_bytes();
    for (ti, &c) in t.iter().enumerate() {
        if qi < qb.len() && c == qb[qi] {
            if ti == last.wrapping_add(1) {
                bonus += 5;
            }
            last = ti;
            qi += 1;
        }
    }
    (qi == qb.len()).then_some(1_000 + bonus - len(target))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_files_by_fuzzy_name_and_skips_noise() {
        let root = std::env::temp_dir().join(format!("yaah-files-{}", std::process::id()));
        for p in ["src/components/chat.tsx", "src/lib/api.ts", "node_modules/x/chat.js", ".git/HEAD", "README.md"] {
            let f = root.join(p);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, "").unwrap();
        }
        let labels = |q: &str| search(std::slice::from_ref(&root), q, 10).into_iter().map(|m| m.label).collect::<Vec<_>>();
        assert_eq!(labels("chat"), vec!["src/components/chat.tsx"]);
        assert_eq!(labels("sla")[0], "src/lib/api.ts", "subsequence: s…l…a");
        assert!(labels("").iter().all(|l| !l.contains("node_modules") && !l.contains(".git")));
        std::fs::remove_dir_all(root).unwrap();
    }
}
