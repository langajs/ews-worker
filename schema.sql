-- EWS 聚合系统 - 完整数据库建表脚本
-- 三层命名：ews_(共享) / ews_jst_(聚水潭) / ews_shopee_(虾皮)

-- ====================================================================
-- 共享层 ews_
-- ====================================================================

-- 分平台配置表
CREATE TABLE IF NOT EXISTS ews_config (
  key TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',  -- ''(通用) / 'jst' / 'shopee'
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (key, platform)
);

INSERT OR IGNORE INTO ews_config (key, value, platform) VALUES ('jwt_secret_name', 'ews_jwt_secret_v1', '');
INSERT OR IGNORE INTO ews_config (key, value, platform) VALUES ('r2_public_url', 'https://oss.langaj.work', '');
INSERT OR IGNORE INTO ews_config (key, value, platform) VALUES ('admin_password', '$2a$10$EWS_DEFAULT_HASH', '');
INSERT OR IGNORE INTO ews_config (key, value, platform) VALUES ('callback_secret', '', '');
INSERT OR IGNORE INTO ews_config (key, value, platform) VALUES ('push_global_max_active', '20', '');
INSERT OR IGNORE INTO ews_config (key, value, platform) VALUES ('push_primary_images_only', 'false', '');
INSERT OR IGNORE INTO ews_config (key, value, platform) VALUES ('push_release_per_minute', '6', '');
INSERT OR IGNORE INTO ews_config (key, value, platform) VALUES ('push_release_per_task_per_minute', '2', '');
INSERT OR IGNORE INTO ews_config (key, value, platform) VALUES ('push_plan_timeout_minutes', '20', '');
INSERT OR IGNORE INTO ews_config (key, value, platform) VALUES ('image_queue_max_active', '6', '');
INSERT OR IGNORE INTO ews_config (key, value, platform) VALUES ('image_queue_batch_size', '6', '');

-- JST 默认配置
INSERT OR IGNORE INTO ews_config (key, value, platform) VALUES ('n8n_title_webhook', '', 'jst');
INSERT OR IGNORE INTO ews_config (key, value, platform) VALUES ('n8n_sku_title_webhook', '', 'jst');
INSERT OR IGNORE INTO ews_config (key, value, platform) VALUES ('n8n_main_webhook', '', 'jst');
INSERT OR IGNORE INTO ews_config (key, value, platform) VALUES ('n8n_sub_image_webhook', '', 'jst');
INSERT OR IGNORE INTO ews_config (key, value, platform) VALUES ('n8n_detail_webhook', '', 'jst');
INSERT OR IGNORE INTO ews_config (key, value, platform) VALUES ('n8n_sku_image_webhook', '', 'jst');
INSERT OR IGNORE INTO ews_config (key, value, platform) VALUES ('n8n_title_enabled', 'true', 'jst');
INSERT OR IGNORE INTO ews_config (key, value, platform) VALUES ('n8n_sku_title_enabled', 'true', 'jst');
INSERT OR IGNORE INTO ews_config (key, value, platform) VALUES ('n8n_sku_image_enabled', 'true', 'jst');
INSERT OR IGNORE INTO ews_config (key, value, platform) VALUES ('push_batch_size', '20', 'jst');

-- Shopee 默认配置
INSERT OR IGNORE INTO ews_config (key, value, platform) VALUES ('n8n_title_webhook', '', 'shopee');
INSERT OR IGNORE INTO ews_config (key, value, platform) VALUES ('n8n_main_webhook', '', 'shopee');
INSERT OR IGNORE INTO ews_config (key, value, platform) VALUES ('n8n_sub_image_webhook', '', 'shopee');
INSERT OR IGNORE INTO ews_config (key, value, platform) VALUES ('n8n_sku_image_webhook', '', 'shopee');
INSERT OR IGNORE INTO ews_config (key, value, platform) VALUES ('n8n_title_enabled', 'true', 'shopee');
INSERT OR IGNORE INTO ews_config (key, value, platform) VALUES ('n8n_sku_image_enabled', 'true', 'shopee');
INSERT OR IGNORE INTO ews_config (key, value, platform) VALUES ('push_batch_size', '20', 'shopee');

