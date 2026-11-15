insert into content_objects (sha256, relative_path, mime_type, byte_size, created_at)
             values (?1, ?2, 'application/pdf', ?3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             on conflict(sha256) do nothing
