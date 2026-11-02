//! Inlining local files into rendered UI.
//!
//! Agents refer to screenshots and built pages by path. When UI is rendered,
//! the `src` of an `image` or `browser` node that is the absolute path of an
//! image or HTML file inside the chat's folders (or the system temp folder)
//! becomes a `data:` URL (images) or a preview URL (pages), so the transcript
//! holds a self-contained snapshot and the webview needs no file access.
//!
//! Only those two props: a path anywhere else (a form field's default, a file
//! list, text) stays a path, so nothing an agent reads back (`ui_get_values`)
//! carries a file's contents. A `src` is usually bound to a prop
//! (`"src": "{{shot}}"`), so the tree is walked the way the renderer resolves
//! it (`src/components/ui-bindings.ts`) to find which string, in the tree or
//! the props, ends up there.

use base64::Engine;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;

const MAX_BYTES: u64 = 10 * 1024 * 1024;
/// Nodes walked while looking for `src` props (`each` repeats its children per
/// item); past this the rest is left as it is.
const MAX_WALK: usize = 100_000;

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

/// Which document a string sits in, and where (a JSON pointer).
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Loc {
    Tree(String),
    Props(String),
}

impl Loc {
    fn child(&self, key: &str) -> Self {
        let key = key.replace('~', "~0").replace('/', "~1");
        match self {
            Self::Tree(p) => Self::Tree(format!("{p}/{key}")),
            Self::Props(p) => Self::Props(format!("{p}/{key}")),
        }
    }
}

/// A value as the renderer sees it once bindings are resolved; each string
/// remembers where it came from (`None`: built from several, like `"a {{x}}"`).
enum Sym {
    Str(String, Option<Loc>),
    List(Vec<Rc<Sym>>),
    Map(BTreeMap<String, Rc<Sym>>),
    Other,
}

type Scope = BTreeMap<String, Rc<Sym>>;

/// A JSON value that sits at `loc`, as a [`Sym`].
fn located(v: &Value, loc: &Loc) -> Rc<Sym> {
    Rc::new(match v {
        Value::String(s) => Sym::Str(s.clone(), Some(loc.clone())),
        Value::Array(items) => Sym::List(items.iter().enumerate().map(|(i, v)| located(v, &loc.child(&i.to_string()))).collect()),
        Value::Object(map) => Sym::Map(map.iter().map(|(k, v)| (k.clone(), located(v, &loc.child(k)))).collect()),
        _ => Sym::Other,
    })
}

/// `x.y.0` in `"{{ x.y.0 }}"`: a value that is one binding and nothing else.
fn exact_binding(s: &str) -> Option<&str> {
    let path = s.strip_prefix("{{")?.strip_suffix("}}")?.trim();
    (!path.is_empty() && path.chars().all(|c| c.is_alphanumeric() || "_.-".contains(c))).then_some(path)
}

/// `a.b.0.c` in scope, as `lookup` in ui-bindings.ts.
fn lookup(scope: &Scope, path: &str) -> Option<Rc<Sym>> {
    let mut parts = path.split('.');
    let mut v = scope.get(parts.next()?)?.clone();
    for k in parts {
        let next = match &*v {
            Sym::Map(m) => m.get(k)?.clone(),
            Sym::List(items) => items.get(k.parse::<usize>().ok()?)?.clone(),
            _ => return None,
        };
        v = next;
    }
    Some(v)
}

/// A tree value at `loc` with its bindings resolved against `scope`.
fn resolve(v: &Value, loc: &Loc, scope: &Scope) -> Rc<Sym> {
    match v {
        Value::String(s) => match exact_binding(s) {
            Some(path) => lookup(scope, path).unwrap_or_else(|| Rc::new(Sym::Other)),
            // Text with bindings in it is built from several values: never a path we inline.
            None if s.contains("{{") => Rc::new(Sym::Str(String::new(), None)),
            None => Rc::new(Sym::Str(s.clone(), Some(loc.clone()))),
        },
        Value::Array(items) => Rc::new(Sym::List(items.iter().enumerate().map(|(i, v)| resolve(v, &loc.child(&i.to_string()), scope)).collect())),
        Value::Object(map) => Rc::new(Sym::Map(map.iter().map(|(k, v)| (k.clone(), resolve(v, &loc.child(k), scope))).collect())),
        _ => Rc::new(Sym::Other),
    }
}

