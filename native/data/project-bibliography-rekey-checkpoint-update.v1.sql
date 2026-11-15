update writing_document_checkpoints set revision=revision+1,checkpoint_json=?3 where manuscript_id=?1 and relative_path=?2
