update manuscript_compile_runs set status = ?2, input_hash = ?3,
             toolchain_json = ?4, raw_output = ?5, exit_code = ?6,
             finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         where id = ?1 and status in ('queued', 'running')
