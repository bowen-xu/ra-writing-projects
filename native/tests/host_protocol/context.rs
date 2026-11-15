use super::*;
use research_workbench_native_sdk::writing_context::{
    ContextDecision, ContextInput, WritingContextBuffer, WritingContextError, WritingContextFile,
    WritingContextRequest, WritingContextSelection,
};
use sha2::{Digest, Sha256};

#[test]
fn actual_host_materializes_unicode_and_preserves_each_context_stage() {
    let fixture = Fixture::new();
    let id = uuid::Uuid::nil();
    let hash = format!("{:x}", Sha256::digest("disk"));
    let selected = WritingContextFile {
        relative_path: "main.tex".into(),
        expected_disk_sha256: hash.to_uppercase(),
        buffer: Some(WritingContextBuffer {
            revision: id,
            text: "甲🧬乙".into(),
        }),
        selection: Some(WritingContextSelection {
            start_utf16: 1,
            end_utf16: 3,
        }),
    };
    let stages = [
        ContextInput::Validate {
            request: WritingContextRequest {
                manuscript_id: id,
                files: vec![selected.clone()],
            },
        },
        ContextInput::CurrentFile {
            manuscript_id: id,
            relative_path: "main.tex".into(),
            rows: DataRows {
                rows: vec![vec![DataValue::Text(hash.clone())]],
            },
        },
        ContextInput::Project {
            manuscript_id: id,
            rows: main_rows(&id.to_string(), "title".into()),
        },
        ContextInput::Registered {
            relative_path: "main.tex".into(),
            files: vec![
                research_workbench_native_sdk::writing_project::ManuscriptFile {
                    manuscript_id: id.to_string(),
                    relative_path: "main.tex".into(),
                    kind: "other".into(),
                    size_bytes: 4,
                    sha256: hash.clone(),
                    modified_at: "original".into(),
                },
            ],
        },
        ContextInput::Materialize {
            manuscript_id: id,
            file: selected,
            disk: "disk".into(),
            disk_hash: hash,
            used_bytes: 3,
        },
        ContextInput::CurrentFile {
            manuscript_id: id,
            relative_path: "main.tex".into(),
            rows: DataRows {
                rows: vec![vec![DataValue::Null]],
            },
        },
    ];
    let inputs = stages
        .into_iter()
        .map(|input| Input::Context {
            input: Box::new(input),
        })
        .collect::<Vec<_>>();
    let requests = std::iter::once(request(RequestBody::Initialize {}))
        .chain(inputs.iter().map(|input| stage(&fixture, input)))
        .chain(std::iter::once(request(RequestBody::Shutdown {})))
        .collect::<Vec<_>>();
    let output = execute(&fixture, &requests);
    assert!(output.status.success(), "{output:?}");
    let replies = responses(&output, &requests);
    let decisions = inputs
        .iter()
        .zip(replies[1..=inputs.len()].iter())
        .map(|(input, reply)| {
            let actual = project_result(&fixture, reply);
            assert_eq!(&actual.input, input);
            let Decision::Context { decision } = actual.decision else {
                panic!("context");
            };
            *decision
        })
        .collect::<Vec<_>>();
    assert_eq!(decisions[0], ContextDecision::Validated {});
    let ContextDecision::CurrentFile { request: current } = &decisions[1] else {
        panic!("current file");
    };
    assert!(current.files[0].buffer.is_none());
    assert_eq!(decisions[2], ContextDecision::ProjectAccepted {});
    assert_eq!(decisions[3], ContextDecision::Registered {});
    let ContextDecision::Materialized { source, used_bytes } = &decisions[4] else {
        panic!("materialization");
    };
    assert_eq!(source.text, "🧬");
    assert_eq!(*used_bytes, 3 + "甲🧬乙".len());
    assert_eq!(
        source.revision,
        format!("sha256:{:x}", Sha256::digest("甲🧬乙"))
    );
    assert_eq!(
        decisions[5],
        ContextDecision::Rejected {
            reason: WritingContextError::Unavailable
        }
    );
}
