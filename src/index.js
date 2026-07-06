// EWS - Cloudflare Worker 主入口（统一路由 + 分平台分发）

import {
  query, getOne, getConfig, updateConfig, getPlatformConfig,
  createUser, getUserByUsername, getUserList, updateUserPassword,
  toggleUserActive, updateUserWebhook, getUserCredits, updateUserCredits,
  createTaskIndex, updateTaskIndexStatus, getTaskIndex, getTaskList, deleteTaskIndex,
  jstCreateTask, jstUpdateTask, jstGetTask, jstUpdateTaskStatus,
  jstCreateVariant, jstClearVariants,
  jstCreateSubTask, jstGetSubTasks, jstUpdateSubTask, jstDeleteSubTasks,
  jstCreateSkuTitle, jstSaveImage, jstClearImages,
  jstCreateExpectedImages, jstCheckSubTaskImages, jstCheckParentCompletion, jstDeleteTaskRecord,
  jstCreatePushPlans, jstGetPushPlans, jstGetPendingPlans, jstUpdatePlanStatus, jstGetPlanStats,
  jstRefundCredits,
  shopeeCreateProduct, shopeeGetProduct, shopeeDeleteProduct,
  shopeeCreateVariations, shopeeClearVariations,
  shopeeCreatePushPlans, shopeeGetPushPlans, shopeeGetPendingPlans, shopeeUpdatePlanStatus, shopeeGetPlanStats,
  shopeeCreateExportRecord,
} from './db.js';
import { generateToken, hashPassword, verifyPassword, authenticateRequest, DEFAULT_PASSWORD } from './auth.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
}
function error(msg, status = 400) { return json({ success: false, error: msg }, status); }

function uuid(len = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  let id = '';
  for (let i = 0; i < len; i++) id += chars[arr[i] % chars.length];
  return id;
}

async function parseBody(request) {
  const ct = request.headers.get('Content-Type') || '';
  if (ct.includes('application/json')) return await request.json();
  if (ct.includes('multipart/form-data') || ct.includes('application/x-www-form-urlencoded')) return await request.formData();
  return null;
}

async function requireAuth(request, env, handler) {
  const auth = await authenticateRequest(request, env);
  if (!auth.valid) return error('未登录或登录已过期', 401);
  request.auth = auth;
  return await handler();
}

// 登录速率限制
const loginAttempts = new Map();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW = 300;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

    try {
      // ========== 共享路由 ==========

      if (path === '/api/ping' && method === 'GET')
        return json({ success: true, message: 'pong', time: Date.now() });

      // --- 认证 ---
      if (path === '/api/auth/login' && method === 'POST')
        return handleLogin(request, env);
      if (path === '/api/auth/verify' && method === 'GET')
        return handleVerify(request, env);
      if (path === '/api/auth/password' && method === 'PUT')
        return requireAuth(request, env, () => handleChangePassword(request, env));

      // --- 配置 (支持 ?platform=jst|shopee) ---
      if (path === '/api/config' && method === 'GET')
        return requireAuth(request, env, () => handleGetConfig(env, url));
      if (path === '/api/config' && method === 'PUT')
        return requireAuth(request, env, () => handleUpdateConfig(request, env));

      // --- 统一任务 ---
      if (path === '/api/tasks/init' && method === 'POST')
        return requireAuth(request, env, () => handleInitTask(request, env));
      if (path === '/api/tasks' && method === 'GET')
        return requireAuth(request, env, () => handleGetTasks(env, ctx, request.auth));
      if (path.match(/^\/api\/tasks\/[^\/]+$/) && method === 'GET')
        return requireAuth(request, env, () => handleGetTaskDetail(env, ctx, path));
      if (path.match(/^\/api\/tasks\/[^\/]+$/) && method === 'PUT')
        return requireAuth(request, env, () => handleUpdateTask(request, env, path));
      if (path.match(/^\/api\/tasks\/[^\/]+$/) && method === 'DELETE')
        return requireAuth(request, env, () => handleDeleteTask(env, path));
      if (path.match(/^\/api\/tasks\/[^\/]+\/status$/) && method === 'PUT')
        return requireAuth(request, env, () => handleUpdateTaskStatus(request, env, path));
      if (path.match(/^\/api\/tasks\/[^\/]+\/push$/) && method === 'POST')
        return requireAuth(request, env, () => handlePushTask(env, ctx, path, request));
      if (path.match(/^\/api\/tasks\/[^\/]+\/plans$/) && method === 'GET')
        return requireAuth(request, env, () => handleGetPlans(env, path));
      if (path.match(/^\/api\/tasks\/[^\/]+\/plans\/[^\/]+\/retry$/) && method === 'POST')
        return requireAuth(request, env, () => handleRetryPlan(env, path, request, ctx));
      if (path.match(/^\/api\/tasks\/[^\/]+\/export$/) && method === 'GET')
        return requireAuth(request, env, () => handleExportTask(env, path));

      // --- 回调 ---
      if (path === '/api/callback' && method === 'POST')
        return handleCallback(request, env, ctx);

      // --- 上传 ---
      if (path === '/api/upload' && method === 'POST')
        return requireAuth(request, env, () => handleUpload(request, env));

      // --- 用户管理 ---
      if (path === '/api/users' && method === 'GET')
        return requireAuth(request, env, () => handleGetUsers(request, env));
      if (path === '/api/users' && method === 'POST')
        return requireAuth(request, env, () => handleCreateUser(request, env));
      if (path.match(/^\/api\/users\/[^\/]+\/toggle$/) && method === 'PUT')
        return requireAuth(request, env, () => handleToggleUser(request, env, path));
      if (path === '/api/users/me/credits' && method === 'GET')
        return requireAuth(request, env, () => handleGetMyCredits(request, env));
      if (path.match(/^\/api\/users\/[^\/]+\/webhook$/) && method === 'GET')
        return requireAuth(request, env, () => handleGetUserWebhook(request, env, path));
      if (path.match(/^\/api\/users\/[^\/]+\/webhook$/) && method === 'PUT')
        return requireAuth(request, env, () => handleUpdateUserWebhook(request, env, path));
      if (path.match(/^\/api\/users\/[^\/]+\/credits$/) && method === 'PUT')
        return requireAuth(request, env, () => handleUpdateUserCredits(request, env, path));

      // --- R2 ---
      if (path.startsWith('/r2/')) return handleR2File(path, env);

      return error('Not Found', 404);
    } catch (err) {
      console.error('Route error:', err);
      return error(err.message || 'Internal Server Error', 500);
    }
  },
};

