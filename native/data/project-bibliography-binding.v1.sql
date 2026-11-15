select manuscript_id, source_item_id, citation_key, bibtex_entry, state,
                    pinned_at, updated_at
             from citation_bindings where manuscript_id = ?1 and source_item_id = ?2