/// Collect where the `src` of each `image` and `browser` node comes from.
fn find_sources(node: &Value, loc: &Loc, scope: &Scope, walked: &mut usize, out: &mut Vec<Loc>) {
    *walked += 1;
    let Some(obj) = node.as_object().filter(|_| *walked <= MAX_WALK) else { return };
    let kids = |key: &str, scope: &Scope, walked: &mut usize, out: &mut Vec<Loc>| {
        for (i, kid) in obj.get(key).and_then(Value::as_array).into_iter().flatten().enumerate() {
            find_sources(kid, &loc.child(key).child(&i.to_string()), scope, walked, out);
        }
    };
    if let Some(each) = obj.get("each") {
        let items = each.as_str().and_then(|path| lookup(scope, path));
        let Some(Sym::List(items)) = items.as_deref() else { return };
        let name = obj.get("as").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("item");
        let index = obj.get("index").and_then(Value::as_str).filter(|s| !s.is_empty());
        for item in items {
            let mut inner = scope.clone();
            inner.insert(name.to_owned(), item.clone());
            if let Some(index) = index {
                inner.insert(index.to_owned(), Rc::new(Sym::Other));
            }
            kids("children", &inner, walked, out);
        }
        return;
    }
    if obj.contains_key("if") {
        // Either branch may show, depending on the data.
        kids("children", scope, walked, out);
        kids("else", scope, walked, out);
        return;
    }
    let no_props = Value::Object(serde_json::Map::new());
    let props = obj.get("props").unwrap_or(&no_props);
    match obj.get("type").and_then(Value::as_str) {
        Some("$component") => {
            // A library component sees only its own props.
            let inner = match &*resolve(props, &loc.child("props"), scope) {
                Sym::Map(m) => m.clone(),
                _ => Scope::new(),
            };
            if let Some(tree) = obj.get("tree") {
                find_sources(tree, &loc.child("tree"), &inner, walked, out);
            }
        }
        Some("image" | "browser") => {
            if let Some(src) = props.get("src")
                && let Sym::Str(s, Some(at)) = &*resolve(src, &loc.child("props").child("src"), scope)
                && s.starts_with('/')
            {
                out.push(at.clone());
            }
        }
        Some("live") => {
            // Its children see the source's data, never a path from props, under these names.
            let mut inner = scope.clone();
            let name = props.get("as").and_then(Value::as_str).filter(|s| !s.is_empty() && !s.contains("{{")).unwrap_or("data");
            inner.insert(name.to_owned(), Rc::new(Sym::Other));
            inner.insert("history".to_owned(), Rc::new(Sym::Other));
            kids("children", &inner, walked, out);
        }
        _ => kids("children", scope, walked, out),
    }
}

/// Inline the files that `image` and `browser` nodes in `tree` show: images
/// become data URLs, HTML files become whatever `serve_html` returns (a URL
/// serving the file's folder). Returns the refused paths, with the reason, for the agent.
pub fn inline(tree: &mut Value, props: &mut Value, roots: &[PathBuf], serve_html: &dyn Fn(&Path) -> Result<String, String>) -> Vec<String> {
    let roots: Vec<PathBuf> = roots.iter().chain(std::iter::once(&std::env::temp_dir())).filter_map(|r| r.canonicalize().ok()).collect();
    let scope = match &*located(props, &Loc::Props(String::new())) {
        Sym::Map(m) => m.clone(),
        _ => Scope::new(),
    };
    let mut found = vec![];
    find_sources(tree, &Loc::Tree(String::new()), &scope, &mut 0, &mut found);
    found.sort();
    found.dedup();
    let mut refused = vec![];
    for loc in found {
        let slot = match &loc {
            Loc::Tree(p) => tree.pointer_mut(p),
            Loc::Props(p) => props.pointer_mut(p),
        };
        let Some(Value::String(s)) = slot else { continue };
        if mime(Path::new(s.as_str())).is_none() {
            continue;
        }
        match resolve_file(s, &roots, serve_html) {
            Ok(url) => *s = url,
            Err(reason) => refused.push(format!("{s}: {reason}")),
        }
    }
    refused
}

