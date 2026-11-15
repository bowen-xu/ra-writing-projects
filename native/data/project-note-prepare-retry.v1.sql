update writing_note_catalog set state='pending' where state='error' and status in (?1,?2)
