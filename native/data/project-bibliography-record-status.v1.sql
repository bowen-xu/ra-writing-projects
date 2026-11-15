insert into managed_bibliographies (
             manuscript_id, relative_path, content_hash, status, generated_at, projection_version
         ) values (
             ?1, ?4, ?2, ?3,
             case when ?2 is null then null else strftime('%Y-%m-%dT%H:%M:%fZ', 'now') end, 1
         ) on conflict(manuscript_id) do update set
             relative_path = excluded.relative_path,
             content_hash = excluded.content_hash,
             status = excluded.status,
             generated_at = case when excluded.content_hash is null
                 then managed_bibliographies.generated_at else excluded.generated_at end
