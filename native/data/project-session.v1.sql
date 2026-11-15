select manuscript_id, open_paths_json, active_path, cursor_state_json,
                    layout_state_json, updated_at
             from writing_sessions where manuscript_id = ?1
