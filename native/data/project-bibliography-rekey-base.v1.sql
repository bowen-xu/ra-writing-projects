insert into manuscript_citation_key_bases values (?1,?2,?3) on conflict(manuscript_id,reference_id) do update set base_key=excluded.base_key
