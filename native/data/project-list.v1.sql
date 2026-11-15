select id, project_id, title, root_path, status, created_at, updated_at
         from manuscripts
         order by case status when 'active' then 0 else 1 end, updated_at desc, id desc
