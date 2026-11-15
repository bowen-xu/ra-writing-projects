//! Pre-migration SQL oracle from f33b6474238195cfb8e2a5faed51b070e55a7b81.
#[derive(Clone, Copy)]
struct Ordering {
    column: &'static str,
    index: &'static str,
    descending: bool,
}
mod original {
    use super::Ordering;
    pub(super) fn browse_sql(order: Ordering, after: bool) -> String {
        let select = format!(
            "select id,title,source_label,updated_at,status,manuscript_id,relative_path,{} from writing_note_catalog indexed by writing_note_catalog_{}",
            order.column, order.index
        );
        let scope = "state='ready' and status=?1";
        if order.column == "id" {
            return format!(
                "{select} where {scope}{} order by id limit ?4",
                if after { " and id>?3" } else { "" }
            );
        }
        if order.descending && after {
            format!(
                "{select} where {scope} and {key}=?2 and id>?3 union all {select} where {scope} and {key}<?2 order by {key} desc,id limit ?4",
                key = order.column
            )
        } else {
            let seek = if after {
                format!(" and ({},id)>(?2,?3)", order.column)
            } else {
                String::new()
            };
            format!(
                "{select} where {scope}{seek} order by {} {},id limit ?4",
                order.column,
                if order.descending { "desc" } else { "asc" }
            )
        }
    }
    fn scan(term: &str) -> bool {
        term.chars().count() < 3 || term.contains('\0')
    }
    pub(super) fn search_sql(terms: &[String], order: Ordering, after: bool) -> String {
        let mut hits = Vec::new();
        for (index, term) in terms.iter().enumerate() {
            let parameter = index + 5;
            let raw = parameter + terms.len();
            if scan(term) {
                hits.push(format!("select manuscript_id,relative_path,{index} as term from writing_note_catalog_body where instr(folded_text,?{raw})>0"));
                hits.push(format!("select manuscript_id,relative_path,{index} as term from writing_note_catalog where instr(metadata_text,?{raw})>0"));
            } else {
                hits.push(format!("select b.manuscript_id,b.relative_path,{index} as term from writing_note_catalog_body_search f join writing_note_catalog_body b on b.rowid=f.rowid where writing_note_catalog_body_search match ?{parameter} and instr(b.folded_text,?{raw})>0"));
                hits.push(format!("select c.manuscript_id,c.relative_path,{index} as term from writing_note_catalog_metadata_search f join writing_note_catalog c on c.rowid=f.rowid where writing_note_catalog_metadata_search match ?{parameter} and instr(c.metadata_text,?{raw})>0"));
            }
        }
        let seek = if after {
            format!(
                " and (c.{key}{comparison}?2 or (c.{key}=?2 and c.id>?3))",
                key = order.column,
                comparison = if order.descending { "<" } else { ">" }
            )
        } else {
            String::new()
        };
        format!("with hits as ({}),matches as (select manuscript_id,relative_path from hits group by manuscript_id,relative_path having count(distinct term)={})
 select c.id,c.title,c.source_label,c.updated_at,c.status,c.manuscript_id,c.relative_path,coalesce(substr(b.search_text,1,240),'') as snippet
 from matches m cross join writing_note_catalog c on c.manuscript_id=m.manuscript_id and c.relative_path=m.relative_path
 left join writing_note_catalog_body b on b.manuscript_id=c.manuscript_id and b.relative_path=c.relative_path
 where c.state='ready'{seek} order by c.{} {}{} limit ?4",hits.join(" union all "),terms.len(),order.column,if order.descending{"desc"}else{"asc"},if order.column=="id"{""}else{",c.id"})
    }
}
#[test]
fn fixed_assets_reproduce_original_indexed_sql_for_all_sort_seek_and_term_shapes() {
    use research_workbench_native_sdk::writing_catalog_query::QueryOrder;
    for (kind, column, index, descending) in [
        (QueryOrder::TitleUp, "title_key", "title_up", false),
        (QueryOrder::TitleDown, "title_down", "title_down", false),
        (QueryOrder::SourceUp, "source_key", "source_up", false),
        (QueryOrder::SourceDown, "source_down", "source_down", false),
        (QueryOrder::Category, "id", "category", false),
        (QueryOrder::TimeUp, "updated_ms", "time_up", false),
        (QueryOrder::TimeDown, "updated_ms", "time_down", true),
    ] {
        let order = Ordering {
            column,
            index,
            descending,
        };
        for after in [false, true] {
            assert_eq!(
                super::asset(&super::statement_name(kind, false, after))
                    .unwrap()
                    .trim_end_matches('\n'),
                original::browse_sql(order, after)
            );
            for count in 1..=32 {
                for pattern in 0..3 {
                    let terms = (0..count)
                        .map(|index| match pattern {
                            0 => format!("x{index}"),
                            1 => format!("fts-term-{index}\""),
                            _ => {
                                if index % 2 == 0 {
                                    format!("nul\0{index}")
                                } else {
                                    format!("研究-term-{index}")
                                }
                            }
                        })
                        .collect::<Vec<_>>();
                    assert_eq!(
                        super::search_sql(&terms, kind, after),
                        original::search_sql(&terms, order, after)
                    );
                }
            }
        }
    }
}
