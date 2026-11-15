//! Original writing Agent context policy over request-bound inputs only.
use research_agent_api::submission::{ContextSourceKind, ContextText};
use research_workbench_native_sdk::{
    data::{DataRows, DataValue},
    writing_context::{
        ContextDecision, ContextInput, WritingContextError, WritingContextFile,
        WritingContextRequest,
    },
    writing_project::ManuscriptFile,
};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use uuid::Uuid;

pub const MAX_BYTES: usize = 8 * 1024 * 1024;
pub const CURRENT_FILE_SQL: &str = include_str!("../../data/project-context-current-file.v1.sql");
pub const CATALOG_SQL: &str = include_str!("../../data/project-context-catalog.v1.sql");
pub const TEXT_PATHS_SQL: &str = include_str!("../../data/project-context-text-paths.v1.sql");

pub fn current_file(
    manuscript_id: Uuid,
    relative_path: &str,
    rows: &DataRows,
) -> Result<WritingContextRequest, WritingContextError> {
    let Some(row) = rows.rows.first() else {
        return Err(WritingContextError::Unavailable);
    };
    let [DataValue::Text(hash)] = row.as_slice() else {
        return Err(WritingContextError::Unavailable);
    };
    Ok(WritingContextRequest {
        manuscript_id,
        files: vec![WritingContextFile {
            relative_path: relative_path.into(),
            expected_disk_sha256: hash.clone(),
            buffer: None,
            selection: None,
        }],
    })
}

pub fn require_active(status: &str) -> Result<(), WritingContextError> {
    if status != "active" {
        return Err(WritingContextError::Unavailable);
    }
    Ok(())
}

pub fn require_registered(
    relative_path: &str,
    registered: &[ManuscriptFile],
) -> Result<(), WritingContextError> {
    if !registered
        .iter()
        .any(|file| file.relative_path == relative_path && file.kind != "image")
    {
        return Err(WritingContextError::Unavailable);
    }
    Ok(())
}

/// The original Core text read precedes this stage. Its disk hash remains the
/// permission basis even when a live buffer supplies the selected text.
pub fn materialize_file(
    manuscript_id: Uuid,
    file: WritingContextFile,
    disk: String,
    disk_hash: String,
    used_bytes: usize,
) -> Result<(ContextText, usize), WritingContextError> {
    if !disk_hash.eq_ignore_ascii_case(&file.expected_disk_sha256) {
        return Err(WritingContextError::Conflict);
    }
    let materialized_bytes = disk
        .len()
        .max(file.buffer.as_ref().map_or(0, |buffer| buffer.text.len()));
    let buffer_revision = file.buffer.as_ref().map(|buffer| buffer.revision);
    let full_text = file.buffer.map(|buffer| buffer.text).unwrap_or(disk);
    let revision = format!("sha256:{:x}", Sha256::digest(full_text.as_bytes()));
    let (start, end) = if let Some(selection) = &file.selection {
        if selection.start_utf16 >= selection.end_utf16 {
            return Err(WritingContextError::InvalidInput);
        }
        (
            utf16_byte_offset(&full_text, selection.start_utf16)?,
            utf16_byte_offset(&full_text, selection.end_utf16)?,
        )
    } else {
        (0, full_text.len())
    };
    let text = full_text[start..end].to_owned();
    let bytes = used_bytes
        .checked_add(materialized_bytes)
        .ok_or(WritingContextError::Budget)?;
    if bytes > MAX_BYTES {
        return Err(WritingContextError::Budget);
    }
    let id = manuscript_id.to_string();
    let source_id = format!(
        "writing:{:x}",
        Sha256::digest(format!("{id}/{}", file.relative_path).as_bytes())
    );
    let anchor = serde_json::json!({"manuscriptId":id,"diskSha256":disk_hash,"bufferRevision":buffer_revision,
        "startUtf16":file.selection.as_ref().map(|s|s.start_utf16),"endUtf16":file.selection.as_ref().map(|s|s.end_utf16)}).to_string();
    Ok((
        ContextText {
            source_id,
            kind: ContextSourceKind::Manuscript,
            resource_id: file.relative_path,
            revision,
            anchor: Some(anchor),
            text,
        },
        bytes,
    ))
}

pub fn decide(input: &ContextInput) -> ContextDecision {
    let result = match input {
        ContextInput::Validate { request } => {
            validate(request).map(|()| ContextDecision::Validated {})
        }
        ContextInput::CurrentFile {
            manuscript_id,
            relative_path,
            rows,
        } => current_file(*manuscript_id, relative_path, rows)
            .map(|request| ContextDecision::CurrentFile { request }),
        ContextInput::Project {
            manuscript_id,
            rows,
        } => super::rows::project(rows, &manuscript_id.to_string())
            .map_err(|_| WritingContextError::Unavailable)
            .and_then(|project| project.ok_or(WritingContextError::Unavailable))
            .and_then(|project| require_active(&project.status))
            .map(|()| ContextDecision::ProjectAccepted {}),
        ContextInput::Registered {
            relative_path,
            files,
        } => require_registered(relative_path, files).map(|()| ContextDecision::Registered {}),
        ContextInput::Materialize {
            manuscript_id,
            file,
            disk,
            disk_hash,
            used_bytes,
        } => materialize_file(
            *manuscript_id,
            file.clone(),
            disk.clone(),
            disk_hash.clone(),
            *used_bytes,
        )
        .map(|(source, used_bytes)| ContextDecision::Materialized { source, used_bytes }),
    };
    result.unwrap_or_else(|reason| ContextDecision::Rejected { reason })
}

pub fn validate(request: &WritingContextRequest) -> Result<(), WritingContextError> {
    if request.files.is_empty() || request.files.len() > 256 {
        return Err(WritingContextError::InvalidInput);
    }
    let mut paths = HashSet::new();
    let mut bytes = 0usize;
    for file in &request.files {
        research_workbench_native_sdk::resource_path::validate_relative_path(&file.relative_path)
            .map_err(|_| WritingContextError::InvalidInput)?;
        if !paths.insert(&file.relative_path)
            || file.expected_disk_sha256.len() != 64
            || !file
                .expected_disk_sha256
                .bytes()
                .all(|c| c.is_ascii_hexdigit())
        {
            return Err(WritingContextError::InvalidInput);
        }
        if let Some(buffer) = &file.buffer {
            bytes = bytes
                .checked_add(buffer.text.len())
                .ok_or(WritingContextError::Budget)?;
        }
        if bytes > MAX_BYTES {
            return Err(WritingContextError::Budget);
        }
    }
    Ok(())
}
fn utf16_byte_offset(text: &str, target: usize) -> Result<usize, WritingContextError> {
    let mut offset = 0;
    for (byte, ch) in text.char_indices() {
        if offset == target {
            return Ok(byte);
        }
        offset += ch.len_utf16();
        if offset > target {
            return Err(WritingContextError::InvalidInput);
        }
    }
    if offset == target {
        Ok(text.len())
    } else {
        Err(WritingContextError::InvalidInput)
    }
}

#[cfg(test)]
mod tests;
