//! Original declaration, retention, content and file-CAS decisions.
use super::{Error, parse, retain};
use research_workbench_native_sdk::{
    resource_path::validate_relative_path,
    writing_bibliography::{
        FileComparison, PublicationContent, PublicationDecision, PublicationFile, PublicationInput,
        SupplementalEntry, SupplementalProjection,
    },
    writing_project::ManuscriptFile,
};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

const HEADER: &str = "% Managed by Research Assistant. Edit entries in the bibliography manager.\n";

pub fn supplemental(
    declared: &[String],
    registered: &[String],
    rows: &[SupplementalEntry],
) -> SupplementalProjection {
    let declared = declared.iter().collect::<HashSet<_>>();
    let mut entries = Vec::new();
    let mut source_paths = HashSet::new();
    for row in rows {
        if row.member_paths.iter().all(|path| !declared.contains(path)) {
            entries.push(row.bibtex_entry.clone());
            source_paths.extend(row.member_paths.iter());
        }
    }
    let support_paths = registered
        .iter()
        .filter(|path| source_paths.contains(*path))
        .cloned()
        .collect();
    SupplementalProjection {
        entries,
        support_paths,
    }
}

pub fn source_paths(files: &[ManuscriptFile], root_path: &str) -> Vec<String> {
    let mut paths = files
        .iter()
        .filter(|file| file.kind == "tex")
        .map(|file| file.relative_path.clone())
        .collect::<HashSet<_>>();
    paths.insert(root_path.to_owned());
    paths.into_iter().collect()
}

pub fn declarations(source: &str, declared: Vec<String>) -> Result<Vec<String>, Error> {
    let command =
        regex::Regex::new(r"\\(?:bibliography|addbibresource)(?:\s*\[[^\]]*\])?\s*\{([^{}]+)\}")
            .map_err(|_| Error::InvalidBibtexEntry)?;
    let mut declared = declared.into_iter().collect::<HashSet<_>>();
    let source = source
        .lines()
        .map(parse::uncomment)
        .collect::<Vec<_>>()
        .join("\n");
    for capture in command.captures_iter(&source) {
        if let Some(names) = capture.get(1) {
            for name in names.as_str().split(',') {
                let name = name.trim();
                let path = if name.to_ascii_lowercase().ends_with(".bib") {
                    name.to_owned()
                } else {
                    format!("{name}.bib")
                };
                validate_relative_path(&path).map_err(|_| Error::InvalidPath)?;
                declared.insert(path);
            }
        }
    }
    let mut result = declared.into_iter().collect::<Vec<_>>();
    result.sort();
    Ok(result)
}

pub fn target(declared: Vec<String>, registered: &[String]) -> (Vec<String>, String) {
    let mut declared = declared.into_iter().collect::<HashSet<_>>();
    if declared.is_empty() {
        declared.insert("references.bib".into());
    }
    let target = if declared.contains("references.bib") {
        "references.bib".into()
    } else {
        registered
            .iter()
            .find(|path| declared.contains(*path))
            .cloned()
            .unwrap_or_else(|| {
                declared
                    .iter()
                    .min()
                    .cloned()
                    .unwrap_or_else(|| "references.bib".into())
            })
    };
    let mut result = declared.into_iter().collect::<Vec<_>>();
    result.sort();
    (result, target)
}

pub fn content(file: &PublicationFile) -> Option<PublicationContent> {
    let mut entries = file.entries.clone();
    let support = if file.path == file.target {
        let automatic = file.automatic.as_ref()?;
        let imported = automatic.imported_keys.iter().collect::<HashSet<_>>();
        let retained = automatic.retained_keys.iter().collect::<HashSet<_>>();
        entries.extend(file.supplemental_entries.clone());
        entries.extend(
            automatic
                .bindings
                .iter()
                .filter(|binding| {
                    !imported.contains(&binding.citation_key)
                        && retained.contains(&binding.citation_key)
                })
                .map(|binding| binding.bibtex_entry.clone()),
        );
        format!("{}\n{}", file.support, file.supplemental_support)
    } else {
        file.support.clone()
    };
    let content = format!("{HEADER}{}\n{}\n", support.trim(), entries.join("\n\n"));
    let sha256 = format!("{:x}", Sha256::digest(content.as_bytes()));
    Some(PublicationContent { content, sha256 })
}

