use super::*;

#[test]
fn host_inventory_keeps_original_order_kind_hash_and_closed_wire() {
    use research_workbench_native_sdk::{
        data::{DataRows, DataValue},
        writing_project::{Decision, HostResourceFile, Input, Operation},
    };
    let row = |path: &str, kind: &str, hash: &str| {
        vec![
            DataValue::Text("m".into()),
            DataValue::Text(path.into()),
            DataValue::Text(kind.into()),
            DataValue::Integer(-1),
            DataValue::Text(hash.into()),
            DataValue::Text("legacy-time".into()),
        ]
    };
    let input = Input::HostFiles {
        manuscript_id: "m".into(),
        rows: DataRows {
            rows: vec![
                row("Z.tex", "tex", "h1"),
                row("a.png", "image", "h2"),
                row("other", "legacy", "raw-hash"),
            ],
        },
    };
    assert_eq!(input.operation(), Operation::HostFiles);
    let output = decide(input.clone()).unwrap();
    assert_eq!(output.input, input);
    let Decision::HostFiles { items } = output.decision else {
        panic!()
    };
    assert_eq!(
        items
            .iter()
            .map(|item| item.relative_path.as_str())
            .collect::<Vec<_>>(),
        ["Z.tex", "a.png", "other"]
    );
    assert_eq!(items[1].kind, "image");
    assert_eq!(items[2].sha256, "raw-hash");
    let mut wire = serde_json::to_value(&items[0]).unwrap();
    assert_eq!(wire["relativePath"], "Z.tex");
    wire["writer"] = serde_json::json!(true);
    assert!(serde_json::from_value::<HostResourceFile>(wire).is_err());
    let mut input_wire = serde_json::to_value(&input).unwrap();
    input_wire["sql"] = serde_json::json!("injected");
    assert!(serde_json::from_value::<Input>(input_wire).is_err());
    let mut wrong = input;
    let Input::HostFiles { manuscript_id, .. } = &mut wrong else {
        panic!()
    };
    *manuscript_id = "other".into();
    assert!(matches!(decide(wrong), Err(InputError::Identity(_))));
}

#[test]
fn citation_redo_decoding_preserves_absence_empty_arrays_and_legacy_fields() {
    use research_workbench_native_sdk::{
        data::{DataRows, DataValue},
        writing_project::{Decision, Input},
    };
    let prepared = |rows| {
        decide(Input::PrepareFileRecovery {
            manuscript_id: "original".into(),
            pending: DataRows { rows },
        })
    };
    assert!(matches!(
        prepared(vec![]).unwrap().decision,
        Decision::FileRecovery { recovery: None, .. }
    ));
    let Decision::FileRecovery {
        recovery: Some(empty),
        ..
    } = prepared(vec![vec![DataValue::Text("[]".into())]])
        .unwrap()
        .decision
    else {
        panic!("empty redo");
    };
    assert_eq!(empty.file_kind, "tex");
    assert!(empty.writes.is_empty());
    let payload =
        r#"[{"path":" ../RAW.tex ","previous":"legacy","content":"正文\r\n","oldExtra":true}]"#;
    let original = citation_key_writes(payload).unwrap();
    let Decision::FileRecovery {
        recovery: Some(plan),
        ..
    } = prepared(vec![vec![DataValue::Text(payload.into())]])
        .unwrap()
        .decision
    else {
        panic!("redo");
    };
    assert_eq!(plan.writes, original);
    assert_eq!(plan.writes[0].path, " ../RAW.tex ");
    assert_eq!(plan.writes[0].content, "正文\r\n");
    assert!(matches!(
        prepared(vec![vec![DataValue::Text("[{}]".into())]]),
        Err(InputError::Json { .. })
    ));
    assert!(matches!(
        prepared(vec![vec![DataValue::Null]]),
        Err(InputError::Cell { .. })
    ));
}

