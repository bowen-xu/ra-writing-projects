//! Private file policy stays in this host; the original stream codec is shared.
use super::HostError;
use research_workbench_native_sdk::{
    native_snapshot::SnapshotRef,
    streaming_payload::{self, PayloadError},
    writing_projects_protocol::{self as protocol, Request},
};

#[cfg(unix)]
pub(super) fn read<T: serde::de::DeserializeOwned>(
    reference: &SnapshotRef,
) -> Result<T, HostError> {
    use std::{fs::OpenOptions, os::unix::fs::OpenOptionsExt};
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&reference.relative_handle)
        .map_err(|error| HostError::SnapshotIo(error.kind()))?;
    let metadata = file
        .metadata()
        .map_err(|error| HostError::SnapshotIo(error.kind()))?;
    if !metadata.is_file() || metadata.len() != reference.byte_size {
        return Err(HostError::SnapshotIntegrity);
    }
    streaming_payload::read_json(file, reference.byte_size, &reference.sha256).map_err(|error| {
        match error {
            PayloadError::Integrity => HostError::SnapshotIntegrity,
            _ => HostError::SnapshotInvalid,
        }
    })
}

#[cfg(unix)]
pub(super) fn write_result(
    request: &Request,
    value: &impl serde::Serialize,
) -> Result<SnapshotRef, HostError> {
    use std::{
        fs,
        os::unix::fs::{OpenOptionsExt, PermissionsExt},
    };
    let failure = |error: std::io::Error| HostError::SnapshotIo(error.kind());
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(protocol::result_handle(&request.request_id))
        .map_err(failure)?;
    let (file, digest) =
        streaming_payload::write_json(file, value).map_err(|error| match error {
            PayloadError::Io(kind) => HostError::SnapshotIo(kind),
            _ => HostError::SnapshotInvalid,
        })?;
    file.sync_all().map_err(failure)?;
    file.set_permissions(fs::Permissions::from_mode(0o400))
        .map_err(failure)?;
    Ok(protocol::result_reference(
        request,
        digest.byte_size,
        digest.sha256,
    ))
}

#[cfg(not(unix))]
pub(super) fn read<T: serde::de::DeserializeOwned>(
    _reference: &SnapshotRef,
) -> Result<T, HostError> {
    Err(HostError::Unsupported)
}
#[cfg(not(unix))]
pub(super) fn write_result(
    _request: &Request,
    _value: &impl serde::Serialize,
) -> Result<SnapshotRef, HostError> {
    Err(HostError::Unsupported)
}
