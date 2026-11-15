use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};

use research_workbench_native_sdk::protocol::{self, Request, RequestBody};
use serde_json::{Value, json};
use zip::{ZipWriter, write::SimpleFileOptions};

#[cfg(unix)]
#[path = "host_protocol/projects.rs"]
mod projects;

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("writing-host-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn request(body: RequestBody) -> Request {
    Request {
        protocol_version: 1,
        plugin_id: "writing_projects".to_owned(),
        package_key: "a".repeat(64),
        instance_id: "8cbfd428-3ac1-4bce-b4f6-d41f31063d8e".to_owned(),
        request_id: uuid::Uuid::new_v4().to_string(),
        body,
    }
}

fn execute(bytes: &[u8]) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_writing-projects-host"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(bytes).unwrap();
    child.wait_with_output().unwrap()
}

fn execute_session(source: &Path) -> (Output, Vec<Request>) {
    let requests = vec![
        request(RequestBody::Initialize),
        request(RequestBody::PreviewImport {
            source_path: source.to_str().unwrap().to_owned(),
        }),
        request(RequestBody::Shutdown),
    ];
    let bytes = requests
        .iter()
        .flat_map(|request| protocol::encode_request(request).unwrap())
        .collect::<Vec<_>>();
    (execute(&bytes), requests)
}

fn responses(output: &Output, requests: &[Request]) -> Vec<protocol::Response> {
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

#[test]
fn real_host_uses_original_preview_and_preserves_domain_failure() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join("main.tex"), b"\\documentclass{article}").unwrap();
    let (output, requests) = execute_session(&fixture.0);
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let replies = responses(&output, &requests);
    let body = serde_json::to_value(&replies[1].body).unwrap();
    assert_eq!(body["outcome"]["preview"]["fileCount"], 1);
    assert_eq!(
        body["outcome"]["preview"]["rootCandidates"],
        json!(["main.tex"])
    );
    assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);

    let (output, requests) = execute_session(Path::new("relative.zip"));
    assert!(output.status.success());
    let replies = responses(&output, &requests);
    let body = serde_json::to_value(&replies[1].body).unwrap();
    assert_eq!(body["outcome"]["error"]["code"], "invalid_input");
    assert_eq!(body["outcome"]["error"]["message"], "稿件路径无效");
}

#[test]
fn rejects_wrong_lifecycle_version_identity_and_unknown_fields() {
    let before_initialize = protocol::encode_request(&request(RequestBody::Shutdown)).unwrap();
    let result = execute(&before_initialize);
    assert!(!result.status.success());
    assert!(result.stdout.is_empty());

    for mutate in [
        |value: &mut Value| value["protocolVersion"] = json!(2),
        |value: &mut Value| value["unexpected"] = json!(true),
        |value: &mut Value| value["body"]["kind"] = json!("readFile"),
    ] {
        let mut value = serde_json::to_value(request(RequestBody::Initialize)).unwrap();
        mutate(&mut value);
        let mut bytes = serde_json::to_vec(&value).unwrap();
        bytes.push(b'\n');
        let result = execute(&bytes);
        assert!(!result.status.success());
        assert!(result.stdout.is_empty());
    }

    let mut bytes = protocol::encode_request(&request(RequestBody::Initialize)).unwrap();
    let mut different = request(RequestBody::Shutdown);
    different.instance_id = uuid::Uuid::new_v4().to_string();
    bytes.extend(protocol::encode_request(&different).unwrap());
    let result = execute(&bytes);
    assert!(!result.status.success());
    assert_eq!(
        result.stdout.iter().filter(|byte| **byte == b'\n').count(),
        1
    );
    assert!(!String::from_utf8_lossy(&result.stderr).contains(&different.instance_id));
}

#[test]
fn legal_zip_preview_larger_than_mcp_budget_survives_real_host_round_trip() {
    let fixture = Fixture::new();
    let source = fixture.0.join("large-preview.zip");
    let mut archive = ZipWriter::new(File::create(&source).unwrap());
    for index in 0..2500 {
        let name = format!(
            "{index:04}-{}/{}/{}/{}.tex",
            "a".repeat(245),
            "b".repeat(250),
            "c".repeat(250),
            "d".repeat(246)
        );
        archive
            .start_file(name, SimpleFileOptions::default())
            .unwrap();
        archive.write_all(b"\\documentclass{article}").unwrap();
    }
    archive.finish().unwrap();
    let (output, requests) = execute_session(&source);
    assert!(output.status.success());
    assert!(output.stdout.len() > 2 * 1024 * 1024);
    let replies = responses(&output, &requests);
    let body = serde_json::to_value(&replies[1].body).unwrap();
    assert_eq!(body["outcome"]["preview"]["fileCount"], 2500);
    assert_eq!(
        body["outcome"]["preview"]["rootCandidates"]
            .as_array()
            .unwrap()
            .len(),
        2500
    );
    assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
}
