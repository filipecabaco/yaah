//! The `map` primitive's rules beyond its prop types: what each `kind` takes (`markers`, today's
//! tile map and the default, with routes and clusters; `outline`, `choropleth`, `bubble`,
//! `connection` and `hexbin`, region maps on bundled geometry), the shape of every row, the caps,
//! coordinates in range, hub and marker ids that exist, and region ids that resolve in the chosen
//! region set (regions.rs), with near names when one doesn't. [`normalize`] then
//! rewrites the ids to the canonical ones before the tree reaches React. In step with
//! `src/components/ui-blocks/map/model.ts`. Bound values (`{{…}}`) pass; the renderer caps them.

use super::chart::check_scale;
use super::regions::{self, Miss, REGION_SETS};
use super::{is_binding, shown};
use serde_json::{Map, Value};
use std::collections::HashMap;

const KINDS: [&str; 6] = ["markers", "outline", "choropleth", "bubble", "connection", "hexbin"];
const MAX_HIGHLIGHT: usize = 100;
const MAX_OUTLINE_POINTS: usize = 200;
const MAX_BUBBLE_POINTS: usize = 500;
const MAX_DATA: usize = 3000;
const MAX_MARKERS: usize = 2000;
const MAX_LINES: usize = 50;
const MAX_LINE_POINTS: usize = 1000;
const MAX_HUBS: usize = 100;
const MAX_LINKS: usize = 200;
const MAX_HEX_POINTS: usize = 5000;
const ID_MAX: usize = 40;
const LABEL_MAX: usize = 60;
const DETAIL_MAX: usize = 200;
const TITLE_MAX: usize = 120;
/// Errors listed for one array before the rest are summed up.
const ROW_ERRORS: usize = 8;
const TONES: [&str; 4] = ["default", "success", "warning", "danger"];

/// Which props each kind takes, beyond `kind` and `height`.
fn own_props(kind: &str) -> &'static [&'static str] {
    match kind {
        "markers" => &["markers", "center", "zoom", "lines", "cluster"],
        "outline" => &["region", "view", "title", "legend", "labels", "highlight", "points", "borders"],
        "choropleth" => &["region", "view", "title", "legend", "labels", "data", "scale", "noDataLabel", "missing"],
        "connection" => &["region", "view", "title", "legend", "labels", "hubs", "links", "directed", "width", "unit"],
        "hexbin" => &["region", "view", "title", "legend", "labels", "points", "radius", "aggregate", "scale", "unit"],
        _ => &["region", "view", "title", "legend", "labels", "points", "maxRadius", "unit", "scale"],
    }
}

/// Errors for a `map` node's props, after their types have been checked.
pub(crate) fn check(props: &Map<String, Value>, path: &str, errs: &mut Vec<String>) {
    let at = |k: &str| format!("{path}.props.{k}");
    let given = |k: &str| props.get(k).filter(|v| !is_binding(v));
    let kind = match props.get("kind") {
        None => "markers",
        Some(v) if is_binding(v) => return,
        Some(Value::String(k)) if KINDS.contains(&k.as_str()) => k.as_str(),
        Some(v) => {
            errs.push(format!("{}: one of {KINDS:?}, got {}", at("kind"), shown(v)));
            return;
        }
    };
    let own = own_props(kind);
    for k in props.keys().filter(|k| !matches!(k.as_str(), "kind" | "height") && !own.contains(&k.as_str())) {
        let home: Vec<&str> = KINDS.iter().copied().filter(|x| own_props(x).contains(&k.as_str())).collect();
        let hint = match (kind, k.as_str()) {
            ("markers", _) => format!("it belongs to kind {home:?}; set `kind` to use it"),
            (_, "markers") => "a region map takes `points` ({ lon, lat, label }) instead".into(),
            (_, "center" | "zoom") => "a region map takes `view`: [west, south, east, north], or \"auto\"".into(),
            _ => format!("it belongs to kind {home:?}"),
        };
        errs.push(format!("{}: a {kind} map has no `{k}`; {hint}", at(k)));
    }
    if let Some(h) = given("height")
        && !h.as_f64().is_some_and(|h| (160.0..=900.0).contains(&h))
    {
        errs.push(format!("{}: 160 to 900 pixels, got {}", at("height"), shown(h)));
    }
    if kind == "markers" {
        check_markers(props, path, errs);
        return;
    }

    let region = match given("region") {
        None => Some("world"),
        Some(Value::String(r)) if REGION_SETS.contains(&r.as_str()) => Some(r.as_str()),
        Some(v) => {
            errs.push(format!("{}: one of {REGION_SETS:?} (the bundled geometry; no URLs), got {}", at("region"), shown(v)));
            None
        }
    };
    if kind == "connection" {
        check_connection(props, path, errs);
    } else if kind == "hexbin" {
        check_hexbin(props, path, errs);
    } else if props.get("region").is_some_and(is_binding) {
        // Ids can't be checked against a set we don't know yet.
        check_rows(props, kind, None, path, errs);
    } else {
        check_rows(props, kind, region, path, errs);
    }
    if let Some(v) = given("view") {
        check_view(v, &at("view"), errs);
    }
    text(given("title"), TITLE_MAX, &at("title"), errs);
    text(given("noDataLabel"), 40, &at("noDataLabel"), errs);
    text(given("unit"), 12, &at("unit"), errs);
    match given("legend") {
        None | Some(Value::Bool(_)) => {}
        Some(Value::Object(o)) => {
            for k in o.keys().filter(|k| *k != "title") {
                errs.push(format!("{}: no `{k}` (allowed: title)", at("legend")));
            }
            text(o.get("title").filter(|v| !is_binding(v)), 80, &format!("{}.title", at("legend")), errs);
        }
        Some(v) => errs.push(format!("{}: true, false or {{ \"title\" }}, got {}", at("legend"), shown(v))),
    }
    if let Some(r) = given("maxRadius")
        && !r.as_f64().is_some_and(|r| (6.0..=48.0).contains(&r))
    {
        errs.push(format!("{}: 6 to 48 pixels, got {}", at("maxRadius"), shown(r)));
    }
    if let Some(m) = given("missing")
        && !matches!(m.as_str(), Some("hatch" | "land"))
    {
        errs.push(format!("{}: \"hatch\" (no data) or \"land\" (outside the data), got {}", at("missing"), shown(m)));
    }
    check_phase2_options(props, path, errs);
    if let Some(b) = given("borders")
        && !matches!(b.as_str(), Some("countries" | "none"))
    {
        errs.push(format!("{}: \"countries\" or \"none\", got {}", at("borders"), shown(b)));
    }
    if let Some(scale) = given("scale") {
        check_scale(scale, &at("scale"), errs);
        if kind == "hexbin" && scale.get("type").is_some_and(|t| t == "categorical") {
            errs.push(format!("{}: a hexbin's cells hold amounts; use \"sequential\" (or \"diverging\" for a signed mean)", at("scale")));
        }
        if kind == "bubble" {
            let shaded = matches!(given("points"), Some(Value::Array(p)) if p.iter().any(|p| p.get("shade").is_some()));
            if !shaded && given("points").is_some() {
                errs.push(format!("{}: a bubble's size is its value; `scale` colours a second variable, so give points a `shade`", at("scale")));
            }
        }
    }
}