fn resolve_file(path: &str, roots: &[PathBuf], serve_html: &dyn Fn(&Path) -> Result<String, String>) -> Result<String, String> {
    let real = Path::new(path).canonicalize().map_err(|_| "no such file".to_owned())?;
    if !roots.iter().any(|r| real.starts_with(r)) {
        return Err("outside this chat's folders and the temp folder".into());
    }
    if mime(&real).is_some_and(|m| m.starts_with("text/html")) {
        return serve_html(&real);
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

/// Folders a preview may not serve as a whole: the shared temp folders, where
/// other programs (and users, on Linux) leave files. A page there needs a folder of its own.
pub fn shared_temp_dir(dir: &Path) -> bool {
    let Ok(dir) = dir.canonicalize() else { return true };
    [std::env::temp_dir(), PathBuf::from("/tmp"), PathBuf::from("/var/tmp"), PathBuf::from("/dev/shm")]
        .iter()
        .filter_map(|t| t.canonicalize().ok())
        .any(|t| t == dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[allow(clippy::unnecessary_wraps, reason = "the shape `inline` takes: a real server can refuse")]
    fn served(p: &Path) -> Result<String, String> {
        Ok(format!("served:{}", p.display()))
    }

    fn temp_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("yaah-inline-{tag}-{}", crate::session::random_token()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn inlines_files_inside_roots_only() {
        let root = temp_root("roots");
        let page = root.join("index.html");
        std::fs::write(&page, "<h1>hi</h1>").unwrap();
        std::fs::write(root.join("shot.png"), [137u8, 80, 78, 71]).unwrap();

        let mut tree = json!({ "type": "stack", "children": [
            { "type": "browser", "props": { "src": page.to_string_lossy() } },
            { "type": "image", "props": { "src": root.join("shot.png").to_string_lossy(), "alt": "a" } },
            { "type": "image", "props": { "src": "/etc/hosts.png", "alt": "b" } },
            { "type": "image", "props": { "src": "/not/a/file", "alt": "c" } },
        ]});
        let refused = inline(&mut tree, &mut json!({}), std::slice::from_ref(&root), &served);
        assert!(tree["children"][0]["props"]["src"].as_str().unwrap().starts_with("served:"), "html is served, not inlined");
        assert!(tree["children"][1]["props"]["src"].as_str().unwrap().starts_with("data:image/png;base64,"));
        assert_eq!(tree["children"][3]["props"]["src"], "/not/a/file", "paths without a known extension are left alone");
        assert_eq!(refused.len(), 1, "{refused:?}");
        assert!(refused[0].starts_with("/etc/hosts.png: "), "{refused:?}");
        std::fs::remove_dir_all(root).unwrap();
    }

    /// The finding: a textfield default holding a path came back from
    /// `ui_get_values` as the file's contents. Only `src` of image and browser is inlined.
    #[test]
    fn only_image_and_browser_sources_are_inlined() {
        let root = temp_root("only-src");
        let shot = root.join("shot.png");
        std::fs::write(&shot, [137u8, 80, 78, 71]).unwrap();
        let shot = shot.to_string_lossy().into_owned();

        let mut tree = json!({ "type": "stack", "children": [
            { "type": "form", "children": [{ "type": "textfield", "props": { "name": "f", "label": "F", "default": shot } }] },
            { "type": "textfile", "props": { "text": "x", "path": shot } },
            { "type": "filetree", "props": { "paths": [shot] } },
            { "type": "textfield", "props": { "name": "g", "label": "G", "default": "{{bound}}" } },
            { "type": "image", "props": { "src": "{{shown}}", "alt": "a" } },
        ]});
        let mut props = json!({ "bound": shot, "shown": shot, "unused": shot });
        let refused = inline(&mut tree, &mut props, std::slice::from_ref(&root), &served);
        assert!(refused.is_empty(), "{refused:?}");
        assert_eq!(tree["children"][0]["children"][0]["props"]["default"], shot, "a form default stays a path");
        assert_eq!(tree["children"][1]["props"]["path"], shot);
        assert_eq!(tree["children"][2]["props"]["paths"][0], shot);
        assert_eq!(props["bound"], shot, "a prop bound to a textfield stays a path");
        assert_eq!(props["unused"], shot, "a prop nothing shows stays a path");
        assert!(props["shown"].as_str().unwrap().starts_with("data:image/png;base64,"), "a prop bound to an image src is inlined");
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Bindings are followed the way the renderer follows them: through library
    /// components' props, `each` items and nested fields.
    #[test]
    fn follows_bindings_through_components_and_lists() {
        let root = temp_root("bindings");
        std::fs::write(root.join("a.png"), [1u8]).unwrap();
        std::fs::write(root.join("b.png"), [2u8]).unwrap();
        std::fs::write(root.join("c.png"), [3u8]).unwrap();
        let path = |n: &str| root.join(n).to_string_lossy().into_owned();

        // A library component (`$component`, as `prepare` expands it) showing `{{shot}}`, inside an `each`.
        let gallery = json!({ "type": "$component", "name": "shot-card", "version": 1,
            "props": { "shot": "{{s.file}}", "caption": "{{s.file}}" },
            "tree": { "type": "card", "children": [
                { "type": "image", "props": { "src": "{{shot}}", "alt": "{{caption}}" } },
                { "type": "text", "props": { "text": "{{caption}}" } }
            ] } });
        let mut tree = json!({ "type": "stack", "children": [
            { "each": "shots", "as": "s", "children": [gallery] },
            { "type": "$component", "name": "one", "version": 1, "props": { "src": path("c.png") },
              "tree": { "type": "browser", "props": { "src": "{{src}}" } } },
            { "type": "image", "props": { "src": "{{dir}}/a.png", "alt": "built from text: left alone" } },
        ]});
        let mut props = json!({ "shots": [{ "file": path("a.png") }, { "file": path("b.png") }], "dir": root, "note": path("a.png") });
        let refused = inline(&mut tree, &mut props, std::slice::from_ref(&root), &served);
        assert!(refused.is_empty(), "{refused:?}");
        assert!(props["shots"][0]["file"].as_str().unwrap().starts_with("data:image/png;base64,AQ=="), "{}", props["shots"][0]);
        assert!(props["shots"][1]["file"].as_str().unwrap().starts_with("data:image/png;base64,Ag=="));
        assert!(tree["children"][1]["props"]["src"].as_str().unwrap().starts_with("data:image/png;base64,Aw=="), "a literal in a component's props");
        assert_eq!(props["note"], path("a.png"), "the same path elsewhere stays a path");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn binding_paths_resolve_like_the_renderer() {
        assert_eq!(exact_binding("{{ a.b-c.0 }}"), Some("a.b-c.0"));
        assert_eq!(exact_binding("{{a}} {{b}}"), None);
        assert_eq!(exact_binding("x {{a}}"), None);
        assert_eq!(exact_binding("{{}}"), None);
        let scope = match &*located(&json!({ "a": [{ "b": "/x.png" }] }), &Loc::Props(String::new())) {
            Sym::Map(m) => m.clone(),
            _ => unreachable!(),
        };
        assert!(matches!(lookup(&scope, "a.0.b").as_deref(), Some(Sym::Str(s, Some(Loc::Props(p)))) if s == "/x.png" && p == "/a/0/b"));
        assert!(lookup(&scope, "a.1.b").is_none());
        assert_eq!(Loc::Props(String::new()).child("a/b~c").child("0"), Loc::Props("/a~1b~0c/0".into()));
    }

    #[test]
    fn the_shared_temp_folders_are_never_served_whole() {
        assert!(shared_temp_dir(&std::env::temp_dir()));
        assert!(shared_temp_dir(Path::new("/tmp")));
        let own = temp_root("own");
        assert!(!shared_temp_dir(&own), "a folder of its own inside it is fine");
        assert!(shared_temp_dir(&own.join("missing")), "a folder that doesn't exist isn't served either");
        std::fs::remove_dir_all(own).unwrap();
    }
}
