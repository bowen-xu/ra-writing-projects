//! The original canonical SQL labels, typed row bytes and source-stat proof.
use super::Error;
use research_workbench_native_sdk::writing_bibliography::{
    PublicationDecision, PublicationProof, SourceStats,
};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub fn sql() -> [&'static str; 4] {
    [
        include_str!("../../data/project-bibliography-proof-files.v1.sql"),
        include_str!("../../data/project-bibliography-proof-entries.v1.sql"),
        include_str!("../../data/project-bibliography-proof-members.v1.sql"),
        include_str!("../../data/project-bibliography-proof-bindings.v1.sql"),
    ]
    .map(|sql| sql.trim_end_matches('\n'))
}

pub fn decide(input: &PublicationProof) -> Result<PublicationDecision, Error> {
    let mut hash = Sha256::new();
    for (sql, rows) in sql().iter().zip(&input.rows) {
        hash.update(sql.as_bytes());
        for row in rows {
            hash.update([2]);
            for text in row {
                match text {
                    None => hash.update([0]),
                    Some(text) => {
                        hash.update([1]);
                        hash.update((text.len() as u64).to_le_bytes());
                        hash.update(text.as_bytes());
                    }
                }
            }
        }
    }
    hash.update((input.root.len() as u64).to_le_bytes());
    hash.update(input.root.as_bytes());
    let mut paths = BTreeSet::from([input.root.clone()]);
    for file in input.files.iter().filter(|file| file.kind == "tex") {
        hash.update((file.relative_path.len() as u64).to_le_bytes());
        hash.update(file.relative_path.as_bytes());
        hash.update(file.sha256.as_bytes());
        paths.insert(file.relative_path.clone());
    }
    let paths = paths.into_iter().collect::<Vec<_>>();
    let values = match &input.stats {
        SourceStats::Unqueried => return Ok(PublicationDecision::NeedStats { paths }),
        SourceStats::Missing => return Ok(PublicationDecision::Proof { fingerprint: None }),
        SourceStats::Ready { values } => values,
    };
    if values.len() != paths.len()
        || values
            .iter()
            .zip(&paths)
            .any(|(stat, path)| stat.path != *path)
    {
        return Err(Error::InvalidPath);
    }
    for stat in values {
        hash.update((stat.path.len() as u64).to_le_bytes());
        hash.update(stat.path.as_bytes());
        for value in [stat.dev, stat.ino, stat.len] {
            hash.update(value.to_le_bytes());
        }
        for value in [stat.mtime, stat.mtime_nsec, stat.ctime, stat.ctime_nsec] {
            hash.update(value.to_le_bytes());
        }
    }
    Ok(PublicationDecision::Proof {
        fingerprint: Some(hash.finalize().into()),
    })
}
