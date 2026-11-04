//! The font families installed on the machine, for Settings → Appearance → Fonts,
//! and the CSS value a chosen family becomes.
//!
//! Only the system font folders are read (macOS: `/System/Library/Fonts`,
//! `/Library/Fonts`, `~/Library/Fonts`; Linux: the folders fontconfig names), with
//! `fontdb`, which reads each file's name table and nothing else. The list is made
//! once per run (warmed at start) and kept. When nothing could be read, a short
//! built-in list stands in.
//!
//! A family ends up in CSS (`--font-ui`, `--font-code` on the root), so a name is
//! only ever accepted when it is plain (letters, digits, spaces and `-_.+&'()`)
//! and is in that list or the built-in one, and it is always quoted and escaped
//! (`css_value`): a crafted `settings.json` can't add CSS.

use serde::Serialize;
use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Instant;

/// What a family is for: the interface's text, or code (code blocks, diffs, terminals).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Slot {
    Ui,
    Code,
}

impl Slot {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "ui" => Ok(Self::Ui),
            "code" => Ok(Self::Code),
            _ => Err("a font is for \"ui\" or \"code\"".into()),
        }
    }

    pub fn key(self) -> &'static str {
        match self {
            Self::Ui => "ui",
            Self::Code => "code",
        }
    }

    /// What follows the chosen family, for characters it lacks (or if it's gone): today's look.
    fn fallback(self) -> &'static str {
        match self {
            Self::Ui => r#""Geist Variable", system-ui, sans-serif"#,
            Self::Code => r#""Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, "DejaVu Sans Mono", monospace"#,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Family {
    pub name: String,
    /// At least one of its faces is fixed-pitch (what the Code picker lists first).
    pub mono: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    pub families: Vec<Family>,
    /// How long the scan took.
    pub scan_ms: u64,
    /// Nothing could be read, so this is the built-in list.
    pub fallback: bool,
}

/// Families any macOS or Linux desktop is likely to have, for when scanning finds nothing.
#[cfg(target_os = "macos")]
const BUILT_IN: &[(&str, bool)] = &[
    ("Avenir Next", false),
    ("Georgia", false),
    ("Helvetica Neue", false),
    ("Times New Roman", false),
    ("Courier New", true),
    ("Menlo", true),
    ("Monaco", true),
];
#[cfg(not(target_os = "macos"))]
const BUILT_IN: &[(&str, bool)] = &[
    ("DejaVu Sans", false),
    ("DejaVu Serif", false),
    ("Liberation Sans", false),
    ("Noto Sans", false),
    ("DejaVu Sans Mono", true),
    ("Liberation Mono", true),
    ("Noto Sans Mono", true),
];

fn built_in() -> Vec<Family> {
    let mut v: Vec<Family> = BUILT_IN.iter().map(|(n, mono)| Family { name: (*n).to_owned(), mono: *mono }).collect();
    v.sort_by_cached_key(|f| f.name.to_lowercase());
    v
}

/// A family name yaah will put in CSS: plain characters only, of a sane length.
/// Names starting with `.` are macOS's private system faces (`.SF NS`), which web views refuse.
pub fn plain_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name.trim() == name
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_alphanumeric() || c == ' ' || "-_.+&'()".contains(c))
}

/// Fixed-pitch families whose files don't say so (Monaco's `post` table doesn't), by the usual words in their names.
fn mono_by_name(name: &str) -> bool {
    ["Courier", "Monaco", "Consolas"].iter().any(|w| name.contains(w))
        || name.split([' ', '-']).any(|w| w.ends_with("Mono") || ["Code", "Term", "Terminal", "Monospace", "Monospaced"].contains(&w))
}

/// Every family in the font files under `dirs` (recursively), de-duplicated and sorted.
pub fn scan(dirs: &[PathBuf]) -> Vec<Family> {
    let mut db = fontdb::Database::new();
    for d in dirs {
        db.load_fonts_dir(d);
    }
    families(&db)
}

fn families(db: &fontdb::Database) -> Vec<Family> {
    let mut by_name: BTreeMap<String, Family> = BTreeMap::new();
    for face in db.faces() {
        // The first name is the English (US) one where the font has it.
        let Some((name, _)) = face.families.first() else { continue };
        if !plain_name(name) {
            continue;
        }
        let f = by_name.entry(name.clone()).or_insert_with(|| Family { name: name.clone(), mono: false });
        f.mono |= face.monospaced || mono_by_name(name);
    }
    let mut v: Vec<Family> = by_name.into_values().collect();
    v.sort_by_cached_key(|f| (f.name.to_lowercase(), f.name.clone()));
    v
}

