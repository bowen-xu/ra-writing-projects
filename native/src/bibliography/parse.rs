use super::Error as WritingError;
use biblatex::{Bibliography, ChunksExt, Entry, RawBibliography};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};

pub use research_workbench_native_sdk::writing_bibliography::adoption::{
    ImportedEntry, ImportedFile,
};

pub fn parse(
    files: &[(String, String)],
    occupied: &HashSet<String>,
) -> Result<Vec<ImportedFile>, WritingError> {
    parse_keys(files, occupied, KeyCase::Lowercase)
}

/// Legacy adoption must register the original identity before source/checkpoint migration.
pub fn parse_existing(
    files: &[(String, String)],
    occupied: &HashSet<String>,
) -> Result<Vec<ImportedFile>, WritingError> {
    parse_keys(files, occupied, KeyCase::Preserve)
}

enum KeyCase {
    Preserve,
    Lowercase,
}

fn parse_keys(
    files: &[(String, String)],
    occupied: &HashSet<String>,
    key_case: KeyCase,
) -> Result<Vec<ImportedFile>, WritingError> {
    let normalize = |key: &str| match key_case {
        KeyCase::Preserve => key.to_owned(),
        KeyCase::Lowercase => key.to_ascii_lowercase(),
    };
    let joined = files
        .iter()
        .map(|(_, text)| text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let parsed = Bibliography::parse(&joined)
        .map_err(|error| WritingError::BibliographyImport(error.to_string()))?;
    let mut keys = occupied
        .iter()
        .map(|key| normalize(key))
        .collect::<HashSet<_>>();
    let mut mapping = BTreeMap::new();
    // Reserve all valid imported identities before assigning normalized keys.
    for entry in parsed.iter() {
        let key = normalize(&entry.key);
        if valid_key(&entry.key) && !keys.contains(&key) {
            mapping.insert(entry.key.clone(), key.clone());
            keys.insert(key);
        }
    }
    for entry in parsed.iter() {
        if mapping.contains_key(&entry.key) {
            continue;
        }
        let base = if valid_key(&entry.key) {
            normalize(&entry.key)
        } else {
            format!(
                "reference{}",
                &format!("{:x}", Sha256::digest(entry.key.as_bytes()))[..12]
            )
        };
        let mut key = base.clone();
        let mut suffix = 2;
        while keys.contains(&key) {
            let serial = suffix.to_string();
            key = format!("{}{}", &base[..base.len().min(128 - serial.len())], serial);
            suffix += 1;
        }
        mapping.insert(entry.key.clone(), key.clone());
        keys.insert(key);
    }
    files
        .iter()
        .map(|(path, text)| {
            let raw = RawBibliography::parse(text)
                .map_err(|error| WritingError::BibliographyImport(error.to_string()))?;
            let mut support = text.clone();
            for entry in raw.entries.iter().rev() {
                support.replace_range(complete_span(text, &entry.span)?, "");
            }
            let entries = raw
                .entries
                .iter()
                .map(|raw| {
                    let old = raw.v.key.v;
                    let entry = parsed.get(old).ok_or(WritingError::InvalidBibtexEntry)?;
                    let original = text[complete_span(text, &raw.span)?].to_owned();
                    let key = mapping[old].clone();
                    let mut normalized = original.clone();
                    normalized.replace_range(
                        raw.v.key.span.start - raw.span.start..raw.v.key.span.end - raw.span.start,
                        &key,
                    );
                    // Rewrite entry-to-entry references while preserving all other raw fields.
                    let reparsed = RawBibliography::parse(&normalized)
                        .map_err(|_| WritingError::InvalidBibtexEntry)?;
                    let mut replacements = Vec::new();
                    for field in &reparsed.entries[0].v.fields {
                        if ["crossref", "xref", "xdata", "related", "entryset"]
                            .contains(&field.key.v.to_ascii_lowercase().as_str())
                        {
                            for chunk in &field.value.v {
                                if let biblatex::RawChunk::Normal(value) = chunk.v {
                                    let next = value
                                        .split(',')
                                        .map(|part| {
                                            mapping
                                                .get(part.trim())
                                                .cloned()
                                                .unwrap_or_else(|| part.trim().to_owned())
                                        })
                                        .collect::<Vec<_>>()
                                        .join(",");
                                    replacements.push((chunk.span.clone(), next));
                                }
                            }
                        }
                    }
                    for (span, value) in replacements.into_iter().rev() {
                        normalized.replace_range(span, &value);
                    }
                    let mut resolved = entry.clone();
                    resolved.key = key.clone();
                    for name in ["crossref", "xref", "xdata", "related", "entryset"] {
                        if resolved.get(name).is_some() {
                            let value = field(&resolved, name)
                                .split(',')
                                .map(|part| {
                                    mapping
                                        .get(part.trim())
                                        .cloned()
                                        .unwrap_or_else(|| part.trim().into())
                                })
                                .collect::<Vec<_>>()
                                .join(",");
                            set_scalar(&mut resolved, name, &value);
                        }
                    }
                    Ok(ImportedEntry {
                        key,
                        original_key: old.to_owned(),
                        original,
                        normalized,
                        metadata: metadata(&resolved),
                    })
                })
                .collect::<Result<Vec<_>, WritingError>>()?;
            Ok(ImportedFile {
                path: path.clone(),
                original: text.clone(),
                support,
                entries,
            })
        })
        .collect()
}

/// Upstream RawEntry spans end before the final delimiter (raw.rs::body).
/// Include that delimiter when preserving/removing a complete source entry.
pub fn complete_span(
    text: &str,
    span: &std::ops::Range<usize>,
) -> Result<std::ops::Range<usize>, WritingError> {
    let tail = &text[span.end..];
    let spaces = tail.len() - tail.trim_start().len();
    match tail.as_bytes().get(spaces) {
        Some(b'}' | b')') => Ok(span.start..span.end + spaces + 1),
        _ => Err(WritingError::InvalidBibtexEntry),
    }
}

pub fn valid_key(value: &str) -> bool {
    value.len() <= 128
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphabetic)
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_:+.-".contains(&b))
}
fn field(entry: &Entry, name: &str) -> String {
    entry
        .get(name)
        .map(|value| value.format_verbatim())
        .unwrap_or_default()
}
pub fn metadata(entry: &Entry) -> Value {
    let kind = match entry.entry_type.to_biblatex().to_string().as_str() {
        "article" => "journalArticle",
        "book" | "collection" => "book",
        "inbook" | "incollection" => "bookSection",
        "inproceedings" | "conference" => "conferencePaper",
        "thesis" | "phdthesis" | "mastersthesis" => "thesis",
        "report" | "techreport" => "report",
        "online" => "webpage",
        "software" => "computerProgram",
        "dataset" => "dataset",
        _ => "document",
    };
    let mut creators = Vec::new();
    for (field, role) in [
        ("author", "author"),
        ("editor", "editor"),
        ("translator", "translator"),
    ] {
        if let Ok(persons) = entry.get_as::<Vec<biblatex::Person>>(field) {
            creators.extend(persons.iter().map(|person|json!({"familyName":person.name,"givenName":person.given_name,"literalName":"","role":role})));
        }
    }
    let year = field(entry, "year")
        .parse::<i32>()
        .ok()
        .or_else(|| field(entry, "date").get(..4).and_then(|v| v.parse().ok()));
    json!({ "itemType": kind, "title": field(entry, "title"), "abstractText": field(entry, "abstract"),
        "issuedYear": year, "containerTitle": if field(entry, "journaltitle").is_empty() { field(entry, "journal") } else {field(entry, "journaltitle")},
        "conferenceName":field(entry,"eventtitle"),"proceedingsTitle":field(entry,"booktitle"),"place":field(entry,"address"),
        "volume": field(entry, "volume"), "issue": field(entry, "number"), "pages": field(entry, "pages"),
        "doi": field(entry, "doi"), "url": field(entry, "url"), "language": field(entry, "language"),
        "bibtexKey": entry.key, "rawBibtex": entry.to_biblatex_string(), "creators": creators, "tags": [], "sourceKind": "bibtex" })
}

