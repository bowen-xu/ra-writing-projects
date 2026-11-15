//! Original per-file selection, parsing, migration guard and library projection.
use super::{Error, parse};
use research_workbench_native_sdk::{
    writing_bibliography::adoption::{
        AdoptionDecision, AdoptionInput, FileSelection, GeneratedHash, ImportedEntry, ImportedFile,
        PublicationChoice,
    },
    writing_project::ManuscriptFile,
};
use serde_json::Value;
use std::collections::HashSet;

pub fn select_file(file: &ManuscriptFile, known: bool, generated: &GeneratedHash) -> FileSelection {
    if !crate::projects::is_managed_bibliography(&file.relative_path) || known {
        return FileSelection::Skip;
    }
    if file.relative_path == "references.bib" {
        match generated {
            GeneratedHash::Unqueried => return FileSelection::NeedGeneratedHash,
            GeneratedHash::Ready { value } if value.as_deref() == Some(file.sha256.as_str()) => {
                return FileSelection::Skip;
            }
            GeneratedHash::Ready { .. } => {}
        }
    }
    FileSelection::Read
}

pub fn parse_imported(
    physical_files: &[(String, String)],
    originals: Option<&[(String, String)]>,
    occupied: &HashSet<String>,
) -> Result<Vec<ImportedFile>, Error> {
    let files = physical_files
        .iter()
        .map(|(path, text)| {
            let original = originals
                .and_then(|sources| sources.iter().find(|(source, _)| source == path))
                .map(|(_, text)| text.clone())
                .unwrap_or_else(|| text.clone());
            (path.clone(), original)
        })
        .collect::<Vec<_>>();
    if originals.is_some() {
        parse::parse(&files, occupied)
    } else {
        parse::parse_existing(&files, occupied)
    }
}

pub fn validate_entry(
    entry: &ImportedEntry,
    path: &str,
    originals: Option<&[(String, String)]>,
    files: &[ManuscriptFile],
) -> Result<(), Error> {
    if originals.is_none_or(|sources| !sources.iter().any(|(source, _)| source == path))
        && entry.key != entry.original_key
        && files.iter().any(|file| file.kind == "tex")
    {
        return Err(Error::BibliographyImport(format!(
            "引用键 {} 需要迁移；原文件已保留，请通过项目导入统一规范化",
            entry.original_key,
        )));
    }
    Ok(())
}

fn token(text: &str) -> String {
    text.chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

pub fn match_library(
    normalized_doi: &str,
    draft: &Value,
    exact_doi: bool,
    candidates: &[Value],
) -> Option<Value> {
    let author = |value: &Value| {
        value["creators"]
            .as_array()
            .and_then(|people| people.first())
            .and_then(|person| person["familyName"].as_str())
            .map(token)
            .unwrap_or_default()
    };
    let mut matches = candidates
        .iter()
        .filter(|item| {
            exact_doi
                || ((normalized_doi.is_empty()
                    || item["doi"].as_str().unwrap_or_default().is_empty())
                    && token(item["title"].as_str().unwrap_or_default())
                        == token(draft["title"].as_str().unwrap_or_default())
                    && item["issuedYear"] == draft["issuedYear"]
                    && !author(draft).is_empty()
                    && author(item) == author(draft))
        })
        .collect::<Vec<_>>();
    if matches.len() == 1 {
        matches.pop().cloned()
    } else {
        None
    }
}

pub fn canonical_entry(entry: &ImportedEntry, library: Option<&Value>) -> Result<String, Error> {
    match library {
        Some(item) => parse::from_library(
            entry.metadata["rawBibtex"]
                .as_str()
                .unwrap_or(&entry.normalized),
            &entry.key,
            item,
        ),
        None => Ok(entry.normalized.clone()),
    }
}

pub fn publication(always: bool, proof_current: Option<bool>) -> PublicationChoice {
    if always {
        return PublicationChoice::Publish;
    }
    match proof_current {
        None => PublicationChoice::NeedProof,
        Some(false) => PublicationChoice::Publish,
        Some(true) => PublicationChoice::Verify,
    }
}

pub fn decide(input: &AdoptionInput) -> AdoptionDecision {
    let result = match input {
        AdoptionInput::NormalizeBinding { entry, key } => {
            super::normalize::single_entry(entry, key)
                .map(|text| AdoptionDecision::CanonicalEntry { text })
        }
        AdoptionInput::FromLibrary {
            template,
            key,
            item,
        } => template
            .as_deref()
            .ok_or(Error::InvalidBibtexEntry)
            .and_then(|template| parse::from_library(template, key, item))
            .map(|text| AdoptionDecision::CanonicalEntry { text }),
        AdoptionInput::Publication {
            always,
            proof_current,
        } => Ok(AdoptionDecision::PublicationChosen {
            result: publication(*always, *proof_current),
        }),
        AdoptionInput::ResourcePath { relative_path } => Ok(AdoptionDecision::ResourcePath {
            file_kind: crate::projects::file_kind(relative_path).into(),
            managed_bibliography: crate::projects::is_managed_bibliography(relative_path),
        }),
        AdoptionInput::NormalizeResources { sources, occupied } => {
            super::resources::normalize(sources, &occupied.iter().cloned().collect())
                .map(|plan| AdoptionDecision::ResourcesNormalized { plan })
        }
        AdoptionInput::ResourceSource {
            source,
            mapping,
            existing,
        } => super::resources::source(source, mapping, *existing)
            .map(|text| AdoptionDecision::ResourceSource { text }),
        AdoptionInput::SelectFile {
            file,
            known,
            generated,
        } => Ok(AdoptionDecision::Selected {
            result: select_file(file, *known, generated),
        }),
        AdoptionInput::Parse {
            physical_files,
            originals,
            occupied,
        } => parse_imported(
            physical_files,
            originals.as_deref(),
            &occupied.iter().cloned().collect(),
        )
        .map(|files| AdoptionDecision::Parsed { files }),
        AdoptionInput::ValidateEntry {
            entry,
            path,
            originals,
            files,
        } => validate_entry(entry, path, originals.as_deref(), files)
            .map(|()| AdoptionDecision::EntryAccepted),
        AdoptionInput::MatchLibrary {
            normalized_doi,
            draft,
            exact_doi,
            candidates,
        } => Ok(AdoptionDecision::LibraryMatched {
            item: match_library(normalized_doi, draft, *exact_doi, candidates),
        }),
        AdoptionInput::CanonicalEntry { entry, library } => {
            canonical_entry(entry, library.as_ref())
                .map(|text| AdoptionDecision::CanonicalEntry { text })
        }
    };
    result.unwrap_or_else(|reason| AdoptionDecision::Rejected { reason })
}

#[cfg(test)]
mod tests;