#[cfg(target_os = "macos")]
fn system_families() -> Vec<Family> {
    let mut dirs = vec![PathBuf::from("/System/Library/Fonts"), PathBuf::from("/Library/Fonts")];
    dirs.push(crate::accounts::home().join("Library/Fonts"));
    scan(&dirs)
}

#[cfg(not(target_os = "macos"))]
fn system_families() -> Vec<Family> {
    // fontconfig's own folders (fonts.conf), or the usual ones when there's no config.
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    families(&db)
}

/// The installed families: scanned on first use, then kept for the run.
pub fn installed() -> &'static Installed {
    static LIST: OnceLock<Installed> = OnceLock::new();
    LIST.get_or_init(|| {
        let start = Instant::now();
        let families = std::panic::catch_unwind(system_families).unwrap_or_default();
        let scan_ms = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX);
        if families.is_empty() {
            eprintln!("[fonts] no font families found; using the built-in list");
            return Installed { families: built_in(), scan_ms, fallback: true };
        }
        Installed { families, scan_ms, fallback: false }
    })
}

/// Scan now on a thread of its own, so Settings (and the first settings read) don't wait for it.
pub fn warm_in_background() {
    std::thread::spawn(|| {
        let list = installed();
        eprintln!("[fonts] {} families in {} ms", list.families.len(), list.scan_ms);
    });
}

/// A family the user may pick: plain, and installed (or built in).
pub fn valid_family(name: &str) -> bool {
    valid_in(name, &installed().families)
}

fn valid_in(name: &str, list: &[Family]) -> bool {
    plain_name(name) && (list.iter().any(|f| f.name == name) || BUILT_IN.iter().any(|(n, _)| *n == name))
}

