select manuscript_id, relative_path, base_sha256, content, updated_at
             from manuscript_recovery_drafts where manuscript_id = ?1 order by updated_at desc
