select r.manuscript_id, m.root_path, r.toolchain_json, r.input_hash
             from manuscript_compile_runs r
             join manuscripts m on m.id = r.manuscript_id
             where r.id = ?1 and r.status in ('succeeded', 'failed')
               and exists(
                   select 1 from manuscript_compile_artifacts a
                   where a.run_id = r.id and a.artifact_kind = 'synctex'
               )
