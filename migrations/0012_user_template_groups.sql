CREATE TABLE IF NOT EXISTS ews_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO ews_groups (id, name, status, created_by)
VALUES ('default', '默认分组', 'active', 'system');

ALTER TABLE ews_users ADD COLUMN group_id TEXT NOT NULL DEFAULT 'default';
UPDATE ews_users SET group_id = 'default' WHERE group_id = '';
CREATE INDEX IF NOT EXISTS idx_ews_users_group ON ews_users(group_id, role, is_active);

CREATE TABLE IF NOT EXISTS ews_shopee_template_groups (
  profile_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  assigned_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (profile_id, group_id),
  FOREIGN KEY (profile_id) REFERENCES ews_shopee_template_profiles(id) ON DELETE CASCADE,
  FOREIGN KEY (group_id) REFERENCES ews_groups(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_shopee_template_groups_group ON ews_shopee_template_groups(group_id, profile_id);

INSERT OR IGNORE INTO ews_shopee_template_groups (profile_id, group_id, assigned_by)
SELECT id, 'default', 'system' FROM ews_shopee_template_profiles;
