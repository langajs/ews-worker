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
    const rows = platform
      ? await query(env, "SELECT key, value, platform FROM ews_config WHERE platform IN ('', ?) ORDER BY CASE WHEN platform = '' THEN 0 ELSE 1 END", [platform])
      : await query(env, "SELECT key, value FROM ews_config WHERE platform = ''");
    const config = {};
    for (const row of rows.results) config[row.key] = row.value;
    return config;
  } catch { return {}; }
}
async function updateConfig(env, key, value, platform = '') {
  await env.DB.prepare("INSERT INTO ews_config (key, value, platform, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(key, platform) DO UPDATE SET value = ?, updated_at = datetime('now')").bind(key, value, platform, value).run();
}
async function getPlatformConfig(env, platform) { return getConfig(env, platform); }

const DEFAULT_USER_IMAGE_CONCURRENCY = 20;
const MAX_USER_IMAGE_CONCURRENCY = 20;
function normalizePlatformAccess(value) {
  return ['allow','jst','shopee'].includes(value) ? value : 'allow';
}
function normalizeUserImageConcurrencyLimit(value) {
  const limit = parseInt(value);
  if (!Number.isInteger(limit) || limit < 1) return DEFAULT_USER_IMAGE_CONCURRENCY;
  return Math.min(limit, MAX_USER_IMAGE_CONCURRENCY);
}
async function getGroupList(env, groupId = '') {
  const where = groupId ? 'WHERE g.id=?' : '';
  return await query(env, `SELECT g.*,
    (SELECT COUNT(*) FROM ews_users u WHERE u.group_id=g.id) AS user_count,
    (SELECT COUNT(*) FROM ews_shopee_template_groups tg WHERE tg.group_id=g.id) AS template_count
    FROM ews_groups g
    ${where}
    ORDER BY CASE WHEN g.id='default' THEN 0 ELSE 1 END, g.status ASC, g.name COLLATE NOCASE ASC`, groupId ? [groupId] : []);
}
async function getGroupById(env, groupId) { return await getOne(env, "SELECT * FROM ews_groups WHERE id = ?", [groupId]); }
async function createGroup(env, group) {
  await env.DB.prepare("INSERT INTO ews_groups (id,name,status,created_by,created_at,updated_at) VALUES (?,?,'active',?,datetime('now'),datetime('now'))")
    .bind(group.id, group.name, group.created_by || '').run();
}
async function updateGroup(env, groupId, name, status, callbackSecret, workflowConfig) {
  await env.DB.prepare("UPDATE ews_groups SET name=?,status=?,callback_secret=?,workflow_config=?,updated_at=datetime('now') WHERE id=?").bind(name, status, callbackSecret, workflowConfig || '{}', groupId).run();
}
async function createUser(env, user) { await env.DB.prepare("INSERT INTO ews_users (id, username, password_hash, role, display_name, platform_access, group_id, image_concurrency_limit, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(user.id, user.username, user.password_hash, user.role || 'user', user.display_name || '', normalizePlatformAccess(user.platform_access), user.group_id || 'default', normalizeUserImageConcurrencyLimit(user.image_concurrency_limit), user.created_by || '').run(); }
async function createUserWithCreditCharge(env, user, payerId, amount) {
  if (!Number.isSafeInteger(amount) || amount < 1) return false;
  const results = await env.DB.batch([
    env.DB.prepare("UPDATE ews_users SET credits=credits-? WHERE id=? AND credits>=?").bind(amount, payerId, amount),
    env.DB.prepare("INSERT INTO ews_users (id,username,password_hash,role,display_name,platform_access,group_id,image_concurrency_limit,credits,created_by) SELECT ?,?,?,?,?,?,?,?,?,? WHERE changes()=1")
      .bind(user.id, user.username, user.password_hash, user.role || 'user', user.display_name || '', normalizePlatformAccess(user.platform_access), user.group_id || 'default', normalizeUserImageConcurrencyLimit(user.image_concurrency_limit), amount, user.created_by || ''),
  ]);
  const result = results?.[1];
  return Number(result?.meta?.changes ?? result?.changes ?? 0) === 1;
}
async function getUserByUsername(env, username) { return await getOne(env, "SELECT u.*,g.name AS group_name,g.status AS group_status,g.callback_secret AS group_callback_secret FROM ews_users u LEFT JOIN ews_groups g ON g.id=u.group_id WHERE u.username = ?", [username]); }
async function getUserList(env, groupId = '') {
  const where = groupId ? "WHERE u.group_id=? AND u.id<>'admin' AND u.role<>'admin'" : '';
  return await query(env, `SELECT u.id,u.username,u.role,u.display_name,u.platform_access,u.group_id,g.name AS group_name,g.status AS group_status,u.image_concurrency_limit,u.is_active,u.credits,u.created_at
    FROM ews_users u LEFT JOIN ews_groups g ON g.id=u.group_id ${where} ORDER BY u.created_at ASC`, groupId ? [groupId] : []);
}
async function updateUserPassword(env, userId, pw) { await env.DB.prepare("UPDATE ews_users SET password_hash = ? WHERE id = ?").bind(pw, userId).run(); }
async function toggleUserActive(env, userId, a) { await env.DB.prepare("UPDATE ews_users SET is_active = ? WHERE id = ?").bind(a ? 1 : 0, userId).run(); }
async function updateUserGroup(env, userId, groupId) { await env.DB.prepare("UPDATE ews_users SET group_id = ? WHERE id = ?").bind(groupId, userId).run(); }
async function deleteUser(env, userId) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM ews_shopee_template_user_meta WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM ews_users WHERE id = ?").bind(userId),
  ]);
}
async function deleteUserWithCreditRefund(env, userId, managerId, groupId) {
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE ews_users SET credits=credits+(
      SELECT credits FROM ews_users WHERE id=? AND role='user' AND group_id=?
    ) WHERE id=? AND role='group_admin' AND group_id=?
      AND EXISTS (SELECT 1 FROM ews_users WHERE id=? AND role='user' AND group_id=?)`)
      .bind(userId, groupId, managerId, groupId, userId, groupId),
    env.DB.prepare("DELETE FROM ews_users WHERE id=? AND role='user' AND group_id=? AND changes()=1")
      .bind(userId, groupId),
    env.DB.prepare("DELETE FROM ews_shopee_template_user_meta WHERE user_id=? AND changes()=1").bind(userId),
  ]);
  const result = results?.[1];
  return Number(result?.meta?.changes ?? result?.changes ?? 0) === 1;
}
async function updateUserPlatformAccess(env, userId, access) { await env.DB.prepare("UPDATE ews_users SET platform_access = ? WHERE id = ?").bind(normalizePlatformAccess(access), userId).run(); }
async function updateUserImageConcurrencyLimit(env, userId, limit) { await env.DB.prepare("UPDATE ews_users SET image_concurrency_limit = ? WHERE id = ?").bind(normalizeUserImageConcurrencyLimit(limit), userId).run(); }
async function updateUserWebhook(env, userId, cfg) { await env.DB.prepare("UPDATE ews_users SET webhook_config = ? WHERE id = ?").bind(cfg, userId).run(); }
async function getUserCredits(env, userId) { const r = await getOne(env, "SELECT credits FROM ews_users WHERE id = ?", [userId]); return r?.credits ?? 0; }
async function updateUserCredits(env, userId, amount, mode) {
  if (mode === 'set') await env.DB.prepare("UPDATE ews_users SET credits = ? WHERE id = ?").bind(Math.max(0, amount), userId).run();
  else if (mode === 'add') await env.DB.prepare("UPDATE ews_users SET credits = credits + ? WHERE id = ?").bind(amount, userId).run();
  else if (mode === 'subtract') await env.DB.prepare("UPDATE ews_users SET credits = MAX(0, credits - ?) WHERE id = ?").bind(amount, userId).run();
}
async function transferUserCredits(env, fromUserId, toUserId, amount) {
  if (fromUserId === toUserId || !Number.isSafeInteger(amount) || amount < 1) return false;
  const results = await env.DB.batch([
    env.DB.prepare("UPDATE ews_users SET credits=credits-? WHERE id=? AND credits>=? AND EXISTS (SELECT 1 FROM ews_users WHERE id=?)")
      .bind(amount, fromUserId, amount, toUserId),
    env.DB.prepare("UPDATE ews_users SET credits=credits+? WHERE id=? AND changes()=1")
      .bind(amount, toUserId),
  ]);
  const result = results?.[1];
  return Number(result?.meta?.changes ?? result?.changes ?? 0) === 1;
}
async function consumeUserCredit(env, userId) {
  const result = await env.DB.prepare("UPDATE ews_users SET credits = credits - 1 WHERE id = ? AND credits > 0").bind(userId).run();
  const meta = result?.meta || {};
  return (meta.changes ?? meta.rows_written ?? 0) > 0;
}

const TASK_RETENTION_DAYS = 7;
const TASK_VISIBLE_SQL = `(
  (status='completed' AND completed_at IS NOT NULL AND completed_at<>''
    AND completed_at >= datetime('now', '-${TASK_RETENTION_DAYS} days'))
  OR ((status<>'completed' OR completed_at IS NULL OR completed_at='')
    AND created_at >= datetime('now', '-${TASK_RETENTION_DAYS} days'))
)`;

function parseSqliteUtc(value) {
  const raw = String(value || '').trim();
  if (!raw) return NaN;
  return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`);
}

