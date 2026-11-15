select manuscript_id, relative_path, base_sha256, content, updated_at
         from manuscript_recovery_drafts where manuscript_id = ?1 and relative_path = ?2
