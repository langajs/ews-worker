UPDATE ews_shopee_template_versions
SET status = 'ready',
    approved_by = COALESCE(approved_by, uploaded_by),
    approved_at = COALESCE(approved_at, datetime('now'))
WHERE status = 'pending_review'
  AND NOT EXISTS (
    SELECT 1
    FROM ews_shopee_template_fields f
    WHERE f.version_id = ews_shopee_template_versions.id
      AND f.mapping_status = 'unmapped_required'
  );

UPDATE ews_shopee_template_profiles
SET current_version_id = (
      SELECT v.id
      FROM ews_shopee_template_versions v
      WHERE v.profile_id = ews_shopee_template_profiles.id
        AND v.status = 'ready'
        AND v.deleted_at IS NULL
      ORDER BY datetime(v.created_at) DESC, v.id DESC
      LIMIT 1
    ),
    status = 'active',
    updated_at = datetime('now')
WHERE status NOT IN ('disabled', 'deleted')
  AND EXISTS (
    SELECT 1
    FROM ews_shopee_template_versions v
    WHERE v.profile_id = ews_shopee_template_profiles.id
      AND v.status = 'ready'
      AND v.deleted_at IS NULL
  );
