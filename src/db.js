// EWS - 数据库操作模块（分平台）
async function query(env, sql, params = []) {
  const result = await env.DB.prepare(sql).bind(...params).all();
  return result;
}
async function getOne(env, sql, params = []) {
  return await env.DB.prepare(sql).bind(...params).first();
}

// ==================== 共享层 ews_ ====================
async function getConfig(env, platform = '') {
  try {
    const rows = await query(env, "SELECT key, value FROM ews_config WHERE platform = ?", [platform]);
    const config = {};
    for (const row of rows.results) config[row.key] = row.value;
    if (!platform) return config;
    const common = await getConfig(env, '');
    return { ...common, ...config };
  } catch { return {}; }
}
async function updateConfig(env, key, value, platform = '') {
  await env.DB.prepare("INSERT INTO ews_config (key, value, platform, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(key, platform) DO UPDATE SET value = ?, updated_at = datetime('now')").bind(key, value, platform, value).run();
}
async function getPlatformConfig(env, platform) { return getConfig(env, platform); }

let userColumnsReady = false;
const DEFAULT_USER_IMAGE_CONCURRENCY = 20;
const MAX_USER_IMAGE_CONCURRENCY = 20;
async function ensureUserColumns(env) {
  if (userColumnsReady) return;
  try { await env.DB.prepare("ALTER TABLE ews_users ADD COLUMN platform_access TEXT NOT NULL DEFAULT 'allow'").run(); } catch (_) {}
  try { await env.DB.prepare("ALTER TABLE ews_users ADD COLUMN image_concurrency_limit INTEGER NOT NULL DEFAULT 20").run(); } catch (_) {}
  userColumnsReady = true;
}
function normalizePlatformAccess(value) {
  return ['allow','jst','shopee'].includes(value) ? value : 'allow';
}
function normalizeUserImageConcurrencyLimit(value) {
  const limit = parseInt(value);
  if (!Number.isInteger(limit) || limit < 1) return DEFAULT_USER_IMAGE_CONCURRENCY;
  return Math.min(limit, MAX_USER_IMAGE_CONCURRENCY);
}
async function createUser(env, user) { await ensureUserColumns(env); await env.DB.prepare("INSERT INTO ews_users (id, username, password_hash, role, display_name, platform_access, image_concurrency_limit, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(user.id, user.username, user.password_hash, user.role || 'user', user.display_name || '', normalizePlatformAccess(user.platform_access), normalizeUserImageConcurrencyLimit(user.image_concurrency_limit), user.created_by || '').run(); }
async function getUserByUsername(env, username) { await ensureUserColumns(env); return await getOne(env, "SELECT * FROM ews_users WHERE username = ?", [username]); }
async function getUserList(env) { await ensureUserColumns(env); return await query(env, "SELECT id, username, role, display_name, platform_access, image_concurrency_limit, is_active, credits, created_at FROM ews_users ORDER BY created_at ASC"); }
async function updateUserPassword(env, userId, pw) { await env.DB.prepare("UPDATE ews_users SET password_hash = ? WHERE id = ?").bind(pw, userId).run(); }
async function toggleUserActive(env, userId, a) { await env.DB.prepare("UPDATE ews_users SET is_active = ? WHERE id = ?").bind(a ? 1 : 0, userId).run(); }
async function deleteUser(env, userId) { await env.DB.prepare("DELETE FROM ews_users WHERE id = ?").bind(userId).run(); }
async function updateUserPlatformAccess(env, userId, access) { await ensureUserColumns(env); await env.DB.prepare("UPDATE ews_users SET platform_access = ? WHERE id = ?").bind(normalizePlatformAccess(access), userId).run(); }
async function updateUserImageConcurrencyLimit(env, userId, limit) { await ensureUserColumns(env); await env.DB.prepare("UPDATE ews_users SET image_concurrency_limit = ? WHERE id = ?").bind(normalizeUserImageConcurrencyLimit(limit), userId).run(); }
async function updateUserWebhook(env, userId, cfg) { await env.DB.prepare("UPDATE ews_users SET webhook_config = ? WHERE id = ?").bind(cfg, userId).run(); }
async function getUserCredits(env, userId) { const r = await getOne(env, "SELECT credits FROM ews_users WHERE id = ?", [userId]); return r?.credits ?? 0; }
async function updateUserCredits(env, userId, amount, mode) {
  if (mode === 'set') await env.DB.prepare("UPDATE ews_users SET credits = ? WHERE id = ?").bind(Math.max(0, amount), userId).run();
  else if (mode === 'add') await env.DB.prepare("UPDATE ews_users SET credits = credits + ? WHERE id = ?").bind(amount, userId).run();
  else if (mode === 'subtract') await env.DB.prepare("UPDATE ews_users SET credits = MAX(0, credits - ?) WHERE id = ?").bind(amount, userId).run();
}
async function consumeUserCredit(env, userId) {
  const result = await env.DB.prepare("UPDATE ews_users SET credits = credits - 1 WHERE id = ? AND credits > 0").bind(userId).run();
  const meta = result?.meta || {};
  return (meta.changes ?? meta.rows_written ?? 0) > 0;
}

async function createTaskIndex(env, id, platform, name, userId) { await env.DB.prepare("INSERT INTO ews_tasks (id, platform, name, status, user_id, created_at, updated_at) VALUES (?, ?, ?, 'init', ?, datetime('now'), datetime('now'))").bind(id, platform, name || '', userId || '').run(); }
async function updateTaskIndexStatus(env, id, status) { await env.DB.prepare("UPDATE ews_tasks SET status = ?, updated_at = datetime('now') WHERE id = ?").bind(status, id).run(); }
async function getTaskIndex(env, id) { return await getOne(env, "SELECT * FROM ews_tasks WHERE id = ?", [id]); }
async function getTaskList(env, platform, userId, role, limit = 0, offset = 0) {
  let sql = "SELECT * FROM ews_tasks"; const params = []; const ws = [];
  if (platform) { ws.push("platform = ?"); params.push(platform); }
  if (role !== 'admin') { ws.push("user_id = ?"); params.push(userId); }
  if (ws.length) sql += " WHERE " + ws.join(" AND ");
  sql += " ORDER BY created_at DESC";
  if (limit > 0) { sql += " LIMIT ? OFFSET ?"; params.push(limit, Math.max(0, offset)); }
  return await query(env, sql, params);
}
async function getTaskCount(env, platform, userId, role) {
  let sql = "SELECT COUNT(*) AS cnt FROM ews_tasks"; const params = []; const ws = [];
  if (platform) { ws.push("platform = ?"); params.push(platform); }
  if (role !== 'admin') { ws.push("user_id = ?"); params.push(userId); }
  if (ws.length) sql += " WHERE " + ws.join(" AND ");
  const row = await getOne(env, sql, params);
  return row?.cnt || 0;
}
async function deleteTaskIndex(env, id) { await env.DB.prepare("DELETE FROM ews_tasks WHERE id = ?").bind(id).run(); }

const PRICE_FLOAT_COLUMNS = [
  ['price_float_enabled', "INTEGER NOT NULL DEFAULT 0"],
  ['price_min', "REAL"],
  ['price_max', "REAL"],
  ['price_precision', "INTEGER NOT NULL DEFAULT 0"],
];
const SHOPEE_VARIATION_COLUMNS = [
  ...PRICE_FLOAT_COLUMNS,
  ['option1_export', "TEXT NOT NULL DEFAULT ''"],
  ['option2_export', "TEXT NOT NULL DEFAULT ''"],
];
const JST_TASK_COLUMNS = [
  ['recommended_copy', "TEXT NOT NULL DEFAULT ''"],
  ['product_link', "TEXT NOT NULL DEFAULT ''"],
  ['supplier_name', "TEXT NOT NULL DEFAULT ''"],
  ['product_type', "TEXT NOT NULL DEFAULT 'one'"],
  ['variation_image_mode', "TEXT NOT NULL DEFAULT 'option1'"],
];
const JST_VARIATION_COLUMNS = [
  ...PRICE_FLOAT_COLUMNS,
  ['sku_image', "TEXT NOT NULL DEFAULT ''"],
  ['market_price', 'REAL'],
  ['min_distribution_price', 'REAL'],
  ['max_distribution_price', 'REAL'],
  ['stock', 'INTEGER NOT NULL DEFAULT 999'],
  ['sku_code', "TEXT NOT NULL DEFAULT ''"],
];
let jstTaskColumnsReady = false;
async function ensureJstTaskColumns(env) {
  if (jstTaskColumnsReady) return;
  for (const [name, type] of JST_TASK_COLUMNS) {
    try { await env.DB.prepare(`ALTER TABLE ews_jst_tasks ADD COLUMN ${name} ${type}`).run(); } catch (_) {}
  }
  jstTaskColumnsReady = true;
}
let jstVariantColumnsReady = false;
async function ensureJstVariantColumns(env) {
  if (jstVariantColumnsReady) return;
  for (const [name, type] of JST_VARIATION_COLUMNS) {
    try { await env.DB.prepare(`ALTER TABLE ews_jst_variants ADD COLUMN ${name} ${type}`).run(); } catch (_) {}
  }
  try { await env.DB.prepare("UPDATE ews_jst_variants SET sku_image=white_bg_image WHERE sku_image='' AND white_bg_image<>''").run(); } catch (_) {}
  try { await env.DB.prepare('ALTER TABLE ews_jst_variants DROP COLUMN white_bg_image').run(); } catch (_) {}
  jstVariantColumnsReady = true;
}
let shopeeVariationColumnsReady = false;
async function ensureShopeeVariationColumns(env) {
  if (shopeeVariationColumnsReady) return;
  for (const [name, type] of SHOPEE_VARIATION_COLUMNS) {
    try { await env.DB.prepare(`ALTER TABLE ews_shopee_variations ADD COLUMN ${name} ${type}`).run(); } catch (_) {}
  }
  shopeeVariationColumnsReady = true;
}

// ==================== JST 模块 ====================
async function jstCreateTask(env, t) { await env.DB.prepare("INSERT INTO ews_jst_tasks (id, name, topic_items, description, main_description, detail_description, reference_image, auxiliary_images, generate_count, stock, weight, variant_count, main_image_count, detail_image_count, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))").bind(t.id, t.name ?? '', t.topic_items ?? '', t.description, t.main_description ?? '', t.detail_description ?? '', t.reference_image, t.auxiliary_images ?? '', t.generate_count, t.stock, t.weight, t.variant_count, t.main_image_count ?? 5, t.detail_image_count ?? 5).run(); }
async function jstUpdateTask(env, tid, d) {
  await ensureJstTaskColumns(env);
  await env.DB.prepare("UPDATE ews_jst_tasks SET name=?, topic_items=?, description=?, recommended_copy=?, product_link=?, supplier_name=?, main_description=?, detail_description=?, reference_image=?, auxiliary_images=?, generate_count=?, stock=?, weight=?, variant_count=?, main_image_count=?, detail_image_count=?, product_type=?, variation_image_mode=?, mode=?, status='pending', updated_at=datetime('now') WHERE id=?")
    .bind(d.name ?? '', d.topic_items ?? '', d.description ?? '', d.recommended_copy ?? '', d.product_link ?? '', d.supplier_name ?? '', d.main_description ?? '', d.detail_description ?? '', d.reference_image ?? '', d.auxiliary_images ?? '', d.generate_count ?? 1, d.stock ?? 999, d.weight ?? 1.0, d.variant_count ?? 1, d.main_image_count ?? 5, d.detail_image_count ?? 5, d.product_type ?? 'one', d.variation_image_mode ?? 'option1', d.mode ?? 'full', tid).run();
}
async function jstGetTask(env, tid) {
  const results = await env.DB.batch([
    env.DB.prepare("SELECT * FROM ews_jst_tasks WHERE id = ?").bind(tid),
    env.DB.prepare("SELECT * FROM ews_jst_variants WHERE task_id = ? ORDER BY sort_order").bind(tid),
    env.DB.prepare("SELECT * FROM ews_jst_task_images WHERE parent_task_id = ? ORDER BY set_index,image_type,position").bind(tid),
    env.DB.prepare("SELECT * FROM ews_jst_sub_tasks WHERE parent_task_id = ? ORDER BY set_index").bind(tid),
  ]);
  const t = results[0]?.results?.[0];
  if (!t) return null;
  t.variants = results[1]?.results || [];
  t.images = results[2]?.results || [];
  t.sub_tasks = results[3]?.results || [];
  return t;
}
async function jstUpdateTaskStatus(env, tid, s) { await env.DB.prepare("UPDATE ews_jst_tasks SET status=?, updated_at=datetime('now') WHERE id=?").bind(s, tid).run(); }
async function jstCreateVariant(env, v) { await ensureJstVariantColumns(env); await env.DB.prepare("INSERT INTO ews_jst_variants (id, task_id, tier1_name, tier1_value, tier2_name, tier2_value, sku_image, price, market_price, min_distribution_price, max_distribution_price, stock, sku_code, price_float_enabled, price_min, price_max, price_precision, description, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))").bind(v.id, v.task_id, v.tier1_name || '', v.tier1_value, v.tier2_name || '', v.tier2_value || '', v.sku_image || '', v.price ?? null, v.market_price ?? null, v.min_distribution_price ?? null, v.max_distribution_price ?? null, v.stock ?? 999, v.sku_code || '', v.price_float_enabled ? 1 : 0, v.price_min ?? null, v.price_max ?? null, v.price_precision ?? 0, v.description ?? '', v.sort_order).run(); }
async function jstClearVariants(env, tid) { await env.DB.prepare("DELETE FROM ews_jst_variants WHERE task_id = ?").bind(tid).run(); }
async function jstReplaceVariants(env, tid, variants) {
  await ensureJstVariantColumns(env);
  const statements = [env.DB.prepare("DELETE FROM ews_jst_variants WHERE task_id = ?").bind(tid)];
  for (const v of variants) statements.push(env.DB.prepare("INSERT INTO ews_jst_variants (id, task_id, tier1_name, tier1_value, tier2_name, tier2_value, sku_image, price, market_price, min_distribution_price, max_distribution_price, stock, sku_code, price_float_enabled, price_min, price_max, price_precision, description, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))").bind(v.id, v.task_id, v.tier1_name || '', v.tier1_value, v.tier2_name || '', v.tier2_value || '', v.sku_image || '', v.price ?? null, v.market_price ?? null, v.min_distribution_price ?? null, v.max_distribution_price ?? null, v.stock ?? 999, v.sku_code || '', v.price_float_enabled ? 1 : 0, v.price_min ?? null, v.price_max ?? null, v.price_precision ?? 0, v.description ?? '', v.sort_order));
  await env.DB.batch(statements);
}
async function jstCreateSubTask(env, s) { await env.DB.prepare("INSERT INTO ews_jst_sub_tasks (id, parent_task_id, set_index, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', datetime('now'), '')").bind(s.id, s.parent_task_id, s.set_index).run(); }
async function jstGetSubTasks(env, tid) { return await query(env, "SELECT * FROM ews_jst_sub_tasks WHERE parent_task_id = ? ORDER BY set_index", [tid]); }
async function jstUpdateSubTask(env, sid, d) {
  var sc = []; var p = [];
  if (d.title !== undefined) { sc.push('title = ?'); p.push(d.title); }
  if (d.status !== undefined) { sc.push('status = ?'); p.push(d.status); }
  if (!sc.length) return;
  sc.push("updated_at = datetime('now')"); p.push(sid);
  await env.DB.prepare(`UPDATE ews_jst_sub_tasks SET ${sc.join(', ')} WHERE id = ?`).bind(...p).run();
}
async function jstDeleteSubTasks(env, tid) { await env.DB.prepare("DELETE FROM ews_jst_sub_tasks WHERE parent_task_id = ?").bind(tid).run(); }
async function jstCreateSkuTitle(env, s) { await env.DB.prepare("INSERT OR IGNORE INTO ews_jst_sku_titles (id, sub_task_id, variant_id, title, created_at) VALUES (?, ?, ?, ?, datetime('now'))").bind(s.id, s.sub_task_id, s.variant_id, s.title).run(); }
async function jstSaveImage(env, img) { var pk = img.sub_task_id + '_' + img.image_type + '_' + img.position + '_' + (img.variant_id || ''); await env.DB.prepare("INSERT OR REPLACE INTO ews_jst_task_images (id, parent_task_id, sub_task_id, variant_id, set_index, image_type, position, image_url, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', datetime('now'))").bind(pk, img.parent_task_id, img.sub_task_id, img.variant_id, img.set_index, img.image_type, img.position, img.image_url).run(); }
async function jstClearImages(env, tid) { await env.DB.prepare("DELETE FROM ews_jst_task_images WHERE parent_task_id = ?").bind(tid).run(); }
async function jstCreateExpectedImages(env, tid, sid, si, vc, mode, mic, dic, includeMain = true, includeSub = true, includeDetail = true, includeSku = true) {
  mic = mic || 5; dic = dic || 5;
  var types = [];
  if (mode === 'dedup' && si > 0) {
    if (includeMain) types.push({ type: 'main', pos: 1 });
  }
  else {
    if (includeMain) types.push({ type: 'main', pos: 1 });
    if (includeSub) for (let p = 2; p <= mic; p++) types.push({ type: 'sub', pos: p });
    if (includeDetail) for (let p = 1; p <= dic; p++) types.push({ type: 'detail', pos: p });
    if (includeSku) for (let v = 0; v < vc; v++) types.push({ type: 'sku', pos: v + 1 });
  }
  for (const t of types) { var pk = sid + '_' + t.type + '_' + t.pos + '_'; await env.DB.prepare("INSERT OR IGNORE INTO ews_jst_task_images (id, parent_task_id, sub_task_id, variant_id, set_index, image_type, position, image_url, status, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, '', 'pending', datetime('now'))").bind(pk, tid, sid, si, t.type, t.pos).run(); }
}
async function jstCheckSubTaskImages(env, sid) { var r = await getOne(env, "SELECT COUNT(*) as total, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as done FROM ews_jst_task_images WHERE sub_task_id = ?", [sid]); return { total: r?.total || 0, completed: r?.done || 0 }; }
async function jstCheckParentCompletion(env, tid) {
  var p = await getOne(env, "SELECT SUM(CASE WHEN status IN ('pending','processing') THEN 1 ELSE 0 END) as active, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed FROM ews_jst_push_plans WHERE task_id = ?", [tid]);
  if ((p?.failed || 0) > 0) { var fs = (p?.active || 0) > 0 ? 'partial_failed' : 'failed'; await env.DB.prepare("UPDATE ews_jst_tasks SET status=?, updated_at=datetime('now') WHERE id=?").bind(fs, tid).run(); await updateTaskIndexStatus(env, tid, fs); return; }
  var r = await getOne(env, "SELECT COUNT(*) as total, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as done FROM ews_jst_sub_tasks WHERE parent_task_id = ?", [tid]);
  if (r && r.total > 0 && r.total === r.done && (p?.active || 0) === 0) { await env.DB.prepare("UPDATE ews_jst_tasks SET status='completed', updated_at=datetime('now') WHERE id=?").bind(tid).run(); await updateTaskIndexStatus(env, tid, 'completed'); }
}
async function jstDeleteTaskRecord(env, tid) { await env.DB.prepare("DELETE FROM ews_jst_tasks WHERE id = ?").bind(tid).run(); }
async function jstCreatePushPlans(env, plans) { var s = env.DB.prepare("INSERT INTO ews_jst_push_plans (id, task_id, sub_task_id, webhook_type, webhook_url, payload, status, batch_order, retry_count, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 0, datetime('now'))"); for (const p of plans) await s.bind(p.id, p.task_id, p.sub_task_id, p.webhook_type, p.webhook_url, p.payload, p.batch_order).run(); }
async function jstGetPushPlans(env, tid) { return await query(env, "SELECT * FROM ews_jst_push_plans WHERE task_id = ? ORDER BY batch_order ASC, webhook_type ASC", [tid]); }
async function jstGetPendingPlans(env, tid, lim) { return await query(env, "SELECT * FROM ews_jst_push_plans WHERE task_id = ? AND status='pending' ORDER BY batch_order ASC LIMIT ?", [tid, lim]); }
async function jstUpdatePlanStatus(env, pid, s, e) { await env.DB.prepare("UPDATE ews_jst_push_plans SET status=?, error=? WHERE id=?").bind(s, e || '', pid).run(); }
async function jstGetPlanStats(env, tid) { var r = await query(env, "SELECT status, COUNT(*) as cnt FROM ews_jst_push_plans WHERE task_id=? GROUP BY status", [tid]); var s = { pending: 0, processing: 0, done: 0, failed: 0, total: 0 }; for (const x of (r?.results || [])) { s[x.status] = x.cnt; s.total += x.cnt; } return s; }
async function jstRefundCredits(env, tid) { var t = await getOne(env, "SELECT user_id FROM ews_tasks WHERE id = ?", [tid]); if (t?.user_id) await env.DB.prepare("UPDATE ews_users SET credits = credits + 1 WHERE id = ?").bind(t.user_id).run(); }

// ==================== Shopee 模块 ====================
let shopeeColumnsReady = false;
async function ensureShopeeProductColumns(env) {
  if (shopeeColumnsReady) return;
  const cols = [
    ['main_description', "TEXT NOT NULL DEFAULT ''"],
    ['reference_title', "TEXT NOT NULL DEFAULT ''"],
    ['reference_image', "TEXT NOT NULL DEFAULT ''"],
    ['auxiliary_images', "TEXT NOT NULL DEFAULT '[]'"],
    ['generate_count', "INTEGER NOT NULL DEFAULT 1"],
    ['mode', "TEXT NOT NULL DEFAULT 'full'"],
    ['main_image_count', "INTEGER NOT NULL DEFAULT 9"],
    ['detail_image_count', "INTEGER NOT NULL DEFAULT 0"],
    ['variation_image_mode', "TEXT NOT NULL DEFAULT 'option1'"],
    ['source_brief', "TEXT NOT NULL DEFAULT ''"],
    ['product_type', "TEXT NOT NULL DEFAULT 'one'"],
    ['variation_name1_export', "TEXT NOT NULL DEFAULT ''"],
    ['variation_name2_export', "TEXT NOT NULL DEFAULT ''"],
    ['max_purchase_start_date', "TEXT NOT NULL DEFAULT ''"],
    ['max_purchase_period_days', "INTEGER"],
    ['max_purchase_end_date', "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [name, type] of cols) {
    try { await env.DB.prepare(`ALTER TABLE ews_shopee_products ADD COLUMN ${name} ${type}`).run(); } catch (_) {}
  }
  try { await env.DB.prepare("ALTER TABLE ews_shopee_sub_tasks ADD COLUMN description TEXT NOT NULL DEFAULT ''").run(); } catch (_) {}
  shopeeColumnsReady = true;
}
async function shopeeCreateProduct(env, p) {
  await ensureShopeeProductColumns(env);
  await env.DB.prepare(`INSERT INTO ews_shopee_products
    (id, task_id, category_id, name, main_description, reference_title, reference_image, auxiliary_images, generate_count, mode, main_image_count, detail_image_count, parent_sku, cover_image, images, weight_kg, length_cm, width_cm, height_cm, gtin, brand_id, hs_code, tax_code, origin_country, variation_name1, variation_name2, variation_image_mode, max_purchase_qty, size_chart_template_id, size_chart_image, pre_order_dts, shipping_channels, source_brief, product_type, variation_name1_export, variation_name2_export, max_purchase_start_date, max_purchase_period_days, max_purchase_end_date, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      task_id=excluded.task_id, category_id=excluded.category_id, name=excluded.name,
      main_description=excluded.main_description,
      reference_title=excluded.reference_title, reference_image=excluded.reference_image, auxiliary_images=excluded.auxiliary_images,
      generate_count=excluded.generate_count, mode=excluded.mode, main_image_count=excluded.main_image_count,
      detail_image_count=excluded.detail_image_count, parent_sku=excluded.parent_sku, cover_image=excluded.cover_image,
      images=excluded.images, weight_kg=excluded.weight_kg, length_cm=excluded.length_cm, width_cm=excluded.width_cm,
      height_cm=excluded.height_cm, gtin=excluded.gtin, brand_id=excluded.brand_id, hs_code=excluded.hs_code,
      tax_code=excluded.tax_code, origin_country=excluded.origin_country, variation_name1=excluded.variation_name1,
      variation_name2=excluded.variation_name2, variation_image_mode=excluded.variation_image_mode,
      max_purchase_qty=excluded.max_purchase_qty, size_chart_template_id=excluded.size_chart_template_id,
      size_chart_image=excluded.size_chart_image, pre_order_dts=excluded.pre_order_dts,
      shipping_channels=excluded.shipping_channels, source_brief=excluded.source_brief,
      product_type=excluded.product_type,
      variation_name1_export=excluded.variation_name1_export, variation_name2_export=excluded.variation_name2_export,
      max_purchase_start_date=excluded.max_purchase_start_date, max_purchase_period_days=excluded.max_purchase_period_days,
      max_purchase_end_date=excluded.max_purchase_end_date, status='pending', updated_at=datetime('now')`)
    .bind(
      p.id, p.task_id, p.category_id || '', p.name, p.main_description || '',
      p.reference_title || '', p.reference_image || '', p.auxiliary_images || '[]', p.generate_count || 1, p.mode || 'full',
      p.main_image_count || 9, p.detail_image_count ?? 0, p.parent_sku || '', p.cover_image || '', p.images || '[]',
      p.weight_kg || 0, p.length_cm ?? null, p.width_cm ?? null, p.height_cm ?? null, p.gtin || '', p.brand_id || '',
      p.hs_code || '', p.tax_code || '', p.origin_country || '', p.variation_name1 || '', p.variation_name2 || '',
      p.variation_image_mode || 'option1', p.max_purchase_qty ?? null, p.size_chart_template_id || '',
      p.size_chart_image || '', p.pre_order_dts ?? null, p.shipping_channels || '[]', p.source_brief || '',
      p.product_type || 'one', p.variation_name1_export || '', p.variation_name2_export || '',
      p.max_purchase_start_date || '', p.max_purchase_period_days ?? null, p.max_purchase_end_date || ''
    ).run();
}
async function shopeeGetProduct(env, pid) {
  const results = await env.DB.batch([
    env.DB.prepare("SELECT * FROM ews_shopee_products WHERE id = ?").bind(pid),
    env.DB.prepare("SELECT * FROM ews_shopee_variations WHERE product_id = ? ORDER BY rowid").bind(pid),
    env.DB.prepare("SELECT * FROM ews_shopee_sub_tasks WHERE parent_task_id = ? ORDER BY set_index").bind(pid),
    env.DB.prepare("SELECT * FROM ews_shopee_task_images WHERE parent_task_id = ? ORDER BY set_index,image_type,position").bind(pid),
  ]);
  const product = results[0]?.results?.[0];
  if (!product) return null;
  product.variations = results[1]?.results || [];
  product.sub_tasks = results[2]?.results || [];
  product.images_rec = results[3]?.results || [];
  return product;
}
async function shopeeDeleteProduct(env, pid) { await env.DB.prepare("DELETE FROM ews_shopee_products WHERE id = ?").bind(pid).run(); }
async function shopeeCreateVariations(env, vs) { await ensureShopeeVariationColumns(env); var s = env.DB.prepare("INSERT INTO ews_shopee_variations (id, product_id, integration_no, option1, option1_export, image_per_variation, option2, option2_export, image_2, price, price_float_enabled, price_min, price_max, price_precision, stock, sku, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))"); for (const v of vs) await s.bind(v.id, v.product_id, v.integration_no, v.option1, v.option1_export || '', v.image_per_variation || '', v.option2 || '', v.option2_export || '', v.image_2 || '', v.price, v.price_float_enabled ? 1 : 0, v.price_min ?? null, v.price_max ?? null, v.price_precision ?? 0, v.stock ?? 999, v.sku || '').run(); }
async function shopeeClearVariations(env, pid) { await env.DB.prepare("DELETE FROM ews_shopee_variations WHERE product_id = ?").bind(pid).run(); }
async function shopeeReplaceVariations(env, pid, variations) {
  await ensureShopeeVariationColumns(env);
  const statements = [env.DB.prepare("DELETE FROM ews_shopee_variations WHERE product_id = ?").bind(pid)];
  for (const v of variations) statements.push(env.DB.prepare("INSERT INTO ews_shopee_variations (id, product_id, integration_no, option1, option1_export, image_per_variation, option2, option2_export, image_2, price, price_float_enabled, price_min, price_max, price_precision, stock, sku, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))").bind(v.id, v.product_id, v.integration_no, v.option1, v.option1_export || '', v.image_per_variation || '', v.option2 || '', v.option2_export || '', v.image_2 || '', v.price, v.price_float_enabled ? 1 : 0, v.price_min ?? null, v.price_max ?? null, v.price_precision ?? 0, v.stock ?? 999, v.sku || ''));
  await env.DB.batch(statements);
}

// -- Shopee 子任务 & 图片
async function shopeeCreateSubTask(env, s) { await ensureShopeeProductColumns(env); await env.DB.prepare("INSERT INTO ews_shopee_sub_tasks (id, parent_task_id, set_index, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', datetime('now'), '')").bind(s.id, s.parent_task_id, s.set_index).run(); }
async function shopeeGetSubTasks(env, tid) { return await query(env, "SELECT * FROM ews_shopee_sub_tasks WHERE parent_task_id = ? ORDER BY set_index", [tid]); }
async function shopeeUpdateSubTask(env, sid, d) {
  var sc = []; var p = [];
  if (d.title !== undefined) { sc.push('title = ?'); p.push(d.title); }
  if (d.description !== undefined) { sc.push('description = ?'); p.push(d.description); }
  if (d.status !== undefined) { sc.push('status = ?'); p.push(d.status); }
  if (!sc.length) return;
  sc.push("updated_at = datetime('now')"); p.push(sid);
  await env.DB.prepare(`UPDATE ews_shopee_sub_tasks SET ${sc.join(', ')} WHERE id = ?`).bind(...p).run();
}
async function shopeeUpdateVariationExports(env, productId, name1, name2, labels) {
  await ensureShopeeProductColumns(env);
  await ensureShopeeVariationColumns(env);
  const statements = [env.DB.prepare("UPDATE ews_shopee_products SET variation_name1_export=?, variation_name2_export=?, updated_at=datetime('now') WHERE id=?").bind(name1 || '', name2 || '', productId)];
  for (const label of labels) statements.push(env.DB.prepare("UPDATE ews_shopee_variations SET option1_export=?, option2_export=? WHERE id=? AND product_id=?").bind(label.option1 || '', label.option2 || '', label.id, productId));
  await env.DB.batch(statements);
}
async function shopeeCreateExpectedImages(env, tid, sid, si, mic, dic, skuCount, includeMain, includeSub) {
  var types = [];
  if (includeMain !== false) types.push({ type: 'main', pos: 1 });
  if (includeSub !== false) for (let p = 2; p <= mic; p++) types.push({ type: 'sub', pos: p });
  for (let p = 1; p <= dic; p++) types.push({ type: 'detail', pos: p });
  for (let p = 1; p <= (skuCount || 0); p++) types.push({ type: 'sku', pos: p });
  for (const t of types) { var pk = sid + '_' + t.type + '_' + t.pos + '_'; await env.DB.prepare("INSERT OR IGNORE INTO ews_shopee_task_images (id, parent_task_id, sub_task_id, set_index, image_type, position, image_url, status, created_at) VALUES (?, ?, ?, ?, ?, ?, '', 'pending', datetime('now'))").bind(pk, tid, sid, si, t.type, t.pos).run(); }
}
async function shopeeCheckSubTaskImages(env, sid) { var r = await getOne(env, "SELECT COUNT(*) as total, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as done FROM ews_shopee_task_images WHERE sub_task_id = ?", [sid]); return { total: r?.total || 0, completed: r?.done || 0 }; }
async function shopeeSaveImage(env, img) { var pk = img.sub_task_id + '_' + img.image_type + '_' + img.position + '_'; await env.DB.prepare("INSERT OR REPLACE INTO ews_shopee_task_images (id, parent_task_id, sub_task_id, set_index, image_type, position, image_url, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', datetime('now'))").bind(pk, img.parent_task_id, img.sub_task_id, img.set_index, img.image_type, img.position, img.image_url).run(); }
async function shopeeCheckParentCompletion(env, tid) {
  var p = await getOne(env, "SELECT SUM(CASE WHEN status IN ('pending','processing') THEN 1 ELSE 0 END) as active, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed FROM ews_shopee_push_plans WHERE task_id = ?", [tid]);
  if ((p?.failed || 0) > 0) { var fs = (p?.active || 0) > 0 ? 'partial_failed' : 'failed'; await env.DB.prepare("UPDATE ews_shopee_products SET status=?, updated_at=datetime('now') WHERE id=?").bind(fs, tid).run(); await updateTaskIndexStatus(env, tid, fs); return; }
  var r = await getOne(env, "SELECT COUNT(*) as total, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as done FROM ews_shopee_sub_tasks WHERE parent_task_id = ?", [tid]);
  if (r && r.total > 0 && r.total === r.done && (p?.active || 0) === 0) { await env.DB.prepare("UPDATE ews_shopee_products SET status='completed', updated_at=datetime('now') WHERE id=?").bind(tid).run(); await updateTaskIndexStatus(env, tid, 'completed'); }
}
async function shopeeRefundCredits(env, tid) { var t = await getOne(env, "SELECT user_id FROM ews_tasks WHERE id = ?", [tid]); if (t?.user_id) await env.DB.prepare("UPDATE ews_users SET credits = credits + 1 WHERE id = ?").bind(t.user_id).run(); }

// -- Shopee 推送计划
async function shopeeCreatePushPlans(env, plans) { var s = env.DB.prepare("INSERT INTO ews_shopee_push_plans (id, task_id, sub_task_id, webhook_type, webhook_url, payload, status, batch_order, retry_count, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 0, datetime('now'))"); for (const p of plans) await s.bind(p.id, p.task_id, p.sub_task_id || '', p.webhook_type, p.webhook_url, p.payload, p.batch_order).run(); }
async function shopeeGetPushPlans(env, tid) { return await query(env, "SELECT * FROM ews_shopee_push_plans WHERE task_id = ? ORDER BY batch_order ASC, webhook_type ASC", [tid]); }
async function shopeeGetPendingPlans(env, tid, lim) { return await query(env, "SELECT * FROM ews_shopee_push_plans WHERE task_id = ? AND status='pending' ORDER BY batch_order ASC LIMIT ?", [tid, lim]); }
async function shopeeUpdatePlanStatus(env, pid, s, e) { await env.DB.prepare("UPDATE ews_shopee_push_plans SET status=?, error=? WHERE id=?").bind(s, e || '', pid).run(); }
async function shopeeGetPlanStats(env, tid) { var r = await query(env, "SELECT status, COUNT(*) as cnt FROM ews_shopee_push_plans WHERE task_id=? GROUP BY status", [tid]); var s = { pending: 0, processing: 0, done: 0, failed: 0, total: 0 }; for (const x of (r?.results || [])) { s[x.status] = x.cnt; s.total += x.cnt; } return s; }

// Shopee 导出记录
async function shopeeCreateExportRecord(env, r) { await env.DB.prepare("INSERT INTO ews_shopee_export_records (id, task_id, file_url, created_at) VALUES (?, ?, ?, datetime('now'))").bind(r.id, r.task_id, r.file_url).run(); }

// ==================== 导出 ====================
export {
  query, getOne,
  getConfig, updateConfig, getPlatformConfig,
  createUser, getUserByUsername, getUserList, updateUserPassword, toggleUserActive, deleteUser, updateUserPlatformAccess, updateUserImageConcurrencyLimit, updateUserWebhook,
  normalizeUserImageConcurrencyLimit,
  getUserCredits, updateUserCredits, consumeUserCredit,
  createTaskIndex, updateTaskIndexStatus, getTaskIndex, getTaskList, getTaskCount, deleteTaskIndex,
  jstCreateTask, jstUpdateTask, jstGetTask, jstUpdateTaskStatus,
  jstCreateVariant, jstClearVariants, jstReplaceVariants,
  jstCreateSubTask, jstGetSubTasks, jstUpdateSubTask, jstDeleteSubTasks,
  jstCreateSkuTitle, jstSaveImage, jstClearImages,
  jstCreateExpectedImages, jstCheckSubTaskImages, jstCheckParentCompletion, jstDeleteTaskRecord,
  jstCreatePushPlans, jstGetPushPlans, jstGetPendingPlans, jstUpdatePlanStatus, jstGetPlanStats,
  jstRefundCredits,
  shopeeCreateProduct, shopeeGetProduct, shopeeDeleteProduct,
  shopeeCreateVariations, shopeeClearVariations, shopeeReplaceVariations,
  shopeeCreatePushPlans, shopeeGetPushPlans, shopeeGetPendingPlans, shopeeUpdatePlanStatus, shopeeGetPlanStats,
  shopeeCreateExportRecord,
  shopeeCreateSubTask, shopeeGetSubTasks, shopeeUpdateSubTask,
  shopeeCreateExpectedImages, shopeeCheckSubTaskImages,
  shopeeSaveImage, shopeeCheckParentCompletion, shopeeRefundCredits, shopeeUpdateVariationExports,
};
