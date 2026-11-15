insert into manuscript_bibliography_files(manuscript_id,relative_path,original_content,support_content,content_hash) values (?1,?2,?3,'',?4) on conflict(manuscript_id,relative_path) do nothing
