use super::*;
use research_workbench_native_sdk::writing_project::{Decision, Input};

#[test]
fn agent_file_policies_preserve_original_order_spelling_and_deferred_editability() {
    let paths: Vec<String> = [
        "main.tex",
        "sections/另一章.TeX",
        "figures/a.PNG",
        "style.bbx",
        "note.ranote",
        "raw.bin",
        "references.BIB",
        " other.bib ",
        "../outside",
        "aux",
        "main.tex",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    let input = Input::PrepareAgentFileChanges {
        relative_paths: paths.clone(),
    };
    let output = decide(input.clone()).unwrap();
    assert_eq!(output.input, input);
    let Decision::AgentFileChangesPrepared { policies } = output.decision else {
        panic!("Agent file policy result")
    };
    assert_eq!(policies.len(), paths.len());
    for (path, policy) in paths.iter().zip(&policies) {
        assert_eq!(&policy.relative_path, path);
        assert_eq!(policy.file_kind, file_kind(path));
        assert_eq!(policy.editable, require_editable_path(path).is_ok());
    }
    assert!(!policies[6].editable);
    assert!(!policies[7].editable);
    // Generic relative-path checks keep their original separate Core position.
    assert!(policies[8].editable);
    assert!(policies[9].editable);
    let wire = serde_json::to_value(output.input).unwrap();
    assert_eq!(wire["kind"], "prepareAgentFileChanges");
    assert_eq!(serde_json::from_value::<Input>(wire).unwrap(), input);
}