// ========== 认证处理 ==========

async function handleLogin(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const now = Math.floor(Date.now() / 1000);
  const record = loginAttempts.get(ip);
  if (record) {
    if (now - record.lastAttempt > RATE_LIMIT_WINDOW) loginAttempts.delete(ip);
    else if (record.blockedUntil && now < record.blockedUntil) return error('登录尝试过于频繁，请5分钟后再试', 429);
  }
  const body = await parseBody(request);
  const { password, username } = body || {};
  if (!password) return error('请输入密码', 400);

  const loginName = username || 'admin';
  let user = await getUserByUsername(env, loginName);
  if (!user) {
    const config = await getConfig(env);
    if (config.admin_password) {
      const valid = await verifyPassword(password, config.admin_password);
      if (valid) {
        const pwdHash = await hashPassword(password);
        try { await createUser(env, { id: loginName, username: loginName, password_hash: pwdHash, role: 'admin', created_by: 'system' }); } catch (_) {}
        user = await getUserByUsername(env, loginName);
      }
    }
  }
  if (!user || user.is_active === 0) return recordFail(loginAttempts, record, ip, now);
  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) return recordFail(loginAttempts, record, ip, now);

  loginAttempts.delete(ip);
  const token = await generateToken(env, user.username, user.role);
  return json({
    success: true, token,
    user: { username: user.username, role: user.role, display_name: user.display_name },
    is_default_password: password === DEFAULT_PASSWORD,
    message: password === DEFAULT_PASSWORD ? '请及时修改默认密码' : '登录成功',
  });

  function recordFail(map, rec, clientIp, ts) {
    const attempts = (rec?.attempts || 0) + 1;
    if (attempts >= RATE_LIMIT_MAX) {
      map.set(clientIp, { attempts, blockedUntil: ts + RATE_LIMIT_WINDOW, lastAttempt: ts });
      return error('登录尝试过于频繁，请5分钟后再试', 429);
    }
    map.set(clientIp, { attempts, lastAttempt: ts });
    return error('用户不存在或密码错误', 401);
  }
}

async function handleVerify(request, env) {
  const auth = await authenticateRequest(request, env);
  return json({ success: auth.valid, username: auth.username || null, role: auth.role || null });
}

async function handleChangePassword(request, env) {
  const body = await parseBody(request);
  const { old_password, new_password } = body || {};
  if (!old_password || !new_password) return error('请提供旧密码和新密码', 400);
  if (new_password.length < 6) return error('新密码长度不能少于6个字符', 400);
  const auth = request.auth;
  const user = await getUserByUsername(env, auth.username);
  if (!user) return error('用户不存在', 404);
  const valid = await verifyPassword(old_password, user.password_hash);
  if (!valid) return error('旧密码错误', 401);
  const newHash = await hashPassword(new_password);
  await updateUserPassword(env, user.id, newHash);
  return json({ success: true, message: '密码修改成功' });
}

// ========== 配置 ==========

async function handleGetConfig(env, url) {
  const platform = url.searchParams.get('platform') || '';
  const config = await getConfig(env, platform);
  const safe = { ...config };
  delete safe.admin_password;
  delete safe.jwt_secret_name;
  return json({ success: true, config: safe, platform });
}

async function handleUpdateConfig(request, env) {
  const body = await parseBody(request);
  if (!body || typeof body !== 'object') return error('无效的配置数据', 400);
  const platform = body._platform || '';
  delete body._platform;
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      await updateConfig(env, key, String(value), platform);
    }
  }
  return json({ success: true, message: '配置更新成功', platform });
}

// ========== 用户管理 ==========

async function handleGetUsers(request, env) {
  if (request.auth?.role !== 'admin') return error('无权访问', 403);
  const result = await getUserList(env);
  return json({ success: true, users: (result?.results || []).map(u => ({
    id: u.id, username: u.username, role: u.role, display_name: u.display_name,
    is_active: u.is_active, credits: u.credits ?? 0, created_at: u.created_at
  })) });
}

async function handleCreateUser(request, env) {
  if (request.auth?.role !== 'admin') return error('无权访问', 403);
  const body = await parseBody(request);
  const { username, password, role } = body || {};
  if (!username || !password) return error('用户名和密码不能为空', 400);
  if (password.length < 6) return error('密码长度不能少于6个字符', 400);
  const existing = await getUserByUsername(env, username);
  if (existing) return error('用户名已存在', 400);
  const pwdHash = await hashPassword(password);
  await createUser(env, { id: username, username, password_hash: pwdHash, role: role === 'admin' ? 'admin' : 'user', created_by: request.auth.username });
  return json({ success: true, message: '用户创建成功' }, 201);
}

async function handleToggleUser(request, env, path) {
  if (request.auth?.role !== 'admin') return error('无权访问', 403);
  const userId = path.split('/')[3];
  const user = await getUserByUsername(env, userId);
  if (!user) return error('用户不存在', 404);
  if (user.id === 'admin') return error('不能禁用管理员', 400);
  await toggleUserActive(env, user.id, !user.is_active);
  return json({ success: true, message: user.is_active ? '用户已禁用' : '用户已启用' });
}

async function handleGetUserWebhook(request, env, path) {
  if (request.auth?.role !== 'admin') return error('无权访问', 403);
  const userId = path.split('/')[3];
  const user = await getUserByUsername(env, userId);
  if (!user) return error('用户不存在', 404);
  let wh = {}; try { wh = JSON.parse(user.webhook_config || '{}'); } catch (_) {}
  return json({ success: true, webhook: wh });
}

async function handleUpdateUserWebhook(request, env, path) {
  if (request.auth?.role !== 'admin') return error('无权访问', 403);
  const userId = path.split('/')[3];
  const body = await parseBody(request);
  const user = await getUserByUsername(env, userId);
  if (!user) return error('用户不存在', 404);
  await updateUserWebhook(env, user.id, JSON.stringify(body));
  return json({ success: true, message: '用户工作流地址已更新' });
}

