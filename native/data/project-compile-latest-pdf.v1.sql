select id from manuscript_compile_runs
             where manuscript_id = ?1 and status in ('succeeded', 'failed')
               and exists (select 1 from manuscript_compile_artifacts a
                           where a.run_id = manuscript_compile_runs.id and a.artifact_kind = 'pdf')
             order by created_at desc, rowid desc limit 1