/// The street map: its markers, routes and clustering.
fn check_markers(props: &Map<String, Value>, path: &str, errs: &mut Vec<String>) {
    let at = |k: &str| format!("{path}.props.{k}");
    let given = |k: &str| props.get(k).filter(|v| !is_binding(v));
    match props.get("markers") {
        None => {
            errs.push(format!("{path}: a markers map needs `markers`: [{{ lat, lng, label }}] (or set `kind` to a region map: outline, choropleth, bubble, connection or hexbin)"));
        }
        Some(Value::Array(m)) if m.len() > MAX_MARKERS => errs.push(format!("{}: at most {MAX_MARKERS} markers, got {}", at("markers"), m.len())),
        _ => {}
    }
    check_lines(props, path, errs);
    if let Some(c) = given("cluster")
        && !(c.is_boolean() || c == "auto")
    {
        errs.push(format!("{}: true, false or \"auto\" (the default: from 40 markers), got {}", at("cluster"), shown(c)));
    }
}

/// The connection and hexbin options: `directed`, `width`, `radius`, `aggregate`.
fn check_phase2_options(props: &Map<String, Value>, path: &str, errs: &mut Vec<String>) {
    let at = |k: &str| format!("{path}.props.{k}");
    let given = |k: &str| props.get(k).filter(|v| !is_binding(v));
    if let Some(d) = given("directed")
        && !d.is_boolean()
    {
        errs.push(format!("{}: true or false, got {}", at("directed"), shown(d)));
    }
    if let Some(w) = given("width") {
        match w.as_str() {
            Some("fixed") => {}
            Some("value") => {
                let valued = matches!(given("links"), Some(Value::Array(l)) if l.iter().any(|l| l.get("value").is_some()));
                if !valued && given("links").is_some() {
                    errs.push(format!("{}: \"value\" draws links by their value, but no link has a `value`", at("width")));
                }
            }
            _ => errs.push(format!("{}: \"value\" or \"fixed\", got {}", at("width"), shown(w))),
        }
    }
    if let Some(r) = given("radius")
        && !r.as_f64().is_some_and(|r| (8.0..=40.0).contains(&r))
    {
        errs.push(format!("{}: the hexagon's radius, 8 to 40 pixels, got {}", at("radius"), shown(r)));
    }
    if let Some(a) = given("aggregate") {
        match a.as_str() {
            Some("count") => {}
            Some("sum" | "mean") => {
                let weighted = matches!(given("points"), Some(Value::Array(p)) if p.iter().any(|p| p.get("weight").is_some()));
                if !weighted && given("points").is_some() {
                    errs.push(format!("{}: {} adds up the points' `weight`, but no point has one", at("aggregate"), shown(a)));
                }
            }
            _ => errs.push(format!("{}: \"count\", \"sum\" or \"mean\" (of `weight`), got {}", at("aggregate"), shown(a))),
        }
    }
}

fn text(v: Option<&Value>, max: usize, path: &str, errs: &mut Vec<String>) {
    match v {
        None => {}
        Some(Value::String(s)) if s.chars().count() <= max => {}
        Some(Value::String(_)) => errs.push(format!("{path}: at most {max} characters")),
        Some(v) => errs.push(format!("{path}: text, got {}", shown(v))),
    }
}

