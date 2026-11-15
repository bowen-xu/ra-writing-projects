use super::*;
use research_workbench_native_sdk::{
    writing_bibliography::AutomaticProjection, writing_project::CitationBinding,
};

fn binding(key: &str) -> CitationBinding {
    CitationBinding {
        manuscript_id: "M".into(),
        literature_item_id: key.into(),
        citation_key: key.into(),
        bibtex_entry: format!("@book{{{key},title={{Automatic}}}}"),
        state: "active".into(),
        pinned_at: "pinned".into(),
        updated_at: "updated".into(),
    }
}

#[test]
fn supplemental_preserves_orphans_skips_shared_declared_entries_and_reads_support_in_registered_order()
 {
    let rows = [
        SupplementalEntry {
            bibtex_entry: "shared".into(),
            member_paths: vec!["declared.bib".into(), "extra.bib".into()],
        },
        SupplementalEntry {
            bibtex_entry: "orphan".into(),
            member_paths: vec![],
        },
        SupplementalEntry {
            bibtex_entry: "extra".into(),
            member_paths: vec!["z.bib".into(), "a.bib".into()],
        },
    ];
    let result = supplemental(
        &["declared.bib".into()],
        &["a.bib".into(), "declared.bib".into(), "z.bib".into()],
        &rows,
    );
    assert_eq!(result.entries, ["orphan", "extra"]);
    assert_eq!(result.support_paths, ["a.bib", "z.bib"]);
}

#[test]
fn declarations_preserve_comment_escaping_case_target_order_and_invalid_path() {
    let declared = declarations("% \\bibliography{ignored}\n\\bibliography{z,a.BIB}\\addbibresource[opts]{nested/extra.bib}", vec![]).unwrap();
    assert_eq!(declared, ["a.BIB", "nested/extra.bib", "z.bib"]);
    assert_eq!(
        target(declared.clone(), &["z.bib".into(), "a.BIB".into()]).1,
        "z.bib"
    );
    assert_eq!(target(declared, &[]).1, "a.BIB");
    assert_eq!(
        target(
            vec!["references.bib".into(), "a.bib".into()],
            &["a.bib".into()]
        )
        .1,
        "references.bib"
    );
    assert_eq!(
        target(vec![], &[]),
        (vec!["references.bib".into()], "references.bib".into())
    );
    assert!(matches!(
        declarations("\\bibliography{../outside}", vec![]),
        Err(Error::InvalidPath)
    ));
    assert_eq!(
        declarations("\\% literal \\bibliography{kept}", vec![]).unwrap(),
        ["kept.bib"]
    );
}

#[test]
fn source_paths_keep_raw_tex_kind_root_and_deduplication() {
    let files = [
        ManuscriptFile {
            manuscript_id: "M".into(),
            relative_path: "main.tex".into(),
            kind: "tex".into(),
            size_bytes: -1,
            sha256: "raw".into(),
            modified_at: "time".into(),
        },
        ManuscriptFile {
            manuscript_id: "M".into(),
            relative_path: "other.tex".into(),
            kind: "other".into(),
            size_bytes: 1,
            sha256: "raw".into(),
            modified_at: "time".into(),
        },
    ];
    assert_eq!(source_paths(&files, "main.tex"), ["main.tex"]);
    let mut paths = source_paths(&files, "unindexed-root.tex");
    paths.sort();
    assert_eq!(paths, ["main.tex", "unindexed-root.tex"]);
}

#[test]
fn retention_requests_sources_only_at_the_original_usage_dependent_boundary() {
    let retained = decide(&PublicationInput::Retention {
        sources: Some(vec!["\\cite{unrecognized}".into()]),
        automatic: vec![],
        imported: vec![("imported".into(), "@book{imported,title={Keep}}".into())],
        preserve_imported: true,
    });
    assert_eq!(
        retained,
        PublicationDecision::Retained {
            keys: vec!["imported".into()]
        }
    );
    assert_eq!(
        decide(&PublicationInput::Retention {
            sources: None,
            automatic: vec![],
            imported: vec![],
            preserve_imported: false,
        }),
        PublicationDecision::NeedSources
    );
    assert_eq!(
        decide(&PublicationInput::Retention {
            sources: None,
            automatic: vec![("automatic".into(), "@book{automatic}".into())],
            imported: vec![],
            preserve_imported: true,
        }),
        PublicationDecision::NeedSources
    );
}

#[test]
fn publication_target_waits_for_automatic_rows_and_keeps_exact_original_bytes() {
    let mut file = PublicationFile {
        path: "references.bib".into(),
        target: "references.bib".into(),
        support: "  @string{j={Journal}}  ".into(),
        entries: vec!["@book{manual,title={Manual}}".into()],
        supplemental_entries: vec!["@book{extra,title={Extra}}".into()],
        supplemental_support: "@preamble{extra}".into(),
        automatic: None,
    };
    assert!(content(&file).is_none());
    file.automatic = Some(AutomaticProjection {
        imported_keys: vec!["manual".into()],
        retained_keys: vec!["manual".into(), "used".into()],
        bindings: vec![binding("manual"), binding("unused"), binding("used")],
    });
    let rendered = content(&file).unwrap();
    let expected = "% Managed by Research Assistant. Edit entries in the bibliography manager.\n@string{j={Journal}}  \n@preamble{extra}\n@book{manual,title={Manual}}\n\n@book{extra,title={Extra}}\n\n@book{used,title={Automatic}}\n";
    assert_eq!(rendered.content, expected);
    assert_eq!(
        rendered.sha256,
        format!("{:x}", Sha256::digest(expected.as_bytes()))
    );
    file.path = "other.bib".into();
    file.automatic = None;
    assert_eq!(
        content(&file).unwrap().content,
        "% Managed by Research Assistant. Edit entries in the bibliography manager.\n@string{j={Journal}}\n@book{manual,title={Manual}}\n"
    );
}

#[test]
fn file_comparison_keeps_idempotency_absence_and_exact_previous_hash_rules() {
    assert!(verify("", None));
    assert!(!verify("", Some("")));
    assert!(verify("old", Some("old")));
    assert!(!verify("old", None));
    assert!(!verify("old", Some("external")));
    assert_eq!(
        compare("stale", "target", Some("target")),
        FileComparison::Current
    );
    assert_eq!(
        compare("", "target", None),
        FileComparison::Write { expected: None }
    );
    assert_eq!(
        compare("old", "target", Some("old")),
        FileComparison::Write {
            expected: Some("old".into())
        }
    );
    assert_eq!(compare("old", "target", None), FileComparison::Conflict);
    assert_eq!(
        compare("", "target", Some("external")),
        FileComparison::Conflict
    );
    assert_eq!(
        compare("old", "target", Some("external")),
        FileComparison::Conflict
    );
}
