use research_workbench_native_sdk::{
    data::{DataRows, DataValue},
    writing_project::{
        BibliographyStatus, CitationBinding, Manuscript, ManuscriptFile, RecoveryDraft,
        WritingSession,
    },
};
use serde::de::DeserializeOwned;

#[derive(Debug, thiserror::Error)]
pub enum InputError {
    #[error(
        "writing_project_input_invalid: catalog query snapshot does not match its prepared read prefix"
    )]
    CatalogQuery,
    #[error(
        "writing_project_input_invalid: Core note analysis does not match the prepared document"
    )]
    NoteAnalysis,
    #[error(
        "writing_project_input_invalid: {group} row {row} has {actual} columns; expected {expected}"
    )]
    Columns {
        group: &'static str,
        row: usize,
        actual: usize,
        expected: usize,
    },
    #[error("writing_project_input_invalid: {group} row {row} column {column} requires {expected}")]
    Cell {
        group: &'static str,
        row: usize,
        column: usize,
        expected: &'static str,
    },
    #[error("writing_project_input_invalid: {0} has multiple rows")]
    Multiplicity(&'static str),
    #[error("writing_project_input_invalid: {0} has another manuscript identity")]
    Identity(&'static str),
    #[error(
        "writing_project_input_invalid: {field} JSON {category} at line {line}, column {column}"
    )]
    Json {
        field: &'static str,
        category: String,
        line: usize,
        column: usize,
    },
    #[error(
        "writing_project_input_invalid: project-existence snapshot does not match the prepared scope"
    )]
    ProjectScope,
    #[error("writing_project_input_invalid: existing manuscript has no {0} snapshot")]
    MissingRelated(&'static str),
    #[error("writing_project_input_invalid: saved draft has another relative path")]
    DraftPath,
}

fn columns(
    row: &[DataValue],
    count: usize,
    group: &'static str,
    index: usize,
) -> Result<(), InputError> {
    if row.len() != count {
        return Err(InputError::Columns {
            group,
            row: index,
            actual: row.len(),
            expected: count,
        });
    }
    Ok(())
}

fn text(
    row: &[DataValue],
    column: usize,
    group: &'static str,
    index: usize,
) -> Result<String, InputError> {
    match &row[column] {
        DataValue::Text(value) => Ok(value.clone()),
        _ => Err(InputError::Cell {
            group,
            row: index,
            column,
            expected: "text",
        }),
    }
}

fn optional_text(
    row: &[DataValue],
    column: usize,
    group: &'static str,
    index: usize,
) -> Result<Option<String>, InputError> {
    match &row[column] {
        DataValue::Null => Ok(None),
        DataValue::Text(value) => Ok(Some(value.clone())),
        _ => Err(InputError::Cell {
            group,
            row: index,
            column,
            expected: "text or null",
        }),
    }
}

fn integer(
    row: &[DataValue],
    column: usize,
    group: &'static str,
    index: usize,
) -> Result<i64, InputError> {
    match row[column] {
        DataValue::Integer(value) => Ok(value),
        _ => Err(InputError::Cell {
            group,
            row: index,
            column,
            expected: "integer",
        }),
    }
}

fn json<T: DeserializeOwned>(value: &str, field: &'static str) -> Result<T, InputError> {
    serde_json::from_str(value).map_err(|error| InputError::Json {
        field,
        category: format!("{:?}", error.classify()),
        line: error.line(),
        column: error.column(),
    })
}

pub(super) fn projects(rows: &DataRows) -> Result<Vec<Manuscript>, InputError> {
    rows.rows
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let group = "manuscript";
            columns(row, 7, group, index)?;
            Ok(Manuscript {
                id: text(row, 0, group, index)?,
                project_id: text(row, 1, group, index)?,
                title: text(row, 2, group, index)?,
                root_path: text(row, 3, group, index)?,
                status: text(row, 4, group, index)?,
                created_at: text(row, 5, group, index)?,
                updated_at: text(row, 6, group, index)?,
            })
        })
        .collect()
}

pub(super) fn project(
    rows: &DataRows,
    manuscript_id: &str,
) -> Result<Option<Manuscript>, InputError> {
    if rows.rows.len() > 1 {
        return Err(InputError::Multiplicity("manuscript"));
    }
    let mut values = projects(rows)?;
    let value = values.pop();
    if value
        .as_ref()
        .is_some_and(|value| value.id != manuscript_id)
    {
        return Err(InputError::Identity("manuscript"));
    }
    Ok(value)
}

pub(super) fn exists(rows: &DataRows, group: &'static str) -> Result<bool, InputError> {
    if rows.rows.len() != 1 {
        return Err(InputError::ProjectScope);
    }
    columns(&rows.rows[0], 1, group, 0)?;
    Ok(integer(&rows.rows[0], 0, group, 0)? != 0)
}

pub(super) fn citation_bindings(
    rows: &DataRows,
    manuscript_id: &str,
) -> Result<Vec<CitationBinding>, InputError> {
    rows.rows
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let group = "citation binding";
            columns(row, 7, group, index)?;
            let id = text(row, 0, group, index)?;
            if id != manuscript_id {
                return Err(InputError::Identity(group));
            }
            Ok(CitationBinding {
                manuscript_id: id,
                literature_item_id: text(row, 1, group, index)?,
                citation_key: text(row, 2, group, index)?,
                bibtex_entry: text(row, 3, group, index)?,
                state: text(row, 4, group, index)?,
                pinned_at: text(row, 5, group, index)?,
                updated_at: text(row, 6, group, index)?,
            })
        })
        .collect()
}

