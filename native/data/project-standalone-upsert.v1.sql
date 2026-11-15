insert into research_projects (id, title, summary, created_at)
         values (?1, '论文写作', '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         on conflict(id) do nothing
