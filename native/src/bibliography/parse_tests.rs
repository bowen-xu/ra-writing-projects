use super::*;
#[test]
fn lowercases_imports_and_relations_but_adopts_legacy_spelling_before_migration() {
    let files = vec![(
        "refs.bib".into(),
        "@book{Xu2026Vision,title={Vision}}\n@book{Child,title={Child},crossref={Xu2026Vision}}"
            .into(),
    )];
    let imported = parse(&files, &HashSet::new()).expect("import");
    assert_eq!(imported[0].entries[0].key, "xu2026vision");
    assert_eq!(imported[0].entries[0].original_key, "Xu2026Vision");
    assert!(imported[0].entries[1].normalized.contains("xu2026vision"));
    let legacy = parse_existing(&files, &HashSet::new()).expect("legacy adoption");
    assert_eq!(legacy[0].entries[0].key, "Xu2026Vision");
    let occupied = HashSet::from(["XU2026VISION".into()]);
    assert_eq!(
        parse(&files, &occupied).expect("collision")[0].entries[0].key,
        "xu2026vision2"
    );
}

#[test]
fn normalizes_illegal_keys_and_preserves_macro_and_unknown_fields() {
    let files = vec![(
        "refs.bib".into(),
        "@string{j={Journal}}\n@article{2026,title={A {nested} title},journal=j,unknown={Keep}}"
            .into(),
    )];
    let parsed = parse(&files, &HashSet::new()).expect("parse");
    let entry = &parsed[0].entries[0];
    assert!(valid_key(&entry.key));
    assert_ne!(entry.key, "2026");
    assert!(entry.normalized.contains("unknown={Keep}"));
    assert!(parsed[0].support.contains("@string"));
    assert_eq!(entry.metadata["containerTitle"], "Journal");
    let mapping = BTreeMap::from([("2026".into(), entry.key.clone())]);
    assert_eq!(
        rewrite_citations("\\citep*[see][p. 2]{2026}", &mapping).expect("migrate"),
        format!("\\citep*[see][p. 2]{{{}}}", entry.key)
    );
}
#[test]
fn rejects_ambiguous_duplicates_and_unrecognized_citation_commands() {
    assert!(
        parse(
            &[(
                "refs.bib".into(),
                "@book{a,title={One}}\n@book{a,title={Two}}".into()
            )],
            &HashSet::new()
        )
        .is_err()
    );
    assert!(
        rewrite_citations(
            "\\customref{2026}",
            &BTreeMap::from([("2026".into(), "safeKey".into())])
        )
        .is_err()
    );
}
#[test]
fn library_projection_remains_compatible_with_bibtex() {
    let item = json!({"title":"Library","issuedYear":2026,"containerTitle":"Library Journal","creators":[]});
    let text = from_library(
        "@article{old,title={Import},journaltitle={Old},date={2020-01},custom={Keep}}",
        "pinned",
        &item,
    )
    .expect("project");
    assert!(text.starts_with("@article{pinned,"));
    assert!(text.contains("2026"));
    assert!(!text.contains("2020"));
    assert!(text.contains("Library Journal"));
    assert!(text.contains("Keep"));
}

#[test]
fn library_names_remain_separate_people_and_literal_organizations() {
    let item = json!({"title":"Library","issuedYear":2026,"doi":"10.1234/test","creators":[
      {"familyName":"Example","givenName":"Alice","literalName":"","role":"author"},
      {"familyName":"Other","givenName":"Bob","literalName":"","role":"author"},
      {"familyName":"","givenName":"","literalName":"Synthetic Group","role":"author"}
    ]});
    let text = from_library("@article{old,title={Original}}", "pinned", &item).expect("project");
    let bib = Bibliography::parse(&text).expect("parse projected BibTeX");
    let entry = bib.get("pinned").expect("entry");
    let people = entry.author().expect("authors");
    assert_eq!(people.len(), 3);
    assert_eq!(people[0].name, "Example");
    assert_eq!(people[0].given_name, "Alice");
    assert_eq!(people[1].given_name, "Bob");
    assert_eq!(people[2].name, "Synthetic Group");
    assert!(text.contains("year = {2026}"));
    assert!(text.contains("doi = {10.1234/test}"));
    assert!(!text.contains("author = {{Example"));
}
#[test]
fn partial_title_update_preserves_author_prefix_suffix_and_existing_date() {
    let original = "@article{pinned,title={Original},author={de la Cruz, Jr., Jane and {Synthetic Group}},date={2020-03},custom={Keep}}";
    let text = from_library(original, "pinned", &json!({"title":"Updated"})).expect("project");
    let before = Bibliography::parse(original).expect("original");
    let after = Bibliography::parse(&text).expect("updated");
    assert_eq!(
        before
            .get("pinned")
            .expect("entry")
            .author()
            .expect("people"),
        after
            .get("pinned")
            .expect("entry")
            .author()
            .expect("people")
    );
    assert!(text.contains("2020"));
    assert!(text.contains("Keep"));
}

#[test]
fn a_colliding_maximum_length_key_remains_valid() {
    let key = "a".repeat(128);
    let parsed = parse(
        &[(
            "source.bib".into(),
            format!("@book{{{key},title={{Synthetic}}}}"),
        )],
        &HashSet::from([key]),
    )
    .expect("normalize");
    assert!(valid_key(&parsed[0].entries[0].key));
    assert_eq!(parsed[0].entries[0].key.len(), 128);
}