async function handleGetMyCredits(request, env) {
  const user = await getUserByUsername(env, request.auth.username);
  return json({ success: true, credits: user?.credits ?? 0 });
}

async function handleUpdateUserCredits(request, env, path) {
  if (request.auth?.role !== 'admin') return error('无权访问', 403);
  const userId = path.split('/')[3];
  const body = await parseBody(request);
  const { action, amount } = body || {};
  if (!action || amount === undefined || amount < 0 || !['set','add','subtract'].includes(action)) return error('参数无效', 400);
  const user = await getUserByUsername(env, userId);
  if (!user) return error('用户不存在', 404);
  await updateUserCredits(env, userId, amount, action);
  return json({ success: true, credits: await getUserCredits(env, userId), message: '算力已更新' });
}

// ========== 任务路由分发 ==========

function getTaskId(path) { return path.split('/')[3]; }

async function handleGetTasks(env, ctx, auth) {
  ctx.waitUntil(processPendingQueue(env, ctx));
  const result = await getTaskList(env, '', auth.username, auth.role);
  let tasks = result.results || [];
  if (auth.role !== 'admin') tasks = tasks.filter(t => t.user_id === auth.username);
  // 附加平台特定信息
  for (const t of tasks) {
    if (t.platform === 'jst') {
      const jst = await getOne(env, "SELECT name, status, mode FROM ews_jst_tasks WHERE id = ?", [t.id]);
      if (jst) { t.name = jst.name; t._mode = jst.mode; }
    } else if (t.platform === 'shopee') {
      const sp = await getOne(env, "SELECT name FROM ews_shopee_products WHERE task_id = ?", [t.id]);
      if (sp) t.name = sp.name;
    }
  }
  return json({ success: true, tasks, total: tasks.length });
}

async function handleInitTask(request, env) {
  const body = await parseBody(request);
  const platform = body?.platform || 'jst';
  const taskId = uuid();
  await createTaskIndex(env, taskId, platform, '', request.auth?.username || '');
  // 初始化平台数据
  if (platform === 'jst') {
    await env.DB.prepare(
      "INSERT INTO ews_jst_tasks (id, name, topic_items, description, main_description, detail_description, reference_image, auxiliary_images, generate_count, stock, weight, variant_count, main_image_count, detail_image_count, status, created_at, updated_at) VALUES (?, '', '', '', '', '', '', '', 1, 999, 1.0, 1, 5, 5, 'init', datetime('now'), datetime('now'))"
    ).bind(taskId).run();
  }
  await updateTaskIndexStatus(env, taskId, 'init');
  return json({ success: true, task_id: taskId, platform, message: '任务初始化成功' }, 201);
}

async function handleGetTaskDetail(env, ctx, path) {
  const taskId = getTaskId(path);
  ctx.waitUntil(processPendingQueue(env, ctx));
  const idx = await getTaskIndex(env, taskId);
  if (!idx) return error('任务不存在', 404);
  let detail = idx;
  if (idx.platform === 'jst') {
    const jst = await jstGetTask(env, taskId);
    if (!jst) return error('任务数据不存在', 404);
    detail = { ...idx, ...jst };
  } else if (idx.platform === 'shopee') {
    const sp = await shopeeGetProduct(env, taskId);
    if (sp) detail = { ...idx, product: sp };
  }
  return json({ success: true, task: detail });
}

async function handleUpdateTask(request, env, path) {
  const taskId = getTaskId(path);
  const body = await parseBody(request);
  const idx = await getTaskIndex(env, taskId);
  if (!idx) return error('任务不存在', 404);

  if (idx.platform === 'shopee') {
    const { name, task_description, category_id, brand_id, cover_image, images, weight_kg, length_cm, width_cm, height_cm, gtin, hs_code, tax_code, origin_country, variation_name1, variation_name2, pre_order_dts, shipping_channels, variations } = body || {};
    if (!name) return error('商品名称不能为空', 400);
    await env.DB.prepare("UPDATE ews_tasks SET name=?, status='pending', updated_at=datetime('now') WHERE id=?").bind(String(name).slice(0,30), taskId).run();
    await shopeeCreateProduct(env, {
      id: taskId, task_id: taskId, name, category_id: category_id || '',
      description: task_description || '', brand_id: brand_id || '',
      cover_image: cover_image || '', images: images || '[]',
      weight_kg: weight_kg || 0, length_cm: length_cm ?? null, width_cm: width_cm ?? null, height_cm: height_cm ?? null,
      gtin: gtin || '', hs_code: hs_code || '', tax_code: tax_code || '', origin_country: origin_country || '',
      variation_name1: variation_name1 || '', variation_name2: variation_name2 || '',
      pre_order_dts: pre_order_dts ?? null,
      shipping_channels: shipping_channels || '[]',
    });
    if (variations && Array.isArray(variations)) {
      await shopeeClearVariations(env, taskId);
      for (const v of variations) {
        await shopeeCreateVariations(env, [{
          id: v.id || uuid(), product_id: taskId, integration_no: v.integration_no || taskId.slice(0,8),
          option1: v.option1 || '', image_per_variation: v.image_per_variation || '',
          option2: v.option2 || '', image_2: v.image_2 || '',
          price: v.price || 0, stock: v.stock || 0, sku: v.sku || '',
        }]);
      }
    }
    return json({ success: true, task_id: taskId, message: '商品创建成功' });
  }

  if (idx.platform === 'jst') {
    const { name, topic_items, description, main_description, detail_description, auxiliary_images, reference_image, generate_count, stock, weight, variants, mode, main_image_count, detail_image_count } = body || {};
    if (!name) return error('任务名称不能为空', 400);
    if (!reference_image) return error('核心参考图不能为空', 400);

    await jstUpdateTask(env, taskId, {
      name: String(name).slice(0, 12), topic_items: topic_items || '', description: description || '',
      main_description: main_description || '', detail_description: detail_description || '',
      auxiliary_images: auxiliary_images || '', reference_image,
      generate_count: parseInt(generate_count), stock: stock !== undefined ? parseInt(stock) : 999,
      weight: weight !== undefined ? parseFloat(weight) : 1.0,
      variant_count: variants?.length || 1,
      main_image_count: Math.min(Math.max(parseInt(main_image_count) || 5, 5), 9),
      detail_image_count: Math.min(Math.max(parseInt(detail_image_count) || 5, 5), 9),
      mode: mode === 'dedup' ? 'dedup' : 'full',
    });
    // 更新索引
    await env.DB.prepare("UPDATE ews_tasks SET name = ?, status = 'pending', updated_at = datetime('now') WHERE id = ?")
      .bind(String(name).slice(0, 12), taskId).run();

    // 变体（二维规格）
    if (variants && Array.isArray(variants)) {
      await jstClearVariants(env, taskId);
      for (let i = 0; i < variants.length; i++) {
        const v = variants[i];
        await jstCreateVariant(env, {
          id: uuid(), task_id: taskId,
          tier1_name: v.tier1_name || '',
          tier1_value: v.tier1_value || v.name || '',
          tier2_name: v.tier2_name || '',
          tier2_value: v.tier2_value || '',
          white_bg_image: v.white_bg_image || v.white_bg_image,
          price: v.price ?? null, description: v.sku_description || '', sort_order: i,
        });
      }
    }
    return json({ success: true, task_id: taskId, message: '任务更新成功' });
  }

  return error('不支持的平台类型', 400);
}

