//! The `chart` primitive's rules beyond its prop types: what each `kind` takes, the shape of
//! `refs`, `scale` and `domain`, and the caps (rows, refs, bins). In step with
//! `src/components/ui-blocks/chart-model.ts` and `scale.ts`, which read the same props.
//! Bound values (`{{…}}`) are only known at render time, so they pass; the renderer
//! clamps them to the same caps.

use super::{is_binding, shown};
use serde_json::{Map, Value};

pub(crate) const MAX_ROWS: usize = 2000;
const MAX_REFS: usize = 20;
const MAX_BINS: u64 = 7;
const LABEL_MAX: usize = 40;
const UNIT_MAX: usize = 12;

/// Errors for a `chart` node's props, after their types have been checked.
pub(crate) fn check(props: &Map<String, Value>, path: &str, errs: &mut Vec<String>) {
    let at = |k: &str| format!("{path}.props.{k}");
    // A bound or missing kind: only the kind-free rules apply.
    let kind = props.get("kind").and_then(Value::as_str).filter(|k| !k.contains("{{"));
    let given = |k: &str| props.get(k).filter(|v| !is_binding(v));

    if let Some(Value::Array(rows)) = given("data")
        && rows.len() > MAX_ROWS
    {
        errs.push(format!("{}: at most {MAX_ROWS} rows, got {}; aggregate or sample them first", at("data"), rows.len()));
    }
    if let Some(Value::Array(series)) = given("series") {
        for (i, s) in series.iter().enumerate() {
            let ok = s.is_string() || s.get("key").is_some_and(Value::is_string);
            if !ok {
                errs.push(format!("{}[{i}]: a field name, or {{ \"key\": field, \"label\"?: text }}; got {}", at("series"), shown(s)));
            }
        }
        if kind == Some("dumbbell") && series.len() != 2 {
            errs.push(format!("{}: a dumbbell takes exactly 2 series (before and after, e.g. poll and result), got {}", at("series"), series.len()));
        }
    }
    if let Some(Value::Array(refs)) = given("refs") {
        if refs.len() > MAX_REFS {
            errs.push(format!("{}: at most {MAX_REFS} reference lines, got {}", at("refs"), refs.len()));
        }
        for (i, r) in refs.iter().enumerate().take(MAX_REFS) {
            check_ref(r, &format!("{}[{i}]", at("refs")), errs);
        }
    }
    if let (Some(k), Some(o)) = (kind, given("orientation"))
        && !matches!(k, "bar" | "dumbbell")
    {
        errs.push(format!("{}: {} applies to bar and dumbbell; a {k} always runs left to right", at("orientation"), shown(o)));
    }
    if let (Some(k), Some(s)) = (kind, given("sort").and_then(Value::as_str)) {
        match s {
            "gap" if k != "dumbbell" => errs.push(format!("{}: `gap` sorts a dumbbell; use `value` or `none` for a {k}", at("sort"))),
            "value" if !matches!(k, "bar" | "dumbbell") => {
                errs.push(format!("{}: a {k} keeps its x order; `value` sorts bar and dumbbell", at("sort")));
            }
            _ => {}
        }
    }
    if kind == Some("dumbbell") && given("stacked").is_some_and(|v| v == true) {
        errs.push(format!("{}: a dumbbell doesn't stack; its two series are dots on one axis", at("stacked")));
    }
    for k in ["zero", "domain"] {
        if let (Some(kind @ ("bar" | "dumbbell")), Some(_)) = (kind, given(k)) {
            let why = if kind == "bar" { "bars always start at 0, their length is the value" } else { "a dumbbell fits its dots" };
            errs.push(format!("{}: `{k}` sets a line or area's value axis; {why}", at(k)));
        }
    }
    if let Some(d) = given("domain") {
        check_domain(d, &at("domain"), errs);
    }
    if let Some(scale) = given("scale") {
        match kind {
            Some("dumbbell") | None => check_scale(scale, &at("scale"), errs),
            Some(k) => errs.push(format!("{}: `scale` colours a dumbbell; a {k} takes its colours from the series slots", at("scale"))),
        }
    }
}

