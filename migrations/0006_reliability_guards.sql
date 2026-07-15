INSERT INTO ews_config (key, value, platform, updated_at)
VALUES ('push_plan_timeout_minutes', '20', '', datetime('now'))
ON CONFLICT(key, platform) DO UPDATE SET
  value = CASE
    WHEN CAST(ews_config.value AS INTEGER) < 20 THEN '20'
    ELSE ews_config.value
  END,
  updated_at = datetime('now');
