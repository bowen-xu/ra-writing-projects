//! Original project and document decisions, without a database or file owner.
use research_workbench_native_sdk::{
    resource_path::validate_relative_path,
    writing_project::{RecoveryDraftInput, WritingSessionDraft},
};

pub use research_workbench_native_sdk::writing_project::Rejection as ProjectError;
mod catalog_prepare;
mod citation_metadata;
pub use citation_metadata::empty_bibliography_status;
pub mod catalog_query;
pub mod checkpoint;
pub mod context;
mod decisions;
pub use catalog_prepare::catalog_statuses;
mod directories;
pub use directories::{path_is_within, relocate, relocate_json_keys, remove_json_keys};
mod file_change;
mod file_save;
pub use file_change::{require_file_index_rows, touch_renamed_file};
mod note;
mod rows;
pub use decisions::decide;
pub use file_save::DUPLICATE_NOTE_IDENTITY;
pub use note::{finish_note, prepare_note};
pub use rows::InputError;

pub const MAX_RECOVERY_DRAFTS_PER_MANUSCRIPT: usize = 32;
pub const MAX_RECOVERY_DRAFTS_TOTAL: usize = 128;

/// Original host inventory projection after the existing file-row decoder.
pub fn host_resource_files(
    files: Vec<research_workbench_native_sdk::writing_project::ManuscriptFile>,
) -> Vec<research_workbench_native_sdk::writing_project::HostResourceFile> {
    files
        .into_iter()
        .map(
            |file| research_workbench_native_sdk::writing_project::HostResourceFile {
                relative_path: file.relative_path,
                kind: file.kind,
                sha256: file.sha256,
            },
        )
        .collect()
}

/// Decode the original persisted redo array before any file is touched.
pub fn citation_key_writes(
    payload: &str,
) -> Result<Vec<research_workbench_native_sdk::writing_project::CitationKeyWrite>, serde_json::Error>
{
    serde_json::from_str(payload)
}

pub fn validate_recovery_path(path: &str) -> Result<(), ProjectError> {
    validate_relative_path(path).map_err(|_| ProjectError::InvalidPath)?;
    Ok(())
}

pub fn require_changed_manuscript(affected_rows: u64) -> Result<(), ProjectError> {
    if affected_rows == 0 {
        return Err(ProjectError::ManuscriptNotFound);
    }
    Ok(())
}

pub const FILE_KIND_POLICY_JSON: &str = include_str!("../data/project-file-kinds.v1.json");
static FILE_KIND_POLICY: std::sync::LazyLock<
    research_workbench_native_sdk::writing_file::FileKindPolicyV1,
> = std::sync::LazyLock::new(|| {
    // This package-owned constant is checked by the original classification
    // regressions and the independent package build.
    serde_json::from_str(FILE_KIND_POLICY_JSON).expect("valid bundled file-kind policy")
});

pub fn file_kind(relative_path: &str) -> &'static str {
    FILE_KIND_POLICY.kind(relative_path)
}

pub fn is_text_path(relative_path: &str) -> bool {
    FILE_KIND_POLICY.is_text_path(relative_path)
}

/// The original extension check follows Core's physical UTF-8 file read.
/// Core owns filesystem and path-scope authorization.
pub fn require_tex_root(relative_path: &str) -> Result<(), ProjectError> {
    if file_kind(relative_path) != "tex" {
        return Err(ProjectError::InvalidPath);
    }
    Ok(())
}

/// Original new-manuscript bytes; file creation remains Core-owned.
pub fn initial_template(title: &str) -> String {
    let escaped_title = title.replace(['{', '}'], "");
    format!(
        "\\documentclass{{article}}\n\\usepackage[utf8]{{inputenc}}\n\\title{{{escaped_title}}}\n\\begin{{document}}\n\\maketitle\n\n\\bibliographystyle{{plain}}\n\\bibliography{{references}}\n\\end{{document}}\n"
    )
}

/// The original repository resolves the project first and passes its trimmed
/// title. Root-path spelling and the title-before-path rejection order remain.
pub fn validate_metadata(title: &str, root_path: &str) -> Result<(), ProjectError> {
    if title.is_empty() || title.chars().count() > 180 {
        return Err(ProjectError::InvalidManuscript);
    }
    validate_relative_path(root_path).map_err(|_| ProjectError::InvalidPath)?;
    Ok(())
}

pub fn validate_session(draft: &WritingSessionDraft) -> Result<(), ProjectError> {
    for path in &draft.open_paths {
        validate_relative_path(path).map_err(|_| ProjectError::InvalidPath)?;
    }
    if let Some(path) = &draft.active_path {
        validate_relative_path(path).map_err(|_| ProjectError::InvalidPath)?;
    }
    Ok(())
}

pub fn validate_recovery_draft(draft: &RecoveryDraftInput) -> Result<(), ProjectError> {
    validate_recovery_path(&draft.relative_path)?;
    if draft.base_sha256.len() != 64 || draft.content.len() > 8 * 1024 * 1024 {
        return Err(ProjectError::InvalidManuscript);
    }
    Ok(())
}

pub fn is_managed_bibliography(path: &str) -> bool {
    path.trim().to_ascii_lowercase().ends_with(".bib")
}

pub fn require_editable_path(path: &str) -> Result<(), ProjectError> {
    if is_managed_bibliography(path) {
        return Err(ProjectError::ManagedBibliography(path.to_owned()));
    }
    Ok(())
}

#[cfg(test)]
mod catalog_prepare_tests;
#[cfg(test)]
mod citation_metadata_tests;
#[cfg(test)]
mod directory_tests;
#[cfg(test)]
mod file_change_tests;
#[cfg(test)]
mod file_save_tests;
#[cfg(test)]
mod tests;

/// Preserve the original editable-path rule and file-kind classification.
/// Each result is consumed at the original Core check, before index writes.
pub fn agent_file_policy(
    path: &str,
) -> research_workbench_native_sdk::writing_file::AgentFilePolicy {
    research_workbench_native_sdk::writing_file::AgentFilePolicy {
        relative_path: path.into(),
        file_kind: file_kind(path).into(),
        editable: require_editable_path(path).is_ok(),
    }
}

#[cfg(test)]
mod agent_file_policy_tests;
