insert into manuscript_compile_runs
             (id, manuscript_id, engine, root_path, status, created_at)
         values (?1, ?2, ?3, ?4, 'queued', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
