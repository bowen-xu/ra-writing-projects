//! Original import eligibility over metadata, with bytes retained by Core.
use research_workbench_native_sdk::writing_note_asset::{
    Decision, ImportInput, MAX_BYTES, Rejection,
};

pub fn validate_import(input: &ImportInput) -> Result<(), Rejection> {
    if input.byte_size > MAX_BYTES as u64 {
        return Err(Rejection::TooLarge);
    }
    if input.display_name.is_empty()
        || input.display_name.len() > 1024
        || input.display_name.contains(['/', '\\', '\0'])
    {
        return Err(Rejection::InvalidPath);
    }
    if !matches!(
        input.mime_type.as_str(),
        "image/png"
            | "image/jpeg"
            | "image/gif"
            | "image/webp"
            | "application/pdf"
            | "text/plain"
            | "application/octet-stream"
    ) {
        return Err(Rejection::InvalidManuscript);
    }
    Ok(())
}

pub fn decide(input: &ImportInput) -> Decision {
    match validate_import(input) {
        Ok(()) => Decision::Validated,
        Err(reason) => Decision::Rejected { reason },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keeps_size_name_and_exact_mime_error_order() {
        let mut input = ImportInput {
            display_name: "../escape".into(),
            mime_type: "image/svg+xml".into(),
            byte_size: MAX_BYTES as u64 + 1,
        };
        assert_eq!(validate_import(&input), Err(Rejection::TooLarge));
        input.byte_size = MAX_BYTES as u64;
        assert_eq!(validate_import(&input), Err(Rejection::InvalidPath));
        input.display_name = "a".into();
        assert_eq!(validate_import(&input), Err(Rejection::InvalidManuscript));
        input.mime_type = "image/jpeg".into();
        assert_eq!(validate_import(&input), Ok(()));
        input.display_name = "字".repeat(342);
        assert_eq!(validate_import(&input), Err(Rejection::InvalidPath));
        input.display_name = " ".into();
        assert_eq!(validate_import(&input), Ok(()));
    }
}
