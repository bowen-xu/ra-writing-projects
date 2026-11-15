update writing_note_catalog set note_id=null,state='error',error_cause=?3 where manuscript_id=?1 and relative_path=?2
