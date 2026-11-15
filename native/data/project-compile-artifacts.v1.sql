select artifact_kind, byte_size, content_sha256
         from manuscript_compile_artifacts where run_id = ?1 order by artifact_kind