pub fn compare(previous: &str, target: &str, actual: Option<&str>) -> FileComparison {
    if actual == Some(target) {
        return FileComparison::Current;
    }
    let expected = (!previous.is_empty()).then_some(previous);
    if actual != expected {
        return FileComparison::Conflict;
    }
    FileComparison::Write {
        expected: expected.map(str::to_owned),
    }
}

pub fn verify(expected: &str, actual: Option<&str>) -> bool {
    actual == (!expected.is_empty()).then_some(expected)
}

pub fn decide(input: &PublicationInput) -> PublicationDecision {
    match input {
        PublicationInput::Regeneration {
            target,
            previous,
            bindings_empty,
            supplemental_empty,
            original,
            force,
        } => PublicationDecision::Regeneration {
            plan: super::recovery::regeneration(
                target,
                previous,
                *bindings_empty,
                *supplemental_empty,
                original.as_ref(),
                *force,
            ),
        },
        PublicationInput::LegacyRecovery {
            registered,
            reference_is_file,
            reference_read,
            probes,
        } => {
            match super::recovery::legacy(*registered, *reference_is_file, *reference_read, probes)
            {
                Ok(plan) => PublicationDecision::LegacyRecovery { plan },
                Err(reason) => PublicationDecision::Rejected { reason },
            }
        }
        PublicationInput::Proof { input } => super::proof::decide(input)
            .unwrap_or_else(|reason| PublicationDecision::Rejected { reason }),
        PublicationInput::Verify {
            expected,
            actual_sha256,
        } => PublicationDecision::Verified {
            matches: verify(expected, actual_sha256.as_deref()),
        },
        PublicationInput::Supplemental {
            declared,
            registered,
            entries,
        } => PublicationDecision::Supplemental {
            projection: supplemental(declared, registered, entries),
        },
        PublicationInput::SourcePaths { files, root_path } => PublicationDecision::SourcePaths {
            paths: source_paths(files, root_path),
        },
        PublicationInput::Declarations { source, declared } => {
            match declarations(source, declared.clone()) {
                Ok(declared) => PublicationDecision::Declarations { declared },
                Err(reason) => PublicationDecision::Rejected { reason },
            }
        }
        PublicationInput::Target {
            declared,
            registered,
        } => {
            let (declared, target) = target(declared.clone(), registered);
            PublicationDecision::Target { declared, target }
        }
        PublicationInput::Retention {
            sources,
            automatic,
            imported,
            preserve_imported,
        } => {
            let sources = if *preserve_imported && automatic.is_empty() {
                &[][..]
            } else {
                let Some(sources) = sources else {
                    return PublicationDecision::NeedSources;
                };
                sources.as_slice()
            };
            match retain(sources, automatic, imported, *preserve_imported) {
                Ok(keys) => {
                    let mut keys = keys.into_iter().collect::<Vec<_>>();
                    keys.sort();
                    PublicationDecision::Retained { keys }
                }
                Err(reason) => PublicationDecision::Rejected { reason },
            }
        }
        PublicationInput::Content { file } => match content(file) {
            Some(content) => PublicationDecision::Content { content },
            None => PublicationDecision::NeedAutomatic,
        },
        PublicationInput::Compare {
            previous,
            target_sha256,
            actual_sha256,
        } => PublicationDecision::Compared {
            result: compare(previous, target_sha256, actual_sha256.as_deref()),
        },
    }
}

#[cfg(test)]
mod tests;
