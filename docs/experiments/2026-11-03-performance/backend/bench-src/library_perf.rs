//! Scratch-only benchmarks for the component library and installed libraries.
#![allow(clippy::all, clippy::pedantic, dead_code, unused)]

use super::*;
use crate::perf_util::*;
use crate::ui_library::{Bundled, Library, LocalDir};
use std::time::Instant;

const A: &str = "library";

/// A component of ~2.5 KB: a card with a 12-node body, bound to its props; every 4th uses `inner`.
pub(crate) fn component_json(name: &str, inner: Option<&str>) -> Value {
    let mut kids: Vec<Value> = (0..10).map(|i| json!({ "type": if i % 2 == 0 { "text" } else { "badge" }, "props": { "text": format!("{{{{label}}}} {i}") } })).collect();
    if let Some(inner) = inner {
        kids.push(json!({ "type": inner, "props": { "label": "{{label}}" } }));
    }
    json!({
        "name": name, "version": 1,
        "description": format!("The {name} component: shows a label with ten rows of text and badges, used for performance measurements of the library. {}", prose(120)),
        "props": { "type": "object", "properties": { "label": { "type": "string", "description": "What to show" }, "tone": { "type": "string" }, "count": { "type": "number" } }, "required": ["label"] },
        "tree": { "type": "card", "props": { "title": "{{label}}" }, "children": [{ "type": "stack", "children": kids }] },
        "examples": [{ "title": "one", "props": { "label": "hi" } }]
    })
}

/// Local collection of `local` components in `root/components`, and installed libraries:
/// `folder` components in a folder library `acme`, `git` in a git-kind library `beta`.
pub(crate) fn build(root: &Path, local: usize, folder: usize, git: usize) -> Library {
    let comps = root.join("components");
    for i in 0..local {
        let name = format!("loc-{i}");
        let inner = (i % 4 == 3).then(|| format!("loc-{}", i - 1));
        std::fs::create_dir_all(comps.join(&name)).unwrap();
        std::fs::write(comps.join(&name).join("component.json"), component_json(&name, inner.as_deref()).to_string()).unwrap();
    }
    let mut records = vec![];
    let write_lib = |dir: &Path, id: &str, n: usize| {
        std::fs::create_dir_all(dir.join("components")).unwrap();
        std::fs::write(dir.join(MANIFEST), json!({ "name": id, "title": format!("{id} components"), "description": "Perf", "version": "1.0.0" }).to_string()).unwrap();
        for i in 0..n {
            let name = format!("c-{i}");
            let inner = (i % 4 == 3).then(|| format!("{id}/c-{}", i - 1));
            std::fs::write(dir.join("components").join(format!("{name}.json")), component_json(&name, inner.as_deref()).to_string()).unwrap();
        }
    };
    if folder > 0 {
        let dir = root.join("folder-lib");
        write_lib(&dir, "acme", folder);
        records.push(json!({ "id": "acme", "source": { "kind": "folder", "path": dir }, "enabled": true, "installedAt": 0, "updatedAt": 0 }));
    }
    if git > 0 {
        write_lib(&root.join("libraries/beta"), "beta", git);
        records.push(json!({ "id": "beta", "source": { "kind": "git", "url": "https://example.com/beta.git" }, "commit": "abc", "enabled": true, "installedAt": 0, "updatedAt": 0 }));
    }
    std::fs::create_dir_all(root.join("config")).unwrap();
    std::fs::write(root.join("config/libraries.json"), Value::Array(records).to_string()).unwrap();
    let store = Store::at(root.join("config/libraries.json"), root.join("libraries"));
    let lib = Library::new(vec![Box::new(Bundled::new()), Box::new(LocalDir::new(comps))], Some(store));
    lib.reload();
    lib
}

