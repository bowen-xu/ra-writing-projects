delete from manuscript_recovery_drafts where rowid not in (
             select rowid from manuscript_recovery_drafts
             order by updated_at desc, rowid desc limit ?1
         )
