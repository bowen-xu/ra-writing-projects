use super::{InputError, invalid};
use research_workbench_native_sdk::{
    data::{DataRows, DataValue},
    writing_catalog_query::{
        CatalogIssue, CatalogItem, CatalogOwner, CatalogPage, CatalogTarget, Cursor, QueryCursor,
        QueryDecision, QueryPlan, QueryProblem, QueryRead, QuerySnapshot,
    },
};

fn text(row: &[DataValue], column: usize) -> Result<String, InputError> {
    match row.get(column) {
        Some(DataValue::Text(value)) => Ok(value.clone()),
        _ => Err(InputError::CatalogQuery),
    }
}
fn integer(row: &[DataValue], column: usize) -> Result<i64, InputError> {
    match row.get(column) {
        Some(DataValue::Integer(value)) => Ok(*value),
        _ => Err(InputError::CatalogQuery),
    }
}
fn items(rows: &DataRows) -> Result<Vec<CatalogItem>, InputError> {
    rows.rows
        .iter()
        .map(|row| {
            if row.len() != 8 {
                return Err(InputError::CatalogQuery);
            }
            let manuscript_id = text(row, 5)?;
            Ok(CatalogItem {
                id: text(row, 0)?,
                title: text(row, 1)?,
                snippet: text(row, 7)?,
                category: "dependent".into(),
                owner: CatalogOwner {
                    kind: "manuscript".into(),
                    id: manuscript_id.clone(),
                    label: text(row, 2)?,
                },
                updated_at: text(row, 3)?,
                status: text(row, 4)?,
                is_favorite: false,
                target: CatalogTarget {
                    kind: "writing".into(),
                    manuscript_id,
                    path: text(row, 6)?,
                },
            })
        })
        .collect()
}
fn issues(rows: &DataRows) -> Result<Vec<CatalogIssue>, InputError> {
    if rows.rows.len() > 5 {
        return Err(InputError::CatalogQuery);
    }
    rows.rows
        .iter()
        .map(|row| {
            if row.len() != 3 {
                return Err(InputError::CatalogQuery);
            }
            Ok(CatalogIssue {
                manuscript_id: text(row, 0)?,
                path: text(row, 1)?,
                cause: text(row, 2)?,
            })
        })
        .collect()
}
fn fill(
    page: &mut CatalogPage,
    plan: &QueryPlan,
    counts: &DataRows,
    issue_rows: &DataRows,
    item_rows: &DataRows,
) -> Result<(), InputError> {
    if counts.rows.len() > 2 || item_rows.rows.len() > plan.limit + 1 {
        return Err(InputError::CatalogQuery);
    }
    for row in &counts.rows {
        if row.len() != 2 {
            return Err(InputError::CatalogQuery);
        }
        let state = text(row, 0)?;
        let count = integer(row, 1)?;
        if state == "pending" {
            page.pending_count = count;
        } else {
            page.error_count = count;
        }
    }
    page.issues = issues(issue_rows)?;
    page.items = items(item_rows)?;
    let more = page.items.len() > plan.limit;
    page.items.truncate(plan.limit);
    if more {
        let cursor = Cursor {
            schema: 1,
            revision: page.revision,
            scope: plan.scope.clone(),
            id: page
                .items
                .last()
                .ok_or(InputError::CatalogQuery)?
                .id
                .clone(),
        };
        page.next_cursor =
            Some(serde_json::to_string(&cursor).map_err(|_| InputError::CatalogQuery)?);
    }
    Ok(())
}
pub(super) fn project(
    plan: &QueryPlan,
    snapshot: &QuerySnapshot,
) -> Result<QueryDecision, InputError> {
    let boundary = match &plan.cursor {
        QueryCursor::Rejected { problem } => Some(problem.clone()),
        QueryCursor::Ready { cursor } if cursor.revision != snapshot.revision => {
            Some(QueryProblem::CatalogChanged {
                current_revision: snapshot.revision,
            })
        }
        _ => None,
    };
    if let Some(problem) = boundary {
        return if matches!(snapshot.read, QueryRead::CursorBoundary {}) {
            Ok(QueryDecision::Rejected { problem })
        } else {
            Err(InputError::CatalogQuery)
        };
    }
    let mut page = CatalogPage {
        items: vec![],
        revision: snapshot.revision,
        next_cursor: None,
        pending_count: 0,
        error_count: 0,
        issues: vec![],
    };
    if !plan.includes {
        return if matches!(snapshot.read, QueryRead::Excluded {}) {
            Ok(QueryDecision::Page { page })
        } else {
            Err(InputError::CatalogQuery)
        };
    }
    let problem = match &snapshot.read {
        QueryRead::VersionMismatch { versions } if versions != &plan.versions => {
            QueryProblem::IndexFailed {
                cause: "writing_note_catalog_version：写作笔记查询投影版本不匹配。".into(),
            }
        }
        QueryRead::TimestampInvalid {
            manuscript_id,
            path,
        } => QueryProblem::IndexFailed {
            cause: format!(
                "writing_note_catalog_timestamp_invalid：写作笔记编辑时间无效（manuscriptId={manuscript_id}，path={path}）；原始数据已保留。"
            ),
        },
        QueryRead::CursorMissing {} if matches!(plan.cursor, QueryCursor::Ready { .. }) => {
            invalid("writing_note_catalog_cursor_missing：写作笔记游标对象不存在。")
        }
        QueryRead::Ready {
            counts,
            issues,
            items,
        } => {
            fill(&mut page, plan, counts, issues, items)?;
            return Ok(QueryDecision::Page { page });
        }
        _ => return Err(InputError::CatalogQuery),
    };
    Ok(QueryDecision::Rejected { problem })
}
