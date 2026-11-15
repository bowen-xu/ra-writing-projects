use super::Fixture;
use research_workbench_native_sdk::{
    data::{DataRows, DataValue},
    streaming_payload,
    writing_project::{
        CreationPlan, Decision, Input, ManuscriptDraft, MetadataDecision, Output as ProjectOutput,
        ProjectScope, Rejection,
    },
    writing_projects_protocol::{self as protocol, Request, RequestBody, Response, ResponseBody},
};
use std::{
    fs,
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    process::{Command, Output, Stdio},
};

#[path = "projects/bibliography_adoption.rs"]
mod bibliography_adoption;
#[path = "projects/bibliography_entries.rs"]
mod bibliography_entries;
#[path = "projects/bibliography_publication.rs"]
mod bibliography_publication;
#[path = "context.rs"]
mod context;

#[test]
fn projects_decode_original_citation_redo_in_the_actual_host() {
    let fixture = Fixture::new();
    let input = Input::PrepareFileRecovery {
        manuscript_id: "original".into(),
        pending: DataRows {
            rows: vec![vec![DataValue::Text(
                r#"[{"path":"sections/a.tex","previous":"old","content":"正文\r\n","legacy":1}]"#
                    .into(),
            )]],
        },
    };
    let requests = vec![
        request(RequestBody::Initialize {}),
        stage(&fixture, &input),
        request(RequestBody::Shutdown {}),
    ];
    let output = execute(&fixture, &requests);
    assert!(output.status.success(), "{:?}", output);
    let replies = responses(&output, &requests);
    let actual = project_result(&fixture, &replies[1]);
    assert_eq!(actual.input, input);
    let Decision::FileRecovery {
        manuscript_id,
        recovery: Some(plan),
    } = actual.decision
    else {
        panic!("redo");
    };
    assert_eq!(manuscript_id, "original");
    assert_eq!(plan.file_kind, "tex");
    assert_eq!(plan.writes.len(), 1);
    assert_eq!(plan.writes[0].path, "sections/a.tex");
    assert_eq!(plan.writes[0].content, "正文\r\n");
}

