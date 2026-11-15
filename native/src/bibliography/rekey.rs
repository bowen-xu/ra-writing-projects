//! Original key identity checks and text/checkpoint edits, without persistence.
use super::{Error, parse::valid_key, rekey_text};
use crate::projects::checkpoint;
use research_workbench_native_sdk::{
    writing_bibliography::{
        ProjectBibliographyEntry,
        rekey::{Assignment, Decision, Input, Rejection},
    },
    writing_project::Rejection as ProjectRejection,
};
use std::collections::{BTreeMap, HashSet};

pub fn mapping(
    assignments: &[Assignment],
    entries: &[ProjectBibliographyEntry],
) -> Result<BTreeMap<String, String>, Rejection> {
    let mut identities = HashSet::new();
    let mut keys = HashSet::new();
    let mut mapping = BTreeMap::new();
    for assignment in assignments {
        if !valid_key(&assignment.to)
            || !valid_key(&assignment.base_key)
            || !identities.insert(assignment.reference_id.clone())
            || !keys.insert(assignment.to.clone())
        {
            return Err(Error::InvalidBibtexEntry.into());
        }
        let current = entries
            .iter()
            .find(|row| row.id == assignment.reference_id)
            .ok_or(Rejection::CitationSourceNotFound)?;
        if current.citation_key == assignment.to {
            continue;
        }
        if current.citation_key != assignment.from {
            return Err(ProjectRejection::CheckpointConflict.into());
        }
        mapping.insert(assignment.from.clone(), assignment.to.clone());
    }
    for row in entries {
        if !identities.contains(&row.id) && !keys.insert(row.citation_key.clone()) {
            return Err(Error::InvalidBibtexEntry.into());
        }
    }
    Ok(mapping)
}

fn prepare(input: &Input) -> Result<Decision, Rejection> {
    Ok(match input {
        Input::Mapping {
            assignments,
            entries,
        } => Decision::Mapping {
            mapping: mapping(assignments, entries)?,
        },
        Input::Source { source, mapping } => Decision::Source {
            text: rekey_text::rewrite(source, mapping),
        },
        Input::TemporaryOwners { keys, mapping } => Decision::TemporaryOwners {
            owners: keys
                .iter()
                .filter(|(_, key)| mapping.contains_key(key))
                .map(|(owner, _)| owner.clone())
                .collect(),
        },
        Input::Canonical {
            key,
            source,
            mapping,
        } => Decision::Canonical {
            key: mapping.get(key).unwrap_or(key).clone(),
            text: rekey_text::bibliography(source, mapping)?,
        },
        Input::Checkpoint {
            manuscript_id,
            relative_path,
            text,
            actual_sha256,
            next,
            mapping,
            record,
        } => {
            let Some(record) = record else {
                return Ok(Decision::Checkpoint { checkpoint: None });
            };
            let mut current = record.checkpoint.clone();
            checkpoint::validate(&current)?;
            if current.manuscript_id != *manuscript_id || current.relative_path != *relative_path {
                return Err(ProjectRejection::InvalidCheckpoint.into());
            }
            if current.save_intent.is_some()
                || current.saved_sha256 != *actual_sha256
                || current.content != *text
            {
                return Err(ProjectRejection::CheckpointConflict.into());
            }
            let baseline = rekey_text::rewrite(&current.review_baseline, mapping);
            let changed = current.content != *next || current.review_baseline != baseline;
            if changed {
                use sha2::{Digest, Sha256};
                current.version += 1;
                current.saved_version = current.version;
                current.content = next.clone();
                current.review_baseline = baseline;
                current.saved_sha256 = format!("{:x}", Sha256::digest(next.as_bytes()));
            }
            Decision::Checkpoint {
                checkpoint: changed.then_some(Box::new(current)),
            }
        }
    })
}

pub fn decide(input: &Input) -> Decision {
    prepare(input).unwrap_or_else(|reason| Decision::Rejected { reason })
}

