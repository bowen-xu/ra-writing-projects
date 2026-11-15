select exists(select 1 from manuscript_compile_runs where manuscript_id = ?1 and status in ('queued', 'running'))
