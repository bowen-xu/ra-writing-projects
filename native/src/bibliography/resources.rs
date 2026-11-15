//! Original resource-upload key normalization and existing-document protection.
use super::{Error, parse};
use research_workbench_native_sdk::writing_bibliography::adoption::ResourceNormalization;
use std::collections::{BTreeMap, HashSet};

pub fn normalize(
    sources: &[(String, String)],
    occupied: &HashSet<String>,
) -> Result<ResourceNormalization, Error> {
    let parsed = parse::parse(sources, occupied)?;
    let mapping = parsed
        .iter()
        .flat_map(|f| f.entries.iter())
        .filter(|e| e.key != e.original_key)
        .map(|e| (e.original_key.clone(), e.key.clone()))
        .collect::<BTreeMap<_, _>>();
    // Existing documents retain occupied keys, and are never rewritten by an upload.
    let document_mapping = mapping
        .iter()
        .filter(|(old, _)| !occupied.contains(*old))
        .map(|(old, new)| (old.clone(), new.clone()))
        .collect();
    let files = parsed
        .into_iter()
        .map(|file| {
            (
                file.path,
                format!(
                    "{}\n{}\n",
                    file.support,
                    file.entries
                        .iter()
                        .map(|e| e.normalized.as_str())
                        .collect::<Vec<_>>()
                        .join("\n\n")
                ),
            )
        })
        .collect();
    Ok(ResourceNormalization {
        files,
        mapping,
        document_mapping,
    })
}

pub fn source(
    text: &str,
    mapping: &BTreeMap<String, String>,
    existing: bool,
) -> Result<String, Error> {
    let next = parse::rewrite_citations(text, mapping)?;
    if existing && next != text {
        return Err(Error::BibliographyImport(
            "现有正文使用了需要规范化的引用键。请通过项目导入同时迁移正文；本次资源未导入。".into(),
        ));
    }
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bibliography::adoption::decide;
    use research_workbench_native_sdk::writing_bibliography::adoption::{
        AdoptionDecision, AdoptionInput,
    };

    #[test]
    fn normalizes_original_keys_and_preserves_support_and_occupied_citations() {
        let sources = vec![("refs.bib".into(), "@string{journal={Synthetic}}\n@article{2026,title={Title},journal=journal,custom={Keep}}\n@book{alpha,title={Other}}".into())];
        let occupied = HashSet::from(["alpha".into()]);
        let plan = normalize(&sources, &occupied).unwrap();
        assert!(plan.mapping.contains_key("2026"));
        assert!(plan.mapping.contains_key("alpha"));
        assert!(!plan.document_mapping.contains_key("alpha"));
        assert!(plan.files[0].1.contains("@string"));
        assert!(plan.files[0].1.contains("custom={Keep}"));
        let original = "\\cite{alpha} \\cite{2026}";
        let next = source(original, &plan.mapping, false).unwrap();
        assert_ne!(next, original);
        assert!(source(original, &plan.document_mapping, true).is_err());
        assert_eq!(
            source("\\cite{alpha}", &plan.document_mapping, true).unwrap(),
            "\\cite{alpha}"
        );
        let input = AdoptionInput::NormalizeResources {
            sources,
            occupied: occupied.into_iter().collect(),
        };
        let wire = serde_json::to_vec(&input).unwrap();
        let decoded = serde_json::from_slice(&wire).unwrap();
        assert_eq!(
            decide(&decoded),
            AdoptionDecision::ResourcesNormalized { plan }
        );
    }

    #[test]
    fn malformed_input_and_original_path_classification_retain_rules() {
        assert!(
            normalize(
                &[("refs.bib".into(), "@book{unfinished".into())],
                &HashSet::new()
            )
            .is_err()
        );
        assert_eq!(
            decide(&AdoptionInput::ResourcePath {
                relative_path: "refs.BIB ".into()
            }),
            AdoptionDecision::ResourcePath {
                file_kind: "other".into(),
                managed_bibliography: true
            }
        );
    }
}
