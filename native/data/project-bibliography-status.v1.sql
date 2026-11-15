select relative_path, content_hash, generated_at, status
             from managed_bibliographies where manuscript_id = ?1
