//! Original startup metadata projection. SQL order and physical reads stay Core-owned.
use super::{InputError, ProjectError, rows};
use research_workbench_native_sdk::{
    data::DataRows,
    writing_project::{BibliographyStatus, CitationMetadataKind, Decision},
};

pub fn empty_bibliography_status() -> BibliographyStatus {
    BibliographyStatus {
        relative_path: "references.bib".to_owned(),
        content_hash: None,
        generated_at: None,
        status: "ready".to_owned(),
        warnings: Vec::new(),
    }
}

pub(super) fn decide(
    kind: CitationMetadataKind,
    manuscript_id: &str,
    manuscript: &DataRows,
    data: Option<&DataRows>,
) -> Result<Decision, InputError> {
    if rows::project(manuscript, manuscript_id)?.is_none() {
        return Ok(Decision::Rejected {
            reason: ProjectError::ManuscriptNotFound,
        });
    }
    let data = data.ok_or(InputError::MissingRelated("citation metadata"))?;
    match kind {
        CitationMetadataKind::Bindings => Ok(Decision::CitationBindings {
            items: rows::citation_bindings(data, manuscript_id)?,
        }),
        CitationMetadataKind::BibliographyStatus => Ok(Decision::BibliographyStatus {
            status: rows::bibliography_status(data)?,
        }),
    }
}
