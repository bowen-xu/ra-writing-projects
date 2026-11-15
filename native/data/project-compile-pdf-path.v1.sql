select c.relative_path
             from manuscript_compile_artifacts a
             join content_objects c on c.sha256 = a.content_sha256
             join manuscript_compile_runs r on r.id = a.run_id
             where a.run_id = ?1 and a.artifact_kind = 'pdf' and r.status in ('succeeded', 'failed')
