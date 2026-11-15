update manuscript_compile_runs set cancellation_requested = 1
         where id = ?1 and status in ('queued', 'running')
