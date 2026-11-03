use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;

pub const PROTOCOL_VERSION: u32 = 1;
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub protocol_version: u32,
    pub profile_id: String,
    pub policy_version: u32,
    pub files: Vec<ManifestFile>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestFile {
    pub root: String,
    pub path: String,
    pub hash: String,
    pub size: u64,
    pub group: String,
}
pub fn portable_path(path: &str) -> bool {
    if path.is_empty() || path.len() > 1024 || path.nfc().collect::<String>() != path {
        return false;
    }
    if path
        .chars()
        .any(|c| matches!(c, '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*') || c.is_control())
    {
        return false;
    }
    path.split('/').all(|p| {
        let name = p.split('.').next().unwrap_or("").to_ascii_lowercase();
        let reserved = matches!(name.as_str(), "con" | "prn" | "aux" | "nul")
            || ((name.starts_with("com") || name.starts_with("lpt"))
                && name.len() == 4
                && matches!(name.as_bytes()[3], b'1'..=b'9'));
        !p.is_empty()
            && p.len() <= 255
            && p != "."
            && p != ".."
            && !p.ends_with(['.', ' '])
            && !reserved
    })
}
impl Manifest {
    pub fn validate(&self) -> Result<(), &'static str> {
        let id = &self.profile_id;
        let uuid = id.len() == 36
            && id.bytes().enumerate().all(|(i, b)| {
                if [8, 13, 18, 23].contains(&i) {
                    b == b'-'
                } else {
                    b.is_ascii_hexdigit()
                }
            });
        let canonical = id.to_ascii_lowercase();
        let uuid = uuid
            && (canonical == "00000000-0000-0000-0000-000000000000"
                || canonical == "ffffffff-ffff-ffff-ffff-ffffffffffff"
                || (matches!(canonical.as_bytes()[14], b'1'..=b'8')
                    && matches!(canonical.as_bytes()[19], b'8' | b'9' | b'a' | b'b')));
        if self.protocol_version != 1
            || self.policy_version == 0
            || self.policy_version > 2147483647
            || !uuid
            || self.files.len() > 100_000
        {
            return Err("Invalid manifest header");
        }
        let mut seen = std::collections::HashSet::new();
        for f in &self.files {
            if !matches!(f.root.as_str(), "account" | "character" | "addons")
                || !portable_path(&f.path)
                || f.hash.len() != 64
                || !f
                    .hash
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                || f.size > 9_007_199_254_740_991
                || f.group.is_empty()
                || f.group.len() > 128
            {
                return Err("Invalid manifest entry");
            }
            if !seen.insert(format!("{}/{}", f.root, f.path.to_lowercase())) {
                return Err("Portable path collision");
            }
        }
        for f in &self.files {
            let lower = f.path.to_lowercase();
            let parts: Vec<&str> = lower.split('/').collect();
            for i in 1..parts.len() {
                if seen.contains(&format!("{}/{}", f.root, parts[..i].join("/"))) {
                    return Err("File/directory collision");
                }
            }
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_manifest_conformance() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../../../fixtures/protocol/manifests.json"))
                .unwrap();
        for case in cases.as_array().unwrap() {
            let parsed = serde_json::from_value::<Manifest>(case["manifest"].clone());
            let valid = parsed.map(|m| m.validate().is_ok()).unwrap_or(false);
            assert_eq!(valid, case["valid"].as_bool().unwrap(), "{}", case["name"]);
        }
    }
    #[test]
    fn shared_blake3_vectors() {
        let vectors: serde_json::Value =
            serde_json::from_str(include_str!("../../../fixtures/protocol/hashes.json")).unwrap();
        for v in vectors.as_array().unwrap() {
            assert_eq!(
                blake3::hash(v["text"].as_str().unwrap().as_bytes())
                    .to_hex()
                    .as_str(),
                v["hash"].as_str().unwrap()
            );
        }
    }
}
