select manuscript_id,relative_path,source_hash from writing_note_catalog where state='pending' and status in (?1,?2) order by status,manuscript_id,relative_path limit 8
