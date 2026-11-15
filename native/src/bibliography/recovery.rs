//! Original first-projection conflict and legacy preservation choices.
use super::Error;
use research_workbench_native_sdk::{
    writing_bibliography::{LegacyRecoveryPlan, RegenerationPlan},
    writing_project::BibliographyStatus,
};
pub fn regeneration(
    target: &str,
    previous: &BibliographyStatus,
    bindings_empty: bool,
    supplemental_empty: bool,
    original: Option<&(String, String)>,
    force: bool,
) -> RegenerationPlan {
    if bindings_empty && supplemental_empty && original.is_none() {
        return RegenerationPlan::Unchanged;
    }
    let expected = (previous.relative_path == target)
        .then_some(previous.content_hash.as_ref())
        .flatten();
    if !force && original.map(|(_, hash)| hash) != expected {
        return RegenerationPlan::Conflict {
            expected: expected.cloned(),
        };
    }
    RegenerationPlan::Register
}
pub fn legacy(
    registered: bool,
    reference_is_file: Option<bool>,
    reference_read: bool,
    probes: &[(String, bool)],
) -> Result<LegacyRecoveryPlan, Error> {
    if registered {
        return Ok(LegacyRecoveryPlan::Ready {
            force: false,
            user_path: None,
        });
    }
    let Some(is_file) = reference_is_file else {
        return Ok(LegacyRecoveryPlan::NeedIsFile {
            path: "references.bib".into(),
        });
    };
    if !is_file {
        return Ok(LegacyRecoveryPlan::Ready {
            force: true,
            user_path: None,
        });
    }
    if !reference_read {
        return Ok(LegacyRecoveryPlan::NeedReferenceRead {
            path: "references.bib".into(),
        });
    }
    let Some((path, exists)) = probes.first() else {
        return Ok(LegacyRecoveryPlan::NeedExists {
            path: "bibliography-backup.txt".into(),
        });
    };
    if path != "bibliography-backup.txt" {
        return Err(Error::InvalidPath);
    }
    if !exists {
        return Ok(LegacyRecoveryPlan::Ready {
            force: true,
            user_path: Some("local.bib".into()),
        });
    }
    let mut suffix = 2;
    for (path, exists) in probes.iter().skip(1) {
        if *path != format!("bibliography-backup-{suffix}.txt") {
            return Err(Error::InvalidPath);
        }
        if !exists {
            return Ok(LegacyRecoveryPlan::Ready {
                force: true,
                user_path: Some(path.clone()),
            });
        }
        suffix += 1;
    }
    Ok(LegacyRecoveryPlan::NeedExists {
        path: format!("bibliography-backup-{suffix}.txt"),
    })
}
