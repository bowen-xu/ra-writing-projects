//! Original SyncTeX lexical rules without filesystem or process authority.
use research_workbench_native_sdk::writing_compile::{
    Rejection, SynctexPdfLocation, SynctexSourceLocation,
    synctex::{InverseCandidate, InverseCandidates},
};
use std::path::Path;

pub fn validate_forward(
    run_id: Option<&str>,
    relative_path: &str,
    line: u32,
) -> Result<(), Rejection> {
    if line == 0 || run_id.is_some_and(|id| uuid::Uuid::parse_str(id).is_err()) {
        return Err(Rejection::InvalidPath);
    }
    research_workbench_native_sdk::resource_path::validate_relative_path(relative_path)
        .map_err(|_| Rejection::InvalidPath)?;
    Ok(())
}

pub fn validate_inverse(run_id: Option<&str>, page: u32, x: f64, y: f64) -> Result<(), Rejection> {
    if page == 0
        || !x.is_finite()
        || !y.is_finite()
        || x < 0.0
        || y < 0.0
        || run_id.is_some_and(|id| uuid::Uuid::parse_str(id).is_err())
    {
        return Err(Rejection::InvalidPath);
    }
    Ok(())
}

pub fn parse_forward(output: &str) -> Result<Vec<SynctexPdfLocation>, Rejection> {
    let mut locations = Vec::new();
    let mut page = None;
    let mut x = None;
    let mut y = None;
    let mut width = 0.0;
    let mut height = 0.0;
    for line in output.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        match key.trim() {
            "Page" => {
                push_pdf_location(&mut locations, &mut page, &mut x, &mut y, width, height);
                page = value.trim().parse().ok();
                width = 0.0;
                height = 0.0;
            }
            "x" => x = value.trim().parse().ok(),
            "y" => y = value.trim().parse().ok(),
            "W" => width = value.trim().parse().unwrap_or(0.0),
            "H" => height = value.trim().parse().unwrap_or(0.0),
            _ => {}
        }
    }
    push_pdf_location(&mut locations, &mut page, &mut x, &mut y, width, height);
    if locations.is_empty() {
        Err(Rejection::SynctexNoResult)
    } else {
        Ok(locations)
    }
}

fn push_pdf_location(
    locations: &mut Vec<SynctexPdfLocation>,
    page: &mut Option<u32>,
    x: &mut Option<f64>,
    y: &mut Option<f64>,
    width: f64,
    height: f64,
) {
    if let (Some(page), Some(x), Some(y)) = (page.take(), x.take(), y.take()) {
        locations.push(SynctexPdfLocation {
            page,
            x,
            y,
            width,
            height,
        });
    }
}

fn is_generated_input(input: Option<&str>) -> bool {
    let Some(input) = input else {
        return false;
    };
    matches!(
        Path::new(input)
            .extension()
            .and_then(|extension| extension.to_str()),
        Some("aux" | "bbl" | "bcf" | "blg" | "fdb_latexmk" | "fls" | "log" | "out" | "toc")
    )
}

pub fn inverse_candidates(output: &str) -> InverseCandidates {
    let mut items = Vec::new();
    let mut generated_input = false;
    let mut input: Option<String> = None;
    let mut line_number = None;
    let mut column = None;
    for line in output.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        match key.trim() {
            "Input" => {
                generated_input |= is_generated_input(input.as_deref());
                if let (Some(input), Some(line)) = (input.take(), line_number.take()) {
                    items.push(InverseCandidate {
                        input,
                        line,
                        column: column.take(),
                    });
                } else {
                    column = None;
                }
                input = Some(value.trim().to_owned());
            }
            "Line" => line_number = value.trim().parse().ok(),
            "Column" => column = value.trim().parse().ok(),
            _ => {}
        }
    }
    generated_input |= is_generated_input(input.as_deref());
    if let (Some(input), Some(line)) = (input, line_number) {
        items.push(InverseCandidate {
            input,
            line,
            column,
        });
    }
    InverseCandidates {
        items,
        generated_input,
    }
}

pub fn finish_inverse(
    locations: Vec<SynctexSourceLocation>,
    invalid_input: bool,
    generated_input: bool,
) -> Result<Vec<SynctexSourceLocation>, Rejection> {
    if locations.is_empty() {
        if invalid_input && !generated_input {
            Err(Rejection::InvalidPath)
        } else {
            Err(Rejection::SynctexNoResult)
        }
    } else {
        Ok(locations)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use research_workbench_native_sdk::writing_compile::{Decision, Input};

    #[test]
    fn forward_wire_preserves_original_nonfinite_and_signed_zero_values() {
        let output = "Page:2\nx:NaN\ny:-0\nW:inf\nH:-inf\n";
        let decision = crate::compile::decide(&Input::ForwardOutput {
            raw_output: output.into(),
        });
        let decoded: Decision =
            serde_json::from_slice(&serde_json::to_vec(&decision).unwrap()).unwrap();
        let Decision::ForwardLocations { locations } = decoded else {
            panic!("expected locations");
        };
        let location: SynctexPdfLocation = locations.into_iter().next().unwrap().into();
        assert!(location.x.is_nan());
        assert_eq!(location.y.to_bits(), (-0.0_f64).to_bits());
        assert_eq!(location.width, f64::INFINITY);
        assert_eq!(location.height, f64::NEG_INFINITY);
        for x in [f64::NAN, f64::INFINITY, -1.0] {
            let input = Input::ValidateInverse {
                run_id: None,
                page: 1,
                x_bits: x.to_bits(),
                y_bits: 0_f64.to_bits(),
            };
            let decoded: Input =
                serde_json::from_slice(&serde_json::to_vec(&input).unwrap()).unwrap();
            assert!(matches!(
                crate::compile::decide(&decoded),
                Decision::Rejected {
                    reason: Rejection::InvalidPath
                }
            ));
        }
    }

    #[test]
    fn inverse_candidates_keep_order_missing_fields_and_generated_error_precedence() {
        let candidates = inverse_candidates(
            "Input:main.bbl\nInput:missing.tex\nColumn:9\nInput:sections/a.tex\nLine:0\nColumn:0\nInput:sections/b.tex\nLine:7\nColumn:3\n",
        );
        assert!(candidates.generated_input);
        assert_eq!(
            candidates.items,
            vec![
                InverseCandidate {
                    input: "sections/a.tex".into(),
                    line: 0,
                    column: Some(0)
                },
                InverseCandidate {
                    input: "sections/b.tex".into(),
                    line: 7,
                    column: Some(3)
                },
            ]
        );
        assert_eq!(
            finish_inverse(vec![], true, true),
            Err(Rejection::SynctexNoResult)
        );
        assert_eq!(
            finish_inverse(vec![], true, false),
            Err(Rejection::InvalidPath)
        );
        assert_eq!(
            finish_inverse(vec![], false, false),
            Err(Rejection::SynctexNoResult)
        );
    }
}