function isTaskExpired(task, now = Date.now()) {
  const retentionBase = task?.status === 'completed' && task?.completed_at
    ? task.completed_at
    : task?.created_at;
  const baseTime = parseSqliteUtc(retentionBase);
  return Number.isFinite(baseTime) && baseTime + TASK_RETENTION_DAYS * 86400000 < now;
}

async function createTaskIndex(env, id, platform, name, userId, groupId) { await env.DB.prepare("INSERT INTO ews_tasks (id, platform, name, status, user_id, group_id, created_at, updated_at) VALUES (?, ?, ?, 'init', ?, ?, datetime('now'), datetime('now'))").bind(id, platform, name || '', userId || '', groupId || 'default').run(); }
async function updateTaskIndexStatus(env, id, status) { await env.DB.prepare("UPDATE ews_tasks SET status = ?, updated_at = datetime('now'), completed_at = CASE WHEN ? = 'completed' THEN COALESCE(completed_at, datetime('now')) ELSE NULL END WHERE id = ?").bind(status, status, id).run(); }
async function getTaskIndex(env, id) { return await getOne(env, "SELECT * FROM ews_tasks WHERE id = ?", [id]); }
async function getTaskList(env, platform, userId, role, groupId, limit = 0, offset = 0) {
  let sql = "SELECT * FROM ews_tasks"; const params = []; const ws = [TASK_VISIBLE_SQL];
  if (platform) { ws.push("platform = ?"); params.push(platform); }
  if (role === 'group_admin') { ws.push("group_id = ?"); params.push(groupId); }
  else if (role !== 'admin') { ws.push("user_id = ?"); params.push(userId); }
  if (ws.length) sql += " WHERE " + ws.join(" AND ");
  sql += " ORDER BY created_at DESC";
  if (limit > 0) { sql += " LIMIT ? OFFSET ?"; params.push(limit, Math.max(0, offset)); }
  return await query(env, sql, params);
}
async function getTaskCount(env, platform, userId, role, groupId) {
  let sql = "SELECT COUNT(*) AS cnt FROM ews_tasks"; const params = []; const ws = [TASK_VISIBLE_SQL];
  if (platform) { ws.push("platform = ?"); params.push(platform); }
  if (role === 'group_admin') { ws.push("group_id = ?"); params.push(groupId); }
  else if (role !== 'admin') { ws.push("user_id = ?"); params.push(userId); }
  if (ws.length) sql += " WHERE " + ws.join(" AND ");
  const row = await getOne(env, sql, params);
  return row?.cnt || 0;
}
async function deleteTaskIndex(env, id) { await env.DB.prepare("DELETE FROM ews_tasks WHERE id = ?").bind(id).run(); }

