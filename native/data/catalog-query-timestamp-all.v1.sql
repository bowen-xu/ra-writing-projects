select manuscript_id,relative_path from writing_note_catalog where state='ready' and updated_ms is null and 1 limit 1
