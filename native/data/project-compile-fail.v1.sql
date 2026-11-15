update manuscript_compile_runs set status = 'failed', raw_output = ?2,
             finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         where id = ?1 and status in ('queued', 'running')