fn check_view(v: &Value, path: &str, errs: &mut Vec<String>) {
    if v == "auto" {
        return;
    }
    let ok = match v.as_array().map(Vec::as_slice) {
        Some([west, south, east, north]) => match (west.as_f64(), south.as_f64(), east.as_f64(), north.as_f64()) {
            (Some(west), Some(south), Some(east), Some(north)) => {
                (-180.0..=180.0).contains(&west)
                    && (-180.0..=180.0).contains(&east)
                    && west < east
                    && (-90.0..=90.0).contains(&south)
                    && (-90.0..=90.0).contains(&north)
                    && south < north
            }
            _ => false,
        },
        _ => false,
    };
    if !ok {
        errs.push(format!("{path}: \"auto\", or [west, south, east, north] in degrees (west < east, south < north), got {}", shown(v)));
    }
}

/// `{ lon, lat }` in range, finite.
fn check_coords(o: &Map<String, Value>, path: &str, errs: &mut Vec<String>) {
    for (k, range) in [("lon", 180.0), ("lat", 90.0)] {
        match o.get(k) {
            Some(v) if is_binding(v) => {}
            Some(Value::Number(n)) if n.as_f64().is_some_and(|x| x.abs() <= range) => {}
            Some(v) => errs.push(format!("{path}.{k}: a number from -{range} to {range}, got {}", shown(v))),
            None => errs.push(format!("{path}: needs `{k}`")),
        }
    }
}

/// The row arrays of a region map: their caps, their keys, their values, and their ids in `region`.
fn check_rows(props: &Map<String, Value>, kind: &str, region: Option<&str>, path: &str, errs: &mut Vec<String>) {
    let set = region.and_then(regions::set);
    let arrays: &[(&str, usize, &[&str])] = match kind {
        "outline" => &[
            ("highlight", MAX_HIGHLIGHT, &["id", "label", "detail", "tone"]),
            ("points", MAX_OUTLINE_POINTS, &["id", "lon", "lat", "label", "detail", "tone"]),
        ],
        "choropleth" => &[("data", MAX_DATA, &["id", "value", "label", "detail"])],
        _ => &[("points", MAX_BUBBLE_POINTS, &["id", "lon", "lat", "value", "label", "detail", "shade"])],
    };
    if kind == "choropleth" && !props.contains_key("data") {
        errs.push(format!("{path}: a choropleth needs `data`: [{{ id, value }}], one row per region"));
    }
    if kind == "bubble" && !props.contains_key("points") {
        errs.push(format!("{path}: a bubble map needs `points`: [{{ lon, lat, value, label }}]"));
    }
    for (name, cap, allowed) in arrays {
        let Some(v) = props.get(*name).filter(|v| !is_binding(v)) else { continue };
        let at = format!("{path}.props.{name}");
        let Some(rows) = v.as_array() else {
            errs.push(format!("{at}: an array of rows, got {}", shown(v)));
            continue;
        };
        if rows.len() > *cap {
            errs.push(format!("{at}: at most {cap} rows, got {}; aggregate them first", rows.len()));
            continue;
        }
        let before = errs.len();
        let mut seen: HashMap<String, usize> = HashMap::new();
        for (i, row) in rows.iter().enumerate() {
            if errs.len() - before >= ROW_ERRORS {
                errs.push(format!("{at}: more rows have problems; fix the ones above first"));
                break;
            }
            let rp = format!("{at}[{i}]");
            let Some(o) = row.as_object() else {
                errs.push(format!("{rp}: an object, got {}", shown(row)));
                continue;
            };
            for k in o.keys().filter(|k| !allowed.contains(&k.as_str())) {
                errs.push(format!("{rp}: no `{k}` (allowed: {})", allowed.join(", ")));
            }
            for (k, max) in [("label", LABEL_MAX), ("detail", DETAIL_MAX)] {
                text(o.get(k).filter(|v| !is_binding(v)), max, &format!("{rp}.{k}"), errs);
            }
            if let Some(t) = o.get("tone").filter(|v| !is_binding(v))
                && !t.as_str().is_some_and(|t| TONES.contains(&t))
            {
                errs.push(format!("{rp}.tone: one of {TONES:?}, got {}", shown(t)));
            }
            if *name == "points" {
                check_coords(o, &rp, errs);
                if kind == "bubble" {
                    match o.get("value") {
                        Some(v) if is_binding(v) => {}
                        Some(Value::Number(n)) if n.as_f64().is_some_and(|x| x >= 0.0) => {}
                        Some(v) => errs.push(format!("{rp}.value: a number, 0 or more (a bubble's area is its value), got {}", shown(v))),
                        None => errs.push(format!("{rp}: needs `value`, the bubble's size")),
                    }
                    if !o.contains_key("label") {
                        errs.push(format!("{rp}: needs `label`, the place's name"));
                    }
                    if let Some(s) = o.get("shade").filter(|v| !is_binding(v))
                        && !s.as_f64().is_some_and(f64::is_finite)
                    {
                        errs.push(format!("{rp}.shade: a number, got {}", shown(s)));
                    }
                }
                continue;
            }
            if *name == "data" {
                match o.get("value") {
                    Some(v) if is_binding(v) || v.is_null() => {}
                    Some(Value::Number(n)) if n.as_f64().is_some_and(f64::is_finite) => {}
                    Some(v) => errs.push(format!("{rp}.value: a number, or null for no data, got {}", shown(v))),
                    None => errs.push(format!("{rp}: needs `value` (a number, or null for no data)")),
                }
            }
            let Some(id) = o.get("id") else {
                errs.push(format!("{rp}: needs `id`, the region"));
                continue;
            };
            if is_binding(id) {
                continue;
            }
            let (Some(set), Some(region)) = (set, region) else { continue };
            match set.resolve(id) {
                Ok(canonical) => {
                    if let Some(first) = seen.insert(canonical.to_owned(), i) {
                        errs.push(format!("{rp}.id {} is the same region as row {first} ({canonical}); one row per region", shown(id)));
                    }
                }
                Err(Miss::NotAnId) => {
                    errs.push(format!("{rp}.id: a region id or name (text, or a whole number for a numeric code), got {}", shown(id)));
                }
                Err(Miss::Ambiguous) => errs.push(format!("{rp}.id {} names more than one region in {region}; use its ISO code", shown(id))),
                Err(Miss::Unknown(near)) if near.is_empty() => errs.push(format!("{rp}.id {} is not in {region}", shown(id))),
                Err(Miss::Unknown(near)) => errs.push(format!("{rp}.id {} is not in {region}, did you mean {}?", shown(id), near.join(" or "))),
            }
        }
    }
}

