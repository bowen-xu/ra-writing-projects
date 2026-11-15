//! Original directory policy; SQL, source paths and clocks retain Core owners.
use super::{InputError, ProjectError, rows};
use research_workbench_native_sdk::{
    data::DataRows,
    writing_directory::{
        DirectoryDecision, DirectoryInput, DirectoryPathChange, DirectoryPlan, DirectoryRejection,
        DirectoryRequest, DirectoryStage,
    },
    writing_project::{Manuscript, MetadataDecision, WritingSessionDraft},
};

fn domain<T>(result: Result<T, ProjectError>) -> DirectoryStage<T> {
    match result {
        Ok(value) => DirectoryStage::Ready { value },
        Err(reason) => DirectoryStage::Rejected {
            reason: DirectoryRejection::Domain { reason },
        },
    }
}
fn observed<T>(
    value: Option<&DataRows>,
    decode: impl FnOnce(&DataRows) -> Result<T, InputError>,
) -> DirectoryStage<T> {
    let Some(value) = value else {
        return DirectoryStage::Unavailable;
    };
    match decode(value) {
        Ok(value) => DirectoryStage::Ready { value },
        Err(error) => DirectoryStage::Rejected {
            reason: match error {
                InputError::Json { .. } => DirectoryRejection::StoredJson {
                    message: error.to_string(),
                },
                _ => DirectoryRejection::InputInvalid {
                    message: error.to_string(),
                },
            },
        },
    }
}
fn manuscript(request: &DirectoryRequest, value: Option<&DataRows>) -> DirectoryStage<Manuscript> {
    match observed(value, |rows| {
        rows::project(rows, request.manuscript_id().trim())
    }) {
        DirectoryStage::Ready { value: None } => domain(Err(ProjectError::ManuscriptNotFound)),
        DirectoryStage::Ready { value: Some(value) } => {
            if matches!(request, DirectoryRequest::Delete { .. })
                && path_is_within(&value.root_path, request.source())
            {
                return domain(Err(ProjectError::InvalidPath));
            }
            DirectoryStage::Ready { value }
        }
        DirectoryStage::Rejected { reason } => DirectoryStage::Rejected { reason },
        DirectoryStage::Unavailable => DirectoryStage::Unavailable,
    }
}
fn unit<T>(stage: DirectoryStage<T>) -> DirectoryStage<()> {
    match stage {
        DirectoryStage::Ready { .. } => DirectoryStage::Ready { value: () },
        DirectoryStage::Rejected { reason } => DirectoryStage::Rejected { reason },
        DirectoryStage::Unavailable => DirectoryStage::Unavailable,
    }
}
fn preflight(
    request: &DirectoryRequest,
    manuscript_rows: Option<&DataRows>,
    files: Option<&DataRows>,
) -> DirectoryDecision {
    let manuscript = match request {
        DirectoryRequest::Rename { .. } => DirectoryStage::Ready { value: () },
        DirectoryRequest::Delete { .. } => unit(manuscript(request, manuscript_rows)),
    };
    let files = match observed(files, |rows| {
        rows::files(rows, request.manuscript_id().trim())
    }) {
        DirectoryStage::Ready { value } => domain(
            value
                .iter()
                .filter(|file| path_is_within(&file.relative_path, request.source()))
                .try_for_each(|file| super::require_editable_path(&file.relative_path)),
        ),
        DirectoryStage::Rejected { reason } => DirectoryStage::Rejected { reason },
        DirectoryStage::Unavailable => DirectoryStage::Unavailable,
    };
    DirectoryDecision::Preflight { manuscript, files }
}
fn changes(
    request: &DirectoryRequest,
    paths: Vec<String>,
    drafts: bool,
) -> Vec<DirectoryPathChange> {
    paths
        .into_iter()
        .filter(|path| path_is_within(path, request.source()))
        .map(|path| {
            let (target, rejection) = match request {
                DirectoryRequest::Rename {
                    from_path, to_path, ..
                } => (Some(relocate(&path, from_path, to_path)), None),
                DirectoryRequest::Delete { .. } => (
                    None,
                    if drafts {
                        super::validate_recovery_path(&path).err()
                    } else {
                        None
                    },
                ),
            };
            DirectoryPathChange {
                path,
                target,
                rejection,
            }
        })
        .collect()
}
fn session(
    request: &DirectoryRequest,
    input: Option<&DataRows>,
) -> DirectoryStage<Option<WritingSessionDraft>> {
    let stage = observed(input, |rows| {
        rows::session(rows, request.manuscript_id().trim())
    });
    let session = match stage {
        DirectoryStage::Ready { value: None } => return DirectoryStage::Ready { value: None },
        DirectoryStage::Ready { value: Some(value) } => value,
        DirectoryStage::Rejected { reason } => return DirectoryStage::Rejected { reason },
        DirectoryStage::Unavailable => return DirectoryStage::Unavailable,
    };
    let mut draft = WritingSessionDraft {
        manuscript_id: request.manuscript_id().trim().into(),
        open_paths: session.open_paths,
        active_path: session.active_path,
        cursor_state: session.cursor_state,
        layout_state: session.layout_state,
    };
    match request {
        DirectoryRequest::Rename {
            from_path, to_path, ..
        } => {
            draft.open_paths = draft
                .open_paths
                .into_iter()
                .map(|path| relocate(&path, from_path, to_path))
                .collect();
            draft.active_path = draft
                .active_path
                .map(|path| relocate(&path, from_path, to_path));
            draft.cursor_state = relocate_json_keys(draft.cursor_state, from_path, to_path);
        }
        DirectoryRequest::Delete { relative_path, .. } => {
            draft
                .open_paths
                .retain(|path| !path_is_within(path, relative_path));
            if draft
                .active_path
                .as_deref()
                .is_some_and(|path| path_is_within(path, relative_path))
            {
                draft.active_path = None;
            }
            draft.cursor_state = remove_json_keys(draft.cursor_state, relative_path);
        }
    }
    domain(super::validate_session(&draft).map(|()| Some(draft)))
}

