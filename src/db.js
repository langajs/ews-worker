// EWS - 数据库操作模块（分平台）
// 共享: ews_ / JST: ews_jst_ / Shopee: ews_shopee_

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
    let sql = "SELECT key, value FROM ews_config WHERE platform = ?";
    const rows = await query(env, sql, [platform]);
    const config = {};
    for (const row of rows.results) config[row.key] = row.value;
    // 合并通用配置
    if (platform) {
      const common = await getConfig(env, '');
      Object.assign(config, common);
    }
    return config;
  } catch { return {}; }
}

async function updateConfig(env, key, value, platform = '') {
  await env.DB.prepare(
    "INSERT INTO ews_config (key, value, platform, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(key, platform) DO UPDATE SET value = ?, updated_at = datetime('now')"
  ).bind(key, value, platform, value).run();
}

async function getPlatformConfig(env, platform) {
  return getConfig(env, platform);
}

// --- 用户 ---
async function createUser(env, user) {
  await env.DB.prepare(
    "INSERT INTO ews_users (id, username, password_hash, role, display_name, created_by) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(user.id, user.username, user.password_hash, user.role || 'user', user.display_name || '', user.created_by || '').run();
}
async function getUserByUsername(env, username) {
  return await getOne(env, "SELECT * FROM ews_users WHERE username = ?", [username]);
}
async function getUserList(env) {
  return await query(env, "SELECT id, username, role, display_name, is_active, credits, created_at FROM ews_users ORDER BY created_at ASC");
}
async function updateUserPassword(env, userId, passwordHash) {
  await env.DB.prepare("UPDATE ews_users SET password_hash = ? WHERE id = ?").bind(passwordHash, userId).run();
}
async function toggleUserActive(env, userId, isActive) {
  await env.DB.prepare("UPDATE ews_users SET is_active = ? WHERE id = ?").bind(isActive ? 1 : 0, userId).run();
}
async function updateUserWebhook(env, userId, webhookConfig) {
  await env.DB.prepare("UPDATE ews_users SET webhook_config = ? WHERE id = ?").bind(webhookConfig, userId).run();
}
async function getUserCredits(env, userId) {
  const row = await getOne(env, "SELECT credits FROM ews_users WHERE id = ?", [userId]);
  return row?.credits ?? 0;
}
async function updateUserCredits(env, userId, amount, mode) {
  if (mode === 'set') await env.DB.prepare("UPDATE ews_users SET credits = ? WHERE id = ?").bind(Math.max(0, amount), userId).run();
  else if (mode === 'add') await env.DB.prepare("UPDATE ews_users SET credits = credits + ? WHERE id = ?").bind(amount, userId).run();
  else if (mode === 'subtract') await env.DB.prepare("UPDATE ews_users SET credits = MAX(0, credits - ?) WHERE id = ?").bind(amount, userId).run();
}

// --- 统一任务索引 ---
async function createTaskIndex(env, id, platform, name, userId) {
  await env.DB.prepare(
    "INSERT INTO ews_tasks (id, platform, name, status, user_id, created_at, updated_at) VALUES (?, ?, ?, 'init', ?, datetime('now'), datetime('now'))"
  ).bind(id, platform, name || '', userId || '').run();
}
async function updateTaskIndexStatus(env, id, status) {
  await env.DB.prepare("UPDATE ews_tasks SET status = ?, updated_at = datetime('now') WHERE id = ?").bind(status, id).run();
}
async function getTaskIndex(env, id) {
  return await getOne(env, "SELECT * FROM ews_tasks WHERE id = ?", [id]);
}
async function getTaskList(env, platform, userId, role) {
  let sql = "SELECT * FROM ews_tasks";
  const params = [];
  const wheres = [];
  if (platform) { wheres.push("platform = ?"); params.push(platform); }
  if (role !== 'admin') { wheres.push("user_id = ?"); params.push(userId); }
  if (wheres.length) sql += " WHERE " + wheres.join(" AND ");
  sql += " ORDER BY created_at DESC";
  return await query(env, sql, params);
}
async function deleteTaskIndex(env, id) {
  await env.DB.prepare("DELETE FROM ews_tasks WHERE id = ?").bind(id).run();
}

// ==================== JST 模块 ews_jst_ ====================

async function jstCreateTask(env, task) {
  await env.DB.prepare(
    "INSERT INTO ews_jst_tasks (id, name, topic_items, description, main_description, detail_description, reference_image, auxiliary_images, generate_count, stock, weight, variant_count, main_image_count, detail_image_count, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))"
  ).bind(task.id, task.name ?? '', task.topic_items ?? '', task.description, task.main_description ?? '', task.detail_description ?? '',
    task.reference_image, task.auxiliary_images ?? '', task.generate_count, task.stock, task.weight, task.variant_count, task.main_image_count ?? 5, task.detail_image_count ?? 5).run();
}
async function jstUpdateTask(env, taskId, data) {
  await env.DB.prepare(
    "UPDATE ews_jst_tasks SET name=?, topic_items=?, description=?, main_description=?, detail_description=?, reference_image=?, auxiliary_images=?, generate_count=?, stock=?, weight=?, variant_count=?, main_image_count=?, detail_image_count=?, mode=?, status='pending', updated_at=datetime('now') WHERE id=?"
  ).bind(data.name ?? '', data.topic_items ?? '', data.description ?? '', data.main_description ?? '', data.detail_description ?? '',
    data.reference_image ?? '', data.auxiliary_images ?? '', data.generate_count ?? 1, data.stock ?? 999, data.weight ?? 1.0,
    data.variant_count ?? 1, data.main_image_count ?? 5, data.detail_image_count ?? 5, data.mode ?? 'full', taskId).run();
}
async function jstGetTask(env, taskId) {
  const task = await getOne(env, "SELECT * FROM ews_jst_tasks WHERE id = ?", [taskId]);
  if (!task) return null;
  const variants = await query(env, "SELECT * FROM ews_jst_variants WHERE task_id = ? ORDER BY sort_order", [taskId]);
  const images = await query(env, "SELECT * FROM ews_jst_task_images WHERE parent_task_id = ? ORDER BY set_index, image_type, position", [taskId]);
  const subTasks = await query(env, "SELECT * FROM ews_jst_sub_tasks WHERE parent_task_id = ? ORDER BY set_index", [taskId]);
  return { ...task, variants: variants.results, images: images.results, sub_tasks: subTasks.results };
}
async function jstUpdateTaskStatus(env, taskId, status) {
  await env.DB.prepare("UPDATE ews_jst_tasks SET status = ?, updated_at = datetime('now') WHERE id = ?").bind(status, taskId).run();
}

async function jstCreateVariant(env, v) {
  await env.DB.prepare(
    "INSERT INTO ews_jst_variants (id, task_id, tier1_name, tier1_value, tier2_name, tier2_value, white_bg_image, price, description, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))"
  ).bind(v.id, v.task_id, v.tier1_name || '', v.tier1_value, v.tier2_name || '', v.tier2_value || '', v.white_bg_image, v.price ?? null, v.description ?? '', v.sort_order).run();
}
async function jstClearVariants(env, taskId) {
  await env.DB.prepare("DELETE FROM ews_jst_variants WHERE task_id = ?").bind(taskId).run();
}

async function jstCreateSubTask(env, st) {
  await env.DB.prepare(
    "INSERT INTO ews_jst_sub_tasks (id, parent_task_id, set_index, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', datetime('now'), '')"
  ).bind(st.id, st.parent_task_id, st.set_index).run();
}
async function jstGetSubTasks(env, taskId) {
  return await query(env, "SELECT * FROM ews_jst_sub_tasks WHERE parent_task_id = ? ORDER BY set_index", [taskId]);
}
async function jstUpdateSubTask(env, subTaskId, data) {
  const setClauses = []; const params = [];
  if (data.title !== undefined) { setClauses.push('title = ?'); params.push(data.title); }
  if (data.status !== undefined) { setClauses.push('status = ?'); params.push(data.status); }
  if (!setClauses.length) return;
  setClauses.push("updated_at = datetime('now')"); params.push(subTaskId);
  await env.DB.prepare(`UPDATE ews_jst_sub_tasks SET ${setClauses.join(', ')} WHERE id = ?`).bind(...params).run();
}
async function jstDeleteSubTasks(env, taskId) {
  await env.DB.prepare("DELETE FROM ews_jst_sub_tasks WHERE parent_task_id = ?").bind(taskId).run();
}

async function jstCreateSkuTitle(env, sku) {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO ews_jst_sku_titles (id, sub_task_id, variant_id, title, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
  ).bind(sku.id, sku.sub_task_id, sku.variant_id, sku.title).run();
}

async function jstSaveImage(env, img) {
  const pk = `${img.sub_task_id}_${img.image_type}_${img.position}_${img.variant_id || ''}`;
  await env.DB.prepare(
    "INSERT OR REPLACE INTO ews_jst_task_images (id, parent_task_id, sub_task_id, variant_id, set_index, image_type, position, image_url, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', datetime('now'))"
  ).bind(pk, img.parent_task_id, img.sub_task_id, img.variant_id, img.set_index, img.image_type, img.position, img.image_url).run();
}
async function jstClearImages(env, taskId) {
  await env.DB.prepare("DELETE FROM ews_jst_task_images WHERE parent_task_id = ?").bind(taskId).run();
}

async function jstCreateExpectedImages(env, taskId, subTaskId, setIndex, variantCount, mode, mainImageCount, detailImageCount) {
  mainImageCount = mainImageCount || 5; detailImageCount = detailImageCount || 5;
  const types = [];
  if (mode === 'dedup' && setIndex > 0) {
    types.push({ type: 'main', pos: 1 });
  } else {
    types.push({ type: 'main', pos: 1 });
    for (let p = 2; p <= mainImageCount; p++) types.push({ type: 'sub', pos: p });
    for (let p = 1; p <= detailImageCount; p++) types.push({ type: 'detail', pos: p });
    for (let v = 0; v < variantCount; v++) types.push({ type: 'sku', pos: v + 1 });
  }
  for (const t of types) {
    const pk = `${subTaskId}_${t.type}_${t.pos}_`;
    await env.DB.prepare(
      "INSERT OR IGNORE INTO ews_jst_task_images (id, parent_task_id, sub_task_id, variant_id, set_index, image_type, position, image_url, status, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, '', 'pending', datetime('now'))"
    ).bind(pk, taskId, subTaskId, setIndex, t.type, t.pos).run();
  }
}
async function jstCheckSubTaskImages(env, subTaskId) {
  const row = await getOne(env,
    "SELECT COUNT(*) as total, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as done FROM ews_jst_task_images WHERE sub_task_id = ?", [subTaskId]);
  return { total: row?.total || 0, completed: row?.done || 0 };
}
async function jstCheckParentCompletion(env, taskId) {
  const row = await getOne(env,
    "SELECT COUNT(*) as total, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as done FROM ews_jst_sub_tasks WHERE parent_task_id = ?", [taskId]);
  if (row && row.total > 0 && row.total === row.done) {
    await env.DB.prepare("UPDATE ews_jst_tasks SET status='completed', updated_at=datetime('now') WHERE id=?").bind(taskId).run();
    await updateTaskIndexStatus(env, taskId, 'completed');
  }
}
async function jstDeleteTaskRecord(env, taskId) {
  await env.DB.prepare("DELETE FROM ews_jst_tasks WHERE id = ?").bind(taskId).run();
}

// -- JST 推送计划 --
async function jstCreatePushPlans(env, plans) {
  const stmt = env.DB.prepare(
    "INSERT INTO ews_jst_push_plans (id, task_id, sub_task_id, webhook_type, webhook_url, payload, status, batch_order, retry_count, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 0, datetime('now'))"
  );
  for (const p of plans) await stmt.bind(p.id, p.task_id, p.sub_task_id, p.webhook_type, p.webhook_url, p.payload, p.batch_order).run();
}
async function jstGetPushPlans(env, taskId) {
  return await query(env, "SELECT * FROM ews_jst_push_plans WHERE task_id = ? ORDER BY batch_order ASC, webhook_type ASC", [taskId]);
}
async function jstGetPendingPlans(env, taskId, limit) {
  return await query(env, "SELECT * FROM ews_jst_push_plans WHERE task_id = ? AND status='pending' ORDER BY batch_order ASC LIMIT ?", [taskId, limit]);
}
async function jstUpdatePlanStatus(env, planId, status, error_ = '') {
  await env.DB.prepare("UPDATE ews_jst_push_plans SET status=?, error=? WHERE id=?").bind(status, error_, planId).run();
}
async function jstGetPlanStats(env, taskId) {
  const rows = await query(env, "SELECT status, COUNT(*) as cnt FROM ews_jst_push_plans WHERE task_id=? GROUP BY status", [taskId]);
  const stats = { pending: 0, processing: 0, done: 0, failed: 0, total: 0 };
  for (const r of (rows?.results || [])) { stats[r.status] = r.cnt; stats.total += r.cnt; }
  return stats;
}
async function jstRefundCredits(env, taskId) {
  const task = await getOne(env, "SELECT user_id FROM ews_tasks WHERE id = ?", [taskId]);
  if (task?.user_id) await env.DB.prepare("UPDATE ews_users SET credits = credits + 1 WHERE id = ?").bind(task.user_id).run();
}

// ==================== Shopee 模块 ews_shopee_ ====================

async function shopeeCreateProduct(env, product) {
  await env.DB.prepare(
    "INSERT INTO ews_shopee_products (id, task_id, category_id, name, description, parent_sku, cover_image, images, weight_kg, length_cm, width_cm, height_cm, gtin, brand_id, hs_code, tax_code, origin_country, variation_name1, variation_name2, max_purchase_qty, size_chart_template_id, size_chart_image, pre_order_dts, shipping_channels, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))"
  ).bind(product.id, product.task_id, product.category_id || '', product.name, product.description || '', product.parent_sku || '',
    product.cover_image || '', product.images || '[]', product.weight_kg || 0, product.length_cm ?? null, product.width_cm ?? null, product.height_cm ?? null,
    product.gtin || '', product.brand_id || '', product.hs_code || '', product.tax_code || '', product.origin_country || '',
    product.variation_name1 || '', product.variation_name2 || '', product.max_purchase_qty ?? null,
    product.size_chart_template_id || '', product.size_chart_image || '', product.pre_order_dts ?? null,
    product.shipping_channels || '[]').run();
}
async function shopeeGetProduct(env, productId) {
  const product = await getOne(env, "SELECT * FROM ews_shopee_products WHERE id = ?", [productId]);
  if (!product) return null;
  const variants = await query(env, "SELECT * FROM ews_shopee_variations WHERE product_id = ?", [productId]);
  return { ...product, variations: variants.results };
}
async function shopeeDeleteProduct(env, productId) {
  await env.DB.prepare("DELETE FROM ews_shopee_products WHERE id = ?").bind(productId).run();
}

async function shopeeCreateVariations(env, variations) {
  const stmt = env.DB.prepare(
    "INSERT INTO ews_shopee_variations (id, product_id, integration_no, option1, image_per_variation, option2, image_2, price, stock, sku, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))"
  );
  for (const v of variations) await stmt.bind(v.id, v.product_id, v.integration_no, v.option1, v.image_per_variation || '', v.option2 || '', v.image_2 || '', v.price, v.stock || 0, v.sku || '').run();
}
async function shopeeClearVariations(env, productId) {
  await env.DB.prepare("DELETE FROM ews_shopee_variations WHERE product_id = ?").bind(productId).run();
}

// -- Shopee 推送计划 (复用 JST 逻辑) --
async function shopeeCreatePushPlans(env, plans) {
  const stmt = env.DB.prepare(
    "INSERT INTO ews_shopee_push_plans (id, task_id, sub_task_id, webhook_type, webhook_url, payload, status, batch_order, retry_count, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 0, datetime('now'))"
  );
  for (const p of plans) await stmt.bind(p.id, p.task_id, p.sub_task_id || '', p.webhook_type, p.webhook_url, p.payload, p.batch_order).run();
}
async function shopeeGetPushPlans(env, taskId) {
  return await query(env, "SELECT * FROM ews_shopee_push_plans WHERE task_id = ? ORDER BY batch_order ASC, webhook_type ASC", [taskId]);
}
async function shopeeGetPendingPlans(env, taskId, limit) {
  return await query(env, "SELECT * FROM ews_shopee_push_plans WHERE task_id = ? AND status='pending' ORDER BY batch_order ASC LIMIT ?", [taskId, limit]);
}
async function shopeeUpdatePlanStatus(env, planId, status, error_ = '') {
  await env.DB.prepare("UPDATE ews_shopee_push_plans SET status=?, error=? WHERE id=?").bind(status, error_, planId).run();
}
async function shopeeGetPlanStats(env, taskId) {
  const rows = await query(env, "SELECT status, COUNT(*) as cnt FROM ews_shopee_push_plans WHERE task_id=? GROUP BY status", [taskId]);
  const stats = { pending: 0, processing: 0, done: 0, failed: 0, total: 0 };
  for (const r of (rows?.results || [])) { stats[r.status] = r.cnt; stats.total += r.cnt; }
  return stats;
}

// Shopee 导出记录
async function shopeeCreateExportRecord(env, record) {
  await env.DB.prepare(
    "INSERT INTO ews_shopee_export_records (id, task_id, file_url, created_at) VALUES (?, ?, ?, datetime('now'))"
  ).bind(record.id, record.task_id, record.file_url).run();
}

// ==================== 导出 ====================

export {
  query, getOne,
  // 共享
  getConfig, updateConfig, getPlatformConfig,
  createUser, getUserByUsername, getUserList, updateUserPassword, toggleUserActive, updateUserWebhook,
  getUserCredits, updateUserCredits,
  createTaskIndex, updateTaskIndexStatus, getTaskIndex, getTaskList, deleteTaskIndex,
  // JST
  jstCreateTask, jstUpdateTask, jstGetTask, jstUpdateTaskStatus,
  jstCreateVariant, jstClearVariants,
  jstCreateSubTask, jstGetSubTasks, jstUpdateSubTask, jstDeleteSubTasks,
  jstCreateSkuTitle, jstSaveImage, jstClearImages,
  jstCreateExpectedImages, jstCheckSubTaskImages, jstCheckParentCompletion, jstDeleteTaskRecord,
  jstCreatePushPlans, jstGetPushPlans, jstGetPendingPlans, jstUpdatePlanStatus, jstGetPlanStats,
  jstRefundCredits,
  // Shopee
  shopeeCreateProduct, shopeeGetProduct, shopeeDeleteProduct,
  shopeeCreateVariations, shopeeClearVariations,
  shopeeCreatePushPlans, shopeeGetPushPlans, shopeeGetPendingPlans, shopeeUpdatePlanStatus, shopeeGetPlanStats,
  shopeeCreateExportRecord,
};
