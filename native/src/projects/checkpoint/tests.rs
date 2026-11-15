use super::*;
use research_workbench_native_sdk::writing_checkpoint::{DocumentOperation, EditorReceipt};
fn fixture() -> DocumentCheckpoint {
    DocumentCheckpoint {
        schema_version: 1,
        manuscript_id: "synthetic".into(),
        relative_path: "main.tex".into(),
        version: 3,
        content: "candidate".into(),
        review_baseline: "baseline".into(),
        saved_sha256: "a".repeat(64),
        saved_version: 2,
        operations: vec![],
        save_intent: None,
        editor_receipt: None,
    }
}
#[test]
fn original_idempotent_retry_precedes_expected_revision_and_keep_keeps_text() {
    let current = CheckpointRecord {
        revision: 2,
        checkpoint: fixture(),
    };
    let retry = CheckpointWrite {
        expected_revision: Some(1),
        checkpoint: fixture(),
    };
    let unchanged = plan(&retry, Some(&current)).unwrap();
    assert!(!unchanged.write_required);
    assert_eq!(unchanged.record, current);
    let mut keep = retry;
    keep.expected_revision = Some(2);
    keep.checkpoint.version += 1;
    keep.checkpoint.review_baseline = keep.checkpoint.content.clone();
    let saved = plan(&keep, Some(&current)).unwrap();
    assert!(saved.write_required);
    assert_eq!(saved.record.revision, 3);
    assert_eq!(saved.record.checkpoint.content, current.checkpoint.content);
    let mut stale = keep.clone();
    stale.expected_revision = Some(1);
    assert_eq!(
        plan(&stale, Some(&current)).unwrap_err(),
        ProjectError::CheckpointConflict
    );
}
#[test]
fn receipt_observation_and_operation_prefix_survive_the_same_original_rules() {
    let mut checkpoint = fixture();
    let observed = "observed editor text";
    checkpoint.operations.push(DocumentOperation {
        operation_id: "operation".into(),
        conversation_id: "conversation".into(),
        request_id: "request".into(),
        result_sha256: format!("{:x}", Sha256::digest(observed.as_bytes())),
    });
    checkpoint.editor_receipt = Some(EditorReceipt {
        operation_id: "operation".into(),
        session_id: "session".into(),
        revision: "editor-revision".into(),
        text: observed.into(),
        state_version: Some(2),
    });
    validate(&checkpoint).unwrap();
    let record = CheckpointRecord {
        revision: 1,
        checkpoint: checkpoint.clone(),
    };
    let mut write = CheckpointWrite {
        expected_revision: Some(1),
        checkpoint,
    };
    write.checkpoint.version += 1;
    write.checkpoint.content.push_str(" user input");
    assert_eq!(
        plan(&write, Some(&record))
            .unwrap()
            .record
            .checkpoint
            .editor_receipt,
        record.checkpoint.editor_receipt
    );
    write.checkpoint.operations.clear();
    assert_eq!(
        plan(&write, Some(&record)).unwrap_err(),
        ProjectError::InvalidCheckpoint
    );
}
#[test]
fn persisted_read_rejects_wrong_identity_and_preserves_legacy_optional_fields() {
    let checkpoint = fixture();
    let mut value = serde_json::to_value(&checkpoint).unwrap();
    value.as_object_mut().unwrap().remove("editorReceipt");
    let record = decode("synthetic", "main.tex", 7, &value.to_string()).unwrap();
    assert_eq!(record.checkpoint, checkpoint);
    assert_eq!(record.revision, 7);
    assert!(matches!(
        decode("other", "main.tex", 7, &value.to_string()),
        Err(CheckpointReadError::Rejected(
            ProjectError::InvalidCheckpoint
        ))
    ));
    value.as_object_mut().unwrap().remove("saveIntent");
    assert!(matches!(
        decode("synthetic", "main.tex", 7, &value.to_string()),
        Err(CheckpointReadError::Json(_))
    ));
}
