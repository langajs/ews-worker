ALTER TABLE ews_shopee_variations ADD COLUMN weight_kg REAL NOT NULL DEFAULT 0.2;

UPDATE ews_shopee_variations
SET weight_kg = COALESCE(
  NULLIF((SELECT weight_kg FROM ews_shopee_products WHERE id = ews_shopee_variations.product_id), 0),
  0.2
);

UPDATE ews_jst_tasks
SET variation_image_mode = CASE
  WHEN variation_image_mode = 'option1' THEN 'ai'
  WHEN variation_image_mode = 'ai' THEN 'ai'
  ELSE 'upload'
END
WHERE product_type <> 'single';

UPDATE ews_shopee_products
SET variation_image_mode = CASE
  WHEN variation_image_mode = 'option1' THEN 'ai'
  WHEN variation_image_mode = 'ai' THEN 'ai'
  ELSE 'upload'
END
WHERE product_type <> 'single';