/// A literal array prop's rows, or nothing (absent, bound, or not an array: that is said).
fn rows<'a>(props: &'a Map<String, Value>, name: &str, cap: usize, path: &str, errs: &mut Vec<String>) -> Option<&'a Vec<Value>> {
    let v = props.get(name).filter(|v| !is_binding(v))?;
    let at = format!("{path}.props.{name}");
    let Some(rows) = v.as_array() else {
        errs.push(format!("{at}: an array of rows, got {}", shown(v)));
        return None;
    };
    if rows.len() > cap {
        errs.push(format!("{at}: at most {cap} rows, got {}; aggregate them first", rows.len()));
        return None;
    }
    Some(rows)
}

/// Each row an object with only `allowed` keys; `each` checks the rest. Stops after `ROW_ERRORS`.
fn each_row(
    rows: &[Value],
    at: &str,
    allowed: &[&str],
    errs: &mut Vec<String>,
    mut each: impl FnMut(usize, &Map<String, Value>, &str, &mut Vec<String>),
) {
    let before = errs.len();
    for (i, row) in rows.iter().enumerate() {
        if errs.len() - before >= ROW_ERRORS {
            errs.push(format!("{at}: more rows have problems; fix the ones above first"));
            break;
        }
        let rp = format!("{at}[{i}]");
        let Some(o) = row.as_object() else {
            errs.push(format!("{rp}: an object, got {}", shown(row)));
            continue;
        };
        for k in o.keys().filter(|k| !allowed.contains(&k.as_str())) {
            errs.push(format!("{rp}: no `{k}` (allowed: {})", allowed.join(", ")));
        }
        for (k, max) in [("label", LABEL_MAX), ("detail", DETAIL_MAX)] {
            text(o.get(k).filter(|v| !is_binding(v)), max, &format!("{rp}.{k}"), errs);
        }
        each(i, o, &rp, errs);
    }
}

/// An id as text: a string up to `ID_MAX` characters, or a whole number. None when bound.
fn own_id(v: Option<&Value>, rp: &str, what: &str, errs: &mut Vec<String>) -> Option<String> {
    match v {
        None => {
            errs.push(format!("{rp}: needs `{what}`"));
            None
        }
        Some(v) if is_binding(v) => None,
        Some(Value::String(s)) if !s.trim().is_empty() && s.chars().count() <= ID_MAX => Some(s.clone()),
        Some(Value::Number(n)) if n.is_i64() || n.is_u64() => Some(n.to_string()),
        Some(v) => {
            errs.push(format!("{rp}.{what}: text up to {ID_MAX} characters, or a whole number, got {}", shown(v)));
            None
        }
    }
}

/// A connection map: hubs with unique ids and places, links between hubs that exist, no self-links, no repeats.
fn check_connection(props: &Map<String, Value>, path: &str, errs: &mut Vec<String>) {
    for need in ["hubs", "links"] {
        if !props.contains_key(need) {
            errs.push(format!("{path}: a connection map needs `hubs`: [{{ id, label, lon, lat }}] and `links`: [{{ from, to, value? }}]"));
            break;
        }
    }
    let mut hubs: HashMap<String, usize> = HashMap::new();
    let hubs_bound = props.get("hubs").is_some_and(is_binding);
    if let Some(rows) = rows(props, "hubs", MAX_HUBS, path, errs) {
        let at = format!("{path}.props.hubs");
        each_row(rows, &at, &["id", "label", "lon", "lat", "detail"], errs, |i, o, rp, errs| {
            check_coords(o, rp, errs);
            if let Some(id) = own_id(o.get("id"), rp, "id", errs)
                && let Some(first) = hubs.insert(id.clone(), i)
            {
                errs.push(format!("{rp}.id {id:?} is also hub {first}; hub ids are unique"));
            }
        });
    }
    let Some(rows) = rows(props, "links", MAX_LINKS, path, errs) else { return };
    let at = format!("{path}.props.links");
    let directed = props.get("directed") == Some(&Value::Bool(true));
    let mut seen: HashMap<(String, String), usize> = HashMap::new();
    // Ids are checked against the hubs only when those are literal and all of them were read.
    let known = !hubs_bound && props.get("hubs").and_then(Value::as_array).is_some_and(|h| h.len() <= MAX_HUBS);
    let mut names: Vec<&String> = hubs.keys().collect();
    names.sort();
    each_row(rows, &at, &["from", "to", "value", "label", "detail"], errs, |i, o, rp, errs| {
        match o.get("value") {
            None => {}
            Some(v) if is_binding(v) => {}
            Some(Value::Number(n)) if n.as_f64().is_some_and(|x| x.is_finite() && x >= 0.0) => {}
            Some(v) => errs.push(format!("{rp}.value: a number, 0 or more (the link's width), got {}", shown(v))),
        }
        let from = own_id(o.get("from"), rp, "from", errs);
        let to = own_id(o.get("to"), rp, "to", errs);
        for (end, id) in [("from", &from), ("to", &to)] {
            if let Some(id) = id
                && known
                && !hubs.contains_key(id)
            {
                let list: Vec<&str> = names.iter().take(8).map(|s| s.as_str()).collect();
                errs.push(format!("{rp}.{end} {id:?} is not a hub id (hubs: {}{})", list.join(", "), if names.len() > 8 { ", …" } else { "" }));
            }
        }
        let (Some(from), Some(to)) = (from, to) else { return };
        if from == to {
            errs.push(format!("{rp}: links {from:?} to itself; a link joins two hubs"));
            return;
        }
        let pair = if directed || from < to { (from, to) } else { (to, from) };
        if let Some(first) = seen.insert(pair.clone(), i) {
            errs.push(format!(
                "{rp}: the same {} as link {first} ({} – {}); add their values into one row",
                if directed { "route" } else { "pair" },
                pair.0,
                pair.1
            ));
        }
    });
}

