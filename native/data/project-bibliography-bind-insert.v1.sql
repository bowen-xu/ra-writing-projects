insert into citation_bindings (
             manuscript_id, literature_item_id, source_item_id, citation_key, bibtex_entry, state,
             pinned_at, updated_at
         ) values (
             ?1, ?2, ?2, ?3, ?4, 'active',
             strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         )
