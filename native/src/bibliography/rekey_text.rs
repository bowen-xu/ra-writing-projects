//! Exact citation-argument edits. Offsets are UTF-8 byte ranges, never text matches.
use super::Error as WritingError;
use std::collections::BTreeMap;

pub fn rewrite(source: &str, mapping: &BTreeMap<String, String>) -> String {
    let bytes = source.as_bytes();
    let mut offset = 0;
    let mut edits = Vec::new();
    while offset < bytes.len() {
        if bytes[offset] == b'%' {
            offset = source[offset..]
                .find('\n')
                .map_or(bytes.len(), |n| offset + n);
            continue;
        }
        if bytes[offset] != b'\\' {
            offset += 1;
            continue;
        }
        offset += 1;
        let start = offset;
        while offset < bytes.len() && bytes[offset].is_ascii_alphabetic() {
            offset += 1;
        }
        if start == offset {
            offset = (offset + 1).min(bytes.len());
            continue;
        }
        let command = &source[start..offset];
        if bytes.get(offset) == Some(&b'*') {
            offset += 1;
        }
        if command == "verb" {
            if let Some(delimiter) = bytes.get(offset) {
                offset = bytes[offset + 1..]
                    .iter()
                    .position(|b| b == delimiter || *b == b'\n')
                    .map_or(bytes.len(), |n| offset + n + 2);
            }
            continue;
        }
        while bytes.get(offset).is_some_and(u8::is_ascii_whitespace) {
            offset += 1;
        }
        if command == "begin" && bytes.get(offset) == Some(&b'{') {
            if let Some(end) = source[offset..].find('}') {
                let env = &source[offset + 1..offset + end];
                if ["verbatim", "verbatim*", "Verbatim", "lstlisting", "minted"].contains(&env) {
                    let close = format!("\\end{{{env}}}");
                    offset = source[offset + end + 1..]
                        .find(&close)
                        .map_or(bytes.len(), |n| offset + end + 1 + n + close.len());
                }
            }
            continue;
        }
        if !command.contains("cite") {
            continue;
        }
        while bytes.get(offset) == Some(&b'[') {
            let Some(end) = source[offset..].find(']') else {
                break;
            };
            offset += end + 1;
            while bytes.get(offset).is_some_and(u8::is_ascii_whitespace) {
                offset += 1;
            }
        }
        if bytes.get(offset) != Some(&b'{') {
            continue;
        }
        offset += 1;
        loop {
            while bytes.get(offset).is_some_and(u8::is_ascii_whitespace) {
                offset += 1;
            }
            let from = offset;
            while let Some(b) = bytes.get(offset) {
                if b.is_ascii_whitespace() || b",{}\\%".contains(b) {
                    break;
                }
                offset += 1;
            }
            if from == offset {
                break;
            }
            if let Some(next) = mapping.get(&source[from..offset]) {
                edits.push((from..offset, next));
            }
            while bytes.get(offset).is_some_and(u8::is_ascii_whitespace) {
                offset += 1;
            }
            if bytes.get(offset) != Some(&b',') {
                break;
            }
            offset += 1;
        }
    }
    let mut result = source.to_owned();
    for (span, next) in edits.into_iter().rev() {
        result.replace_range(span, next);
    }
    result
}

pub fn bibliography(
    source: &str,
    mapping: &BTreeMap<String, String>,
) -> Result<String, WritingError> {
    let parsed =
        biblatex::RawBibliography::parse(source).map_err(|_| WritingError::InvalidBibtexEntry)?;
    let mut edits = Vec::new();
    for entry in parsed.entries {
        if let Some(key) = mapping.get(entry.v.key.v) {
            edits.push((entry.v.key.span, key.clone()));
        }
        for field in entry.v.fields {
            if !["crossref", "xref", "xdata", "entryset", "related"]
                .contains(&field.key.v.to_ascii_lowercase().as_str())
            {
                continue;
            }
            for chunk in field.value.v {
                if let biblatex::RawChunk::Normal(value) = chunk.v {
                    let next = value
                        .split(',')
                        .map(|key| mapping.get(key.trim()).map_or(key.trim(), String::as_str))
                        .collect::<Vec<_>>()
                        .join(",");
                    edits.push((chunk.span, next));
                }
            }
        }
    }
    edits.sort_by_key(|(span, _)| span.start);
    let mut result = source.to_owned();
    for (span, text) in edits.into_iter().rev() {
        result.replace_range(span, &text);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rewrites_only_keys_in_real_citation_arguments() {
        let mapping = BTreeMap::from([("xu2026vision".into(), "xu2026vision:a".into())]);
        let source = "标题 \\citep*[see]{ xu2026vision, other }\n% \\cite{xu2026vision}\n\\verb|\\cite{xu2026vision}|\n\\begin{verbatim}\n\\cite{xu2026vision}\n\\end{verbatim}\n\\cite{xu2026vision";
        let output = rewrite(source, &mapping);
        assert_eq!(output.matches("xu2026vision:a").count(), 2);
        assert!(output.contains("{ xu2026vision:a, other }"));
        assert!(output.contains("% \\cite{xu2026vision}"));
    }
}
