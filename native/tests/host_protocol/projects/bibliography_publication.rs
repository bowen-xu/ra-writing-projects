use super::*;
use research_workbench_native_sdk::{
    writing_bibliography::{
        AutomaticProjection, PublicationFile, PublicationInput, SupplementalEntry,
    },
    writing_project::CitationBinding,
};
use research_writing_projects_native::bibliography::publication;

#[test]
fn actual_host_preserves_bibliography_publication_stages_and_exact_file_decisions() {
    let fixture = Fixture::new();
    let automatic = vec![("auto".into(), "@book{auto,title={Automatic}}".into())];
    let file = PublicationFile {
        path: "refs.bib".into(),
        target: "refs.bib".into(),
        support: "support".into(),
        entries: vec!["@book{local,title={Local}}".into()],
        supplemental_entries: vec![],
        supplemental_support: "".into(),
        automatic: None,
    };
    let mut ready = file.clone();
    ready.automatic = Some(AutomaticProjection {
        imported_keys: vec!["local".into()],
        retained_keys: vec!["local".into(), "auto".into()],
        bindings: vec![CitationBinding {
            manuscript_id: "M".into(),
            literature_item_id: "source".into(),
            citation_key: "auto".into(),
            bibtex_entry: "@book{auto,title={Automatic}}".into(),
            state: "active".into(),
            pinned_at: "pinned".into(),
            updated_at: "updated".into(),
        }],
    });
    let target = publication::content(&ready).unwrap().sha256;
    let inputs = vec![
        PublicationInput::Verify {
            expected: "".into(),
            actual_sha256: None,
        },
        PublicationInput::Verify {
            expected: "old".into(),
            actual_sha256: Some("external".into()),
        },
        PublicationInput::Supplemental {
            declared: vec!["declared.bib".into()],
            registered: vec!["extra.bib".into()],
            entries: vec![SupplementalEntry {
                bibtex_entry: "extra".into(),
                member_paths: vec!["extra.bib".into()],
            }],
        },
        PublicationInput::SourcePaths {
            files: vec![],
            root_path: "main.tex".into(),
        },
        PublicationInput::Declarations {
            source: "\\bibliography{refs}".into(),
            declared: vec![],
        },
        PublicationInput::Target {
            declared: vec!["refs.bib".into()],
            registered: vec![],
        },
        PublicationInput::Retention {
            sources: None,
            automatic: automatic.clone(),
            imported: vec![],
            preserve_imported: true,
        },
        PublicationInput::Retention {
            sources: Some(vec!["\\cite{auto}".into()]),
            automatic,
            imported: vec![],
            preserve_imported: true,
        },
        PublicationInput::Content {
            file: Box::new(file),
        },
        PublicationInput::Content {
            file: Box::new(ready),
        },
        PublicationInput::Compare {
            previous: "old".into(),
            target_sha256: target.clone(),
            actual_sha256: None,
        },
        PublicationInput::Compare {
            previous: "old".into(),
            target_sha256: target.clone(),
            actual_sha256: Some("old".into()),
        },
        PublicationInput::Compare {
            previous: "old".into(),
            target_sha256: target.clone(),
            actual_sha256: Some(target),
        },
        PublicationInput::Declarations {
            source: "\\bibliography{../unsafe}".into(),
            declared: vec![],
        },
    ];
    let staged = inputs
        .iter()
        .map(|input| Input::BibliographyPublication {
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
        let Decision::BibliographyPublication { decision } = result.decision else {
            panic!("publication stage");
        };
        assert_eq!(*decision, publication::decide(input));
    }
}
