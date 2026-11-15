use super::*;
use serde_json::json;

fn file(path: &str, kind: &str) -> ManuscriptFile {
    ManuscriptFile {
        manuscript_id: "raw-M".into(),
        relative_path: path.into(),
        kind: kind.into(),
        size_bytes: -1,
        sha256: "raw-hash".into(),
        modified_at: "modified".into(),
    }
}

fn entry() -> ImportedEntry {
    ImportedEntry {
        key: "normalized".into(),
        original_key: "OriginalKey".into(),
        original: "raw bytes".into(),
        normalized: "@book{normalized,title={Original},custom={Keep}}".into(),
        metadata: json!({"title":"Original"}),
    }
}

#[test]
fn selection_keeps_generated_hash_lookup_lazy_and_raw_reference_path_rule() {
    assert_eq!(
        select_file(&file("not.tex", "tex"), false, &GeneratedHash::Unqueried),
        FileSelection::Skip
    );
    assert_eq!(
        select_file(
            &file("references.bib", "bib"),
            true,
            &GeneratedHash::Unqueried
        ),
        FileSelection::Skip
    );
    assert_eq!(
        select_file(
            &file("references.bib", "bib"),
            false,
            &GeneratedHash::Unqueried
        ),
        FileSelection::NeedGeneratedHash
    );
    assert_eq!(
        select_file(
            &file("references.bib", "bib"),
            false,
            &GeneratedHash::Ready {
                value: Some("raw-hash".into())
            }
        ),
        FileSelection::Skip
    );
    assert_eq!(
        select_file(
            &file("references.bib", "bib"),
            false,
            &GeneratedHash::Ready { value: None }
        ),
        FileSelection::Read
    );
    assert_eq!(
        select_file(
            &file("REFERENCES.BIB", "unknown"),
            false,
            &GeneratedHash::Unqueried
        ),
        FileSelection::Read
    );
    assert_eq!(
        select_file(&file("other.bib", "tex"), false, &GeneratedHash::Unqueried),
        FileSelection::Read
    );
}

#[test]
fn parsing_keeps_legacy_keys_fresh_original_overrides_and_unmatched_some_flag() {
    let physical = vec![("refs.bib".into(), "@book{MixedKey,title={Physical}}".into())];
    let old = parse_imported(&physical, None, &HashSet::new()).unwrap();
    assert_eq!(old[0].entries[0].key, "MixedKey");
    let originals = vec![("refs.bib".into(), "@book{MixedKey,title={Original}}".into())];
    let fresh = parse_imported(&physical, Some(&originals), &HashSet::new()).unwrap();
    assert_eq!(fresh[0].entries[0].key, "mixedkey");
    assert_eq!(fresh[0].entries[0].metadata["title"], "Original");
    assert_eq!(fresh[0].original, originals[0].1);
    let unmatched = parse_imported(&physical, Some(&[]), &HashSet::new()).unwrap();
    assert_eq!(unmatched[0].entries[0].key, "mixedkey");
    assert_eq!(unmatched[0].entries[0].metadata["title"], "Physical");
}

#[test]
fn migration_refusal_stays_a_separate_deferred_entry_decision() {
    let entry = entry();
    let files = [file("main.tex", "tex")];
    let rejected = validate_entry(&entry, "refs.bib", None, &files).unwrap_err();
    assert_eq!(
        rejected.to_string(),
        "BibTeX 导入未完成：引用键 OriginalKey 需要迁移；原文件已保留，请通过项目导入统一规范化"
    );
    assert!(
        validate_entry(
            &entry,
            "refs.bib",
            Some(&[("other.bib".into(), String::new())]),
            &files
        )
        .is_err()
    );
    assert!(
        validate_entry(
            &entry,
            "refs.bib",
            Some(&[("refs.bib".into(), String::new())]),
            &files
        )
        .is_ok()
    );
    assert!(validate_entry(&entry, "refs.bib", None, &[]).is_ok());
    assert!(validate_entry(&entry, "refs.bib", None, &[file("main.tex", "TeX")]).is_ok());
}

#[test]
fn library_match_keeps_exact_doi_uniqueness_and_original_title_year_first_author_policy() {
    let draft =
        json!({"title":"A-Study","issuedYear":2026,"creators":[{"familyName":"De la Cruz"}]});
    let candidate = json!({"id":"one","title":"A Study","issuedYear":2026,"doi":"","creators":[{"familyName":"de-LA Cruz"}]});
    assert_eq!(
        match_library(
            "normalized-doi",
            &draft,
            false,
            std::slice::from_ref(&candidate)
        ),
        Some(candidate.clone())
    );
    assert!(match_library("", &draft, false, &[candidate.clone(), candidate.clone()]).is_none());
    let mut with_doi = candidate.clone();
    with_doi["doi"] = json!("other-doi");
    assert!(match_library("normalized-doi", &draft, false, &[with_doi]).is_none());
    let mut wrong_year = candidate;
    wrong_year["issuedYear"] = json!("2026");
    assert!(match_library("", &draft, false, &[wrong_year.clone()]).is_none());
    assert_eq!(
        match_library("", &Value::Null, true, std::slice::from_ref(&wrong_year)),
        Some(wrong_year)
    );
    assert!(
        match_library(
            "",
            &json!({"title":"A Study","issuedYear":2026}),
            false,
            &[json!({"title":"A Study","issuedYear":2026})]
        )
        .is_none()
    );
}

#[test]
fn canonical_projection_keeps_unlinked_bytes_and_original_library_field_update() {
    let mut entry = entry();
    assert_eq!(canonical_entry(&entry, None).unwrap(), entry.normalized);
    entry.metadata["rawBibtex"] = json!("@book{ImportedKey,title={Raw},custom={Keep}}");
    let projected = canonical_entry(&entry, Some(&json!({"title":"Live title"}))).unwrap();
    assert!(projected.starts_with("@book{normalized,"));
    assert!(projected.contains("Live title"));
    assert!(projected.contains("Keep"));
}

#[test]
fn publication_choice_skips_proof_for_explicit_publish_and_checks_it_for_hot_list() {
    assert_eq!(publication(true, None), PublicationChoice::Publish);
    assert_eq!(publication(true, Some(true)), PublicationChoice::Publish);
    assert_eq!(publication(false, None), PublicationChoice::NeedProof);
    assert_eq!(publication(false, Some(true)), PublicationChoice::Verify);
    assert_eq!(publication(false, Some(false)), PublicationChoice::Publish);
}
