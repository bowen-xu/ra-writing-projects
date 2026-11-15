select manuscript_id, relative_path, file_kind, byte_size, sha256, modified_at
         from manuscript_files where manuscript_id = ?1 order by relative_path collate nocase
