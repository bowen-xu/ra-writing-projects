use super::*;
use research_workbench_native_sdk::{
    data::{DataRows, DataValue},
    writing_directory::{DirectoryDecision, DirectoryInput, DirectoryRequest, DirectoryStage},
};

fn texts(values: &[&str]) -> Vec<DataValue> {
    values
        .iter()
        .map(|value| DataValue::Text((*value).into()))
        .collect()
}
fn manuscript(root: &str) -> DataRows {
    DataRows {
        rows: vec![texts(&[
            "original",
            "project",
            "  legacy  ",
            root,
            "active",
            "created",
            "updated",
        ])],
    }
}
fn rename() -> DirectoryRequest {
    DirectoryRequest::Rename {
        manuscript_id: "original".into(),
        from_path: "chapters".into(),
        to_path: "renamed".into(),
    }
}
fn relation(
    request: DirectoryRequest,
    root: &str,
    session: Option<DataRows>,
) -> research_workbench_native_sdk::writing_directory::DirectoryPlan {
    let DirectoryDecision::Relations { plan } = directories::decide(&DirectoryInput::Relations {
        request,
        manuscript: Some(manuscript(root)),
        files: Some(DataRows { rows: vec![] }),
        drafts: Some(DataRows { rows: vec![] }),
        session,
    }) else {
        panic!("relations")
    };
    *plan
}

#[test]
fn directory_paths_preserve_original_prefix_and_cursor_key_rules() {
    assert_eq!(
        relocate("chapters/方法.tex", "chapters", "renamed"),
        "renamed/方法.tex"
    );
    assert_eq!(
        relocate("chapters-old/main.tex", "chapters", "renamed"),
        "chapters-old/main.tex"
    );
    assert!(path_is_within("chapters", "chapters"));
    assert!(!path_is_within("chapters-old", "chapters"));
    let cursor = serde_json::json!({"chapters/a.tex": {"head": 8}, "chapters-old/a.tex": 2});
    assert_eq!(
        relocate_json_keys(cursor.clone(), "chapters", "renamed"),
        serde_json::json!({"renamed/a.tex": {"head":8}, "chapters-old/a.tex":2})
    );
    assert_eq!(
        remove_json_keys(cursor, "chapters"),
        serde_json::json!({"chapters-old/a.tex":2})
    );
    assert_eq!(
        relocate_json_keys(serde_json::json!([1]), "chapters", "renamed"),
        serde_json::json!({})
    );
    assert_eq!(
        remove_json_keys(serde_json::Value::Null, "chapters"),
        serde_json::json!({})
    );
}

#[test]
fn directory_stages_defer_missing_reads_and_later_session_errors() {
    let plan = relation(rename(), "chapters/main.tex", None);
    assert!(matches!(plan.manuscript, DirectoryStage::Ready { .. }));
    assert!(matches!(plan.files, DirectoryStage::Ready { .. }));
    assert!(matches!(plan.session, DirectoryStage::Unavailable));
    let DirectoryStage::Ready {
        value: Some(metadata),
    } = plan.metadata
    else {
        panic!("metadata")
    };
    assert_eq!(metadata.root_path, "renamed/main.tex");
    assert_eq!(metadata.title, "legacy");
    let session = DataRows {
        rows: vec![vec![
            DataValue::Text("original".into()),
            DataValue::Text("null".into()),
            DataValue::Null,
            DataValue::Text("{}".into()),
            DataValue::Text("{}".into()),
            DataValue::Text("updated".into()),
        ]],
    };
    let plan = relation(rename(), "elsewhere/main.tex", Some(session));
    assert!(matches!(plan.files, DirectoryStage::Ready { .. }));
    let DirectoryStage::Rejected { reason } = plan.session else {
        panic!("deferred session rejection")
    };
    assert_eq!(reason.code(), "storage_error");
    assert!(reason.to_string().contains("open paths JSON"));
    let DirectoryStage::Ready {
        value: Some(metadata),
    } = plan.metadata
    else {
        panic!("metadata even with unrelated root")
    };
    assert_eq!(metadata.title, "legacy");
    assert_eq!(metadata.root_path, "elsewhere/main.tex");
}

#[test]
fn directory_delete_protects_root_and_keeps_recovery_path_rejection_per_item() {
    let request = DirectoryRequest::Delete {
        manuscript_id: "original".into(),
        relative_path: "chapters".into(),
    };
    let plan = relation(
        request.clone(),
        "chapters/main.tex",
        Some(DataRows { rows: vec![] }),
    );
    let DirectoryStage::Rejected { reason } = plan.manuscript else {
        panic!("root protection")
    };
    assert_eq!(reason.to_string(), "稿件路径无效");
    let DirectoryDecision::Relations { plan } = directories::decide(&DirectoryInput::Relations {
        request,
        manuscript: Some(manuscript("main.tex")),
        files: Some(DataRows { rows: vec![] }),
        drafts: Some(DataRows {
            rows: vec![texts(&["chapters/a.tex"]), texts(&["chapters/../bad.tex"])],
        }),
        session: Some(DataRows { rows: vec![] }),
    }) else {
        panic!("relations")
    };
    let DirectoryStage::Ready { value: drafts } = plan.drafts else {
        panic!("drafts")
    };
    assert_eq!(drafts.len(), 2);
    assert_eq!(drafts[0].rejection, None);
    assert_eq!(drafts[1].rejection, Some(ProjectError::InvalidPath));
}
