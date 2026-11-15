insert into writing_document_checkpoints (manuscript_id, relative_path, revision, checkpoint_json, updated_at)
         values (?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         on conflict(manuscript_id, relative_path) do update set
         revision = excluded.revision, checkpoint_json = excluded.checkpoint_json, updated_at = excluded.updated_at
