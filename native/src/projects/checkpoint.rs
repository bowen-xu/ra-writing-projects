//! Original writing checkpoint decisions. Core retains storage and HBS execution.
mod rows;
use super::{InputError, ProjectError};
use research_workbench_native_sdk::writing_checkpoint::{
    CheckpointDecision, CheckpointInput, CheckpointPlan, CheckpointRecord, CheckpointWrite,
    DocumentCheckpoint,
};
pub use rows::{CheckpointReadError, decode};
use sha2::{Digest, Sha256};

pub const READ_SQL: &str = include_str!("../../data/project-checkpoint-read.v1.sql");
pub const PATHS_SQL: &str = include_str!("../../data/project-checkpoint-paths.v1.sql");
pub const UPSERT_SQL: &str = include_str!("../../data/project-checkpoint-upsert.v1.sql");

pub const MAX_VERSION: u64 = 9_007_199_254_740_991;

fn valid_identity(value: &str) -> bool {
    !value.is_empty() && value.chars().count() <= 128 && !value.chars().any(|c| c <= '\u{1f}')
}
fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
pub fn validate(checkpoint: &DocumentCheckpoint) -> Result<(), ProjectError> {
    research_workbench_native_sdk::resource_path::validate_relative_path(&checkpoint.relative_path)
        .map_err(|_| ProjectError::InvalidPath)?;
    // Preserve the stricter persisted identity spelling after path validation.
    if checkpoint
        .relative_path
        .split('/')
        .any(|s| s.is_empty() || s == "." || s == "..")
        || checkpoint.relative_path.as_bytes().get(1) == Some(&b':')
        || !valid_identity(&checkpoint.manuscript_id)
        || checkpoint.schema_version != 1
        || checkpoint.version > MAX_VERSION
        || checkpoint.saved_version > checkpoint.version
        || !valid_hash(&checkpoint.saved_sha256)
    {
        return Err(ProjectError::InvalidCheckpoint);
    }
    if checkpoint.content.len() > 8 * 1024 * 1024
        || checkpoint.review_baseline.len() > 8 * 1024 * 1024
    {
        return Err(ProjectError::FileTooLarge);
    }
    let mut operations = std::collections::HashSet::new();
    for operation in &checkpoint.operations {
        if !valid_identity(&operation.operation_id)
            || !valid_identity(&operation.conversation_id)
            || !valid_identity(&operation.request_id)
            || !valid_hash(&operation.result_sha256)
            || !operations.insert(&operation.operation_id)
        {
            return Err(ProjectError::InvalidCheckpoint);
        }
    }
    if let Some(receipt) = &checkpoint.editor_receipt {
        if receipt.text.len() > 8 * 1024 * 1024 {
            return Err(ProjectError::FileTooLarge);
        }
        if receipt
            .state_version
            .is_some_and(|version| version > checkpoint.version)
            || !valid_identity(&receipt.session_id)
            || !valid_identity(&receipt.revision)
            || !checkpoint.operations.iter().any(|operation| {
                operation.operation_id == receipt.operation_id
                    && operation.result_sha256
                        == format!("{:x}", Sha256::digest(receipt.text.as_bytes()))
            })
        {
            return Err(ProjectError::InvalidCheckpoint);
        }
    }
    if let Some(intent) = &checkpoint.save_intent
        && (!valid_identity(&intent.operation_id)
            || intent.version > checkpoint.version
            || intent.version < checkpoint.saved_version
            || !valid_hash(&intent.expected_sha256)
            || !valid_hash(&intent.target_sha256))
    {
        return Err(ProjectError::InvalidCheckpoint);
    }
    Ok(())
}
pub fn validate_write(write: &CheckpointWrite) -> Result<(), ProjectError> {
    validate(&write.checkpoint)?;
    if write
        .expected_revision
        .is_some_and(|revision| revision == 0 || revision > MAX_VERSION)
    {
        return Err(ProjectError::InvalidCheckpoint);
    }
    Ok(())
}
fn receipt_advances(current: &DocumentCheckpoint, next: &DocumentCheckpoint) -> bool {
    current.editor_receipt.is_none()
        || current.editor_receipt == next.editor_receipt
        || next.editor_receipt.as_ref().is_some_and(|receipt| {
            next.operations
                .iter()
                .skip(current.operations.len())
                .any(|operation| operation.operation_id == receipt.operation_id)
        })
}
pub fn plan(
    write: &CheckpointWrite,
    current: Option<&CheckpointRecord>,
) -> Result<CheckpointPlan, ProjectError> {
    validate_write(write)?;
    let next = &write.checkpoint;
    if let Some(current) = current {
        validate(&current.checkpoint)?;
        if current.checkpoint.manuscript_id != next.manuscript_id
            || current.checkpoint.relative_path != next.relative_path
        {
            return Err(ProjectError::InvalidCheckpoint);
        }
        // Original idempotence precedes the expected-revision comparison.
        if current.checkpoint == *next {
            return Ok(CheckpointPlan {
                write: write.clone(),
                record: current.clone(),
                write_required: false,
            });
        }
        if next.version < current.checkpoint.version
            || next.saved_version < current.checkpoint.saved_version
            || !next.operations.starts_with(&current.checkpoint.operations)
            || !receipt_advances(&current.checkpoint, next)
            || (next.version == current.checkpoint.version
                && (next.content != current.checkpoint.content
                    || next.review_baseline != current.checkpoint.review_baseline))
        {
            return Err(ProjectError::CheckpointConflict);
        }
    }
    if current.map(|record| record.revision) != write.expected_revision {
        return Err(ProjectError::CheckpointConflict);
    }
    let revision = match current {
        Some(record) => record
            .revision
            .checked_add(1)
            .ok_or(ProjectError::CheckpointConflict)?,
        None => 1,
    };
    if revision > MAX_VERSION {
        return Err(ProjectError::CheckpointConflict);
    }
    Ok(CheckpointPlan {
        write: write.clone(),
        record: CheckpointRecord {
            revision,
            checkpoint: next.clone(),
        },
        write_required: true,
    })
}
pub(super) fn decide(input: &CheckpointInput) -> Result<CheckpointDecision, InputError> {
    Ok(match input {
        CheckpointInput::Validate { write } => match validate_write(write) {
            Ok(()) => CheckpointDecision::Validated {
                write: write.clone(),
            },
            Err(reason) => CheckpointDecision::Rejected { reason },
        },
        CheckpointInput::Read {
            manuscript_id,
            relative_path,
            required,
            rows,
        } => rows::decide(manuscript_id, relative_path, *required, rows)?,
        CheckpointInput::Save { write, current } => match plan(write, current.as_deref()) {
            Ok(plan) => CheckpointDecision::Save {
                plan: Box::new(plan),
            },
            Err(reason) => CheckpointDecision::Rejected { reason },
        },
    })
}

#[cfg(test)]
mod tests;
