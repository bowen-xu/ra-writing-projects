//! Pure compilation decisions. File, tool and process ownership stays in Core.
pub mod diagnostics;
pub mod synctex;

use research_workbench_native_sdk::writing_compile::{
    CompileOptions, CompileRun, Decision, EngineArgument, Flag, Input, LatexTool,
    LatexToolchainInfo, ProcessState, Rejection, RunStatus,
};

pub fn engine_argument(engine: &str) -> Result<EngineArgument, Rejection> {
    match engine {
        "pdflatex" => Ok(EngineArgument::Pdf),
        "xelatex" => Ok(EngineArgument::Xelatex),
        "lualatex" => Ok(EngineArgument::Lualatex),
        _ => Err(Rejection::InvalidEngine),
    }
}

pub fn transport_run(mut run: CompileRun) -> CompileRun {
    if run.status == "timed_out" {
        run.status = "timedOut".into();
    }
    run
}

pub fn flags(options: &CompileOptions) -> Vec<Flag> {
    let mut flags = vec![if options.stop_on_first_error {
        Flag::HaltOnError
    } else {
        Flag::Force
    }];
    if options.draft {
        flags.push(Flag::DraftGraphics);
    }
    if options.from_scratch {
        flags.push(Flag::FromScratch);
    }
    flags
}

pub fn toolchain_info(tools: Vec<LatexTool>, checked_at: String) -> LatexToolchainInfo {
    let available = |name: &str| tools.iter().any(|tool| tool.name == name && tool.available);
    let has_latexmk = available("latexmk");
    let supported_engines = ["pdflatex", "xelatex", "lualatex"]
        .into_iter()
        .filter(|name| has_latexmk && available(name))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    LatexToolchainInfo {
        available: !supported_engines.is_empty(),
        tools,
        supported_engines,
        checked_at,
    }
}

pub fn prepare(input: &Input) -> Result<Decision, Rejection> {
    Ok(match input {
        Input::ValidateForward {
            run_id,
            relative_path,
            line,
        } => {
            synctex::validate_forward(run_id.as_deref(), relative_path, *line)?;
            Decision::Accepted
        }
        Input::ValidateInverse {
            run_id,
            page,
            x_bits,
            y_bits,
        } => {
            synctex::validate_inverse(
                run_id.as_deref(),
                *page,
                f64::from_bits(*x_bits),
                f64::from_bits(*y_bits),
            )?;
            Decision::Accepted
        }
        Input::ForwardOutput { raw_output } => Decision::ForwardLocations {
            locations: synctex::parse_forward(raw_output)?
                .into_iter()
                .map(Into::into)
                .collect(),
        },
        Input::InverseCandidates { raw_output } => Decision::InverseCandidates {
            candidates: synctex::inverse_candidates(raw_output),
        },
        Input::InverseResolved {
            locations,
            invalid_input,
            generated_input,
        } => Decision::InverseLocations {
            locations: synctex::finish_inverse(
                locations.clone(),
                *invalid_input,
                *generated_input,
            )?,
        },
        Input::ValidateEngine { engine } => {
            engine_argument(engine)?;
            Decision::Accepted
        }
        Input::EngineArgument { engine } => Decision::EngineArgument {
            argument: engine_argument(engine)?,
        },
        Input::ValidateToolchain { engine, toolchain } => {
            if !toolchain.available || !toolchain.supported_engines.contains(engine) {
                return Err(Rejection::ToolchainUnavailable);
            }
            Decision::Accepted
        }
        Input::ProjectToolchain { tools, checked_at } => Decision::Toolchain {
            toolchain: toolchain_info(tools.clone(), checked_at.clone()),
        },
        Input::Flags { options } => Decision::Flags {
            flags: flags(options),
        },
        Input::Diagnostics { raw_output } => Decision::Diagnostics {
            items: diagnostics::parse(raw_output),
        },
        Input::ProjectRun { run } => Decision::Run {
            run: transport_run(run.clone()),
        },
        Input::Completion {
            state,
            successful,
            raw_output,
        } => {
            let completion = complete(*state, *successful, raw_output);
            Decision::Completion {
                status: completion.status,
                diagnostics: completion.diagnostics,
            }
        }
    })
}

