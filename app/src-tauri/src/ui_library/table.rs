//! The `table` primitive's rules beyond its prop types: columns are names or `{ key, label?, align? }`
//! with unique keys, and every row is something the table can show, an object keyed by column key
//! or an array in column order, with plain cells. A row the renderer would draw blank (wrong keys, a
//! bare string) is an error naming the columns, so the agent fixes it instead of the user seeing
//! "Nothing to show". In step with `src/components/ui-blocks/data-table.tsx`. Bound values pass.

use super::{is_binding, shown};
use serde_json::{Map, Value};

/// Errors listed for the rows before the rest are summed up.
const ROW_ERRORS: usize = 8;

/// Errors for a `table` node's props, after their types have been checked.
pub(crate) fn check(props: &Map<String, Value>, path: &str, errs: &mut Vec<String>) {
    let Some(Value::Array(columns)) = props.get("columns").filter(|v| !is_binding(v)) else { return };
    let mut keys: Vec<&str> = Vec::new();
    for (i, c) in columns.iter().enumerate() {
        let at = format!("{path}.props.columns[{i}]");
        let key = match c {
            Value::String(k) => Some(k.as_str()),
            Value::Object(o) => {
                if let Some(a) = o.get("align").filter(|a| !matches!(a.as_str(), Some("left" | "right"))) {
                    errs.push(format!("{at}.align: \"left\" or \"right\", got {}", shown(a)));
                }
                let key = o.get("key").and_then(Value::as_str);
                if key.is_none() {
                    errs.push(format!("{at}: a column object needs a string `key` (the row field it shows), got {}", shown(c)));
                }
                key
            }
            _ => {
                errs.push(format!("{at}: a column is a name like \"Server\" or {{ \"key\": \"server\", \"label\": \"Server\" }}, got {}", shown(c)));
                None
            }
        };
        if let Some(k) = key {
            if keys.contains(&k) {
                errs.push(format!("{at}: the column `{k}` is listed twice"));
            }
            keys.push(k);
        }
    }
    if columns.is_empty() {
        errs.push(format!("{path}.props.columns: list at least one column"));
        return;
    }

    let Some(Value::Array(rows)) = props.get("rows").filter(|v| !is_binding(v)) else { return };
    let mut row_errs = Vec::new();
    for (i, r) in rows.iter().enumerate() {
        let at = format!("{path}.props.rows[{i}]");
        match r {
            Value::Object(o) => {
                if !o.is_empty() && !o.keys().any(|k| keys.contains(&k.as_str())) {
                    row_errs.push(format!(
                        "{at}: its keys {:?} match no column, so it would show blank. Key rows by the column keys {keys:?}, or send an array in column order",
                        o.keys().collect::<Vec<_>>()
                    ));
                }
                for (k, v) in o {
                    if v.is_object() || v.is_array() {
                        row_errs.push(format!("{at}.{k}: a cell is a string, number or boolean, got {}", shown(v)));
                    }
                }
            }
            Value::Array(cells) => {
                if cells.len() != keys.len() {
                    row_errs.push(format!(
                        "{at}: {} cells for {} columns {keys:?}; an array row has one cell per column, in order",
                        cells.len(),
                        keys.len()
                    ));
                }
                for (j, v) in cells.iter().enumerate() {
                    if v.is_object() || v.is_array() {
                        row_errs.push(format!("{at}[{j}]: a cell is a string, number or boolean, got {}", shown(v)));
                    }
                }
            }
            _ => row_errs.push(format!(
                "{at}: a row is an object keyed by column ({{ \"{}\": … }}) or an array in column order, got {}",
                keys[0],
                shown(r)
            )),
        }
    }
    let extra = row_errs.len().saturating_sub(ROW_ERRORS);
    errs.extend(row_errs.into_iter().take(ROW_ERRORS));
    if extra > 0 {
        errs.push(format!("{path}.props.rows: {extra} more rows like these"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn errors(props: Value) -> Vec<String> {
        let mut errs = Vec::new();
        let Value::Object(props) = props else { panic!("props are an object") };
        check(&props, "$", &mut errs);
        errs
    }

    #[test]
    fn both_row_shapes_pass() {
        let p = json!({ "columns": ["Server", { "key": "url", "label": "Endpoint", "align": "left" }],
            "rows": [{ "Server": "Zapier", "url": "mcp.zapier.com" }, ["Miro", "mcp.miro.com"], { "Server": "Todoist" }] });
        assert_eq!(errors(p), Vec::<String>::new());
    }

    #[test]
    fn bound_rows_and_columns_pass() {
        assert_eq!(errors(json!({ "columns": "{{data.columns}}", "rows": "{{data.rows}}" })), Vec::<String>::new());
        assert_eq!(errors(json!({ "columns": ["a"], "rows": "{{data.rows}}" })), Vec::<String>::new());
    }

    #[test]
    fn a_row_that_would_show_blank_names_the_columns() {
        let e = errors(json!({ "columns": ["Server", "Endpoint"], "rows": [{ "name": "Zapier", "url": "x" }] }));
        assert_eq!(e.len(), 1, "{e:?}");
        assert!(e[0].contains("match no column") && e[0].contains(r#"["Server", "Endpoint"]"#), "{e:?}");
    }

    #[test]
    fn array_rows_need_one_cell_per_column() {
        let e = errors(json!({ "columns": ["a", "b", "c"], "rows": [["1", "2"]] }));
        assert!(e[0].contains("2 cells for 3 columns"), "{e:?}");
    }

    #[test]
    fn bare_rows_cells_and_columns_are_refused() {
        let e = errors(json!({ "columns": ["a", "a", 3, { "label": "x" }], "rows": ["just text", { "a": { "nested": true } }] }));
        let all = e.join("\n");
        for want in ["listed twice", "a column is a name", "needs a string `key`", "a row is an object keyed by column", "a cell is a string"] {
            assert!(all.contains(want), "missing {want}: {all}");
        }
    }

    #[test]
    fn many_bad_rows_are_summed_up() {
        let rows: Vec<Value> = (0..20).map(|i| json!(i)).collect();
        let e = errors(json!({ "columns": ["a"], "rows": rows }));
        assert_eq!(e.len(), ROW_ERRORS + 1);
        assert!(e.last().unwrap().contains("12 more rows"), "{e:?}");
    }
}
