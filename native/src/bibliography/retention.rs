//! Original bibliography retention, evaluated over owned source text and entries.
use super::{Error as WritingError, parse as managed_bib_parse};
use regex::Regex;
use std::collections::HashSet;
pub fn retain(
    sources: &[String],
    automatic: &[(String, String)],
    imported: &[(String, String)],
    preserve_imported: bool,
) -> Result<HashSet<String>, WritingError> {
    let known = imported.iter().chain(automatic).collect::<Vec<_>>();
    let known_keys = known
        .iter()
        .map(|row| row.0.as_str())
        .collect::<HashSet<_>>();
    let mut retained = imported
        .iter()
        .filter(|_| preserve_imported)
        .map(|row| row.0.clone())
        .collect::<HashSet<_>>();
    let cite =
        Regex::new(r"\\(?:[A-Za-z]*cite[A-Za-z]*|nocite)\*?\s*(?:\[[^\]]*\]\s*)*\{([^}]*)\}")
            .map_err(|_| WritingError::InvalidBibtexEntry)?;
    let argument = Regex::new(r"\{([^{}]*)\}").map_err(|_| WritingError::InvalidBibtexEntry)?;
    for source in sources {
        let text = source
            .lines()
            .map(managed_bib_parse::uncomment)
            .collect::<Vec<_>>()
            .join("\n");
        // Retain keys in extra multi-cite arguments and user macros rather than
        // incorrectly pruning a citation our standard scanner cannot classify.
        for capture in argument.captures_iter(&text) {
            for key in capture[1]
                .split(',')
                .map(str::trim)
                .filter(|key| known_keys.contains(key))
            {
                retained.insert(key.to_owned());
            }
        }
        for capture in cite.captures_iter(&text) {
            for key in capture[1]
                .split(',')
                .map(str::trim)
                .filter(|key| !key.is_empty())
            {
                if key == "*" {
                    return Ok(known.iter().map(|row| row.0.clone()).collect());
                }
                retained.insert(key.to_owned());
            }
        }
    }
    let relation = Regex::new(
        r#"(?i)\b(?:crossref|xref|xdata|entryset|related)\s*=\s*(\{[^{}]*\}|"[^"]*"|[^,\r\n}]+)"#,
    )
    .map_err(|_| WritingError::InvalidBibtexEntry)?;
    let mut changed = true;
    while changed {
        changed = false;
        for row in &known {
            if !retained.contains(&row.0) {
                continue;
            }
            for capture in relation.captures_iter(&row.1) {
                let value = capture[1].trim();
                let literal = value
                    .strip_prefix('{')
                    .and_then(|text| text.strip_suffix('}'))
                    .or_else(|| {
                        value
                            .strip_prefix('"')
                            .and_then(|text| text.strip_suffix('"'))
                    });
                let Some(literal) = literal else {
                    // An imported macro/custom relation is ambiguous: preserve
                    // every cached entry instead of pruning a possible parent.
                    return Ok(known.iter().map(|row| row.0.clone()).collect());
                };
                for key in literal
                    .split(',')
                    .map(str::trim)
                    .filter(|key| !key.is_empty())
                {
                    changed |= retained.insert(key.to_owned());
                }
            }
        }
    }
    Ok(retained)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imports_are_roots_and_automatic_entries_follow_all_sources_and_relations() {
        let automatic = ["used", "unused", "parent", "extra"].map(|key| {
            (
                key.to_owned(),
                format!("@book{{{key},title={{Synthetic}}}}"),
            )
        });
        let imported = vec![(
            "local".into(),
            "@book{local,crossref={parent},xdata={extra}}".into(),
        )];
        let retained = retain(
            &["% \\cite{unused}".into(), "\\textcite*[see]{used}".into()],
            &automatic,
            &imported,
            true,
        )
        .unwrap();
        assert_eq!(
            retained,
            ["used", "parent", "extra", "local"]
                .map(str::to_owned)
                .into()
        );
        assert_eq!(
            retain(&["\\nocite{*}".into()], &automatic, &imported, true)
                .unwrap()
                .len(),
            5
        );
        assert_eq!(retain(&[], &automatic, &[], true).unwrap().len(), 0);
        assert!(
            retain(&[], &automatic, &imported, false)
                .unwrap()
                .is_empty()
        );
    }
}