pub fn complete(
    state: ProcessState,
    successful: bool,
    raw_output: &str,
) -> research_workbench_native_sdk::writing_compile::Completion {
    let status = match state {
        ProcessState::Cancelled => RunStatus::Cancelled,
        ProcessState::TimedOut => RunStatus::TimedOut,
        ProcessState::Completed if successful => RunStatus::Succeeded,
        ProcessState::Completed => RunStatus::Failed,
    };
    let mut parsed_diagnostics = diagnostics::parse(raw_output);
    if status == RunStatus::Failed
        && !parsed_diagnostics
            .iter()
            .any(|item| item.severity == "error")
    {
        parsed_diagnostics.push(
            research_workbench_native_sdk::writing_compile::CompileDiagnostic {
                severity: "error".to_owned(),
                message: "LaTeX 编译失败，请查看原始日志".to_owned(),
                file: None,
                line: None,
                column: None,
            },
        );
    }
    research_workbench_native_sdk::writing_compile::Completion {
        status,
        diagnostics: parsed_diagnostics,
    }
}

pub fn decide(input: &Input) -> Decision {
    prepare(input).unwrap_or_else(|reason| Decision::Rejected { reason })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finite_flags_keep_original_arguments_and_order_for_all_options() {
        for draft in [false, true] {
            for stop_on_first_error in [false, true] {
                for from_scratch in [false, true] {
                    let options = CompileOptions {
                        draft,
                        stop_on_first_error,
                        from_scratch,
                    };
                    let input = Input::Flags { options };
                    let encoded = serde_json::to_value(&input).unwrap();
                    let decoded: Input = serde_json::from_value(encoded).unwrap();
                    let Decision::Flags { flags } = decide(&decoded) else {
                        panic!("wrong compile decision");
                    };
                    let mut expected = vec![if stop_on_first_error {
                        "-halt-on-error"
                    } else {
                        "-f"
                    }];
                    if draft {
                        expected.push("-usepretex=\\PassOptionsToPackage{draft}{graphics}\\PassOptionsToPackage{draft}{graphicx}");
                    }
                    if from_scratch {
                        expected.push("-gg");
                    }
                    assert_eq!(
                        flags.into_iter().map(Flag::argument).collect::<Vec<_>>(),
                        expected
                    );
                }
            }
        }
    }

    #[test]
    fn engine_and_toolchain_rejections_keep_original_precedence() {
        for (engine, argument) in [
            ("pdflatex", "-pdf"),
            ("xelatex", "-xelatex"),
            ("lualatex", "-lualatex"),
        ] {
            assert_eq!(engine_argument(engine).unwrap().argument(), argument);
        }
        assert!(matches!(
            decide(&Input::ValidateEngine {
                engine: "arbitrary".into()
            }),
            Decision::Rejected {
                reason: Rejection::InvalidEngine
            }
        ));
        let tool = |name: &str| LatexTool {
            name: name.into(),
            available: true,
            path: None,
            version: None,
        };
        let missing_driver = toolchain_info(vec![tool("pdflatex")], "original".into());
        assert!(!missing_driver.available);
        let selected = toolchain_info(vec![tool("latexmk"), tool("pdflatex")], "frozen".into());
        assert_eq!(selected.supported_engines, ["pdflatex"]);
        assert_eq!(selected.checked_at, "frozen");
        assert!(matches!(
            decide(&Input::ValidateToolchain {
                engine: "xelatex".into(),
                toolchain: selected
            }),
            Decision::Rejected {
                reason: Rejection::ToolchainUnavailable
            }
        ));
    }
}
