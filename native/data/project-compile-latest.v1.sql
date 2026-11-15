select id from manuscript_compile_runs where manuscript_id = ?1
             order by created_at desc, rowid desc limit 1
