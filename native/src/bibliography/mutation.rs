//! Original editable field set, CAS precedence, linking and binding-key rules.
use super::{Error, normalize, parse};
use research_workbench_native_sdk::writing_bibliography::mutation::{Decision, Input, Rejection};
use serde_json::{Map, Value};
use std::collections::HashSet;

pub fn unique_key(base: &str, occupied: &HashSet<String>) -> String {
    let base = base.to_ascii_lowercase();
    let occupied = occupied
        .iter()
        .map(|key| key.to_ascii_lowercase())
        .collect::<HashSet<_>>();
    if !occupied.contains(&base) {
        return base;
    }
    let mut suffix = 2;
    loop {
        let serial = suffix.to_string();
        let candidate = format!("{}{}", &base[..base.len().min(128 - serial.len())], serial);
        if !occupied.contains(&candidate) {
            return candidate;
        }
        suffix += 1;
    }
}
pub fn prepare(input: &Input) -> Result<Decision, Rejection> {
    Ok(match input {
        Input::PrepareSearch {
            scope,
            library_available,
        } => {
            if !matches!(scope.as_str(), "project" | "library") {
                return Err(Rejection::InvalidManuscript);
            }
            if !library_available {
                return Err(Rejection::LiteratureUnavailable);
            }
            Decision::SearchScope {
                project_only: scope == "project",
            }
        }
        Input::ProjectSearch { hits } => Decision::Candidates {
            items: candidates(hits.clone()),
        },
        Input::ValidateDraft { draft } => {
            if draft["title"]
                .as_str()
                .is_none_or(|title| title.trim().is_empty())
            {
                return Err(Error::InvalidBibtexEntry.into());
            }
            Decision::Accepted
        }
        Input::SelectUpdate {
            entry_id,
            entries,
            draft,
            library_available,
        } => {
            let selected = entries
                .iter()
                .find(|entry| entry.id == *entry_id)
                .ok_or(Error::InvalidBibtexEntry)?;
            if selected.library_item_id.is_some() && !library_available {
                return Err(Rejection::LiteratureUnavailable);
            }
            let mut patch = Map::new();
            for key in [
                "itemType",
                "title",
                "abstractText",
                "issuedYear",
                "containerTitle",
                "conferenceName",
                "proceedingsTitle",
                "place",
                "volume",
                "issue",
                "pages",
                "doi",
                "url",
                "language",
                "creators",
            ] {
                let next = draft.get(key).unwrap_or(&Value::Null);
                if next != selected.current.get(key).unwrap_or(&Value::Null) {
                    patch.insert(key.into(), next.clone());
                }
            }
            Decision::UpdateSelection {
                selected: selected.current.clone(),
                patch,
            }
        }
        Input::Update {
            key,
            current,
            linked,
            expected,
            selected,
            patch,
        } => {
            if linked.is_some() {
                return Err(Rejection::ManagedBibliography(
                    "文献库条目请在对照中更新".into(),
                ));
            }
            if current != expected {
                return Err(Rejection::FileConflict);
            }
            let template = selected["rawBibtex"]
                .as_str()
                .ok_or(Error::InvalidBibtexEntry)?;
            Decision::Text {
                text: parse::from_library(template, key, &Value::Object(patch.clone()))?,
            }
        }
        Input::SelectLink { entry_id, item_id } => {
            let source = entry_id.strip_prefix("binding:");
            if source.is_some_and(|source| source != item_id) {
                return Err(Rejection::CitationSourceNotFound);
            }
            Decision::Link {
                source: source.map(ToOwned::to_owned),
            }
        }
        Input::BindKey {
            requested,
            imported,
            pinned,
            occupied,
        } => {
            let requested = requested
                .as_deref()
                .filter(|value| normalize::valid_key(value));
            let imported = imported
                .as_deref()
                .filter(|value| normalize::valid_key(value));
            Decision::Key {
                key: pinned.clone().unwrap_or_else(|| {
                    unique_key(
                        requested.or(imported).unwrap_or("reference"),
                        &occupied.iter().cloned().collect(),
                    )
                }),
            }
        }
        Input::RemoveKeys { keys, used } => {
            let used = used.iter().collect::<HashSet<_>>();
            Decision::Remove {
                keys: keys
                    .iter()
                    .filter(|key| !used.contains(key))
                    .cloned()
                    .collect(),
            }
        }
    })
}
pub fn decide(input: &Input) -> Decision {
    prepare(input).unwrap_or_else(|reason| Decision::Rejected { reason })
}

