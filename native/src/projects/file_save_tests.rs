use super::*;
use research_workbench_native_sdk::{
    data::{DataRows, DataValue},
    note_document::{NoteDocumentAnalysis, NoteDocumentAnalysisResult},
    writing_file::{WritingNoteCatalogProjection, WritingNotePreparation},
    writing_project::{Decision, Input, SaveFileRequest},
};

fn request(path: &str, content: &str) -> SaveFileRequest {
    SaveFileRequest {
        manuscript_id: " original ".into(),
        relative_path: path.into(),
        content: content.into(),
        expected_sha256: None,
    }
}
fn manuscript() -> DataRows {
    DataRows {
        rows: vec![
            [
                "original", "project", "title", "main.tex", "active", "created", "updated",
            ]
            .into_iter()
            .map(|value| DataValue::Text(value.into()))
            .collect(),
        ],
    }
}
#[test]
fn save_preparation_defers_note_errors_preserves_raw_input_and_bib_precedence() {
    assert!(matches!(
        decide(Input::PrepareFileSave {
            request: request(" References.BIB ", "invalid"),
            note_title: "x".into()
        })
        .unwrap()
        .decision,
        Decision::Rejected {
            reason: ProjectError::ManagedBibliography(_)
        }
    ));
    let original = request(" notes/未命名.ranote ", "not json");
    let Decision::FileSavePrepared { preparation } = decide(Input::PrepareFileSave {
        request: original.clone(),
        note_title: "未命名".into(),
    })
    .unwrap()
    .decision
    else {
        panic!("prepare");
    };
    assert_eq!(preparation.request, original);
    assert_eq!(preparation.file_kind, "other");
    assert!(matches!(
        preparation.note,
        WritingNotePreparation::Invalid { .. }
    ));
    assert!(matches!(
        decide(Input::FinishFileSave {
            preparation: preparation.clone(),
            manuscript: DataRows { rows: vec![] },
            note_analysis: None
        })
        .unwrap()
        .decision,
        Decision::Rejected {
            reason: ProjectError::ManuscriptNotFound
        }
    ));
    assert!(matches!(
        decide(Input::FinishFileSave {
            preparation,
            manuscript: manuscript(),
            note_analysis: None
        })
        .unwrap()
        .decision,
        Decision::FileSave { .. }
    ));
}

#[test]
fn note_policy_consumes_matching_core_analysis_and_keeps_domain_error_before_generic_error() {
    let content = serde_json::json!({"schemaVersion":1.0,"noteId":"note","blocks":[{"id":"block","type":"paragraph","props":{},"content":{"kind":"inline","items":[{"type":"mention"}]},"children":[]}]}).to_string();
    let Decision::FileSavePrepared { preparation } = decide(Input::PrepareFileSave {
        request: request("note.ranote", &content),
        note_title: "note".into(),
    })
    .unwrap()
    .decision
    else {
        panic!("prepare");
    };
    let WritingNotePreparation::Document { note } = &preparation.note else {
        panic!("document");
    };
    let mut analysis = NoteDocumentAnalysis {
        document: note.document.clone(),
        known_block_types: vec!["paragraph".into()],
        result: NoteDocumentAnalysisResult::Invalid {
            cause: "generic error".into(),
        },
    };
    let Decision::FileSave { plan } = decide(Input::FinishFileSave {
        preparation: preparation.clone(),
        manuscript: manuscript(),
        note_analysis: Some(Box::new(analysis.clone())),
    })
    .unwrap()
    .decision
    else {
        panic!("plan");
    };
    assert_eq!(
        plan.catalog,
        WritingNoteCatalogProjection::Invalid {
            cause: "writing_note_mention_unsupported：写作笔记不支持科研提及。".into()
        }
    );
    analysis.document.page_id = "another".into();
    assert!(matches!(
        decide(Input::FinishFileSave {
            preparation,
            manuscript: manuscript(),
            note_analysis: Some(Box::new(analysis))
        }),
        Err(InputError::NoteAnalysis)
    ));
}
