delete from manuscript_recovery_drafts
         where updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')
