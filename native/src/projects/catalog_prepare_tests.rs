use super::*;
use research_workbench_native_sdk::{
    data::{DataRows, DataValue},
    note_document::{NoteDocumentAnalysis, NoteDocumentAnalysisResult},
    writing_catalog::{
        CatalogDecision, CatalogInput, FileRead, ItemEffect, ItemInput, ItemPreparation,
        PendingFile, PreparationScope,
    },
    writing_file::{WritingNoteCatalogProjection, WritingNotePreparation},
};

fn item(path: &str, read: FileRead) -> ItemPreparation {
    let input = ItemInput {
        file: PendingFile {
            manuscript_id: " raw ".into(),
            path: path.into(),
            hash: "old".into(),
        },
        read,
        note_title: "Title".into(),
    };
    let CatalogDecision::PrepareItem { preparation } =
        catalog_prepare::decide(&CatalogInput::PrepareItem {
            item: Box::new(input),
        })
        .unwrap()
    else {
        panic!("preparation")
    };
    *preparation
}
fn finish(preparation: ItemPreparation, analysis: Option<NoteDocumentAnalysis>) -> ItemEffect {
    let CatalogDecision::FinishItem { plan } = catalog_prepare::decide(&CatalogInput::FinishItem {
        preparation: Box::new(preparation),
        analysis,
    })
    .unwrap() else {
        panic!("plan")
    };
    assert_eq!(plan.duplicate_identity_cause, DUPLICATE_NOTE_IDENTITY);
    plan.effect
}

#[test]
fn catalog_scope_rows_and_counts_preserve_the_original_tolerance_and_order() {
    assert_eq!(
        catalog_statuses(PreparationScope::Active),
        ("active", "active")
    );
    assert_eq!(
        catalog_statuses(PreparationScope::Archived),
        ("archived", "archived")
    );
    assert_eq!(
        catalog_statuses(PreparationScope::Live),
        ("active", "archived")
    );
    let rows = DataRows {
        rows: vec![vec![
            DataValue::Text(" id ".into()),
            DataValue::Text(" notes/原文.ranote ".into()),
            DataValue::Text("legacy".into()),
        ]],
    };
    let CatalogDecision::Pending { files } =
        catalog_prepare::decide(&CatalogInput::Pending { rows }).unwrap()
    else {
        panic!("pending")
    };
    assert_eq!(
        files,
        [PendingFile {
            manuscript_id: " id ".into(),
            path: " notes/原文.ranote ".into(),
            hash: "legacy".into()
        }]
    );
    let CatalogDecision::Finish { result } = catalog_prepare::decide(&CatalogInput::Finish {
        processed_count: 8,
        rows: DataRows {
            rows: vec![vec![DataValue::Integer(1), DataValue::Integer(2)]],
        },
    })
    .unwrap() else {
        panic!("counts")
    };
    assert_eq!(
        (
            result.processed_count,
            result.pending_count,
            result.error_count
        ),
        (8, 1, 2)
    );
    assert!(
        catalog_prepare::decide(&CatalogInput::Pending {
            rows: DataRows {
                rows: vec![vec![DataValue::Null; 3]]
            }
        })
        .is_err()
    );
}

#[test]
fn catalog_read_outcomes_keep_external_change_and_read_failure_distinct_from_invalid_note() {
    let changed = item(
        "note.ranote",
        FileRead::Read {
            content: "not json".into(),
            hash: "new".into(),
        },
    );
    assert!(changed.note.is_none());
    assert_eq!(finish(changed, None), ItemEffect::ExternalChange {});
    let missing = item(
        "note.ranote",
        FileRead::Failed {
            cause: "稿件文件不存在".into(),
        },
    );
    assert_eq!(
        finish(missing, None),
        ItemEffect::Error {
            cause: "writing_note_catalog_read_failed：稿件文件不存在".into()
        }
    );
    let invalid = item(
        "note.ranote",
        FileRead::Read {
            content: "not json".into(),
            hash: "old".into(),
        },
    );
    assert!(matches!(
        invalid.note,
        Some(WritingNotePreparation::Invalid { .. })
    ));
    assert!(matches!(
        finish(invalid, None),
        ItemEffect::Record {
            projection: WritingNoteCatalogProjection::Invalid { .. }
        }
    ));
}

#[test]
fn catalog_uses_raw_extension_and_does_not_apply_file_edit_or_manuscript_existence_policy() {
    for path in ["notes/note.ranote ", "References.BIB"] {
        let prepared = item(
            path,
            FileRead::Read {
                content: "not json".into(),
                hash: "old".into(),
            },
        );
        assert_eq!(
            finish(prepared, None),
            ItemEffect::Record {
                projection: WritingNoteCatalogProjection::Ignored
            }
        );
    }
    let prepared = item(
        "notes/旧.RANOTE",
        FileRead::Read {
            content: r#"{"schemaVersion":1,"noteId":"stable","blocks":[]}"#.into(),
            hash: "old".into(),
        },
    );
    let Some(WritingNotePreparation::Document { note }) = &prepared.note else {
        panic!("document")
    };
    let mut analysis = NoteDocumentAnalysis {
        document: note.document.clone(),
        known_block_types: vec![],
        result: NoteDocumentAnalysisResult::Ready {
            text: "".into(),
            folded_text: "".into(),
        },
    };
    assert_eq!(
        finish(prepared.clone(), Some(analysis.clone())),
        ItemEffect::Record {
            projection: WritingNoteCatalogProjection::Ready {
                note_id: "stable".into(),
                text: "".into(),
                folded_text: "".into()
            }
        }
    );
    analysis.document.page_id = "another".into();
    assert!(matches!(
        catalog_prepare::decide(&CatalogInput::FinishItem {
            preparation: Box::new(prepared),
            analysis: Some(analysis)
        }),
        Err(InputError::NoteAnalysis)
    ));
}
