update writing_note_catalog set state='error',error_cause='writing_note_catalog_external_change：文件内容与登记哈希不同，请刷新项目文件后重试。' where manuscript_id=?1 and relative_path=?2
