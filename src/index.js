// EWS - Cloudflare Worker 主入口（统一路由 + 分平台分发）

import { PhotonImage, SamplingFilter, crop, resize } from '@cf-wasm/photon/workerd';
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
  shopeeCreateSubTask, shopeeGetSubTasks, shopeeUpdateSubTask,
  shopeeCreateExpectedImages, shopeeCheckSubTaskImages, shopeeCreateSkuTitle,
  shopeeSaveImage, shopeeCheckParentCompletion, shopeeRefundCredits,
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

function parseNumberOrNull(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function isEnabled(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function clampPricePrecision(value) {
  const n = parseInt(value);
  if (Number.isNaN(n)) return 0;
  return Math.min(Math.max(n, -2), 2);
}

function normalizeVariantPricing(variant, requiredPrice) {
  const enabled = isEnabled(variant?.price_float_enabled);
  const precision = clampPricePrecision(variant?.price_precision);
  const price = parseNumberOrNull(variant?.price);
  if (!enabled) {
    return {
      price: requiredPrice ? (price ?? 0) : price,
      price_float_enabled: 0,
      price_min: null,
      price_max: null,
      price_precision: precision,
    };
  }
  const min = parseNumberOrNull(variant?.price_min);
  const max = parseNumberOrNull(variant?.price_max);
  if (min === null || max === null) return { error: '价格浮动区间不能为空' };
  if (max < min) return { error: '价格浮动最高价不能小于最低价' };
  return {
    price: min,
    price_float_enabled: 1,
    price_min: min,
    price_max: max,
    price_precision: precision,
  };
}

function stableUnit(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 0x100000000;
}

function formatExportPrice(value, precision) {
  if (!Number.isFinite(value)) return '';
  if (precision > 0) return Number(value.toFixed(precision));
  return Math.round(value);
}

function exportPriceForVariant(variant, taskId, setIdx, variantIdx) {
  if (!isEnabled(variant?.price_float_enabled)) return variant?.price ?? '';
  const min = parseNumberOrNull(variant?.price_min);
  const max = parseNumberOrNull(variant?.price_max);
  if (min === null || max === null || max < min) return variant?.price ?? '';
  const precision = clampPricePrecision(variant?.price_precision);
  const step = Math.pow(10, -precision);
  const lo = Math.ceil(min / step);
  const hi = Math.floor(max / step);
  if (hi < lo) return formatExportPrice(min, precision);
  const unit = stableUnit([taskId, setIdx, variant?.id || variantIdx, min, max, precision].join('|'));
  return formatExportPrice((lo + Math.floor(unit * (hi - lo + 1))) * step, precision);
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
        return requireAuth(request, env, () => handleGetConfig(request, env, url));
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

async function handleGetConfig(request, env, url) {
  if (request.auth?.role !== 'admin') return error('无权访问', 403);
  const platform = url.searchParams.get('platform') || '';
  const config = await getConfig(env, platform);
  const safe = { ...config };
  delete safe.admin_password;
  delete safe.jwt_secret_name;
  return json({ success: true, config: safe, platform });
}

async function handleUpdateConfig(request, env) {
  if (request.auth?.role !== 'admin') return error('无权访问', 403);
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

async function getTaskSummaryRows(env, sqlPrefix, ids) {
  const rows = [];
  for (let i = 0; i < ids.length; i += 80) {
    const part = ids.slice(i, i + 80);
    if (!part.length) continue;
    const ph = part.map(() => '?').join(',');
    const result = await query(env, `${sqlPrefix} (${ph})`, part);
    rows.push(...(result?.results || []));
  }
  return rows;
}

async function handleGetTasks(env, ctx, auth) {
  ctx.waitUntil(processPendingQueue(env, ctx));
  const result = await getTaskList(env, '', auth.username, auth.role);
  let tasks = result.results || [];
  if (auth.role !== 'admin') tasks = tasks.filter(t => t.user_id === auth.username);

  const jstIds = tasks.filter(t => t.platform === 'jst').map(t => t.id);
  const shopeeIds = tasks.filter(t => t.platform === 'shopee').map(t => t.id);
  const [jstRows, shopeeRows] = await Promise.all([
    getTaskSummaryRows(env, 'SELECT id, name, mode FROM ews_jst_tasks WHERE id IN', jstIds),
    getTaskSummaryRows(env, 'SELECT task_id, name FROM ews_shopee_products WHERE task_id IN', shopeeIds),
  ]);
  const jstMap = new Map(jstRows.map(row => [row.id, row]));
  const shopeeMap = new Map(shopeeRows.map(row => [row.task_id, row]));

  for (const t of tasks) {
    if (t.platform === 'jst') {
      const jst = jstMap.get(t.id);
      if (jst) { t.name = jst.name; t._mode = jst.mode; }
    } else if (t.platform === 'shopee') {
      const sp = shopeeMap.get(t.id);
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
    const { name, description, task_description, main_description, detail_description, reference_title, reference_image, auxiliary_images, generate_count, main_image_count, detail_image_count, mode, category_id, brand_id, cover_image, images, weight_kg, length_cm, width_cm, height_cm, gtin, hs_code, tax_code, origin_country, variation_name1, variation_name2, pre_order_dts, shipping_channels, variations } = body || {};
    if (!name) return error('商品名称不能为空', 400);
    if (!reference_image) return error('核心参考图不能为空', 400);
    const shopeeDetailCount = parseInt(detail_image_count);
    await env.DB.prepare("UPDATE ews_tasks SET name=?, status='pending', updated_at=datetime('now') WHERE id=?").bind(String(name).slice(0,30), taskId).run();
    await shopeeCreateProduct(env, {
      id: taskId, task_id: taskId, name, category_id: category_id || '',
      description: description ?? task_description ?? '', main_description: main_description || '', detail_description: detail_description || '',
      reference_title: reference_title || name || '',
      reference_image: reference_image || '', auxiliary_images: auxiliary_images || '[]',
      generate_count: Math.max(1, parseInt(generate_count) || 1),
      mode: mode === 'dedup' ? 'dedup' : 'full',
      main_image_count: Math.min(Math.max(parseInt(main_image_count) || 9, 5), 9),
      detail_image_count: Math.min(Math.max(Number.isNaN(shopeeDetailCount) ? 0 : shopeeDetailCount, 0), 9),
      brand_id: brand_id || '',
      cover_image: cover_image || '', images: images || '[]',
      weight_kg: weight_kg || 0, length_cm: length_cm ?? null, width_cm: width_cm ?? null, height_cm: height_cm ?? null,
      gtin: gtin || '', hs_code: hs_code || '', tax_code: tax_code || '', origin_country: origin_country || '',
      variation_name1: variation_name1 || '', variation_name2: variation_name2 || '',
      pre_order_dts: pre_order_dts ?? null,
      shipping_channels: shipping_channels || '[]',
    });
    if (variations && Array.isArray(variations)) {
      await shopeeClearVariations(env, taskId);
      for (let i = 0; i < variations.length; i++) {
        const v = variations[i];
        const pricing = normalizeVariantPricing(v, true);
        if (pricing.error) return error('变体#' + (i + 1) + pricing.error, 400);
        await shopeeCreateVariations(env, [{
          id: v.id || uuid(), product_id: taskId, integration_no: v.integration_no || taskId.slice(0,8),
          option1: v.option1 || '', image_per_variation: v.image_per_variation || '',
          option2: v.option2 || '', image_2: v.image_2 || '',
          price: pricing.price, price_float_enabled: pricing.price_float_enabled,
          price_min: pricing.price_min, price_max: pricing.price_max, price_precision: pricing.price_precision,
          stock: v.stock || 0, sku: v.sku || '',
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
        const pricing = normalizeVariantPricing(v, false);
        if (pricing.error) return error('变体#' + (i + 1) + pricing.error, 400);
        await jstCreateVariant(env, {
          id: uuid(), task_id: taskId,
          tier1_name: v.tier1_name || '',
          tier1_value: v.tier1_value || v.name || '',
          tier2_name: v.tier2_name || '',
          tier2_value: v.tier2_value || '',
          white_bg_image: v.sku_image || v.white_bg_image || '',
          price: pricing.price, price_float_enabled: pricing.price_float_enabled,
          price_min: pricing.price_min, price_max: pricing.price_max, price_precision: pricing.price_precision,
          description: v.sku_description || '', sort_order: i,
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
  if (idx.platform === 'shopee') await env.DB.prepare("UPDATE ews_shopee_products SET status=?, updated_at=datetime('now') WHERE id=?").bind(status, taskId).run();
  await updateTaskIndexStatus(env, taskId, status);
  return json({ success: true, message: '状态更新成功' });
}

// ========== JST 推送 ==========

async function handlePushTask(env, ctx, path, request) {
  const taskId = getTaskId(path);
  const idx = await getTaskIndex(env, taskId);
  if (!idx) return error('任务不存在', 404);
  if (idx.platform === 'jst') return jstHandlePush(env, taskId, ctx, request);
  if (idx.platform === 'shopee') return shopeeHandlePush(env, taskId, ctx, request);
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
          variant_name: detail.variants[v].tier1_value, sku_image: detail.variants[v].white_bg_image || '',
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
    await env.DB.prepare("UPDATE ews_jst_tasks SET status='pending', queue_mode='manual', updated_at=datetime('now') WHERE id=?").bind(taskId).run();
    await updateTaskIndexStatus(env, taskId, 'pending');
    return json({ success: true, task_id: taskId, sub_tasks: subTasks, test_mode: true,
      total_plans: planRecords.length, jobs_count: planRecords.length,
      message: '测试模式：已创建 ' + subTasks.length + ' 个子任务、' + planRecords.length + ' 个推送计划' });
  }
  await updateTaskIndexStatus(env, taskId, 'processing');
  ctx.waitUntil(jstReleaseTaskQueue(env, taskId, ctx));
  return json({ success: true, task_id: taskId, sub_tasks: subTasks, total_plans: planRecords.length, jobs_count: planRecords.length,
    message: '已创建 ' + planRecords.length + ' 个推送计划' });
}

// ========== Shopee 推送（与 JST 对齐） ==========
async function shopeeHandlePush(env, taskId, ctx, request) {
  const body = await parseBody(request).catch(() => ({}));
  const testMode = body?.test_mode === true;
  const config = await getConfig(env, 'shopee');
  const pushUser = await getUserByUsername(env, request.auth?.username || '');
  if (pushUser?.webhook_config) {
    try { const wh = JSON.parse(pushUser.webhook_config); Object.assign(config, wh.shopee || {}); } catch (_) {}
  }
  const detail = await shopeeGetProduct(env, taskId);
  if (!detail) return error('商品不存在', 404);
  const rawDetailCount = parseInt(detail.detail_image_count);
  const detailCount = Math.min(Math.max(Number.isNaN(rawDetailCount) ? 0 : rawDetailCount, 0), 9);
  const requiredShopeeWebhooks = [
    ['n8n_title_webhook', '商品标题'],
    ['n8n_sku_title_webhook', 'SKU标题'],
    ['n8n_main_webhook', '封面图'],
    ['n8n_sub_image_webhook', '附图'],
    ['n8n_sku_image_webhook', 'SKU变体图'],
  ];
  if (detailCount > 0) requiredShopeeWebhooks.push(['n8n_detail_webhook', '详情图']);
  const missingShopeeWebhooks = requiredShopeeWebhooks.filter(([key]) => !config[key]).map(([, label]) => label);
  if (missingShopeeWebhooks.length)
    return error('请先在系统配置页配置 Shopee 必需工作流 Webhook: ' + missingShopeeWebhooks.join('、'), 400);

  const callbackSecret = config.callback_secret || '';
  const baseUrl = new URL(request.url).origin + '/api/callback';
  const mainCount = Math.min(Math.max(detail.main_image_count || 9, 5), 9);
  const refImg = detail.reference_image || '';
  const auxImgs = detail.auxiliary_images || '';
  const generateCount = detail.generate_count || 1;
  const mode = detail.mode || 'full';

  // 创建子任务（每个子任务是一套 AI 生成后的 Shopee 商品资源）
  const variantCombos = detail.variations || [];
  const subTaskIds = [];
  for (let i = 0; i < generateCount; i++) {
    const subId = uuid(); subTaskIds.push(subId);
    await shopeeCreateSubTask(env, { id: subId, parent_task_id: taskId, set_index: i });
    const dedupShared = mode === 'dedup' && i > 0;
    const expectedMainCount = config.n8n_main_webhook ? mainCount : 0;
    const expectedSubCount = (!dedupShared && config.n8n_sub_image_webhook) ? mainCount : 0;
    const expectedDetailCount = (!dedupShared && config.n8n_detail_webhook) ? detailCount : 0;
    const skuImageCount = (!dedupShared && config.n8n_sku_image_webhook) ? variantCombos.length : 0;
    await shopeeCreateExpectedImages(env, taskId, subId, i, expectedSubCount, expectedDetailCount, skuImageCount, !!config.n8n_main_webhook, !!config.n8n_sub_image_webhook && !dedupShared);
  }
  await updateTaskIndexStatus(env, taskId, 'processing');
  await env.DB.prepare("UPDATE ews_shopee_products SET status='processing', updated_at=datetime('now') WHERE id=?").bind(taskId).run();

  const subTasks = subTaskIds.map((id, i) => ({ sub_task_id: id, set_index: i }));
  const allJobs = [];

  // title
  if (config.n8n_title_webhook) allJobs.push({ webhook_type: 'title', sub_task_id: subTasks[0]?.sub_task_id || '', url: config.n8n_title_webhook,
    data: { task_id: taskId, name: detail.name, reference_title: detail.reference_title || detail.name || '', description: detail.description || '',
      sub_task_count: generateCount, callback_secret: callbackSecret, callback_url: baseUrl } });
  // sku_title
  if (config.n8n_sku_title_webhook) allJobs.push({ webhook_type: 'sku_title', sub_task_id: subTasks[0]?.sub_task_id || '', url: config.n8n_sku_title_webhook,
    data: { task_id: taskId, name: detail.name, reference_title: detail.reference_title || detail.name || '', description: detail.description || '',
      sub_task_count: generateCount, variants: variantCombos.map(v => ({ id: v.id, name: v.option1 || '', option2: v.option2 || '' })),
      callback_secret: callbackSecret, callback_url: baseUrl } });
  // main_1
  if (config.n8n_main_webhook) for (const st of subTasks) allJobs.push({ webhook_type: 'main_1', sub_task_id: st.sub_task_id, url: config.n8n_main_webhook,
    data: { task_id: taskId, sub_task_id: st.sub_task_id, set_index: st.set_index, reference_image: refImg,
      main_description: detail.main_description || '', auxiliary_images: auxImgs,
      image_type: 'main', image_position: 1, callback_secret: callbackSecret, callback_url: baseUrl } });
  // sub_2~N
  if (config.n8n_sub_image_webhook) for (let p = 2; p <= mainCount; p++) for (const st of subTasks) {
    if (mode === 'dedup' && st.set_index > 0) continue;
    allJobs.push({ webhook_type: 'sub_' + p, sub_task_id: st.sub_task_id, url: config.n8n_sub_image_webhook,
      data: { task_id: taskId, sub_task_id: st.sub_task_id, set_index: st.set_index, reference_image: refImg,
        main_description: detail.main_description || '', auxiliary_images: auxImgs,
        image_type: 'sub', image_position: p, callback_secret: callbackSecret, callback_url: baseUrl } });
  }
  // detail_1~M
  if (config.n8n_detail_webhook) for (let p = 1; p <= detailCount; p++) for (const st of subTasks) {
    if (mode === 'dedup' && st.set_index > 0) continue;
    allJobs.push({ webhook_type: 'detail_' + p, sub_task_id: st.sub_task_id, url: config.n8n_detail_webhook,
      data: { task_id: taskId, sub_task_id: st.sub_task_id, set_index: st.set_index, reference_image: refImg,
        detail_description: detail.detail_description || '', auxiliary_images: auxImgs,
        image_type: 'detail', image_position: p, callback_secret: callbackSecret, callback_url: baseUrl } });
  }
  // sku_1~V (每个变体的SKU参考图)
  if (config.n8n_sku_image_webhook) for (const st of subTasks) {
    if (mode === 'dedup' && st.set_index > 0) continue;
    for (let vi = 0; vi < variantCombos.length; vi++) {
      allJobs.push({ webhook_type: 'sku_' + (vi+1), sub_task_id: st.sub_task_id, url: config.n8n_sku_image_webhook,
        data: { task_id: taskId, sub_task_id: st.sub_task_id, set_index: st.set_index, reference_image: refImg,
          variant_name: variantCombos[vi].option1 || '',
          variant_option2: variantCombos[vi].option2 || '',
          sku_image: variantCombos[vi].image_per_variation || '',
          image_type: 'sku', image_position: vi+1, callback_secret: callbackSecret, callback_url: baseUrl } });
    }
  }

  const batchSize = parseInt(config.push_batch_size) || 20;
  const planRecords = [];
  for (let bi = 0; bi < allJobs.length; bi++) {
    const j = allJobs[bi];
    planRecords.push({ id: uuid(), task_id: taskId, sub_task_id: j.sub_task_id, webhook_type: j.webhook_type,
      webhook_url: j.url || '', payload: JSON.stringify(j.data), batch_order: Math.floor(bi / batchSize) });
  }
  if (planRecords.length > 0) await shopeeCreatePushPlans(env, planRecords);

  if (testMode) {
    await updateTaskIndexStatus(env, taskId, 'pending');
    await env.DB.prepare("UPDATE ews_shopee_products SET status='pending', updated_at=datetime('now') WHERE id=?").bind(taskId).run();
    return json({ success: true, task_id: taskId, sub_tasks: subTasks, test_mode: true, total_plans: planRecords.length, jobs_count: planRecords.length,
      message: '测试模式：已创建 ' + subTasks.length + ' 个子任务、' + planRecords.length + ' 个推送计划' });
  }
  ctx.waitUntil(shopeeReleaseTaskQueue(env, taskId, ctx));
  return json({ success: true, task_id: taskId, sub_tasks: subTasks, total_plans: planRecords.length, jobs_count: planRecords.length, message: '已创建 ' + planRecords.length + ' 个推送计划' });
}

async function shopeeReleaseTaskQueue(env, taskId, ctx) {
  try {
    const config = await getConfig(env, 'shopee');
    const batchSize = parseInt(config.push_batch_size) || 20;
    const processingRow = await getOne(env, "SELECT COUNT(*) as cnt FROM ews_shopee_push_plans WHERE task_id=? AND status='processing'", [taskId]);
    const slots = batchSize - (processingRow?.cnt || 0);
    if (slots <= 0) return;
    const pendingPlans = await shopeeGetPendingPlans(env, taskId, slots);
    const plans = pendingPlans?.results || [];
    if (!plans.length) return;
    const taskOwner = await getOne(env, "SELECT user_id FROM ews_tasks WHERE id=?", [taskId]);
    for (const plan of plans) {
      if (!plan.webhook_url) {
        await markPushPlanFailed(env, 'ews_shopee_push_plans', plan.id, 'Webhook地址未配置');
        continue;
      }
      let canSend = true;
      if (taskOwner?.user_id) {
        const credits = await getUserCredits(env, taskOwner.user_id);
        if (credits > 0) await updateUserCredits(env, taskOwner.user_id, 1, 'subtract');
        else canSend = false;
      }
      if (canSend) {
        await shopeeUpdatePlanStatus(env, plan.id, 'processing');
        ctx.waitUntil(dispatchPushPlan(env, 'ews_shopee_push_plans', taskId, plan));
      } else {
        await env.DB.prepare("UPDATE ews_shopee_push_plans SET status='failed', retry_count=3, error=? WHERE id=?").bind('算力不足', plan.id).run();
      }
    }
  } catch (err) { console.error('shopeeReleaseTaskQueue error:', err.message); }
}

async function pushToWebhook(url, data) {
  if (!url) throw new Error('Webhook地址未配置');
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  if (!resp.ok) throw new Error('Webhook响应异常: HTTP ' + resp.status);
  return true;
}

async function markPushPlanFailed(env, planTable, planId, message) {
  await env.DB.prepare(`UPDATE ${planTable} SET status='failed', retry_count=3, error=? WHERE id=?`).bind(message || '推送失败', planId).run();
}

async function refundTaskCredit(env, taskId) {
  const taskOwner = await getOne(env, "SELECT user_id FROM ews_tasks WHERE id=?", [taskId]);
  if (taskOwner?.user_id) await updateUserCredits(env, taskOwner.user_id, 1, 'add');
}

async function dispatchPushPlan(env, planTable, taskId, plan) {
  try {
    await pushToWebhook(plan.webhook_url, JSON.parse(plan.payload));
  } catch (err) {
    await markPushPlanFailed(env, planTable, plan.id, err.message);
    await refundTaskCredit(env, taskId);
  }
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
      if (!plan.webhook_url) {
        await markPushPlanFailed(env, 'ews_jst_push_plans', plan.id, 'Webhook地址未配置');
        continue;
      }
      let canSend = true;
      if (taskOwner?.user_id) {
        const credits = await getUserCredits(env, taskOwner.user_id);
        if (credits > 0) await updateUserCredits(env, taskOwner.user_id, 1, 'subtract');
        else canSend = false;
      }
      if (canSend) {
        await jstUpdatePlanStatus(env, plan.id, 'processing');
        ctx.waitUntil(dispatchPushPlan(env, 'ews_jst_push_plans', taskId, plan));
      } else {
        await env.DB.prepare("UPDATE ews_jst_push_plans SET status='failed', retry_count=3, error=? WHERE id=?").bind('算力不足', plan.id).run();
      }
    }
  } catch (err) { console.error('jstReleaseTaskQueue error:', err.message); }
}

async function processPendingQueue(env, ctx) {
  try {
    await processCallbackQueue(env, ctx);
    await processImageQueue(env, ctx);
    const jstRows = await query(env, "SELECT DISTINCT p.task_id FROM ews_jst_push_plans p LEFT JOIN ews_jst_tasks t ON t.id = p.task_id WHERE p.status='pending' AND COALESCE(t.queue_mode, 'auto') != 'manual'");
    for (const row of (jstRows?.results || [])) ctx.waitUntil(jstReleaseTaskQueue(env, row.task_id, ctx));
    const shopeeRows = await query(env, "SELECT DISTINCT p.task_id FROM ews_shopee_push_plans p LEFT JOIN ews_tasks t ON t.id = p.task_id WHERE p.status='pending' AND t.status='processing'");
    for (const row of (shopeeRows?.results || [])) ctx.waitUntil(shopeeReleaseTaskQueue(env, row.task_id, ctx));
  } catch (err) { console.error('processPendingQueue error:', err.message); }
}

// ========== 回调 ==========

const CALLBACK_QUEUE_BATCH_SIZE = 3;
const CALLBACK_QUEUE_MAX_ATTEMPTS = 5;
const IMAGE_QUEUE_BATCH_SIZE = 3;
const IMAGE_QUEUE_MAX_ACTIVE = 3;
const IMAGE_QUEUE_MAX_ATTEMPTS = 5;
let callbackQueueReady = false;
let imageQueueReady = false;

function callbackPermanentError(message) {
  const err = new Error(message);
  err.permanent = true;
  return err;
}

async function ensureCallbackQueueTable(env) {
  if (callbackQueueReady) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ews_callback_queue (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT '',
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT DEFAULT '',
    received_at TEXT NOT NULL DEFAULT (datetime('now')),
    processing_at TEXT DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_callback_queue_status ON ews_callback_queue(status, received_at)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_callback_queue_task ON ews_callback_queue(task_id)").run();
  callbackQueueReady = true;
}

async function ensureImageQueueTable(env) {
  if (imageQueueReady) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ews_image_queue (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT '',
    sub_task_id TEXT NOT NULL DEFAULT '',
    set_index INTEGER NOT NULL DEFAULT 0,
    image_type TEXT NOT NULL,
    image_position INTEGER NOT NULL DEFAULT 1,
    image_url TEXT DEFAULT '',
    error_message TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT DEFAULT '',
    received_at TEXT NOT NULL DEFAULT (datetime('now')),
    processing_at TEXT DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_image_queue_status ON ews_image_queue(status, received_at)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_image_queue_task ON ews_image_queue(task_id)").run();
  imageQueueReady = true;
}

async function handleCallback(request, env, ctx) {
  const body = await parseBody(request);
  if (!body || typeof body !== 'object' || typeof body.get === 'function') return error('无效的请求体', 400);
  const { task_id } = body;
  if (!task_id) return error('缺少 task_id', 400);
  const idx = await getTaskIndex(env, task_id);
  if (!idx) return error('任务不存在', 404);
  const config = await getConfig(env, idx.platform || '');
  const receivedSecret = body.secret ?? body.callback_secret;
  if (config.callback_secret && receivedSecret !== config.callback_secret) return error('回调密钥无效', 403);

  try {
    await ensureCallbackQueueTable(env);
    const queueId = uuid(16);
    await env.DB.prepare("INSERT INTO ews_callback_queue (id, task_id, platform, payload, status, received_at, updated_at) VALUES (?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))")
      .bind(queueId, task_id, idx.platform || '', JSON.stringify(body)).run();
    ctx.waitUntil(processCallbackQueue(env, ctx, queueId));
    return json({ success: true, queued: true, queue_id: queueId, message: '回调已入队' });
  } catch (err) {
    console.error('callback enqueue failed:', err.message);
    return json({ success: false, queued: false, retryable: true, error: '回调队列写入失败，请稍后重试' }, 503);
  }
}

async function processCallbackQueue(env, ctx, preferredId) {
  try {
    await ensureCallbackQueueTable(env);
    const rows = [];
    if (preferredId) {
      const preferred = await getOne(env, "SELECT * FROM ews_callback_queue WHERE id=?", [preferredId]);
      if (preferred) rows.push(preferred);
    }
    const remaining = CALLBACK_QUEUE_BATCH_SIZE - rows.length;
    if (remaining > 0) {
      const pending = await query(env, `SELECT * FROM ews_callback_queue
        WHERE id != ? AND attempts < ? AND (status='pending' OR (status='processing' AND processing_at < datetime('now', '-5 minutes')))
        ORDER BY received_at ASC LIMIT ?`, [preferredId || '', CALLBACK_QUEUE_MAX_ATTEMPTS, remaining]);
      rows.push(...(pending?.results || []));
    }
    for (const row of rows) await processCallbackQueueRow(env, ctx, row);
  } catch (err) {
    console.error('processCallbackQueue error:', err.message);
  }
}

async function processCallbackQueueRow(env, ctx, row) {
  const claim = await env.DB.prepare(`UPDATE ews_callback_queue
    SET status='processing', attempts=attempts+1, processing_at=datetime('now'), updated_at=datetime('now'), error=''
    WHERE id=? AND attempts < ? AND (status='pending' OR (status='processing' AND processing_at < datetime('now', '-5 minutes')))`)
    .bind(row.id, CALLBACK_QUEUE_MAX_ATTEMPTS).run();
  const attempts = (row.attempts || 0) + 1;
  const claimedChanges = claim.meta && typeof claim.meta.changes === 'number' ? claim.meta.changes : 1;
  if (claimedChanges < 1) return;
  try {
    const payload = JSON.parse(row.payload || '{}');
    await processCallbackPayload(env, ctx, payload, true);
    await env.DB.prepare("DELETE FROM ews_callback_queue WHERE id=?").bind(row.id).run();
  } catch (err) {
    const failed = err.permanent || attempts >= CALLBACK_QUEUE_MAX_ATTEMPTS;
    await env.DB.prepare("UPDATE ews_callback_queue SET status=?, error=?, updated_at=datetime('now') WHERE id=?")
      .bind(failed ? 'failed' : 'pending', err.message || '回调处理失败', row.id).run();
    console.error('callback queue item failed:', row.id, err.message);
  }
}

async function enqueueImageCallback(env, idx, body) {
  await ensureImageQueueTable(env);
  const imageId = uuid(16);
  await env.DB.prepare(`INSERT INTO ews_image_queue
    (id, task_id, platform, sub_task_id, set_index, image_type, image_position, image_url, error_message, status, received_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))`)
    .bind(
      imageId,
      body.task_id,
      idx.platform || '',
      body.sub_task_id || '',
      body.set_index ?? 0,
      body.image_type,
      parseInt(body.image_position) || 1,
      body.image_url || '',
      body.error || ''
    ).run();
  return imageId;
}

async function processImageQueue(env, ctx) {
  try {
    await ensureImageQueueTable(env);
    const candidates = await query(env, `SELECT * FROM ews_image_queue
      WHERE attempts < ? AND (status='pending' OR (status='processing' AND processing_at < datetime('now', '-5 minutes')))
      ORDER BY received_at ASC LIMIT ?`, [IMAGE_QUEUE_MAX_ATTEMPTS, IMAGE_QUEUE_BATCH_SIZE]);
    for (const row of (candidates?.results || [])) await processImageQueueRow(env, ctx, row);
  } catch (err) {
    console.error('processImageQueue error:', err.message);
  }
}

async function processImageQueueRow(env, ctx, row) {
  const claim = await env.DB.prepare(`UPDATE ews_image_queue
    SET status='processing', attempts=attempts+1, processing_at=datetime('now'), updated_at=datetime('now'), error=''
    WHERE id=? AND attempts < ?
      AND (status='pending' OR (status='processing' AND processing_at < datetime('now', '-5 minutes')))
      AND (SELECT COUNT(*) FROM ews_image_queue WHERE status='processing' AND processing_at >= datetime('now', '-5 minutes')) < ?`)
    .bind(row.id, IMAGE_QUEUE_MAX_ATTEMPTS, IMAGE_QUEUE_MAX_ACTIVE).run();
  const attempts = (row.attempts || 0) + 1;
  const claimedChanges = claim.meta && typeof claim.meta.changes === 'number' ? claim.meta.changes : 1;
  if (claimedChanges < 1) return;
  try {
    await processImageQueuePayload(env, ctx, row);
    await env.DB.prepare("DELETE FROM ews_image_queue WHERE id=?").bind(row.id).run();
  } catch (err) {
    const failed = err.permanent || attempts >= IMAGE_QUEUE_MAX_ATTEMPTS;
    await env.DB.prepare("UPDATE ews_image_queue SET status=?, error=?, updated_at=datetime('now') WHERE id=?")
      .bind(failed ? 'failed' : 'pending', err.message || '图片处理失败', row.id).run();
    console.error('image queue item failed:', row.id, err.message);
  } finally {
    if (ctx) ctx.waitUntil(processImageQueue(env, ctx));
  }
}

async function processImageQueuePayload(env, ctx, row) {
  const task_id = row.task_id;
  const idx = await getTaskIndex(env, task_id);
  if (!idx) throw callbackPermanentError('任务不存在');
  const config = await getConfig(env, idx.platform || '');
  const publicUrl = config.r2_public_url || '';
  const isShopee = idx.platform === 'shopee';
  const updateSubTask = isShopee ? shopeeUpdateSubTask : jstUpdateSubTask;
  const checkSubTaskImages = isShopee ? shopeeCheckSubTaskImages : jstCheckSubTaskImages;
  const checkParentCompletion = isShopee ? shopeeCheckParentCompletion : jstCheckParentCompletion;
  const refundCredits = isShopee ? shopeeRefundCredits : jstRefundCredits;
  const planTable = isShopee ? 'ews_shopee_push_plans' : 'ews_jst_push_plans';
  const sub_task_id = row.sub_task_id || '';
  const image_type = row.image_type;
  const image_position = parseInt(row.image_position) || 1;
  const whType = `${image_type}_${image_position}`;
  const result = row.image_url ? await processOneImage(env, idx.platform, task_id, sub_task_id, row.set_index ?? 0, image_type, image_position, row.image_url, publicUrl) : null;

  if (result) {
    await env.DB.prepare(`UPDATE ${planTable} SET status='done' WHERE task_id=? AND sub_task_id=? AND webhook_type=? AND status='processing'`)
      .bind(task_id, sub_task_id, whType).run();
  } else {
    const planInfo = await env.DB.prepare(`SELECT id, webhook_url, payload, retry_count FROM ${planTable} WHERE task_id=? AND sub_task_id=? AND webhook_type=? AND status='processing'`)
      .bind(task_id, sub_task_id, whType).first();
    if (planInfo && planInfo.webhook_url && (planInfo.retry_count||0) < 3) {
      const newCount = (planInfo.retry_count||0) + 1;
      await env.DB.prepare(`UPDATE ${planTable} SET status='processing', retry_count=?, error=? WHERE id=?`).bind(newCount, `${row.error_message || '下载失败'}，重试第${newCount}次`, planInfo.id).run();
      ctx.waitUntil(dispatchPushPlan(env, planTable, task_id, planInfo));
    } else {
      const reason = planInfo?.retry_count >= 3 ? '已重试3次失败' : (row.error_message || '下载失败');
      await env.DB.prepare(`UPDATE ${planTable} SET status='failed', error=? WHERE task_id=? AND sub_task_id=? AND webhook_type=? AND status='processing'`).bind(reason, task_id, sub_task_id, whType).run();
      if (planInfo?.retry_count >= 3) await refundCredits(env, task_id);
    }
  }

  if (sub_task_id) {
    const imgStatus = await checkSubTaskImages(env, sub_task_id);
    if (imgStatus.total > 0 && imgStatus.total === imgStatus.completed) await updateSubTask(env, sub_task_id, { status: 'completed' });
  }
  await checkParentCompletion(env, task_id);

  if (isShopee) {
    const taskInfo = await getOne(env, "SELECT status FROM ews_tasks WHERE id=?", [task_id]);
    if (taskInfo?.status === 'processing') ctx.waitUntil(shopeeReleaseTaskQueue(env, task_id, ctx));
  } else {
    const taskInfo = await getOne(env, "SELECT queue_mode FROM ews_jst_tasks WHERE id=?", [task_id]);
    if (taskInfo?.queue_mode !== 'manual') ctx.waitUntil(jstReleaseTaskQueue(env, task_id, ctx));
  }
}

async function processCallbackPayload(env, ctx, body, trustedQueuePayload) {
  if (!body || typeof body !== 'object') throw callbackPermanentError('无效的请求体');
  const { task_id, sub_task_id, set_index, titles, product_title, image_type, image_position, image_url, error: errMsg } = body;
  if (!task_id) throw callbackPermanentError('缺少 task_id');
  const idx = await getTaskIndex(env, task_id);
  if (!idx) throw callbackPermanentError('任务不存在');

  const config = await getConfig(env, idx.platform || '');
  if (!trustedQueuePayload) {
    const receivedSecret = body.secret ?? body.callback_secret;
    if (config.callback_secret && receivedSecret !== config.callback_secret) throw callbackPermanentError('回调密钥无效');
  }

  const publicUrl = config.r2_public_url || '';
  const isShopee = idx.platform === 'shopee';
  const getSubTasks = isShopee ? shopeeGetSubTasks : jstGetSubTasks;
  const updateSubTask = isShopee ? shopeeUpdateSubTask : jstUpdateSubTask;
  const checkSubTaskImages = isShopee ? shopeeCheckSubTaskImages : jstCheckSubTaskImages;
  const checkParentCompletion = isShopee ? shopeeCheckParentCompletion : jstCheckParentCompletion;
  const refundCredits = isShopee ? shopeeRefundCredits : jstRefundCredits;

  // 标题回调
  if (titles && Array.isArray(titles)) {
    const subTasks = await getSubTasks(env, task_id);
    const allSubs = (subTasks?.results || []).sort((a,b) => a.set_index - b.set_index);
    if (titles.length !== allSubs.length) throw callbackPermanentError(`标题数量不匹配: ${titles.length} vs ${allSubs.length}`);
    for (let i = 0; i < allSubs.length; i++) await updateSubTask(env, allSubs[i].id, { title: titles[i] });
  } else if (product_title) {
    const subTasks = await getSubTasks(env, task_id);
    for (const st of (subTasks?.results || [])) await updateSubTask(env, st.id, { title: product_title });
  }
  if (titles || product_title) {
    const PP = idx.platform === 'jst' ? 'ews_jst_' : 'ews_shopee_';
    await env.DB.prepare(`UPDATE ${PP}push_plans SET status='done' WHERE task_id=? AND webhook_type='title' AND status='processing'`).bind(task_id).run();
  }

  // SKU 标题回调
  if (body.sku_titles && Array.isArray(body.sku_titles)) {
    if (isShopee) {
      const skuDetail = await shopeeGetProduct(env, task_id);
      const variants = skuDetail?.variations || [];
      const subTasks = await shopeeGetSubTasks(env, task_id);
      const allSubs = (subTasks?.results || []).sort((a,b) => a.set_index - b.set_index);
      const vCount = variants.length;
      const expected = allSubs.length * vCount;
      if (body.sku_titles.length !== expected) throw callbackPermanentError(`SKU标题数量不匹配: ${body.sku_titles.length} vs ${expected}`);
      for (let si = 0; si < allSubs.length; si++) {
        for (let vi = 0; vi < vCount; vi++) {
          const title = body.sku_titles[si * vCount + vi];
          if (title) await shopeeCreateSkuTitle(env, { id: uuid(), sub_task_id: allSubs[si].id, variation_id: variants[vi].id, title: title.slice(0, 20) });
        }
      }
      await env.DB.prepare("UPDATE ews_shopee_push_plans SET status='done' WHERE task_id=? AND webhook_type='sku_title' AND status='processing'").bind(task_id).run();
    } else {
      const skuDetail = await jstGetTask(env, task_id);
      const variants = (skuDetail?.variants || []).sort((a,b) => a.sort_order - b.sort_order);
      const subTasks = await jstGetSubTasks(env, task_id);
      const allSubs = (subTasks?.results || []).sort((a,b) => a.set_index - b.set_index);
      const vCount = variants.length;
      const expected = allSubs.length * vCount;
      if (body.sku_titles.length !== expected) throw callbackPermanentError(`SKU标题数量不匹配: ${body.sku_titles.length} vs ${expected}`);
      for (let si = 0; si < allSubs.length; si++) {
        for (let vi = 0; vi < vCount; vi++) {
          const title = body.sku_titles[si * vCount + vi];
          if (title) await jstCreateSkuTitle(env, { id: uuid(), sub_task_id: allSubs[si].id, variant_id: variants[vi].id, title: title.slice(0, 30) });
        }
      }
      await env.DB.prepare("UPDATE ews_jst_push_plans SET status='done' WHERE task_id=? AND webhook_type='sku_title' AND status='processing'").bind(task_id).run();
    }
  }

  // 图片回调先进入图片队列，避免回调并发直接放大 R2/D1 压力
  let imageQueued = false;
  if (image_type && image_position && (image_url || errMsg)) {
    if (!['main','sub','detail','sku'].includes(image_type)) throw callbackPermanentError('无效的图片类型');
    await enqueueImageCallback(env, idx, body);
    ctx.waitUntil(processImageQueue(env, ctx));
    imageQueued = true;
  }

  if (!imageQueued) {
    // 检查子任务完成
    if (sub_task_id) {
      const imgStatus = await checkSubTaskImages(env, sub_task_id);
      if (imgStatus.total > 0 && imgStatus.total === imgStatus.completed) await updateSubTask(env, sub_task_id, { status: 'completed' });
    }
    await checkParentCompletion(env, task_id);

    if (isShopee) {
      const taskInfo = await getOne(env, "SELECT status FROM ews_tasks WHERE id=?", [task_id]);
      if (taskInfo?.status === 'processing') ctx.waitUntil(shopeeReleaseTaskQueue(env, task_id, ctx));
    } else {
      const taskInfo = await getOne(env, "SELECT queue_mode FROM ews_jst_tasks WHERE id=?", [task_id]);
      if (taskInfo?.queue_mode !== 'manual') ctx.waitUntil(jstReleaseTaskQueue(env, task_id, ctx));
    }
  }

  return { success: true, sub_task_id, image_queued: imageQueued };
}

const SHOPEE_ITEM_IMAGE_LIMIT_BYTES = 2 * 1024 * 1024;
const SHOPEE_ITEM_IMAGE_MAX_SIDE = 1200;
const SHOPEE_JPEG_QUALITIES = [90, 86, 82, 78, 74, 70, 66, 62, 58, 54, 50];
const SHOPEE_FALLBACK_SIDES = [1100, 1000, 900, 800, 700, 600];

function isShopeeItemImage(platform, imageType) {
  return platform === 'shopee' && (imageType === 'main' || imageType === 'sub');
}

function freePhotonImage(img) {
  if (img) img.free();
}

function candidateShopeeSides(side) {
  const first = Math.min(side, SHOPEE_ITEM_IMAGE_MAX_SIDE);
  const sides = [first, ...SHOPEE_FALLBACK_SIDES.filter(s => s < first)];
  return [...new Set(sides)].filter(s => s > 0);
}

function encodeShopeeJpegUnderLimit(image) {
  let best = null;
  for (const quality of SHOPEE_JPEG_QUALITIES) {
    const bytes = image.get_bytes_jpeg(quality);
    if (!best || bytes.byteLength < best.byteLength) best = bytes;
    if (bytes.byteLength <= SHOPEE_ITEM_IMAGE_LIMIT_BYTES) return bytes;
  }
  return best;
}

function normalizeShopeeItemImage(buffer) {
  let input = null;
  let square = null;
  const resizedImages = [];
  try {
    input = PhotonImage.new_from_byteslice(new Uint8Array(buffer));
    const width = input.get_width();
    const height = input.get_height();
    if (!width || !height) throw new Error('Invalid image dimensions');

    const side = Math.min(width, height);
    let working = input;
    if (width !== height) {
      const left = Math.floor((width - side) / 2);
      const top = Math.floor((height - side) / 2);
      square = crop(input, left, top, left + side, top + side);
      working = square;
    }

    for (const targetSide of candidateShopeeSides(side)) {
      let candidate = working;
      if (working.get_width() !== targetSide || working.get_height() !== targetSide) {
        candidate = resize(working, targetSide, targetSide, SamplingFilter.Lanczos3);
        resizedImages.push(candidate);
      }
      const bytes = encodeShopeeJpegUnderLimit(candidate);
      if (bytes && bytes.byteLength <= SHOPEE_ITEM_IMAGE_LIMIT_BYTES) return bytes;
    }
    throw new Error('Shopee image remains above 2MB after compression');
  } finally {
    for (const img of resizedImages) freePhotonImage(img);
    freePhotonImage(square);
    freePhotonImage(input);
  }
}

async function processOneImage(env, platform, task_id, sub_task_id, set_index, image_type, image_position, image_url, publicUrl) {
  try {
    const resp = await fetch(image_url);
    if (!resp.ok) return null;
    let buffer = await resp.arrayBuffer();
    let contentType = resp.headers.get('content-type') || 'image/jpeg';
    if (isShopeeItemImage(platform, image_type)) {
      buffer = normalizeShopeeItemImage(buffer);
      contentType = 'image/jpeg';
    }
    const ext = 'jpg';
    const fileName = `${image_type}_${image_position}.${ext}`;
    const r2Key = `ews/${task_id}/${sub_task_id}/${fileName}`;
    await env.R2.put(r2Key, buffer, { httpMetadata: { contentType } });
    const fullUrl = publicUrl ? `${publicUrl.replace(/\/+$/, '')}/${r2Key}` : r2Key;
    if (platform === 'shopee') await shopeeSaveImage(env, { parent_task_id: task_id, sub_task_id, set_index, image_type, position: image_position, image_url: fullUrl });
    else await jstSaveImage(env, { id: '', parent_task_id: task_id, sub_task_id, variant_id: null, set_index, image_type, position: image_position, image_url: fullUrl });
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
  const variants = detail.variants || [];
  const images = detail.images || [];
  const generateCount = detail.generate_count || 1;
  const mode = detail.mode || 'full';
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

  function recordedImg(setIdx, type, pos) {
    const found = images.find(img => img.set_index === setIdx && img.image_type === type && img.position === pos);
    return found?.image_url || '';
  }
  function getImg(setIdx, type, pos) {
    const direct = recordedImg(setIdx, type, pos);
    if (direct) return direct;
    if (mode === 'dedup' && setIdx > 0 && type !== 'main') {
      return recordedImg(0, type, pos);
    }
    return '';
  }
  function getSkuUrl(setIdx, vIdx) {
    const direct = recordedImg(setIdx, 'sku', vIdx + 1);
    if (direct) return direct;
    if (mode === 'dedup' && setIdx > 0) return recordedImg(0, 'sku', vIdx + 1);
    return '';
  }

  const exportErrors = [];
  function addExportError(msg) {
    if (exportErrors.length < 80) exportErrors.push(msg);
  }
  if (variants.length === 0) addExportError('至少需要一个变体');
  if (subTaskIds.length === 0) addExportError('请先推送并完成AI生成任务，当前没有商品套图子任务');
  if (subTaskIds.length > 0 && subTaskIds.length < generateCount) addExportError('AI商品套图数量不足: ' + subTaskIds.length + '/' + generateCount);
  for (let setIdx = 0; setIdx < generateCount; setIdx++) {
    const subTaskId = subTaskIds[setIdx] || '';
    const subTask = (detail.sub_tasks || []).find(st => st.id === subTaskId);
    const setLabel = '第' + (setIdx + 1) + '套';
    if (!subTaskId) { addExportError(setLabel + ' 缺少子任务'); continue; }
    if (!(subTask?.title || '').trim()) addExportError(setLabel + ' 缺少AI商品标题');
    if (!getImg(setIdx, 'main', 1)) addExportError(setLabel + ' 缺少AI主图main_1');
    for (let p = 2; p <= mainImgTotal; p++) {
      if (!getImg(setIdx, 'sub', p)) addExportError(setLabel + ' 缺少AI附图sub_' + p);
    }
    for (let p = 1; p <= detailImgTotal; p++) {
      if (!getImg(setIdx, 'detail', p)) addExportError(setLabel + ' 缺少AI详情图detail_' + p);
    }
    for (let vIdx = 0; vIdx < variants.length; vIdx++) {
      const variant = variants[vIdx];
      const skuTitle = skuTitleMap[subTaskId + '_' + variant.id] || '';
      if (!skuTitle.trim()) addExportError(setLabel + ' 变体#' + (vIdx + 1) + ' 缺少AI SKU标题');
      if (!getSkuUrl(setIdx, vIdx)) addExportError(setLabel + ' 变体#' + (vIdx + 1) + ' 缺少AI SKU变体图');
    }
  }
  if (exportErrors.length) {
    return json({ success: false, error: 'JST资源未生成完成，已阻止导出', errors: exportErrors }, 400);
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
      const exportPrice = exportPriceForVariant(variant, taskId, setIdx, vIdx);
      rows.push({
        '款式编码': styleCode, '商品编码': skuCode, '颜色': skuTitle, '规格': '',
        '商品主图': JSON.stringify(mainUrls.filter(u => u)),
        '商品详情图': JSON.stringify(detailUrls.filter(u => u)),
        '图片地址': skuUrl, '商品名称': productTitle, '推荐文案': '', '商品描述': '', '宝贝链接': '',
        '库存': detail.stock ?? 999, '重量(kg)': detail.weight ?? 1.0, '基本售价': exportPrice,
        '市场|吊牌价': exportPrice, '最低分销控价': '', '最高分销控价': '', '供应商名': '',
        '3:4主图': '', '长图': '', '透明素材图': '', '白底图': '',
      });
    }
  }
  return json({ success: true, rows, task_title: detail.name, mode, export_format: 'jst' });
}

// ========== Shopee 模板校验 ==========
function validateShopeeRow(product, variations) {
  var warnings = []; var errors = [];
  var n = product.name || '';
  var desc = product.description || '';
  var weightKg = parseFloat(product.weight_kg);
  var weightG = isNaN(weightKg) ? 0 : Math.round(weightKg * 1000);
  var categoryId = product.category_id || '';
  var hsCode = product.hs_code || '';
  var gtin = product.gtin || '';
  var varCount = variations.length;
  var variationName1 = product.variation_name1 || '';
  var variationName2 = product.variation_name2 || '';

  // 必填字段
  if (!n) errors.push('任务名称不能为空');
  if (!desc) errors.push('商品描述(Product Description)不能为空');
  if (desc && (desc.length < 100 || desc.length > 3000)) errors.push('商品描述(Product Description)必须为100~3000字符（当前: ' + desc.length + '）');
  if (varCount === 0) errors.push('至少需要一个变体');
  if (isNaN(weightKg) || weightKg <= 0 || weightG > 100000000) errors.push('重量(Weight)导出为g，必须在0~100000000g之间（当前: ' + (isNaN(weightKg) ? '空' : weightG + 'g') + '）');

  // 变体校验
  if (varCount > 0) {
    var hasTier2 = variations.some(function(v) { return v.option2 && v.option2.trim(); });
    if (varCount > 50) errors.push('变体数量超过50上限（当前: ' + varCount + '）');
    if (!hasTier2 && varCount > 20) errors.push('一维规格变体超过20上限（当前: ' + varCount + '）');
    if (!variationName1) errors.push('规格名1(Variation Name1)不能为空');
    if (variationName1 && (variationName1.length < 1 || variationName1.length > 14)) errors.push('规格名1(Variation Name1)必须为1~14字符（当前: ' + variationName1.length + '）');
    if (hasTier2 && !variationName2) errors.push('存在二级规格时，规格名2(Variation Name2)不能为空');
    if (variationName2 && (variationName2.length < 1 || variationName2.length > 14)) errors.push('规格名2(Variation Name2)必须为1~14字符（当前: ' + variationName2.length + '）');

    // 检查变体组合是否重复
    var combos = {};
    for (var i = 0; i < variations.length; i++) {
      var key = (variations[i].option1 || '') + '|' + (variations[i].option2 || '');
      if (combos[key]) { warnings.push('变体组合 "' + key + '" 重复（第' + (i+1) + '行）'); }
      combos[key] = true;
      if (!variations[i].option1 || !variations[i].option1.trim()) errors.push('变体#' + (i+1) + ' 规格值1不能为空');
      if (variations[i].option1 && variations[i].option1.length > 20) errors.push('变体#' + (i+1) + ' 规格值1(Option for Variation 1)必须为1~20字符（当前: ' + variations[i].option1.length + '）');
      if (hasTier2 && (!variations[i].option2 || !variations[i].option2.trim())) errors.push('变体#' + (i+1) + ' 规格值2不能为空');
      if (variations[i].option2 && variations[i].option2.length > 20) errors.push('变体#' + (i+1) + ' 规格值2(Option for Variation 2)必须为1~20字符（当前: ' + variations[i].option2.length + '）');
      if (isEnabled(variations[i].price_float_enabled)) {
        var minPrice = parseFloat(variations[i].price_min);
        var maxPrice = parseFloat(variations[i].price_max);
        if (isNaN(minPrice) || isNaN(maxPrice) || maxPrice < minPrice) errors.push('变体#' + (i+1) + ' 价格浮动区间无效');
        else if (minPrice < 1000 || maxPrice > 120000000) errors.push('变体#' + (i+1) + ' 价格浮动区间必须在1000~120000000');
      } else {
        var p = parseFloat(variations[i].price);
        if (isNaN(p) || p < 1000 || p > 120000000) errors.push('变体#' + (i+1) + ' 价格(Price)必须为1000~120000000（当前: ' + variations[i].price + '）');
      }
      var stock = parseInt(variations[i].stock);
      if (isNaN(stock) || stock < 0 || stock > 10000000) errors.push('变体#' + (i+1) + ' 库存(Stock)必须为0~10000000（当前: ' + variations[i].stock + '）');
      if (variations[i].sku && variations[i].sku.length >= 100) errors.push('变体#' + (i+1) + ' SKU必须小于100字符（当前: ' + variations[i].sku.length + '）');
    }
  }

  // 分类ID
  if (categoryId && !/^\d+$/.test(categoryId)) warnings.push('分类ID(Category)应为数字（当前: ' + categoryId + '）');

  // HS Code
  if (hsCode && !/^\d{4,8}$/.test(hsCode)) warnings.push('HS Code应为4/6/8位数字（当前: ' + hsCode + '）');

  // GTIN
  if (gtin && !/^\d{8,14}$/.test(gtin)) warnings.push('GTIN应为8~14位数字（当前: ' + gtin + '）');

  // 重量单位提示
  if (!isNaN(weightKg) && weightKg > 100) warnings.push('重量较大(' + weightKg + 'kg)，导出会转换为' + weightG + 'g，请确认单位是否正确');

  // Parent SKU / SKU 重复检查
  var skuSet = {};
  for (var vi = 0; vi < variations.length; vi++) {
    var sku = variations[vi].sku || '';
    if (sku) {
      if (skuSet[sku]) warnings.push('SKU "' + sku + '" 重复（变体#' + (vi+1) + '），店内不可重复');
      skuSet[sku] = true;
    }
  }

  return { errors: errors, warnings: warnings, valid: errors.length === 0 };
}

async function shopeeHandleExport(env, taskId) {
  const product = await shopeeGetProduct(env, taskId);
  if (!product) return error('商品不存在', 404);
  const variations = product.variations || [];

  // 校验
  var validation = validateShopeeRow(product, variations);
  // 有错误则拒绝导出，有警告则附带
  if (!validation.valid) {
    return json({ success: false, error: '数据校验失败', errors: validation.errors, warnings: validation.warnings }, 400);
  }

  const rows = [];
  const mode = product.mode || 'full';
  const mainImgTotal = Math.min(Math.max(product.main_image_count || 9, 5), 9);
  const expectedSetCount = Math.max(parseInt(product.generate_count) || 1, 1);
  const subTasks = (product.sub_tasks && product.sub_tasks.length) ? product.sub_tasks : [];
  var shippingChannels = [];
  try { shippingChannels = JSON.parse(product.shipping_channels || '[]'); } catch(e) {}

  const subTaskIds = subTasks.map(st => st.id).filter(Boolean);
  const skuTitleMap = {};
  if (subTaskIds.length > 0) {
    const ph = subTaskIds.map(() => '?').join(',');
    const skuRows = await query(env, `SELECT sub_task_id, variation_id, title FROM ews_shopee_sku_titles WHERE sub_task_id IN (${ph})`, subTaskIds);
    for (const st of (skuRows?.results || [])) skuTitleMap[st.sub_task_id + '_' + st.variation_id] = st.title;
  }

  function generatedImage(type, pos, setIdx, subTaskId) {
    const rec = (product.images_rec || []).find(img => img.set_index === setIdx && img.image_type === type && img.position === pos);
    return rec?.image_url || '';
  }
  function getImg(setIdx, subTaskId, type, pos) {
    const direct = generatedImage(type, pos, setIdx, subTaskId);
    if (direct) return direct;
    if (mode === 'dedup' && setIdx > 0 && type !== 'main') {
      const firstSubId = subTasks[0]?.id || '';
      const shared = generatedImage(type, pos, 0, firstSubId);
      if (shared) return shared;
    }
    return '';
  }
  function productImages(setIdx, subTaskId) {
    const generated = [];
    for (let p = 2; p <= mainImgTotal; p++) {
      const url = getImg(setIdx, subTaskId, 'sub', p);
      if (url) generated.push(url);
    }
    return generated;
  }
  function getSkuUrl(setIdx, subTaskId, vIdx, v) {
    return getImg(setIdx, subTaskId, 'sku', vIdx + 1);
  }
  function shipping(id) { return shippingChannels.includes(id) ? 'On' : 'Off'; }
  function weightInGrams() {
    const kg = parseFloat(product.weight_kg);
    return isNaN(kg) ? '' : Math.round(kg * 1000);
  }
  function styleCodeFor(subTask, setIdx) {
    return subTask.id ? subTask.id.slice(0, 8) : `${taskId.slice(0, 8)}-S${setIdx + 1}`;
  }
  function parentSkuFor(subTask, setIdx) {
    return product.parent_sku ? `${product.parent_sku}-${setIdx + 1}` : styleCodeFor(subTask, setIdx);
  }
  function skuCodeFor(subTask, setIdx, v, variationsIdx) {
    const parentSku = parentSkuFor(subTask, setIdx);
    return v.sku ? `${parentSku}-${v.sku}` : `${parentSku}-V${variationsIdx + 1}`;
  }

  const exportErrors = [];
  function addExportError(msg) {
    if (exportErrors.length < 80) exportErrors.push(msg);
  }
  if (subTasks.length === 0) addExportError('请先推送并完成AI生成任务，当前没有商品套图子任务');
  if (subTasks.length > 0 && subTasks.length < expectedSetCount) addExportError('AI商品套图数量不足: ' + subTasks.length + '/' + expectedSetCount);
  for (let si = 0; si < subTasks.length; si++) {
    const subTask = subTasks[si];
    const setIdx = subTask.set_index ?? si;
    const setLabel = '第' + (setIdx + 1) + '套';
    const productTitle = subTask.title || '';
    if (productTitle.length < 10 || productTitle.length > 120) addExportError(setLabel + ' 缺少合规AI商品标题(Product Name 10~120字符)');
    if (!getImg(setIdx, subTask.id || '', 'main', 1)) addExportError(setLabel + ' 缺少AI封面图(main_1)，不能用参考图替代');
    for (let p = 2; p <= mainImgTotal; p++) {
      if (!getImg(setIdx, subTask.id || '', 'sub', p)) addExportError(setLabel + ' 缺少AI附图sub_' + p);
    }
    for (let vi = 0; vi < variations.length; vi++) {
      const v = variations[vi];
      const skuTitle = skuTitleMap[(subTask.id || '') + '_' + v.id] || '';
      const skuCode = skuCodeFor(subTask, setIdx, v, vi);
      if (skuTitle.length < 1 || skuTitle.length > 20) addExportError(setLabel + ' 变体#' + (vi + 1) + ' 缺少合规AI SKU标题(Option 1~20字符)');
      if (!getSkuUrl(setIdx, subTask.id || '', vi, v)) addExportError(setLabel + ' 变体#' + (vi + 1) + ' 缺少AI SKU变体图');
      if (skuCode.length >= 100) addExportError(setLabel + ' 变体#' + (vi + 1) + ' 导出SKU超过100字符');
    }
  }
  if (exportErrors.length) {
    return json({ success: false, error: 'Shopee资源未生成完成，已阻止导出', errors: exportErrors, warnings: validation.warnings }, 400);
  }

  // 列顺序必须匹配 Shopee 模板 (A~AP)
  function makeRow(subTask, setIdx, variationsIdx) {
    var v = variations[variationsIdx];
    var images = productImages(setIdx, subTask.id || '');
    var coverImage = getImg(setIdx, subTask.id || '', 'main', 1);
    var parentSku = parentSkuFor(subTask, setIdx);
    var skuTitle = skuTitleMap[(subTask.id || '') + '_' + v.id] || '';
    var skuCode = skuCodeFor(subTask, setIdx, v, variationsIdx);
    var exportPrice = exportPriceForVariant(v, taskId, setIdx, variationsIdx);
    return [
      product.category_id || '',                          // A Category
      subTask.title || '',                                // B Product Name
      product.description || '',                          // C Product Description
      '', '', '', '',                                     // D-G MaxPQ (保留空位)
      parentSku,                                          // H Parent SKU
      parentSku,                                          // I Variation Integration No.
      product.variation_name1 || '',                      // J Variation Name1
      skuTitle,                                           // K Option for Variation 1
      getSkuUrl(setIdx, subTask.id || '', variationsIdx, v), // L Image per Variation
      product.variation_name2 || '',                      // M Variation Name2
      v.option2 || '',                                    // N Option for Variation 2
      exportPrice,                                       // O Price
      v.stock ?? '',                                      // P Stock
      skuCode,                                            // Q SKU
      product.size_chart_template_id || '',               // R Size Chart Template
      product.size_chart_image || '',                     // S Size Chart Image
      product.gtin || '',                                 // T GTIN
      coverImage,                                         // U Cover image
      images[0] || '', images[1] || '', images[2] || '',  // V-X Item Image 1~3
      images[3] || '', images[4] || '', images[5] || '',  // Y-AA Item Image 4~6
      images[6] || '', images[7] || '',                   // AB-AC Item Image 7~8
      weightInGrams(),                                    // AD Weight(g)
      product.length_cm ?? '',                            // AE Length
      product.width_cm ?? '',                             // AF Width
      product.height_cm ?? '',                            // AG Height
      shipping('5000'), shipping('5001'), shipping('5004'), // AH-AJ Shipping
      shipping('5012'), shipping('5115'), shipping('50039'), shipping('50052'), // AK-AN Shipping
      product.pre_order_dts ?? '',                        // AO Pre-order DTS
      '',                                                 // AP Fail Reason
    ];
  }

  for (let si = 0; si < subTasks.length; si++) {
    const subTask = subTasks[si];
    const setIdx = subTask.set_index ?? si;
    for (let vi = 0; vi < variations.length; vi++) rows.push(makeRow(subTask, setIdx, vi));
  }

  var shopeeColumns = ['Category','Product Name','Product Description','Max Purchase Qty','MaxPQ Start Date','MaxPQ Time Period','MaxPQ End Date','Parent SKU','Variation Integration No.','Variation Name1','Option for Variation 1','Image per Variation','Variation Name2','Option for Variation 2','Price','Stock','SKU','Size Chart Template','Size Chart Image','GTIN','Cover image','Item Image 1','Item Image 2','Item Image 3','Item Image 4','Item Image 5','Item Image 6','Item Image 7','Item Image 8','Weight','Length','Width','Height','Shipping(5000)','Shipping(5001)','Shipping(5004)','Shipping(5012)','Shipping(5115)','Shipping(50039)','Shipping(50052)','Pre-order DTS','Fail Reason'];
  return json({ success: true, rows, columns: shopeeColumns, task_title: product.name, export_format: 'shopee',
    validation: { warnings: validation.warnings } });
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