async function handleDeleteTask(env, path) {
  const taskId = getTaskId(path);
  const idx = await getTaskIndex(env, taskId);
  if (!idx) return error('任务不存在', 404);
  // 清理 R2
  const prefix = `ews/${taskId}/`;
  try {
    let truncated = true; let cursor;
    while (truncated) {
      const listOpts = { prefix }; if (cursor) listOpts.cursor = cursor;
      const objects = await env.R2.list(listOpts);
      if (objects.objects.length > 0) {
        const keys = objects.objects.map(o => o.key);
        for (let i = 0; i < keys.length; i += 100) await env.R2.delete(keys.slice(i, i + 100));
      }
      truncated = objects.truncated; cursor = objects.cursor;
    }
  } catch (err) { console.error('R2 cleanup error:', err.message); }
  // 清理平台数据
  if (idx.platform === 'jst') await jstDeleteTaskRecord(env, taskId);
  else if (idx.platform === 'shopee') await shopeeDeleteProduct(env, taskId);
  await deleteTaskIndex(env, taskId);
  return json({ success: true, message: '任务已删除' });
}

async function handleUpdateTaskStatus(request, env, path) {
  const taskId = getTaskId(path);
  const body = await parseBody(request);
  const { status } = body || {};
  if (!['pending','processing','completed','failed'].includes(status)) return error('无效的状态值', 400);
  const idx = await getTaskIndex(env, taskId);
  if (!idx) return error('任务不存在', 404);
  if (idx.platform === 'jst') await jstUpdateTaskStatus(env, taskId, status);
  await updateTaskIndexStatus(env, taskId, status);
  return json({ success: true, message: '状态更新成功' });
}

// ========== JST 推送 ==========

async function handlePushTask(env, ctx, path, request) {
  const taskId = getTaskId(path);
  const idx = await getTaskIndex(env, taskId);
  if (!idx) return error('任务不存在', 404);
  if (idx.platform === 'jst') return jstHandlePush(env, taskId, ctx, request);
  return error('不支持的平台', 400);
}

