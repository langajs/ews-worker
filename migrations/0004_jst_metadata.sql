ALTER TABLE ews_jst_tasks ADD COLUMN source_brief TEXT NOT NULL DEFAULT '';
ALTER TABLE ews_jst_sub_tasks ADD COLUMN recommended_copy TEXT NOT NULL DEFAULT '';
ALTER TABLE ews_jst_sub_tasks ADD COLUMN description TEXT NOT NULL DEFAULT '';

UPDATE ews_jst_tasks
SET source_brief=description
WHERE source_brief='' AND description<>'';