// ==================== JST 模块 ====================
async function jstCreateTask(env, t) { await env.DB.prepare("INSERT INTO ews_jst_tasks (id, name, topic_items, source_brief, description, main_description, detail_description, reference_image, auxiliary_images, generate_count, stock, weight, variant_count, main_image_count, detail_image_count, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))").bind(t.id, t.name ?? '', t.topic_items ?? '', t.source_brief ?? t.description ?? '', t.description ?? '', t.main_description ?? '', t.detail_description ?? '', t.reference_image, t.auxiliary_images ?? '', t.generate_count, t.stock, t.weight, t.variant_count, t.main_image_count ?? 5, t.detail_image_count ?? 5).run(); }
async function jstUpdateTask(env, tid, d) {
  await env.DB.prepare("UPDATE ews_jst_tasks SET name=?, topic_items=?, source_brief=?, description=?, recommended_copy=?, product_link=?, supplier_name=?, main_description=?, detail_description=?, reference_image=?, auxiliary_images=?, generate_count=?, stock=?, weight=?, variant_count=?, main_image_count=?, detail_image_count=?, product_type=?, variation_image_mode=?, mode=?, status='pending', updated_at=datetime('now') WHERE id=?")
    .bind(d.name ?? '', d.topic_items ?? '', d.source_brief ?? d.description ?? '', d.description ?? '', d.recommended_copy ?? '', d.product_link ?? '', d.supplier_name ?? '', d.main_description ?? '', d.detail_description ?? '', d.reference_image ?? '', d.auxiliary_images ?? '', d.generate_count ?? 1, d.stock ?? 999, d.weight ?? 1.0, d.variant_count ?? 1, d.main_image_count ?? 5, d.detail_image_count ?? 5, d.product_type ?? 'one', d.variation_image_mode ?? 'upload', d.mode ?? 'full', tid).run();
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
async function jstCreateVariant(env, v) { await env.DB.prepare("INSERT INTO ews_jst_variants (id, task_id, tier1_name, tier1_value, tier2_name, tier2_value, sku_image, price, market_price, min_distribution_price, max_distribution_price, stock, sku_code, price_float_enabled, price_min, price_max, price_precision, description, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))").bind(v.id, v.task_id, v.tier1_name || '', v.tier1_value, v.tier2_name || '', v.tier2_value || '', v.sku_image || '', v.price ?? null, v.market_price ?? null, v.min_distribution_price ?? null, v.max_distribution_price ?? null, v.stock ?? 999, v.sku_code || '', v.price_float_enabled ? 1 : 0, v.price_min ?? null, v.price_max ?? null, v.price_precision ?? 0, v.description ?? '', v.sort_order).run(); }
async function jstClearVariants(env, tid) { await env.DB.prepare("DELETE FROM ews_jst_variants WHERE task_id = ?").bind(tid).run(); }
async function jstReplaceVariants(env, tid, variants) {
  const statements = [env.DB.prepare("DELETE FROM ews_jst_variants WHERE task_id = ?").bind(tid)];
  for (const v of variants) statements.push(env.DB.prepare("INSERT INTO ews_jst_variants (id, task_id, tier1_name, tier1_value, tier2_name, tier2_value, sku_image, price, market_price, min_distribution_price, max_distribution_price, stock, sku_code, price_float_enabled, price_min, price_max, price_precision, description, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))").bind(v.id, v.task_id, v.tier1_name || '', v.tier1_value, v.tier2_name || '', v.tier2_value || '', v.sku_image || '', v.price ?? null, v.market_price ?? null, v.min_distribution_price ?? null, v.max_distribution_price ?? null, v.stock ?? 999, v.sku_code || '', v.price_float_enabled ? 1 : 0, v.price_min ?? null, v.price_max ?? null, v.price_precision ?? 0, v.description ?? '', v.sort_order));
  await env.DB.batch(statements);
}
async function jstCreateSubTask(env, s) { await env.DB.prepare("INSERT INTO ews_jst_sub_tasks (id, parent_task_id, set_index, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', datetime('now'), '')").bind(s.id, s.parent_task_id, s.set_index).run(); }
async function jstGetSubTasks(env, tid) { return await query(env, "SELECT * FROM ews_jst_sub_tasks WHERE parent_task_id = ? ORDER BY set_index", [tid]); }
async function jstUpdateSubTask(env, sid, d) {
  var sc = []; var p = [];
  if (d.title !== undefined) { sc.push('title = ?'); p.push(d.title); }
  if (d.recommended_copy !== undefined) { sc.push('recommended_copy = ?'); p.push(d.recommended_copy); }
  if (d.description !== undefined) { sc.push('description = ?'); p.push(d.description); }
  if (d.status !== undefined) { sc.push('status = ?'); p.push(d.status); }
  if (!sc.length) return;
  sc.push("updated_at = datetime('now')"); p.push(sid);
  await env.DB.prepare(`UPDATE ews_jst_sub_tasks SET ${sc.join(', ')} WHERE id = ?`).bind(...p).run();
}
async function jstDeleteSubTasks(env, tid) { await env.DB.prepare("DELETE FROM ews_jst_sub_tasks WHERE parent_task_id = ?").bind(tid).run(); }
async function jstSaveMetadataBatch(env, taskId, products, skuTitles) {
  const statements = [env.DB.prepare(`WITH updates AS (
    SELECT json_extract(value, '$.sub_task_id') AS id,
      json_extract(value, '$.product_title') AS title,
      json_extract(value, '$.recommended_copy') AS recommended_copy,
      json_extract(value, '$.product_description') AS description
    FROM json_each(?)
  )
  UPDATE ews_jst_sub_tasks SET
    title=(SELECT title FROM updates WHERE updates.id=ews_jst_sub_tasks.id),
    recommended_copy=(SELECT recommended_copy FROM updates WHERE updates.id=ews_jst_sub_tasks.id),
    description=(SELECT description FROM updates WHERE updates.id=ews_jst_sub_tasks.id),
    updated_at=datetime('now')
  WHERE parent_task_id=? AND id IN (SELECT id FROM updates)`).bind(JSON.stringify(products), taskId)];
  if (skuTitles.length > 0) {
    statements.push(env.DB.prepare(`INSERT INTO ews_jst_sku_titles (id, sub_task_id, variant_id, title, created_at)
      SELECT json_extract(value, '$.id'), json_extract(value, '$.sub_task_id'),
        json_extract(value, '$.variant_id'), json_extract(value, '$.title'), datetime('now')
      FROM json_each(?) WHERE true
      ON CONFLICT(sub_task_id, variant_id) DO UPDATE SET title=excluded.title, created_at=datetime('now')`).bind(JSON.stringify(skuTitles)));
  }
  await env.DB.batch(statements);
}
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
  var p = await getOne(env, "SELECT SUM(CASE WHEN status IN ('pending','dispatching','processing') THEN 1 ELSE 0 END) as active, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed FROM ews_jst_push_plans WHERE task_id = ?", [tid]);
  if ((p?.failed || 0) > 0) { var fs = (p?.active || 0) > 0 ? 'partial_failed' : 'failed'; await env.DB.prepare("UPDATE ews_jst_tasks SET status=?, updated_at=datetime('now') WHERE id=?").bind(fs, tid).run(); await updateTaskIndexStatus(env, tid, fs); return; }
  var r = await getOne(env, "SELECT COUNT(*) as total, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as done FROM ews_jst_sub_tasks WHERE parent_task_id = ?", [tid]);
  if (r && r.total > 0 && r.total === r.done && (p?.active || 0) === 0) { await env.DB.prepare("UPDATE ews_jst_tasks SET status='completed', updated_at=datetime('now') WHERE id=?").bind(tid).run(); await updateTaskIndexStatus(env, tid, 'completed'); }
}
async function jstDeleteTaskRecord(env, tid) { await env.DB.prepare("DELETE FROM ews_jst_tasks WHERE id = ?").bind(tid).run(); }
async function createPushPlans(env, table, plans) {
  const sql = `INSERT INTO ${table} (id, task_id, sub_task_id, webhook_type, webhook_url, payload, user_id, is_image, status, batch_order, retry_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, datetime('now'))`;
  const statements = plans.map(p => env.DB.prepare(sql).bind(
    p.id, p.task_id, p.sub_task_id || '', p.webhook_type, p.webhook_url, p.payload, p.user_id || '',
    /^(main|main_1|sub_\d+|detail_\d+|sku_\d+)$/.test(p.webhook_type || '') ? 1 : 0,
    p.batch_order
  ));
  for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50));
}
async function jstCreatePushPlans(env, plans) { await createPushPlans(env, 'ews_jst_push_plans', plans); }
async function jstGetPushPlans(env, tid) { return await query(env, "SELECT * FROM ews_jst_push_plans WHERE task_id = ? ORDER BY batch_order ASC, webhook_type ASC", [tid]); }
async function jstGetPendingPlans(env, tid, lim) { return await query(env, "SELECT * FROM ews_jst_push_plans WHERE task_id = ? AND status='pending' ORDER BY batch_order ASC LIMIT ?", [tid, lim]); }
async function jstUpdatePlanStatus(env, pid, s, e) { await env.DB.prepare("UPDATE ews_jst_push_plans SET status=?, error=? WHERE id=?").bind(s, e || '', pid).run(); }
async function jstGetPlanStats(env, tid) { var r = await query(env, "SELECT status, COUNT(*) as cnt FROM ews_jst_push_plans WHERE task_id=? GROUP BY status", [tid]); var s = { pending: 0, dispatching: 0, processing: 0, done: 0, failed: 0, total: 0 }; for (const x of (r?.results || [])) { s[x.status] = x.cnt; s.total += x.cnt; } return s; }
async function jstRefundCredits(env, tid) { var t = await getOne(env, "SELECT user_id FROM ews_tasks WHERE id = ?", [tid]); if (t?.user_id) await env.DB.prepare("UPDATE ews_users SET credits = credits + 1 WHERE id = ?").bind(t.user_id).run(); }

