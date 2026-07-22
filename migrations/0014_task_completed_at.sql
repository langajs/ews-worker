ALTER TABLE ews_tasks ADD COLUMN completed_at TEXT;

UPDATE ews_tasks
SET completed_at = updated_at
WHERE status = 'completed' AND (completed_at IS NULL OR completed_at = '');

CREATE INDEX IF NOT EXISTS idx_ews_tasks_completed ON ews_tasks(completed_at DESC);
