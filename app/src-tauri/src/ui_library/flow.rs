//! The `flow` primitive's rules beyond its prop types: nodes with unique ids, links between nodes
//! that exist, the caps per kind (a sankey 200 nodes and 1,000 links, a network 500 and 2,000),
//! values a sankey can draw, at most three network groups (the colours stay apart for colour-blind
//! readers), and a sankey that flows one way: a cycle is named, node by node. In step with
//! `src/components/ui-blocks/flow/flow-model.ts`. Bound values (`{{…}}`) pass.

use super::{is_binding, shown};
use serde_json::{Map, Value};
use std::collections::{BTreeSet, HashMap};

const MAX_GROUPS: usize = 3;
const ID_MAX: usize = 60;
const LABEL_MAX: usize = 60;
/// Errors listed for one array before the rest are summed up.
const ROW_ERRORS: usize = 8;

fn caps(kind: &str) -> (usize, usize) {
    if kind == "network" { (500, 2000) } else { (200, 1000) }
}

/// Errors for a `flow` node's props, after their types have been checked.
pub(crate) fn check(props: &Map<String, Value>, path: &str, errs: &mut Vec<String>) {
    let at = |k: &str| format!("{path}.props.{k}");
    let kind = match props.get("kind") {
        Some(v) if is_binding(v) => return,
        Some(Value::String(k)) if k == "sankey" || k == "network" => k.as_str(),
        // The prop types already said what kind must be.
        _ => return,
    };
    let (max_nodes, max_links) = caps(kind);
    if let Some(h) = props.get("height").filter(|v| !is_binding(v))
        && !h.as_f64().is_some_and(|h| (160.0..=900.0).contains(&h))
    {
        errs.push(format!("{}: 160 to 900 pixels, got {}", at("height"), shown(h)));
    }
    for (k, max) in [("unit", 12), ("title", 120)] {
        match props.get(k).filter(|v| !is_binding(v)) {
            Some(Value::String(s)) if s.chars().count() > max => errs.push(format!("{}: at most {max} characters", at(k))),
            _ => {}
        }
    }

    let Some(Value::Array(nodes)) = props.get("nodes").filter(|v| !is_binding(v)) else { return };
    let Some(ids) = check_nodes(nodes, kind, max_nodes, &at("nodes"), errs) else { return };
    let Some(Value::Array(links)) = props.get("links").filter(|v| !is_binding(v)) else { return };
    check_links(links, kind, max_links, &ids, &at("links"), errs);
}

/// The nodes: unique ids, known keys, tones, sizes and at most three groups. Their ids, or None when there are too many to go on.
fn check_nodes<'a>(nodes: &'a [Value], kind: &str, max_nodes: usize, at_nodes: &str, errs: &mut Vec<String>) -> Option<HashMap<&'a str, usize>> {
    if nodes.len() > max_nodes {
        errs.push(format!("{}: a {kind} takes at most {max_nodes} nodes, got {}; group the small ones into one", at_nodes, nodes.len()));
        return None;
    }
    let mut ids: HashMap<&str, usize> = HashMap::new();
    let mut groups = BTreeSet::new();
    let node_keys: &[&str] = if kind == "sankey" { &["id", "label", "tone"] } else { &["id", "label", "group", "size"] };
    let before = errs.len();
    for (i, n) in nodes.iter().enumerate() {
        if errs.len() - before >= ROW_ERRORS {
            errs.push(format!("{at_nodes}: more nodes have problems; fix the ones above first"));
            break;
        }
        let np = format!("{at_nodes}[{i}]");
        let Some(o) = n.as_object() else {
            errs.push(format!("{np}: {{ \"id\", \"label\"? }}, got {}", shown(n)));
            continue;
        };
        for k in o.keys().filter(|k| !node_keys.contains(&k.as_str())) {
            errs.push(format!("{np}: a {kind} node has no `{k}` (allowed: {})", node_keys.join(", ")));
        }
        match o.get("id") {
            Some(v) if is_binding(v) => {}
            Some(Value::String(id)) if !id.is_empty() && id.chars().count() <= ID_MAX => {
                if let Some(first) = ids.insert(id.as_str(), i) {
                    errs.push(format!("{np}.id \"{id}\" is already node {first}; ids are unique"));
                }
            }
            Some(v) => errs.push(format!("{np}.id: text, 1 to {ID_MAX} characters, got {}", shown(v))),
            None => errs.push(format!("{np}: needs `id`")),
        }
        if let Some(Value::String(l)) = o.get("label")
            && l.chars().count() > LABEL_MAX
        {
            errs.push(format!("{np}.label: at most {LABEL_MAX} characters"));
        }
        if let Some(t) = o.get("tone").filter(|v| !is_binding(v))
            && !matches!(t.as_str(), Some("default" | "success" | "warning" | "danger"))
        {
            errs.push(format!("{np}.tone: one of default, success, warning, danger, got {}", shown(t)));
        }
        if let Some(s) = o.get("size").filter(|v| !is_binding(v))
            && !s.as_f64().is_some_and(|s| s >= 0.0 && s.is_finite())
        {
            errs.push(format!("{np}.size: a number, 0 or more, got {}", shown(s)));
        }
        match o.get("group").filter(|v| !is_binding(v)) {
            None => {}
            Some(Value::String(g)) if g.chars().count() <= 40 => {
                groups.insert(g.clone());
            }
            Some(v) => errs.push(format!("{np}.group: text, at most 40 characters, got {}", shown(v))),
        }
    }
    if groups.len() > MAX_GROUPS {
        let list: Vec<&String> = groups.iter().collect();
        errs.push(format!(
            "{}: at most {MAX_GROUPS} groups (colours past three can't be told apart), got {} ({list:?}); merge some, or show them in the table",
            at_nodes,
            groups.len()
        ));
    }
    Some(ids)
}

