use super::{
    InputError, ProjectError, rows, validate_metadata, validate_recovery_draft, validate_session,
};
use research_workbench_native_sdk::writing_project::{
    CitationKeyRecovery, CreationPlan, Decision, InitialTemplate, Input, Metadata,
    MetadataDecision, Output, ProjectScope, RecoveryRetention, STANDALONE_PROJECT_ID,
};

pub(super) fn metadata(title: &str, root_path: &str) -> MetadataDecision {
    let title = title.trim();
    match validate_metadata(title, root_path) {
        Ok(()) => MetadataDecision::Ready {
            metadata: Metadata {
                title: title.into(),
                root_path: root_path.into(),
            },
        },
        Err(reason) => MetadataDecision::Rejected { reason },
    }
}

fn rejected(reason: ProjectError) -> Decision {
    Decision::Rejected { reason }
}

/// Each decision consumes owned rows captured by the actual Core operation.
/// It does not run SQL, execute a file action or release a transaction.
pub fn decide(input: Input) -> Result<Output, InputError> {
    let decision = match &input {
        Input::NoteAsset { input } => Decision::NoteAsset {
            decision: crate::note_assets::decide(input),
        },
        Input::Transfer { input } => Decision::Transfer {
            decision: Box::new(crate::transfer::decide(input)),
        },
        Input::PrepareAgentFileChanges { relative_paths } => Decision::AgentFileChangesPrepared {
            policies: relative_paths
                .iter()
                .map(|path| super::agent_file_policy(path))
                .collect(),
        },
        Input::Compile { input } => Decision::Compile {
            decision: Box::new(crate::compile::decide(input)),
        },
        Input::BibliographyMutation { input } => Decision::BibliographyMutation {
            decision: Box::new(crate::bibliography::mutation::decide(input)),
        },
        Input::BibliographyRekey { input } => Decision::BibliographyRekey {
            decision: Box::new(crate::bibliography::rekey::decide(input)),
        },
        Input::BibliographyAdoption { input } => Decision::BibliographyAdoption {
            decision: Box::new(crate::bibliography::adoption::decide(input)),
        },
        Input::BibliographyPublication { input } => Decision::BibliographyPublication {
            decision: Box::new(crate::bibliography::publication::decide(input)),
        },
        Input::BibliographyEntries { input } => Decision::BibliographyEntries {
            decision: Box::new(crate::bibliography::entries::decide(input)),
        },
        Input::HostFiles {
            manuscript_id,
            rows: captured,
        } => Decision::HostFiles {
            items: super::host_resource_files(rows::files(captured, manuscript_id)?),
        },
        Input::CitationMetadata {
            metadata_kind,
            manuscript_id,
            manuscript,
            data,
        } => super::citation_metadata::decide(
            *metadata_kind,
            manuscript_id,
            manuscript,
            data.as_ref(),
        )?,
        Input::Context { input } => Decision::Context {
            decision: Box::new(super::context::decide(input)),
        },
        Input::Checkpoint { input } => Decision::Checkpoint {
            decision: Box::new(super::checkpoint::decide(input)?),
        },
        Input::CatalogQuery { input } => Decision::CatalogQuery {
            decision: Box::new(super::catalog_query::decide(input)?),
        },
        Input::CatalogPreparation { input } => Decision::CatalogPreparation {
            decision: Box::new(super::catalog_prepare::decide(input)?),
        },
        Input::Directory { input } => Decision::Directory {
            decision: Box::new(super::directories::decide(input)),
        },
        Input::PrepareFileChange { request } => match super::file_change::prepare(request) {
            Ok(()) => Decision::FileChangePrepared {
                request: request.clone(),
            },
            Err(reason) => rejected(reason),
        },
        Input::PlanFileChange {
            request,
            manuscript,
        } => super::file_change::plan(request, manuscript)?,
        Input::PrepareFileSave {
            request,
            note_title,
        } => match super::file_save::prepare(request, note_title) {
            Ok(preparation) => Decision::FileSavePrepared {
                preparation: Box::new(preparation),
            },
            Err(reason) => rejected(reason),
        },
        Input::FinishFileSave {
            preparation,
            manuscript,
            note_analysis,
        } => super::file_save::finish(preparation, manuscript, note_analysis.as_deref())?,
        Input::PrepareFileRecovery {
            manuscript_id,
            pending,
        } => {
            let recovery = rows::pending_recovery(pending)?
                .map(|payload| {
                    super::citation_key_writes(&payload)
                        .map(|writes| CitationKeyRecovery {
                            writes,
                            file_kind: "tex".into(),
                        })
                        .map_err(|error| InputError::Json {
                            field: "citation key writes",
                            category: format!("{:?}", error.classify()),
                            line: error.line(),
                            column: error.column(),
                        })
                })
                .transpose()?;
            Decision::FileRecovery {
                manuscript_id: manuscript_id.clone(),
                recovery,
            }
        }
        Input::ListProjects { rows: captured } => Decision::Projects {
            items: rows::projects(captured)?,
        },
        Input::GetProject {
            manuscript_id,
            rows: captured,
        } => match rows::project(captured, manuscript_id)? {
            Some(manuscript) => Decision::Project { manuscript },
            None => rejected(ProjectError::ManuscriptNotFound),
        },
        Input::PrepareStatus { manuscript_id } => Decision::StatusPrepared {
            manuscript_id: manuscript_id.clone(),
        },
        Input::FinishStatus {
            manuscript_id,
            affected_rows,
            manuscript,
        } => match super::require_changed_manuscript(*affected_rows) {
            Err(reason) => rejected(reason),
            Ok(()) => match rows::project(
                manuscript
                    .as_ref()
                    .ok_or(InputError::MissingRelated("status readback"))?,
                manuscript_id,
            )? {
                Some(manuscript) => Decision::Project { manuscript },
                None => rejected(ProjectError::ManuscriptNotFound),
            },
        },
        Input::CheckRootKind { relative_path } => match super::require_tex_root(relative_path) {
            Ok(()) => Decision::RootKindAccepted {
                relative_path: relative_path.clone(),
            },
            Err(reason) => rejected(reason),
        },
        Input::PrepareCreation {
            manuscript_id,
            draft,
        } => match uuid::Uuid::parse_str(manuscript_id) {
            Ok(id) if !id.is_nil() => {
                let scope = match draft
                    .project_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    Some(project_id) => ProjectScope::Existing {
                        project_id: project_id.into(),
                    },
                    None => ProjectScope::Standalone {
                        project_id: STANDALONE_PROJECT_ID.into(),
                    },
                };
                let metadata = metadata(
                    &draft.title,
                    draft.root_path.as_deref().unwrap_or("main.tex"),
                );
                let initial_template = match &metadata {
                    MetadataDecision::Ready { metadata } => Some(InitialTemplate {
                        kind: "tex".into(),
                        content: super::initial_template(&metadata.title),
                    }),
                    MetadataDecision::Rejected { .. } => None,
                };
                Decision::Creation {
                    plan: CreationPlan {
                        manuscript_id: id.to_string(),
                        scope,
                        metadata,
                        initial_template,
                    },
                }
            }
            _ => rejected(ProjectError::InvalidManuscript),
        },
        Input::VerifyCreation {
            plan,
            project_exists,
        } => match &plan.scope {
            ProjectScope::Existing { .. }
                if !rows::exists(project_exists, "project existence")? =>
            {
                rejected(ProjectError::ProjectNotFound)
            }
            ProjectScope::Standalone { project_id }
                if project_id != STANDALONE_PROJECT_ID || !project_exists.rows.is_empty() =>
            {
                return Err(InputError::ProjectScope);
            }
            _ => Decision::Creation { plan: plan.clone() },
        },
        Input::PrepareUpdate {
            request,
            manuscript,
        } => match rows::project(manuscript, request.manuscript_id.trim())? {
            Some(current) => Decision::Metadata {
                manuscript_id: current.id,
                decision: metadata(
                    request.title.as_deref().unwrap_or(&current.title),
                    request.root_path.as_deref().unwrap_or(&current.root_path),
                ),
            },
            None => rejected(ProjectError::ManuscriptNotFound),
        },
        Input::PrepareDeletion {
            manuscript_id,
            manuscript,
        } => match rows::project(manuscript, manuscript_id)? {
            None => rejected(ProjectError::ManuscriptNotFound),
            Some(current) if current.status != "archived" => {
                rejected(ProjectError::ManuscriptMustBeArchived)
            }
            Some(_) => Decision::DeletionNeedsCompileCheck {
                manuscript_id: manuscript_id.clone(),
            },
        },
        Input::VerifyDeletion {
            manuscript_id,
            active_compile,
        } => {
            if rows::exists(active_compile, "active compile")? {
                rejected(ProjectError::CompileAlreadyRunning)
            } else {
                Decision::Deletion {
                    manuscript_id: manuscript_id.clone(),
                }
            }
        }
        Input::ListFiles {
            manuscript_id,
            manuscript,
            files,
        } => match rows::project(manuscript, manuscript_id)? {
            None => rejected(ProjectError::ManuscriptNotFound),
            Some(_) => Decision::Files {
                files: rows::files(
                    files.as_ref().ok_or(InputError::MissingRelated("files"))?,
                    manuscript_id,
                )?,
            },
        },
        Input::GetSession {
            manuscript_id,
            manuscript,
            session,
        } => match rows::project(manuscript, manuscript_id)? {
            None => rejected(ProjectError::ManuscriptNotFound),
            Some(_) => Decision::Session {
                session: rows::session(
                    session
                        .as_ref()
                        .ok_or(InputError::MissingRelated("session"))?,
                    manuscript_id,
                )?,
            },
        },
        Input::PrepareSession { draft } => match validate_session(draft) {
            Ok(()) => Decision::SessionPrepared {
                draft: draft.clone(),
            },
            Err(reason) => rejected(reason),
        },
        Input::ListRecoveryDrafts {
            manuscript_id,
            manuscript,
            drafts,
        } => match rows::project(manuscript, manuscript_id)? {
            None => rejected(ProjectError::ManuscriptNotFound),
            Some(_) => Decision::RecoveryDrafts {
                drafts: rows::drafts(
                    drafts
                        .as_ref()
                        .ok_or(InputError::MissingRelated("drafts"))?,
                    manuscript_id,
                )?,
            },
        },
        Input::PrepareRecoveryDraft { draft, manuscript } => {
            match rows::project(manuscript, draft.manuscript_id.trim())? {
                None => rejected(ProjectError::ManuscriptNotFound),
                Some(_) => match validate_recovery_draft(draft) {
                    Ok(()) => Decision::RecoveryDraftPrepared {
                        draft: draft.clone(),
                        retention: RecoveryRetention {
                            per_manuscript: super::MAX_RECOVERY_DRAFTS_PER_MANUSCRIPT as u64,
                            total: super::MAX_RECOVERY_DRAFTS_TOTAL as u64,
                        },
                    },
                    Err(reason) => rejected(reason),
                },
            }
        }
        Input::ProjectRecoveryDraft {
            manuscript_id,
            relative_path,
            rows: captured,
        } => {
            let mut drafts = rows::drafts(captured, manuscript_id)?;
            if drafts.is_empty() {
                return Err(InputError::MissingRelated("saved draft"));
            }
            if drafts.len() != 1 {
                return Err(InputError::Multiplicity("saved draft"));
            }
            let draft = drafts.remove(0);
            if draft.relative_path != *relative_path {
                return Err(InputError::DraftPath);
            }
            Decision::RecoveryDraft { draft }
        }
        Input::PrepareRecoveryClear {
            manuscript_id,
            relative_path,
        } => match super::validate_recovery_path(relative_path) {
            Ok(()) => Decision::RecoveryClearPrepared {
                manuscript_id: manuscript_id.clone(),
                relative_path: relative_path.clone(),
            },
            Err(reason) => rejected(reason),
        },
    };
    Ok(Output { input, decision })
}
