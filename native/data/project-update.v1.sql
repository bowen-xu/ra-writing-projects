update manuscripts set title = ?2, root_path = ?3,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         where id = ?1
