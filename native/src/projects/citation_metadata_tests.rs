use super::*;
use research_workbench_native_sdk::{
    data::{DataRows, DataValue},
    writing_project::{CitationMetadataKind, Decision, Input, Rejection},
};

fn strings(values: &[&str]) -> Vec<DataValue> {
    values
        .iter()
        .map(|value| DataValue::Text((*value).into()))
        .collect()
}
fn project() -> DataRows {
    DataRows {
        rows: vec![strings(&[
            "m", "p", "title", "main.tex", "active", "created", "updated",
        ])],
    }
}
fn input(kind: CitationMetadataKind, data: DataRows) -> Input {
    Input::CitationMetadata {
        metadata_kind: kind,
        manuscript_id: "m".into(),
        manuscript: project(),
        data: Some(data),
    }
}

#[test]
fn citation_metadata_preserves_missing_manuscript_precedence_and_required_snapshot() {
    for kind in [
        CitationMetadataKind::Bindings,
        CitationMetadataKind::BibliographyStatus,
    ] {
        let mut request = input(
            kind,
            DataRows {
                rows: vec![vec![DataValue::Null]],
            },
        );
        let Input::CitationMetadata { manuscript, .. } = &mut request else {
            panic!()
        };
        manuscript.rows.clear();
        assert_eq!(
            decide(request).unwrap().decision,
            Decision::Rejected {
                reason: Rejection::ManuscriptNotFound
            }
        );
        let request = Input::CitationMetadata {
            metadata_kind: kind,
            manuscript_id: "m".into(),
            manuscript: project(),
            data: None,
        };
        assert!(matches!(
            decide(request.clone()),
            Err(InputError::MissingRelated(_))
        ));
        let mut wire = serde_json::to_value(&request).unwrap();
        wire.as_object_mut().unwrap().remove("data");
        assert!(serde_json::from_value::<Input>(wire).is_err());
    }
}

#[test]
fn citation_metadata_preserves_full_binding_bytes_order_and_wire_names() {
    let rows = DataRows {
        rows: vec![
            strings(&[
                "m",
                "s1",
                "ZKey",
                "@article{ZKey,\r\n title={原文}}",
                "active",
                "pinned",
                "updated",
            ]),
            strings(&["m", "s2", "aKey", "", "legacy", "old", "new"]),
        ],
    };
    let request = input(CitationMetadataKind::Bindings, rows);
    assert_eq!(
        serde_json::from_str::<Input>(&serde_json::to_string(&request).unwrap()).unwrap(),
        request
    );
    let output = decide(request.clone()).unwrap();
    assert_eq!(output.input, request);
    let Decision::CitationBindings { items } = output.decision else {
        panic!()
    };
    assert_eq!(
        items
            .iter()
            .map(|item| item.citation_key.as_str())
            .collect::<Vec<_>>(),
        ["ZKey", "aKey"]
    );
    assert_eq!(items[0].bibtex_entry, "@article{ZKey,\r\n title={原文}}");
    assert_eq!(items[1].state, "legacy");
    let wire = serde_json::to_value(&items[0]).unwrap();
    assert_eq!(wire["literatureItemId"], "s1");
    assert_eq!(wire["pinnedAt"], "pinned");
}

#[test]
fn citation_metadata_keeps_empty_and_nullable_bibliography_status() {
    let request = input(
        CitationMetadataKind::BibliographyStatus,
        DataRows { rows: vec![] },
    );
    assert_eq!(
        decide(request).unwrap().decision,
        Decision::BibliographyStatus {
            status: empty_bibliography_status()
        }
    );
    let request = input(
        CitationMetadataKind::BibliographyStatus,
        DataRows {
            rows: vec![vec![
                DataValue::Text("refs/原文.bib".into()),
                DataValue::Null,
                DataValue::Null,
                DataValue::Text("conflict".into()),
            ]],
        },
    );
    let Decision::BibliographyStatus { status } = decide(request).unwrap().decision else {
        panic!()
    };
    assert_eq!(status.relative_path, "refs/原文.bib");
    assert_eq!(status.status, "conflict");
    assert!(
        status.content_hash.is_none()
            && status.generated_at.is_none()
            && status.warnings.is_empty()
    );
    let wire = serde_json::to_value(status).unwrap();
    assert!(wire["contentHash"].is_null() && wire["generatedAt"].is_null());
}

#[test]
fn citation_metadata_rejects_other_identity_wrong_cells_and_duplicate_status() {
    assert!(matches!(
        decide(input(
            CitationMetadataKind::Bindings,
            DataRows {
                rows: vec![strings(&["other", "s", "k", "b", "state", "p", "u"])]
            }
        )),
        Err(InputError::Identity(_))
    ));
    assert!(matches!(
        decide(input(
            CitationMetadataKind::Bindings,
            DataRows {
                rows: vec![vec![DataValue::Null; 7]]
            }
        )),
        Err(InputError::Cell { .. })
    ));
    assert!(matches!(
        decide(input(
            CitationMetadataKind::BibliographyStatus,
            DataRows {
                rows: vec![strings(&["refs.bib", "h", "t", "ready"]); 2]
            }
        )),
        Err(InputError::Multiplicity(_))
    ));
    assert!(matches!(
        decide(input(
            CitationMetadataKind::BibliographyStatus,
            DataRows {
                rows: vec![strings(&["refs.bib"])]
            }
        )),
        Err(InputError::Columns { .. })
    ));
}
