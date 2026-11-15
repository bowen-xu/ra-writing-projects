update citation_bindings set bibtex_entry = ?3, state = 'active',
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         where manuscript_id = ?1 and source_item_id = ?2
