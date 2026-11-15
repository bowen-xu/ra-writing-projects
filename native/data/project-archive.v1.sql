update manuscripts set status = 'archived', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         where id = ?1