fn request(body: RequestBody) -> Request {
    Request {
        protocol_version: 2,
        plugin_id: "writing_projects".into(),
        package_key: "a".repeat(64),
        instance_id: "8cbfd428-3ac1-4bce-b4f6-d41f31063d8e".into(),
        request_id: uuid::Uuid::new_v4().to_string(),
        body,
    }
}
fn stage(fixture: &Fixture, input: &Input) -> Request {
    let mut request = request(RequestBody::Initialize {});
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(fixture.0.join(protocol::input_handle(&request.request_id)))
        .unwrap();
    let (file, digest) = streaming_payload::write_json(file, input).unwrap();
    file.sync_all().unwrap();
    file.set_permissions(fs::Permissions::from_mode(0o400))
        .unwrap();
    request.body = RequestBody::Projects {
        operation: input.operation(),
        snapshot: protocol::input_reference(&request, digest.byte_size, digest.sha256),
    };
    request
}
fn execute(fixture: &Fixture, requests: &[Request]) -> Output {
    let bytes = requests
        .iter()
        .flat_map(|request| {
            let frame = protocol::encode_request(request).unwrap();
            assert!(frame.len() < 4096);
            frame
        })
        .collect::<Vec<_>>();
    let mut child = Command::new(env!("CARGO_BIN_EXE_writing-projects-host"))
        .arg("--project-files-v2")
        .current_dir(&fixture.0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(&bytes).unwrap();
    child.wait_with_output().unwrap()
}
fn responses(output: &Output, requests: &[Request]) -> Vec<Response> {
    let lines = output
        .stdout
        .split(|byte| *byte == b'\n')
        .filter(|frame| !frame.is_empty())
        .collect::<Vec<_>>();
    assert_eq!(lines.len(), requests.len());
    lines
        .iter()
        .zip(requests)
        .map(|(line, request)| {
            let response = protocol::decode_response(line).unwrap();
            response.validate_for_request(request).unwrap();
            response
        })
        .collect()
}
fn project_result(fixture: &Fixture, response: &Response) -> ProjectOutput {
    let ResponseBody::ProjectResult { payload } = &response.body else {
        panic!("Expected the actual project result");
    };
    let file = fs::File::open(fixture.0.join(&payload.relative_handle)).unwrap();
    assert_eq!(file.metadata().unwrap().permissions().mode() & 0o777, 0o400);
    streaming_payload::read_json(file, payload.byte_size, &payload.sha256).unwrap()
}
fn main_rows(id: &str, title: String) -> DataRows {
    DataRows {
        rows: vec![
            vec![
                id.into(),
                "project".into(),
                title,
                "main.tex".into(),
                "active".into(),
                "created".into(),
                "updated".into(),
            ]
            .into_iter()
            .map(DataValue::Text)
            .collect(),
        ],
    }
}

#[test]
fn real_v2_host_preserves_recovery_retention_and_projects_the_actual_saved_row() {
    use research_workbench_native_sdk::writing_project::RecoveryDraftInput;
    let fixture = Fixture::new();
    let draft = RecoveryDraftInput {
        manuscript_id: "legacy".into(),
        relative_path: "notes/草稿.tex".into(),
        base_sha256: "z".repeat(64),
        content: "正文\r\n".into(),
    };
    let saved = DataRows {
        rows: vec![vec![
            DataValue::Text(draft.manuscript_id.clone()),
            DataValue::Text(draft.relative_path.clone()),
            DataValue::Text(draft.base_sha256.clone()),
            DataValue::Text(draft.content.clone()),
            DataValue::Text("stored time".into()),
        ]],
    };
    let inputs = [
        Input::PrepareRecoveryDraft {
            draft: draft.clone(),
            manuscript: main_rows("legacy", "title".into()),
        },
        Input::ProjectRecoveryDraft {
            manuscript_id: "legacy".into(),
            relative_path: draft.relative_path.clone(),
            rows: saved,
        },
        Input::PrepareRecoveryClear {
            manuscript_id: "missing".into(),
            relative_path: "main.tex".into(),
        },
    ];
    let requests = std::iter::once(request(RequestBody::Initialize {}))
        .chain(inputs.iter().map(|input| stage(&fixture, input)))
        .chain(std::iter::once(request(RequestBody::Shutdown {})))
        .collect::<Vec<_>>();
    let output = execute(&fixture, &requests);
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let replies = responses(&output, &requests);
    let Decision::RecoveryDraftPrepared {
        draft: prepared,
        retention,
    } = project_result(&fixture, &replies[1]).decision
    else {
        panic!("prepared");
    };
    assert_eq!(prepared, draft);
    assert_eq!((retention.per_manuscript, retention.total), (32, 128));
    let Decision::RecoveryDraft { draft: stored } = project_result(&fixture, &replies[2]).decision
    else {
        panic!("stored");
    };
    assert_eq!(stored.content, draft.content);
    assert_eq!(stored.base_sha256, draft.base_sha256);
    assert_eq!(stored.relative_path, draft.relative_path);
    assert_eq!(stored.updated_at, "stored time");
    assert_eq!(
        project_result(&fixture, &replies[3]).decision,
        Decision::RecoveryClearPrepared {
            manuscript_id: "missing".into(),
            relative_path: "main.tex".into()
        }
    );
}

#[test]
fn real_v2_host_prepares_status_finishes_actual_counts_and_checks_root_kind() {
    let fixture = Fixture::new();
    let inputs = [
        Input::PrepareStatus {
            manuscript_id: "legacy".into(),
        },
        Input::FinishStatus {
            manuscript_id: "legacy".into(),
            affected_rows: 0,
            manuscript: None,
        },
        Input::FinishStatus {
            manuscript_id: "legacy".into(),
            affected_rows: 1,
            manuscript: Some(main_rows("legacy", "  old title  ".into())),
        },
        Input::CheckRootKind {
            relative_path: "sections/main.TEX".into(),
        },
        Input::CheckRootKind {
            relative_path: "sections/main.md".into(),
        },
    ];
    let requests = std::iter::once(request(RequestBody::Initialize {}))
        .chain(inputs.iter().map(|input| stage(&fixture, input)))
        .chain(std::iter::once(request(RequestBody::Shutdown {})))
        .collect::<Vec<_>>();
    let output = execute(&fixture, &requests);
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let replies = responses(&output, &requests);
    for (input, response) in inputs.iter().zip(&replies[1..]) {
        assert_eq!(&project_result(&fixture, response).input, input);
    }
    assert_eq!(
        project_result(&fixture, &replies[1]).decision,
        Decision::StatusPrepared {
            manuscript_id: "legacy".into()
        }
    );
    assert_eq!(
        project_result(&fixture, &replies[2]).decision,
        Decision::Rejected {
            reason: Rejection::ManuscriptNotFound
        }
    );
    let Decision::Project { manuscript } = project_result(&fixture, &replies[3]).decision else {
        panic!("project");
    };
    assert_eq!(manuscript.title, "  old title  ");
    assert_eq!(
        project_result(&fixture, &replies[4]).decision,
        Decision::RootKindAccepted {
            relative_path: "sections/main.TEX".into()
        }
    );
    assert_eq!(
        project_result(&fixture, &replies[5]).decision,
        Decision::Rejected {
            reason: Rejection::InvalidPath
        }
    );
}

#[test]
fn real_v2_host_preserves_over_frame_payloads_and_the_original_import_preview() {
    let fixture = Fixture::new();
    let source = fixture.0.join("source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("main.tex"), b"\\documentclass{article}").unwrap();
    let input = Input::ListProjects {
        rows: main_rows("legacy", "x".repeat(protocol::MAX_FRAME_BYTES + 1)),
    };
    let requests = [
        request(RequestBody::Initialize {}),
        stage(&fixture, &input),
        request(RequestBody::PreviewImport {
            source_path: source.to_str().unwrap().into(),
        }),
        request(RequestBody::Shutdown {}),
    ];
    let output = execute(&fixture, &requests);
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let replies = responses(&output, &requests);
    let decoded = project_result(&fixture, &replies[1]);
    assert!(decoded.input == input);
    let Decision::Projects { items } = decoded.decision else {
        panic!("Expected the original project list");
    };
    assert_eq!(items[0].id, "legacy");
    assert_eq!(items[0].title.len(), protocol::MAX_FRAME_BYTES + 1);
    assert!(
        matches!(&replies[2].body, ResponseBody::PreviewImportResult { outcome: research_workbench_native_sdk::protocol::PreviewOutcome::Success { preview } } if preview.file_count == 1 && preview.root_candidates == ["main.tex"])
    );
    assert_eq!(fs::read_dir(&source).unwrap().count(), 1);
}

#[test]
fn real_v2_host_defers_metadata_preserves_missing_project_precedence_and_discloses_json_failure() {
    let fixture = Fixture::new();
    let id = uuid::Uuid::new_v4().to_string();
    let plan = CreationPlan {
        manuscript_id: id.clone(),
        scope: ProjectScope::Existing {
            project_id: "missing".into(),
        },
        metadata: MetadataDecision::Rejected {
            reason: Rejection::InvalidManuscript,
        },
        initial_template: None,
    };
    let inputs = [
        Input::PrepareCreation {
            manuscript_id: id.clone(),
            draft: ManuscriptDraft {
                project_id: Some(" missing ".into()),
                title: "".into(),
                root_path: None,
            },
        },
        Input::VerifyCreation {
            plan: plan.clone(),
            project_exists: DataRows {
                rows: vec![vec![DataValue::Integer(0)]],
            },
        },
        Input::GetProject {
            manuscript_id: id.clone(),
            rows: DataRows { rows: vec![] },
        },
        Input::GetSession {
            manuscript_id: id.clone(),
            manuscript: main_rows(&id, "Synthetic".into()),
            session: Some(DataRows {
                rows: vec![vec![
                    DataValue::Text(id),
                    DataValue::Text("invalid".into()),
                    DataValue::Null,
                    DataValue::Text("{}".into()),
                    DataValue::Text("{}".into()),
                    DataValue::Text("now".into()),
                ]],
            }),
        },
    ];
    let mut requests = vec![request(RequestBody::Initialize {})];
    requests.extend(inputs.iter().map(|input| stage(&fixture, input)));
    requests.push(request(RequestBody::Shutdown {}));
    let output = execute(&fixture, &requests);
    assert!(output.status.success());
    let replies = responses(&output, &requests);
    assert!(
        matches!(project_result(&fixture, &replies[1]).decision, Decision::Creation { plan: actual } if actual == plan)
    );
    assert!(matches!(
        project_result(&fixture, &replies[2]).decision,
        Decision::Rejected {
            reason: Rejection::ProjectNotFound
        }
    ));
    assert!(matches!(
        project_result(&fixture, &replies[3]).decision,
        Decision::Rejected {
            reason: Rejection::ManuscriptNotFound
        }
    ));
    assert!(
        matches!(&replies[4].body, ResponseBody::ProjectFailure { failure, message } if failure.code() == "storage_error" && message.contains("JSON Syntax") && !message.contains("invalid\""))
    );
}

#[test]
fn real_v2_host_rejects_digest_changes_and_symlink_input_without_reading_another_file() {
    let input = Input::ListProjects {
        rows: DataRows { rows: vec![] },
    };
    for symlink in [false, true] {
        let fixture = Fixture::new();
        let mut project = stage(&fixture, &input);
        let RequestBody::Projects { snapshot, .. } = &mut project.body else {
            unreachable!()
        };
        if symlink {
            let path = fixture.0.join(&snapshot.relative_handle);
            let original = fixture.0.join("synthetic-payload.json");
            fs::rename(&path, &original).unwrap();
            std::os::unix::fs::symlink(&original, &path).unwrap();
        } else {
            snapshot.sha256 = "0".repeat(64);
        }
        let requests = [
            request(RequestBody::Initialize {}),
            project,
            request(RequestBody::Shutdown {}),
        ];
        let output = execute(&fixture, &requests);
        assert!(!output.status.success());
        assert_eq!(
            output
                .stdout
                .split(|byte| *byte == b'\n')
                .filter(|line| !line.is_empty())
                .count(),
            1
        );
        assert!(
            String::from_utf8(output.stderr)
                .unwrap()
                .contains("writing_host_snapshot_")
        );
    }
}
