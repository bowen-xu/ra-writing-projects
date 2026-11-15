//! Original imported and automatic entry projection with owned related inputs.
use super::{Error, parse::metadata};
use research_workbench_native_sdk::{
    writing_bibliography::{
        EntryDecision, EntryInput, ImportedRecord, PreparedAutomatic, PreparedImported,
        ProjectBibliographyEntry,
    },
    writing_project::CitationBinding,
};
use serde_json::Value;

pub fn prepare_imported(
    manuscript_id: &str,
    rows: Vec<ImportedRecord>,
    support: &str,
) -> Result<Vec<PreparedImported>, Error> {
    let all_text = format!(
        "{}\n{}",
        support,
        rows.iter()
            .map(|row| row.bibtex_entry.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    );
    let canonical = biblatex::Bibliography::parse(&all_text)
        .map_err(|error| Error::BibliographyImport(error.to_string()))?;
    Ok(rows
        .into_iter()
        .map(|record| PreparedImported {
            manuscript_id: manuscript_id.to_owned(),
            current: canonical.get(&record.citation_key).map(metadata),
            record,
        })
        .collect())
}

pub fn finish_imported(
    entry: PreparedImported,
    imported: Value,
    paths: Vec<String>,
    base_key: Option<String>,
    library_item: Option<Value>,
) -> Result<ProjectBibliographyEntry, Error> {
    let record = entry.record;
    Ok(ProjectBibliographyEntry {
        id: record.id,
        manuscript_id: entry.manuscript_id,
        citation_key: record.citation_key,
        base_key,
        original_key: record.original_key,
        original_bibtex: record.original_bibtex,
        bibtex_entry: record.bibtex_entry,
        imported,
        current: entry.current.ok_or(Error::InvalidBibtexEntry)?,
        library_item_id: record.library_item_id,
        library_item,
        paths,
    })
}

pub fn prepare_automatic(
    manuscript_id: &str,
    binding: CitationBinding,
    occupied_keys: &[String],
) -> Result<Option<PreparedAutomatic>, Error> {
    if occupied_keys.iter().any(|key| key == &binding.citation_key) {
        return Ok(None);
    }
    let bibliography = biblatex::Bibliography::parse(&binding.bibtex_entry)
        .map_err(|_| Error::InvalidBibtexEntry)?;
    let metadata = bibliography
        .iter()
        .next()
        .map(metadata)
        .ok_or(Error::InvalidBibtexEntry)?;
    Ok(Some(PreparedAutomatic {
        manuscript_id: manuscript_id.to_owned(),
        reference_id: format!("binding:{}", binding.literature_item_id),
        read_library: binding.state == "active",
        binding,
        metadata,
    }))
}

pub fn finish_automatic(
    entry: PreparedAutomatic,
    base_key: Option<String>,
    library_item: Option<Value>,
) -> ProjectBibliographyEntry {
    let library_item = entry.read_library.then_some(library_item).flatten();
    let binding = entry.binding;
    ProjectBibliographyEntry {
        id: entry.reference_id,
        manuscript_id: entry.manuscript_id,
        citation_key: binding.citation_key.clone(),
        base_key,
        original_key: binding.citation_key,
        original_bibtex: binding.bibtex_entry.clone(),
        bibtex_entry: binding.bibtex_entry,
        imported: entry.metadata.clone(),
        current: entry.metadata,
        library_item_id: Some(binding.literature_item_id),
        library_item,
        paths: vec!["references.bib".into()],
    }
}

pub fn decide(input: &EntryInput) -> EntryDecision {
    let result = match input {
        EntryInput::PrepareImported {
            manuscript_id,
            rows,
            support,
        } => prepare_imported(manuscript_id, rows.clone(), support)
            .map(|entries| EntryDecision::ImportedPrepared { entries }),
        EntryInput::FinishImported {
            entry,
            imported,
            paths,
            base_key,
            library_item,
        } => finish_imported(
            *entry.clone(),
            imported.clone(),
            paths.clone(),
            base_key.clone(),
            library_item.clone(),
        )
        .map(|entry| EntryDecision::Entry {
            entry: Box::new(entry),
        }),
        EntryInput::PrepareAutomatic {
            manuscript_id,
            binding,
            occupied_keys,
        } => prepare_automatic(manuscript_id, *binding.clone(), occupied_keys).map(|entry| {
            EntryDecision::AutomaticPrepared {
                entry: entry.map(Box::new),
            }
        }),
        EntryInput::FinishAutomatic {
            entry,
            base_key,
            library_item,
        } => Ok(EntryDecision::Entry {
            entry: Box::new(finish_automatic(
                *entry.clone(),
                base_key.clone(),
                library_item.clone(),
            )),
        }),
    };
    result.unwrap_or_else(|reason| EntryDecision::Rejected { reason })
}

#[cfg(test)]
mod tests;
