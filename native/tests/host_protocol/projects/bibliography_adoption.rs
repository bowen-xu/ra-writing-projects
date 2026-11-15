use super::*;
use research_workbench_native_sdk::{
    writing_bibliography::adoption::{AdoptionInput, GeneratedHash},
    writing_project::ManuscriptFile,
};
use research_writing_projects_native::bibliography::adoption;
use serde_json::{Value, json};
use std::collections::HashSet;

#[test]
fn actual_host_preserves_lazy_adoption_keys_migration_library_and_publication_decisions() {
    let fixture = Fixture::new();
    let file = ManuscriptFile {
        manuscript_id: "M".into(),
        relative_path: "references.bib".into(),
        kind: "bib".into(),
        size_bytes: 1,
        sha256: "recorded".into(),
        modified_at: "modified".into(),
    };
    let physical = vec![(
        "references.bib".into(),
        "@book{MixedKey,title={Physical},custom={Keep}}".into(),
    )];
    let fresh = adoption::parse_imported(&physical, Some(&[]), &HashSet::new()).unwrap();
    let entry = fresh[0].entries[0].clone();
    let source = ManuscriptFile {
        relative_path: "main.tex".into(),
        kind: "tex".into(),
        ..file.clone()
    };
    let inputs = vec![
        AdoptionInput::SelectFile {
            file: Box::new(file.clone()),
            known: false,
            generated: GeneratedHash::Unqueried,
        },
        AdoptionInput::SelectFile {
            file: Box::new(file.clone()),
            known: false,
            generated: GeneratedHash::Ready {
                value: Some("recorded".into()),
            },
        },
        AdoptionInput::SelectFile {
            file: Box::new(file),
            known: true,
            generated: GeneratedHash::Unqueried,
        },
        AdoptionInput::Parse {
            physical_files: physical.clone(),
            originals: None,
            occupied: vec![],
        },
        AdoptionInput::Parse {
            physical_files: physical,
            originals: Some(vec![]),
            occupied: vec![],
        },
        AdoptionInput::ValidateEntry {
            entry: Box::new(entry.clone()),
            path: "references.bib".into(),
            originals: None,
            files: vec![source],
        },
        AdoptionInput::MatchLibrary {
            normalized_doi: "doi".into(),
            draft: Value::Null,
            exact_doi: true,
            candidates: vec![json!({"id":"one"})],
        },
        AdoptionInput::CanonicalEntry {
            entry: Box::new(entry),
            library: Some(json!({"title":"Live"})),
        },
        AdoptionInput::Publication {
            always: true,
            proof_current: None,
        },
        AdoptionInput::Publication {
            always: false,
            proof_current: None,
        },
        AdoptionInput::Publication {
            always: false,
            proof_current: Some(true),
        },
    ];
    let staged = inputs
        .iter()
        .map(|input| Input::BibliographyAdoption {
            input: Box::new(input.clone()),
        })
        .collect::<Vec<_>>();
    let mut requests = vec![request(RequestBody::Initialize {})];
    requests.extend(staged.iter().map(|input| stage(&fixture, input)));
    requests.push(request(RequestBody::Shutdown {}));
    let output = execute(&fixture, &requests);
    assert!(output.status.success(), "{:?}", output);
    let replies = responses(&output, &requests);
    for (index, input) in inputs.iter().enumerate() {
        let result = project_result(&fixture, &replies[index + 1]);
        assert_eq!(result.input, staged[index]);
        let Decision::BibliographyAdoption { decision } = result.decision else {
            panic!("adoption phase");
        };
        assert_eq!(*decision, adoption::decide(input));
    }
}
