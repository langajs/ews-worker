ALTER TABLE ews_shopee_products ADD COLUMN dimension_mode TEXT NOT NULL DEFAULT 'global';
ALTER TABLE ews_shopee_variations ADD COLUMN length_cm REAL;
ALTER TABLE ews_shopee_variations ADD COLUMN width_cm REAL;
ALTER TABLE ews_shopee_variations ADD COLUMN height_cm REAL;
