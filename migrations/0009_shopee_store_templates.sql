CREATE TABLE IF NOT EXISTS ews_shopee_stores (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  template_context_id TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_shopee_stores_user_context
  ON ews_shopee_stores(user_id, template_context_id);
CREATE INDEX IF NOT EXISTS idx_shopee_stores_user_active
  ON ews_shopee_stores(user_id, is_active);

CREATE TABLE IF NOT EXISTS ews_shopee_store_templates (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  signature TEXT NOT NULL,
  template_type TEXT NOT NULL DEFAULT 'basic',
  field_count INTEGER NOT NULL DEFAULT 0,
  category_count INTEGER NOT NULL DEFAULT 0,
  manifest_json TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (store_id) REFERENCES ews_shopee_stores(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_shopee_templates_store_hash
  ON ews_shopee_store_templates(store_id, sha256);
CREATE INDEX IF NOT EXISTS idx_shopee_templates_store_active
  ON ews_shopee_store_templates(store_id, is_active);

CREATE TABLE IF NOT EXISTS ews_shopee_template_categories (
  template_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  category_name TEXT NOT NULL,
  dts_range TEXT NOT NULL DEFAULT '',
  dts_min INTEGER,
  dts_max INTEGER,
  PRIMARY KEY (template_id, category_id),
  FOREIGN KEY (template_id) REFERENCES ews_shopee_store_templates(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_shopee_template_categories_lookup
  ON ews_shopee_template_categories(template_id, category_name);

ALTER TABLE ews_shopee_products ADD COLUMN store_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_shopee_products_store ON ews_shopee_products(store_id);
