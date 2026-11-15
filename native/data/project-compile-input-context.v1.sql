select manuscript_id, input_hash from manuscript_compile_runs
             where id = ?1 and status in ('succeeded', 'failed') and input_hash is not null