#[test]
#[ignore]
fn perf_library() {
    for (local, folder, git) in [(0, 0, 0), (200, 0, 0), (200, 500, 0), (200, 0, 500)] {
        let root = tmp("lib");
        let t = Instant::now();
        let lib = build(&root, local, folder, git);
        let label = format!("{local} local + {} in a {} library", folder + git, if folder > 0 { "folder" } else if git > 0 { "git" } else { "no" });
        // reload() is what startup (Library::local) does; build() included writing the files, so time it alone.
        let r = bench(0, 3, || lib.reload());
        report("startup", &format!("Library reload ({label})"), r.mean / 1e3, "ms", "Library::local() at startup: Pack::load of every installed library");
        let n = lib.list().unwrap().len();
        let l = bench(1, 10, || {
            std::hint::black_box(lib.list().unwrap());
        });
        report(A, &format!("list() ({label}, {n} components)"), l.mean / 1e3, "ms", "re-reads every local component file, recomputes uses for all");
        let c = bench(1, 10, || {
            std::hint::black_box(lib.catalog().unwrap());
        });
        let size = lib.catalog().unwrap().to_string().len();
        report(A, &format!("catalog() ({label})"), c.mean / 1e3, "ms", &format!("{:.0} KB of JSON", size as f64 / 1e3));
        let rf = bench(1, 20, || lib.refresh_folders());
        report(A, &format!("refresh_folders() ({label})"), rf.mean, "us", "runs on every list/get/prepare/save");
        let ll = bench(1, 5, || {
            std::hint::black_box(lib.list_libraries().unwrap());
        });
        report(A, &format!("list_libraries() ({label})"), ll.mean / 1e3, "ms", "Component library page");
        let names = bench(1, 5, || {
            std::hint::black_box(crate::agent_guide::component_names(&lib));
        });
        report(A, &format!("agent_guide::component_names ({label})"), names.mean / 1e3, "ms", "per session/new (guide text) + per sync + ui_guide/resources/prompts");
        if local > 0 {
            let g = bench(1, 50, || {
                std::hint::black_box(lib.get("loc-3").unwrap());
            });
            report(A, &format!("get(local) ({label})"), g.mean, "us", "reads its file from disk");
            let p = bench(1, 50, || {
                std::hint::black_box(lib.prepare(Some("loc-3"), json!({ "label": "x" }), None).unwrap());
            });
            report(A, &format!("prepare(local component, 1 nested) ({label})"), p.mean, "us", "");
            // An ad-hoc tree of 250 local component references (x 13 nodes = 3250 > cap? keep under: 220 x 13 = 2860).
            let tree = json!({ "type": "stack", "children": (0..220).map(|i| json!({ "type": format!("loc-{}", (i * 4) % local), "props": { "label": "x" } })).collect::<Vec<_>>() });
            let p = bench(1, 10, || {
                std::hint::black_box(lib.prepare(None, json!({}), Some(tree.clone())).unwrap());
            });
            report(A, &format!("prepare(ad-hoc tree: 220 local component refs, ~2.9k expanded nodes) ({label})"), p.mean / 1e3, "ms", "validate resolves each ref from disk; expansion caches per call");
        }
        if folder + git > 0 {
            let id = if folder > 0 { "acme" } else { "beta" };
            let tree = json!({ "type": "stack", "children": (0..220).map(|i| json!({ "type": format!("{id}/c-{}", (i * 4) % 500), "props": { "label": "x" } })).collect::<Vec<_>>() });
            let p = bench(1, 10, || {
                std::hint::black_box(lib.prepare(None, json!({}), Some(tree.clone())).unwrap());
            });
            report(A, &format!("prepare(ad-hoc tree: 220 library refs, ~2.9k expanded nodes) ({label})"), p.mean / 1e3, "ms", "");
            let p = bench(1, 50, || {
                std::hint::black_box(lib.prepare(Some(&format!("{id}/c-7")), json!({ "label": "x" }), None).unwrap());
            });
            report(A, &format!("prepare(library component) ({label})"), p.mean, "us", "");
        }
        // Primitive-only tree at the node cap.
        let tree = json!({ "type": "stack", "children": (0..2990).map(|i| json!({ "type": "text", "props": { "text": format!("row {i}") } })).collect::<Vec<_>>() });
        let p = bench(1, 10, || {
            std::hint::black_box(lib.prepare(None, json!({}), Some(tree.clone())).unwrap());
        });
        report(A, &format!("prepare(ad-hoc 2,990 primitive nodes) ({label})"), p.mean / 1e3, "ms", "");
        let _ = std::fs::remove_dir_all(root);
    }
}
