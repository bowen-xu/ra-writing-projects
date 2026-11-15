update manuscripts set last_successful_compile_run_id = ?1,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             where id = (select manuscript_id from manuscript_compile_runs
                         where id = ?1 and status = 'succeeded')
