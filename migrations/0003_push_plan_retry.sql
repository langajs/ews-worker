ALTER TABLE ews_jst_push_plans ADD COLUMN next_retry_at TEXT NOT NULL DEFAULT '';
ALTER TABLE ews_shopee_push_plans ADD COLUMN next_retry_at TEXT NOT NULL DEFAULT '';
ALTER TABLE ews_image_queue ADD COLUMN error_retryable INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_jst_plans_retry_due
  ON ews_jst_push_plans(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_shopee_plans_retry_due
  ON ews_shopee_push_plans(status, next_retry_at);

INSERT INTO ews_config (key, value, platform, updated_at)
VALUES ('push_plan_timeout_minutes', '15', '', datetime('now'))
ON CONFLICT(key, platform) DO UPDATE SET value='15', updated_at=datetime('now');
