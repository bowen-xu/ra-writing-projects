select coalesce(sum(case when state='pending' then count else 0 end),0),coalesce(sum(case when state='error' then count else 0 end),0) from writing_note_catalog_counts where status in (?1,?2)
