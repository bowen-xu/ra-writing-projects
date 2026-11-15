insert into manuscript_files
             (manuscript_id, relative_path, file_kind, byte_size, sha256, modified_at)
         values (?1, ?2, ?3, ?4, ?5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         on conflict(manuscript_id, relative_path) do update set
             file_kind = excluded.file_kind,
             byte_size = excluded.byte_size,
             sha256 = excluded.sha256,
             modified_at = excluded.modified_at
