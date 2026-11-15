update manuscript_files set relative_path = ?3,
             modified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         where manuscript_id = ?1 and relative_path = ?2
