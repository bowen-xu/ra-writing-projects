insert into writing_sessions
             (manuscript_id, open_paths_json, active_path, cursor_state_json, layout_state_json, updated_at)
         values (?1, ?2, ?3, ?4, ?5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         on conflict(manuscript_id) do update set
             open_paths_json = excluded.open_paths_json,
             active_path = excluded.active_path,
             cursor_state_json = excluded.cursor_state_json,
             layout_state_json = excluded.layout_state_json,
             updated_at = excluded.updated_at
