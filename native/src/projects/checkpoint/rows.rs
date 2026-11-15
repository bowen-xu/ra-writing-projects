use super::*;
use research_workbench_native_sdk::data::{DataRows, DataValue};

#[derive(Debug, thiserror::Error)]
pub enum CheckpointReadError {
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Rejected(#[from] ProjectError),
}
pub fn decode(
    manuscript_id: &str,
    relative_path: &str,
    revision: u64,
    payload: &str,
) -> Result<CheckpointRecord, CheckpointReadError> {
    let checkpoint: DocumentCheckpoint = serde_json::from_str(payload)?;
    validate(&checkpoint)?;
    if checkpoint.manuscript_id != manuscript_id || checkpoint.relative_path != relative_path {
        return Err(ProjectError::InvalidCheckpoint.into());
    }
    Ok(CheckpointRecord {
        revision,
        checkpoint,
    })
}
pub(super) fn decide(
    manuscript_id: &str,
    relative_path: &str,
    required: bool,
    rows: &DataRows,
) -> Result<CheckpointDecision, InputError> {
    if rows.rows.len() > 1 {
        return Err(InputError::Multiplicity("writing checkpoint"));
    }
    let Some(row) = rows.rows.first() else {
        return Ok(if required {
            CheckpointDecision::Rejected {
                reason: ProjectError::CheckpointConflict,
            }
        } else {
            CheckpointDecision::Read { record: None }
        });
    };
    if row.len() != 2 {
        return Err(InputError::Columns {
            group: "writing checkpoint",
            row: 0,
            actual: row.len(),
            expected: 2,
        });
    }
    let revision = match &row[0] {
        DataValue::Integer(value) if *value >= 0 => *value as u64,
        _ => {
            return Err(InputError::Cell {
                group: "writing checkpoint",
                row: 0,
                column: 0,
                expected: "non-negative integer",
            });
        }
    };
    let DataValue::Text(payload) = &row[1] else {
        return Err(InputError::Cell {
            group: "writing checkpoint",
            row: 0,
            column: 1,
            expected: "text",
        });
    };
    match decode(manuscript_id, relative_path, revision, payload) {
        Ok(record) => Ok(CheckpointDecision::Read {
            record: Some(Box::new(record)),
        }),
        Err(CheckpointReadError::Rejected(reason)) => Ok(CheckpointDecision::Rejected { reason }),
        Err(CheckpointReadError::Json(error)) => Err(InputError::Json {
            field: "writing checkpoint",
            category: format!("{:?}", error.classify()),
            line: error.line(),
            column: error.column(),
        }),
    }
}
