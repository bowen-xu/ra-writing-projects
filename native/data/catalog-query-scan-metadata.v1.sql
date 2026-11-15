select manuscript_id,relative_path,{{index}} as term from writing_note_catalog where instr(metadata_text,?{{raw}})>0