async function jstHandlePush(env, taskId, ctx, request) {
  // [从原 index.js handlePushTask 移入，逻辑保持一致]
  const pushBody = await parseBody(request).catch(() => ({}));
  const testMode = pushBody?.test_mode === true;
  const detail = await jstGetTask(env, taskId);
  if (!detail) return error('任务不存在', 404);
  if (detail.status !== 'pending') return error('只能推送等待中的任务', 400);
  const config = await getConfig(env, 'jst');
  const pushUser = await getUserByUsername(env, request.auth?.username || '');
  if (pushUser?.webhook_config) {
    try { const wh = JSON.parse(pushUser.webhook_config); Object.assign(config, wh.jst || {}); } catch (_) {}
  }
  const callbackSecret = config.callback_secret || '';
  const baseUrl = `${new URL(request.url).origin}/api/callback`;
  const mainWebhookUrl = config.n8n_main_webhook || '';
  const subImageWebhookUrl = config.n8n_sub_image_webhook || '';
  const detailWebhookUrl = config.n8n_detail_webhook || '';
  const mainImageCount = Math.min(Math.max(detail.main_image_count || 5, 5), 9);
  const detailImageCount = Math.min(Math.max(detail.detail_image_count || 5, 5), 9);

  if (!config.n8n_title_webhook && !config.n8n_sku_title_webhook && !mainWebhookUrl && !subImageWebhookUrl && !detailWebhookUrl && !config.n8n_sku_image_webhook)
    return error('请先在系统配置页配置 JST 工作流 Webhook 地址后再推送', 400);

  const generateCount = detail.generate_count || 1;
  const variantCount = detail.variants?.length || 1;
  const subTaskIds = [];
  for (let i = 0; i < generateCount; i++) {
    const subId = uuid(); subTaskIds.push(subId);
    await jstCreateSubTask(env, { id: subId, parent_task_id: taskId, set_index: i });
    await jstCreateExpectedImages(env, taskId, subId, i, variantCount, detail.mode || 'full', mainImageCount, detailImageCount);
  }
  await jstUpdateTaskStatus(env, taskId, 'processing');
  const subTasks = subTaskIds.map((id, i) => ({ sub_task_id: id, set_index: i, style_code: id.slice(0, 8) }));
  const allJobs = [];

  // title
  allJobs.push({ webhook_type: 'title', sub_task_id: subTasks[0]?.sub_task_id || "", url: config.n8n_title_webhook,
    data: { task_id: taskId, name: detail.name, reference_title: detail.topic_items || '', description: detail.description || '',
      sub_task_count: generateCount, callback_secret: callbackSecret, callback_url: baseUrl } });
  // sku_title
  allJobs.push({ webhook_type: 'sku_title', sub_task_id: subTasks[0]?.sub_task_id || "", url: config.n8n_sku_title_webhook,
    data: { task_id: taskId, name: detail.name, reference_title: detail.topic_items || '', description: detail.description || '',
      sub_task_count: generateCount, variants: (detail.variants||[]).map(v=>({id:v.id,name:v.tier1_value})), callback_secret: callbackSecret, callback_url: baseUrl } });
  // main_1
  if (mainWebhookUrl) for (const st of subTasks) allJobs.push({ webhook_type: 'main_1', sub_task_id: st.sub_task_id, url: mainWebhookUrl,
    data: { task_id: taskId, sub_task_id: st.sub_task_id, set_index: st.set_index, reference_image: detail.reference_image,
      main_description: detail.main_description || '', auxiliary_images: detail.auxiliary_images || '', image_type: 'main', image_position: 1, callback_secret: callbackSecret, callback_url: baseUrl } });
  // sub_2~N
  if (subImageWebhookUrl) for (let pos = 2; pos <= mainImageCount; pos++) for (const st of subTasks) {
    if ((detail.mode||'full') === 'dedup' && st.set_index > 0) continue;
    allJobs.push({ webhook_type: 'sub_' + pos, sub_task_id: st.sub_task_id, url: subImageWebhookUrl,
      data: { task_id: taskId, sub_task_id: st.sub_task_id, set_index: st.set_index, reference_image: detail.reference_image,
        main_description: detail.main_description || '', auxiliary_images: detail.auxiliary_images || '', image_type: 'sub', image_position: pos, callback_secret: callbackSecret, callback_url: baseUrl } });
  }
  // detail_1~M
  if (detailWebhookUrl) for (let pos = 1; pos <= detailImageCount; pos++) for (const st of subTasks) {
    if ((detail.mode||'full') === 'dedup' && st.set_index > 0) continue;
    allJobs.push({ webhook_type: 'detail_' + pos, sub_task_id: st.sub_task_id, url: detailWebhookUrl,
      data: { task_id: taskId, sub_task_id: st.sub_task_id, set_index: st.set_index, reference_image: detail.reference_image,
        detail_description: detail.detail_description || '', auxiliary_images: detail.auxiliary_images || '', image_type: 'detail', image_position: pos, callback_secret: callbackSecret, callback_url: baseUrl } });
  }
  // sku
  for (const st of subTasks) {
    if ((detail.mode||'full') === 'dedup' && st.set_index > 0) continue;
    for (let v = 0; v < (detail.variants||[]).length; v++) {
      allJobs.push({ webhook_type: 'sku_' + (v+1), sub_task_id: st.sub_task_id, url: config.n8n_sku_image_webhook,
        data: { task_id: taskId, sub_task_id: st.sub_task_id, set_index: st.set_index, reference_image: detail.reference_image,
          variant_name: detail.variants[v].tier1_value, white_bg_image: detail.variants[v].white_bg_image,
          sku_description: detail.variants[v].description || '', image_type: 'sku', image_position: v+1, callback_secret: callbackSecret, callback_url: baseUrl } });
    }
  }

  // 写入计划
  const batchSize = parseInt(config.push_batch_size) || 20;
  const planRecords = [];
  for (let bi = 0; bi < allJobs.length; bi++) {
    const j = allJobs[bi];
    planRecords.push({ id: uuid(), task_id: taskId, sub_task_id: j.sub_task_id, webhook_type: j.webhook_type, webhook_url: j.url || '',
      payload: JSON.stringify(j.data), batch_order: Math.floor(bi / batchSize) });
  }
  if (planRecords.length > 0) await jstCreatePushPlans(env, planRecords);

  if (testMode) {
    await env.DB.prepare("UPDATE ews_jst_tasks SET queue_mode='manual' WHERE id=?").bind(taskId).run();
    return json({ success: true, task_id: taskId, sub_tasks: subTasks, test_mode: true,
      total_plans: planRecords.length,
      message: '测试模式：已创建 ' + subTasks.length + ' 个子任务、' + planRecords.length + ' 个推送计划' });
  }
  ctx.waitUntil(jstReleaseTaskQueue(env, taskId, ctx));
  return json({ success: true, task_id: taskId, sub_tasks: subTasks, total_plans: planRecords.length,
    message: '已创建 ' + planRecords.length + ' 个推送计划' });
}

async function pushToWebhook(url, data) {
  if (!url) return;
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  return resp.ok;
}

async function jstReleaseTaskQueue(env, taskId, ctx) {
  try {
    const config = await getConfig(env, 'jst');
    const batchSize = parseInt(config.push_batch_size) || 20;
    const processingRow = await getOne(env, "SELECT COUNT(*) as cnt FROM ews_jst_push_plans WHERE task_id=? AND status='processing'", [taskId]);
    const slots = batchSize - (processingRow?.cnt || 0);
    if (slots <= 0) return;
    const pendingPlans = await jstGetPendingPlans(env, taskId, slots);
    const plans = pendingPlans?.results || [];
    if (!plans.length) return;
    const taskOwner = await getOne(env, "SELECT user_id FROM ews_tasks WHERE id=?", [taskId]);
    for (const plan of plans) {
      let canSend = true;
      if (taskOwner?.user_id) {
        const credits = await getUserCredits(env, taskOwner.user_id);
        if (credits > 0) await updateUserCredits(env, taskOwner.user_id, 1, 'subtract');
        else canSend = false;
      }
      if (canSend) {
        await jstUpdatePlanStatus(env, plan.id, 'processing');
        ctx.waitUntil(pushToWebhook(plan.webhook_url, JSON.parse(plan.payload)));
      } else {
        await env.DB.prepare("UPDATE ews_jst_push_plans SET status='failed', retry_count=3, error=? WHERE id=?").bind('算力不足', plan.id).run();
      }
    }
  } catch (err) { console.error('jstReleaseTaskQueue error:', err.message); }
}

async function processPendingQueue(env, ctx) {
  try {
    const rows = await query(env, "SELECT DISTINCT task_id FROM ews_jst_push_plans WHERE status='pending'");
    for (const row of (rows?.results || [])) ctx.waitUntil(jstReleaseTaskQueue(env, row.task_id, ctx));
  } catch (err) { console.error('processPendingQueue error:', err.message); }
}

// ========== 回调 ==========

