select revision, checkpoint_json from writing_document_checkpoints
         where manuscript_id = ?1 and relative_path = ?2