pub(super) fn decide(input: &DirectoryInput) -> DirectoryDecision {
    let (request, manuscript_rows, files, drafts, session_rows) = match input {
        DirectoryInput::Preflight {
            request,
            manuscript,
            files,
        } => return preflight(request, manuscript.as_ref(), files.as_ref()),
        DirectoryInput::Relations {
            request,
            manuscript,
            files,
            drafts,
            session,
        } => (request, manuscript, files, drafts, session),
    };
    let paths = super::validate_recovery_path(request.source()).and_then(|()| match request {
        DirectoryRequest::Rename { to_path, .. } => super::validate_recovery_path(to_path),
        DirectoryRequest::Delete { .. } => Ok(()),
    });
    let manuscript = manuscript(request, manuscript_rows.as_ref());
    let metadata = match request {
        DirectoryRequest::Delete { .. } => DirectoryStage::Ready { value: None },
        DirectoryRequest::Rename {
            from_path, to_path, ..
        } => match &manuscript {
            DirectoryStage::Ready { value } => match super::decisions::metadata(
                &value.title,
                &relocate(&value.root_path, from_path, to_path),
            ) {
                MetadataDecision::Ready { metadata } => DirectoryStage::Ready {
                    value: Some(metadata),
                },
                MetadataDecision::Rejected { reason } => domain(Err(reason)),
            },
            _ => DirectoryStage::Unavailable,
        },
    };
    let files = match observed(files.as_ref(), |rows| {
        rows::files(rows, request.manuscript_id().trim())
    }) {
        DirectoryStage::Ready { value } => DirectoryStage::Ready {
            value: changes(
                request,
                value.into_iter().map(|file| file.relative_path).collect(),
                false,
            ),
        },
        DirectoryStage::Rejected { reason } => DirectoryStage::Rejected { reason },
        DirectoryStage::Unavailable => DirectoryStage::Unavailable,
    };
    let drafts = match observed(drafts.as_ref(), rows::directory_draft_paths) {
        DirectoryStage::Ready { value } => DirectoryStage::Ready {
            value: changes(request, value, true),
        },
        DirectoryStage::Rejected { reason } => DirectoryStage::Rejected { reason },
        DirectoryStage::Unavailable => DirectoryStage::Unavailable,
    };
    DirectoryDecision::Relations {
        plan: Box::new(DirectoryPlan {
            paths: domain(paths),
            manuscript,
            files,
            drafts,
            session: session(request, session_rows.as_ref()),
            metadata,
            on_unindexed_file: super::file_change::UNINDEXED_FILE,
        }),
    }
}
pub fn relocate(path: &str, from_path: &str, to_path: &str) -> String {
    if path == from_path {
        return to_path.to_owned();
    }
    path.strip_prefix(&format!("{from_path}/"))
        .map_or_else(|| path.to_owned(), |suffix| format!("{to_path}/{suffix}"))
}

pub fn path_is_within(path: &str, directory: &str) -> bool {
    path == directory || path.starts_with(&format!("{directory}/"))
}

pub fn relocate_json_keys(
    value: serde_json::Value,
    from_path: &str,
    to_path: &str,
) -> serde_json::Value {
    let serde_json::Value::Object(entries) = value else {
        return serde_json::Value::Object(Default::default());
    };
    serde_json::Value::Object(
        entries
            .into_iter()
            .map(|(key, value)| (relocate(&key, from_path, to_path), value))
            .collect(),
    )
}

pub fn remove_json_keys(value: serde_json::Value, relative_path: &str) -> serde_json::Value {
    let serde_json::Value::Object(entries) = value else {
        return serde_json::Value::Object(Default::default());
    };
    serde_json::Value::Object(
        entries
            .into_iter()
            .filter(|(key, _)| !path_is_within(key, relative_path))
            .collect(),
    )
}