async function handleCallback(request, env, ctx) {
  const body = await parseBody(request);
  if (!body) return error('无效的请求体', 400);
  const config = await getConfig(env);
  if (config.callback_secret && body.secret !== config.callback_secret) return error('回调密钥无效', 403);

  const { task_id, sub_task_id, set_index, titles, product_title, sku_selling_points, image_type, image_position, image_url, error: errMsg } = body;
  if (!task_id) return error('缺少 task_id', 400);
  const idx = await getTaskIndex(env, task_id);
  if (!idx) return error('任务不存在', 404);

  const publicUrl = config.r2_public_url || '';

  // 标题回调
  if (titles && Array.isArray(titles)) {
    const subTasks = await jstGetSubTasks(env, task_id);
    const allSubs = (subTasks?.results || []).sort((a,b) => a.set_index - b.set_index);
    if (titles.length !== allSubs.length) return error(`标题数量不匹配: ${titles.length} vs ${allSubs.length}`, 400);
    for (let i = 0; i < allSubs.length; i++) await jstUpdateSubTask(env, allSubs[i].id, { title: titles[i] });
  } else if (product_title) {
    const subTasks = await jstGetSubTasks(env, task_id);
    for (const st of (subTasks?.results || [])) await jstUpdateSubTask(env, st.id, { title: product_title });
  }
  if (titles || product_title) {
    await env.DB.prepare("UPDATE ews_jst_push_plans SET status='done' WHERE task_id=? AND webhook_type='title' AND status='processing'").bind(task_id).run();
  }

  // SKU 标题回调
  if (body.sku_titles && Array.isArray(body.sku_titles)) {
    const skuDetail = await jstGetTask(env, task_id);
    const variants = (skuDetail?.variants || []).sort((a,b) => a.sort_order - b.sort_order);
    const subTasks = await jstGetSubTasks(env, task_id);
    const allSubs = (subTasks?.results || []).sort((a,b) => a.set_index - b.set_index);
    const vCount = variants.length;
    const expected = allSubs.length * vCount;
    if (body.sku_titles.length !== expected) return error(`SKU标题数量不匹配: ${body.sku_titles.length} vs ${expected}`, 400);
    for (let si = 0; si < allSubs.length; si++) {
      for (let vi = 0; vi < vCount; vi++) {
        const title = body.sku_titles[si * vCount + vi];
        if (title) await jstCreateSkuTitle(env, { id: uuid(), sub_task_id: allSubs[si].id, variant_id: variants[vi].id, title: title.slice(0, 30) });
      }
    }
    await env.DB.prepare("UPDATE ews_jst_push_plans SET status='done' WHERE task_id=? AND webhook_type='sku_title' AND status='processing'").bind(task_id).run();
  }

  // 图片回调
  const savedImages = [];
  if (image_type && image_position && image_url) {
    if (!['main','sub','detail','sku'].includes(image_type)) return error('无效的图片类型', 400);
    const result = await processOneImage(env, task_id, sub_task_id, set_index ?? 0, image_type, image_position, image_url, publicUrl);
    const whType = `${image_type}_${image_position}`;
    if (result) {
      savedImages.push(result);
      // 根据平台更新对应推送计划
      const planTable = idx.platform === 'jst' ? 'ews_jst_push_plans' : 'ews_shopee_push_plans';
      await env.DB.prepare(`UPDATE ${planTable} SET status='done' WHERE task_id=? AND sub_task_id=? AND webhook_type=? AND status='processing'`)
        .bind(task_id, sub_task_id, whType).run();
    } else {
      // 重试
      const planTable = idx.platform === 'jst' ? 'ews_jst_push_plans' : 'ews_shopee_push_plans';
      const planInfo = await env.DB.prepare(`SELECT id, webhook_url, payload, retry_count FROM ${planTable} WHERE task_id=? AND sub_task_id=? AND webhook_type=? AND status='processing'`)
        .bind(task_id, sub_task_id, whType).first();
      if (planInfo && planInfo.webhook_url && (planInfo.retry_count||0) < 3) {
        const newCount = (planInfo.retry_count||0) + 1;
        await env.DB.prepare(`UPDATE ${planTable} SET status='processing', retry_count=?, error=? WHERE id=?`).bind(newCount, `下载失败，重试第${newCount}次`, planInfo.id).run();
        ctx.waitUntil(pushToWebhook(planInfo.webhook_url, JSON.parse(planInfo.payload)));
      } else {
        const reason = planInfo?.retry_count >= 3 ? '已重试3次失败' : '下载失败';
        await env.DB.prepare(`UPDATE ${planTable} SET status='failed', error=? WHERE task_id=? AND sub_task_id=? AND webhook_type=? AND status='processing'`).bind(reason, task_id, sub_task_id, whType).run();
        if (planInfo?.retry_count >= 3) await jstRefundCredits(env, task_id);
      }
    }
  }

  // 检查子任务完成
  if (sub_task_id) {
    const imgStatus = await jstCheckSubTaskImages(env, sub_task_id);
    if (imgStatus.total > 0 && imgStatus.total === imgStatus.completed) await jstUpdateSubTask(env, sub_task_id, { status: 'completed' });
  }
  await jstCheckParentCompletion(env, task_id);

  const taskInfo = await getOne(env, "SELECT queue_mode FROM ews_jst_tasks WHERE id=?", [task_id]);
  if (taskInfo?.queue_mode !== 'manual') ctx.waitUntil(jstReleaseTaskQueue(env, task_id, ctx));

  return json({ success: true, sub_task_id, images_saved: savedImages.length, message: '回调处理完成' });
}

async function processOneImage(env, task_id, sub_task_id, set_index, image_type, image_position, image_url, publicUrl) {
  try {
    const resp = await fetch(image_url);
    if (!resp.ok) return null;
    const buffer = await resp.arrayBuffer();
    const ext = 'jpg';
    const fileName = `${image_type}_${image_position}.${ext}`;
    const r2Key = `ews/${task_id}/${sub_task_id}/${fileName}`;
    await env.R2.put(r2Key, buffer, { httpMetadata: { contentType: resp.headers.get('content-type') || 'image/jpeg' } });
    const fullUrl = publicUrl ? `${publicUrl.replace(/\/+$/, '')}/${r2Key}` : r2Key;
    await jstSaveImage(env, { id: '', parent_task_id: task_id, sub_task_id, variant_id: null, set_index, image_type, position: image_position, image_url: fullUrl });
    return { type: image_type, position: image_position, url: fullUrl };
  } catch (err) { console.error('processOneImage failed:', err.message); return null; }
}

