use super::*;
use research_workbench_native_sdk::writing_context::{
    WritingContextBuffer, WritingContextSelection,
};

fn file() -> WritingContextFile {
    WritingContextFile {
        relative_path: "notes/稿件.tex".into(),
        expected_disk_sha256: format!("{:x}", Sha256::digest("disk")),
        buffer: None,
        selection: None,
    }
}
fn materialize(
    file: WritingContextFile,
    used: usize,
) -> Result<(ContextText, usize), WritingContextError> {
    materialize_file(
        Uuid::nil(),
        file,
        "disk".into(),
        format!("{:x}", Sha256::digest("disk")),
        used,
    )
}

#[test]
fn selected_live_unicode_keeps_original_disk_and_full_buffer_identity() {
    let mut selected = file();
    selected.expected_disk_sha256.make_ascii_uppercase();
    selected.buffer = Some(WritingContextBuffer {
        revision: Uuid::nil(),
        text: "甲🧬乙\r\n".into(),
    });
    selected.selection = Some(WritingContextSelection {
        start_utf16: 1,
        end_utf16: 3,
    });
    validate(&WritingContextRequest {
        manuscript_id: Uuid::nil(),
        files: vec![selected.clone()],
    })
    .unwrap();
    let (source, bytes) = materialize(selected, 9).unwrap();
    assert_eq!(source.text, "🧬");
    assert_eq!(bytes, 9 + "甲🧬乙\r\n".len());
    assert_eq!(
        source.revision,
        format!("sha256:{:x}", Sha256::digest("甲🧬乙\r\n"))
    );
    assert_eq!(
        source.source_id,
        format!(
            "writing:{:x}",
            Sha256::digest(format!("{}/notes/稿件.tex", Uuid::nil()))
        )
    );
    let anchor: serde_json::Value = serde_json::from_str(source.anchor.as_ref().unwrap()).unwrap();
    assert_eq!(anchor["bufferRevision"], Uuid::nil().to_string());
    assert_eq!(anchor["diskSha256"], file().expected_disk_sha256);
    assert_eq!(anchor["startUtf16"], 1);
    assert_eq!(anchor["endUtf16"], 3);
}

#[test]
fn hash_then_selection_then_full_budget_preserves_original_error_order() {
    let mut selected = file();
    selected.selection = Some(WritingContextSelection {
        start_utf16: 1,
        end_utf16: 0,
    });
    selected.expected_disk_sha256 = "f".repeat(64);
    assert_eq!(
        materialize(selected.clone(), MAX_BYTES).unwrap_err(),
        WritingContextError::Conflict
    );
    selected.expected_disk_sha256 = file().expected_disk_sha256;
    assert_eq!(
        materialize(selected, MAX_BYTES).unwrap_err(),
        WritingContextError::InvalidInput
    );
    assert_eq!(
        materialize(file(), MAX_BYTES).unwrap_err(),
        WritingContextError::Budget
    );
    assert_eq!(
        materialize(file(), usize::MAX).unwrap_err(),
        WritingContextError::Budget
    );
    assert_eq!(materialize(file(), MAX_BYTES - 4).unwrap().1, MAX_BYTES);
}

#[test]
fn split_surrogates_and_outside_offsets_are_rejected_after_hash_check() {
    for (start_utf16, end_utf16) in [(1, 2), (2, 3), (0, 5), (3, 3)] {
        let mut selected = file();
        selected.buffer = Some(WritingContextBuffer {
            revision: Uuid::nil(),
            text: "甲🧬乙".into(),
        });
        selected.selection = Some(WritingContextSelection {
            start_utf16,
            end_utf16,
        });
        assert_eq!(
            materialize(selected, 0).unwrap_err(),
            WritingContextError::InvalidInput
        );
    }
}

#[test]
fn request_budget_and_path_rules_keep_original_optional_buffer_revision() {
    let mut request = WritingContextRequest {
        manuscript_id: Uuid::nil(),
        files: vec![file()],
    };
    request.files[0].buffer = Some(WritingContextBuffer {
        revision: Uuid::nil(),
        text: "x".repeat(MAX_BYTES),
    });
    validate(&request).unwrap();
    request.files[0].buffer.as_mut().unwrap().text.push('x');
    assert_eq!(validate(&request).unwrap_err(), WritingContextError::Budget);
    request.files[0].relative_path = "../a.tex".into();
    assert_eq!(
        validate(&request).unwrap_err(),
        WritingContextError::InvalidInput
    );
    request.files = vec![file(), file()];
    assert_eq!(
        validate(&request).unwrap_err(),
        WritingContextError::InvalidInput
    );
    request.files.clear();
    assert_eq!(
        validate(&request).unwrap_err(),
        WritingContextError::InvalidInput
    );
}

#[test]
fn registered_kind_remains_authoritative_instead_of_extension() {
    let mut entry = ManuscriptFile {
        manuscript_id: Uuid::nil().to_string(),
        relative_path: "a.png".into(),
        kind: "other".into(),
        size_bytes: 0,
        sha256: String::new(),
        modified_at: String::new(),
    };
    require_registered("a.png", &[entry.clone()]).unwrap();
    entry.kind = "image".into();
    entry.relative_path = "a.tex".into();
    assert_eq!(
        require_registered("a.tex", &[entry]).unwrap_err(),
        WritingContextError::Unavailable
    );
    assert_eq!(
        require_registered("missing", &[]).unwrap_err(),
        WritingContextError::Unavailable
    );
}

#[test]
fn current_file_row_keeps_query_row_text_codec_and_original_request_defaults() {
    let rows = DataRows {
        rows: vec![vec![DataValue::Text(file().expected_disk_sha256)]],
    };
    let request = current_file(Uuid::nil(), "main.tex", &rows).unwrap();
    assert_eq!(request.files[0].relative_path, "main.tex");
    assert!(request.files[0].buffer.is_none());
    assert!(request.files[0].selection.is_none());
    for rows in [
        DataRows { rows: vec![] },
        DataRows {
            rows: vec![vec![DataValue::Null]],
        },
        DataRows {
            rows: vec![vec![DataValue::Integer(1)]],
        },
    ] {
        assert_eq!(
            current_file(Uuid::nil(), "main.tex", &rows).unwrap_err(),
            WritingContextError::Unavailable
        );
    }
    assert_eq!(
        require_active("archived").unwrap_err(),
        WritingContextError::Unavailable
    );
    require_active("active").unwrap();
}
