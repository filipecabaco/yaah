//! The window's layout, as the user left it: the split panes (a tree of row and
//! column splits, each pane showing a chat, a project, the component library, the
//! picker or the home screen) and the sidebar (hidden or not, its width). Saved in
//! `settings.json` (`layout`, `sidebar`) through `settings.rs`; read back checked,
//! with the panes on chats or projects deleted since dropped.
//!
//! The UI owns the tree's editing (`src/lib/layout.ts`); this is what it may save
//! and what comes back at start.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;

/// Panes at most (the UI stops splitting there too).
pub const MAX_PANES: usize = 16;
/// How deep splits nest at most; 16 panes never need more.
const MAX_DEPTH: usize = 16;
/// Pane and split ids are the UI's own short names (`p3`, `s2`).
const MAX_ID: usize = 64;
/// A divider never goes closer to an edge than this share of its split.
const RATIO_MIN: f64 = 0.05;
/// Width of the sidebar in CSS pixels.
pub const SIDEBAR_MIN: u32 = 220;
pub const SIDEBAR_MAX: u32 = 480;
pub const SIDEBAR_DEFAULT: u32 = 288;

/// What a pane shows. `None` (JSON `null`) is the home screen.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Content {
    Chat { id: String },
    Project { id: String },
    Components,
    Picker,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Dir {
    /// `a` left of `b`.
    Row,
    /// `a` above `b`.
    Column,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Node {
    Pane {
        id: String,
        content: Option<Content>,
    },
    Split {
        id: String,
        dir: Dir,
        /// `a`'s share of the split.
        ratio: f64,
        a: Box<Node>,
        b: Box<Node>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Layout {
    pub root: Node,
    /// The pane the keyboard and the sidebar act on.
    pub focused: String,
}

impl Node {
    fn panes<'a>(&'a self, out: &mut Vec<&'a str>) {
        match self {
            Self::Pane { id, .. } => out.push(id),
            Self::Split { a, b, .. } => {
                a.panes(out);
                b.panes(out);
            }
        }
    }

    /// Every id (panes and splits), and the deepest nesting.
    fn census<'a>(&'a self, depth: usize, ids: &mut Vec<&'a str>, deepest: &mut usize) {
        *deepest = (*deepest).max(depth);
        match self {
            Self::Pane { id, .. } => ids.push(id),
            Self::Split { id, a, b, .. } => {
                ids.push(id);
                a.census(depth + 1, ids, deepest);
                b.census(depth + 1, ids, deepest);
            }
        }
    }

    /// Without the panes `keep` rejects; a split left with one side becomes that side.
    fn pruned(self, keep: &impl Fn(Option<&Content>) -> bool) -> Option<Self> {
        match self {
            Self::Pane { ref content, .. } => keep(content.as_ref()).then_some(self),
            Self::Split { id, dir, ratio, a, b } => match (a.pruned(keep), b.pruned(keep)) {
                (Some(a), Some(b)) => Some(Self::Split { id, dir, ratio, a: Box::new(a), b: Box::new(b) }),
                (one, other) => one.or(other),
            },
        }
    }

    /// Ratios within bounds (a missing or broken one is an even split).
    fn with_sane_ratios(self) -> Self {
        match self {
            Self::Split { id, dir, ratio, a, b } => {
                let ratio = if ratio.is_finite() { ratio.clamp(RATIO_MIN, 1.0 - RATIO_MIN) } else { 0.5 };
                Self::Split { id, dir, ratio, a: Box::new(a.with_sane_ratios()), b: Box::new(b.with_sane_ratios()) }
            }
            pane @ Self::Pane { .. } => pane,
        }
    }
}

impl Layout {
    /// One pane on the home screen: what a first start shows.
    #[must_use]
    pub fn home() -> Self {
        Self { root: Node::Pane { id: "p1".into(), content: None }, focused: "p1".into() }
    }

    pub fn pane_ids(&self) -> Vec<&str> {
        let mut out = vec![];
        self.root.panes(&mut out);
        out
    }

    /// The layout if it's one the UI could have made: at most [`MAX_PANES`] panes, ids
    /// unique and short, not nested past [`MAX_DEPTH`]. Ratios are brought within
    /// bounds and a focus on no pane moves to the first.
    pub fn checked(self) -> Result<Self, String> {
        let (mut ids, mut deepest) = (vec![], 0);
        self.root.census(0, &mut ids, &mut deepest);
        if deepest > MAX_DEPTH {
            return Err(format!("panes nest at most {MAX_DEPTH} deep"));
        }
        let panes = self.pane_ids().len();
        if panes > MAX_PANES {
            return Err(format!("{panes} panes; at most {MAX_PANES}"));
        }
        if let Some(bad) = ids.iter().find(|id| id.is_empty() || id.len() > MAX_ID || id.chars().any(char::is_control)) {
            return Err(format!("not a pane id: {bad:?}"));
        }
        let mut seen = HashSet::new();
        if let Some(dup) = ids.iter().find(|id| !seen.insert(**id)) {
            return Err(format!("two panes or splits are called {dup}"));
        }
        let root = self.root.with_sane_ratios();
        let mut panes = vec![];
        root.panes(&mut panes);
        let focused = if panes.contains(&self.focused.as_str()) { self.focused } else { panes[0].to_owned() };
        Ok(Self { root, focused })
    }

    /// Without the panes on chats or projects that are gone (`chat_exists`,
    /// `project_exists`), their neighbours taking the space. The home pane when none is left.
    #[must_use]
    pub fn pruned(self, chat_exists: impl Fn(&str) -> bool, project_exists: impl Fn(&str) -> bool) -> Self {
        let keep = |c: Option<&Content>| match c {
            Some(Content::Chat { id }) => chat_exists(id),
            Some(Content::Project { id }) => project_exists(id),
            _ => true,
        };
        let focused = self.focused;
        let Some(root) = self.root.pruned(&keep) else { return Self::home() };
        let mut ids = vec![];
        root.panes(&mut ids);
        let focused = if ids.contains(&focused.as_str()) { focused } else { ids[0].to_owned() };
        Self { root, focused }
    }
}

/// The sidebar: hidden to a strip or not, and its width.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sidebar {
    pub collapsed: bool,
    pub width: u32,
}