// ========== 推送计划 ==========

async function handleGetPlans(env, path) {
  const taskId = getTaskId(path);
  const idx = await getTaskIndex(env, taskId);
  if (!idx) return error('任务不存在', 404);
  const config = await getConfig(env);
  const publicUrl = (config.r2_public_url || '').replace(/\/+$/, '');
  const plansTable = idx.platform === 'jst' ? 'ews_jst_push_plans' : 'ews_shopee_push_plans';
  const plans = await query(env, `SELECT * FROM ${plansTable} WHERE task_id=? ORDER BY batch_order ASC, webhook_type ASC`, [taskId]);
  const stats = await query(env, `SELECT status, COUNT(*) as cnt FROM ${plansTable} WHERE task_id=? GROUP BY status`, [taskId]);
  const s = { pending: 0, processing: 0, done: 0, failed: 0, total: 0 };
  for (const r of (stats?.results || [])) { s[r.status] = r.cnt; s.total += r.cnt; }
  return json({ success: true, plans: (plans?.results || []).map(p => {
    let preview_url = '';
    try { const pl = JSON.parse(p.payload); if (pl.image_type && pl.image_position && pl.sub_task_id && publicUrl) preview_url = `${publicUrl}/ews/${pl.task_id}/${pl.sub_task_id}/${pl.image_type}_${pl.image_position}.jpg`; } catch(_) {}
    return { ...p, preview_url };
  }), stats: s });
}

async function handleRetryPlan(env, path, request, ctx) {
  const parts = path.split('/');
  const taskId = parts[3], planId = parts[5];
  const idx = await getTaskIndex(env, taskId);
  if (!idx) return error('任务不存在', 404);
  const plansTable = idx.platform === 'jst' ? 'ews_jst_push_plans' : 'ews_shopee_push_plans';
  const plan = await getOne(env, `SELECT * FROM ${plansTable} WHERE id=?`, [planId]);
  if (!plan) return error('计划不存在', 404);
  const taskOwner = await getOne(env, "SELECT user_id FROM ews_tasks WHERE id=?", [taskId]);
  if (taskOwner?.user_id) {
    if ((await getUserCredits(env, taskOwner.user_id)) <= 0) return error('算力不足', 400);
    await updateUserCredits(env, taskOwner.user_id, 1, 'subtract');
  }
  await env.DB.prepare(`UPDATE ${plansTable} SET status='processing', retry_count=0 WHERE id=?`).bind(planId).run();
  try { await pushToWebhook(plan.webhook_url, JSON.parse(plan.payload)); return json({ success: true, message: '计划已重新推送' }); }
  catch (err) {
    await env.DB.prepare(`UPDATE ${plansTable} SET status='failed', error=? WHERE id=?`).bind(err.message, planId).run();
    if (taskOwner?.user_id) await updateUserCredits(env, taskOwner.user_id, 1, 'add');
    return error('推送失败: ' + err.message, 500);
  }
}

// ========== 导出 ==========

async function handleExportTask(env, path) {
  const taskId = getTaskId(path);
  const idx = await getTaskIndex(env, taskId);
  if (!idx) return error('任务不存在', 404);
  if (idx.platform === 'jst') return jstHandleExport(env, taskId);
  if (idx.platform === 'shopee') return shopeeHandleExport(env, taskId);
  return error('不支持的平台', 400);
}

async function jstHandleExport(env, taskId) {
  const detail = await jstGetTask(env, taskId);
  if (!detail) return error('任务不存在', 404);
  const config = await getConfig(env);
  const variants = detail.variants || [];
  const images = detail.images || [];
  const generateCount = detail.generate_count || 1;
  const mode = detail.mode || 'full';
  const baseUrl = (config.r2_public_url || '').replace(/\/+$/, '');
  const mainImgTotal = Math.min(Math.max(detail.main_image_count || 5, 5), 9);
  const detailImgTotal = Math.min(Math.max(detail.detail_image_count || 5, 5), 9);
  const subTasks = await jstGetSubTasks(env, taskId);
  const subTaskIds = (subTasks?.results || []).map(st => st.id);

  // SKU 标题
  const skuTitleMap = {};
  if (subTaskIds.length > 0) {
    const ph = subTaskIds.map(() => '?').join(',');
    const skuRows = await query(env, `SELECT sub_task_id, variant_id, title FROM ews_jst_sku_titles WHERE sub_task_id IN (${ph})`, subTaskIds);
    for (const st of (skuRows?.results || [])) skuTitleMap[st.sub_task_id + '_' + st.variant_id] = st.title;
  }

  function getImg(setIdx, type, pos) {
    const found = images.find(img => img.set_index === setIdx && img.image_type === type && img.position === pos);
    if (found?.image_url) return found.image_url;
    if (mode === 'dedup' && setIdx > 0 && type !== 'main') {
      const refSubId = subTaskIds[0];
      if (refSubId) {
        const refFound = images.find(img => img.set_index === 0 && img.image_type === type && img.position === pos);
        if (refFound?.image_url) return refFound.image_url;
        return `${baseUrl}/ews/${taskId}/${refSubId}/${type}_${pos}.jpg`;
      }
    }
    const ownSubId = subTaskIds[setIdx];
    return ownSubId ? `${baseUrl}/ews/${taskId}/${ownSubId}/${type}_${pos}.jpg` : '';
  }
  function getSkuUrl(setIdx, vIdx) {
    const found = images.find(img => img.set_index === setIdx && img.image_type === 'sku' && img.position === (vIdx + 1));
    if (found?.image_url) return found.image_url;
    if (mode === 'dedup' && setIdx > 0) {
      const refSubId = subTaskIds[0];
      if (refSubId) {
        const refFound = images.find(img => img.set_index === 0 && img.image_type === 'sku' && img.position === (vIdx + 1));
        if (refFound?.image_url) return refFound.image_url;
        return `${baseUrl}/ews/${taskId}/${refSubId}/sku_${vIdx + 1}.jpg`;
      }
    }
    const ownSubId = subTaskIds[setIdx];
    return ownSubId ? `${baseUrl}/ews/${taskId}/${ownSubId}/sku_${vIdx + 1}.jpg` : '';
  }

  const rows = [];
  for (let setIdx = 0; setIdx < generateCount; setIdx++) {
    const subTaskId = subTaskIds[setIdx] || '';
    const styleCode = subTaskId ? subTaskId.slice(0, 8) : `${taskId.slice(0, 8)}-S${setIdx + 1}`;
    const subTask = (detail.sub_tasks || []).find(st => st.id === subTaskId);
    const productTitle = subTask?.title || '';
    for (let vIdx = 0; vIdx < variants.length; vIdx++) {
      const variant = variants[vIdx];
      const skuCode = `${styleCode}-V${vIdx + 1}`;
      const mainUrls = [getImg(setIdx, 'main', 1)];
      for (let p = 2; p <= mainImgTotal; p++) mainUrls.push(getImg(setIdx, 'sub', p));
      const detailUrls = [];
      for (let p = 1; p <= detailImgTotal; p++) detailUrls.push(getImg(setIdx, 'detail', p));
      const skuUrl = getSkuUrl(setIdx, vIdx);
      const skuTitle = skuTitleMap[subTaskId + '_' + variant.id] || '';
      rows.push({
        '款式编码': styleCode, '商品编码': skuCode, '颜色': skuTitle, '规格': '',
        '商品主图': JSON.stringify(mainUrls.filter(u => u)),
        '商品详情图': JSON.stringify(detailUrls.filter(u => u)),
        '图片地址': skuUrl, '商品名称': productTitle, '推荐文案': '', '商品描述': '', '宝贝链接': '',
        '库存': detail.stock ?? 999, '重量(kg)': detail.weight ?? 1.0, '基本售价': variant.price ?? '',
        '市场|吊牌价': variant.price ?? '', '最低分销控价': '', '最高分销控价': '', '供应商名': '',
        '3:4主图': '', '长图': '', '透明素材图': '', '白底图': '',
      });
    }
  }
  return json({ success: true, rows, task_title: detail.name, mode, export_format: 'jst' });
}

