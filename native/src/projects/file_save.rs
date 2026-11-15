use super::{InputError, ProjectError, rows};
use research_workbench_native_sdk::{
    data::DataRows,
    note_document::NoteDocumentAnalysis,
    writing_file::{
        FileSavePlan, FileSavePreparation, WritingNoteCatalogProjection, WritingNotePreparation,
    },
    writing_project::{Decision, SaveFileRequest},
};

pub const DUPLICATE_NOTE_IDENTITY: &str =
    "writing_note_identity_duplicate：同一写作项目中存在重复的笔记标识，请核对文件。";

pub(super) fn prepare(
    request: &SaveFileRequest,
    note_title: &str,
) -> Result<FileSavePreparation, ProjectError> {
    super::require_editable_path(&request.relative_path)?;
    let path = request.relative_path.trim();
    let note = prepare_catalog_note(path, note_title, &request.content);
    Ok(FileSavePreparation {
        request: request.clone(),
        file_kind: super::file_kind(path).into(),
        note,
    })
}

pub(super) fn prepare_catalog_note(
    path: &str,
    note_title: &str,
    content: &str,
) -> WritingNotePreparation {
    if !path.to_ascii_lowercase().ends_with(".ranote") {
        WritingNotePreparation::Ignored
    } else if note_title.is_empty() {
        WritingNotePreparation::Invalid {
            cause: "writing_note_title_invalid：写作笔记文件名为空。".into(),
        }
    } else {
        match super::prepare_note(content) {
            Ok(note) => WritingNotePreparation::Document { note },
            Err(cause) => WritingNotePreparation::Invalid { cause },
        }
    }
}

pub(super) fn finish(
    preparation: &FileSavePreparation,
    manuscript: &DataRows,
    analysis: Option<&NoteDocumentAnalysis>,
) -> Result<Decision, InputError> {
    if rows::project(manuscript, preparation.request.manuscript_id.trim())?.is_none() {
        return Ok(Decision::Rejected {
            reason: ProjectError::ManuscriptNotFound,
        });
    }
    let catalog = project_catalog_note(&preparation.note, analysis)?;
    Ok(Decision::FileSave {
        plan: Box::new(FileSavePlan {
            preparation: preparation.clone(),
            catalog,
            duplicate_identity_cause: DUPLICATE_NOTE_IDENTITY.into(),
        }),
    })
}

pub(super) fn project_catalog_note(
    note: &WritingNotePreparation,
    analysis: Option<&NoteDocumentAnalysis>,
) -> Result<WritingNoteCatalogProjection, InputError> {
    Ok(match (note, analysis) {
        (WritingNotePreparation::Ignored, None) => WritingNoteCatalogProjection::Ignored,
        (WritingNotePreparation::Invalid { cause }, None) => {
            WritingNoteCatalogProjection::Invalid {
                cause: cause.clone(),
            }
        }
        (WritingNotePreparation::Document { note }, Some(analysis))
            if note.document == analysis.document =>
        {
            match super::finish_note(note, analysis) {
                Ok(projection) => projection,
                Err(cause) => WritingNoteCatalogProjection::Invalid { cause },
            }
        }
        _ => return Err(InputError::NoteAnalysis),
    })
}