fn set_scalar(entry: &mut Entry, name: &str, value: &str) {
    // String::to_chunks creates a protected group. Numeric identifiers and name
    // list separators must remain normal chunks, not one literal organization.
    entry.set(
        name,
        vec![biblatex::Spanned::zero(biblatex::Chunk::Normal(
            value.into(),
        ))],
    );
}

pub fn from_library(imported: &str, key: &str, item: &Value) -> Result<String, WritingError> {
    let mut parsed = Bibliography::parse(imported).map_err(|_| WritingError::InvalidBibtexEntry)?;
    let entry = parsed
        .iter_mut()
        .next()
        .ok_or(WritingError::InvalidBibtexEntry)?;
    entry.key = key.to_owned();
    let kind = match item["itemType"].as_str().unwrap_or_default() {
        "journalArticle" | "magazineArticle" | "newspaperArticle" => Some("article"),
        "book" => Some("book"),
        "bookSection" => Some("incollection"),
        "conferencePaper" => Some("inproceedings"),
        "thesis" => Some("phdthesis"),
        "report" => Some("techreport"),
        "webpage" => Some("online"),
        "computerProgram" => Some("software"),
        "dataset" => Some("dataset"),
        "document" | "manuscript" | "preprint" => Some("misc"),
        _ => None,
    };
    if let Some(kind) = kind {
        entry.entry_type = kind.parse().map_err(|_| WritingError::InvalidBibtexEntry)?;
    }
    if item.get("containerTitle").is_some() {
        entry.remove("journaltitle");
    }
    if item.get("issuedYear").is_some() {
        entry.remove("date");
    }
    for (field, property) in [
        ("title", "title"),
        ("abstract", "abstractText"),
        ("journal", "containerTitle"),
        ("eventtitle", "conferenceName"),
        ("booktitle", "proceedingsTitle"),
        ("address", "place"),
        ("volume", "volume"),
        ("number", "issue"),
        ("pages", "pages"),
        ("doi", "doi"),
        ("url", "url"),
        ("language", "language"),
    ] {
        if let Some(value) = item[property].as_str() {
            if value.is_empty() {
                entry.remove(field);
            } else {
                if field == "title" {
                    entry.set_as(field, &value.to_owned());
                } else {
                    set_scalar(entry, field, value);
                }
            }
        }
    }
    if let Some(year) = item.get("issuedYear") {
        if let Some(year) = year.as_i64() {
            set_scalar(entry, "year", &year.to_string());
        } else {
            entry.remove("year");
        }
    }
    if let Some(creators) = item["creators"].as_array() {
        for (field, role) in [
            ("author", "author"),
            ("editor", "editor"),
            ("translator", "translator"),
        ] {
            let mut names = Vec::new();
            for person in creators.iter().filter(|person| person["role"] == role) {
                if !names.is_empty() {
                    names.push(biblatex::Spanned::zero(biblatex::Chunk::Normal(
                        " and ".into(),
                    )));
                }
                let chunk = if let Some(literal) = person["literalName"]
                    .as_str()
                    .filter(|value| !value.is_empty())
                {
                    biblatex::Chunk::Verbatim(literal.into())
                } else {
                    biblatex::Chunk::Normal(format!(
                        "{}, {}",
                        person["familyName"].as_str().unwrap_or_default(),
                        person["givenName"].as_str().unwrap_or_default()
                    ))
                };
                names.push(biblatex::Spanned::zero(chunk));
            }
            if names.is_empty() {
                entry.remove(field);
            } else {
                entry.set(field, names);
            }
        }
    }
    entry
        .to_bibtex_string()
        .map_err(|error| WritingError::BibliographyImport(error.to_string()))
}