async function shopeeHandleExport(env, taskId) {
  const product = await shopeeGetProduct(env, taskId);
  if (!product) return error('商品不存在', 404);
  const variations = product.variations || [];
  const config = await getConfig(env);
  const baseUrl = (config.r2_public_url || '').replace(/\/+$/, '');

  const rows = [];
  const integrationNo = taskId.slice(0, 8);

  // 第一行：商品基础信息
  const baseRow = {
    'Category': product.category_id || '',
    'Product Name': product.name,
    'Product Description': product.description || '',
    'Parent SKU': product.parent_sku || integrationNo,
    'Variation Integration No.': integrationNo,
    'Variation Name1': product.variation_name1 || '',
    'Option for Variation 1': variations[0]?.option1 || '',
    'Image per Variation': variations[0]?.image_per_variation || '',
    'Variation Name2': product.variation_name2 || '',
    'Option for Variation 2': variations[0]?.option2 || '',
    'Price': variations[0]?.price ?? '',
    'Stock': variations[0]?.stock ?? '',
    'SKU': variations[0]?.sku || '',
    'Cover image': product.cover_image || '',
    'Item Image 1': '',
    'Weight': product.weight_kg || '',
    'Length': product.length_cm ?? '',
    'Width': product.width_cm ?? '',
    'Height': product.height_cm ?? '',
    'GTIN': product.gtin || '',
    'Pre-order DTS': product.pre_order_dts ?? '',
  };
  // 填充图片
  const images = product.images ? JSON.parse(product.images) : [];
  for (let i = 0; i < Math.min(images.length, 8); i++) {
    baseRow['Item Image ' + (i + 1)] = images[i];
  }
  rows.push(baseRow);

  // 其余变体行（仅变体差异字段）
  for (let v = 1; v < variations.length; v++) {
    rows.push({
      'Category': '', 'Product Name': '', 'Product Description': '', 'Parent SKU': '',
      'Variation Integration No.': integrationNo,
      'Variation Name1': '', 'Option for Variation 1': variations[v].option1,
      'Image per Variation': variations[v].image_per_variation || '',
      'Variation Name2': '', 'Option for Variation 2': variations[v].option2 || '',
      'Price': variations[v].price ?? '', 'Stock': variations[v].stock ?? '', 'SKU': variations[v].sku || '',
      'Cover image': '', 'Item Image 1': '', 'Weight': '', 'Length': '', 'Width': '', 'Height': '',
      'GTIN': '', 'Pre-order DTS': '',
    });
  }

  return json({ success: true, rows, task_title: product.name, export_format: 'shopee' });
}

// ========== 上传 ==========

async function handleUpload(request, env) {
  const formData = await parseBody(request);
  if (!(formData instanceof FormData)) return error('请使用 multipart/form-data 格式上传', 400);
  const file = formData.get('file');
  if (!file) return error('请选择文件', 400);
  if (!['image/jpeg','image/png','image/webp','image/gif'].includes(file.type)) return error('仅支持 JPG/PNG/WebP/GIF', 400);
  if (file.size > 10 * 1024 * 1024) return error('文件大小不能超过 10MB', 400);
  const taskId = formData.get('task_id'); if (!taskId) return error('缺少 task_id', 400);
  const folder = formData.get('folder') || 'uploads';
  const buffer = await file.arrayBuffer();
  const key = `ews/${taskId}/${folder}/${uuid()}.jpg`;
  await env.R2.put(key, buffer, { httpMetadata: { contentType: file.type } });
  const config = await getConfig(env);
  const publicUrl = config.r2_public_url || '';
  return json({ success: true, key, url: publicUrl ? `${publicUrl.replace(/\/+$/, '')}/${key}` : null, message: '上传成功' });
}

// ========== R2 ==========

async function handleR2File(path, env) {
  const key = path.replace(/^\/r2\//, '');
  const object = await env.R2.get(key);
  if (!object) return error('文件不存在', 404);
  return new Response(object.body, { headers: { 'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000' } });
}