//! The `map` primitive's rules beyond its prop types: what each `kind` takes (`markers`, today's
//! tile map and the default; `outline`, `choropleth` and `bubble`, region maps on bundled
//! geometry), the shape of every row, the caps, coordinates in range, and region ids that resolve
//! in the chosen region set (regions.rs), with near names when one doesn't. [`normalize`] then
//! rewrites the ids to the canonical ones before the tree reaches React. In step with
//! `src/components/ui-blocks/map/model.ts`. Bound values (`{{…}}`) pass; the renderer caps them.

use super::chart::check_scale;
use super::regions::{self, Miss, REGION_SETS};
use super::{is_binding, shown};
use serde_json::{Map, Value};
use std::collections::HashMap;

const KINDS: [&str; 4] = ["markers", "outline", "choropleth", "bubble"];
const MAX_HIGHLIGHT: usize = 100;
const MAX_OUTLINE_POINTS: usize = 200;
const MAX_BUBBLE_POINTS: usize = 500;
const MAX_DATA: usize = 3000;
const MAX_MARKERS: usize = 2000;
const LABEL_MAX: usize = 60;
const DETAIL_MAX: usize = 200;
const TITLE_MAX: usize = 120;
/// Errors listed for one array before the rest are summed up.
const ROW_ERRORS: usize = 8;
const TONES: [&str; 4] = ["default", "success", "warning", "danger"];

/// Which props each kind takes, beyond `kind` and `height`.
fn own_props(kind: &str) -> &'static [&'static str] {
    match kind {
        "markers" => &["markers", "center", "zoom"],
        "outline" => &["region", "view", "title", "legend", "labels", "highlight", "points", "borders"],
        "choropleth" => &["region", "view", "title", "legend", "labels", "data", "scale", "noDataLabel"],
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
        match props.get("markers") {
            None => {
                errs.push(format!("{path}: a markers map needs `markers`: [{{ lat, lng, label }}] (or set `kind` to outline, choropleth or bubble)"));
            }
            Some(Value::Array(m)) if m.len() > MAX_MARKERS => errs.push(format!("{}: at most {MAX_MARKERS} markers, got {}", at("markers"), m.len())),
            _ => {}
        }
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
    if props.get("region").is_some_and(is_binding) {
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
    if let Some(b) = given("borders")
        && !matches!(b.as_str(), Some("countries" | "none"))
    {
        errs.push(format!("{}: \"countries\" or \"none\", got {}", at("borders"), shown(b)));
    }
    if let Some(scale) = given("scale") {
        check_scale(scale, &at("scale"), errs);
        if kind == "bubble" {
            let shaded = matches!(given("points"), Some(Value::Array(p)) if p.iter().any(|p| p.get("shade").is_some()));
            if !shaded && given("points").is_some() {
                errs.push(format!("{}: a bubble's size is its value; `scale` colours a second variable, so give points a `shade`", at("scale")));
            }
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
