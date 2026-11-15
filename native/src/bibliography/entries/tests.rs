use super::*;
use serde_json::json;

fn imported() -> ImportedRecord {
    ImportedRecord {
        id: "original-entry".into(),
        citation_key: "LegacyKey".into(),
        original_key: "Original-Key".into(),
        original_bibtex: "original bytes\r\n".into(),
        bibtex_entry: "@article{LegacyKey,title={甲🧬乙},journal=j,custom={Keep}}".into(),
        imported_json: "{\"unrecognized\": [1, null]}".into(),
        library_item_id: None,
    }
}

fn binding(state: &str) -> CitationBinding {
    CitationBinding {
        manuscript_id: "stored legacy manuscript spelling".into(),
        literature_item_id: "source-item".into(),
        citation_key: "PinnedKey".into(),
        bibtex_entry: "@book{OtherStoredKey,title={Automatic}}".into(),
        state: state.into(),
        pinned_at: "pinned".into(),
        updated_at: "updated".into(),
    }
}

#[test]
fn imported_projection_keeps_original_identity_macros_values_and_wire_shape() {
    let rows = vec![imported()];
    let prepared = prepare_imported(" Caller M ", rows.clone(), "@string{j={Journal}}")
        .unwrap()
        .remove(0);
    assert_eq!(prepared.record, rows[0]);
    assert_eq!(
        prepared.current.as_ref().unwrap()["containerTitle"],
        "Journal"
    );
    let paths = vec!["z.bib".into(), "a.bib".into()];
    let result = finish_imported(
        prepared,
        json!({"unrecognized": [1, null]}),
        paths.clone(),
        None,
        None,
    )
    .unwrap();
    assert_eq!(result.manuscript_id, " Caller M ");
    assert_eq!(result.citation_key, "LegacyKey");
    assert_eq!(result.original_bibtex, "original bytes\r\n");
    assert_eq!(result.paths, paths);
    assert_eq!(result.imported, json!({"unrecognized": [1, null]}));
    let wire = serde_json::to_value(&result).unwrap();
    assert!(!wire.as_object().unwrap().contains_key("baseKey"));
    assert!(!wire.as_object().unwrap().contains_key("libraryItemId"));
    assert_eq!(wire["libraryItem"], Value::Null);
    assert_eq!(
        serde_json::from_value::<ProjectBibliographyEntry>(wire.clone()).unwrap(),
        result
    );
    let mut missing = wire;
    missing.as_object_mut().unwrap().remove("libraryItem");
    assert!(serde_json::from_value::<ProjectBibliographyEntry>(missing).is_err());
}

#[test]
fn missing_canonical_entry_stays_deferred_after_related_and_import_json_reads() {
    let mut row = imported();
    row.bibtex_entry = "@book{DifferentKey,title={Other}}".into();
    row.imported_json = "{".into();
    let prepared = prepare_imported("M", vec![row], "").unwrap().remove(0);
    assert!(prepared.current.is_none());
    assert_eq!(prepared.record.imported_json, "{");
    assert!(matches!(
        finish_imported(prepared, Value::Null, vec![], None, None),
        Err(Error::InvalidBibtexEntry)
    ));
}

#[test]
fn automatic_duplicate_skips_parse_and_retains_original_binding_metadata_rules() {
    let mut duplicate = binding("active");
    duplicate.bibtex_entry = "{".into();
    assert!(
        prepare_automatic("M", duplicate, &["PinnedKey".into()])
            .unwrap()
            .is_none()
    );
    let prepared = prepare_automatic(" Caller M ", binding("inactive"), &[])
        .unwrap()
        .unwrap();
    assert!(!prepared.read_library);
    assert_eq!(prepared.reference_id, "binding:source-item");
    assert_eq!(prepared.metadata["bibtexKey"], "OtherStoredKey");
    let result = finish_automatic(
        prepared,
        Some("original-base".into()),
        Some(json!({"discard":true})),
    );
    assert_eq!(result.manuscript_id, " Caller M ");
    assert_eq!(result.citation_key, "PinnedKey");
    assert_eq!(result.base_key.as_deref(), Some("original-base"));
    assert_eq!(result.library_item_id.as_deref(), Some("source-item"));
    assert!(result.library_item.is_none());
    assert_eq!(result.paths, ["references.bib"]);
    assert_eq!(result.imported, result.current);
}

#[test]
fn native_entry_stages_keep_rejection_classes_and_closed_data_only_inputs() {
    let mut row = imported();
    row.bibtex_entry = "@book{bad,title={".into();
    assert!(matches!(
        prepare_imported("M", vec![row], ""),
        Err(Error::BibliographyImport(_))
    ));
    let mut automatic = binding("active");
    automatic.bibtex_entry = "{".into();
    assert!(matches!(
        prepare_automatic("M", automatic, &[]),
        Err(Error::InvalidBibtexEntry)
    ));
    let mut input = serde_json::to_value(EntryInput::PrepareImported {
        manuscript_id: "M".into(),
        rows: vec![],
        support: String::new(),
    })
    .unwrap();
    input["databasePath"] = json!("outside-owner");
    assert!(serde_json::from_value::<EntryInput>(input).is_err());
}
