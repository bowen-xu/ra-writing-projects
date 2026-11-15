insert into manuscript_compile_artifacts
             (id, run_id, artifact_kind, content_sha256, cache_relative_path, byte_size)
         values (?1, ?2, ?3, ?4, ?5, ?6)
