select severity, message, relative_path, line, column_number
         from manuscript_compile_diagnostics where run_id = ?1 order by position
