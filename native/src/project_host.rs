//! Explicit v2 adapter in the same independently built writing executable.
mod snapshot;
use research_agent_core::mcp::FrameDecoder;
use research_workbench_native_sdk::{
    writing_project::Input,
    writing_projects_protocol::{self as protocol, RequestBody, Response, ResponseBody},
};
use std::io::{self, Read, Write};

#[derive(Debug, thiserror::Error)]
pub(super) enum HostError {
    #[error("writing_host_input_failed: {0:?}")]
    Input(io::ErrorKind),
    #[error("writing_host_output_failed: {0:?}")]
    Output(io::ErrorKind),
    #[error("writing_host_protocol_invalid")]
    Protocol,
    #[error("writing_host_lifecycle_invalid")]
    Lifecycle,
    #[error("writing_host_identity_mismatch")]
    Identity,
    #[error("writing_host_input_closed_before_shutdown")]
    Closed,
    #[error("writing_host_snapshot_io: {0:?}")]
    SnapshotIo(io::ErrorKind),
    #[error("writing_host_snapshot_invalid")]
    SnapshotInvalid,
    #[error("writing_host_snapshot_integrity_mismatch")]
    SnapshotIntegrity,
    #[cfg(not(unix))]
    #[error("writing_host_platform_unsupported")]
    Unsupported,
}

pub(super) fn run(input: &mut impl Read, output: &mut impl Write) -> Result<(), HostError> {
    let mut decoder = FrameDecoder::with_max_frame_bytes(protocol::MAX_FRAME_BYTES);
    let mut identity: Option<(String, String)> = None;
    let mut chunk = [0_u8; 8192];
    loop {
        let count = match input.read(&mut chunk) {
            Ok(0) => return Err(HostError::Closed),
            Ok(count) => count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(HostError::Input(error.kind())),
        };
        let frames = decoder
            .push(&chunk[..count])
            .map_err(|_| HostError::Protocol)?;
        for frame in frames {
            let request = protocol::decode_request(&frame).map_err(|_| HostError::Protocol)?;
            if identity.as_ref().is_some_and(|(package, instance)| {
                *package != request.package_key || *instance != request.instance_id
            }) {
                return Err(HostError::Identity);
            }
            let shutdown = matches!(&request.body, RequestBody::Shutdown {});
            let body = match (&identity, &request.body) {
                (None, RequestBody::Initialize {}) => {
                    identity = Some((request.package_key.clone(), request.instance_id.clone()));
                    ResponseBody::Initialized {
                        capability: protocol::CAPABILITY_ID.into(),
                        version: protocol::CAPABILITY_VERSION,
                    }
                }
                (
                    Some(_),
                    RequestBody::Projects {
                        operation,
                        snapshot,
                    },
                ) => {
                    let input: Input = snapshot::read(snapshot)?;
                    if input.operation() != *operation {
                        return Err(HostError::Protocol);
                    }
                    match research_writing_projects_native::projects::decide(input) {
                        Ok(value) => ResponseBody::ProjectResult {
                            payload: snapshot::write_result(&request, &value)?,
                        },
                        Err(error) => ResponseBody::ProjectFailure {
                            failure: match &error {
                                research_writing_projects_native::projects::InputError::Json {
                                    ..
                                } => protocol::FailureKind::StoredJson,
                                _ => protocol::FailureKind::InputInvalid,
                            },
                            message: error.to_string(),
                        },
                    }
                }
                (Some(_), RequestBody::PreviewImport { source_path }) => {
                    ResponseBody::PreviewImportResult {
                        outcome: super::inspect(source_path),
                    }
                }
                (Some(_), RequestBody::Shutdown {}) => ResponseBody::ShutdownComplete {},
                _ => return Err(HostError::Lifecycle),
            };
            let response = Response::for_request(&request, body);
            let bytes = protocol::encode_response(&response).map_err(|_| HostError::Protocol)?;
            output
                .write_all(&bytes)
                .map_err(|error| HostError::Output(error.kind()))?;
            output
                .flush()
                .map_err(|error| HostError::Output(error.kind()))?;
            if shutdown {
                return Ok(());
            }
        }
    }
}
