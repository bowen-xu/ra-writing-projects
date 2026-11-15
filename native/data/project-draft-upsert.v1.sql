insert into manuscript_recovery_drafts (
             manuscript_id, relative_path, base_sha256, content, updated_at
         ) values (?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         on conflict(manuscript_id, relative_path) do update set
             base_sha256 = excluded.base_sha256, content = excluded.content,
             updated_at = excluded.updated_at
