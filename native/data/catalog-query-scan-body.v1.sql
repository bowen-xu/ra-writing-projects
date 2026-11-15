select manuscript_id,relative_path,{{index}} as term from writing_note_catalog_body where instr(folded_text,?{{raw}})>0