#[cfg(test)]
mod tests {
    use super::*;
    use research_workbench_native_sdk::writing_checkpoint::{
        CheckpointRecord, DocumentCheckpoint, SaveIntent,
    };
    use serde_json::json;
    fn entry(id: &str, key: &str) -> ProjectBibliographyEntry {
        serde_json::from_value(json!({"id":id,"manuscriptId":"m","citationKey":key,
            "originalKey":key,"originalBibtex":"","bibtexEntry":"","imported":{},"current":{},"libraryItem":null,"paths":[]})).unwrap()
    }
    fn assignment(id: &str, from: &str, to: &str) -> Assignment {
        Assignment {
            reference_id: id.into(),
            base_key: "base".into(),
            from: from.into(),
            to: to.into(),
        }
    }
    #[test]
    fn mapping_keeps_swaps_collisions_and_lost_reply_identity() {
        let rows = vec![entry("a", "x"), entry("b", "y")];
        assert_eq!(
            mapping(
                &[assignment("a", "x", "y"), assignment("b", "y", "x")],
                &rows
            )
            .unwrap(),
            BTreeMap::from([("x".into(), "y".into()), ("y".into(), "x".into())])
        );
        assert!(matches!(
            mapping(&[assignment("a", "x", "y")], &rows),
            Err(Rejection::Bibliography(Error::InvalidBibtexEntry))
        ));
        assert!(matches!(
            mapping(&[assignment("missing", "x", "z")], &rows),
            Err(Rejection::CitationSourceNotFound)
        ));
        assert!(matches!(
            mapping(&[assignment("a", "stale", "z")], &rows),
            Err(Rejection::Project(ProjectRejection::CheckpointConflict))
        ));
        assert!(
            mapping(&[assignment("a", "stale", "x")], &rows)
                .unwrap()
                .is_empty()
        );
        assert!(matches!(
            mapping(
                &[assignment("a", "x", "z"), assignment("a", "x", "w")],
                &rows
            ),
            Err(Rejection::Bibliography(Error::InvalidBibtexEntry))
        ));
    }
    fn checkpoint_input() -> Input {
        use sha2::{Digest, Sha256};
        let text = "\\cite{x} revised";
        let checkpoint: DocumentCheckpoint=serde_json::from_value(json!({"schemaVersion":1,"manuscriptId":"m",
            "relativePath":"main.tex","version":2,"savedVersion":2,"content":text,
            "reviewBaseline":"\\cite{x} original","savedSha256":format!("{:x}",Sha256::digest(text.as_bytes())),
            "operations":[],"saveIntent":null})).unwrap();
        Input::Checkpoint {
            manuscript_id: "m".into(),
            relative_path: "main.tex".into(),
            text: text.into(),
            actual_sha256: checkpoint.saved_sha256.clone(),
            next: "\\cite{y} revised".into(),
            mapping: BTreeMap::from([("x".into(), "y".into())]),
            record: Some(Box::new(CheckpointRecord {
                revision: 7,
                checkpoint,
            })),
        }
    }
    #[test]
    fn checkpoint_rewrites_both_texts_preserving_review_difference_and_rejects_pending_save() {
        let input = checkpoint_input();
        let Decision::Checkpoint {
            checkpoint: Some(next),
        } = decide(&input)
        else {
            panic!("checkpoint");
        };
        assert_eq!(next.content, "\\cite{y} revised");
        assert_eq!(next.review_baseline, "\\cite{y} original");
        assert_eq!((next.version, next.saved_version), (3, 3));
        let mut pending = input.clone();
        if let Input::Checkpoint {
            record: Some(record),
            ..
        } = &mut pending
        {
            record.checkpoint.save_intent = Some(SaveIntent {
                operation_id: "save".into(),
                version: 2,
                expected_sha256: record.checkpoint.saved_sha256.clone(),
                target_sha256: next.saved_sha256.clone(),
            });
        }
        assert!(matches!(
            decide(&pending),
            Decision::Rejected {
                reason: Rejection::Project(ProjectRejection::CheckpointConflict)
            }
        ));
        let mut no_change = input;
        if let Input::Checkpoint {
            record: Some(record),
            text,
            next,
            mapping,
            ..
        } = &mut no_change
        {
            *next = text.clone();
            mapping.clear();
            record.checkpoint.review_baseline = text.clone();
        }
        assert_eq!(
            decide(&no_change),
            Decision::Checkpoint { checkpoint: None }
        );
    }
    #[test]
    fn rekey_wire_keeps_required_nulls_closed_inputs_and_existing_assignment_shape() {
        let input = checkpoint_input();
        let mut encoded = serde_json::to_value(&input).unwrap();
        assert_eq!(
            serde_json::from_value::<Input>(encoded.clone()).unwrap(),
            input
        );
        encoded.as_object_mut().unwrap().remove("record");
        assert!(serde_json::from_value::<Input>(encoded).is_err());
        let a = assignment("id", "x", "y");
        assert_eq!(
            serde_json::to_value(a).unwrap(),
            json!({"referenceId":"id","baseKey":"base","from":"x","to":"y"})
        );
    }
}
