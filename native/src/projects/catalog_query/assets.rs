//! Original query SQL, shared with the retained static adapter.
pub fn asset(name: &str) -> Option<&'static str> {
    match name {
        "catalog-query-after-category.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-after-category.v1.sql"
        )),
        "catalog-query-after-source-down.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-after-source-down.v1.sql"
        )),
        "catalog-query-after-source-up.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-after-source-up.v1.sql"
        )),
        "catalog-query-after-time-down.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-after-time-down.v1.sql"
        )),
        "catalog-query-after-time-up.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-after-time-up.v1.sql"
        )),
        "catalog-query-after-title-down.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-after-title-down.v1.sql"
        )),
        "catalog-query-after-title-up.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-after-title-up.v1.sql"
        )),
        "catalog-query-browse-category-0.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-browse-category-0.v1.sql"
        )),
        "catalog-query-browse-category-1.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-browse-category-1.v1.sql"
        )),
        "catalog-query-browse-source-down-0.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-browse-source-down-0.v1.sql"
        )),
        "catalog-query-browse-source-down-1.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-browse-source-down-1.v1.sql"
        )),
        "catalog-query-browse-source-up-0.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-browse-source-up-0.v1.sql"
        )),
        "catalog-query-browse-source-up-1.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-browse-source-up-1.v1.sql"
        )),
        "catalog-query-browse-time-down-0.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-browse-time-down-0.v1.sql"
        )),
        "catalog-query-browse-time-down-1.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-browse-time-down-1.v1.sql"
        )),
        "catalog-query-browse-time-up-0.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-browse-time-up-0.v1.sql"
        )),
        "catalog-query-browse-time-up-1.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-browse-time-up-1.v1.sql"
        )),
        "catalog-query-browse-title-down-0.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-browse-title-down-0.v1.sql"
        )),
        "catalog-query-browse-title-down-1.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-browse-title-down-1.v1.sql"
        )),
        "catalog-query-browse-title-up-0.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-browse-title-up-0.v1.sql"
        )),
        "catalog-query-browse-title-up-1.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-browse-title-up-1.v1.sql"
        )),
        "catalog-query-counts-all.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-counts-all.v1.sql"
        )),
        "catalog-query-counts-status.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-counts-status.v1.sql"
        )),
        "catalog-query-fts-body.v1.sql" => {
            Some(include_str!("../../../data/catalog-query-fts-body.v1.sql"))
        }
        "catalog-query-fts-metadata.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-fts-metadata.v1.sql"
        )),
        "catalog-query-generation.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-generation.v1.sql"
        )),
        "catalog-query-issues-all.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-issues-all.v1.sql"
        )),
        "catalog-query-issues-status.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-issues-status.v1.sql"
        )),
        "catalog-query-scan-body.v1.sql" => {
            Some(include_str!("../../../data/catalog-query-scan-body.v1.sql"))
        }
        "catalog-query-scan-metadata.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-scan-metadata.v1.sql"
        )),
        "catalog-query-search-category-0.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-search-category-0.v1.sql"
        )),
        "catalog-query-search-category-1.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-search-category-1.v1.sql"
        )),
        "catalog-query-search-source-down-0.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-search-source-down-0.v1.sql"
        )),
        "catalog-query-search-source-down-1.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-search-source-down-1.v1.sql"
        )),
        "catalog-query-search-source-up-0.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-search-source-up-0.v1.sql"
        )),
        "catalog-query-search-source-up-1.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-search-source-up-1.v1.sql"
        )),
        "catalog-query-search-time-down-0.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-search-time-down-0.v1.sql"
        )),
        "catalog-query-search-time-down-1.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-search-time-down-1.v1.sql"
        )),
        "catalog-query-search-time-up-0.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-search-time-up-0.v1.sql"
        )),
        "catalog-query-search-time-up-1.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-search-time-up-1.v1.sql"
        )),
        "catalog-query-search-title-down-0.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-search-title-down-0.v1.sql"
        )),
        "catalog-query-search-title-down-1.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-search-title-down-1.v1.sql"
        )),
        "catalog-query-search-title-up-0.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-search-title-up-0.v1.sql"
        )),
        "catalog-query-search-title-up-1.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-search-title-up-1.v1.sql"
        )),
        "catalog-query-timestamp-all.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-timestamp-all.v1.sql"
        )),
        "catalog-query-timestamp-status.v1.sql" => Some(include_str!(
            "../../../data/catalog-query-timestamp-status.v1.sql"
        )),
        "catalog-query-versions.v1.sql" => {
            Some(include_str!("../../../data/catalog-query-versions.v1.sql"))
        }
        _ => None,
    }
}
