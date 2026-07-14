// EWS - Cloudflare Worker 主入口（统一路由 + 分平台分发）

import { PhotonImage, SamplingFilter, crop, resize } from '@cf-wasm/photon/workerd';
import {
  query, getOne, getConfig, updateConfig, getPlatformConfig,
  createUser, getUserByUsername, getUserList, updateUserPassword,
  toggleUserActive, deleteUser, updateUserPlatformAccess, updateUserWebhook, getUserCredits, updateUserCredits, consumeUserCredit,
  createTaskIndex, updateTaskIndexStatus, getTaskIndex, getTaskList, getTaskCount, deleteTaskIndex,
  jstCreateTask, jstUpdateTask, jstGetTask, jstUpdateTaskStatus,
  jstReplaceVariants,
  jstCreateSubTask, jstGetSubTasks, jstUpdateSubTask, jstDeleteSubTasks,
  jstCreateSkuTitle, jstSaveImage, jstClearImages,
  jstCreateExpectedImages, jstCheckSubTaskImages, jstCheckParentCompletion, jstDeleteTaskRecord,
  jstCreatePushPlans, jstGetPushPlans, jstGetPendingPlans, jstGetPlanStats,
  jstRefundCredits,
  shopeeCreateProduct, shopeeGetProduct, shopeeDeleteProduct,
  shopeeReplaceVariations,
  shopeeCreatePushPlans, shopeeGetPushPlans, shopeeGetPendingPlans, shopeeGetPlanStats,
  shopeeCreateExportRecord,
  shopeeCreateSubTask, shopeeGetSubTasks, shopeeUpdateSubTask,
  shopeeCreateExpectedImages, shopeeCheckSubTaskImages,
  shopeeSaveImage, shopeeCheckParentCompletion, shopeeRefundCredits, shopeeUpdateVariationExports,
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

const USER_WORKFLOW_SWITCH_KEYS = new Set([
  'n8n_title_enabled',
  'n8n_sku_title_enabled',
  'n8n_sku_image_enabled',
]);

function isWorkflowEnabled(config, key) {
  const value = config?.[key];
  return value === undefined || value === null || value === '' ? true : isEnabled(value);
}

function workflowExecutionFlags(config) {
  const primaryImagesOnly = isEnabled(config?.push_primary_images_only);
  return {
    primaryImagesOnly,
    title: !primaryImagesOnly && isWorkflowEnabled(config, 'n8n_title_enabled'),
    skuTitle: !primaryImagesOnly && isWorkflowEnabled(config, 'n8n_sku_title_enabled'),
    skuImage: !primaryImagesOnly && isWorkflowEnabled(config, 'n8n_sku_image_enabled'),
    detail: !primaryImagesOnly,
  };
}

function applyUserWorkflowOverrides(config, rawConfig, platform) {
  if (!rawConfig) return;
  try {
    const platformConfig = JSON.parse(rawConfig)?.[platform];
    if (!platformConfig || typeof platformConfig !== 'object' || Array.isArray(platformConfig)) return;
    for (const [key, value] of Object.entries(platformConfig)) {
      if (value === undefined || value === null || value === '' || value === 'inherit') continue;
      config[key] = value;
    }
  } catch (_) {}
}

function normalizeUserWorkflowConfig(body) {
  const normalized = {};
  for (const platform of ['jst', 'shopee']) {
    const source = body?.[platform];
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    const target = {};
    for (const [key, value] of Object.entries(source)) {
      if (USER_WORKFLOW_SWITCH_KEYS.has(key)) {
        if (typeof value === 'boolean') target[key] = value;
        else if (value === 'true' || value === 'false') target[key] = value === 'true';
      } else if (typeof value === 'string' && value.trim()) {
        target[key] = value.trim();
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        target[key] = value;
      }
    }
    normalized[platform] = target;
  }
  return normalized;
}

function clampPricePrecision(value) {
  const n = parseInt(value);
  if (Number.isNaN(n)) return 0;
  return Math.min(Math.max(n, -2), 2);
}

function normalizePlatformAccess(value) {
  return ['allow','jst','shopee'].includes(value) ? value : 'allow';
}

function canUsePlatform(auth, platform) {
  if (auth?.role === 'admin') return true;
  const access = normalizePlatformAccess(auth?.platform_access);
  return access === 'allow' || access === platform;
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
  async scheduled(event, env, ctx) {
    ctx.waitUntil(processPendingQueue(env, ctx));
  },

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
        return requireAuth(request, env, () => handleGetTasks(env, ctx, request.auth, url));
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
      if (path.match(/^\/api\/users\/[^\/]+\/platform$/) && method === 'PUT')
        return requireAuth(request, env, () => handleUpdateUserPlatform(request, env, path));
      if (path === '/api/users/me/credits' && method === 'GET')
        return requireAuth(request, env, () => handleGetMyCredits(request, env));
      if (path.match(/^\/api\/users\/[^\/]+\/webhook$/) && method === 'GET')
        return requireAuth(request, env, () => handleGetUserWebhook(request, env, path));
      if (path.match(/^\/api\/users\/[^\/]+\/webhook$/) && method === 'PUT')
        return requireAuth(request, env, () => handleUpdateUserWebhook(request, env, path));
      if (path.match(/^\/api\/users\/[^\/]+\/credits$/) && method === 'PUT')
        return requireAuth(request, env, () => handleUpdateUserCredits(request, env, path));
      if (path.match(/^\/api\/users\/[^\/]+\/reset-password$/) && method === 'PUT')
        return requireAuth(request, env, () => handleResetUserPassword(request, env, path));
      if (path.match(/^\/api\/users\/[^\/]+$/) && method === 'DELETE')
        return requireAuth(request, env, () => handleDeleteUser(request, env, path));

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
    user: { username: user.username, role: user.role, display_name: user.display_name, platform_access: user.role === 'admin' ? 'allow' : normalizePlatformAccess(user.platform_access) },
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
  return json({ success: auth.valid, username: auth.username || null, role: auth.role || null, platform_access: auth.role === 'admin' ? 'allow' : normalizePlatformAccess(auth.platform_access) });
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
    platform_access: u.role === 'admin' ? 'allow' : normalizePlatformAccess(u.platform_access),
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
  await createUser(env, { id: username, username, password_hash: pwdHash, role: role === 'admin' ? 'admin' : 'user', platform_access: normalizePlatformAccess(body?.platform_access), created_by: request.auth.username });
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

async function handleUpdateUserPlatform(request, env, path) {
  if (request.auth?.role !== 'admin') return error('无权访问', 403);
  const userId = path.split('/')[3];
  const body = await parseBody(request);
  const user = await getUserByUsername(env, userId);
  if (!user) return error('用户不存在', 404);
  const access = normalizePlatformAccess(body?.platform_access);
  await updateUserPlatformAccess(env, user.id, user.role === 'admin' ? 'allow' : access);
  return json({ success: true, platform_access: user.role === 'admin' ? 'allow' : access, message: '平台权限已更新' });
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
  await updateUserWebhook(env, user.id, JSON.stringify(normalizeUserWorkflowConfig(body)));
  return json({ success: true, message: '用户工作流配置已更新' });
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

async function handleResetUserPassword(request, env, path) {
  if (request.auth?.role !== 'admin') return error('无权访问', 403);
  const userId = path.split('/')[3];
  const user = await getUserByUsername(env, userId);
  if (!user) return error('用户不存在', 404);
  const defaultHash = await hashPassword('user123');
  await updateUserPassword(env, user.id, defaultHash);
  return json({ success: true, message: `用户 ${user.username} 密码已重置为 user123` });
}

async function handleDeleteUser(request, env, path) {
  if (request.auth?.role !== 'admin') return error('无权访问', 403);
  const userId = path.split('/')[3];
  if (userId === 'admin' || userId === request.auth.username) return error('不能删除管理员或当前登录用户', 400);
  const user = await getUserByUsername(env, userId);
  if (!user) return error('用户不存在', 404);
  await deleteUser(env, user.id);
  return json({ success: true, message: `用户 ${user.username} 已删除` });
}

// ========== 任务路由分发 ==========

function getTaskId(path) { return path.split('/')[3]; }

const MAX_GENERATE_COUNT = 100;
const MAX_JST_VARIATIONS = 100;
const MAX_SHOPEE_VARIATIONS = 50;
const SHOPEE_DESCRIPTION_MIN_LENGTH = 100;
const SHOPEE_DESCRIPTION_MAX_LENGTH = 3000;
const JST_TEMPLATE_COLUMNS = Object.freeze([
  '款式编码','商品编码','颜色','规格','商品主图','商品详情图','图片地址','商品名称','推荐文案','商品描述','宝贝链接',
  '库存','重量(kg)','基本售价','市场|吊牌价','最低分销控价','最高分销控价','供应商名','3:4主图','长图','透明素材图','白底图',
]);

function normalizeShopeeVariationImageMode(value, fallback = 'option1') {
  return ['option1','none'].includes(value) ? value : fallback;
}

function normalizeShopeeProductType(value, variations) {
  if (['single','one','two'].includes(value)) return value;
  return (variations || []).some(variation => String(variation?.option2 || '').trim()) ? 'two' : 'one';
}

function normalizeShopeeShippingChannels(value) {
  let channels = value;
  if (typeof channels === 'string') {
    try { channels = JSON.parse(channels); } catch (_) { channels = []; }
  }
  const allowed = new Set(['5000','5001','5004','5012','5115','50039','50052']);
  return [...new Set((Array.isArray(channels) ? channels : []).map(String).filter(channel => allowed.has(channel)))];
}

function shopeeVariationGroupKey(value) {
  return String(value || '').trim().toLocaleLowerCase('vi');
}

function getShopeeVariationGroups(variations, imageMode) {
  const groups = [];
  const byKey = new Map();
  for (const variation of (variations || [])) {
    const key = shopeeVariationGroupKey(variation.option1);
    let group = byKey.get(key);
    if (!group) {
      group = { key, name: variation.option1 || '', option2: '', image: variation.image_per_variation || '', variations: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    if (!group.image && variation.image_per_variation) group.image = variation.image_per_variation;
    group.variations.push(variation);
  }
  return groups;
}

function normalizeJstProductType(value, variations) {
  if (['single','one','two'].includes(value)) return value;
  if ((variations || []).some(variation => String(variation?.tier2_value || '').trim())) return 'two';
  return 'one';
}

function normalizeJstVariationImageMode(value, productType) {
  if (productType === 'single') return 'none';
  return value === 'none' ? 'none' : 'option1';
}

function getJstVariationGroups(variations) {
  const groups = [];
  const byKey = new Map();
  for (const variation of (variations || [])) {
    const key = shopeeVariationGroupKey(variation.tier1_value);
    let group = byKey.get(key);
    if (!group) {
      group = { key, name: variation.tier1_value || '', image: variation.sku_image || '', description: variation.description || '', variations: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    if (!group.image && variation.sku_image) group.image = variation.sku_image;
    if (!group.description && variation.description) group.description = variation.description;
    group.variations.push(variation);
  }
  return groups;
}

async function resetGeneratedTaskArtifacts(env, taskId, platform) {
  const prefix = platform === 'shopee' ? 'ews_shopee' : 'ews_jst';
  await env.DB.prepare("DELETE FROM ews_callback_queue WHERE task_id=?").bind(taskId).run().catch(() => {});
  await env.DB.prepare("DELETE FROM ews_image_queue WHERE task_id=?").bind(taskId).run().catch(() => {});
  await env.DB.prepare(`DELETE FROM ${prefix}_push_plans WHERE task_id=?`).bind(taskId).run();
  await env.DB.prepare(`DELETE FROM ${prefix}_task_images WHERE parent_task_id=?`).bind(taskId).run();
  if (platform === 'jst') await env.DB.prepare("DELETE FROM ews_jst_sku_titles WHERE sub_task_id IN (SELECT id FROM ews_jst_sub_tasks WHERE parent_task_id=?)").bind(taskId).run();
  await env.DB.prepare(`DELETE FROM ${prefix}_sub_tasks WHERE parent_task_id=?`).bind(taskId).run();
}

async function getTaskSummaryRows(env, sqlPrefix, ids, sqlSuffix = '') {
  const rows = [];
  for (let i = 0; i < ids.length; i += 80) {
    const part = ids.slice(i, i + 80);
    if (!part.length) continue;
    const ph = part.map(() => '?').join(',');
    const result = await query(env, `${sqlPrefix} (${ph})${sqlSuffix}`, part);
    rows.push(...(result?.results || []));
  }
  return rows;
}

async function handleGetTasks(env, ctx, auth, url) {
  const platform = ['jst','shopee'].includes(url.searchParams.get('platform')) ? url.searchParams.get('platform') : '';
  const page = Math.max(parseInt(url.searchParams.get('page')) || 1, 1);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit')) || 50, 1), 100);
  const [result, total] = await Promise.all([
    getTaskList(env, platform, auth.username, auth.role, limit, (page - 1) * limit),
    getTaskCount(env, platform, auth.username, auth.role),
  ]);
  let tasks = result.results || [];
  if (auth.role !== 'admin') tasks = tasks.filter(t => t.user_id === auth.username);

  const jstIds = tasks.filter(t => t.platform === 'jst').map(t => t.id);
  const shopeeIds = tasks.filter(t => t.platform === 'shopee').map(t => t.id);
  const [jstRows, shopeeRows, jstPlanRows, shopeePlanRows] = await Promise.all([
    getTaskSummaryRows(env, 'SELECT id, name, mode FROM ews_jst_tasks WHERE id IN', jstIds),
    getTaskSummaryRows(env, 'SELECT task_id, name FROM ews_shopee_products WHERE task_id IN', shopeeIds),
    getTaskSummaryRows(env, 'SELECT task_id, COUNT(*) as cnt FROM ews_jst_push_plans WHERE task_id IN', jstIds, ' GROUP BY task_id'),
    getTaskSummaryRows(env, 'SELECT task_id, COUNT(*) as cnt FROM ews_shopee_push_plans WHERE task_id IN', shopeeIds, ' GROUP BY task_id'),
  ]);
  const jstMap = new Map(jstRows.map(row => [row.id, row]));
  const shopeeMap = new Map(shopeeRows.map(row => [row.task_id, row]));
  const planCountMap = new Map([...jstPlanRows, ...shopeePlanRows].map(row => [row.task_id, row.cnt || 0]));

  for (const t of tasks) {
    t.plan_count = planCountMap.get(t.id) || 0;
    if (t.platform === 'jst') {
      const jst = jstMap.get(t.id);
      if (jst) { t.name = jst.name; t._mode = jst.mode; }
    } else if (t.platform === 'shopee') {
      const sp = shopeeMap.get(t.id);
      if (sp) t.name = sp.name;
    }
  }
  ctx.waitUntil(runQueueStage('task list fallback release', () => releasePendingPushPlans(env, ctx)));
  return json({ success: true, tasks, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) });
}

async function handleInitTask(request, env) {
  const body = await parseBody(request);
  const platform = body?.platform || 'jst';
  if (!['jst','shopee'].includes(platform)) return error('不支持的平台', 400);
  if (!canUsePlatform(request.auth, platform)) return error('当前用户无权创建该平台任务', 403);
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
    const { name, source_brief, product_type, main_description, reference_title, reference_image, auxiliary_images, generate_count, mode, category_id, cover_image, images, weight_kg, length_cm, width_cm, height_cm, gtin, variation_name1, variation_name2, variation_image_mode, max_purchase_qty, max_purchase_start_date, max_purchase_period_days, max_purchase_end_date, size_chart_template_id, size_chart_image, pre_order_dts, shipping_channels, variations } = body || {};
    if (!name) return error('商品名称不能为空', 400);
    if (!reference_image) return error('核心参考图不能为空', 400);
    const sourceBrief = String(source_brief || '').trim();
    if (sourceBrief.length < 10 || sourceBrief.length > 2000) return error('商品事实必须为10~2000字符', 400);
    const shopeeGenerateCount = parseInt(generate_count);
    if (!Number.isInteger(shopeeGenerateCount) || shopeeGenerateCount < 1 || shopeeGenerateCount > MAX_GENERATE_COUNT) return error(`生成套数必须为1~${MAX_GENERATE_COUNT}`, 400);
    if (!Array.isArray(variations) || variations.length < 1 || variations.length > MAX_SHOPEE_VARIATIONS) return error(`Shopee变体数量必须为1~${MAX_SHOPEE_VARIATIONS}`, 400);
    if (!['single','one','two'].includes(product_type)) return error('商品规格结构必须为single、one或two', 400);
    const productType = product_type;
    if (productType === 'single' && variations.length !== 1) return error('无规格商品只能有一条价格记录', 400);
    const variationName1 = String(variation_name1 || '').trim();
    const variationName2 = String(variation_name2 || '').trim();
    if (productType !== 'single' && (!variationName1 || variationName1.length > 14)) return error('一级规格名必须为1~14字符', 400);
    const variationImageMode = normalizeShopeeVariationImageMode(variation_image_mode, 'option1');
    const normalizedVariations = [];
    const combinationKeys = new Set();
    let lowestPrice = Infinity;
    let highestPrice = 0;
    for (let i = 0; i < variations.length; i++) {
      const v = variations[i];
      const pricing = normalizeVariantPricing(v, true);
      if (pricing.error) return error('变体#' + (i + 1) + pricing.error, 400);
      const stock = v.stock === undefined || v.stock === null || v.stock === '' ? 999 : Number(v.stock);
      if (!Number.isInteger(stock) || stock < 0 || stock > 10000000) return error(`变体#${i + 1}库存必须为0~10000000`, 400);
      const option1 = productType === 'single' ? '' : String(v.option1 || '').trim();
      const option2 = productType === 'single' ? '' : String(v.option2 || '').trim();
      if (productType !== 'single' && (!option1 || option1.length > 20)) return error(`变体#${i + 1}一级规格值必须为1~20字符`, 400);
      if (option2.length > 20) return error(`变体#${i + 1}二级规格值不能超过20字符`, 400);
      const combinationKey = `${shopeeVariationGroupKey(option1)}|${shopeeVariationGroupKey(option2)}`;
      if (combinationKeys.has(combinationKey)) return error(`变体#${i + 1}规格组合重复`, 400);
      combinationKeys.add(combinationKey);
      const priceLow = pricing.price_float_enabled ? pricing.price_min : pricing.price;
      const priceHigh = pricing.price_float_enabled ? pricing.price_max : pricing.price;
      if (priceLow < 1000 || priceHigh > 120000000) return error(`变体#${i + 1}价格必须为1000~120000000`, 400);
      lowestPrice = Math.min(lowestPrice, priceLow);
      highestPrice = Math.max(highestPrice, priceHigh);
      normalizedVariations.push({
        id: v.id || uuid(), product_id: taskId, integration_no: v.integration_no || taskId.slice(0,8),
        option1, option1_export: '', image_per_variation: productType === 'single' ? '' : v.image_per_variation || '',
        option2, option2_export: '', image_2: '',
        price: pricing.price, price_float_enabled: pricing.price_float_enabled,
        price_min: pricing.price_min, price_max: pricing.price_max, price_precision: pricing.price_precision,
        stock, sku: v.sku || '',
      });
    }
    if (highestPrice / lowestPrice > 5) return error('最高SKU价格除以最低SKU价格不能超过5', 400);
    const hasTier2 = normalizedVariations.some(variation => variation.option2);
    if (productType === 'one' && hasTier2) return error('一维规格不能填写二级规格值', 400);
    if (productType === 'one' && normalizedVariations.length > 20) return error('一维规格最多20个规格值', 400);
    if (productType === 'two' && (!variationName2 || variationName2.length > 14)) return error('二维规格的二级规格名必须为1~14字符', 400);
    if (productType === 'two' && normalizedVariations.some(variation => !variation.option2)) return error('二维规格下每个SKU组合都必须填写二级规格值', 400);
    const normalizedImageMode = productType === 'single' ? 'none' : variationImageMode;
    const variationGroups = getShopeeVariationGroups(normalizedVariations, normalizedImageMode);
    if (normalizedImageMode === 'option1') {
      for (const group of variationGroups) {
        const imageUrls = [...new Set(group.variations.map(variation => variation.image_per_variation).filter(Boolean))];
        if (imageUrls.length !== 1) return error(`一级规格值“${group.name}”必须且只能使用一张SKU参考图`, 400);
        for (const variation of group.variations) variation.image_per_variation = imageUrls[0];
      }
    }
    const weightKg = parseFloat(weight_kg);
    if (!Number.isFinite(weightKg) || weightKg <= 0 || weightKg * 1000 > 100000000) return error('重量必须大于0且导出后不超过100000000g', 400);
    const dimensions = [length_cm, width_cm, height_cm].map(parseNumberOrNull);
    const dimensionCount = dimensions.filter(value => value !== null).length;
    if (dimensionCount !== 0 && dimensionCount !== 3) return error('长、宽、高必须同时填写或全部留空', 400);
    if (dimensions.some(value => value !== null && (value <= 0 || value > 10000000))) return error('长、宽、高必须大于0且不超过10000000', 400);
    const channels = normalizeShopeeShippingChannels(shipping_channels);
    if (!channels.length) return error('至少选择一个物流渠道', 400);
    const channelPriceLimits = { '5000': 10000000, '5001': 100000000, '5004': 100000000, '5115': 5000000 };
    for (const channel of channels) {
      if (channelPriceLimits[channel] && highestPrice > channelPriceLimits[channel]) return error(`物流渠道${channel}允许的最高价格为${channelPriceLimits[channel]}`, 400);
    }
    const maxPurchaseQty = max_purchase_qty === undefined || max_purchase_qty === null || max_purchase_qty === '' ? null : parseInt(max_purchase_qty);
    if (maxPurchaseQty !== null && (!Number.isInteger(maxPurchaseQty) || maxPurchaseQty < 1 || maxPurchaseQty > 999999)) return error('限购数量必须为1~999999', 400);
    const purchaseStart = String(max_purchase_start_date || '').trim();
    const purchaseEnd = String(max_purchase_end_date || '').trim();
    const purchasePeriod = max_purchase_period_days === undefined || max_purchase_period_days === null || max_purchase_period_days === '' ? null : parseInt(max_purchase_period_days);
    const hasPurchasePeriod = purchaseStart || purchaseEnd || purchasePeriod !== null;
    if (hasPurchasePeriod && (maxPurchaseQty === null || !/^\d{4}-\d{2}-\d{2}$/.test(purchaseStart) || !/^\d{4}-\d{2}-\d{2}$/.test(purchaseEnd) || !Number.isInteger(purchasePeriod) || purchasePeriod < 1 || purchasePeriod > 365)) return error('周期限购必须同时填写数量、开始日期、1~365天周期和结束日期', 400);
    if (hasPurchasePeriod && purchaseEnd < purchaseStart) return error('周期限购结束日期不能早于开始日期', 400);
    const sizeChartTemplate = String(size_chart_template_id || '').trim();
    const sizeChartImage = String(size_chart_image || '').trim();
    if (sizeChartTemplate && sizeChartImage) return error('尺码表模板和尺码表图片只能填写一个', 400);
    const preOrderDts = pre_order_dts === undefined || pre_order_dts === null || pre_order_dts === '' ? null : parseInt(pre_order_dts);
    if (preOrderDts !== null && (!Number.isInteger(preOrderDts) || preOrderDts < 5 || preOrderDts > 30)) return error('预售DTS必须为5~30天', 400);
    await env.DB.prepare("UPDATE ews_tasks SET name=?, status='pending', updated_at=datetime('now') WHERE id=?").bind(String(name).slice(0,30), taskId).run();
    await shopeeCreateProduct(env, {
      id: taskId, task_id: taskId, name, category_id: category_id || '',
      source_brief: sourceBrief, product_type: productType,
      main_description: main_description || '',
      reference_title: reference_title || name || '',
      reference_image: reference_image || '', auxiliary_images: auxiliary_images || '[]',
      generate_count: shopeeGenerateCount,
      mode: mode === 'dedup' ? 'dedup' : 'full',
      main_image_count: 9, detail_image_count: 0,
      cover_image: cover_image || '', images: images || '[]',
      weight_kg: weightKg, length_cm: dimensions[0], width_cm: dimensions[1], height_cm: dimensions[2], gtin: gtin || '',
      variation_name1: productType === 'single' ? '' : variationName1, variation_name2: productType === 'two' ? variationName2 : '',
      variation_name1_export: '', variation_name2_export: '', variation_image_mode: normalizedImageMode,
      max_purchase_qty: maxPurchaseQty, max_purchase_start_date: purchaseStart, max_purchase_period_days: purchasePeriod, max_purchase_end_date: purchaseEnd,
      size_chart_template_id: sizeChartTemplate, size_chart_image: sizeChartImage, pre_order_dts: preOrderDts,
      shipping_channels: JSON.stringify(channels),
    });
    await shopeeReplaceVariations(env, taskId, normalizedVariations);
    return json({ success: true, task_id: taskId, message: '商品创建成功' });
  }

  if (idx.platform === 'jst') {
    const { name, topic_items, description, recommended_copy, product_link, supplier_name, main_description, detail_description, auxiliary_images, reference_image, generate_count, stock, weight, product_type, variation_image_mode, variants, mode, main_image_count, detail_image_count } = body || {};
    if (!name) return error('任务名称不能为空', 400);
    if (!reference_image) return error('核心参考图不能为空', 400);
    const topicItems = String(topic_items || '').trim();
    if (!topicItems || topicItems.length > 1000) return error('参考标题或关键词必须为1~1000字符', 400);
    const productDescription = String(description || '').trim();
    if (productDescription.length > 3000) return error('商品描述不能超过3000字符', 400);
    const recommendedCopy = String(recommended_copy || '').trim();
    if (recommendedCopy.length > 1000) return error('推荐文案不能超过1000字符', 400);
    const productLink = String(product_link || '').trim();
    if (productLink && !/^https?:\/\//i.test(productLink)) return error('宝贝链接必须为HTTP或HTTPS地址', 400);
    const supplierName = String(supplier_name || '').trim();
    if (supplierName.length > 100) return error('供应商名不能超过100字符', 400);
    const jstGenerateCount = parseInt(generate_count);
    if (!Number.isInteger(jstGenerateCount) || jstGenerateCount < 1 || jstGenerateCount > MAX_GENERATE_COUNT) return error(`生成套数必须为1~${MAX_GENERATE_COUNT}`, 400);
    if (!Array.isArray(variants) || variants.length < 1 || variants.length > MAX_JST_VARIATIONS) return error(`聚水潭SKU组合数量必须为1~${MAX_JST_VARIATIONS}`, 400);
    if (!['single','one','two'].includes(product_type)) return error('商品规格结构必须为single、one或two', 400);
    const productType = product_type;
    if (productType === 'single' && variants.length !== 1) return error('无规格商品只能有一条SKU记录', 400);
    const defaultStock = stock === undefined || stock === null || stock === '' ? 999 : Number(stock);
    if (!Number.isInteger(defaultStock) || defaultStock < 0 || defaultStock > 99999999) return error('默认库存必须为0~99999999', 400);
    const taskWeight = Number(weight);
    if (!Number.isFinite(taskWeight) || taskWeight < 0) return error('重量必须为大于等于0的数字', 400);
    const normalizedVariants = [];
    const combinationKeys = new Set();
    const skuCodes = new Set();
    for (let i = 0; i < variants.length; i++) {
      const v = variants[i];
      const pricing = normalizeVariantPricing(v, false);
      if (pricing.error) return error('变体#' + (i + 1) + pricing.error, 400);
      if (!pricing.price_float_enabled && v.price !== undefined && v.price !== null && v.price !== '' && pricing.price === null) return error(`变体#${i + 1}基本售价必须为数字`, 400);
      if ([pricing.price,pricing.price_min,pricing.price_max].some(value => value !== null && value < 0)) return error(`变体#${i + 1}基本售价不能小于0`, 400);
      const tier1Name = productType === 'single' ? '' : String(v.tier1_name || '颜色').trim();
      const tier1Value = productType === 'single' ? '' : String(v.tier1_value || v.name || '').trim();
      const tier2Name = productType === 'two' ? String(v.tier2_name || '规格').trim() : '';
      const tier2Value = productType === 'two' ? String(v.tier2_value || '').trim() : '';
      if (productType !== 'single' && (!tier1Name || tier1Name.length > 100)) return error(`变体#${i + 1}一级规格名必须为1~100字符`, 400);
      if (productType !== 'single' && (!tier1Value || tier1Value.length > 100)) return error(`变体#${i + 1}一级规格值必须为1~100字符`, 400);
      if (productType === 'two' && (!tier2Name || tier2Name.length > 100)) return error(`变体#${i + 1}二级规格名必须为1~100字符`, 400);
      if (productType === 'two' && (!tier2Value || tier2Value.length > 100)) return error(`变体#${i + 1}二级规格值必须为1~100字符`, 400);
      const combinationKey = `${shopeeVariationGroupKey(tier1Value)}|${shopeeVariationGroupKey(tier2Value)}`;
      if (combinationKeys.has(combinationKey)) return error(`变体#${i + 1}规格组合重复`, 400);
      combinationKeys.add(combinationKey);
      const variantStock = v.stock === undefined || v.stock === null || v.stock === '' ? defaultStock : Number(v.stock);
      if (!Number.isInteger(variantStock) || variantStock < 0 || variantStock > 99999999) return error(`变体#${i + 1}库存必须为0~99999999`, 400);
      const marketPrice = parseNumberOrNull(v.market_price);
      const minDistributionPrice = parseNumberOrNull(v.min_distribution_price);
      const maxDistributionPrice = parseNumberOrNull(v.max_distribution_price);
      for (const [raw,label,parsed] of [[v.market_price,'市场价',marketPrice],[v.min_distribution_price,'最低分销控价',minDistributionPrice],[v.max_distribution_price,'最高分销控价',maxDistributionPrice]]) {
        if (raw !== undefined && raw !== null && raw !== '' && parsed === null) return error(`变体#${i + 1}${label}必须为数字`, 400);
      }
      if ([marketPrice,minDistributionPrice,maxDistributionPrice].some(value => value !== null && value < 0)) return error(`变体#${i + 1}模板价格不能小于0`, 400);
      if (minDistributionPrice !== null && maxDistributionPrice !== null && maxDistributionPrice < minDistributionPrice) return error(`变体#${i + 1}最高分销控价不能低于最低分销控价`, 400);
      const skuCode = String(v.sku_code || v.sku || '').trim();
      if (skuCode.length > 80) return error(`变体#${i + 1}商家SKU不能超过80字符`, 400);
      if (skuCode && skuCodes.has(skuCode.toLocaleLowerCase())) return error(`变体#${i + 1}商家SKU重复`, 400);
      if (skuCode) skuCodes.add(skuCode.toLocaleLowerCase());
      normalizedVariants.push({
        id: v.id || uuid(), task_id: taskId,
        tier1_name: tier1Name, tier1_value: tier1Value,
        tier2_name: tier2Name, tier2_value: tier2Value,
        sku_image: productType === 'single' ? '' : String(v.sku_image || ''),
        price: pricing.price, price_float_enabled: pricing.price_float_enabled,
        price_min: pricing.price_min, price_max: pricing.price_max, price_precision: pricing.price_precision,
        market_price: marketPrice, min_distribution_price: minDistributionPrice, max_distribution_price: maxDistributionPrice,
        stock: variantStock, sku_code: skuCode,
        description: String(v.sku_description || '').trim(), sort_order: i,
      });
    }
    if (productType !== 'single' && new Set(normalizedVariants.map(variant => variant.tier1_name)).size !== 1) return error('全部SKU必须使用相同的一级规格名', 400);
    if (productType === 'two' && new Set(normalizedVariants.map(variant => variant.tier2_name)).size !== 1) return error('全部SKU必须使用相同的二级规格名', 400);
    const jstImageMode = normalizeJstVariationImageMode(variation_image_mode, productType);
    if (jstImageMode === 'option1') {
      for (const group of getJstVariationGroups(normalizedVariants)) {
        const imageUrls = [...new Set(group.variations.map(variation => variation.sku_image).filter(Boolean))];
        if (imageUrls.length > 1) return error(`一级规格值“${group.name}”只能使用一张SKU参考图`, 400);
        if (imageUrls.length === 1) for (const variation of group.variations) variation.sku_image = imageUrls[0];
      }
    } else {
      for (const variation of normalizedVariants) variation.sku_image = '';
    }

    await jstUpdateTask(env, taskId, {
      name: String(name).slice(0, 30), topic_items: topicItems, description: productDescription,
      recommended_copy: recommendedCopy, product_link: productLink, supplier_name: supplierName,
      main_description: main_description || '', detail_description: detail_description || '',
      auxiliary_images: auxiliary_images || '', reference_image,
      generate_count: jstGenerateCount, stock: defaultStock, weight: taskWeight,
      variant_count: normalizedVariants.length,
      main_image_count: Math.min(Math.max(parseInt(main_image_count) || 5, 1), 9),
      detail_image_count: Math.min(Math.max(parseInt(detail_image_count) || 5, 1), 9),
      product_type: productType, variation_image_mode: jstImageMode,
      mode: mode === 'dedup' ? 'dedup' : 'full',
    });
    // 更新索引
    await env.DB.prepare("UPDATE ews_tasks SET name = ?, status = 'pending', updated_at = datetime('now') WHERE id = ?")
      .bind(String(name).slice(0, 30), taskId).run();

    // 变体（二维规格）
    await jstReplaceVariants(env, taskId, normalizedVariants);
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
  if (!['pending','processing','completed','failed','partial_failed'].includes(status)) return error('无效的状态值', 400);
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
  const taskOwner = await getOne(env, "SELECT user_id FROM ews_tasks WHERE id=?", [taskId]);
  const pushUser = await getUserByUsername(env, taskOwner?.user_id || request.auth?.username || '');
  applyUserWorkflowOverrides(config, pushUser?.webhook_config, 'jst');
  const workflowFlags = workflowExecutionFlags(config);
  const callbackSecret = config.callback_secret || '';
  const baseUrl = `${new URL(request.url).origin}/api/callback`;
  const titleWebhookUrl = workflowFlags.title ? config.n8n_title_webhook || '' : '';
  const skuTitleWebhookUrl = workflowFlags.skuTitle ? config.n8n_sku_title_webhook || '' : '';
  const skuImageWebhookUrl = workflowFlags.skuImage ? config.n8n_sku_image_webhook || '' : '';
  const mainWebhookUrl = config.n8n_main_webhook || '';
  const subImageWebhookUrl = config.n8n_sub_image_webhook || '';
  const detailWebhookUrl = workflowFlags.detail ? config.n8n_detail_webhook || '' : '';
  const mainImageCount = Math.min(Math.max(detail.main_image_count || 5, 1), 9);
  const detailImageCount = Math.min(Math.max(detail.detail_image_count || 5, 1), 9);
  const generateCount = detail.generate_count || 1;
  const productType = normalizeJstProductType(detail.product_type, detail.variants || []);
  const variationImageMode = normalizeJstVariationImageMode(detail.variation_image_mode, productType);
  const variantCount = detail.variants?.length || 0;
  const variationGroups = productType === 'single' ? [] : getJstVariationGroups(detail.variants || []);
  const skuImageGroups = variationImageMode === 'none' ? [] : variationGroups;
  const needsSkuTitles = productType !== 'single' && variantCount > 0;

  const missingEnabledWebhooks = [];
  if (workflowFlags.title && !titleWebhookUrl) missingEnabledWebhooks.push('商品标题');
  if (workflowFlags.skuTitle && needsSkuTitles && !skuTitleWebhookUrl) missingEnabledWebhooks.push('SKU标题');
  if (workflowFlags.skuImage && skuImageGroups.length > 0 && !skuImageWebhookUrl) missingEnabledWebhooks.push('SKU图片');
  if (missingEnabledWebhooks.length) return error('请先配置已开启的 JST 工作流 Webhook: ' + missingEnabledWebhooks.join('、'), 400);
  if (!titleWebhookUrl && !skuTitleWebhookUrl && !mainWebhookUrl && !subImageWebhookUrl && !detailWebhookUrl && !skuImageWebhookUrl)
    return error('请先在系统配置页配置 JST 工作流 Webhook 地址后再推送', 400);

  await resetGeneratedTaskArtifacts(env, taskId, 'jst');

  const subTaskIds = [];
  for (let i = 0; i < generateCount; i++) {
    const subId = uuid(); subTaskIds.push(subId);
    await jstCreateSubTask(env, { id: subId, parent_task_id: taskId, set_index: i });
    await jstCreateExpectedImages(env, taskId, subId, i, skuImageGroups.length, detail.mode || 'full', mainImageCount, detailImageCount,
      !!mainWebhookUrl, !!subImageWebhookUrl, !!detailWebhookUrl, !!skuImageWebhookUrl);
  }
  await env.DB.prepare("UPDATE ews_jst_tasks SET status='processing', queue_mode='auto', updated_at=datetime('now') WHERE id=?").bind(taskId).run();
  const subTasks = subTaskIds.map((id, i) => ({ sub_task_id: id, set_index: i, style_code: id.slice(0, 8) }));
  const allJobs = [];

  // title
  if (titleWebhookUrl) allJobs.push({ webhook_type: 'title', sub_task_id: subTasks[0]?.sub_task_id || "", url: titleWebhookUrl,
    data: { task_id: taskId, name: detail.name, reference_title: detail.topic_items || '', description: detail.description || '',
      sub_task_count: generateCount, sub_tasks: subTasks, callback_secret: callbackSecret, callback_url: baseUrl } });
  // sku_title
  if (skuTitleWebhookUrl && needsSkuTitles) allJobs.push({ webhook_type: 'sku_title', sub_task_id: subTasks[0]?.sub_task_id || "", url: skuTitleWebhookUrl,
    data: { task_id: taskId, name: detail.name, reference_title: detail.topic_items || '', description: detail.description || '',
      sub_task_count: generateCount, sub_tasks: subTasks, product_type: productType,
      variants: (detail.variants||[]).map(v=>({id:v.id,name:v.tier1_value,option2:v.tier2_value||'',tier1_name:v.tier1_name||'',tier2_name:v.tier2_name||'',sku_description:v.description||''})), callback_secret: callbackSecret, callback_url: baseUrl } });
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
  if (skuImageWebhookUrl && skuImageGroups.length > 0) for (const st of subTasks) {
    if ((detail.mode||'full') === 'dedup' && st.set_index > 0) continue;
    for (let v = 0; v < skuImageGroups.length; v++) {
      const group = skuImageGroups[v];
      allJobs.push({ webhook_type: 'sku_' + (v+1), sub_task_id: st.sub_task_id, url: skuImageWebhookUrl,
        data: { task_id: taskId, sub_task_id: st.sub_task_id, set_index: st.set_index, reference_image: detail.reference_image,
          variant_name: group.name, sku_image: group.image || '',
          sku_description: group.description || '', image_type: 'sku', image_position: v+1, callback_secret: callbackSecret, callback_url: baseUrl } });
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
  const taskOwner = await getOne(env, "SELECT user_id FROM ews_tasks WHERE id=?", [taskId]);
  const pushUser = await getUserByUsername(env, taskOwner?.user_id || request.auth?.username || '');
  applyUserWorkflowOverrides(config, pushUser?.webhook_config, 'shopee');
  const workflowFlags = workflowExecutionFlags(config);
  const detail = await shopeeGetProduct(env, taskId);
  if (!detail) return error('商品不存在', 404);
  if (detail.status !== 'pending') return error('只能推送等待中的任务', 400);
  const productType = normalizeShopeeProductType(detail.product_type, detail.variations || []);
  const variationImageMode = normalizeShopeeVariationImageMode(detail.variation_image_mode, 'option1');
  const variantCombos = productType === 'single' ? [] : detail.variations || [];
  const variationGroups = getShopeeVariationGroups(variantCombos, variationImageMode);
  const skuImageGroups = variationImageMode === 'none' ? [] : variationGroups;
  const titleWebhookUrl = workflowFlags.title ? config.n8n_title_webhook || '' : '';
  const skuImageWebhookUrl = workflowFlags.skuImage ? config.n8n_sku_image_webhook || '' : '';
  const mainWebhookUrl = config.n8n_main_webhook || '';
  const subImageWebhookUrl = config.n8n_sub_image_webhook || '';
  const requiredShopeeWebhooks = [
    [mainWebhookUrl, '封面图'],
    [subImageWebhookUrl, '附图'],
  ];
  if (workflowFlags.title) requiredShopeeWebhooks.push([titleWebhookUrl, '商品元数据']);
  if (workflowFlags.skuImage && skuImageGroups.length > 0) requiredShopeeWebhooks.push([skuImageWebhookUrl, 'SKU变体图']);
  const missingShopeeWebhooks = requiredShopeeWebhooks.filter(([url]) => !url).map(([, label]) => label);
  if (missingShopeeWebhooks.length)
    return error('请先在系统配置页配置 Shopee 必需工作流 Webhook: ' + missingShopeeWebhooks.join('、'), 400);

  await resetGeneratedTaskArtifacts(env, taskId, 'shopee');

  const callbackSecret = config.callback_secret || '';
  const baseUrl = new URL(request.url).origin + '/api/callback';
  const mainCount = 9;
  const refImg = detail.reference_image || '';
  const auxImgs = detail.auxiliary_images || '';
  const generateCount = detail.generate_count || 1;
  const mode = detail.mode || 'full';

  // 创建子任务（每个子任务是一套 AI 生成后的 Shopee 商品资源）
  const subTaskIds = [];
  for (let i = 0; i < generateCount; i++) {
    const subId = uuid(); subTaskIds.push(subId);
    await shopeeCreateSubTask(env, { id: subId, parent_task_id: taskId, set_index: i });
    const dedupShared = mode === 'dedup' && i > 0;
    const expectedSubCount = (!dedupShared && subImageWebhookUrl) ? mainCount : 0;
    const skuImageCount = (!dedupShared && skuImageWebhookUrl) ? skuImageGroups.length : 0;
    await shopeeCreateExpectedImages(env, taskId, subId, i, expectedSubCount, 0, skuImageCount, !!mainWebhookUrl, !!subImageWebhookUrl && !dedupShared);
  }
  await updateTaskIndexStatus(env, taskId, 'processing');
  await env.DB.prepare("UPDATE ews_shopee_products SET status='processing', updated_at=datetime('now') WHERE id=?").bind(taskId).run();

  const subTasks = subTaskIds.map((id, i) => ({ sub_task_id: id, set_index: i }));
  const allJobs = [];

  // 商品元数据
  if (titleWebhookUrl) allJobs.push({ webhook_type: 'title', sub_task_id: subTasks[0]?.sub_task_id || '', url: titleWebhookUrl,
    data: { task_id: taskId, name: detail.name, source_brief: detail.source_brief || '', reference_title: detail.reference_title || '',
      reference_image: refImg, auxiliary_images: auxImgs, sub_task_count: generateCount, sub_tasks: subTasks,
      product_type: productType, variation_name1: detail.variation_name1 || '', variation_name2: detail.variation_name2 || '',
      variants: variantCombos.map(variant => ({ id: variant.id, option1: variant.option1 || '', option2: variant.option2 || '' })),
      callback_secret: callbackSecret, callback_url: baseUrl } });
  // main_1
  if (mainWebhookUrl) for (const st of subTasks) allJobs.push({ webhook_type: 'main_1', sub_task_id: st.sub_task_id, url: mainWebhookUrl,
    data: { task_id: taskId, sub_task_id: st.sub_task_id, set_index: st.set_index, reference_image: refImg,
      main_description: detail.main_description || detail.source_brief || '', auxiliary_images: auxImgs,
      image_type: 'main', image_position: 1, callback_secret: callbackSecret, callback_url: baseUrl } });
  // sub_2~N
  if (subImageWebhookUrl) for (let p = 2; p <= mainCount; p++) for (const st of subTasks) {
    if (mode === 'dedup' && st.set_index > 0) continue;
    allJobs.push({ webhook_type: 'sub_' + p, sub_task_id: st.sub_task_id, url: subImageWebhookUrl,
      data: { task_id: taskId, sub_task_id: st.sub_task_id, set_index: st.set_index, reference_image: refImg,
        main_description: detail.main_description || detail.source_brief || '', auxiliary_images: auxImgs,
        image_type: 'sub', image_position: p, callback_secret: callbackSecret, callback_url: baseUrl } });
  }
  // sku_1~V（按一级规格出图，二维规格复用一级规格图）
  if (skuImageWebhookUrl && skuImageGroups.length > 0) for (const st of subTasks) {
    if (mode === 'dedup' && st.set_index > 0) continue;
    for (let vi = 0; vi < skuImageGroups.length; vi++) {
      const group = skuImageGroups[vi];
      allJobs.push({ webhook_type: 'sku_' + (vi+1), sub_task_id: st.sub_task_id, url: skuImageWebhookUrl,
        data: { task_id: taskId, sub_task_id: st.sub_task_id, set_index: st.set_index, reference_image: refImg,
          variant_name: group.name,
          variant_option2: group.option2 || '',
          sku_image: group.image,
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

function workflowPlanWhereClause(flags, alias = '') {
  const column = alias ? `${alias}.webhook_type` : 'webhook_type';
  if (flags.primaryImagesOnly) return ` AND (${column}='main' OR ${column}='main_1' OR ${column} LIKE 'sub_%')`;
  const conditions = [];
  if (!flags.title) conditions.push(`${column}<>'title'`);
  if (!flags.skuTitle) conditions.push(`${column}<>'sku_title'`);
  if (!flags.skuImage) conditions.push(`${column} NOT GLOB 'sku_[0-9]*'`);
  return conditions.length ? ` AND ${conditions.join(' AND ')}` : '';
}

async function getPendingPlansForRelease(env, planTable, taskId, limit, flags) {
  const safeTable = normalizePushPlanTable(planTable);
  const workflowWhere = workflowPlanWhereClause(flags);
  return await query(env, `SELECT * FROM ${safeTable} WHERE task_id = ? AND status='pending'${workflowWhere} ORDER BY batch_order ASC LIMIT ?`, [taskId, limit]);
}

async function shopeeReleaseTaskQueue(env, taskId, ctx) {
  try {
    await ensurePushPlanRuntimeColumns(env);
    const config = await getConfig(env, 'shopee');
    const taskOwner = await getOne(env, "SELECT user_id FROM ews_tasks WHERE id=?", [taskId]);
    const workflowUser = taskOwner?.user_id ? await getUserByUsername(env, taskOwner.user_id) : null;
    applyUserWorkflowOverrides(config, workflowUser?.webhook_config, 'shopee');
    const workflowFlags = workflowExecutionFlags(config);
    const batchSize = parseInt(config.push_batch_size) || 20;
    const release = await getPushReleaseWindow(env, 'ews_shopee_push_plans', taskId, batchSize);
    if (release.limit <= 0) return;
    const pendingPlans = await getPendingPlansForRelease(env, 'ews_shopee_push_plans', taskId, release.limit, workflowFlags);
    const plans = pendingPlans?.results || [];
    if (!plans.length) return;
    for (const plan of plans) {
      if (!plan.webhook_url) {
        await markPushPlanFailed(env, 'ews_shopee_push_plans', plan.id, 'Webhook地址未配置');
        continue;
      }
      const claimed = await claimPushPlan(env, 'ews_shopee_push_plans', plan.id, taskId, batchSize, release.globalMax, release.globalReleasePerMinute, release.taskReleasePerMinute);
      if (!claimed) continue;
      if (taskOwner?.user_id) {
        if (!(await consumeUserCredit(env, taskOwner.user_id))) {
          await markPushPlanFailed(env, 'ews_shopee_push_plans', plan.id, '算力不足');
          continue;
        }
      }
      ctx.waitUntil(dispatchPushPlan(env, 'ews_shopee_push_plans', taskId, plan));
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
  await ensurePushPlanRuntimeColumns(env);
  const safeTable = normalizePushPlanTable(planTable);
  const plan = await getOne(env, `SELECT task_id FROM ${safeTable} WHERE id=?`, [planId]);
  const result = await env.DB.prepare(`UPDATE ${safeTable} SET status='failed', retry_count=3, error=?, updated_at=datetime('now') WHERE id=?`)
    .bind(message || '推送失败', planId).run();
  if (d1Changes(result) > 0 && plan?.task_id) await reconcileTaskStatusForPushPlans(env, safeTable, plan.task_id, message || '推送失败');
}

async function refundTaskCredit(env, taskId) {
  const taskOwner = await getOne(env, "SELECT user_id FROM ews_tasks WHERE id=?", [taskId]);
  if (taskOwner?.user_id) await updateUserCredits(env, taskOwner.user_id, 1, 'add');
}

async function completePushPlanFromCallback(env, planTable, taskId, webhookType, subTaskId = '') {
  const safeTable = normalizePushPlanTable(planTable);
  const subTaskClause = subTaskId ? ' AND sub_task_id=?' : '';
  const params = [taskId, webhookType];
  if (subTaskId) params.push(subTaskId);
  const completed = await env.DB.prepare(`UPDATE ${safeTable} SET status='done', error='', updated_at=datetime('now') WHERE task_id=? AND webhook_type=?${subTaskClause} AND status='processing'`).bind(...params).run();
  if (d1Changes(completed) > 0) return true;
  const timedOutPlan = await getOne(env, `SELECT id FROM ${safeTable} WHERE task_id=? AND webhook_type=?${subTaskClause} AND status='failed' AND error LIKE 'Push plan timed out after %'`, params);
  if (!timedOutPlan) return false;
  const taskOwner = await getOne(env, "SELECT user_id FROM ews_tasks WHERE id=?", [taskId]);
  if (taskOwner?.user_id && !(await consumeUserCredit(env, taskOwner.user_id))) return false;
  const recovered = await env.DB.prepare(`UPDATE ${safeTable} SET status='done', error='Late callback accepted', updated_at=datetime('now') WHERE id=? AND status='failed' AND error LIKE 'Push plan timed out after %'`).bind(timedOutPlan.id).run();
  if (d1Changes(recovered) < 1 && taskOwner?.user_id) await updateUserCredits(env, taskOwner.user_id, 1, 'add');
  return d1Changes(recovered) > 0;
}

async function getGlobalPushMaxActive(env) {
  const config = await getConfig(env);
  return parseQueueLimit(config.push_global_max_active, DEFAULT_GLOBAL_PUSH_MAX_ACTIVE, MAX_GLOBAL_PUSH_MAX_ACTIVE);
}

async function getPushReleaseLimits(env) {
  const config = await getConfig(env);
  return {
    globalPerMinute: parseQueueLimit(config.push_release_per_minute, DEFAULT_PUSH_RELEASE_PER_MINUTE, MAX_PUSH_RELEASE_PER_MINUTE),
    taskPerMinute: parseQueueLimit(config.push_release_per_task_per_minute, DEFAULT_PUSH_RELEASE_PER_TASK_PER_MINUTE, MAX_PUSH_RELEASE_PER_TASK_PER_MINUTE),
  };
}

async function getGlobalPushActiveCount(env) {
  await ensurePushPlanRuntimeColumns(env);
  const jst = await getOne(env, "SELECT COUNT(*) as cnt FROM ews_jst_push_plans WHERE status='processing'");
  const shopee = await getOne(env, "SELECT COUNT(*) as cnt FROM ews_shopee_push_plans WHERE status='processing'");
  return (jst?.cnt || 0) + (shopee?.cnt || 0);
}

async function getPushReleaseWindow(env, planTable, taskId, taskBatchSize) {
  await ensurePushPlanRuntimeColumns(env);
  const safeTable = normalizePushPlanTable(planTable);
  const globalMax = await getGlobalPushMaxActive(env);
  const releaseLimits = await getPushReleaseLimits(env);
  const taskActive = await getOne(env, `SELECT COUNT(*) as cnt FROM ${safeTable} WHERE task_id=? AND status='processing'`, [taskId]);
  const globalActive = await getGlobalPushActiveCount(env);
  const globalRecent = await getOne(env, `SELECT
    ((SELECT COUNT(*) FROM ews_jst_push_plans WHERE processing_at >= datetime('now', '-1 minute'))
      + (SELECT COUNT(*) FROM ews_shopee_push_plans WHERE processing_at >= datetime('now', '-1 minute'))) as cnt`);
  const taskRecent = await getOne(env, `SELECT COUNT(*) as cnt FROM ${safeTable} WHERE task_id=? AND processing_at >= datetime('now', '-1 minute')`, [taskId]);
  const activeLimit = Math.min(taskBatchSize - (taskActive?.cnt || 0), globalMax - globalActive);
  const rateLimit = Math.min(releaseLimits.taskPerMinute - (taskRecent?.cnt || 0), releaseLimits.globalPerMinute - (globalRecent?.cnt || 0));
  return {
    globalMax,
    globalReleasePerMinute: releaseLimits.globalPerMinute,
    taskReleasePerMinute: releaseLimits.taskPerMinute,
    limit: Math.max(0, Math.min(activeLimit, rateLimit)),
  };
}

async function claimPushPlan(env, planTable, planId, taskId, taskBatchSize, globalMaxActive, globalReleasePerMinute, taskReleasePerMinute) {
  await ensurePushPlanRuntimeColumns(env);
  const safeTable = normalizePushPlanTable(planTable);
  const claim = await env.DB.prepare(`UPDATE ${safeTable}
    SET status='processing', error='', processing_at=datetime('now'), updated_at=datetime('now')
    WHERE id=? AND task_id=? AND status='pending'
      AND (SELECT COUNT(*) FROM ${safeTable} WHERE task_id=? AND status='processing') < ?
      AND ((SELECT COUNT(*) FROM ews_jst_push_plans WHERE status='processing')
        + (SELECT COUNT(*) FROM ews_shopee_push_plans WHERE status='processing')) < ?
      AND ((SELECT COUNT(*) FROM ews_jst_push_plans WHERE processing_at >= datetime('now', '-1 minute'))
        + (SELECT COUNT(*) FROM ews_shopee_push_plans WHERE processing_at >= datetime('now', '-1 minute'))) < ?
      AND (SELECT COUNT(*) FROM ${safeTable} WHERE task_id=? AND processing_at >= datetime('now', '-1 minute')) < ?`)
    .bind(planId, taskId, taskId, taskBatchSize, globalMaxActive, globalReleasePerMinute, taskId, taskReleasePerMinute).run();
  return d1Changes(claim) > 0;
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
    await ensurePushPlanRuntimeColumns(env);
    const config = await getConfig(env, 'jst');
    const taskOwner = await getOne(env, "SELECT user_id FROM ews_tasks WHERE id=?", [taskId]);
    const workflowUser = taskOwner?.user_id ? await getUserByUsername(env, taskOwner.user_id) : null;
    applyUserWorkflowOverrides(config, workflowUser?.webhook_config, 'jst');
    const workflowFlags = workflowExecutionFlags(config);
    const batchSize = parseInt(config.push_batch_size) || 20;
    const release = await getPushReleaseWindow(env, 'ews_jst_push_plans', taskId, batchSize);
    if (release.limit <= 0) return;
    const pendingPlans = await getPendingPlansForRelease(env, 'ews_jst_push_plans', taskId, release.limit, workflowFlags);
    const plans = pendingPlans?.results || [];
    if (!plans.length) return;
    for (const plan of plans) {
      if (!plan.webhook_url) {
        await markPushPlanFailed(env, 'ews_jst_push_plans', plan.id, 'Webhook地址未配置');
        continue;
      }
      const claimed = await claimPushPlan(env, 'ews_jst_push_plans', plan.id, taskId, batchSize, release.globalMax, release.globalReleasePerMinute, release.taskReleasePerMinute);
      if (!claimed) continue;
      if (taskOwner?.user_id) {
        if (!(await consumeUserCredit(env, taskOwner.user_id))) {
          await markPushPlanFailed(env, 'ews_jst_push_plans', plan.id, '算力不足');
          continue;
        }
      }
      ctx.waitUntil(dispatchPushPlan(env, 'ews_jst_push_plans', taskId, plan));
    }
  } catch (err) { console.error('jstReleaseTaskQueue error:', err.message); }
}

async function runQueueStage(name, action) {
  try {
    return await action();
  } catch (err) {
    console.error(`${name} error:`, err.message);
  }
}

async function releasePendingPushPlans(env, ctx) {
  const releaseLimits = await getPushReleaseLimits(env);
  const candidateLimit = Math.min(Math.max(releaseLimits.globalPerMinute * 20, 100), 500);
  const candidates = await query(env, `SELECT platform, task_id, MIN(created_at) AS oldest FROM (
    SELECT 'jst' AS platform, p.task_id, p.created_at FROM ews_jst_push_plans p
      JOIN ews_jst_tasks t ON t.id=p.task_id
      WHERE p.status='pending' AND t.status IN ('processing','partial_failed')
        AND COALESCE(t.queue_mode, 'auto') != 'manual'
    UNION ALL
    SELECT 'shopee' AS platform, p.task_id, p.created_at FROM ews_shopee_push_plans p
      JOIN ews_tasks t ON t.id=p.task_id
      WHERE p.status='pending' AND t.status IN ('processing','partial_failed')
  ) GROUP BY platform, task_id ORDER BY oldest ASC LIMIT ?`, [candidateLimit]);
  for (const row of (candidates?.results || [])) {
    if (row.platform === 'jst') await jstReleaseTaskQueue(env, row.task_id, ctx);
    else await shopeeReleaseTaskQueue(env, row.task_id, ctx);
  }
}

async function processPendingQueue(env, ctx) {
  const ready = await runQueueStage('push plan runtime setup', () => ensurePushPlanRuntimeColumns(env));
  if (ready === undefined && !pushPlanColumnsReady) return;
  await runQueueStage('stale push plan recovery', () => recoverStalePushPlans(env));
  await runQueueStage('callback queue processing', () => processCallbackQueue(env, ctx));
  await runQueueStage('pending push plan release', () => releasePendingPushPlans(env, ctx));
  await runQueueStage('image queue processing', () => processImageQueue(env, ctx));
  await runQueueStage('push plan status reconciliation', () => reconcileOpenPushPlanTaskStatuses(env));
}

// ========== 回调 ==========

const CALLBACK_QUEUE_BATCH_SIZE = 3;
const CALLBACK_QUEUE_MAX_ACTIVE = 3;
const CALLBACK_QUEUE_MAX_ATTEMPTS = 5;
const DEFAULT_IMAGE_QUEUE_BATCH_SIZE = 6;
const DEFAULT_IMAGE_QUEUE_MAX_ACTIVE = 6;
const MAX_IMAGE_QUEUE_BATCH_SIZE = 20;
const MAX_IMAGE_QUEUE_MAX_ACTIVE = 20;
const IMAGE_QUEUE_MAX_ATTEMPTS = 5;
const DEFAULT_GLOBAL_PUSH_MAX_ACTIVE = 20;
const MAX_GLOBAL_PUSH_MAX_ACTIVE = 200;
const DEFAULT_PUSH_RELEASE_PER_MINUTE = 6;
const MAX_PUSH_RELEASE_PER_MINUTE = 120;
const DEFAULT_PUSH_RELEASE_PER_TASK_PER_MINUTE = 2;
const MAX_PUSH_RELEASE_PER_TASK_PER_MINUTE = 60;
const DEFAULT_PUSH_PLAN_TIMEOUT_MINUTES = 30;
const MAX_PUSH_PLAN_TIMEOUT_MINUTES = 1440;
let callbackQueueReady = false;
let imageQueueReady = false;
let pushPlanColumnsReady = false;

function parseQueueLimit(value, fallback, max) {
  const n = parseInt(value);
  if (Number.isNaN(n) || n < 1) return fallback;
  return Math.min(n, max);
}

function d1Changes(result) {
  const meta = result?.meta || {};
  if (typeof meta.changes === 'number') return meta.changes;
  if (typeof meta.rows_written === 'number') return meta.rows_written;
  if (meta.changed_db === true) return 1;
  if (meta.changed_db === false) return 0;
  return result?.success === true ? 1 : 0;
}

function normalizePushPlanTable(planTable) {
  if (planTable === 'ews_jst_push_plans' || planTable === 'ews_shopee_push_plans') return planTable;
  throw new Error('Invalid push plan table');
}

function pushPlanPlatform(planTable) {
  return normalizePushPlanTable(planTable) === 'ews_jst_push_plans' ? 'jst' : 'shopee';
}

function parsePushPlanTimeoutMinutes(value) {
  const n = parseInt(value);
  if (Number.isNaN(n)) return DEFAULT_PUSH_PLAN_TIMEOUT_MINUTES;
  return Math.min(Math.max(n, 5), MAX_PUSH_PLAN_TIMEOUT_MINUTES);
}

async function getPushPlanTimeoutMinutes(env) {
  const config = await getConfig(env);
  return parsePushPlanTimeoutMinutes(config.push_plan_timeout_minutes);
}

async function getImageQueueLimits(env) {
  const config = await getConfig(env);
  return {
    batchSize: parseQueueLimit(config.image_queue_batch_size, DEFAULT_IMAGE_QUEUE_BATCH_SIZE, MAX_IMAGE_QUEUE_BATCH_SIZE),
    maxActive: parseQueueLimit(config.image_queue_max_active, DEFAULT_IMAGE_QUEUE_MAX_ACTIVE, MAX_IMAGE_QUEUE_MAX_ACTIVE),
  };
}

async function ensurePushPlanRuntimeColumns(env) {
  if (pushPlanColumnsReady) return;
  for (const table of ['ews_jst_push_plans', 'ews_shopee_push_plans']) {
    const indexName = table === 'ews_jst_push_plans' ? 'idx_jst_plans_processing' : 'idx_shopee_plans_processing';
    const dispatchIndexName = table === 'ews_jst_push_plans' ? 'idx_jst_plans_processing_at' : 'idx_shopee_plans_processing_at';
    try { await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN processing_at TEXT NOT NULL DEFAULT ''`).run(); } catch (_) {}
    try { await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`).run(); } catch (_) {}
    try { await env.DB.prepare(`CREATE INDEX IF NOT EXISTS ${indexName} ON ${table}(status, processing_at)`).run(); } catch (_) {}
    try { await env.DB.prepare(`CREATE INDEX IF NOT EXISTS ${dispatchIndexName} ON ${table}(processing_at)`).run(); } catch (_) {}
    await env.DB.prepare(`UPDATE ${table}
      SET processing_at=datetime('now'), updated_at=datetime('now')
      WHERE status='processing' AND (processing_at IS NULL OR processing_at='')`).run();
    await env.DB.prepare(`UPDATE ${table}
      SET updated_at=COALESCE(NULLIF(updated_at, ''), created_at, datetime('now'))
      WHERE updated_at IS NULL OR updated_at=''`).run();
  }
  pushPlanColumnsReady = true;
}

async function failTaskForPushPlan(env, planTable, taskId, message) {
  await reconcileTaskStatusForPushPlans(env, planTable, taskId, message);
}

async function setTaskStatusForPushPlan(env, planTable, taskId, status) {
  const platform = pushPlanPlatform(planTable);
  if (platform === 'jst') {
    await env.DB.prepare("UPDATE ews_jst_tasks SET status=?, updated_at=datetime('now') WHERE id=?").bind(status, taskId).run();
  } else {
    await env.DB.prepare("UPDATE ews_shopee_products SET status=?, updated_at=datetime('now') WHERE id=?").bind(status, taskId).run();
  }
  await updateTaskIndexStatus(env, taskId, status);
}

async function reconcileTaskStatusForPushPlans(env, planTable, taskId, message, options = {}) {
  const safeTable = normalizePushPlanTable(planTable);
  const stats = await getOne(env, `SELECT
    SUM(CASE WHEN status IN ('pending','processing') THEN 1 ELSE 0 END) as active,
    SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed
    FROM ${safeTable} WHERE task_id=?`, [taskId]);
  const active = stats?.active || 0;
  const failed = stats?.failed || 0;
  let nextStatus = '';
  if (failed > 0) nextStatus = active > 0 ? 'partial_failed' : 'failed';
  else if (active > 0 && options.resumeWhenNoFailures) nextStatus = 'processing';
  if (nextStatus) await setTaskStatusForPushPlan(env, safeTable, taskId, nextStatus);
  if (failed > 0 && message) console.error('push plan task has failed plans:', taskId, message);
}

async function reconcileOpenPushPlanTaskStatuses(env) {
  await ensurePushPlanRuntimeColumns(env);
  const jstRows = await query(env, `SELECT DISTINCT task_id FROM ews_jst_push_plans
    WHERE status IN ('failed','pending','processing') LIMIT 100`);
  for (const row of (jstRows?.results || [])) await reconcileTaskStatusForPushPlans(env, 'ews_jst_push_plans', row.task_id);
  const shopeeRows = await query(env, `SELECT DISTINCT task_id FROM ews_shopee_push_plans
    WHERE status IN ('failed','pending','processing') LIMIT 100`);
  for (const row of (shopeeRows?.results || [])) await reconcileTaskStatusForPushPlans(env, 'ews_shopee_push_plans', row.task_id);
}

async function recoverStalePushPlans(env) {
  await ensurePushPlanRuntimeColumns(env);
  const timeoutMinutes = await getPushPlanTimeoutMinutes(env);
  const staleModifier = `-${timeoutMinutes} minutes`;
  for (const table of ['ews_jst_push_plans', 'ews_shopee_push_plans']) {
    const rows = await query(env, `SELECT id, task_id FROM ${table}
      WHERE status='processing' AND processing_at < datetime('now', ?)
      ORDER BY processing_at ASC LIMIT 50`, [staleModifier]);
    for (const row of (rows?.results || [])) {
      const message = `Push plan timed out after ${timeoutMinutes} minutes without callback`;
      const result = await env.DB.prepare(`UPDATE ${table}
        SET status='failed', retry_count=3, error=?, updated_at=datetime('now')
        WHERE id=? AND status='processing' AND processing_at < datetime('now', ?)`)
        .bind(message, row.id, staleModifier).run();
      if (d1Changes(result) > 0) {
        await refundTaskCredit(env, row.task_id);
        await failTaskForPushPlan(env, table, row.task_id, message);
      }
    }
  }
}

function callbackPermanentError(message) {
  const err = new Error(message);
  err.permanent = true;
  return err;
}

function normalizeGeneratedTitles(values, expectedCount, minLength, maxLength, label) {
  if (!Array.isArray(values) || values.length !== expectedCount) {
    throw callbackPermanentError(`${label}数量不匹配: ${Array.isArray(values) ? values.length : 0} vs ${expectedCount}`);
  }
  return values.map((value, index) => {
    const title = typeof value === 'string' ? value.trim() : '';
    if (title.length < minLength || title.length > maxLength) {
      throw callbackPermanentError(`${label}#${index + 1}长度必须为${minLength}~${maxLength}字符`);
    }
    return title;
  });
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
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_callback_queue_processing ON ews_callback_queue(status, processing_at)").run();
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
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_image_queue_processing ON ews_image_queue(status, processing_at)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_image_queue_task ON ews_image_queue(task_id)").run();
  imageQueueReady = true;
}

async function recoverStaleCallbackQueue(env) {
  await ensureCallbackQueueTable(env);
  await env.DB.prepare(`UPDATE ews_callback_queue
    SET status='failed', error='回调队列处理超时，已达到最大重试次数', updated_at=datetime('now')
    WHERE status='processing' AND attempts >= ?
      AND (processing_at IS NULL OR processing_at='' OR processing_at < datetime('now', '-5 minutes'))`)
    .bind(CALLBACK_QUEUE_MAX_ATTEMPTS).run();
  await env.DB.prepare(`UPDATE ews_callback_queue
    SET status='pending', error='回调队列处理超时，重新入队', updated_at=datetime('now')
    WHERE status='processing' AND attempts < ?
      AND (processing_at IS NULL OR processing_at='' OR processing_at < datetime('now', '-5 minutes'))`)
    .bind(CALLBACK_QUEUE_MAX_ATTEMPTS).run();
}

async function failImageQueuePlan(env, row, reason) {
  const idx = await getTaskIndex(env, row.task_id);
  if (!idx) return 'missing_task';
  await ensurePushPlanRuntimeColumns(env);
  const planTable = idx.platform === 'shopee' ? 'ews_shopee_push_plans' : 'ews_jst_push_plans';
  const whType = `${row.image_type}_${parseInt(row.image_position) || 1}`;
  const result = await env.DB.prepare(`UPDATE ${planTable}
    SET status='failed', retry_count=3, error=?, updated_at=datetime('now')
    WHERE task_id=? AND sub_task_id=? AND webhook_type=? AND status='processing'`)
    .bind(reason, row.task_id, row.sub_task_id || '', whType).run();
  if (d1Changes(result) > 0) {
    await refundTaskCredit(env, row.task_id);
    await failTaskForPushPlan(env, planTable, row.task_id, reason);
    return 'failed';
  }
  const plan = await getOne(env, `SELECT status FROM ${planTable} WHERE task_id=? AND sub_task_id=? AND webhook_type=?`, [row.task_id, row.sub_task_id || '', whType]);
  return plan?.status || 'missing_plan';
}

async function reconcileFailedImageQueuePlans(env, taskId, planTable) {
  await ensureImageQueueTable(env);
  const safeTable = normalizePushPlanTable(planTable);
  const rows = await query(env, `SELECT q.* FROM ews_image_queue q
    INNER JOIN ${safeTable} p
      ON p.task_id=q.task_id AND p.sub_task_id=q.sub_task_id
      AND p.webhook_type=(q.image_type || '_' || q.image_position)
    WHERE q.task_id=? AND q.status='failed' AND p.status='processing'
    ORDER BY q.updated_at ASC LIMIT 50`, [taskId]);
  for (const row of (rows?.results || [])) {
    await failImageQueuePlan(env, row, row.error || '图片队列处理失败');
  }
}

async function clearFailedImageQueueForPlan(env, plan) {
  const match = /^(main|sub|detail|sku)_(\d+)$/.exec(plan.webhook_type || '');
  if (!match) return;
  await ensureImageQueueTable(env);
  await env.DB.prepare(`DELETE FROM ews_image_queue
    WHERE task_id=? AND sub_task_id=? AND image_type=? AND image_position=? AND status='failed'`)
    .bind(plan.task_id, plan.sub_task_id || '', match[1], parseInt(match[2])).run();
}

async function recoverStaleImageQueue(env) {
  await ensureImageQueueTable(env);
  const reason = '图片队列处理超时，已达到最大重试次数';
  const exhausted = await query(env, `SELECT * FROM ews_image_queue
    WHERE status='processing' AND attempts >= ?
      AND (processing_at IS NULL OR processing_at='' OR processing_at < datetime('now', '-5 minutes'))
    ORDER BY updated_at ASC LIMIT 50`, [IMAGE_QUEUE_MAX_ATTEMPTS]);
  for (const row of (exhausted?.results || [])) {
    const planStatus = await failImageQueuePlan(env, row, reason);
    if (planStatus === 'done') {
      await env.DB.prepare("DELETE FROM ews_image_queue WHERE id=?").bind(row.id).run();
      continue;
    }
    const result = await env.DB.prepare(`UPDATE ews_image_queue
      SET status='failed', error=?, updated_at=datetime('now')
      WHERE id=? AND status='processing' AND attempts >= ?
        AND (processing_at IS NULL OR processing_at='' OR processing_at < datetime('now', '-5 minutes'))`)
      .bind(reason, row.id, IMAGE_QUEUE_MAX_ATTEMPTS).run();
    if (d1Changes(result) < 1) continue;
  }
  await env.DB.prepare(`UPDATE ews_image_queue
    SET status='pending', error='图片队列处理超时，重新入队', updated_at=datetime('now')
    WHERE status='processing' AND attempts < ?
      AND (processing_at IS NULL OR processing_at='' OR processing_at < datetime('now', '-5 minutes'))`)
    .bind(IMAGE_QUEUE_MAX_ATTEMPTS).run();
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
    if (preferredId) {
      const preferred = await getOne(env, "SELECT * FROM ews_callback_queue WHERE id=?", [preferredId]);
      if (preferred) await processCallbackQueueRow(env, ctx, preferred);
      return;
    }
    await recoverStaleCallbackQueue(env);
    const pending = await query(env, `SELECT * FROM ews_callback_queue
      WHERE attempts < ? AND (status='pending' OR (status='processing' AND processing_at < datetime('now', '-5 minutes')))
      ORDER BY received_at ASC LIMIT ?`, [CALLBACK_QUEUE_MAX_ATTEMPTS, CALLBACK_QUEUE_BATCH_SIZE]);
    const results = await Promise.allSettled((pending?.results || []).map(row => processCallbackQueueRow(env, ctx, row)));
    const claimedAny = results.some(result => result.status === 'fulfilled' && result.value);
    if (claimedAny && ctx) ctx.waitUntil(processCallbackQueue(env, ctx));
  } catch (err) {
    console.error('processCallbackQueue error:', err.message);
  }
}

async function failCallbackPushPlan(env, row, reason) {
  let payload;
  try { payload = JSON.parse(row.payload || '{}'); } catch (_) { return; }
  let webhookType = '';
  if (payload.sku_titles !== undefined) webhookType = 'sku_title';
  else if (payload.products !== undefined || payload.titles !== undefined || payload.product_title) webhookType = 'title';
  else if (payload.image_type && payload.image_position) webhookType = `${payload.image_type}_${parseInt(payload.image_position) || 1}`;
  if (!webhookType) return;
  const planTable = row.platform === 'shopee' ? 'ews_shopee_push_plans' : 'ews_jst_push_plans';
  const subTaskWhere = webhookType === 'title' || webhookType === 'sku_title' ? '' : ' AND sub_task_id=?';
  const params = [row.task_id, webhookType];
  if (subTaskWhere) params.push(payload.sub_task_id || '');
  const plan = await getOne(env, `SELECT id FROM ${planTable} WHERE task_id=? AND webhook_type=?${subTaskWhere} AND status='processing'`, params);
  if (!plan) return;
  await markPushPlanFailed(env, planTable, plan.id, reason);
  await refundTaskCredit(env, row.task_id);
}

async function processCallbackQueueRow(env, ctx, row) {
  const claim = await env.DB.prepare(`UPDATE ews_callback_queue
    SET status='processing', attempts=attempts+1, processing_at=datetime('now'), updated_at=datetime('now'), error=''
    WHERE id=? AND attempts < ?
      AND (status='pending' OR (status='processing' AND processing_at < datetime('now', '-5 minutes')))
      AND (SELECT COUNT(*) FROM ews_callback_queue WHERE status='processing' AND processing_at >= datetime('now', '-5 minutes')) < ?`)
    .bind(row.id, CALLBACK_QUEUE_MAX_ATTEMPTS, CALLBACK_QUEUE_MAX_ACTIVE).run();
  const attempts = (row.attempts || 0) + 1;
  const claimedChanges = d1Changes(claim);
  if (claimedChanges < 1) return;
  try {
    const payload = JSON.parse(row.payload || '{}');
    await processCallbackPayload(env, ctx, payload, true);
    await env.DB.prepare("DELETE FROM ews_callback_queue WHERE id=? AND status='processing' AND attempts=?").bind(row.id, attempts).run();
  } catch (err) {
    const failed = err.permanent || attempts >= CALLBACK_QUEUE_MAX_ATTEMPTS;
    if (err.permanent) await failCallbackPushPlan(env, row, err.message || '回调数据无效');
    await env.DB.prepare("UPDATE ews_callback_queue SET status=?, error=?, updated_at=datetime('now') WHERE id=? AND status='processing' AND attempts=?")
      .bind(failed ? 'failed' : 'pending', err.message || '回调处理失败', row.id, attempts).run();
    console.error('callback queue item failed:', row.id, err.message);
  }
  return true;
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

async function processImageQueue(env, ctx, preferredId) {
  try {
    await ensureImageQueueTable(env);
    const limits = await getImageQueueLimits(env);
    if (preferredId) {
      const preferred = await getOne(env, "SELECT * FROM ews_image_queue WHERE id=?", [preferredId]);
      if (preferred) await processImageQueueRow(env, ctx, preferred, limits);
      return;
    }
    await recoverStaleImageQueue(env);
    const candidates = await query(env, `SELECT * FROM ews_image_queue
      WHERE attempts < ? AND (status='pending' OR (status='processing' AND processing_at < datetime('now', '-5 minutes')))
      ORDER BY received_at ASC LIMIT ?`, [IMAGE_QUEUE_MAX_ATTEMPTS, limits.batchSize]);
    const rows = candidates?.results || [];
    if (!rows.length) return;
    const results = await Promise.allSettled(rows.map(row => processImageQueueRow(env, ctx, row, limits)));
    const claimedAny = results.some(result => result.status === 'fulfilled' && result.value);
    if (claimedAny && ctx) ctx.waitUntil(processImageQueue(env, ctx));
  } catch (err) {
    console.error('processImageQueue error:', err.message);
  }
}

async function processImageQueueRow(env, ctx, row, limits) {
  const queueLimits = limits || await getImageQueueLimits(env);
  const claim = await env.DB.prepare(`UPDATE ews_image_queue
    SET status='processing', attempts=attempts+1, processing_at=datetime('now'), updated_at=datetime('now'), error=''
    WHERE id=? AND attempts < ?
      AND (status='pending' OR (status='processing' AND processing_at < datetime('now', '-5 minutes')))
      AND (SELECT COUNT(*) FROM ews_image_queue WHERE status='processing' AND processing_at >= datetime('now', '-5 minutes')) < ?`)
    .bind(row.id, IMAGE_QUEUE_MAX_ATTEMPTS, queueLimits.maxActive).run();
  const attempts = (row.attempts || 0) + 1;
  const claimedChanges = d1Changes(claim);
  if (claimedChanges < 1) return false;
  try {
    await processImageQueuePayload(env, ctx, row);
    await env.DB.prepare("DELETE FROM ews_image_queue WHERE id=? AND status='processing' AND attempts=?").bind(row.id, attempts).run();
  } catch (err) {
    const failed = err.permanent || attempts >= IMAGE_QUEUE_MAX_ATTEMPTS;
    if (failed) await failImageQueuePlan(env, row, err.message || '图片处理达到最大重试次数');
    await env.DB.prepare("UPDATE ews_image_queue SET status=?, error=?, updated_at=datetime('now') WHERE id=? AND status='processing' AND attempts=?")
      .bind(failed ? 'failed' : 'pending', err.message || '图片处理失败', row.id, attempts).run();
    console.error('image queue item failed:', row.id, err.message);
  }
  return true;
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
  await ensurePushPlanRuntimeColumns(env);
  const sub_task_id = row.sub_task_id || '';
  if (!sub_task_id) throw callbackPermanentError('图片回调缺少 sub_task_id');
  const subTaskTable = isShopee ? 'ews_shopee_sub_tasks' : 'ews_jst_sub_tasks';
  const subTask = await getOne(env, `SELECT id, set_index FROM ${subTaskTable} WHERE id=? AND parent_task_id=?`, [sub_task_id, task_id]);
  if (!subTask) throw callbackPermanentError('图片回调的 sub_task_id 不属于当前任务');
  const image_type = row.image_type;
  const image_position = parseInt(row.image_position) || 1;
  const whType = `${image_type}_${image_position}`;
  const result = row.image_url ? await processOneImage(env, idx.platform, task_id, sub_task_id, subTask.set_index, image_type, image_position, row.image_url, publicUrl) : null;

  if (result) {
    await completePushPlanFromCallback(env, planTable, task_id, whType, sub_task_id);
  } else {
    const planInfo = await env.DB.prepare(`SELECT id, webhook_url, payload, retry_count FROM ${planTable} WHERE task_id=? AND sub_task_id=? AND webhook_type=? AND status='processing'`)
      .bind(task_id, sub_task_id, whType).first();
    if (planInfo && planInfo.webhook_url && (planInfo.retry_count||0) < 3) {
      const newCount = (planInfo.retry_count||0) + 1;
      await env.DB.prepare(`UPDATE ${planTable} SET status='processing', retry_count=?, error=?, processing_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).bind(newCount, `${row.error_message || '下载失败'}，重试第${newCount}次`, planInfo.id).run();
      ctx.waitUntil(dispatchPushPlan(env, planTable, task_id, planInfo));
    } else {
      const reason = planInfo?.retry_count >= 3 ? '已重试3次失败' : (row.error_message || '下载失败');
      await env.DB.prepare(`UPDATE ${planTable} SET status='failed', retry_count=3, error=?, updated_at=datetime('now') WHERE task_id=? AND sub_task_id=? AND webhook_type=? AND status='processing'`).bind(reason, task_id, sub_task_id, whType).run();
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
    if (['processing','partial_failed'].includes(taskInfo?.status)) ctx.waitUntil(shopeeReleaseTaskQueue(env, task_id, ctx));
  } else {
    const taskInfo = await getOne(env, "SELECT queue_mode FROM ews_jst_tasks WHERE id=?", [task_id]);
    if (taskInfo?.queue_mode !== 'manual') ctx.waitUntil(jstReleaseTaskQueue(env, task_id, ctx));
  }
}

async function processCallbackPayload(env, ctx, body, trustedQueuePayload) {
  if (!body || typeof body !== 'object') throw callbackPermanentError('无效的请求体');
  const { task_id, sub_task_id, products, titles, product_title, image_type, image_position, image_url, error: errMsg } = body;
  if (!task_id) throw callbackPermanentError('缺少 task_id');
  if (products !== undefined && !Array.isArray(products)) throw callbackPermanentError('products 必须是数组');
  if (titles !== undefined && !Array.isArray(titles)) throw callbackPermanentError('titles 必须是数组');
  if (body.sku_titles !== undefined && !Array.isArray(body.sku_titles)) throw callbackPermanentError('sku_titles 必须是数组');
  const idx = await getTaskIndex(env, task_id);
  if (!idx) throw callbackPermanentError('任务不存在');

  const config = await getConfig(env, idx.platform || '');
  if (!trustedQueuePayload) {
    const receivedSecret = body.secret ?? body.callback_secret;
    if (config.callback_secret && receivedSecret !== config.callback_secret) throw callbackPermanentError('回调密钥无效');
  }

  const isShopee = idx.platform === 'shopee';
  if (isShopee && (titles !== undefined || product_title !== undefined)) throw callbackPermanentError('Shopee商品元数据必须使用products回调');
  if (isShopee && body.sku_titles !== undefined) throw callbackPermanentError('Shopee规格标签必须通过variation_labels随products回调');
  const getSubTasks = isShopee ? shopeeGetSubTasks : jstGetSubTasks;
  const updateSubTask = isShopee ? shopeeUpdateSubTask : jstUpdateSubTask;
  const checkSubTaskImages = isShopee ? shopeeCheckSubTaskImages : jstCheckSubTaskImages;
  const checkParentCompletion = isShopee ? shopeeCheckParentCompletion : jstCheckParentCompletion;
  await ensurePushPlanRuntimeColumns(env);

  // Shopee 商品元数据回调
  if (Array.isArray(products)) {
    if (!isShopee) throw callbackPermanentError('products 仅支持 Shopee 任务');
    const subTasks = await shopeeGetSubTasks(env, task_id);
    const allSubs = (subTasks?.results || []).sort((a,b) => a.set_index - b.set_index);
    if (products.length !== allSubs.length) throw callbackPermanentError(`商品元数据数量不匹配: ${products.length} vs ${allSubs.length}`);
    const metadataBySubTask = new Map(products.map(item => [String(item?.sub_task_id || ''), item]));
    if (metadataBySubTask.has('') || metadataBySubTask.size !== products.length) throw callbackPermanentError('商品元数据的sub_task_id不能为空或重复');
    const normalizedProducts = [];
    for (let i = 0; i < allSubs.length; i++) {
      const item = metadataBySubTask.get(allSubs[i].id);
      if (!item) throw callbackPermanentError(`商品元数据缺少sub_task_id: ${allSubs[i].id}`);
      const title = normalizeGeneratedTitles([item?.product_name], 1, 10, 120, `商品标题#${i + 1}`)[0];
      const description = normalizeGeneratedTitles([item?.product_description], 1, SHOPEE_DESCRIPTION_MIN_LENGTH, SHOPEE_DESCRIPTION_MAX_LENGTH, `商品描述#${i + 1}`)[0];
      normalizedProducts.push({ id: allSubs[i].id, title, description });
    }
    if (new Set(normalizedProducts.map(item => item.title.toLocaleLowerCase('vi'))).size !== normalizedProducts.length) throw callbackPermanentError('商品标题存在重复项');
    const detail = await shopeeGetProduct(env, task_id);
    const productType = normalizeShopeeProductType(detail?.product_type, detail?.variations || []);
    const sourceVariations = productType === 'single' ? [] : detail?.variations || [];
    const variationLabels = body.variation_labels || {};
    const labels = Array.isArray(variationLabels.values) ? variationLabels.values : [];
    if (sourceVariations.length > 0) {
      const name1 = String(variationLabels.name1 || '').trim();
      const name2 = String(variationLabels.name2 || '').trim();
      if (!name1 || name1.length > 14) throw callbackPermanentError('AI一级规格名必须为1~14字符');
      if (productType === 'two' && (!name2 || name2.length > 14)) throw callbackPermanentError('AI二级规格名必须为1~14字符');
      if (labels.length !== sourceVariations.length) throw callbackPermanentError(`AI规格值数量不匹配: ${labels.length} vs ${sourceVariations.length}`);
      const labelsById = new Map(labels.map(label => [String(label?.id || ''), label]));
      const normalizedLabels = [];
      const option1Translations = new Map();
      const combinationKeys = new Set();
      for (const variation of sourceVariations) {
        const label = labelsById.get(variation.id);
        if (!label) throw callbackPermanentError(`AI规格值缺少变体ID: ${variation.id}`);
        const option1 = String(label.option1 || '').trim();
        const option2 = String(label.option2 || '').trim();
        if (!option1 || option1.length > 20) throw callbackPermanentError('AI一级规格值必须为1~20字符');
        if (productType === 'two' && (!option2 || option2.length > 20)) throw callbackPermanentError('AI二级规格值必须为1~20字符');
        const sourceOption1Key = shopeeVariationGroupKey(variation.option1);
        const translatedOption1Key = shopeeVariationGroupKey(option1);
        if (option1Translations.has(sourceOption1Key) && option1Translations.get(sourceOption1Key) !== translatedOption1Key) throw callbackPermanentError('同一一级规格值的AI翻译不一致');
        option1Translations.set(sourceOption1Key, translatedOption1Key);
        const combinationKey = `${translatedOption1Key}|${shopeeVariationGroupKey(option2)}`;
        if (combinationKeys.has(combinationKey)) throw callbackPermanentError('AI规格翻译产生重复组合');
        combinationKeys.add(combinationKey);
        normalizedLabels.push({ id: variation.id, option1, option2: productType === 'two' ? option2 : '' });
      }
      await shopeeUpdateVariationExports(env, task_id, name1, productType === 'two' ? name2 : '', normalizedLabels);
    }
    for (const item of normalizedProducts) await shopeeUpdateSubTask(env, item.id, { title: item.title, description: item.description });
  // JST 标题回调
  } else if (Array.isArray(titles)) {
    const subTasks = await getSubTasks(env, task_id);
    const allSubs = (subTasks?.results || []).sort((a,b) => a.set_index - b.set_index);
    const normalizedTitles = normalizeGeneratedTitles(titles, allSubs.length, 1, 200, '商品标题');
    for (let i = 0; i < allSubs.length; i++) await updateSubTask(env, allSubs[i].id, { title: normalizedTitles[i] });
  } else if (product_title) {
    const subTasks = await getSubTasks(env, task_id);
    const title = normalizeGeneratedTitles([product_title], 1, 1, 200, '商品标题')[0];
    for (const st of (subTasks?.results || [])) await updateSubTask(env, st.id, { title });
  }
  if (products || titles || product_title) {
    const planTable = idx.platform === 'jst' ? 'ews_jst_push_plans' : 'ews_shopee_push_plans';
    await completePushPlanFromCallback(env, planTable, task_id, 'title');
  }

  // SKU 标题回调
  if (body.sku_titles && Array.isArray(body.sku_titles)) {
    const skuDetail = await jstGetTask(env, task_id);
    const variants = (skuDetail?.variants || []).sort((a,b) => a.sort_order - b.sort_order);
    const subTasks = await jstGetSubTasks(env, task_id);
    const allSubs = (subTasks?.results || []).sort((a,b) => a.set_index - b.set_index);
    const vCount = variants.length;
    const expected = allSubs.length * vCount;
    const skuTitles = normalizeGeneratedTitles(body.sku_titles, expected, 1, 30, 'SKU标题');
    for (let si = 0; si < allSubs.length; si++) {
      for (let vi = 0; vi < vCount; vi++) {
        const title = skuTitles[si * vCount + vi];
        await jstCreateSkuTitle(env, { id: uuid(), sub_task_id: allSubs[si].id, variant_id: variants[vi].id, title });
      }
    }
    await completePushPlanFromCallback(env, 'ews_jst_push_plans', task_id, 'sku_title');
  }

  // 图片回调先进入图片队列，避免回调并发直接放大 R2/D1 压力
  let imageQueued = false;
  const hasImageCallback = image_type !== undefined || image_url !== undefined || (errMsg && sub_task_id);
  if (hasImageCallback) {
    if (!['main','sub','detail','sku'].includes(image_type)) throw callbackPermanentError('无效的图片类型');
    if (!sub_task_id) throw callbackPermanentError('图片回调缺少 sub_task_id');
    const normalizedPosition = parseInt(image_position);
    if (!Number.isInteger(normalizedPosition) || normalizedPosition < 1) throw callbackPermanentError('图片回调的 image_position 无效');
    if (!image_url && !errMsg) throw callbackPermanentError('图片回调缺少 image_url 或 error');
    const subTaskTable = isShopee ? 'ews_shopee_sub_tasks' : 'ews_jst_sub_tasks';
    const callbackSubTask = await getOne(env, `SELECT id, set_index FROM ${subTaskTable} WHERE id=? AND parent_task_id=?`, [sub_task_id, task_id]);
    if (!callbackSubTask) throw callbackPermanentError('图片回调的 sub_task_id 不属于当前任务');
    const imageQueueId = await enqueueImageCallback(env, idx, { ...body, set_index: callbackSubTask.set_index, image_position: normalizedPosition });
    ctx.waitUntil(processImageQueue(env, ctx, imageQueueId));
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
      if (['processing','partial_failed'].includes(taskInfo?.status)) ctx.waitUntil(shopeeReleaseTaskQueue(env, task_id, ctx));
    } else {
      const taskInfo = await getOne(env, "SELECT queue_mode FROM ews_jst_tasks WHERE id=?", [task_id]);
      if (taskInfo?.queue_mode !== 'manual') ctx.waitUntil(jstReleaseTaskQueue(env, task_id, ctx));
    }
  }

  return { success: true, sub_task_id, image_queued: imageQueued };
}

const SHOPEE_ITEM_IMAGE_LIMIT_BYTES = 2 * 1024 * 1024;
const SHOPEE_ITEM_IMAGE_MAX_SIDE = 1200;
const SHOPEE_FAST_JPEG_QUALITY = 88;
const SHOPEE_RETRY_JPEG_QUALITY = 82;
const SHOPEE_FINAL_JPEG_QUALITY = 55;
const IMAGE_FETCH_TIMEOUT_MS = 30000;
const MAX_SOURCE_IMAGE_BYTES = 16 * 1024 * 1024;

function isShopeeItemImage(platform, imageType) {
  return platform === 'shopee' && (imageType === 'main' || imageType === 'sub');
}

function freePhotonImage(img) {
  if (img) img.free();
}

function isJpegContentType(contentType) {
  return /^image\/jpe?g\b/i.test(contentType || '');
}

function canReuseShopeeItemImage(buffer, contentType) {
  if (!buffer || buffer.byteLength > SHOPEE_ITEM_IMAGE_LIMIT_BYTES) return false;
  if (!isJpegContentType(contentType)) return false;
  let input = null;
  try {
    input = PhotonImage.new_from_byteslice(new Uint8Array(buffer));
    const width = input.get_width();
    const height = input.get_height();
    return width > 0 && width === height;
  } catch (_) {
    return false;
  } finally {
    freePhotonImage(input);
  }
}

async function fetchImageWithTimeout(imageUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    return await fetch(imageUrl, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readImageResponse(resp) {
  const declaredSize = parseInt(resp.headers.get('content-length') || '0');
  if (declaredSize > MAX_SOURCE_IMAGE_BYTES) throw new Error('Source image exceeds 16MB limit');
  if (!resp.body?.getReader) {
    const buffer = await resp.arrayBuffer();
    if (buffer.byteLength > MAX_SOURCE_IMAGE_BYTES) throw new Error('Source image exceeds 16MB limit');
    return buffer;
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    total += chunk.byteLength;
    if (total > MAX_SOURCE_IMAGE_BYTES) {
      await reader.cancel();
      throw new Error('Source image exceeds 16MB limit');
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

function encodeShopeeJpegFast(image) {
  const primary = image.get_bytes_jpeg(SHOPEE_FAST_JPEG_QUALITY);
  if (primary.byteLength <= SHOPEE_ITEM_IMAGE_LIMIT_BYTES) return primary;
  const retry = image.get_bytes_jpeg(SHOPEE_RETRY_JPEG_QUALITY);
  return retry.byteLength < primary.byteLength ? retry : primary;
}

function normalizeShopeeItemImage(buffer) {
  let input = null;
  let square = null;
  let resized = null;
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

    const encoded = encodeShopeeJpegFast(working);
    if (encoded.byteLength <= SHOPEE_ITEM_IMAGE_LIMIT_BYTES) return encoded;

    const targetSide = Math.min(side, SHOPEE_ITEM_IMAGE_MAX_SIDE);
    if (working.get_width() > targetSide || working.get_height() > targetSide) {
      resized = resize(working, targetSide, targetSide, SamplingFilter.Lanczos3);
      const resizedBytes = encodeShopeeJpegFast(resized);
      if (resizedBytes.byteLength <= SHOPEE_ITEM_IMAGE_LIMIT_BYTES) return resizedBytes;
    }
    const finalBytes = (resized || working).get_bytes_jpeg(SHOPEE_FINAL_JPEG_QUALITY);
    if (finalBytes.byteLength <= SHOPEE_ITEM_IMAGE_LIMIT_BYTES) return finalBytes;
    throw new Error('Shopee image remains above 2MB after compression');
  } finally {
    freePhotonImage(resized);
    freePhotonImage(square);
    freePhotonImage(input);
  }
}

async function processOneImage(env, platform, task_id, sub_task_id, set_index, image_type, image_position, image_url, publicUrl) {
  try {
    const resp = await fetchImageWithTimeout(image_url);
    if (!resp.ok) return null;
    let buffer = await readImageResponse(resp);
    let contentType = resp.headers.get('content-type') || 'image/jpeg';
    if (!/^image\//i.test(contentType) && !/^application\/octet-stream\b/i.test(contentType)) return null;
    if (isShopeeItemImage(platform, image_type)) {
      if (!canReuseShopeeItemImage(buffer, contentType)) buffer = normalizeShopeeItemImage(buffer);
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
  await reconcileFailedImageQueuePlans(env, taskId, plansTable);
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
  await ensurePushPlanRuntimeColumns(env);
  const plan = await getOne(env, `SELECT * FROM ${plansTable} WHERE id=?`, [planId]);
  if (!plan || plan.task_id !== taskId) return error('计划不存在', 404);
  if (plan.status === 'processing') return error('计划正在处理中，请勿重复推送', 409);
  await clearFailedImageQueueForPlan(env, plan);
  await env.DB.prepare(`UPDATE ${plansTable} SET status='pending', retry_count=0, error='', processing_at='', updated_at=datetime('now') WHERE id=?`).bind(planId).run();
  await reconcileTaskStatusForPushPlans(env, plansTable, taskId, 'retry plan resumed', { resumeWhenNoFailures: true });
  if (idx.platform === 'jst') ctx.waitUntil(jstReleaseTaskQueue(env, taskId, ctx));
  else ctx.waitUntil(shopeeReleaseTaskQueue(env, taskId, ctx));
  return json({ success: true, queued: true, message: '计划已重新加入统一推送队列' });
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
  const mainImgTotal = Math.min(Math.max(detail.main_image_count || 5, 1), 9);
  const detailImgTotal = Math.min(Math.max(detail.detail_image_count || 5, 1), 9);
  const productType = normalizeJstProductType(detail.product_type, variants);
  const variationImageMode = normalizeJstVariationImageMode(detail.variation_image_mode, productType);
  const variationGroups = productType === 'single' ? [] : getJstVariationGroups(variants);
  const groupPosition = new Map(variationGroups.map((group, index) => [group.key, index + 1]));
  const subTasks = await jstGetSubTasks(env, taskId);
  const subTaskIds = (subTasks?.results || []).map(st => st.id);
  const plans = await query(env, 'SELECT webhook_type FROM ews_jst_push_plans WHERE task_id=?', [taskId]);
  const plannedTypes = new Set((plans?.results || []).map(plan => plan.webhook_type));
  const titlePlanned = plannedTypes.has('title');
  const skuTitlePlanned = plannedTypes.has('sku_title');
  const skuImagePlanned = [...plannedTypes].some(type => /^sku_\d+$/.test(type));

  const skuTitleMap = {};
  if (subTaskIds.length > 0) {
    const ph = subTaskIds.map(() => '?').join(',');
    const skuRows = await query(env, `SELECT sub_task_id, variant_id, title FROM ews_jst_sku_titles WHERE sub_task_id IN (${ph})`, subTaskIds);
    for (const st of (skuRows?.results || [])) skuTitleMap[st.sub_task_id + '_' + st.variant_id] = st.title;
  }

  function recordedImg(subTaskId, type, pos) {
    const found = images.find(img => img.sub_task_id === subTaskId && img.image_type === type && img.position === pos);
    return found?.image_url || '';
  }
  function getImg(setIdx, subTaskId, type, pos) {
    const direct = recordedImg(subTaskId, type, pos);
    if (direct) return direct;
    if (mode === 'dedup' && setIdx > 0 && type !== 'main') {
      return recordedImg(subTaskIds[0] || '', type, pos);
    }
    return '';
  }
  function getSkuUrl(setIdx, subTaskId, variant) {
    if (variationImageMode === 'none' || productType === 'single') return '';
    const position = groupPosition.get(shopeeVariationGroupKey(variant.tier1_value));
    if (!position) return '';
    const direct = recordedImg(subTaskId, 'sku', position);
    if (direct) return direct;
    if (mode === 'dedup' && setIdx > 0) return recordedImg(subTaskIds[0] || '', 'sku', position);
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
    if (titlePlanned && !(subTask?.title || '').trim()) addExportError(setLabel + ' 缺少AI商品标题');
    if (plannedTypes.has('main_1') && !getImg(setIdx, subTaskId, 'main', 1)) addExportError(setLabel + ' 缺少AI主图main_1');
    for (let p = 2; p <= mainImgTotal; p++) {
      if (plannedTypes.has('sub_' + p) && !getImg(setIdx, subTaskId, 'sub', p)) addExportError(setLabel + ' 缺少AI附图sub_' + p);
    }
    for (let p = 1; p <= detailImgTotal; p++) {
      if (plannedTypes.has('detail_' + p) && !getImg(setIdx, subTaskId, 'detail', p)) addExportError(setLabel + ' 缺少AI详情图detail_' + p);
    }
    const checkedSkuImages = new Set();
    for (let vIdx = 0; vIdx < variants.length; vIdx++) {
      const variant = variants[vIdx];
      const skuTitle = skuTitleMap[subTaskId + '_' + variant.id] || '';
      if (skuTitlePlanned && !skuTitle.trim()) addExportError(setLabel + ' SKU#' + (vIdx + 1) + ' 缺少AI SKU标题');
      const skuGroupKey = shopeeVariationGroupKey(variant.tier1_value);
      if (skuImagePlanned && !checkedSkuImages.has(skuGroupKey) && !getSkuUrl(setIdx, subTaskId, variant)) addExportError(setLabel + ' 一级规格“' + (variant.tier1_value || '') + '”缺少AI SKU图片');
      checkedSkuImages.add(skuGroupKey);
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
    const productTitle = subTask?.title || detail.name || '';
    for (let vIdx = 0; vIdx < variants.length; vIdx++) {
      const variant = variants[vIdx];
      const skuSuffix = String(variant.sku_code || '').trim() || `V${vIdx + 1}`;
      const skuCode = `${styleCode}-${skuSuffix}`;
      const mainUrls = [getImg(setIdx, subTaskId, 'main', 1)];
      for (let p = 2; p <= mainImgTotal; p++) mainUrls.push(getImg(setIdx, subTaskId, 'sub', p));
      const detailUrls = [];
      for (let p = 1; p <= detailImgTotal; p++) detailUrls.push(getImg(setIdx, subTaskId, 'detail', p));
      const skuUrl = getSkuUrl(setIdx, subTaskId, variant);
      const skuTitle = skuTitleMap[subTaskId + '_' + variant.id] || '';
      const exportPrice = exportPriceForVariant(variant, taskId, setIdx, vIdx);
      const row = {
        '款式编码': styleCode, '商品编码': skuCode,
        '颜色': productType === 'single' ? '' : (skuTitle || variant.tier1_value || ''),
        '规格': productType === 'two' ? (variant.tier2_value || '') : '',
        '商品主图': JSON.stringify(mainUrls.filter(u => u)),
        '商品详情图': JSON.stringify(detailUrls.filter(u => u)),
        '图片地址': skuUrl, '商品名称': productTitle,
        '推荐文案': detail.recommended_copy || '', '商品描述': detail.description || '', '宝贝链接': detail.product_link || '',
        '库存': variant.stock ?? detail.stock ?? 999, '重量(kg)': detail.weight ?? 1.0, '基本售价': exportPrice,
        '市场|吊牌价': variant.market_price ?? '',
        '最低分销控价': variant.min_distribution_price ?? '', '最高分销控价': variant.max_distribution_price ?? '',
        '供应商名': detail.supplier_name || '',
        '3:4主图': '', '长图': '', '透明素材图': '', '白底图': '',
      };
      rows.push(JST_TEMPLATE_COLUMNS.map(column => row[column]));
    }
  }
  return json({ success: true, rows, columns: JST_TEMPLATE_COLUMNS, task_title: detail.name, mode, export_format: 'jst', template_sheet: '商品导入模板', template_start_row: 3 });
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
  var productType = normalizeShopeeProductType(product.product_type, variations);
  var isSingle = productType === 'single';

  // 必填字段
  if (!n) errors.push('任务名称不能为空');
  if (!desc) errors.push('商品描述(Product Description)不能为空');
  if (desc && (desc.length < SHOPEE_DESCRIPTION_MIN_LENGTH || desc.length > SHOPEE_DESCRIPTION_MAX_LENGTH)) errors.push('商品描述(Product Description)必须为100~3000字符（当前: ' + desc.length + '）');
  if (varCount === 0) errors.push('至少需要一个变体');
  if (isNaN(weightKg) || weightKg <= 0 || weightG > 100000000) errors.push('重量(Weight)导出为g，必须在0~100000000g之间（当前: ' + (isNaN(weightKg) ? '空' : weightG + 'g') + '）');

  // 变体校验
  if (varCount > 0) {
    var hasTier2 = variations.some(function(v) { return v.option2 && v.option2.trim(); });
    if (varCount > 50) errors.push('变体数量超过50上限（当前: ' + varCount + '）');
    if (!isSingle && !hasTier2 && varCount > 20) errors.push('一维规格变体超过20上限（当前: ' + varCount + '）');
    if (!isSingle && !variationName1) errors.push('规格名1(Variation Name1)不能为空');
    if (variationName1 && (variationName1.length < 1 || variationName1.length > 14)) errors.push('规格名1(Variation Name1)必须为1~14字符（当前: ' + variationName1.length + '）');
    if (hasTier2 && !variationName2) errors.push('存在二级规格时，规格名2(Variation Name2)不能为空');
    if (variationName2 && (variationName2.length < 1 || variationName2.length > 14)) errors.push('规格名2(Variation Name2)必须为1~14字符（当前: ' + variationName2.length + '）');

    // 检查变体组合是否重复
    var combos = {};
    for (var i = 0; i < variations.length; i++) {
      var key = (variations[i].option1 || '') + '|' + (variations[i].option2 || '');
      if (combos[key]) { warnings.push('变体组合 "' + key + '" 重复（第' + (i+1) + '行）'); }
      combos[key] = true;
      if (!isSingle && (!variations[i].option1 || !variations[i].option1.trim())) errors.push('变体#' + (i+1) + ' 规格值1不能为空');
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

  var priceLows = []; var priceHighs = [];
  for (var pi = 0; pi < variations.length; pi++) {
    if (isEnabled(variations[pi].price_float_enabled)) {
      priceLows.push(parseFloat(variations[pi].price_min));
      priceHighs.push(parseFloat(variations[pi].price_max));
    } else {
      priceLows.push(parseFloat(variations[pi].price));
      priceHighs.push(parseFloat(variations[pi].price));
    }
  }
  var lowest = Math.min(...priceLows.filter(Number.isFinite));
  var highest = Math.max(...priceHighs.filter(Number.isFinite));
  if (Number.isFinite(lowest) && lowest > 0 && Number.isFinite(highest) && highest / lowest > 5) errors.push('最高SKU价格除以最低SKU价格不能超过5');
  var dimensions = [product.length_cm, product.width_cm, product.height_cm].map(parseNumberOrNull);
  var dimensionCount = dimensions.filter(function(value) { return value !== null; }).length;
  if (dimensionCount !== 0 && dimensionCount !== 3) errors.push('长、宽、高必须同时填写或全部留空');
  var shippingChannels = normalizeShopeeShippingChannels(product.shipping_channels);
  if (!shippingChannels.length) errors.push('至少需要开启一个物流渠道');
  var shippingPriceLimits = { '5000': 10000000, '5001': 100000000, '5004': 100000000, '5115': 5000000 };
  for (var ci = 0; ci < shippingChannels.length; ci++) {
    var channelLimit = shippingPriceLimits[shippingChannels[ci]];
    if (channelLimit && highest > channelLimit) errors.push('物流渠道' + shippingChannels[ci] + '允许的最高价格为' + channelLimit);
  }
  if (product.size_chart_template_id && product.size_chart_image) errors.push('尺码表模板和尺码表图片只能填写一个');

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
  const productType = normalizeShopeeProductType(product.product_type, variations);
  const isSingleProduct = productType === 'single';
  const firstGeneratedDescription = String(product.sub_tasks?.[0]?.description || '').trim();

  // 校验
  var validation = validateShopeeRow({ ...product, description: firstGeneratedDescription }, variations);
  // 有错误则拒绝导出，有警告则附带
  if (!validation.valid) {
    return json({ success: false, error: '数据校验失败', errors: validation.errors, warnings: validation.warnings }, 400);
  }

  const rows = [];
  const mode = product.mode || 'full';
  const variationImageMode = normalizeShopeeVariationImageMode(product.variation_image_mode, 'option1');
  const variationGroups = getShopeeVariationGroups(isSingleProduct ? [] : variations, variationImageMode);
  const variationImagePositions = new Map();
  for (let groupIndex = 0; groupIndex < variationGroups.length; groupIndex++) {
    for (const variation of variationGroups[groupIndex].variations) variationImagePositions.set(variation.id, groupIndex + 1);
  }
  const mainImgTotal = Math.min(Math.max(product.main_image_count || 9, 5), 9);
  const expectedSetCount = Math.max(parseInt(product.generate_count) || 1, 1);
  const subTasks = (product.sub_tasks && product.sub_tasks.length) ? product.sub_tasks : [];
  var shippingChannels = [];
  try { shippingChannels = JSON.parse(product.shipping_channels || '[]'); } catch(e) {}

  function generatedImage(type, pos, setIdx, subTaskId) {
    const rec = (product.images_rec || []).find(img => img.sub_task_id === subTaskId && img.image_type === type && img.position === pos);
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
    if (isSingleProduct || variationImageMode === 'none') return '';
    const imagePosition = variationImagePositions.get(v.id);
    return imagePosition ? getImg(setIdx, subTaskId, 'sku', imagePosition) : '';
  }
  function productDescriptionFor(subTask) {
    return String(subTask?.description || '').trim();
  }
  function option1For(subTask, variation) {
    if (isSingleProduct) return '';
    return variation.option1_export || '';
  }
  function option2For(variation) {
    if (isSingleProduct) return '';
    return variation.option2_export || '';
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
  if (!isSingleProduct && !product.variation_name1_export) addExportError('缺少AI规范化一级规格名');
  if (productType === 'two' && !product.variation_name2_export) addExportError('缺少AI规范化二级规格名');
  for (let si = 0; si < subTasks.length; si++) {
    const subTask = subTasks[si];
    const setIdx = subTask.set_index ?? si;
    const setLabel = '第' + (setIdx + 1) + '套';
    const productTitle = subTask.title || '';
    if (productTitle.length < 10 || productTitle.length > 120) addExportError(setLabel + ' 缺少合规AI商品标题(Product Name 10~120字符)');
    const productDescription = productDescriptionFor(subTask);
    if (productDescription.length < SHOPEE_DESCRIPTION_MIN_LENGTH || productDescription.length > SHOPEE_DESCRIPTION_MAX_LENGTH) addExportError(setLabel + ' 缺少合规AI商品描述(Product Description 100~3000字符)');
    if (!getImg(setIdx, subTask.id || '', 'main', 1)) addExportError(setLabel + ' 缺少AI封面图(main_1)，不能用参考图替代');
    for (let p = 2; p <= mainImgTotal; p++) {
      if (!getImg(setIdx, subTask.id || '', 'sub', p)) addExportError(setLabel + ' 缺少AI附图sub_' + p);
    }
    for (let vi = 0; vi < variations.length; vi++) {
      const v = variations[vi];
      const skuCode = skuCodeFor(subTask, setIdx, v, vi);
      const option1 = option1For(subTask, v);
      const option2 = option2For(v);
      if (!isSingleProduct && (option1.length < 1 || option1.length > 20)) addExportError(setLabel + ' 变体#' + (vi + 1) + ' 缺少合规一级规格值(1~20字符)');
      if (productType === 'two' && (option2.length < 1 || option2.length > 20)) addExportError(setLabel + ' 变体#' + (vi + 1) + ' 缺少合规二级规格值(1~20字符)');
      if (!isSingleProduct && variationImageMode !== 'none' && !getSkuUrl(setIdx, subTask.id || '', vi, v)) addExportError(setLabel + ' 变体#' + (vi + 1) + ' 缺少AI SKU变体图');
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
    var option1 = option1For(subTask, v);
    var option2 = option2For(v);
    var skuCode = skuCodeFor(subTask, setIdx, v, variationsIdx);
    var exportPrice = exportPriceForVariant(v, taskId, setIdx, variationsIdx);
    return [
      product.category_id || '',                          // A Category
      subTask.title || '',                                // B Product Name
      productDescriptionFor(subTask),                     // C Product Description
      product.max_purchase_qty ?? '',                     // D Maximum Purchase Quantity
      product.max_purchase_start_date || '',              // E MaxPQ Start Date
      product.max_purchase_period_days ?? '',             // F MaxPQ Time Period
      product.max_purchase_end_date || '',                // G MaxPQ End Date
      parentSku,                                          // H Parent SKU
      isSingleProduct ? '' : parentSku,                   // I Variation Integration No.
      isSingleProduct ? '' : product.variation_name1_export || '', // J Variation Name1
      option1,                                            // K Option for Variation 1
      getSkuUrl(setIdx, subTask.id || '', variationsIdx, v), // L Image per Variation
      productType === 'two' ? product.variation_name2_export || '' : '', // M Variation Name2
      option2,                                            // N Option for Variation 2
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
  const taskId = formData.get('task_id'); if (!taskId) return error('缺少 task_id', 400);
  const folder = String(formData.get('folder') || 'uploads');
  const imageTypes = ['image/jpeg','image/png','image/webp','image/gif'];
  const isSizeChartPdf = folder === 'size-chart' && file.type === 'application/pdf';
  if (!imageTypes.includes(file.type) && !isSizeChartPdf) return error('仅支持 JPG/PNG/WebP/GIF，尺码表可使用 PDF', 400);
  const maxSize = folder === 'size-chart' ? 2 * 1024 * 1024 : 10 * 1024 * 1024;
  if (file.size > maxSize) return error(folder === 'size-chart' ? '尺码表文件不能超过 2MB' : '文件大小不能超过 10MB', 400);
  const buffer = await file.arrayBuffer();
  const key = `ews/${taskId}/${folder}/${uuid()}.${isSizeChartPdf ? 'pdf' : 'jpg'}`;
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