// ==================== Shopee 模块 ====================
async function shopeeListTemplateProfiles(env, userId, includeInactive = false, groupId = '') {
  const filters = [];
  if (!includeInactive) filters.push("p.status='active' AND p.deleted_at IS NULL AND v.status='ready'");
  if (groupId) filters.push("EXISTS (SELECT 1 FROM ews_shopee_template_groups access_group WHERE access_group.profile_id=p.id AND access_group.group_id=?)");
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const params = [userId];
  if (groupId) params.push(groupId);
  return await query(env, `SELECT p.*, COALESCE(m.alias,'') AS user_alias, COALESCE(m.note,'') AS user_note,
    COALESCE(m.is_favorite,0) AS is_favorite, v.id AS version_id, v.filename, v.sha256, v.schema_hash,
    v.signature, v.template_type, v.field_count, v.logistics_count, v.category_count,
    v.manifest_json, v.status AS version_status, v.uploaded_by AS version_uploaded_by, v.has_sensitive_data,
    v.sensitive_summary, v.created_at AS version_created_at,
    COALESCE((SELECT json_group_array(tg.group_id) FROM ews_shopee_template_groups tg WHERE tg.profile_id=p.id),'[]') AS group_ids_json
    FROM ews_shopee_template_profiles p
    LEFT JOIN ews_shopee_template_user_meta m ON m.profile_id=p.id AND m.user_id=?
    LEFT JOIN ews_shopee_template_versions v ON v.id=p.current_version_id
    ${where}
    ORDER BY COALESCE(m.is_favorite,0) DESC, p.updated_at DESC`, params);
}
async function shopeeGetTemplateProfile(env, profileId, userId = '', groupId = '') {
  const accessFilter = groupId
    ? "AND EXISTS (SELECT 1 FROM ews_shopee_template_groups access_group WHERE access_group.profile_id=p.id AND access_group.group_id=?)"
    : '';
  const params = [userId, profileId];
  if (groupId) params.push(groupId);
  return await getOne(env, `SELECT p.*, COALESCE(m.alias,'') AS user_alias, COALESCE(m.note,'') AS user_note,
    COALESCE(m.is_favorite,0) AS is_favorite, v.id AS version_id, v.filename, v.sha256, v.schema_hash,
    v.signature, v.template_type, v.field_count, v.logistics_count, v.category_count,
    v.manifest_json, v.status AS version_status, v.uploaded_by AS version_uploaded_by, v.has_sensitive_data,
    v.sensitive_summary, v.created_at AS version_created_at,
    COALESCE((SELECT json_group_array(tg.group_id) FROM ews_shopee_template_groups tg WHERE tg.profile_id=p.id),'[]') AS group_ids_json
    FROM ews_shopee_template_profiles p
    LEFT JOIN ews_shopee_template_user_meta m ON m.profile_id=p.id AND m.user_id=?
    LEFT JOIN ews_shopee_template_versions v ON v.id=p.current_version_id
    WHERE p.id=? ${accessFilter}`, params);
}
async function shopeeGetTemplateProfileByContext(env, market, storeContextId) {
  return await getOne(env, "SELECT * FROM ews_shopee_template_profiles WHERE market=? AND store_context_id=?", [market, storeContextId]);
}
async function shopeeClaimTemplateProfile(env, profile) {
  await env.DB.prepare(`INSERT OR IGNORE INTO ews_shopee_template_profiles
    (id,market,store_context_id,profile_code,system_name,status,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,'pending_upload',?,datetime('now'),datetime('now'))`)
    .bind(profile.id, profile.market, profile.store_context_id, profile.profile_code, profile.system_name, profile.created_by).run();
  return await shopeeGetTemplateProfileByContext(env, profile.market, profile.store_context_id);
}
async function shopeeAssignTemplateGroup(env, profileId, groupId, assignedBy) {
  await env.DB.prepare("INSERT OR IGNORE INTO ews_shopee_template_groups (profile_id,group_id,assigned_by,created_at) VALUES (?,?,?,datetime('now'))")
    .bind(profileId, groupId, assignedBy || '').run();
}
async function shopeeReplaceTemplateGroups(env, profileId, groupIds, assignedBy) {
  const statements = [env.DB.prepare("DELETE FROM ews_shopee_template_groups WHERE profile_id=?").bind(profileId)];
  for (let offset = 0; offset < groupIds.length; offset += 30) {
    const chunk = groupIds.slice(offset, offset + 30);
    const values = chunk.map(() => "(?,?,?,datetime('now'))").join(',');
    const params = chunk.flatMap(groupId => [profileId, groupId, assignedBy || '']);
    statements.push(env.DB.prepare(`INSERT INTO ews_shopee_template_groups (profile_id,group_id,assigned_by,created_at) VALUES ${values}`).bind(...params));
  }
  await env.DB.batch(statements);
}
async function shopeeReplaceGroupTemplates(env, groupId, profileIds, assignedBy) {
  const statements = [env.DB.prepare("DELETE FROM ews_shopee_template_groups WHERE group_id=?").bind(groupId)];
  for (let offset = 0; offset < profileIds.length; offset += 30) {
    const chunk = profileIds.slice(offset, offset + 30);
    const values = chunk.map(() => "(?,?,?,datetime('now'))").join(',');
    const params = chunk.flatMap(profileId => [profileId, groupId, assignedBy || '']);
    statements.push(env.DB.prepare(`INSERT INTO ews_shopee_template_groups (profile_id,group_id,assigned_by,created_at) VALUES ${values}`).bind(...params));
  }
  await env.DB.batch(statements);
}
async function shopeeGetTemplateVersion(env, versionId) {
  return await getOne(env, "SELECT * FROM ews_shopee_template_versions WHERE id=?", [versionId]);
}
async function shopeeGetCurrentTemplateVersion(env, profileId) {
  return await getOne(env, `SELECT v.* FROM ews_shopee_template_profiles p
    JOIN ews_shopee_template_versions v ON v.id=p.current_version_id
    WHERE p.id=?`, [profileId]);
}
async function shopeeGetLatestTemplateVersion(env, profileId) {
  return await getOne(env, "SELECT * FROM ews_shopee_template_versions WHERE profile_id=? AND deleted_at IS NULL ORDER BY datetime(created_at) DESC, id DESC LIMIT 1", [profileId]);
}
async function shopeeGetTemplateVersionByHash(env, profileId, sha256) {
  return await getOne(env, "SELECT * FROM ews_shopee_template_versions WHERE profile_id=? AND sha256=?", [profileId, sha256]);
}
async function shopeeGetTemplateCategories(env, versionId) {
  return await query(env, "SELECT category_id AS id, category_name AS name, dts_range, dts_min, dts_max FROM ews_shopee_template_version_categories WHERE version_id=? ORDER BY category_name", [versionId]);
}
async function shopeeGetTemplateCategory(env, versionId, categoryId) {
  return await getOne(env, "SELECT category_id AS id, category_name AS name, dts_range, dts_min, dts_max FROM ews_shopee_template_version_categories WHERE version_id=? AND category_id=?", [versionId, categoryId]);
}
async function shopeeGetTemplateFields(env, versionId) {
  return await query(env, "SELECT * FROM ews_shopee_template_fields WHERE version_id=? ORDER BY column_index", [versionId]);
}
async function shopeeSaveTemplateVersion(env, profile, version, fields, categories, userMeta) {
  await env.DB.prepare(`INSERT INTO ews_shopee_template_profiles
    (id,market,store_context_id,profile_code,system_name,status,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,datetime('now'),datetime('now'))
    ON CONFLICT(market,store_context_id) DO NOTHING`)
    .bind(profile.id, profile.market, profile.store_context_id, profile.profile_code, profile.system_name, profile.status, profile.created_by).run();
  await env.DB.prepare(`INSERT INTO ews_shopee_template_versions
    (id,profile_id,uploaded_by,filename,r2_key,sha256,schema_hash,signature,template_type,field_count,
     logistics_count,category_count,manifest_json,status,has_sensitive_data,sensitive_summary,approved_by,approved_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`)
    .bind(version.id, profile.id, version.uploaded_by, version.filename, version.r2_key, version.sha256,
      version.schema_hash, version.signature, version.template_type, version.field_count, version.logistics_count,
      version.category_count, version.manifest_json, version.status, version.has_sensitive_data ? 1 : 0,
      version.sensitive_summary, version.approved_by || null, version.approved_at || null).run();
  const fieldInsert = `INSERT INTO ews_shopee_template_fields
    (version_id,token,column_index,column_name,label,requirement,data_type,semantic_key,mapping_status,is_required)
    VALUES (?,?,?,?,?,?,?,?,?,?)`;
  for (let offset = 0; offset < fields.length; offset += 75) {
    await env.DB.batch(fields.slice(offset, offset + 75).map(field => env.DB.prepare(fieldInsert).bind(
      version.id, field.token, field.column, field.column_name, field.label || '', field.requirement || '',
      field.data_type || 'string', field.semantic_key || '', field.mapping_status, field.is_required ? 1 : 0
    )));
  }
  const categoryInsert = "INSERT INTO ews_shopee_template_version_categories (version_id,category_id,category_name,dts_range,dts_min,dts_max) VALUES (?,?,?,?,?,?)";
  for (let offset = 0; offset < categories.length; offset += 75) {
    await env.DB.batch(categories.slice(offset, offset + 75).map(category => env.DB.prepare(categoryInsert).bind(
      version.id, category.id, category.name, category.dts_range || '', category.dts_min ?? null, category.dts_max ?? null
    )));
  }
  await env.DB.prepare(`INSERT INTO ews_shopee_template_user_meta
    (profile_id,user_id,alias,note,is_favorite,created_at,updated_at) VALUES (?,?,?,?,?,datetime('now'),datetime('now'))
    ON CONFLICT(profile_id,user_id) DO UPDATE SET alias=excluded.alias,note=excluded.note,
      is_favorite=excluded.is_favorite,updated_at=datetime('now')`)
    .bind(profile.id, version.uploaded_by, userMeta.alias, userMeta.note, userMeta.is_favorite ? 1 : 0).run();
  if (version.status === 'ready') {
    await env.DB.prepare(`UPDATE ews_shopee_template_profiles SET current_version_id=?,
      status=CASE WHEN status IN ('disabled','deleted') THEN status ELSE 'active' END,
      updated_at=datetime('now') WHERE id=?`).bind(version.id, profile.id).run();
  } else {
    await env.DB.prepare(`UPDATE ews_shopee_template_profiles SET
      status=CASE WHEN current_version_id IS NULL THEN ? ELSE status END,
      updated_at=datetime('now') WHERE id=?`).bind(version.status, profile.id).run();
  }
}
async function shopeeUpdateTemplateUserMeta(env, profileId, userId, meta) {
  await env.DB.prepare(`INSERT INTO ews_shopee_template_user_meta
    (profile_id,user_id,alias,note,is_favorite,created_at,updated_at) VALUES (?,?,?,?,?,datetime('now'),datetime('now'))
    ON CONFLICT(profile_id,user_id) DO UPDATE SET alias=excluded.alias,note=excluded.note,
      is_favorite=excluded.is_favorite,updated_at=datetime('now')`)
    .bind(profileId, userId, meta.alias, meta.note, meta.is_favorite ? 1 : 0).run();
}
async function shopeeUpdateTemplateProfile(env, profileId, globalAlias, status) {
  await env.DB.prepare("UPDATE ews_shopee_template_profiles SET system_name=?,status=?,deleted_at=NULL,updated_at=datetime('now') WHERE id=?")
    .bind(globalAlias, status, profileId).run();
}
async function shopeeMapTemplateField(env, versionId, token, semanticKey, adminId) {
  return await env.DB.prepare(`UPDATE ews_shopee_template_fields SET semantic_key=?,mapping_status='mapped',
    mapped_by=?,mapped_at=datetime('now') WHERE version_id=? AND token=?`)
    .bind(semanticKey, adminId, versionId, token).run();
}
async function shopeeCountUnmappedRequiredFields(env, versionId) {
  const row = await getOne(env, "SELECT COUNT(*) AS count FROM ews_shopee_template_fields WHERE version_id=? AND mapping_status='unmapped_required'", [versionId]);
  return Number(row?.count || 0);
}
async function shopeeApproveTemplateVersion(env, profileId, versionId, adminId) {
  await env.DB.batch([
    env.DB.prepare("UPDATE ews_shopee_template_versions SET status='ready',approved_by=?,approved_at=datetime('now') WHERE id=? AND profile_id=?").bind(adminId, versionId, profileId),
    env.DB.prepare("UPDATE ews_shopee_template_profiles SET current_version_id=?,status='active',deleted_at=NULL,updated_at=datetime('now') WHERE id=?").bind(versionId, profileId),
  ]);
}
async function shopeeSoftDeleteTemplateProfile(env, profileId) {
  await env.DB.prepare("UPDATE ews_shopee_template_profiles SET status='deleted',deleted_at=datetime('now'),updated_at=datetime('now') WHERE id=?").bind(profileId).run();
}
async function shopeeGetTemplateProfileVersions(env, profileId) {
  return await query(env, "SELECT * FROM ews_shopee_template_versions WHERE profile_id=? AND deleted_at IS NULL ORDER BY datetime(created_at) DESC, id DESC", [profileId]);
}
async function shopeeDeleteTemplateVersions(env, profileId, versions, replacementVersionId) {
  const deleted = [];
  for (const version of versions) {
    if (!version?.id || version.id === replacementVersionId) continue;
    const guard = "NOT EXISTS (SELECT 1 FROM ews_shopee_template_profiles WHERE id=? AND current_version_id=?)";
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE ews_shopee_products SET template_version_id=?
        WHERE template_profile_id=? AND template_version_id=? AND ${guard}`)
        .bind(replacementVersionId || '', profileId, version.id, profileId, version.id),
      env.DB.prepare(`DELETE FROM ews_shopee_template_version_categories WHERE version_id=? AND ${guard}`)
        .bind(version.id, profileId, version.id),
      env.DB.prepare(`DELETE FROM ews_shopee_template_fields WHERE version_id=? AND ${guard}`)
        .bind(version.id, profileId, version.id),
      env.DB.prepare(`DELETE FROM ews_shopee_template_versions WHERE id=? AND profile_id=? AND ${guard}`)
        .bind(version.id, profileId, profileId, version.id),
    ]);
    if (Number(results.at(-1)?.meta?.changes || 0) > 0) deleted.push(version);
  }
  return deleted;
}
async function shopeeGetTemplateProfileTaskCount(env, profileId) {
  const row = await getOne(env, "SELECT COUNT(*) AS count FROM ews_shopee_products WHERE template_profile_id=?", [profileId]);
  return Number(row?.count || 0);
}
async function shopeePurgeTemplateProfile(env, profileId) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM ews_shopee_template_version_categories WHERE version_id IN (SELECT id FROM ews_shopee_template_versions WHERE profile_id=?)").bind(profileId),
    env.DB.prepare("DELETE FROM ews_shopee_template_fields WHERE version_id IN (SELECT id FROM ews_shopee_template_versions WHERE profile_id=?)").bind(profileId),
    env.DB.prepare("DELETE FROM ews_shopee_template_user_meta WHERE profile_id=?").bind(profileId),
    env.DB.prepare("DELETE FROM ews_shopee_template_groups WHERE profile_id=?").bind(profileId),
    env.DB.prepare("DELETE FROM ews_shopee_template_versions WHERE profile_id=?").bind(profileId),
    env.DB.prepare("DELETE FROM ews_shopee_template_profiles WHERE id=?").bind(profileId),
  ]);
}
async function shopeeCreateProduct(env, p) {
  await env.DB.prepare(`INSERT INTO ews_shopee_products
    (id, task_id, category_id, name, main_description, reference_title, reference_image, auxiliary_images, generate_count, mode, main_image_count, detail_image_count, parent_sku, parent_sku_mode, cover_image, images, weight_kg, length_cm, width_cm, height_cm, dimension_mode, gtin, brand_id, hs_code, tax_code, origin_country, variation_name1, variation_name2, variation_image_mode, max_purchase_qty, size_chart_template_id, size_chart_image, pre_order_dts, shipping_channels, source_brief, product_type, variation_name1_export, variation_name2_export, max_purchase_start_date, max_purchase_period_days, max_purchase_end_date, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      task_id=excluded.task_id, category_id=excluded.category_id, name=excluded.name,
      main_description=excluded.main_description,
      reference_title=excluded.reference_title, reference_image=excluded.reference_image, auxiliary_images=excluded.auxiliary_images,
      generate_count=excluded.generate_count, mode=excluded.mode, main_image_count=excluded.main_image_count,
      detail_image_count=excluded.detail_image_count, parent_sku=excluded.parent_sku, parent_sku_mode=excluded.parent_sku_mode, cover_image=excluded.cover_image,
      images=excluded.images, weight_kg=excluded.weight_kg, length_cm=excluded.length_cm, width_cm=excluded.width_cm,
      height_cm=excluded.height_cm, dimension_mode=excluded.dimension_mode, gtin=excluded.gtin, brand_id=excluded.brand_id, hs_code=excluded.hs_code,
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
      p.main_image_count || 9, p.detail_image_count ?? 0, p.parent_sku || '', p.parent_sku_mode || 'numbered', p.cover_image || '', p.images || '[]',
      p.weight_kg || 0, p.length_cm ?? null, p.width_cm ?? null, p.height_cm ?? null, p.dimension_mode || 'global', p.gtin || '', p.brand_id || '',
      p.hs_code || '', p.tax_code || '', p.origin_country || '', p.variation_name1 || '', p.variation_name2 || '',
      p.variation_image_mode || 'upload', p.max_purchase_qty ?? null, p.size_chart_template_id || '',
      p.size_chart_image || '', p.pre_order_dts ?? null, p.shipping_channels || '[]', p.source_brief || '',
      p.product_type || 'one', p.variation_name1_export || '', p.variation_name2_export || '',
      p.max_purchase_start_date || '', p.max_purchase_period_days ?? null, p.max_purchase_end_date || ''
    ).run();
  await env.DB.prepare(`UPDATE ews_shopee_products
    SET store_id='',template_profile_id=?,template_version_id=? WHERE id=?`)
    .bind(p.template_profile_id || '', p.template_version_id || '', p.id).run();
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
async function shopeeUpdateProductTemplate(env, productId, profileId, versionId) {
  await env.DB.prepare("UPDATE ews_shopee_products SET template_profile_id=?,template_version_id=?,updated_at=datetime('now') WHERE id=?")
    .bind(profileId, versionId, productId).run();
}
async function shopeeDeleteProduct(env, pid) { await env.DB.prepare("DELETE FROM ews_shopee_products WHERE id = ?").bind(pid).run(); }
async function shopeeCreateVariations(env, vs) { var s = env.DB.prepare("INSERT INTO ews_shopee_variations (id, product_id, integration_no, option1, option1_export, image_per_variation, option2, option2_export, image_2, price, price_float_enabled, price_min, price_max, price_precision, stock, sku, sku_description, weight_kg, length_cm, width_cm, height_cm, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))"); for (const v of vs) await s.bind(v.id, v.product_id, v.integration_no, v.option1, v.option1_export || '', v.image_per_variation || '', v.option2 || '', v.option2_export || '', v.image_2 || '', v.price, v.price_float_enabled ? 1 : 0, v.price_min ?? null, v.price_max ?? null, v.price_precision ?? 0, v.stock ?? 999, v.sku || '', v.sku_description || '', v.weight_kg ?? 0.2, v.length_cm ?? null, v.width_cm ?? null, v.height_cm ?? null).run(); }
async function shopeeClearVariations(env, pid) { await env.DB.prepare("DELETE FROM ews_shopee_variations WHERE product_id = ?").bind(pid).run(); }
async function shopeeReplaceVariations(env, pid, variations) {
  const statements = [env.DB.prepare("DELETE FROM ews_shopee_variations WHERE product_id = ?").bind(pid)];
  for (const v of variations) statements.push(env.DB.prepare("INSERT INTO ews_shopee_variations (id, product_id, integration_no, option1, option1_export, image_per_variation, option2, option2_export, image_2, price, price_float_enabled, price_min, price_max, price_precision, stock, sku, sku_description, weight_kg, length_cm, width_cm, height_cm, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))").bind(v.id, v.product_id, v.integration_no, v.option1, v.option1_export || '', v.image_per_variation || '', v.option2 || '', v.option2_export || '', v.image_2 || '', v.price, v.price_float_enabled ? 1 : 0, v.price_min ?? null, v.price_max ?? null, v.price_precision ?? 0, v.stock ?? 999, v.sku || '', v.sku_description || '', v.weight_kg ?? 0.2, v.length_cm ?? null, v.width_cm ?? null, v.height_cm ?? null));
  await env.DB.batch(statements);
}

// -- Shopee 子任务 & 图片
async function shopeeCreateSubTask(env, s) { await env.DB.prepare("INSERT INTO ews_shopee_sub_tasks (id, parent_task_id, set_index, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', datetime('now'), '')").bind(s.id, s.parent_task_id, s.set_index).run(); }
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
  var p = await getOne(env, "SELECT SUM(CASE WHEN status IN ('pending','dispatching','processing') THEN 1 ELSE 0 END) as active, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed FROM ews_shopee_push_plans WHERE task_id = ?", [tid]);
  if ((p?.failed || 0) > 0) { var fs = (p?.active || 0) > 0 ? 'partial_failed' : 'failed'; await env.DB.prepare("UPDATE ews_shopee_products SET status=?, updated_at=datetime('now') WHERE id=?").bind(fs, tid).run(); await updateTaskIndexStatus(env, tid, fs); return; }
  var r = await getOne(env, "SELECT COUNT(*) as total, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as done FROM ews_shopee_sub_tasks WHERE parent_task_id = ?", [tid]);
  if (r && r.total > 0 && r.total === r.done && (p?.active || 0) === 0) { await env.DB.prepare("UPDATE ews_shopee_products SET status='completed', updated_at=datetime('now') WHERE id=?").bind(tid).run(); await updateTaskIndexStatus(env, tid, 'completed'); }
}
async function shopeeRefundCredits(env, tid) { var t = await getOne(env, "SELECT user_id FROM ews_tasks WHERE id = ?", [tid]); if (t?.user_id) await env.DB.prepare("UPDATE ews_users SET credits = credits + 1 WHERE id = ?").bind(t.user_id).run(); }

// -- Shopee 推送计划
async function shopeeCreatePushPlans(env, plans) { await createPushPlans(env, 'ews_shopee_push_plans', plans); }
async function shopeeGetPushPlans(env, tid) { return await query(env, "SELECT * FROM ews_shopee_push_plans WHERE task_id = ? ORDER BY batch_order ASC, webhook_type ASC", [tid]); }
async function shopeeGetPendingPlans(env, tid, lim) { return await query(env, "SELECT * FROM ews_shopee_push_plans WHERE task_id = ? AND status='pending' ORDER BY batch_order ASC LIMIT ?", [tid, lim]); }
async function shopeeUpdatePlanStatus(env, pid, s, e) { await env.DB.prepare("UPDATE ews_shopee_push_plans SET status=?, error=? WHERE id=?").bind(s, e || '', pid).run(); }
async function shopeeGetPlanStats(env, tid) { var r = await query(env, "SELECT status, COUNT(*) as cnt FROM ews_shopee_push_plans WHERE task_id=? GROUP BY status", [tid]); var s = { pending: 0, dispatching: 0, processing: 0, done: 0, failed: 0, total: 0 }; for (const x of (r?.results || [])) { s[x.status] = x.cnt; s.total += x.cnt; } return s; }

// Shopee 导出记录
async function shopeeCreateExportRecord(env, r) { await env.DB.prepare("INSERT INTO ews_shopee_export_records (id, task_id, file_url, created_at) VALUES (?, ?, ?, datetime('now'))").bind(r.id, r.task_id, r.file_url).run(); }

// ==================== 导出 ====================
export {
  query, getOne,
  getConfig, updateConfig, getPlatformConfig,
  getGroupList, getGroupById, createGroup, updateGroup,
  createUser, createUserWithCreditCharge, getUserByUsername, getUserList, updateUserPassword, toggleUserActive, updateUserGroup, deleteUser, deleteUserWithCreditRefund, updateUserPlatformAccess, updateUserImageConcurrencyLimit, updateUserWebhook,
  normalizeUserImageConcurrencyLimit,
  getUserCredits, updateUserCredits, transferUserCredits, consumeUserCredit,
  TASK_RETENTION_DAYS, isTaskExpired,
  createTaskIndex, updateTaskIndexStatus, getTaskIndex, getTaskList, getTaskCount, deleteTaskIndex,
  jstCreateTask, jstUpdateTask, jstGetTask, jstUpdateTaskStatus,
  jstCreateVariant, jstClearVariants, jstReplaceVariants,
  jstCreateSubTask, jstGetSubTasks, jstUpdateSubTask, jstDeleteSubTasks,
  jstSaveMetadataBatch, jstSaveImage, jstClearImages,
  jstCreateExpectedImages, jstCheckSubTaskImages, jstCheckParentCompletion, jstDeleteTaskRecord,
  jstCreatePushPlans, jstGetPushPlans, jstGetPendingPlans, jstUpdatePlanStatus, jstGetPlanStats,
  jstRefundCredits,
  shopeeCreateProduct, shopeeGetProduct, shopeeUpdateProductTemplate, shopeeDeleteProduct,
  shopeeListTemplateProfiles, shopeeGetTemplateProfile, shopeeGetTemplateProfileByContext, shopeeClaimTemplateProfile,
  shopeeAssignTemplateGroup, shopeeReplaceTemplateGroups, shopeeReplaceGroupTemplates,
  shopeeGetTemplateVersion, shopeeGetCurrentTemplateVersion, shopeeGetLatestTemplateVersion, shopeeGetTemplateVersionByHash,
  shopeeGetTemplateCategories, shopeeGetTemplateCategory, shopeeGetTemplateFields, shopeeSaveTemplateVersion,
  shopeeUpdateTemplateUserMeta, shopeeUpdateTemplateProfile, shopeeMapTemplateField, shopeeCountUnmappedRequiredFields,
  shopeeApproveTemplateVersion, shopeeSoftDeleteTemplateProfile, shopeeGetTemplateProfileVersions,
  shopeeDeleteTemplateVersions,
  shopeeGetTemplateProfileTaskCount, shopeePurgeTemplateProfile,
  shopeeCreateVariations, shopeeClearVariations, shopeeReplaceVariations,
  shopeeCreatePushPlans, shopeeGetPushPlans, shopeeGetPendingPlans, shopeeUpdatePlanStatus, shopeeGetPlanStats,
  shopeeCreateExportRecord,
  shopeeCreateSubTask, shopeeGetSubTasks, shopeeUpdateSubTask,
  shopeeCreateExpectedImages, shopeeCheckSubTaskImages,
  shopeeSaveImage, shopeeCheckParentCompletion, shopeeRefundCredits, shopeeUpdateVariationExports,
};
