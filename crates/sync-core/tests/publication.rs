use attuner_sync_core::{Manifest, namespace, remote};
#[test]
fn canonical_publications_match_typescript() {
    let vectors: serde_json::Value =
        serde_json::from_str(include_str!("../../../fixtures/protocol/publications.json")).unwrap();
    for vector in vectors.as_array().unwrap() {
        let manifest: Manifest = serde_json::from_value(vector["manifest"].clone()).unwrap();
        assert_eq!(
            remote::canonical(&manifest).unwrap(),
            vector["canonical"].as_str().unwrap()
        );
        assert_eq!(
            remote::digest(&manifest).unwrap(),
            vector["hash"].as_str().unwrap()
        );
        remote::validate(
            &manifest,
            &manifest.profile_id,
            &["account".into(), "addons".into()],
            1,
        )
        .unwrap();
        let mut forged = manifest.clone();
        forged.files[0].group = "forged".into();
        assert!(remote::validate(&forged, &manifest.profile_id, &["account".into()], 1).is_err());
    }
}
#[test]
fn namespace_uses_the_same_pinned_unicode_tables() {
    for (a, b) in [
        ("Straße", "STRASSE"),
        ("Ａ", "a"),
        ("Café", "Cafe\u{301}"),
        ("Ꭰ", "ꭰ"),
    ] {
        assert_eq!(namespace::key(a), namespace::key(b));
    }
    assert!(!namespace::assigned("\u{0378}"));
}
