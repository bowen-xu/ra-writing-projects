delete from manuscript_recovery_drafts
         where manuscript_id = ?1 and rowid not in (
             select rowid from manuscript_recovery_drafts
             where manuscript_id = ?1
             order by updated_at desc, rowid desc limit ?2
         )