/// `[low, high]`: two finite numbers with low < high (bound ends pass).
fn check_domain(d: &Value, path: &str, errs: &mut Vec<String>) {
    let ok = match d.as_array().map(Vec::as_slice) {
        Some([lo, hi]) if is_binding(lo) || is_binding(hi) => true,
        Some([lo, hi]) => matches!((lo.as_f64(), hi.as_f64()), (Some(lo), Some(hi)) if lo < hi),
        _ => false,
    };
    if !ok {
        errs.push(format!("{path}: [low, high], two numbers with low < high, got {}", shown(d)));
    }
}

fn check_ref(r: &Value, path: &str, errs: &mut Vec<String>) {
    let Some(r) = r.as_object() else {
        errs.push(format!("{path}: a reference line is {{ \"axis\": \"x\" | \"y\", \"value\", \"label\"? }}, got {}", shown(r)));
        return;
    };
    for k in r.keys().filter(|k| !matches!(k.as_str(), "axis" | "value" | "label")) {
        errs.push(format!("{path}: no `{k}` (allowed: axis, value, label)"));
    }
    match r.get("axis") {
        Some(v) if is_binding(v) => {}
        Some(Value::String(a)) if a == "x" || a == "y" => {}
        Some(v) => errs.push(format!("{path}.axis: `x` (a category) or `y` (a value), got {}", shown(v))),
        None => errs.push(format!("{path}: needs `axis`, `x` (a category) or `y` (a value)")),
    }
    match r.get("value") {
        Some(Value::String(_)) => {}
        Some(Value::Number(n)) if n.as_f64().is_some_and(f64::is_finite) => {}
        Some(v) => errs.push(format!("{path}.value: a number, or a category name, got {}", shown(v))),
        None => errs.push(format!("{path}: needs `value`, where the line goes")),
    }
    match r.get("label") {
        None => {}
        Some(Value::String(s)) if s.chars().count() <= LABEL_MAX => {}
        Some(Value::String(_)) => errs.push(format!("{path}.label: at most {LABEL_MAX} characters; it sits on the line")),
        Some(v) => errs.push(format!("{path}.label: text, got {}", shown(v))),
    }
}