pub fn rewrite_citations(
    source: &str,
    mapping: &BTreeMap<String, String>,
) -> Result<String, WritingError> {
    let regex = regex::Regex::new(
        r"\\(?:[A-Za-z]*cite[A-Za-z]*|nocite)\*?(?:\s*\[[^\]]*\])*\s*\{([^{}]*)\}",
    )
    .map_err(|_| WritingError::InvalidBibtexEntry)?;
    let mut next = source.to_owned();
    for capture in regex
        .captures_iter(source)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
    {
        let whole = capture.get(0).ok_or(WritingError::InvalidBibtexEntry)?;
        let line = source[..whole.start()]
            .rsplit('\n')
            .next()
            .unwrap_or_default();
        if comment_start(line).is_some() {
            continue;
        }
        let keys = capture.get(1).ok_or(WritingError::InvalidBibtexEntry)?;
        let value = keys
            .as_str()
            .split(',')
            .map(|key| {
                mapping
                    .get(key.trim())
                    .cloned()
                    .unwrap_or_else(|| key.trim().to_owned())
            })
            .collect::<Vec<_>>()
            .join(",");
        next.replace_range(keys.range(), &value);
    }
    // Unknown citation macros cannot be safely guessed. Do not publish a project
    // with references that a key rename would strand.
    let commands = regex::Regex::new(r"\\[A-Za-z@]+\*?(?:\s*\[[^\]]*\])*\s*\{([^{}]*)\}")
        .map_err(|_| WritingError::InvalidBibtexEntry)?;
    let without_comments = next
        .lines()
        .map(|line| &line[..comment_start(line).unwrap_or(line.len())])
        .collect::<Vec<_>>()
        .join("\n");
    if commands.captures_iter(&without_comments).any(|capture| {
        capture.get(1).is_some_and(|keys| {
            keys.as_str()
                .split(',')
                .any(|key| mapping.contains_key(key.trim()))
        })
    }) {
        return Err(WritingError::BibliographyImport(
            "引用键迁移涉及无法识别的命令，原项目未修改".into(),
        ));
    }
    Ok(next)
}

pub fn uncomment(line: &str) -> &str {
    &line[..comment_start(line).unwrap_or(line.len())]
}

fn comment_start(line: &str) -> Option<usize> {
    let bytes = line.as_bytes();
    bytes.iter().enumerate().find_map(|(index, b)| {
        if *b != b'%' {
            return None;
        }
        let escapes = bytes[..index]
            .iter()
            .rev()
            .take_while(|b| **b == b'\\')
            .count();
        (escapes % 2 == 0).then_some(index)
    })
}

#[cfg(test)]
#[path = "parse_tests.rs"]
mod tests;