/// A hexbin map: raw points, each in range, `weight` a number.
fn check_hexbin(props: &Map<String, Value>, path: &str, errs: &mut Vec<String>) {
    if !props.contains_key("points") {
        errs.push(format!("{path}: a hexbin map needs `points`: [{{ lon, lat, weight? }}], the raw places to bin"));
    }
    let Some(rows) = rows(props, "points", MAX_HEX_POINTS, path, errs) else { return };
    let at = format!("{path}.props.points");
    each_row(rows, &at, &["lon", "lat", "weight"], errs, |_, o, rp, errs| {
        check_coords(o, rp, errs);
        if let Some(w) = o.get("weight").filter(|v| !is_binding(v))
            && !w.as_f64().is_some_and(f64::is_finite)
        {
            errs.push(format!("{rp}.weight: a number, got {}", shown(w)));
        }
    });
}

/// A street map's routes: each 2 or more places, `[lat, lng]` or the `id` of a marker.
fn check_lines(props: &Map<String, Value>, path: &str, errs: &mut Vec<String>) {
    let Some(lines) = rows(props, "lines", MAX_LINES, path, errs) else { return };
    let mut ids: HashMap<String, usize> = HashMap::new();
    let markers = props.get("markers").filter(|v| !is_binding(v)).and_then(Value::as_array);
    for (i, m) in markers.into_iter().flatten().enumerate() {
        if let Some(id) = m.get("id").and_then(Value::as_str)
            && let Some(first) = ids.insert(id.to_owned(), i)
        {
            errs.push(format!("{path}.props.markers[{i}].id {id:?} is also marker {first}; a route needs ids that are unique"));
        }
    }
    let at = format!("{path}.props.lines");
    each_row(lines, &at, &["points", "label", "detail", "tone"], errs, |_, o, rp, errs| {
        if let Some(t) = o.get("tone").filter(|v| !is_binding(v))
            && !t.as_str().is_some_and(|t| TONES.contains(&t))
        {
            errs.push(format!("{rp}.tone: one of {TONES:?}, got {}", shown(t)));
        }
        let Some(points) = o.get("points") else {
            errs.push(format!("{rp}: needs `points`: [[lat, lng], …] or marker ids"));
            return;
        };
        if is_binding(points) {
            return;
        }
        let Some(points) = points.as_array() else {
            errs.push(format!("{rp}.points: an array of [lat, lng] or marker ids, got {}", shown(points)));
            return;
        };
        if !(2..=MAX_LINE_POINTS).contains(&points.len()) {
            errs.push(format!("{rp}.points: 2 to {MAX_LINE_POINTS} places, got {}", points.len()));
            return;
        }
        let before = errs.len();
        for (j, p) in points.iter().enumerate() {
            if errs.len() - before >= 3 {
                break;
            }
            let pp = format!("{rp}.points[{j}]");
            match p {
                v if is_binding(v) => {}
                Value::String(id) if markers.is_none() || ids.contains_key(id) => {}
                Value::String(id) => errs.push(format!("{pp} {id:?} is not a marker id (give the marker an `id`, or write [lat, lng])")),
                Value::Array(ll) => match ll.as_slice() {
                    [lat, lng] if lat.as_f64().is_some_and(|x| x.abs() <= 90.0) && lng.as_f64().is_some_and(|x| x.abs() <= 180.0) => {}
                    _ => errs.push(format!("{pp}: [lat, lng] (lat -90 to 90, lng -180 to 180), got {}", shown(p))),
                },
                _ => errs.push(format!("{pp}: [lat, lng] or a marker id, got {}", shown(p))),
            }
        }
    });
}