pub fn candidates(
    hits: Vec<research_workbench_native_sdk::catalog::bibliography::CitationSearchHit>,
) -> Vec<research_workbench_native_sdk::writing_bibliography::CitationCandidate> {
    use research_workbench_native_sdk::writing_bibliography::CitationCandidate;
    hits.into_iter()
        .map(|row| {
            let mut warnings = Vec::new();
            if row.first_author.trim().is_empty() {
                warnings.push("缺少作者".into());
            }
            if row.issued_year.is_none() {
                warnings.push("缺少年份".into());
            }
            if row.title.trim().is_empty() {
                warnings.push("缺少标题".into());
            }
            CitationCandidate {
                literature_item_id: row.literature_item_id,
                title: row.title,
                issued_year: row.issued_year,
                container_title: row.container_title,
                imported_key: row.imported_key,
                first_author: row.first_author,
                has_pdf: row.has_pdf,
                has_evidence: row.has_evidence,
                citation_key: row.citation_key,
                warnings,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn binding_keys_keep_original_precedence_case_and_occupied_suffixes() {
        for (requested, imported, pinned, expected) in [
            (
                Some("Requested"),
                Some("Imported"),
                Some("PINNED"),
                "PINNED",
            ),
            (Some("Requested"), Some("Imported"), None, "requested2"),
            (Some("invalid key"), Some("Imported"), None, "imported"),
            (None, None, None, "reference"),
        ] {
            assert_eq!(
                decide(&Input::BindKey {
                    requested: requested.map(Into::into),
                    imported: imported.map(Into::into),
                    pinned: pinned.map(Into::into),
                    occupied: vec!["Requested".into()]
                }),
                Decision::Key {
                    key: expected.into()
                }
            );
        }
    }
    #[test]
    fn edit_keeps_managed_before_cas_before_template_validation() {
        let mut input = Input::Update {
            key: "x".into(),
            current: "current".into(),
            linked: Some("library".into()),
            expected: "stale".into(),
            selected: json!({}),
            patch: Map::new(),
        };
        assert!(matches!(
            decide(&input),
            Decision::Rejected {
                reason: Rejection::ManagedBibliography(_)
            }
        ));
        if let Input::Update { linked, .. } = &mut input {
            *linked = None;
        }
        assert_eq!(
            decide(&input),
            Decision::Rejected {
                reason: Rejection::FileConflict
            }
        );
        if let Input::Update { expected, .. } = &mut input {
            *expected = "current".into();
        }
        assert_eq!(
            decide(&input),
            Decision::Rejected {
                reason: Rejection::Bibliography(Error::InvalidBibtexEntry)
            }
        );
    }
    #[test]
    fn search_and_link_rejections_and_warning_order_remain_original() {
        assert_eq!(
            decide(&Input::PrepareSearch {
                scope: "invalid".into(),
                library_available: false
            }),
            Decision::Rejected {
                reason: Rejection::InvalidManuscript
            }
        );
        assert_eq!(
            decide(&Input::PrepareSearch {
                scope: "library".into(),
                library_available: false
            }),
            Decision::Rejected {
                reason: Rejection::LiteratureUnavailable
            }
        );
        assert_eq!(
            decide(&Input::SelectLink {
                entry_id: "binding:a".into(),
                item_id: "b".into()
            }),
            Decision::Rejected {
                reason: Rejection::CitationSourceNotFound
            }
        );
        let hits = vec![
            research_workbench_native_sdk::catalog::bibliography::CitationSearchHit {
                literature_item_id: "id".into(),
                title: "".into(),
                first_author: "".into(),
                issued_year: None,
                container_title: "".into(),
                imported_key: "".into(),
                citation_key: None,
                has_pdf: false,
                has_evidence: false,
            },
        ];
        let rows = candidates(hits);
        assert_eq!(rows[0].warnings, ["缺少作者", "缺少年份", "缺少标题"]);
        assert_eq!(
            serde_json::to_value(&rows[0]).unwrap()["citationKey"],
            Value::Null
        );
    }
}