impl Default for Sidebar {
    fn default() -> Self {
        Self { collapsed: false, width: SIDEBAR_DEFAULT }
    }
}

impl Sidebar {
    pub fn new(collapsed: bool, width: u32) -> Self {
        Self { collapsed, width: width.clamp(SIDEBAR_MIN, SIDEBAR_MAX) }
    }

    /// From `settings.json`; anything missing or odd reads as the default, a width out of range is brought in.
    pub fn from_saved(v: Option<&Value>) -> Self {
        let Some(v) = v else { return Self::default() };
        let collapsed = v["collapsed"].as_bool().unwrap_or(false);
        let width = v["width"].as_u64().map_or(SIDEBAR_DEFAULT, |w| u32::try_from(w).unwrap_or(SIDEBAR_MAX));
        Self::new(collapsed, width)
    }
}

/// A saved layout, if there is one the UI could have made.
pub fn from_saved(v: Option<&Value>) -> Option<Layout> {
    serde_json::from_value::<Layout>(v?.clone()).ok()?.checked().ok()
}

/// What the UI starts with: `{ panes, sidebar }`, `panes` null when none was saved.
pub fn for_ui(saved: Option<Layout>, sidebar: Sidebar, chat_exists: impl Fn(&str) -> bool, project_exists: impl Fn(&str) -> bool) -> Value {
    json!({
        "panes": saved.map(|l| l.pruned(chat_exists, project_exists)),
        "sidebar": sidebar,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[allow(clippy::needless_pass_by_value, reason = "reads like the JSON it builds")]
    fn pane(id: &str, content: Value) -> Value {
        json!({ "type": "pane", "id": id, "content": content })
    }

    #[allow(clippy::needless_pass_by_value, reason = "reads like the JSON it builds")]
    fn split(id: &str, dir: &str, ratio: f64, a: Value, b: Value) -> Value {
        json!({ "type": "split", "id": id, "dir": dir, "ratio": ratio, "a": a, "b": b })
    }

    /// p1 (chat c1) | [ p2 (project pr1) / p3 (chat c2) ], focus on p3: what the UI sends.
    fn three() -> Value {
        json!({
            "root": split(
                "s1",
                "row",
                0.4,
                pane("p1", json!({ "kind": "chat", "id": "c1" })),
                split("s2", "column", 0.5, pane("p2", json!({ "kind": "project", "id": "pr1" })), pane("p3", json!({ "kind": "chat", "id": "c2" }))),
            ),
            "focused": "p3",
        })
    }

    #[test]
    fn a_layout_from_the_ui_round_trips() {
        let l = from_saved(Some(&three())).expect("valid");
        assert_eq!(l.pane_ids(), ["p1", "p2", "p3"]);
        assert_eq!(serde_json::to_value(&l).unwrap(), three(), "saved as the UI sent it");
        let other = json!({ "root": pane("p1", json!({ "kind": "picker" })), "focused": "p1" });
        assert_eq!(serde_json::to_value(from_saved(Some(&other)).unwrap()).unwrap(), other);
        let home = json!({ "root": pane("p1", Value::Null), "focused": "p1" });
        assert_eq!(from_saved(Some(&home)), Some(Layout::home()), "null content is the home screen");
    }

    #[test]
    fn panes_on_deleted_chats_or_projects_are_dropped() {
        let l = from_saved(Some(&three())).unwrap();
        // c2 was deleted: p3 goes, p2 takes its split's place, the focus moves to the first pane.
        let pruned = l.clone().pruned(|c| c == "c1", |_| true);
        assert_eq!(pruned.pane_ids(), ["p1", "p2"]);
        assert_eq!(pruned.focused, "p1");
        let Node::Split { ratio, b, .. } = &pruned.root else { panic!("still split") };
        assert!((ratio - 0.4).abs() < f64::EPSILON, "the outer divider stays where it was");
        assert!(matches!(**b, Node::Pane { ref id, .. } if id == "p2"));

        // The project went too: one pane.
        let one = l.clone().pruned(|c| c == "c1", |_| false);
        assert_eq!(one.root, Node::Pane { id: "p1".into(), content: Some(Content::Chat { id: "c1".into() }) });
        // Everything gone: home.
        assert_eq!(l.clone().pruned(|_| false, |_| false), Layout::home());
        // Nothing gone: unchanged, focus kept.
        assert_eq!(l.clone().pruned(|_| true, |_| true), l);
    }

    #[test]
    fn what_the_ui_could_not_have_made_is_refused() {
        let dup = json!({ "root": split("s1", "row", 0.5, pane("p1", Value::Null), pane("p1", Value::Null)), "focused": "p1" });
        assert!(from_saved(Some(&dup)).is_none(), "duplicate ids");
        let bad_kind = json!({ "root": pane("p1", json!({ "kind": "terminal" })), "focused": "p1" });
        assert!(from_saved(Some(&bad_kind)).is_none(), "an unknown kind of content");
        let empty_id = json!({ "root": pane("", Value::Null), "focused": "" });
        assert!(from_saved(Some(&empty_id)).is_none());
        assert!(from_saved(Some(&json!("nonsense"))).is_none());
        assert!(from_saved(None).is_none());

        // 17 panes: one too many.
        let mut node = pane("p0", Value::Null);
        for i in 1..=MAX_PANES {
            node = split(&format!("s{i}"), "row", 0.5, node, pane(&format!("p{i}"), Value::Null));
        }
        let err = serde_json::from_value::<Layout>(json!({ "root": node, "focused": "p0" })).unwrap().checked().unwrap_err();
        assert!(err.contains("at most 16") || err.contains("nest"), "{err}");
    }

    #[test]
    fn ratios_and_focus_are_brought_back_in_range() {
        let wild = json!({
            "root": split("s1", "column", 3.0, pane("p1", Value::Null), split("s2", "row", -1.0, pane("p2", Value::Null), pane("p3", Value::Null))),
            "focused": "s1",
        });
        let l = from_saved(Some(&wild)).unwrap();
        let Node::Split { ratio, b, .. } = &l.root else { panic!() };
        assert!((ratio - 0.95).abs() < 1e-9);
        let Node::Split { ratio: inner, .. } = &**b else { panic!() };
        assert!((inner - 0.05).abs() < 1e-9);
        assert_eq!(l.focused, "p1", "a split can't have the focus; nor can a pane that isn't there");
    }

    #[test]
    fn the_sidebar_reads_back_within_bounds() {
        assert_eq!(Sidebar::from_saved(None), Sidebar { collapsed: false, width: SIDEBAR_DEFAULT });
        assert_eq!(Sidebar::from_saved(Some(&json!({ "collapsed": true, "width": 300 }))), Sidebar { collapsed: true, width: 300 });
        assert_eq!(Sidebar::from_saved(Some(&json!({ "width": 5000 }))).width, SIDEBAR_MAX);
        assert_eq!(Sidebar::from_saved(Some(&json!({ "width": 10 }))).width, SIDEBAR_MIN);
        assert_eq!(Sidebar::from_saved(Some(&json!({ "collapsed": "yes", "width": "wide" }))), Sidebar::default());
        assert_eq!(Sidebar::new(false, u32::MAX).width, SIDEBAR_MAX);
    }

    #[test]
    fn the_ui_gets_null_panes_until_something_was_saved() {
        let v = for_ui(None, Sidebar::default(), |_| true, |_| true);
        assert_eq!(v, json!({ "panes": null, "sidebar": { "collapsed": false, "width": SIDEBAR_DEFAULT } }));
        let v = for_ui(from_saved(Some(&three())), Sidebar::new(true, 240), |c| c != "c1", |_| true);
        assert_eq!(v["panes"]["root"]["a"]["id"], "p2", "p1's chat is gone");
        assert_eq!(v["sidebar"], json!({ "collapsed": true, "width": 240 }));
    }
}