/// Rewrite a valid region map's literal ids to the canonical ones its geometry carries (PT → PRT,
/// "Pennsylvania" → PA), so React joins rows to regions without the alias table.
pub(crate) fn normalize(props: &mut Map<String, Value>) {
    let kind = props.get("kind").and_then(Value::as_str);
    if !matches!(kind, Some("outline" | "choropleth")) {
        return;
    }
    let region = match props.get("region") {
        None => "world",
        Some(Value::String(r)) if !r.contains("{{") => r.as_str(),
        _ => return,
    };
    let Some(set) = regions::set(region) else { return };
    for name in ["data", "highlight"] {
        let Some(Value::Array(rows)) = props.get_mut(name) else { continue };
        for row in rows {
            let Some(o) = row.as_object_mut() else { continue };
            let Some(id) = o.get("id") else { continue };
            if is_binding(id) {
                continue;
            }
            if let Ok(canonical) = set.resolve(id) {
                o.insert("id".into(), Value::String(canonical.to_owned()));
            }
        }
    }
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

    #[test]
    fn the_research_examples_pass() {
        let outline = json!({ "kind": "outline", "region": "europe", "title": "Edge locations",
            "highlight": [{ "id": "PT", "tone": "success" }, { "id": "DE", "tone": "success" }, { "id": "PL", "tone": "warning", "detail": "degraded" }],
            "points": [{ "lon": -9.14, "lat": 38.72, "label": "Lisbon" }, { "lon": 13.4, "lat": 52.52, "label": "Berlin" }], "labels": "all" });
        let choropleth = json!({ "kind": "choropleth", "region": "us-states", "title": "2024 margin by state",
            "data": [{ "id": "PA", "value": 1.7, "detail": "R +1.7" }, { "id": "MI", "value": 1.4 }, { "id": "VA", "value": -5.8 }, { "id": "WY", "value": 46.1 }],
            "scale": { "type": "diverging", "domain": [-20, 20], "midpoint": 0, "bins": 7, "unit": "pts" }, "legend": { "title": "Margin (R + / D -)" }, "labels": "auto" });
        let turnout = json!({ "kind": "choropleth", "region": "europe", "data": [{ "id": "BE", "value": 89.0 }, { "id": "MT", "value": null }], "scale": { "type": "sequential", "bins": 5, "unit": "%" }, "legend": true });
        let bubble = json!({ "kind": "bubble", "region": "europe", "title": "Store revenue by city",
            "points": [{ "lon": -9.14, "lat": 38.72, "label": "Lisbon", "value": 4.2 }, { "lon": 2.35, "lat": 48.86, "label": "Paris", "value": 7.9 }], "unit": "M EUR", "labels": "auto" });
        for p in [outline, choropleth, turnout, bubble] {
            assert_eq!(errors(p.clone()), NONE, "{p}");
        }
        assert_eq!(errors(json!({ "markers": [{ "lat": 1, "lng": 2 }] })), NONE, "markers stays the default");
    }

    #[test]
    fn bad_ids_say_what_was_meant() {
        let errs =
            errors(json!({ "kind": "choropleth", "region": "us-states", "data": [{ "id": "PA", "value": 1 }, { "id": "Pensilvania", "value": 2 }] }));
        assert_eq!(errs.len(), 1, "{errs:?}");
        assert!(errs[0].starts_with("$.props.data[1].id \"Pensilvania\" is not in us-states, did you mean \"Pennsylvania\" (PA)"), "{errs:?}");
        let dup = errors(
            json!({ "kind": "choropleth", "region": "us-states", "data": [{ "id": "PA", "value": 1 }, { "id": "Pennsylvania", "value": 2 }] }),
        );
        assert!(dup[0].contains("same region as row 0 (PA)"), "{dup:?}");
        let world = errors(json!({ "kind": "outline", "highlight": [{ "id": "Atlantis" }] }));
        assert!(world[0].contains("is not in world"), "{world:?}");
        assert!(errors(json!({ "kind": "choropleth", "region": "mars", "data": [] }))[0].contains("one of [\"world\", \"europe\", \"us-states\"]"));
        let bound = json!({ "kind": "choropleth", "region": "us-states", "data": [{ "id": "{{row.state}}", "value": 1 }] });
        assert_eq!(errors(bound), NONE, "bound ids are the renderer's to resolve");
    }

    #[test]
    fn props_belong_to_their_kind() {
        let e = errors(json!({ "kind": "choropleth", "data": [], "markers": [] }));
        assert!(e[0].contains("takes `points`"), "{e:?}");
        let e = errors(json!({ "data": [], "markers": [] }));
        assert!(e[0].contains("belongs to kind [\"choropleth\"]"), "{e:?}");
        assert!(errors(json!({ "kind": "bubble", "points": [], "center": [0, 0] }))[0].contains("takes `view`"));
        assert!(errors(json!({}))[0].contains("needs `markers`"));
        assert!(errors(json!({ "kind": "choropleth" }))[0].contains("needs `data`"));
        assert!(errors(json!({ "kind": "pie" }))[0].contains("one of"));
    }

    #[test]
    fn rows_have_a_shape_and_caps() {
        let e = errors(json!({ "kind": "bubble", "points": [
            { "lon": 200, "lat": 0, "label": "a", "value": 1 },
            { "lon": 0, "lat": 0, "label": "b", "value": -1 },
            { "lon": 0, "lat": 0, "value": 1 },
            { "lon": 0, "lat": 0, "label": "c", "value": 1, "color": "red" },
            { "lat": 0, "label": "d", "value": 1 }
        ] }));
        for want in ["points[0].lon", "points[1].value", "points[2]: needs `label`", "points[3]: no `color`", "points[4]: needs `lon`"] {
            assert!(e.iter().any(|x| x.contains(want)), "{want} in {e:?}");
        }
        let many: Vec<Value> = (0..=MAX_DATA).map(|i| json!({ "id": "PA", "value": i })).collect();
        assert!(errors(json!({ "kind": "choropleth", "region": "us-states", "data": many }))[0].contains("at most 3000 rows"));
        let tone = errors(json!({ "kind": "outline", "highlight": [{ "id": "PT", "tone": "red" }] }));
        assert!(tone[0].contains("tone"), "{tone:?}");
        assert!(errors(json!({ "kind": "choropleth", "data": [{ "id": "PT", "value": "high" }] }))[0].contains("null for no data"));
    }

    #[test]
    fn views_scales_and_sizes_are_checked() {
        assert_eq!(errors(json!({ "kind": "outline", "view": [-10, 35, 30, 60] })), NONE);
        assert_eq!(errors(json!({ "kind": "outline", "view": "auto" })), NONE);
        for bad in [json!([10, 35, -10, 60]), json!([0, 0, 1]), json!("europe"), json!([-200, 0, 0, 10])] {
            assert!(errors(json!({ "kind": "outline", "view": bad }))[0].contains("[west, south, east, north]"), "{bad}");
        }
        assert!(errors(json!({ "kind": "choropleth", "data": [], "scale": { "type": "diverging", "bins": 9 } }))[0].contains("2 to 7"));
        assert!(
            errors(json!({ "kind": "bubble", "points": [{ "lon": 0, "lat": 0, "label": "a", "value": 1 }], "scale": { "type": "sequential" } }))[0]
                .contains("give points a `shade`")
        );
        assert!(errors(json!({ "kind": "bubble", "points": [], "maxRadius": 100 }))[0].contains("6 to 48"));
        assert!(errors(json!({ "kind": "outline", "height": 2000 }))[0].contains("160 to 900"));
        assert!(errors(json!({ "kind": "outline", "legend": { "colour": "x" } }))[0].contains("no `colour`"));
    }

    fn flights() -> Value {
        json!({ "kind": "connection", "region": "world", "title": "Daily flights from hubs",
            "hubs": [{ "id": "LIS", "label": "Lisbon", "lon": -9.14, "lat": 38.77 }, { "id": "GRU", "label": "Sao Paulo", "lon": -46.47, "lat": -23.43 }, { "id": "JFK", "label": "New York", "lon": -73.78, "lat": 40.64 }],
            "links": [{ "from": "LIS", "to": "GRU", "value": 6 }, { "from": "LIS", "to": "JFK", "value": 9 }, { "from": "JFK", "to": "GRU", "value": 3 }],
            "directed": true, "labels": "auto", "unit": " flights" })
    }

    fn with(mut base: Value, k: &str, v: Value) -> Value {
        base[k] = v;
        base
    }

    #[test]
    fn connections_join_hubs_that_exist() {
        assert_eq!(errors(flights()), NONE);
        assert_eq!(errors(with(flights(), "width", json!("fixed"))), NONE);
        let e = errors(with(flights(), "links", json!([{ "from": "LIS", "to": "LAX" }])));
        assert!(e[0].starts_with("$.props.links[0].to \"LAX\" is not a hub id (hubs: GRU, JFK, LIS)"), "{e:?}");
        assert!(errors(with(flights(), "links", json!([{ "from": "LIS", "to": "LIS" }])))[0].contains("to itself"));
        let twice = errors(with(flights(), "links", json!([{ "from": "LIS", "to": "GRU" }, { "from": "LIS", "to": "GRU" }])));
        assert!(twice[0].contains("same route as link 0"), "{twice:?}");
        // Undirected, A–B and B–A are one pair; directed they are two routes.
        let back = json!([{ "from": "LIS", "to": "GRU" }, { "from": "GRU", "to": "LIS" }]);
        assert_eq!(errors(with(flights(), "links", back.clone())), NONE);
        assert!(errors(with(with(flights(), "directed", json!(false)), "links", back))[0].contains("same pair"));
        let hubs = errors(with(
            flights(),
            "hubs",
            json!([{ "id": "A", "lon": 0, "lat": 0 }, { "id": "A", "lon": 1, "lat": 100 }, { "id": "", "lon": 0, "lat": 0 }]),
        ));
        for want in ["hubs[1].id \"A\" is also hub 0", "hubs[1].lat", "hubs[2].id: text up to 40"] {
            assert!(hubs.iter().any(|x| x.contains(want)), "{want} in {hubs:?}");
        }
        assert!(errors(with(flights(), "links", json!([{ "from": "LIS", "to": "GRU", "value": -1 }])))[0].contains("0 or more"));
        let many: Vec<Value> = (0..=MAX_LINKS).map(|i| json!({ "from": "LIS", "to": format!("x{i}") })).collect();
        assert!(errors(with(flights(), "links", json!(many)))[0].contains("at most 200 rows"));
        assert!(errors(json!({ "kind": "connection", "hubs": [] }))[0].contains("needs `hubs`"));
        let unvalued = with(with(flights(), "links", json!([{ "from": "LIS", "to": "GRU" }])), "width", json!("value"));
        assert!(errors(unvalued)[0].contains("no link has a `value`"));
        assert!(errors(with(flights(), "width", json!("thick")))[0].contains("\"value\" or \"fixed\""));
        assert!(errors(with(flights(), "directed", json!("yes")))[0].contains("true or false"));
        assert!(errors(with(flights(), "data", json!([])))[0].contains("has no `data`"));
        let bound = with(flights(), "hubs", json!("{{hubs}}"));
        assert_eq!(errors(bound), NONE, "bound hubs: their ids are the renderer's to check");
    }

    #[test]
    fn hexbins_take_raw_points() {
        let ok = json!({ "kind": "hexbin", "region": "europe", "title": "Weather stations per cell",
            "points": [{ "lon": -9.1, "lat": 38.7 }, { "lon": -8.6, "lat": 41.1, "weight": 2 }],
            "radius": 14, "scale": { "type": "sequential", "bins": 5, "unit": "stations" }, "legend": true });
        assert_eq!(errors(ok.clone()), NONE);
        assert_eq!(errors(with(ok.clone(), "aggregate", json!("mean"))), NONE);
        assert!(errors(with(ok.clone(), "radius", json!(4)))[0].contains("8 to 40"));
        assert!(errors(with(ok.clone(), "aggregate", json!("max")))[0].contains("\"count\", \"sum\" or \"mean\""));
        let unweighted = with(with(ok.clone(), "points", json!([{ "lon": 0, "lat": 0 }])), "aggregate", json!("sum"));
        assert!(errors(unweighted)[0].contains("no point has one"));
        let bad = errors(with(
            ok.clone(),
            "points",
            json!([{ "lon": 0, "lat": 95 }, { "lon": 0, "lat": 0, "weight": "x" }, { "lon": 0, "lat": 0, "label": "a" }]),
        ));
        for want in ["points[0].lat", "points[1].weight", "points[2]: no `label`"] {
            assert!(bad.iter().any(|x| x.contains(want)), "{want} in {bad:?}");
        }
        assert!(errors(with(ok.clone(), "scale", json!({ "type": "categorical" })))[0].contains("hold amounts"));
        let many: Vec<Value> = (0..=MAX_HEX_POINTS).map(|_| json!({ "lon": 0, "lat": 0 })).collect();
        assert!(errors(with(ok.clone(), "points", json!(many)))[0].contains("at most 5000 rows"));
        assert!(errors(json!({ "kind": "hexbin" }))[0].contains("needs `points`"));
        assert!(errors(with(ok, "maxRadius", json!(10)))[0].contains("has no `maxRadius`"));
    }

    #[test]
    fn choropleths_say_how_missing_regions_look() {
        let base = json!({ "kind": "choropleth", "region": "us-states", "data": [{ "id": "PA", "value": 1 }] });
        assert_eq!(errors(with(base.clone(), "missing", json!("land"))), NONE);
        assert_eq!(errors(with(base.clone(), "missing", json!("hatch"))), NONE);
        assert!(errors(with(base, "missing", json!("grey")))[0].contains("\"hatch\" (no data) or \"land\""));
        assert!(errors(json!({ "kind": "bubble", "points": [], "missing": "land" }))[0].contains("belongs to kind [\"choropleth\"]"));
    }

    #[test]
    fn street_maps_take_routes_and_clusters() {
        let ok = json!({ "markers": [{ "id": "depot", "lat": 38.72, "lng": -9.14 }, { "id": "s1", "lat": 38.75, "lng": -9.1 }],
            "lines": [{ "points": ["depot", "s1", [38.7, -9.2]], "label": "Morning round", "tone": "success" }], "cluster": "auto" });
        assert_eq!(errors(ok.clone()), NONE);
        assert_eq!(errors(with(ok.clone(), "cluster", json!(false))), NONE);
        assert!(errors(with(ok.clone(), "cluster", json!("yes")))[0].contains("true, false or \"auto\""));
        let bad = errors(with(
            ok.clone(),
            "lines",
            json!([{ "points": ["depot"] }, { "points": ["nope", [100, 0], 3] }, { "label": "x" }, { "points": ["depot", "s1"], "tone": "red" }]),
        ));
        for want in [
            "lines[0].points: 2 to 1000",
            "lines[1].points[0] \"nope\" is not a marker id",
            "lines[1].points[1]: [lat, lng]",
            "lines[1].points[2]",
            "lines[2]: needs `points`",
            "lines[3].tone",
        ] {
            assert!(bad.iter().any(|x| x.contains(want)), "{want} in {bad:?}");
        }
        let dup = errors(
            json!({ "markers": [{ "id": "a", "lat": 0, "lng": 0 }, { "id": "a", "lat": 1, "lng": 1 }], "lines": [{ "points": ["a", [0, 0]] }] }),
        );
        assert!(dup[0].contains("is also marker 0"), "{dup:?}");
        let many: Vec<Value> = (0..=MAX_LINES).map(|_| json!({ "points": [[0, 0], [1, 1]] })).collect();
        assert!(errors(with(ok.clone(), "lines", json!(many)))[0].contains("at most 50 rows"));
        assert!(errors(json!({ "kind": "outline", "lines": [] }))[0].contains("belongs to kind [\"markers\"]"));
    }

    #[test]
    fn ids_are_rewritten_to_the_canonical_ones() {
        let Value::Object(mut p) = json!({ "kind": "choropleth", "region": "world", "data": [{ "id": "PT", "value": 1 }, { "id": "Czech Republic", "value": 2 }, { "id": 840, "value": 3 }, { "id": "{{x}}", "value": 4 }] })
        else {
            unreachable!()
        };
        normalize(&mut p);
        let ids: Vec<&Value> = p["data"].as_array().unwrap().iter().map(|r| &r["id"]).collect();
        assert_eq!(ids, [&json!("PRT"), &json!("CZE"), &json!("USA"), &json!("{{x}}")]);
        let Value::Object(mut us) = json!({ "kind": "outline", "region": "us-states", "highlight": [{ "id": "Texas" }, { "id": 42 }] }) else {
            unreachable!()
        };
        normalize(&mut us);
        assert_eq!(us["highlight"][0]["id"], "TX");
        assert_eq!(us["highlight"][1]["id"], "PA");
    }
}
