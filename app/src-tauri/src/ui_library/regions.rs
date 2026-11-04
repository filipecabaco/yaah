//! The region ids a region map accepts, per region set, from `src/assets/geo/region-ids.json`
//! (generated with the geometry by `app/scripts/build-geo.ts`, so the two can't disagree). An
//! agent writes ids the way it knows them, and each resolves to the canonical one the geometry
//! carries: countries by ISO 3166-1 alpha-3, alpha-2, numeric code or an English name (with the
//! common aliases: "USA", "UK", "Czech Republic", "Turkey"…); US states by postal code, FIPS code
//! (string or number) or name. Case, spaces and dots don't matter. An id that resolves nowhere
//! gets up to three near names back ("did you mean …").

use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;

const REGION_IDS: &str = include_str!("../../../src/assets/geo/region-ids.json");
pub(crate) const REGION_SETS: [&str; 3] = ["world", "europe", "us-states"];

#[derive(Deserialize)]
struct Row {
    id: String,
    name: String,
    #[serde(default)]
    a2: Option<String>,
    #[serde(default)]
    num: Option<String>,
    #[serde(default)]
    fips: Option<String>,
    #[serde(default)]
    aliases: Vec<String>,
}

pub(crate) struct Entry {
    pub(crate) id: String,
    pub(crate) name: String,
}

pub(crate) struct Set {
    pub(crate) entries: Vec<Entry>,
    /// Normalised key → entry index; `None` when two regions share the key (an ambiguous alias).
    keys: HashMap<String, Option<usize>>,
    /// Numeric codes are zero-padded to this many digits ("42", "076").
    pad: usize,
}

fn key(s: &str) -> String {
    s.trim().to_lowercase().replace('.', "").split_whitespace().collect::<Vec<_>>().join(" ")
}

fn sets() -> &'static BTreeMap<String, Set> {
    static SETS: OnceLock<BTreeMap<String, Set>> = OnceLock::new();
    SETS.get_or_init(|| {
        let raw: BTreeMap<String, Vec<Row>> = serde_json::from_str(REGION_IDS).expect("region-ids.json is generated valid");
        raw.into_iter()
            .map(|(name, rows)| {
                let mut keys: HashMap<String, Option<usize>> = HashMap::new();
                let pad = if name == "us-states" { 2 } else { 3 };
                for (i, r) in rows.iter().enumerate() {
                    let own = [Some(&r.id), Some(&r.name), r.a2.as_ref(), r.num.as_ref(), r.fips.as_ref()];
                    for k in own.into_iter().flatten().chain(&r.aliases).map(|s| key(s)) {
                        keys.entry(k)
                            .and_modify(|e| {
                                if *e != Some(i) {
                                    *e = None;
                                }
                            })
                            .or_insert(Some(i));
                    }
                }
                // A region's own id always wins over another region's alias; a name two regions share ("Congo") stays ambiguous.
                for (i, r) in rows.iter().enumerate() {
                    keys.insert(key(&r.id), Some(i));
                }
                let entries = rows.into_iter().map(|r| Entry { id: r.id, name: r.name }).collect();
                (name, Set { entries, keys, pad })
            })
            .collect()
    })
}

pub(crate) fn set(name: &str) -> Option<&'static Set> {
    sets().get(name)
}

/// Why an id didn't resolve, as the end of an error sentence.
pub(crate) enum Miss {
    /// Not an id at all (an object, a bool, a fraction).
    NotAnId,
    Ambiguous,
    Unknown(Vec<String>),
}

impl Set {
    /// The canonical id for `raw` (a string, or a whole number for numeric and FIPS codes).
    pub(crate) fn resolve(&self, raw: &Value) -> Result<&str, Miss> {
        let text = match raw {
            Value::String(s) => s.clone(),
            Value::Number(n) if let Some(n) = n.as_u64() => format!("{n:0>width$}", width = self.pad),
            _ => return Err(Miss::NotAnId),
        };
        match self.keys.get(&key(&text)) {
            Some(Some(i)) => Ok(&self.entries[*i].id),
            Some(None) => Err(Miss::Ambiguous),
            None => Err(Miss::Unknown(self.near(&text))),
        }
    }

