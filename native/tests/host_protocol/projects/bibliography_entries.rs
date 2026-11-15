use super::*;
use research_workbench_native_sdk::writing_bibliography::{
    EntryDecision, EntryInput, ImportedRecord,
};
use research_workbench_native_sdk::writing_project::CitationBinding;
use research_writing_projects_native::bibliography::entries;
use serde_json::json;

#[test]
fn actual_host_projects_original_bibliography_entries_with_owned_staged_inputs() {
    let fixture = Fixture::new();
    let rows = vec![ImportedRecord {
        id: "existing-entry".into(),
        citation_key: "StoredKey".into(),
        original_key: "OriginalKey".into(),
        original_bibtex: "raw\r\n".into(),
        bibtex_entry: "@book{StoredKey,title={甲🧬乙}}".into(),
        imported_json: "{\"legacy\":true}".into(),
        library_item_id: None,
    }];
    let prepared = entries::prepare_imported("original-M", rows.clone(), "")
        .unwrap()
        .remove(0);
    let inputs = [
        Input::BibliographyEntries {
            input: Box::new(EntryInput::PrepareImported {
                manuscript_id: "original-M".into(),
                rows,
                support: String::new(),
            }),
        },
        Input::BibliographyEntries {
            input: Box::new(EntryInput::FinishImported {
                entry: Box::new(prepared.clone()),
                imported: json!({"legacy":true}),
                paths: vec!["refs.bib".into()],
                base_key: None,
                library_item: None,
            }),
        },
    ];
    let requests = vec![
        request(RequestBody::Initialize {}),
        stage(&fixture, &inputs[0]),
        stage(&fixture, &inputs[1]),
        request(RequestBody::Shutdown {}),
    ];
    let output = execute(&fixture, &requests);
    assert!(output.status.success(), "{:?}", output);
    let replies = responses(&output, &requests);
    let first = project_result(&fixture, &replies[1]);
    assert_eq!(first.input, inputs[0]);
    let Decision::BibliographyEntries { decision } = first.decision else {
        panic!("entry phase");
    };
    assert_eq!(
        *decision,
        EntryDecision::ImportedPrepared {
            entries: vec![prepared]
        }
    );
    let second = project_result(&fixture, &replies[2]);
    assert_eq!(second.input, inputs[1]);
    let Decision::BibliographyEntries { decision } = second.decision else {
        panic!("entry phase");
    };
    let EntryDecision::Entry { entry } = *decision else {
        panic!("entry projection");
    };
    assert_eq!(entry.manuscript_id, "original-M");
    assert_eq!(entry.original_bibtex, "raw\r\n");
    assert_eq!(entry.current["title"], "甲🧬乙");
    assert_eq!(entry.imported, json!({"legacy":true}));
    assert_eq!(entry.paths, ["refs.bib"]);
    let json = serde_json::to_value(entry).unwrap();
    assert_eq!(json["libraryItem"], serde_json::Value::Null);
    assert!(json.get("baseKey").is_none());
}

#[test]
fn actual_host_projects_automatic_entries_and_skips_duplicate_before_parsing() {
    let fixture = Fixture::new();
    let binding = CitationBinding {
        manuscript_id: "stored-M".into(),
        literature_item_id: "source-item".into(),
        citation_key: "AutoKey".into(),
        bibtex_entry: "@book{FirstKey,title={Automatic}}".into(),
        state: "active".into(),
        pinned_at: "pinned".into(),
        updated_at: "updated".into(),
    };
    let prepared = entries::prepare_automatic(" Caller M ", binding.clone(), &[])
        .unwrap()
        .unwrap();
    let mut duplicate = binding.clone();
    duplicate.bibtex_entry = "@book{bad,title={".into();
    let inputs = [
        Input::BibliographyEntries {
            input: Box::new(EntryInput::PrepareAutomatic {
                manuscript_id: " Caller M ".into(),
                binding: Box::new(binding),
                occupied_keys: vec![],
            }),
        },
        Input::BibliographyEntries {
            input: Box::new(EntryInput::FinishAutomatic {
                entry: Box::new(prepared.clone()),
                base_key: Some("base".into()),
                library_item: Some(json!({"id":"source-item","title":"Live metadata"})),
            }),
        },
        Input::BibliographyEntries {
            input: Box::new(EntryInput::PrepareAutomatic {
                manuscript_id: " Caller M ".into(),
                binding: Box::new(duplicate),
                occupied_keys: vec!["AutoKey".into()],
            }),
        },
    ];
    let requests = vec![
        request(RequestBody::Initialize {}),
        stage(&fixture, &inputs[0]),
        stage(&fixture, &inputs[1]),
        stage(&fixture, &inputs[2]),
        request(RequestBody::Shutdown {}),
    ];
    let output = execute(&fixture, &requests);
    assert!(output.status.success(), "{:?}", output);
    let replies = responses(&output, &requests);
    let first = project_result(&fixture, &replies[1]);
    assert_eq!(first.input, inputs[0]);
    let Decision::BibliographyEntries { decision } = first.decision else {
        panic!("entry phase");
    };
    assert_eq!(
        *decision,
        EntryDecision::AutomaticPrepared {
            entry: Some(Box::new(prepared))
        }
    );
    let second = project_result(&fixture, &replies[2]);
    assert_eq!(second.input, inputs[1]);
    let Decision::BibliographyEntries { decision } = second.decision else {
        panic!("entry phase");
    };
    let EntryDecision::Entry { entry } = *decision else {
        panic!("automatic entry");
    };
    assert_eq!(entry.manuscript_id, " Caller M ");
    assert_eq!(entry.id, "binding:source-item");
    assert_eq!(entry.citation_key, "AutoKey");
    assert_eq!(entry.current["bibtexKey"], "FirstKey");
    assert_eq!(entry.base_key.as_deref(), Some("base"));
    assert_eq!(entry.imported, entry.current);
    assert_eq!(
        entry.library_item.as_ref().unwrap()["title"],
        "Live metadata"
    );
    let third = project_result(&fixture, &replies[3]);
    assert_eq!(third.input, inputs[2]);
    let Decision::BibliographyEntries { decision } = third.decision else {
        panic!("duplicate phase");
    };
    assert_eq!(*decision, EntryDecision::AutomaticPrepared { entry: None });
}