fn check_scale(scale: &Value, path: &str, errs: &mut Vec<String>) {
    let Some(s) = scale.as_object() else {
        errs.push(format!("{path}: {{ \"type\", \"domain\"?, \"midpoint\"?, \"bins\"?, \"unit\"? }}, got {}", shown(scale)));
        return;
    };
    for k in s.keys().filter(|k| !matches!(k.as_str(), "type" | "domain" | "midpoint" | "bins" | "unit")) {
        errs.push(format!("{path}: no `{k}` (allowed: type, domain, midpoint, bins, unit)"));
    }
    let kind = match s.get("type") {
        Some(Value::String(t)) if matches!(t.as_str(), "sequential" | "diverging" | "categorical") => Some(t.as_str()),
        Some(v) if is_binding(v) => None,
        Some(v) => {
            errs.push(format!("{path}.type: `sequential`, `diverging` or `categorical`, got {}", shown(v)));
            None
        }
        None => {
            errs.push(format!("{path}: needs `type`: `sequential` (magnitude), `diverging` (either side of a midpoint) or `categorical`"));
            None
        }
    };
    let domain = s.get("domain").filter(|v| !is_binding(v));
    let bounds = match domain {
        None => None,
        Some(Value::Array(d)) => match (d.as_slice(), d.first().and_then(Value::as_f64), d.get(1).and_then(Value::as_f64)) {
            ([_, _], Some(lo), Some(hi)) if lo < hi => Some((lo, hi)),
            _ => {
                errs.push(format!("{path}.domain: [low, high], two numbers with low < high, got {}", shown(&Value::Array(d.clone()))));
                None
            }
        },
        Some(v) => {
            errs.push(format!("{path}.domain: [low, high], got {}", shown(v)));
            None
        }
    };
    match s.get("midpoint").filter(|v| !is_binding(v)) {
        None => {}
        Some(Value::Number(n)) => {
            if kind.is_some_and(|k| k != "diverging") {
                errs.push(format!("{path}.midpoint: only a diverging scale has a midpoint"));
            }
            if let (Some(m), Some((lo, hi))) = (n.as_f64(), bounds)
                && !(lo < m && m < hi)
            {
                errs.push(format!("{path}.midpoint: {m} isn't inside the domain [{lo}, {hi}]"));
            }
        }
        Some(v) => errs.push(format!("{path}.midpoint: a number, got {}", shown(v))),
    }
    match s.get("bins").filter(|v| !is_binding(v)) {
        None => {}
        Some(Value::Number(n)) if n.as_u64().is_some_and(|b| (2..=MAX_BINS).contains(&b)) => {}
        Some(v) => errs.push(format!("{path}.bins: a whole number from 2 to {MAX_BINS} (past 7 classes, neighbours blur), got {}", shown(v))),
    }
    match s.get("unit") {
        None => {}
        Some(Value::String(u)) if u.chars().count() <= UNIT_MAX => {}
        Some(v) => errs.push(format!("{path}.unit: a short suffix (at most {UNIT_MAX} characters), got {}", shown(v))),
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
    fn dumbbell(extra: Value) -> Value {
        let mut p = json!({
            "kind": "dumbbell", "x": "state",
            "data": [{ "state": "PA", "poll": -0.5, "result": 1.7 }],
            "series": [{ "key": "poll", "label": "Poll" }, { "key": "result", "label": "Result" }]
        });
        let Value::Object(extra) = extra else { panic!("extra props are an object") };
        p.as_object_mut().unwrap().extend(extra);
        p
    }

    #[test]
    fn a_good_dumbbell_passes() {
        let p = dumbbell(json!({
            "refs": [{ "axis": "y", "value": 0, "label": "Tie" }], "sort": "gap", "orientation": "horizontal", "labels": "ends",
            "scale": { "type": "diverging", "domain": [-20, 20], "midpoint": 0, "bins": 7, "unit": " pts" }
        }));
        assert_eq!(errors(p), NONE);
    }

    #[test]
    fn a_dumbbell_takes_exactly_two_series() {
        let one = errors(dumbbell(json!({ "series": ["poll"] })));
        assert_eq!(one.len(), 1);
        assert!(one[0].contains("exactly 2 series") && one[0].contains("got 1"), "{one:?}");
        assert!(errors(dumbbell(json!({ "series": ["a", "b", "c"] })))[0].contains("got 3"));
        assert!(errors(dumbbell(json!({ "stacked": true })))[0].contains("doesn't stack"));
        assert_eq!(errors(json!({ "kind": "bar", "series": ["a", "b", "c"] })), NONE, "other kinds take up to 5 and fold the rest");
        assert!(errors(json!({ "kind": "bar", "series": [42] }))[0].contains("series[0]"));
    }

    #[test]
    fn rows_are_capped() {
        let rows: Vec<Value> = (0..=MAX_ROWS).map(|i| json!({ "x": i, "y": i })).collect();
        let errs = errors(json!({ "kind": "line", "data": rows, "series": ["y"] }));
        assert!(errs[0].contains("at most 2000 rows, got 2001"), "{errs:?}");
        assert_eq!(errors(json!({ "kind": "line", "data": "{{history}}", "series": ["y"] })), NONE, "bound data is the renderer's to cap");
    }

    #[test]
    fn refs_have_a_shape() {
        let bad = errors(json!({ "kind": "line", "refs": [
            { "axis": "z", "value": 1 },
            { "value": 1 },
            { "axis": "y" },
            { "axis": "y", "value": true },
            { "axis": "y", "value": 1, "label": "x".repeat(41) },
            { "axis": "y", "value": 1, "colour": "red" },
            "Tie"
        ] }));
        for (i, want) in
            ["refs[0].axis", "refs[1]: needs `axis`", "refs[2]: needs `value`", "refs[3].value", "refs[4].label", "refs[5]: no `colour`", "refs[6]"]
                .iter()
                .enumerate()
        {
            assert!(bad.iter().any(|e| e.contains(want)), "{i}: {want} in {bad:?}");
        }
        let good = json!({ "kind": "bar", "refs": [{ "axis": "x", "value": "W2" }, { "axis": "y", "value": 2.5, "label": "Target" }] });
        assert_eq!(errors(good), NONE);
        let many: Vec<Value> = (0..21).map(|i| json!({ "axis": "y", "value": i })).collect();
        assert!(errors(json!({ "kind": "bar", "refs": many }))[0].contains("at most 20"));
    }

    #[test]
    fn orientation_and_sort_belong_to_some_kinds() {
        assert!(errors(json!({ "kind": "line", "orientation": "horizontal" }))[0].contains("bar and dumbbell"));
        assert_eq!(errors(json!({ "kind": "bar", "orientation": "horizontal", "sort": "value" })), NONE);
        assert!(errors(json!({ "kind": "bar", "sort": "gap" }))[0].contains("`gap` sorts a dumbbell"));
        assert!(errors(json!({ "kind": "area", "sort": "value" }))[0].contains("keeps its x order"));
        assert_eq!(errors(json!({ "kind": "line", "sort": "none" })), NONE);
    }

    #[test]
    fn zero_and_domain_set_a_line_or_area_axis() {
        assert_eq!(errors(json!({ "kind": "line", "zero": true, "domain": [0, 100] })), NONE);
        assert_eq!(errors(json!({ "kind": "area", "domain": [-1.5, 2] })), NONE);
        assert_eq!(errors(json!({ "kind": "line", "domain": ["{{lo}}", 10] })), NONE, "bound ends are the renderer's");
        assert!(errors(json!({ "kind": "bar", "zero": true }))[0].contains("bars always start at 0"));
        assert!(errors(json!({ "kind": "dumbbell", "domain": [0, 1] }))[0].contains("fits its dots"));
        for bad in [json!([5, 1]), json!([1, 1]), json!([0, 1, 2]), json!(["a", 1]), json!([0])] {
            let errs = errors(json!({ "kind": "line", "domain": bad }));
            assert!(errs.iter().any(|e| e.contains("$.props.domain: [low, high]")), "{bad}: {errs:?}");
        }
    }

    #[test]
    fn scales_are_checked() {
        let scale = |s: Value| errors(dumbbell(json!({ "scale": s })));
        assert_eq!(scale(json!({ "type": "sequential", "bins": 5 })), NONE);
        assert!(scale(json!({ "domain": [0, 1] }))[0].contains("needs `type`"));
        assert!(scale(json!({ "type": "rainbow" }))[0].contains("`sequential`, `diverging` or `categorical`"));
        assert!(scale(json!({ "type": "diverging", "bins": 8 }))[0].contains("2 to 7"));
        assert!(scale(json!({ "type": "diverging", "bins": 1 }))[0].contains("2 to 7"));
        assert!(scale(json!({ "type": "diverging", "bins": 2.5 }))[0].contains("2 to 7"));
        assert!(scale(json!({ "type": "diverging", "domain": [5, 1] }))[0].contains("low < high"));
        assert!(scale(json!({ "type": "diverging", "domain": [0, 1, 2] }))[0].contains("[low, high]"));
        assert!(scale(json!({ "type": "diverging", "domain": [-1, 1], "midpoint": 4 }))[0].contains("isn't inside"));
        assert!(scale(json!({ "type": "sequential", "midpoint": 0 }))[0].contains("only a diverging"));
        assert!(scale(json!({ "type": "sequential", "unit": "a very long unit" }))[0].contains("short suffix"));
        assert!(scale(json!({ "type": "sequential", "format": "{v}%" }))[0].contains("no `format`"));
        assert!(errors(json!({ "kind": "bar", "scale": { "type": "sequential" } }))[0].contains("colours a dumbbell"));
    }
}
