DELETE FROM ews_config
WHERE platform = 'jst'
  AND key IN ('n8n_sku_title_webhook', 'n8n_sku_title_enabled');

DELETE FROM ews_jst_push_plans
WHERE webhook_type = 'sku_title';

DELETE FROM ews_shopee_push_plans
WHERE webhook_type = 'sku_title';
