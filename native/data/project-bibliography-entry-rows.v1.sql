select id,citation_key,original_key,original_bibtex,bibtex_entry,imported_draft_json,literature_item_id
        from manuscript_bibliography_entries where manuscript_id=?1 order by citation_key
