select id, manuscript_id, engine, status, raw_output, exit_code, started_at, finished_at
             from manuscript_compile_runs where id = ?1
