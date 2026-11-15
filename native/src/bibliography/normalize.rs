//! Original Citation.js single-entry normalization and binding-key policy.
use super::{Error, parse};

pub fn single_entry(entry: &str, key: &str) -> Result<String, Error> {
    if entry.len() > 256 * 1024 || !valid_key(key) {
        return Err(Error::InvalidBibtexEntry);
    }
    let trimmed = entry.trim();
    if !trimmed.starts_with('@') {
        return Err(Error::InvalidBibtexEntry);
    }
    let raw = biblatex::RawBibliography::parse(trimmed).map_err(|_| Error::InvalidBibtexEntry)?;
    if raw.entries.len() != 1
        || parse::complete_span(trimmed, &raw.entries[0].span)?.end != trimmed.len()
    {
        return Err(Error::InvalidBibtexEntry);
    }
    let range = raw.entries[0].v.key.span.clone();
    let mut result = trimmed.to_owned();
    result.replace_range(range, key);
    Ok(result)
}

pub use super::parse::valid_key;
