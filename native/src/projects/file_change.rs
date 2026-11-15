use super::{InputError, ProjectError, rows};
use research_workbench_native_sdk::{
    data::DataRows,
    writing_file::{FileChangeAction, FileChangePlan, FileChangeRequest},
    writing_project::Decision,
};

pub const UNINDEXED_FILE: ProjectError = ProjectError::FileNotFound;

pub fn require_file_index_rows(changed: u64) -> Result<(), ProjectError> {
    if changed == 0 {
        return Err(UNINDEXED_FILE);
    }
    Ok(())
}

pub fn touch_renamed_file(path: &str) -> bool {
    path.to_lowercase().ends_with(".ranote")
}

pub(super) fn prepare(request: &FileChangeRequest) -> Result<(), ProjectError> {
    match request {
        FileChangeRequest::Rename {
            from_path, to_path, ..
        } => {
            super::require_editable_path(from_path)?;
            super::require_editable_path(to_path)?;
        }
        FileChangeRequest::Delete { relative_path, .. } => {
            super::require_editable_path(relative_path)?
        }
    }
    Ok(())
}

pub(super) fn plan(
    request: &FileChangeRequest,
    manuscript: &DataRows,
) -> Result<Decision, InputError> {
    if let Err(reason) = prepare(request) {
        return Ok(Decision::Rejected { reason });
    }
    let Some(manuscript) = rows::project(manuscript, request.manuscript_id().trim())? else {
        return Ok(Decision::Rejected {
            reason: ProjectError::ManuscriptNotFound,
        });
    };
    let action = match request {
        FileChangeRequest::Rename {
            from_path, to_path, ..
        } => FileChangeAction::Rename {
            touch_destination: touch_renamed_file(to_path.trim()),
            on_unindexed: UNINDEXED_FILE,
            root_metadata: (manuscript.root_path == from_path.trim())
                .then(|| super::decisions::metadata(&manuscript.title, to_path)),
        },
        FileChangeRequest::Delete { relative_path, .. } => {
            if manuscript.root_path == relative_path.trim()
                || relative_path.trim() == "references.bib"
            {
                return Ok(Decision::Rejected {
                    reason: ProjectError::InvalidPath,
                });
            }
            FileChangeAction::Delete
        }
    };
    Ok(Decision::FileChange {
        plan: Box::new(FileChangePlan {
            request: request.clone(),
            manuscript,
            action,
        }),
    })
}
