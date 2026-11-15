select exists(select 1 from manuscript_files where manuscript_id=?1 and relative_path=?2)
