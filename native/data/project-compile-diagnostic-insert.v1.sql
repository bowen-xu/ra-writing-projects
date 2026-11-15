insert into manuscript_compile_diagnostics
                 (id, run_id, severity, message, relative_path, line, column_number, position)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
