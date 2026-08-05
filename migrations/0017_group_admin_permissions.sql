ALTER TABLE ews_groups ADD COLUMN callback_secret TEXT NOT NULL DEFAULT '';

ALTER TABLE ews_tasks ADD COLUMN group_id TEXT NOT NULL DEFAULT 'default';

UPDATE ews_tasks
SET group_id = COALESCE((
  SELECT u.group_id FROM ews_users u WHERE u.username = ews_tasks.user_id
), 'default');

CREATE INDEX IF NOT EXISTS idx_ews_tasks_group ON ews_tasks(group_id);

UPDATE ews_groups
SET callback_secret = COALESCE((
  SELECT value FROM ews_config WHERE key = 'callback_secret' AND platform = ''
), '')
WHERE callback_secret = '';

DELETE FROM ews_config WHERE key = 'callback_secret' AND platform = '';

UPDATE ews_users
SET role = 'group_admin'
WHERE role = 'admin' AND id <> 'admin';
