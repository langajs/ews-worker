DROP TABLE IF EXISTS ews_shopee_template_categories;
DROP TABLE IF EXISTS ews_shopee_store_templates;
DROP TABLE IF EXISTS ews_shopee_stores;

INSERT OR IGNORE INTO ews_queue_scheduler_state (state_key, state_value)
VALUES ('task_cleanup_lease', '');

INSERT OR IGNORE INTO ews_queue_scheduler_state (state_key, state_value)
VALUES ('task_cleanup_last_success', '');
