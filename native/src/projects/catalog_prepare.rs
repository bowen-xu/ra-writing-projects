//! Original bounded index preparation policy, using the existing Note projection.
use super::{InputError, file_save, rows};
use research_workbench_native_sdk::writing_catalog::{
    CatalogDecision, CatalogInput, FileRead, ItemEffect, ItemInput, ItemPlan, ItemPreparation,
    PreparationScope,
};

pub fn catalog_statuses(scope: PreparationScope) -> (&'static str, &'static str) {
    match scope {
        PreparationScope::Active => ("active", "active"),
        PreparationScope::Archived => ("archived", "archived"),
        PreparationScope::Live => ("active", "archived"),
    }
}

fn prepare(item: &ItemInput) -> ItemPreparation {
    let note = match &item.read {
        FileRead::Read { content, hash } if hash == &item.file.hash => Some(
            file_save::prepare_catalog_note(&item.file.path, &item.note_title, content),
        ),
        _ => None,
    };
    ItemPreparation {
        input: item.clone(),
        note,
    }
}

pub(super) fn decide(input: &CatalogInput) -> Result<CatalogDecision, InputError> {
    Ok(match input {
        CatalogInput::Batch { scope, .. } => {
            let (a, b) = catalog_statuses(*scope);
            CatalogDecision::Batch {
                statuses: [a.into(), b.into()],
            }
        }
        CatalogInput::Pending { rows } => CatalogDecision::Pending {
            files: rows::pending_catalog_files(rows)?,
        },
        CatalogInput::PrepareItem { item } => CatalogDecision::PrepareItem {
            preparation: Box::new(prepare(item)),
        },
        CatalogInput::FinishItem {
            preparation,
            analysis,
        } => {
            if prepare(&preparation.input) != **preparation {
                return Err(InputError::NoteAnalysis);
            }
            let effect = match (&preparation.input.read, &preparation.note, analysis) {
                (_, Some(note), analysis) => ItemEffect::Record {
                    projection: file_save::project_catalog_note(note, analysis.as_ref())?,
                },
                (FileRead::Read { .. }, None, None) => ItemEffect::ExternalChange {},
                (FileRead::Failed { cause }, None, None) => ItemEffect::Error {
                    cause: format!("writing_note_catalog_read_failed：{cause}"),
                },
                _ => return Err(InputError::NoteAnalysis),
            };
            CatalogDecision::FinishItem {
                plan: Box::new(ItemPlan {
                    preparation: (**preparation).clone(),
                    effect,
                    duplicate_identity_cause: file_save::DUPLICATE_NOTE_IDENTITY.into(),
                }),
            }
        }
        CatalogInput::Finish {
            processed_count,
            rows,
        } => CatalogDecision::Finish {
            result: rows::catalog_preparation(rows, *processed_count)?,
        },
    })
}