/// The links: between nodes that exist, values a sankey can draw, no self-links, no sankey cycle.
fn check_links(links: &[Value], kind: &str, max_links: usize, ids: &HashMap<&str, usize>, at_links: &str, errs: &mut Vec<String>) {
    if links.len() > max_links {
        errs.push(format!("{}: a {kind} takes at most {max_links} links, got {}; aggregate them first", at_links, links.len()));
        return;
    }
    let mut edges: Vec<(&str, &str)> = vec![];
    let before = errs.len();
    for (i, l) in links.iter().enumerate() {
        if errs.len() - before >= ROW_ERRORS {
            errs.push(format!("{at_links}: more links have problems; fix the ones above first"));
            break;
        }
        let lp = format!("{at_links}[{i}]");
        let Some(o) = l.as_object() else {
            errs.push(format!("{lp}: {{ \"source\", \"target\", \"value\" }}, got {}", shown(l)));
            continue;
        };
        for k in o.keys().filter(|k| !matches!(k.as_str(), "source" | "target" | "value" | "label")) {
            errs.push(format!("{lp}: no `{k}` (allowed: source, target, value, label)"));
        }
        let end = |k: &str, errs: &mut Vec<String>| -> Option<&str> {
            match o.get(k) {
                Some(v) if is_binding(v) => None,
                Some(Value::String(id)) if ids.contains_key(id.as_str()) => Some(id.as_str()),
                Some(Value::String(id)) => {
                    errs.push(format!("{lp}.{k} \"{id}\" isn't a node; nodes are {}", node_list(ids)));
                    None
                }
                Some(v) => {
                    errs.push(format!("{lp}.{k}: a node id, got {}", shown(v)));
                    None
                }
                None => {
                    errs.push(format!("{lp}: needs `{k}`, a node id"));
                    None
                }
            }
        };
        let (s, t) = (end("source", errs), end("target", errs));
        match o.get("value") {
            Some(v) if is_binding(v) => {}
            Some(Value::Number(n)) if n.as_f64().is_some_and(|v| v.is_finite() && (v > 0.0 || (kind == "network" && v >= 0.0))) => {}
            None if kind == "network" => {}
            Some(v) => errs.push(format!(
                "{lp}.value: {}, got {}",
                if kind == "sankey" { "a number above 0 (the band's width)" } else { "a number, 0 or more" },
                shown(v)
            )),
            None => errs.push(format!("{lp}: needs `value`, how much flows (the band's width)")),
        }
        if let (Some(s), Some(t)) = (s, t) {
            if s == t {
                errs.push(format!("{lp}: goes from \"{s}\" to itself"));
            } else {
                edges.push((s, t));
            }
        }
    }
    if kind == "sankey"
        && let Some(cycle) = find_cycle(&edges)
    {
        errs.push(format!(
            "{}: the links form a cycle ({}); a sankey flows one way. Split the node that repeats into two stages (e.g. \"test\" and \"retest\"), or use a network",
            at_links,
            cycle.join(" → ")
        ));
    }
}

fn node_list(ids: &HashMap<&str, usize>) -> String {
    let mut v: Vec<(&&str, &usize)> = ids.iter().collect();
    v.sort_by_key(|(_, i)| **i);
    let names: Vec<String> = v.iter().take(8).map(|(id, _)| format!("\"{id}\"")).collect();
    if ids.len() > 8 { format!("{}, …", names.join(", ")) } else { names.join(", ") }
}

