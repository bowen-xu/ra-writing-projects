//! Original writing-note query policy. Core owns each coherent SQL read.
mod assets;
mod projection;
use super::InputError;
pub use assets::asset;
use research_workbench_native_sdk::{
    note_catalog_query::PageCatalogQuery,
    writing_catalog_query::{
        Cursor, QueryCursor, QueryDecision, QueryInput, QueryOrder, QueryPlan, QueryProblem,
        QueryTerm,
    },
};
use sha2::{Digest, Sha256};

pub fn invalid(cause: &str) -> QueryProblem {
    QueryProblem::InvalidInput {
        cause: cause.into(),
    }
}
pub fn scope(query: &PageCatalogQuery, terms: &[String]) -> String {
    format!(
        "{:x}",
        Sha256::digest(
            serde_json::json!([query.category, query.view, query.sort, terms])
                .to_string()
                .as_bytes()
        )
    )
}
pub fn order(query: &PageCatalogQuery) -> Result<QueryOrder, QueryProblem> {
    let (field, down) = match &query.sort {
        None => ("updatedAt", true),
        Some(sort) => (
            sort.field.as_str(),
            match sort.direction.as_str() {
                "ascending" => false,
                "descending" => true,
                _ => return Err(invalid("writing_note_catalog_sort_invalid：排序方向无效。")),
            },
        ),
    };
    Ok(match (field, down) {
        ("title", false) => QueryOrder::TitleUp,
        ("title", true) => QueryOrder::TitleDown,
        ("source", false) => QueryOrder::SourceUp,
        ("source", true) => QueryOrder::SourceDown,
        ("category", _) => QueryOrder::Category,
        ("updatedAt", false) => QueryOrder::TimeUp,
        ("updatedAt", true) => QueryOrder::TimeDown,
        _ => return Err(invalid("writing_note_catalog_sort_invalid：排序字段无效。")),
    })
}
pub fn prepare(query: &PageCatalogQuery) -> Result<QueryPlan, QueryProblem> {
    if !matches!(query.category.as_str(), "all" | "independent" | "dependent")
        || !matches!(
            query.view.as_str(),
            "recent" | "favorites" | "archive" | "trash"
        )
        || query.limit.is_some_and(|n| !(1..=200).contains(&n))
        || query
            .cursor
            .as_ref()
            .is_some_and(|cursor| cursor.len() > 8192)
    {
        return Err(invalid(
            "writing_note_catalog_query_invalid：写作笔记查询范围或分页无效。",
        ));
    }
    let terms = research_note_query::note_query_terms(query.search.as_deref().unwrap_or_default())
        .map_err(|cause| invalid(&cause))?;
    let order = order(query)?;
    let scope = scope(query, &terms);
    // Cursor parsing is deferred until Core has read the generation row.
    let cursor = match query.cursor.as_deref() {
        None => QueryCursor::Absent {},
        Some(value) => match serde_json::from_str::<Cursor>(value) {
            Err(_) => QueryCursor::Rejected {
                problem: invalid("writing_note_catalog_cursor_invalid：写作笔记游标无效。"),
            },
            Ok(cursor) if cursor.schema != 1 || cursor.scope != scope => QueryCursor::Rejected {
                problem: invalid("writing_note_catalog_cursor_scope：写作笔记游标不属于当前查询。"),
            },
            Ok(cursor) => QueryCursor::Ready { cursor },
        },
    };
    let includes = query.view != "trash"
        && (!terms.is_empty() || query.category != "independent" && query.view != "favorites");
    Ok(QueryPlan {
        query: query.clone(),
        terms: terms
            .into_iter()
            .map(|raw| QueryTerm {
                scan: scan(&raw),
                parameter: search_parameter(&raw),
                raw,
            })
            .collect(),
        order,
        scope,
        cursor,
        includes,
        status: if query.view == "archive" {
            "archived"
        } else {
            "active"
        }
        .into(),
        limit: query.limit.unwrap_or(20),
        versions: [
            "writing-note-text/v1".into(),
            research_note_query::note_collation_version(),
            "rfc3339-utc-ms-floor-v1".into(),
        ],
    })
}
pub fn scan(term: &str) -> bool {
    term.chars().count() < 3 || term.contains('\0')
}
pub fn search_parameter(term: &str) -> String {
    if scan(term) {
        term.into()
    } else {
        format!("\"{}\"", term.replace('"', "\"\""))
    }
}
/// Fixed asset naming only. No SQL text is received from a host.
pub fn statement_name(order: QueryOrder, search: bool, after: bool) -> String {
    format!(
        "catalog-query-{}-{}-{}.v1.sql",
        if search { "search" } else { "browse" },
        order.asset_key(),
        u8::from(after)
    )
}
pub fn search_sql(terms: &[String], order: QueryOrder, after: bool) -> String {
    research_note_query::catalog_search_sql(
        research_note_query::CatalogSearchSql {
            scan_body: asset("catalog-query-scan-body.v1.sql").expect("fixed catalog asset"),
            scan_metadata: asset("catalog-query-scan-metadata.v1.sql")
                .expect("fixed catalog asset"),
            fts_body: asset("catalog-query-fts-body.v1.sql").expect("fixed catalog asset"),
            fts_metadata: asset("catalog-query-fts-metadata.v1.sql").expect("fixed catalog asset"),
            result: asset(&statement_name(order, true, after)).expect("fixed catalog asset"),
        },
        &terms.iter().map(|term| scan(term)).collect::<Vec<_>>(),
    )
}
pub(super) fn decide(input: &QueryInput) -> Result<QueryDecision, InputError> {
    Ok(match input {
        QueryInput::Prepare { query } => match prepare(query) {
            Ok(plan) => QueryDecision::Prepared {
                plan: Box::new(plan),
            },
            Err(problem) => QueryDecision::Rejected { problem },
        },
        QueryInput::Project { plan, snapshot } => {
            if prepare(&plan.query).as_ref() != Ok(plan.as_ref()) {
                return Err(InputError::CatalogQuery);
            }
            projection::project(plan, snapshot)?
        }
    })
}

#[cfg(test)]
mod original_sql_tests;
#[cfg(test)]
mod tests;