/// `name` as one CSS string: quoted, with `"`, `\` and control characters escaped.
pub fn css_string(name: &str) -> String {
    let mut out = String::with_capacity(name.len() + 2);
    out.push('"');
    for c in name.chars() {
        match c {
            '"' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            c if c.is_control() => {
                let _ = write!(out, "\\{:x} ", u32::from(c));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The `font-family` value for a chosen family: it, then today's stack for that slot.
pub fn css_value(slot: Slot, family: &str) -> String {
    format!("{}, {}", css_string(family), slot.fallback())
}

/// Font files in a folder, for tests that need a real one.
#[cfg(test)]
fn some_font_file() -> Option<PathBuf> {
    fn walk(dir: &std::path::Path, depth: u8) -> Option<PathBuf> {
        for e in std::fs::read_dir(dir).ok()?.filter_map(Result::ok) {
            let p = e.path();
            let ext = p.extension().and_then(|x| x.to_str()).map(str::to_ascii_lowercase);
            if p.is_file() && matches!(ext.as_deref(), Some("ttf" | "otf")) {
                return Some(p);
            }
            if p.is_dir()
                && depth > 0
                && let Some(f) = walk(&p, depth - 1)
            {
                return Some(f);
            }
        }
        None
    }
    ["/System/Library/Fonts", "/usr/share/fonts", "/Library/Fonts"].iter().find_map(|d| walk(std::path::Path::new(d), 3))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_that_could_break_out_of_css_are_refused() {
        for ok in ["Georgia", "Courier New", "Avenir Next", "M+ 1p", "Fira Code (Retina)", "Noto Sans CJK JP", "ヒラギノ角ゴシック", "Tom's Hand"]
        {
            assert!(plain_name(ok), "{ok}");
        }
        for bad in [
            "",
            " Georgia",
            ".SF NS",
            r#"Arial"; } body { display: none } :root { --x: ""#,
            "Arial\\\"",
            "x;y",
            "a{b}",
            "url(https://evil.example/x)\"",
            "a\nb",
            "<script>",
            &"x".repeat(101),
        ] {
            assert!(!plain_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn css_values_are_quoted_and_escaped_and_keep_a_fallback() {
        assert_eq!(css_value(Slot::Ui, "Georgia"), r#""Georgia", "Geist Variable", system-ui, sans-serif"#);
        assert!(css_value(Slot::Code, "Menlo").starts_with(r#""Menlo", "Geist Mono", ui-monospace"#));
        assert!(css_value(Slot::Code, "Menlo").ends_with("monospace"));
        // Even if something unplain got this far, it stays one CSS string.
        assert_eq!(css_string(r#"a"b\c"#), r#""a\"b\\c""#);
        assert_eq!(css_string("a\nb"), "\"a\\a b\"");
    }

    #[test]
    fn only_installed_or_built_in_families_are_valid() {
        let list = vec![Family { name: "Georgia".into(), mono: false }, Family { name: "Menlo".into(), mono: true }];
        assert!(valid_in("Georgia", &list));
        assert!(!valid_in("georgia", &list), "names are exact");
        assert!(!valid_in("Comic Sans Nowhere", &list));
        assert!(valid_in(BUILT_IN[0].0, &[]), "the built-in list is always allowed");
        assert!(!valid_in(r#"Georgia"; color: red"#, &list));
        assert!(Slot::parse("ui").is_ok() && Slot::parse("code").is_ok() && Slot::parse("body").is_err());
    }

    #[test]
    fn monospace_families_are_known_by_name_too() {
        for mono in ["Monaco", "Fira Code", "JetBrains Mono", "Courier New", "Iosevka Term", "Cascadia Code", "SFMono", "Noto Sans Mono CJK JP"] {
            assert!(mono_by_name(mono), "{mono}");
        }
        for not in ["Georgia", "Avenir Next", "Helvetica Neue", "Monotype Corsiva", "Barcode Sans", "Termina"] {
            assert!(!mono_by_name(not), "{not}");
        }
    }

    #[test]
    fn the_built_in_list_is_sorted_and_has_monospace_families() {
        let b = built_in();
        assert!(b.windows(2).all(|w| w[0].name.to_lowercase() <= w[1].name.to_lowercase()));
        assert!(b.iter().any(|f| f.mono) && b.iter().any(|f| !f.mono));
        assert!(b.iter().all(|f| plain_name(&f.name)));
    }

    #[test]
    fn scanning_a_folder_lists_each_family_once_sorted_and_skips_broken_files() {
        let Some(font) = some_font_file() else {
            eprintln!("no system font to copy; skipped");
            return;
        };
        let dir = std::env::temp_dir().join(format!("yaah-fonts-{}", crate::random::token()));
        std::fs::create_dir_all(dir.join("nested")).unwrap();
        let ext = font.extension().unwrap().to_string_lossy().into_owned();
        std::fs::copy(&font, dir.join(format!("a.{ext}"))).unwrap();
        std::fs::copy(&font, dir.join(format!("nested/b.{ext}"))).unwrap();
        std::fs::write(dir.join("broken.ttf"), b"not a font").unwrap();
        std::fs::write(dir.join("notes.txt"), b"hello").unwrap();

        let start = Instant::now();
        let found = scan(std::slice::from_ref(&dir));
        eprintln!("scanned {} in {:?}: {found:?}", font.display(), start.elapsed());
        assert!(found.iter().any(|f| !f.name.is_empty()), "{} has a family", font.display());
        let mut names: Vec<&str> = found.iter().map(|f| f.name.as_str()).collect();
        let n = names.len();
        names.dedup();
        assert_eq!(names.len(), n, "each family once, though the file is there twice");
        assert!(found.windows(2).all(|w| w[0].name.to_lowercase() <= w[1].name.to_lowercase()), "sorted");
        assert!(found.iter().all(|f| plain_name(&f.name)));
        assert!(scan(&[dir.join("missing")]).is_empty(), "a missing folder is no families, not an error");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_installed_list_has_its_shape() {
        let list = installed();
        eprintln!("{} families in {} ms (fallback: {})", list.families.len(), list.scan_ms, list.fallback);
        assert!(list.families.len() > 1, "{} families", list.families.len());
        let v = serde_json::to_value(list).unwrap();
        assert!(v["families"][0]["name"].is_string() && v["families"][0]["mono"].is_boolean() && v["scanMs"].is_u64());
        let mut names: Vec<&str> = list.families.iter().map(|f| f.name.as_str()).collect();
        let n = names.len();
        names.dedup();
        assert_eq!(names.len(), n);
    }
}