    /// Up to three regions whose name or id is closest to `text` (edit distance, within a third of its length).
    fn near(&self, text: &str) -> Vec<String> {
        let k = key(text);
        let limit = (k.chars().count() / 3).max(2);
        let mut scored: Vec<(usize, &Entry)> =
            self.entries.iter().map(|e| (distance(&k, &key(&e.name)).min(distance(&k, &key(&e.id))), e)).filter(|(d, _)| *d <= limit).collect();
        scored.sort_by_key(|(d, e)| (*d, e.name.clone()));
        scored.into_iter().take(3).map(|(_, e)| format!("\"{}\" ({})", e.name, e.id)).collect()
    }
}

/// Levenshtein distance over characters.
fn distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut prev = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let here = row[j + 1];
            row[j + 1] = if ca == *cb { prev } else { 1 + prev.min(row[j]).min(row[j + 1]) };
            prev = here;
        }
    }
    row[b.len()]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn id(set_name: &str, raw: &Value) -> Result<String, String> {
        set(set_name).unwrap().resolve(raw).map(str::to_owned).map_err(|m| match m {
            Miss::NotAnId => "not an id".into(),
            Miss::Ambiguous => "ambiguous".into(),
            Miss::Unknown(near) => format!("unknown: {}", near.join(", ")),
        })
    }

    #[test]
    fn every_set_is_there() {
        for s in REGION_SETS {
            assert!(set(s).is_some_and(|s| !s.entries.is_empty()), "{s}");
        }
        assert_eq!(set("us-states").unwrap().entries.len(), 51, "50 states and DC");
        assert!(set("world").unwrap().entries.len() > 170);
    }

    #[test]
    fn countries_resolve_from_every_code_and_name() {
        for raw in [json!("PRT"), json!("PT"), json!("pt"), json!("620"), json!(620), json!("Portugal"), json!(" portugal ")] {
            assert_eq!(id("world", &raw), Ok("PRT".into()), "{raw}");
        }
        for (raw, want) in [
            ("USA", "USA"),
            ("United States", "USA"),
            ("U.S.A.", "USA"),
            ("UK", "GBR"),
            ("Czech Republic", "CZE"),
            ("Czechia", "CZE"),
            ("Turkey", "TUR"),
            ("Türkiye", "TUR"),
            ("Kosovo", "XKX"),
        ] {
            assert_eq!(id("world", &json!(raw)), Ok(want.into()), "{raw}");
        }
        assert_eq!(id("europe", &json!("MT")), Ok("MLT".into()), "Malta is in the 50m Europe set");
        assert!(id("europe", &json!("BRA")).unwrap_err().starts_with("unknown"), "Brazil isn't in Europe");
    }

    #[test]
    fn states_resolve_from_postal_fips_and_name() {
        for raw in [json!("PA"), json!("pa"), json!("42"), json!(42), json!("Pennsylvania")] {
            assert_eq!(id("us-states", &raw), Ok("PA".into()), "{raw}");
        }
        assert_eq!(id("us-states", &json!(6)), Ok("CA".into()), "a FIPS number is padded");
        assert_eq!(id("us-states", &json!("D.C.")), Ok("DC".into()));
        assert_eq!(id("us-states", &json!("District of Columbia")), Ok("DC".into()));
    }

    #[test]
    fn typos_suggest_the_nearest_names() {
        let err = id("us-states", &json!("Pensilvania")).unwrap_err();
        assert!(err.contains("\"Pennsylvania\" (PA)"), "{err}");
        let err = id("world", &json!("Portgual")).unwrap_err();
        assert!(err.contains("\"Portugal\" (PRT)"), "{err}");
        assert_eq!(id("world", &json!("Congo")), Err("ambiguous".into()), "two countries are called Congo");
        assert_eq!(id("world", &json!(true)), Err("not an id".into()));
        assert_eq!(id("world", &json!(1.5)), Err("not an id".into()));
    }
}
