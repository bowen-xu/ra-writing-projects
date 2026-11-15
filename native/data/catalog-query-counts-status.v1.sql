select state,sum(count) from writing_note_catalog_counts where state in ('pending','error') and status=?1 group by state