/// A cycle among the directed edges, as the ids round it (the first repeated at the end).
fn find_cycle<'a>(edges: &[(&'a str, &'a str)]) -> Option<Vec<&'a str>> {
    let mut out: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut order: Vec<&str> = vec![];
    for (s, t) in edges {
        for n in [s, t] {
            if !out.contains_key(n) {
                order.push(n);
                out.insert(n, vec![]);
            }
        }
        if let Some(v) = out.get_mut(s) {
            v.push(t);
        }
    }
    // 0 unseen, 1 on the current path, 2 done. Iterative, so a long chain can't overflow the stack.
    let mut state: HashMap<&str, u8> = HashMap::new();
    for start in order {
        if state.get(start).copied().unwrap_or(0) != 0 {
            continue;
        }
        let mut path: Vec<&str> = vec![start];
        let mut todo: Vec<(&str, usize)> = vec![(start, 0)];
        state.insert(start, 1);
        while let Some((node, next)) = todo.last_mut() {
            let node = *node;
            let Some(&to) = out[node].get(*next) else {
                state.insert(node, 2);
                path.pop();
                todo.pop();
                continue;
            };
            *next += 1;
            match state.get(to).copied().unwrap_or(0) {
                1 => {
                    let from = path.iter().position(|n| *n == to).unwrap_or(0);
                    let mut cycle = path[from..].to_vec();
                    cycle.push(to);
                    return Some(cycle);
                }
                0 => {
                    state.insert(to, 1);
                    path.push(to);
                    todo.push((to, 0));
                }
                _ => {}
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NONE: [String; 0] = [];

    fn errors(props: Value) -> Vec<String> {
        let mut errs = Vec::new();
        let Value::Object(props) = props else { panic!("props are an object") };
        check(&props, "$", &mut errs);
        errs
    }

    fn ci() -> Value {
        json!({ "kind": "sankey", "unit": " jobs",
            "nodes": [{ "id": "push", "label": "Push" }, { "id": "lint" }, { "id": "test" }, { "id": "build" }, { "id": "pass", "tone": "success" }, { "id": "fail", "tone": "danger" }],
            "links": [
                { "source": "push", "target": "lint", "value": 120 }, { "source": "push", "target": "test", "value": 120 },
                { "source": "lint", "target": "pass", "value": 112 }, { "source": "lint", "target": "fail", "value": 8 },
                { "source": "test", "target": "build", "value": 101 }, { "source": "test", "target": "fail", "value": 19 },
                { "source": "build", "target": "pass", "value": 101 }
            ] })
    }

    #[test]
    fn the_research_examples_pass() {
        assert_eq!(errors(ci()), NONE);
        let net = json!({ "kind": "network", "nodes": [
            { "id": "web", "group": "edge", "size": 3 }, { "id": "api", "group": "core", "size": 5 }, { "id": "db", "label": "postgres", "group": "data" }
        ], "links": [{ "source": "web", "target": "api", "value": 900 }, { "source": "api", "target": "db" }, { "source": "db", "target": "web" }] });
        assert_eq!(errors(net), NONE, "a network may loop back");
    }

    #[test]
    fn a_sankey_cycle_is_named() {
        let mut p = ci();
        p["links"].as_array_mut().unwrap().push(json!({ "source": "build", "target": "test", "value": 3 }));
        let errs = errors(p);
        assert_eq!(errs.len(), 1, "{errs:?}");
        assert!(errs[0].contains("cycle (test → build → test)"), "{errs:?}");
        assert!(errs[0].contains("flows one way"));
    }

    #[test]
    fn links_join_nodes_that_exist() {
        let errs = errors(json!({ "kind": "sankey", "nodes": [{ "id": "a" }, { "id": "b" }, { "id": "a" }], "links": [
            { "source": "a", "target": "c", "value": 1 }, { "source": "a", "target": "a", "value": 1 }, { "source": "a", "target": "b", "value": 0 }, { "source": "a", "target": "b" }
        ] }));
        for want in [
            "nodes[2].id \"a\" is already node 0",
            "links[0].target \"c\" isn't a node",
            "links[1]: goes from \"a\" to itself",
            "links[2].value: a number above 0",
            "links[3]: needs `value`",
        ] {
            assert!(errs.iter().any(|e| e.contains(want)), "{want} in {errs:?}");
        }
    }

    #[test]
    fn too_many_nodes_links_or_groups() {
        let nodes: Vec<Value> = (0..201).map(|i| json!({ "id": format!("n{i}") })).collect();
        assert!(errors(json!({ "kind": "sankey", "nodes": nodes, "links": [] }))[0].contains("at most 200 nodes, got 201"));
        let nodes: Vec<Value> = (0..501).map(|i| json!({ "id": format!("n{i}") })).collect();
        assert!(errors(json!({ "kind": "network", "nodes": nodes, "links": [] }))[0].contains("at most 500 nodes, got 501"));
        let links: Vec<Value> = (0..2001).map(|_| json!({ "source": "a", "target": "b" })).collect();
        assert!(errors(json!({ "kind": "network", "nodes": [{ "id": "a" }, { "id": "b" }], "links": links }))[0].contains("at most 2000 links"));
        let four: Vec<Value> = ["a", "b", "c", "d"].iter().map(|g| json!({ "id": g, "group": g })).collect();
        assert!(errors(json!({ "kind": "network", "nodes": four, "links": [] }))[0].contains("at most 3 groups"));
        assert!(errors(json!({ "kind": "sankey", "nodes": [{ "id": "a", "group": "x" }], "links": [] }))[0].contains("a sankey node has no `group`"));
    }

    #[test]
    fn a_long_chain_has_no_cycle_and_does_not_overflow() {
        let n = 200;
        let nodes: Vec<Value> = (0..n).map(|i| json!({ "id": format!("n{i}") })).collect();
        let links: Vec<Value> = (1..n).map(|i| json!({ "source": format!("n{}", i - 1), "target": format!("n{i}"), "value": 1 })).collect();
        assert_eq!(errors(json!({ "kind": "sankey", "nodes": nodes, "links": links })), NONE);
    }
}
