select exists(select 1 from manuscript_files where manuscript_id=?1 and relative_path=?2 and sha256=?3 and byte_size=?4)
