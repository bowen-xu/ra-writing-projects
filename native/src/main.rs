//! Trusted, finite writing import-preview child. Stdout is protocol only.
use std::io::{self, Read, Write};
use std::process::ExitCode;

use research_agent_api::mcp::FrameDecoder;
use research_workbench_native_sdk::protocol::{
    self, CAPABILITY_ID, ImportPreview, MAX_FRAME_BYTES, PreviewErrorCode, PreviewFailure,
    PreviewOutcome, Request, RequestBody, Response, ResponseBody,
};
use research_writing_projects_native::{InspectionError, preview};
mod project_host;

#[derive(Debug, thiserror::Error)]
enum HostError {
    #[error("plugin host input failed")]
    Input,
    #[error("plugin host output failed")]
    Output,
    #[error("plugin host received an invalid protocol message")]
    Protocol,
    #[error("plugin host received an invalid lifecycle message")]
    Lifecycle,
    #[error("plugin host received a different package or instance identity")]
    Identity,
    #[error("plugin host input ended before shutdown")]
    Closed,
}

struct Identity {
    plugin_id: String,
    package_key: String,
    instance_id: String,
}

impl Identity {
    fn from_request(request: &Request) -> Self {
        Self {
            plugin_id: request.plugin_id.clone(),
            package_key: request.package_key.clone(),
            instance_id: request.instance_id.clone(),
        }
    }

    fn matches(&self, request: &Request) -> bool {
        self.plugin_id == request.plugin_id
            && self.package_key == request.package_key
            && self.instance_id == request.instance_id
    }
}

fn inspect(source_path: &str) -> PreviewOutcome {
    match preview(source_path) {
        Ok(inspection) => PreviewOutcome::Success {
            preview: ImportPreview {
                file_count: inspection.files.len() as u64,
                byte_size: inspection.byte_size,
                root_candidates: inspection.root_candidates,
            },
        },
        Err(error) => {
            let code = match &error {
                InspectionError::InvalidPath => PreviewErrorCode::InvalidInput,
                InspectionError::FileTooLarge => PreviewErrorCode::FileTooLarge,
                InspectionError::SymlinkNotAllowed => PreviewErrorCode::UnsafePath,
                InspectionError::Io(_) | InspectionError::Zip(_) => PreviewErrorCode::StorageError,
            };
            PreviewOutcome::Failure {
                error: PreviewFailure {
                    code,
                    message: error.to_string(),
                },
            }
        }
    }
}

fn run(input: &mut impl Read, output: &mut impl Write) -> Result<(), HostError> {
    let mut decoder = FrameDecoder::with_max_frame_bytes(MAX_FRAME_BYTES);
    let mut identity: Option<Identity> = None;
    let mut chunk = [0_u8; 8192];
    loop {
        let count = match input.read(&mut chunk) {
            Ok(0) => return Err(HostError::Closed),
            Ok(count) => count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(HostError::Input),
        };
        let frames = decoder
            .push(&chunk[..count])
            .map_err(|_| HostError::Protocol)?;
        for frame in frames {
            let request = protocol::decode_request(&frame).map_err(|_| HostError::Protocol)?;
            if let Some(identity) = &identity
                && !identity.matches(&request)
            {
                return Err(HostError::Identity);
            }
            let shutdown = matches!(&request.body, RequestBody::Shutdown);
            let body = match (&identity, &request.body) {
                (None, RequestBody::Initialize) => {
                    identity = Some(Identity::from_request(&request));
                    ResponseBody::Initialized {
                        capability: CAPABILITY_ID.to_owned(),
                        version: 1,
                    }
                }
                (Some(_), RequestBody::PreviewImport { source_path }) => {
                    ResponseBody::PreviewImportResult {
                        outcome: inspect(source_path),
                    }
                }
                (Some(_), RequestBody::Shutdown) => ResponseBody::ShutdownComplete,
                _ => return Err(HostError::Lifecycle),
            };
            let response = Response::for_request(&request, body);
            let bytes = protocol::encode_response(&response).map_err(|_| HostError::Protocol)?;
            output.write_all(&bytes).map_err(|_| HostError::Output)?;
            output.flush().map_err(|_| HostError::Output)?;
            if shutdown {
                return Ok(());
            }
        }
    }
}

fn main() -> ExitCode {
    let mut arguments = std::env::args_os().skip(1);
    let result = match (arguments.next(), arguments.next()) {
        (None, None) => run(&mut io::stdin().lock(), &mut io::stdout().lock())
            .map_err(|error| error.to_string()),
        (Some(profile), None) if profile == "--project-files-v2" => {
            project_host::run(&mut io::stdin().lock(), &mut io::stdout().lock())
                .map_err(|error| error.to_string())
        }
        _ => Err("writing_host_profile_invalid".to_owned()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            // Never echo a request, source path, document body or raw serde cause.
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
