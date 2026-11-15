select e.bibtex_entry from manuscript_bibliography_entries e join manuscript_bibliography_members m on m.entry_id=e.id
                where m.manuscript_id=?1 and m.relative_path=?2 order by e.citation_key
