insert into manuscripts (id, project_id, title, root_path, created_at, updated_at)
         values (?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