#[test]
fn recovery_preparation_keeps_original_retention_raw_input_and_clear_path_rules() {
    use research_workbench_native_sdk::{
        data::{DataRows, DataValue},
        writing_project::{Decision, Input, RecoveryDraftInput},
    };
    let manuscript = DataRows {
        rows: vec![
            [
                "original", "project", "title", "main.tex", "active", "created", "updated",
            ]
            .into_iter()
            .map(|value| DataValue::Text(value.into()))
            .collect(),
        ],
    };
    let draft = RecoveryDraftInput {
        manuscript_id: " original ".into(),
        relative_path: "notes/草稿.tex".into(),
        base_sha256: "z".repeat(64),
        content: "正文\r\n".into(),
    };
    let Decision::RecoveryDraftPrepared {
        draft: prepared,
        retention,
    } = decide(Input::PrepareRecoveryDraft {
        draft: draft.clone(),
        manuscript,
    })
    .unwrap()
    .decision
    else {
        panic!("prepared");
    };
    assert_eq!(prepared, draft);
    assert_eq!(retention.per_manuscript, 32);
    assert_eq!(retention.total, 128);
    assert_eq!(
        decide(Input::PrepareRecoveryClear {
            manuscript_id: "missing".into(),
            relative_path: "main.tex".into()
        })
        .unwrap()
        .decision,
        Decision::RecoveryClearPrepared {
            manuscript_id: "missing".into(),
            relative_path: "main.tex".into()
        }
    );
    assert!(matches!(
        decide(Input::PrepareRecoveryClear {
            manuscript_id: "missing".into(),
            relative_path: "../main.tex".into()
        })
        .unwrap()
        .decision,
        Decision::Rejected {
            reason: ProjectError::InvalidPath
        }
    ));
}

#[test]
fn status_finisher_uses_actual_count_and_keeps_skipped_read_distinct_from_empty_rows() {
    use research_workbench_native_sdk::{
        data::{DataRows, DataValue},
        writing_project::{Decision, Input, Rejection},
    };
    let skipped = Input::FinishStatus {
        manuscript_id: "legacy".into(),
        affected_rows: 0,
        manuscript: None,
    };
    let output = decide(skipped.clone()).unwrap();
    assert_eq!(output.input, skipped);
    assert_eq!(
        output.decision,
        Decision::Rejected {
            reason: Rejection::ManuscriptNotFound
        }
    );
    let rows = DataRows {
        rows: vec![
            [
                "legacy",
                "project",
                "  title  ",
                "main.tex",
                "archived",
                "created",
                "updated",
            ]
            .into_iter()
            .map(|value| DataValue::Text(value.into()))
            .collect(),
        ],
    };
    let complete = Input::FinishStatus {
        manuscript_id: "legacy".into(),
        affected_rows: 1,
        manuscript: Some(rows),
    };
    let Decision::Project { manuscript } = decide(complete).unwrap().decision else {
        panic!("project");
    };
    assert_eq!(manuscript.id, "legacy");
    assert_eq!(manuscript.title, "  title  ");
    assert_eq!(manuscript.status, "archived");
    assert!(matches!(
        decide(Input::FinishStatus {
            manuscript_id: "legacy".into(),
            affected_rows: 1,
            manuscript: None
        }),
        Err(InputError::MissingRelated("status readback"))
    ));
}

#[test]
fn file_classification_and_post_io_root_check_keep_the_original_extension_policy() {
    for (path, expected) in [
        ("MAIN.TEX", "tex"),
        ("references.bib", "bib"),
        ("figures/图.PDF", "image"),
        ("main.sty", "style"),
        ("notes/main.ranote", "other"),
        ("main.tex ", "other"),
    ] {
        assert_eq!(file_kind(path), expected);
    }
    assert!(require_tex_root("sections/main.TEX").is_ok());
    assert_eq!(
        require_tex_root("sections/main.ranote"),
        Err(ProjectError::InvalidPath)
    );
}

