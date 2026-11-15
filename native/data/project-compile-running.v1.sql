update manuscript_compile_runs set status = 'running',
             started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         where id = ?1 and status = 'queued'
