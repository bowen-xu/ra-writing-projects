with item_ids as (
             select source_item_id as id from citation_bindings where manuscript_id = ?1
             union
             select literature_item_id from manuscript_bibliography_entries
             where manuscript_id = ?1 and literature_item_id is not null
         )
         select id,
                (select cb.citation_key from citation_bindings cb
                 where cb.manuscript_id = ?1 and cb.source_item_id = item_ids.id),
                (select e.citation_key from manuscript_bibliography_entries e
                 where e.manuscript_id = ?1 and e.literature_item_id = item_ids.id
                 order by e.citation_key limit 1),
                coalesce((select group_concat(e.citation_key, ' ')
                    from manuscript_bibliography_entries e
                    where e.manuscript_id = ?1 and e.literature_item_id = item_ids.id), '')
         from item_ids
