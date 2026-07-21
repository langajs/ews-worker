CREATE TABLE IF NOT EXISTS ews_shopee_template_profiles (
  id TEXT PRIMARY KEY,
  market TEXT NOT NULL DEFAULT 'VN',
  store_context_id TEXT NOT NULL,
  profile_code TEXT NOT NULL,
  system_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_review',
  current_version_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_shopee_template_profiles_context
  ON ews_shopee_template_profiles(market, store_context_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shopee_template_profiles_code
  ON ews_shopee_template_profiles(profile_code);
CREATE INDEX IF NOT EXISTS idx_shopee_template_profiles_status
  ON ews_shopee_template_profiles(status, updated_at);

CREATE TABLE IF NOT EXISTS ews_shopee_template_versions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  filename TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  schema_hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  template_type TEXT NOT NULL DEFAULT 'basic',
  field_count INTEGER NOT NULL DEFAULT 0,
  logistics_count INTEGER NOT NULL DEFAULT 0,
  category_count INTEGER NOT NULL DEFAULT 0,
  manifest_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_review',
  has_sensitive_data INTEGER NOT NULL DEFAULT 0,
  sensitive_summary TEXT NOT NULL DEFAULT '[]',
  approved_by TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  FOREIGN KEY (profile_id) REFERENCES ews_shopee_template_profiles(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_shopee_template_versions_hash
  ON ews_shopee_template_versions(profile_id, sha256);
CREATE INDEX IF NOT EXISTS idx_shopee_template_versions_profile_status
  ON ews_shopee_template_versions(profile_id, status, created_at);

CREATE TABLE IF NOT EXISTS ews_shopee_template_user_meta (
  profile_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  alias TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  is_favorite INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (profile_id, user_id),
  FOREIGN KEY (profile_id) REFERENCES ews_shopee_template_profiles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_shopee_template_user_meta_user
  ON ews_shopee_template_user_meta(user_id, is_favorite, updated_at);

CREATE TABLE IF NOT EXISTS ews_shopee_template_fields (
  version_id TEXT NOT NULL,
  token TEXT NOT NULL,
  column_index INTEGER NOT NULL,
  column_name TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  requirement TEXT NOT NULL DEFAULT '',
  data_type TEXT NOT NULL DEFAULT 'string',
  semantic_key TEXT NOT NULL DEFAULT '',
  mapping_status TEXT NOT NULL DEFAULT 'unmapped_optional',
  is_required INTEGER NOT NULL DEFAULT 0,
  mapped_by TEXT,
  mapped_at TEXT,
  PRIMARY KEY (version_id, token),
  FOREIGN KEY (version_id) REFERENCES ews_shopee_template_versions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_shopee_template_fields_mapping
  ON ews_shopee_template_fields(version_id, mapping_status);

CREATE TABLE IF NOT EXISTS ews_shopee_template_version_categories (
  version_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  category_name TEXT NOT NULL,
  dts_range TEXT NOT NULL DEFAULT '',
  dts_min INTEGER,
  dts_max INTEGER,
  PRIMARY KEY (version_id, category_id),
  FOREIGN KEY (version_id) REFERENCES ews_shopee_template_versions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_shopee_template_version_categories_lookup
  ON ews_shopee_template_version_categories(version_id, category_name);

INSERT OR IGNORE INTO ews_shopee_template_profiles
  (id, market, store_context_id, profile_code, system_name, status, created_by, created_at, updated_at)
SELECT
  'shp-vn-' || s.template_context_id,
  'VN',
  s.template_context_id,
  'SHP-VN-' || s.template_context_id,
  'SHP-VN-' || s.template_context_id,
  'active',
  MIN(s.user_id),
  MIN(s.created_at),
  MAX(s.updated_at)
FROM ews_shopee_stores s
GROUP BY s.template_context_id;

INSERT OR IGNORE INTO ews_shopee_template_versions
  (id, profile_id, uploaded_by, filename, r2_key, sha256, schema_hash, signature, template_type,
   field_count, logistics_count, category_count, manifest_json, status, has_sensitive_data,
   sensitive_summary, approved_by, approved_at, created_at)
SELECT
  t.id,
  p.id,
  t.user_id,
  t.filename,
  t.r2_key,
  t.sha256,
  'legacy:' || t.signature,
  t.signature,
  t.template_type,
  t.field_count,
  COALESCE(json_array_length(t.manifest_json, '$.shipping_channels'), 0),
  t.category_count,
  t.manifest_json,
  'ready',
  0,
  '[]',
  t.user_id,
  t.created_at,
  t.created_at
FROM ews_shopee_store_templates t
JOIN ews_shopee_stores s ON s.id = t.store_id
JOIN ews_shopee_template_profiles p
  ON p.market = 'VN' AND p.store_context_id = s.template_context_id
ORDER BY t.created_at ASC;

INSERT OR IGNORE INTO ews_shopee_template_version_categories
  (version_id, category_id, category_name, dts_range, dts_min, dts_max)
SELECT c.template_id, c.category_id, c.category_name, c.dts_range, c.dts_min, c.dts_max
FROM ews_shopee_template_categories c
JOIN ews_shopee_template_versions v ON v.id = c.template_id;

WITH parsed_fields AS (
  SELECT
    v.id AS version_id,
    json_extract(field.value, '$.token') AS token,
    CAST(json_extract(field.value, '$.column') AS INTEGER) AS column_index,
    json_extract(field.value, '$.column_name') AS column_name,
    COALESCE(json_extract(field.value, '$.label'), '') AS label,
    COALESCE(json_extract(field.value, '$.requirement'), '') AS requirement,
    CASE
      WHEN instr(json_extract(field.value, '$.token'), '|') > 0
      THEN substr(json_extract(field.value, '$.token'), 1, instr(json_extract(field.value, '$.token'), '|') - 1)
      ELSE json_extract(field.value, '$.token')
    END AS token_key
  FROM ews_shopee_template_versions v, json_each(v.manifest_json, '$.fields') field
)
INSERT OR IGNORE INTO ews_shopee_template_fields
  (version_id, token, column_index, column_name, label, requirement, data_type,
   semantic_key, mapping_status, is_required)
SELECT
  version_id,
  token,
  column_index,
  column_name,
  label,
  requirement,
  CASE WHEN token_key IN (
    'ps_category','ps_price','ps_stock','ps_weight','ps_length','ps_width','ps_height','ps_product_pre_order_dts'
  ) THEN 'number' ELSE 'string' END,
  CASE WHEN token_key IN (
    'ps_category','ps_product_name','ps_product_description','ps_sku_parent_short',
    'et_title_variation_integration_no','et_title_variation_1','et_title_option_for_variation_1',
    'et_title_image_per_variation','et_title_variation_2','et_title_option_for_variation_2',
    'ps_price','ps_stock','ps_sku_short','ps_new_size_chart','et_title_size_chart','ps_gtin_code',
    'ps_item_cover_image','ps_item_image_1','ps_item_image_2','ps_item_image_3','ps_item_image_4',
    'ps_item_image_5','ps_item_image_6','ps_item_image_7','ps_item_image_8',
    'ps_weight','ps_length','ps_width','ps_height','ps_product_pre_order_dts','et_title_reason'
  ) OR token_key GLOB 'channel_id.[0-9]*' THEN token_key ELSE '' END,
  CASE WHEN token_key IN (
    'ps_category','ps_product_name','ps_product_description','ps_sku_parent_short',
    'et_title_variation_integration_no','et_title_variation_1','et_title_option_for_variation_1',
    'et_title_image_per_variation','et_title_variation_2','et_title_option_for_variation_2',
    'ps_price','ps_stock','ps_sku_short','ps_new_size_chart','et_title_size_chart','ps_gtin_code',
    'ps_item_cover_image','ps_item_image_1','ps_item_image_2','ps_item_image_3','ps_item_image_4',
    'ps_item_image_5','ps_item_image_6','ps_item_image_7','ps_item_image_8',
    'ps_weight','ps_length','ps_width','ps_height','ps_product_pre_order_dts','et_title_reason'
  ) OR token_key GLOB 'channel_id.[0-9]*' THEN 'mapped'
    WHEN lower(requirement) LIKE '%mandatory%' THEN 'unmapped_required'
    ELSE 'unmapped_optional' END,
  CASE WHEN lower(requirement) LIKE '%mandatory%' THEN 1 ELSE 0 END
FROM parsed_fields;

INSERT OR IGNORE INTO ews_shopee_template_user_meta
  (profile_id, user_id, alias, note, is_favorite, created_at, updated_at)
SELECT p.id, s.user_id, s.name, '', 0, s.created_at, s.updated_at
FROM ews_shopee_stores s
JOIN ews_shopee_template_profiles p
  ON p.market = 'VN' AND p.store_context_id = s.template_context_id;

UPDATE ews_shopee_template_profiles
SET current_version_id = (
  SELECT v.id FROM ews_shopee_template_versions v
  WHERE v.profile_id = ews_shopee_template_profiles.id AND v.status = 'ready'
  ORDER BY datetime(v.created_at) DESC, v.id DESC LIMIT 1
)
WHERE current_version_id IS NULL;

ALTER TABLE ews_shopee_products ADD COLUMN template_profile_id TEXT NOT NULL DEFAULT '';
ALTER TABLE ews_shopee_products ADD COLUMN template_version_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_shopee_products_template_profile
  ON ews_shopee_products(template_profile_id);
CREATE INDEX IF NOT EXISTS idx_shopee_products_template_version
  ON ews_shopee_products(template_version_id);

UPDATE ews_shopee_products
SET template_profile_id = COALESCE((
  SELECT p.id
  FROM ews_shopee_stores s
  JOIN ews_shopee_template_profiles p
    ON p.market = 'VN' AND p.store_context_id = s.template_context_id
  WHERE s.id = ews_shopee_products.store_id
), '')
WHERE template_profile_id = '' AND store_id <> '';

UPDATE ews_shopee_products
SET template_version_id = COALESCE((
  SELECT p.current_version_id
  FROM ews_shopee_template_profiles p
  WHERE p.id = ews_shopee_products.template_profile_id
), '')
WHERE template_version_id = '' AND template_profile_id <> '';