#[test]
fn creation_preserves_original_template_bytes_and_defers_invalid_metadata() {
    use research_workbench_native_sdk::writing_project::{
        Decision, Input, ManuscriptDraft, MetadataDecision, ProjectScope, STANDALONE_PROJECT_ID,
    };
    let input = Input::PrepareCreation {
        manuscript_id: "8cbfd428-3ac1-4bce-b4f6-d41f31063d8e".into(),
        draft: ManuscriptDraft {
            project_id: Some("  ".into()),
            title: "  A {研究}  ".into(),
            root_path: None,
        },
    };
    let Decision::Creation { plan } = decide(input).unwrap().decision else {
        panic!("creation");
    };
    assert_eq!(
        plan.scope,
        ProjectScope::Standalone {
            project_id: STANDALONE_PROJECT_ID.into()
        }
    );
    let MetadataDecision::Ready { metadata } = plan.metadata else {
        panic!("metadata");
    };
    assert_eq!(metadata.title, "A {研究}");
    assert_eq!(metadata.root_path, "main.tex");
    let template = plan.initial_template.unwrap();
    assert_eq!(template.kind, "tex");
    assert_eq!(
        template.content,
        "\\documentclass{article}\n\\usepackage[utf8]{inputenc}\n\\title{A 研究}\n\\begin{document}\n\\maketitle\n\n\\bibliographystyle{plain}\n\\bibliography{references}\n\\end{document}\n"
    );
}

#[test]
fn metadata_keeps_scalar_limit_root_spelling_and_original_rejection_order() {
    assert!(validate_metadata(&"稿".repeat(180), "sections/main.tex").is_ok());
    assert_eq!(
        validate_metadata(&"稿".repeat(181), "../main.tex"),
        Err(ProjectError::InvalidManuscript)
    );
    assert_eq!(
        validate_metadata("", "../main.tex"),
        Err(ProjectError::InvalidManuscript)
    );
    assert_eq!(
        validate_metadata("Title", "../main.tex"),
        Err(ProjectError::InvalidPath)
    );
    assert!(validate_metadata("Title", "sections/main.tex ").is_err());
}

#[test]
fn session_keeps_original_path_validation_without_adding_membership_rules() {
    let mut draft = WritingSessionDraft {
        manuscript_id: "original".into(),
        open_paths: vec!["main.tex".into()],
        active_path: Some("sections/current.tex".into()),
        cursor_state: serde_json::json!({"offset": 3}),
        layout_state: serde_json::json!({"original": true}),
    };
    assert!(validate_session(&draft).is_ok());
    draft.open_paths.push("../escape.tex".into());
    assert_eq!(validate_session(&draft), Err(ProjectError::InvalidPath));
    draft.open_paths.clear();
    draft.active_path = Some("bad\\name.tex".into());
    assert_eq!(validate_session(&draft), Err(ProjectError::InvalidPath));
    draft.active_path = None;
    assert!(validate_session(&draft).is_ok());
}

#[test]
fn recovery_keeps_byte_limits_legacy_hash_acceptance_and_path_first() {
    let mut draft = RecoveryDraftInput {
        manuscript_id: "original".into(),
        relative_path: "main.tex".into(),
        base_sha256: "é".repeat(32),
        content: "x".repeat(8 * 1024 * 1024),
    };
    assert!(validate_recovery_draft(&draft).is_ok());
    draft.content.push('x');
    assert_eq!(
        validate_recovery_draft(&draft),
        Err(ProjectError::InvalidManuscript)
    );
    draft.relative_path = "../escape.tex".into();
    assert_eq!(
        validate_recovery_draft(&draft),
        Err(ProjectError::InvalidPath)
    );
}

#[test]
fn managed_bibliography_keeps_case_insensitive_suffix_and_original_error_path() {
    let original = " Refs.BIB ";
    assert!(is_managed_bibliography(original));
    assert_eq!(
        require_editable_path(original),
        Err(ProjectError::ManagedBibliography(original.into()))
    );
    assert!(!is_managed_bibliography("refs.bib.bak"));
    assert!(require_editable_path("refs.bib.bak").is_ok());
}
