update writing_note_catalog set note_id=?3,state='ready',error_cause=null where manuscript_id=?1 and relative_path=?2 and (note_id is not ?3 or state<>'ready' or error_cause is not null)
