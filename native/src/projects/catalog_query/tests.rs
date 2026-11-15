use super::*;
use research_workbench_native_sdk::{
    data::DataRows,
    writing_catalog_query::{QueryRead, QuerySnapshot},
};
fn query() -> PageCatalogQuery {
    PageCatalogQuery {
        category: "all".into(),
        view: "recent".into(),
        limit: Some(1),
        cursor: None,
        search: None,
        sort: None,
    }
}
#[test]
fn query_validation_precedes_terms_order_and_deferred_cursor_errors() {
    let mut q = query();
    q.category = "unknown".into();
    q.search = Some("x".repeat(4097));
    assert!(
        matches!(prepare(&q),Err(QueryProblem::InvalidInput { cause }) if cause.starts_with("writing_note_catalog_query_invalid"))
    );
    q.category = "all".into();
    assert!(prepare(&q).is_err());
    q.search = None;
    q.cursor = Some("{".into());
    let p = prepare(&q).unwrap();
    assert!(matches!(p.cursor, QueryCursor::Rejected { .. }));
    assert!(matches!(
        projection::project(
            &p,
            &QuerySnapshot {
                revision: 7,
                read: QueryRead::CursorBoundary {}
            }
        )
        .unwrap(),
        QueryDecision::Rejected { .. }
    ));
    assert!(
        projection::project(
            &p,
            &QuerySnapshot {
                revision: 7,
                read: QueryRead::Excluded {}
            }
        )
        .is_err()
    );
}
#[test]
fn excluded_views_and_search_override_keep_original_scope_semantics() {
    let mut q = query();
    q.category = "independent".into();
    assert!(!prepare(&q).unwrap().includes);
    q.search = Some("term".into());
    assert!(prepare(&q).unwrap().includes);
    q.view = "favorites".into();
    assert!(prepare(&q).unwrap().includes);
    q.view = "trash".into();
    assert!(!prepare(&q).unwrap().includes);
    q.view = "archive".into();
    let p = prepare(&q).unwrap();
    assert_eq!(p.status, "archived");
    assert_eq!(p.terms[0].parameter, "\"term\"");
    assert_eq!(search_parameter("a\0long"), "a\0long");
    assert_eq!(search_parameter("a\"long"), "\"a\"\"long\"");
}
#[test]
fn cursor_scope_hash_and_revision_are_retained_and_snapshot_prefix_is_closed() {
    let mut q = query();
    let p = prepare(&q).unwrap();
    q.cursor = Some(
        serde_json::to_string(&Cursor {
            schema: 1,
            revision: 7,
            scope: p.scope,
            id: "id".into(),
        })
        .unwrap(),
    );
    let p = prepare(&q).unwrap();
    let input = QueryInput::Project {
        plan: Box::new(p.clone()),
        snapshot: Box::new(QuerySnapshot {
            revision: 8,
            read: QueryRead::CursorBoundary {},
        }),
    };
    assert_eq!(
        decide(&input).unwrap(),
        QueryDecision::Rejected {
            problem: QueryProblem::CatalogChanged {
                current_revision: 8
            }
        }
    );
    let bad = QuerySnapshot {
        revision: 8,
        read: QueryRead::Ready {
            counts: DataRows { rows: vec![] },
            issues: DataRows { rows: vec![] },
            items: DataRows { rows: vec![] },
        },
    };
    assert!(projection::project(&p, &bad).is_err());
    let mut forged = p;
    forged.limit = 200;
    assert!(
        decide(&QueryInput::Project {
            plan: Box::new(forged),
            snapshot: Box::new(bad)
        })
        .is_err()
    );
}