pub(super) fn bibliography_status(rows: &DataRows) -> Result<BibliographyStatus, InputError> {
    if rows.rows.len() > 1 {
        return Err(InputError::Multiplicity("bibliography status"));
    }
    let Some(row) = rows.rows.first() else {
        return Ok(super::empty_bibliography_status());
    };
    let group = "bibliography status";
    columns(row, 4, group, 0)?;
    Ok(BibliographyStatus {
        relative_path: text(row, 0, group, 0)?,
        content_hash: optional_text(row, 1, group, 0)?,
        generated_at: optional_text(row, 2, group, 0)?,
        status: text(row, 3, group, 0)?,
        warnings: Vec::new(),
    })
}

pub(super) fn files(
    rows: &DataRows,
    manuscript_id: &str,
) -> Result<Vec<ManuscriptFile>, InputError> {
    rows.rows
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let group = "file";
            columns(row, 6, group, index)?;
            let id = text(row, 0, group, index)?;
            if id != manuscript_id {
                return Err(InputError::Identity(group));
            }
            Ok(ManuscriptFile {
                manuscript_id: id,
                relative_path: text(row, 1, group, index)?,
                kind: text(row, 2, group, index)?,
                size_bytes: integer(row, 3, group, index)?,
                sha256: text(row, 4, group, index)?,
                modified_at: text(row, 5, group, index)?,
            })
        })
        .collect()
}

pub(super) fn session(
    rows: &DataRows,
    manuscript_id: &str,
) -> Result<Option<WritingSession>, InputError> {
    if rows.rows.len() > 1 {
        return Err(InputError::Multiplicity("session"));
    }
    let Some(row) = rows.rows.first() else {
        return Ok(None);
    };
    let group = "session";
    columns(row, 6, group, 0)?;
    let id = text(row, 0, group, 0)?;
    if id != manuscript_id {
        return Err(InputError::Identity(group));
    }
    Ok(Some(WritingSession {
        manuscript_id: id,
        open_paths: json(&text(row, 1, group, 0)?, "open paths")?,
        active_path: optional_text(row, 2, group, 0)?,
        cursor_state: json(&text(row, 3, group, 0)?, "cursor state")?,
        layout_state: json(&text(row, 4, group, 0)?, "layout state")?,
        updated_at: text(row, 5, group, 0)?,
    }))
}

pub(super) fn drafts(
    rows: &DataRows,
    manuscript_id: &str,
) -> Result<Vec<RecoveryDraft>, InputError> {
    rows.rows
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let group = "draft";
            columns(row, 5, group, index)?;
            let id = text(row, 0, group, index)?;
            if id != manuscript_id {
                return Err(InputError::Identity(group));
            }
            Ok(RecoveryDraft {
                manuscript_id: id,
                relative_path: text(row, 1, group, index)?,
                base_sha256: text(row, 2, group, index)?,
                content: text(row, 3, group, index)?,
                updated_at: text(row, 4, group, index)?,
            })
        })
        .collect()
}

pub(super) fn pending_recovery(rows: &DataRows) -> Result<Option<String>, InputError> {
    if rows.rows.len() > 1 {
        return Err(InputError::Multiplicity("citation key writes"));
    }
    let Some(row) = rows.rows.first() else {
        return Ok(None);
    };
    columns(row, 1, "citation key writes", 0)?;
    text(row, 0, "citation key writes", 0).map(Some)
}

pub(super) fn directory_draft_paths(rows: &DataRows) -> Result<Vec<String>, InputError> {
    rows.rows
        .iter()
        .enumerate()
        .map(|(index, row)| {
            columns(row, 1, "directory draft path", index)?;
            text(row, 0, "directory draft path", index)
        })
        .collect()
}

pub(super) fn pending_catalog_files(
    rows: &DataRows,
) -> Result<Vec<research_workbench_native_sdk::writing_catalog::PendingFile>, InputError> {
    rows.rows
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let group = "pending writing note";
            columns(row, 3, group, index)?;
            Ok(
                research_workbench_native_sdk::writing_catalog::PendingFile {
                    manuscript_id: text(row, 0, group, index)?,
                    path: text(row, 1, group, index)?,
                    hash: text(row, 2, group, index)?,
                },
            )
        })
        .collect()
}

pub(super) fn catalog_preparation(
    rows: &DataRows,
    processed_count: usize,
) -> Result<research_workbench_native_sdk::writing_catalog::Preparation, InputError> {
    if rows.rows.len() != 1 {
        return Err(InputError::Multiplicity("writing note counts"));
    }
    columns(&rows.rows[0], 2, "writing note counts", 0)?;
    Ok(
        research_workbench_native_sdk::writing_catalog::Preparation {
            processed_count,
            pending_count: integer(&rows.rows[0], 0, "writing note counts", 0)?,
            error_count: integer(&rows.rows[0], 1, "writing note counts", 0)?,
        },
    )
}
