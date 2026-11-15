use super::*;
use research_workbench_native_sdk::{
    data::{DataRows, DataValue},
    writing_file::{FileChangeAction, FileChangeRequest},
    writing_project::{Decision, Input, MetadataDecision},
};
fn manuscript() -> DataRows {
    DataRows {
        rows: vec![
            [
                "original",
                "project",
                "  legacy  ",
                "main.tex",
                "active",
                "created",
                "updated",
            ]
            .into_iter()
            .map(|value| DataValue::Text(value.into()))
            .collect(),
        ],
    }
}
fn rename(to: &str) -> FileChangeRequest {
    FileChangeRequest::Rename {
        manuscript_id: " original ".into(),
        from_path: " main.tex ".into(),
        to_path: to.into(),
    }
}
#[test]
fn rename_plan_preserves_deferred_raw_root_validation_and_original_note_timestamp_rule() {
    let Decision::FileChange { plan } = decide(Input::PlanFileChange {
        request: rename(" moved.tex "),
        manuscript: manuscript(),
    })
    .unwrap()
    .decision
    else {
        panic!("rename")
    };
    let FileChangeAction::Rename {
        root_metadata,
        on_unindexed,
        ..
    } = plan.action
    else {
        panic!("action")
    };
    assert_eq!(on_unindexed, ProjectError::FileNotFound);
    assert!(matches!(
        root_metadata,
        Some(MetadataDecision::Rejected {
            reason: ProjectError::InvalidPath
        })
    ));
    let Decision::FileChange { plan } = decide(Input::PlanFileChange {
        request: rename("notes/Root.RANOTE"),
        manuscript: manuscript(),
    })
    .unwrap()
    .decision
    else {
        panic!("rename")
    };
    let FileChangeAction::Rename {
        touch_destination,
        root_metadata,
        ..
    } = plan.action
    else {
        panic!("action")
    };
    assert!(touch_destination);
    let Some(MetadataDecision::Ready { metadata }) = root_metadata else {
        panic!("root metadata")
    };
    assert_eq!(metadata.root_path, "notes/Root.RANOTE");
    assert_eq!(metadata.title, "legacy");
    assert_eq!(require_file_index_rows(0), Err(ProjectError::FileNotFound));
    assert!(require_file_index_rows(1).is_ok());
}
#[test]
fn change_preparation_and_delete_keep_source_bib_missing_project_and_root_error_order() {
    let request = FileChangeRequest::Rename {
        manuscript_id: "missing".into(),
        from_path: " From.BIB ".into(),
        to_path: "To.bib".into(),
    };
    assert_eq!(
        decide(Input::PrepareFileChange { request })
            .unwrap()
            .decision,
        Decision::Rejected {
            reason: ProjectError::ManagedBibliography(" From.BIB ".into())
        }
    );
    let request = FileChangeRequest::Delete {
        manuscript_id: "original".into(),
        relative_path: " main.tex ".into(),
    };
    assert_eq!(
        decide(Input::PlanFileChange {
            request: request.clone(),
            manuscript: DataRows { rows: vec![] }
        })
        .unwrap()
        .decision,
        Decision::Rejected {
            reason: ProjectError::ManuscriptNotFound
        }
    );
    assert_eq!(
        decide(Input::PlanFileChange {
            request,
            manuscript: manuscript()
        })
        .unwrap()
        .decision,
        Decision::Rejected {
            reason: ProjectError::InvalidPath
        }
    );
}
