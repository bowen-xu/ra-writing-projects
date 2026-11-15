select w.projection_version,n.collation_version,n.time_version from writing_note_catalog_state w cross join note_catalog_order_state n where w.id=1 and n.id=1
