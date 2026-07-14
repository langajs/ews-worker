ALTER TABLE ews_jst_push_plans ADD COLUMN user_id TEXT NOT NULL DEFAULT '';
ALTER TABLE ews_jst_push_plans ADD COLUMN is_image INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ews_shopee_push_plans ADD COLUMN user_id TEXT NOT NULL DEFAULT '';
ALTER TABLE ews_shopee_push_plans ADD COLUMN is_image INTEGER NOT NULL DEFAULT 0;

UPDATE ews_jst_push_plans
SET user_id = COALESCE((SELECT user_id FROM ews_tasks WHERE id = ews_jst_push_plans.task_id), '')
WHERE user_id = '';
UPDATE ews_shopee_push_plans
SET user_id = COALESCE((SELECT user_id FROM ews_tasks WHERE id = ews_shopee_push_plans.task_id), '')
WHERE user_id = '';

UPDATE ews_jst_push_plans
SET is_image = CASE
  WHEN webhook_type IN ('main', 'main_1')
    OR webhook_type GLOB 'sub_[0-9]*'
    OR webhook_type GLOB 'detail_[0-9]*'
    OR webhook_type GLOB 'sku_[0-9]*'
  THEN 1 ELSE 0 END;
UPDATE ews_shopee_push_plans
SET is_image = CASE
  WHEN webhook_type IN ('main', 'main_1')
    OR webhook_type GLOB 'sub_[0-9]*'
    OR webhook_type GLOB 'detail_[0-9]*'
    OR webhook_type GLOB 'sku_[0-9]*'
  THEN 1 ELSE 0 END;

CREATE INDEX IF NOT EXISTS idx_jst_plans_user_active
  ON ews_jst_push_plans(user_id, status, is_image);
CREATE INDEX IF NOT EXISTS idx_shopee_plans_user_active
  ON ews_shopee_push_plans(user_id, status, is_image);

CREATE TABLE IF NOT EXISTS ews_queue_scheduler_state (
  state_key TEXT PRIMARY KEY,
  state_value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO ews_queue_scheduler_state (state_key, state_value)
VALUES ('push_plan_last_user', '');