-- 共享用户表
CREATE TABLE IF NOT EXISTS ews_users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',      -- admin / user
  display_name TEXT DEFAULT '',
  platform_access TEXT NOT NULL DEFAULT 'allow', -- allow / jst / shopee
  webhook_config TEXT DEFAULT '{}',       -- JSON: {"jst":{...}, "shopee":{...}}
  is_active INTEGER NOT NULL DEFAULT 1,
  credits INTEGER NOT NULL DEFAULT 200,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT DEFAULT ''
);
INSERT OR IGNORE INTO ews_users (id, username, password_hash, role, created_by)
  VALUES ('admin', 'admin', '$2a$10$EWS_DEFAULT_HASH', 'admin', 'system');

-- 统一任务索引表
CREATE TABLE IF NOT EXISTS ews_tasks (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,           -- 'jst' / 'shopee'
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'init',  -- init / pending / processing / completed / failed
  user_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ews_tasks_platform ON ews_tasks(platform);
CREATE INDEX IF NOT EXISTS idx_ews_tasks_user ON ews_tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_ews_tasks_created ON ews_tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ews_tasks_user_created ON ews_tasks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ews_tasks_platform_created ON ews_tasks(platform, created_at DESC);

-- 共享回调队列：工作流回调先入队备份，处理成功后删除，失败保留重试/排查
CREATE TABLE IF NOT EXISTS ews_callback_queue (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending / processing / failed
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT DEFAULT '',
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  processing_at TEXT DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_callback_queue_status ON ews_callback_queue(status, received_at);
CREATE INDEX IF NOT EXISTS idx_callback_queue_processing ON ews_callback_queue(status, processing_at);
CREATE INDEX IF NOT EXISTS idx_callback_queue_task ON ews_callback_queue(task_id);

-- 共享图片处理队列：限制图片下载/R2写入并发，成功处理后删除
CREATE TABLE IF NOT EXISTS ews_image_queue (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '',
  sub_task_id TEXT NOT NULL DEFAULT '',
  set_index INTEGER NOT NULL DEFAULT 0,
  image_type TEXT NOT NULL,
  image_position INTEGER NOT NULL DEFAULT 1,
  image_url TEXT DEFAULT '',
  error_message TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', -- pending / processing / failed
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT DEFAULT '',
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  processing_at TEXT DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_image_queue_status ON ews_image_queue(status, received_at);
CREATE INDEX IF NOT EXISTS idx_image_queue_processing ON ews_image_queue(status, processing_at);
CREATE INDEX IF NOT EXISTS idx_image_queue_task ON ews_image_queue(task_id);

-- ====================================================================
-- 聚水潭模块 ews_jst_
-- ====================================================================

-- JST 任务（扩展信息）
CREATE TABLE IF NOT EXISTS ews_jst_tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  topic_items TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '',
  recommended_copy TEXT NOT NULL DEFAULT '',
  product_link TEXT NOT NULL DEFAULT '',
  supplier_name TEXT NOT NULL DEFAULT '',
  main_description TEXT NOT NULL DEFAULT '',
  detail_description TEXT NOT NULL DEFAULT '',
  reference_image TEXT NOT NULL,
  auxiliary_images TEXT NOT NULL DEFAULT '',
  generate_count INTEGER NOT NULL DEFAULT 1,
  stock INTEGER NOT NULL DEFAULT 999,
  weight REAL NOT NULL DEFAULT 1.0,
  variant_count INTEGER NOT NULL DEFAULT 1,
  main_image_count INTEGER NOT NULL DEFAULT 5,
  detail_image_count INTEGER NOT NULL DEFAULT 5,
  product_type TEXT NOT NULL DEFAULT 'one', -- single / one / two
  variation_image_mode TEXT NOT NULL DEFAULT 'option1', -- option1 / none
  mode TEXT NOT NULL DEFAULT 'full',       -- full / dedup
  status TEXT NOT NULL DEFAULT 'pending',
  queue_mode TEXT NOT NULL DEFAULT 'auto',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- JST 子任务（款式编码）
CREATE TABLE IF NOT EXISTS ews_jst_sub_tasks (
  id TEXT PRIMARY KEY,
  parent_task_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  set_index INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (parent_task_id) REFERENCES ews_jst_tasks(id) ON DELETE CASCADE
);

-- JST 变体（二维规格）
CREATE TABLE IF NOT EXISTS ews_jst_variants (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  tier1_name TEXT NOT NULL DEFAULT '',      -- 第一层规格名（如"颜色"）
  tier1_value TEXT NOT NULL,               -- 第一层规格值（如"红色"，旧数据迁移自此）
  tier2_name TEXT NOT NULL DEFAULT '',      -- 第二层规格名（如"尺码"）
  tier2_value TEXT NOT NULL DEFAULT '',     -- 第二层规格值（如"M"）
  sku_image TEXT NOT NULL DEFAULT '',
  price REAL,
  market_price REAL,
  min_distribution_price REAL,
  max_distribution_price REAL,
  stock INTEGER NOT NULL DEFAULT 999,
  sku_code TEXT NOT NULL DEFAULT '',
  price_float_enabled INTEGER NOT NULL DEFAULT 0,
  price_min REAL,
  price_max REAL,
  price_precision INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES ews_jst_tasks(id) ON DELETE CASCADE
);

-- JST SKU 标题
CREATE TABLE IF NOT EXISTS ews_jst_sku_titles (
  id TEXT PRIMARY KEY,
  sub_task_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (sub_task_id) REFERENCES ews_jst_sub_tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (variant_id) REFERENCES ews_jst_variants(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jst_sku_titles_unique ON ews_jst_sku_titles(sub_task_id, variant_id);

-- JST 图片记录
CREATE TABLE IF NOT EXISTS ews_jst_task_images (
  id TEXT PRIMARY KEY,
  parent_task_id TEXT NOT NULL,
  sub_task_id TEXT,
  variant_id TEXT,
  set_index INTEGER NOT NULL,
  image_type TEXT NOT NULL,          -- main / sub / detail / sku
  position INTEGER NOT NULL DEFAULT 1,
  image_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (parent_task_id) REFERENCES ews_jst_tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (sub_task_id) REFERENCES ews_jst_sub_tasks(id) ON DELETE SET NULL,
  FOREIGN KEY (variant_id) REFERENCES ews_jst_variants(id) ON DELETE SET NULL
);

-- JST 推送计划
CREATE TABLE IF NOT EXISTS ews_jst_push_plans (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  sub_task_id TEXT NOT NULL,
  webhook_type TEXT NOT NULL,       -- title / sku_title / main_1 / sub_{pos} / detail_{pos} / sku_{pos}
  webhook_url TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT DEFAULT '',
  batch_order INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  processing_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES ews_jst_tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_jst_plans_status ON ews_jst_push_plans(task_id, status);
CREATE INDEX IF NOT EXISTS idx_jst_plans_processing ON ews_jst_push_plans(status, processing_at);
CREATE INDEX IF NOT EXISTS idx_jst_plans_processing_at ON ews_jst_push_plans(processing_at);

-- JST 导出记录
CREATE TABLE IF NOT EXISTS ews_jst_export_records (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  file_url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES ews_jst_tasks(id) ON DELETE CASCADE
);

-- ====================================================================
-- 虾皮模块 ews_shopee_
-- ====================================================================

-- Shopee 商品
CREATE TABLE IF NOT EXISTS ews_shopee_products (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  category_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  main_description TEXT NOT NULL DEFAULT '',
  reference_title TEXT NOT NULL DEFAULT '',
  reference_image TEXT NOT NULL DEFAULT '',
  auxiliary_images TEXT NOT NULL DEFAULT '[]',
  generate_count INTEGER NOT NULL DEFAULT 1,
  mode TEXT NOT NULL DEFAULT 'full',
  main_image_count INTEGER NOT NULL DEFAULT 9,
  detail_image_count INTEGER NOT NULL DEFAULT 0,
  parent_sku TEXT NOT NULL DEFAULT '',
  cover_image TEXT NOT NULL DEFAULT '',
  images TEXT NOT NULL DEFAULT '[]',         -- JSON: 商品图片 URL 数组
  weight_kg REAL NOT NULL DEFAULT 0,
  length_cm REAL,
  width_cm REAL,
  height_cm REAL,
  gtin TEXT NOT NULL DEFAULT '',
  brand_id TEXT NOT NULL DEFAULT '',
  hs_code TEXT NOT NULL DEFAULT '',
  tax_code TEXT NOT NULL DEFAULT '',
  origin_country TEXT NOT NULL DEFAULT '',
  variation_name1 TEXT NOT NULL DEFAULT '',  -- 第一层规格名
  variation_name2 TEXT NOT NULL DEFAULT '',  -- 第二层规格名
  variation_image_mode TEXT NOT NULL DEFAULT 'option1', -- option1 / none
  source_brief TEXT NOT NULL DEFAULT '',
  product_type TEXT NOT NULL DEFAULT 'one', -- single / one / two
  variation_name1_export TEXT NOT NULL DEFAULT '',
  variation_name2_export TEXT NOT NULL DEFAULT '',
  max_purchase_qty INTEGER,
  max_purchase_start_date TEXT NOT NULL DEFAULT '',
  max_purchase_period_days INTEGER,
  max_purchase_end_date TEXT NOT NULL DEFAULT '',
  size_chart_template_id TEXT NOT NULL DEFAULT '',
  size_chart_image TEXT NOT NULL DEFAULT '',
  pre_order_dts INTEGER,
  shipping_channels TEXT NOT NULL DEFAULT '["50052"]',  -- JSON: 默认启用 SPX
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES ews_tasks(id) ON DELETE CASCADE
);

-- Shopee 变体（二维规格）
CREATE TABLE IF NOT EXISTS ews_shopee_variations (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  integration_no TEXT NOT NULL,         -- 变体集成号（同一商品一致）
  option1 TEXT NOT NULL,                -- 第一层规格值
  option1_export TEXT NOT NULL DEFAULT '',
  image_per_variation TEXT NOT NULL DEFAULT '',
  option2 TEXT NOT NULL DEFAULT '',     -- 第二层规格值
  option2_export TEXT NOT NULL DEFAULT '',
  image_2 TEXT NOT NULL DEFAULT '',
  price REAL NOT NULL,
  price_float_enabled INTEGER NOT NULL DEFAULT 0,
  price_min REAL,
  price_max REAL,
  price_precision INTEGER NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 999,
  sku TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (product_id) REFERENCES ews_shopee_products(id) ON DELETE CASCADE
);

-- Shopee 子任务（款式编码，对标 JST sub_tasks）
CREATE TABLE IF NOT EXISTS ews_shopee_sub_tasks (
  id TEXT PRIMARY KEY,
  parent_task_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  set_index INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (parent_task_id) REFERENCES ews_tasks(id) ON DELETE CASCADE
);

-- Shopee 图片记录（对标 JST task_images）
CREATE TABLE IF NOT EXISTS ews_shopee_task_images (
  id TEXT PRIMARY KEY,
  parent_task_id TEXT NOT NULL,
  sub_task_id TEXT,
  set_index INTEGER NOT NULL,
  image_type TEXT NOT NULL,    -- main / sub / detail / sku
  position INTEGER NOT NULL DEFAULT 1,
  image_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (parent_task_id) REFERENCES ews_tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (sub_task_id) REFERENCES ews_shopee_sub_tasks(id) ON DELETE SET NULL
);

-- Shopee 推送计划（结构与 JST 一致）
CREATE TABLE IF NOT EXISTS ews_shopee_push_plans (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  sub_task_id TEXT NOT NULL DEFAULT '',
  webhook_type TEXT NOT NULL,           -- title(metadata) / main_1 / sub_{pos} / sku_{pos}
  webhook_url TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT DEFAULT '',
  batch_order INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  processing_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES ews_tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_shopee_plans_status ON ews_shopee_push_plans(task_id, status);
CREATE INDEX IF NOT EXISTS idx_shopee_plans_processing ON ews_shopee_push_plans(status, processing_at);
CREATE INDEX IF NOT EXISTS idx_shopee_plans_processing_at ON ews_shopee_push_plans(processing_at);

-- Shopee 导出记录
CREATE TABLE IF NOT EXISTS ews_shopee_export_records (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  file_url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES ews_tasks(id) ON DELETE CASCADE
);
