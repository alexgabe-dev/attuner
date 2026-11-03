use std::{collections::BTreeMap, sync::OnceLock};
use unicode_normalization::UnicodeNormalization;
#[derive(serde::Deserialize)]
struct Tables {
    fold: BTreeMap<String, String>,
    assigned: Vec<(u32, u32)>,
}
fn tables() -> &'static Tables {
    static TABLE: OnceLock<Tables> = OnceLock::new();
    TABLE.get_or_init(|| {
        serde_json::from_str(include_str!("../../../fixtures/unicode/namespace-v1.json"))
            .expect("compiled Unicode tables")
    })
}
pub fn key(value: &str) -> String {
    value
        .nfkc()
        .flat_map(|c| {
            tables()
                .fold
                .get(&(c as u32).to_string())
                .cloned()
                .unwrap_or_else(|| c.to_string())
                .chars()
                .collect::<Vec<_>>()
        })
        .nfkc()
        .collect()
}
pub fn assigned(value: &str) -> bool {
    value.chars().all(|c| {
        tables()
            .assigned
            .iter()
            .any(|(a, b)| (*a..=*b).contains(&(c as u32)))
    })
}
