with hits as ({{hits}}),matches as (select manuscript_id,relative_path from hits group by manuscript_id,relative_path having count(distinct term)={{count}})
 select c.id,c.title,c.source_label,c.updated_at,c.status,c.manuscript_id,c.relative_path,coalesce(substr(b.search_text,1,240),'') as snippet
 from matches m cross join writing_note_catalog c on c.manuscript_id=m.manuscript_id and c.relative_path=m.relative_path
 left join writing_note_catalog_body b on b.manuscript_id=c.manuscript_id and b.relative_path=c.relative_path
 where c.state='ready' order by c.source_down asc,c.id limit ?4
