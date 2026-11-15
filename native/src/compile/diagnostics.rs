use std::collections::HashSet;

use research_workbench_native_sdk::{
    resource_path::validate_relative_path, writing_compile::CompileDiagnostic,
};

pub fn parse(raw_output: &str) -> Vec<CompileDiagnostic> {
    let mut seen = HashSet::new();
    raw_output
        .lines()
        .filter_map(parse_line)
        .filter(|diagnostic| {
            seen.insert((
                diagnostic.severity.clone(),
                diagnostic.message.clone(),
                diagnostic.file.clone(),
                diagnostic.line,
            ))
        })
        .take(500)
        .collect()
}

fn parse_line(value: &str) -> Option<CompileDiagnostic> {
    let trimmed = value.trim();
    let first_separator = trimmed.find(':')?;
    let path_value = trimmed[..first_separator].trim().trim_start_matches("./");
    if validate_relative_path(path_value).is_err() {
        return None;
    }
    let remainder = &trimmed[first_separator + 1..];
    let second_separator = remainder.find(':')?;
    let line = remainder[..second_separator].trim().parse::<i64>().ok()?;
    let message = remainder[second_separator + 1..].trim();
    if message.is_empty() {
        return None;
    }
    let lowercase = message.to_ascii_lowercase();
    let severity = if lowercase.contains("warning") {
        "warning"
    } else if lowercase.contains("error")
        || lowercase.contains("undefined control sequence")
        || message.starts_with('!')
    {
        "error"
    } else {
        "info"
    };
    Some(CompileDiagnostic {
        severity: severity.to_owned(),
        message: message.chars().take(1000).collect(),
        file: Some(path_value.to_owned()),
        line: Some(line),
        column: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_file_line_diagnostics_without_inventing_locations() {
        let values = parse(
            "./main.tex:5: Undefined control sequence.\nLaTeX Warning: global warning\n/private/a.tex:2: hidden",
        );
        assert_eq!(values.len(), 1);
        assert_eq!(values[0].severity, "error");
        assert_eq!(values[0].file.as_deref(), Some("main.tex"));
        assert_eq!(values[0].line, Some(5));
    }
}
