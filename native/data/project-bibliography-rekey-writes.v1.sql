insert into manuscript_citation_key_writes values (?1,?2) on conflict(manuscript_id) do update set payload_json=excluded.payload_json
