// EWS - Cloudflare Worker 主入口（统一路由 + 分平台分发）

import { AwsClient } from 'aws4fetch';
import {
  query, getOne, getConfig, updateConfig, getPlatformConfig,
  createUser, getUserByUsername, getUserList, updateUserPassword,
  toggleUserActive, deleteUser, updateUserPlatformAccess, updateUserImageConcurrencyLimit, updateUserWebhook, getUserCredits, updateUserCredits, consumeUserCredit,
  normalizeUserImageConcurrencyLimit,
  createTaskIndex, updateTaskIndexStatus, getTaskIndex, getTaskList, getTaskCount, deleteTaskIndex,
  jstCreateTask, jstUpdateTask, jstGetTask, jstUpdateTaskStatus,
  jstReplaceVariants,
  jstCreateSubTask, jstGetSubTasks, jstUpdateSubTask, jstDeleteSubTasks,
  jstSaveMetadataBatch, jstSaveImage, jstClearImages,
  jstCreateExpectedImages, jstCheckSubTaskImages, jstCheckParentCompletion, jstDeleteTaskRecord,
  jstCreatePushPlans, jstGetPushPlans, jstGetPendingPlans, jstGetPlanStats,
  jstRefundCredits,
  shopeeCreateProduct, shopeeGetProduct, shopeeDeleteProduct,
  shopeeListTemplateProfiles, shopeeGetTemplateProfile, shopeeGetTemplateProfileByContext, shopeeClaimTemplateProfile,
  shopeeGetTemplateVersion, shopeeGetCurrentTemplateVersion, shopeeGetLatestTemplateVersion, shopeeGetTemplateVersionByHash,
  shopeeGetTemplateCategories, shopeeGetTemplateCategory, shopeeGetTemplateFields, shopeeSaveTemplateVersion,
  shopeeUpdateTemplateUserMeta, shopeeUpdateTemplateProfile, shopeeMapTemplateField, shopeeCountUnmappedRequiredFields,
  shopeeApproveTemplateVersion, shopeeSoftDeleteTemplateProfile, shopeeGetTemplateProfileVersions,
  shopeeDeleteTemplateVersions,
  shopeeGetTemplateProfileTaskCount, shopeePurgeTemplateProfile,
  shopeeReplaceVariations,
  shopeeCreatePushPlans, shopeeGetPushPlans, shopeeGetPendingPlans, shopeeGetPlanStats,
  shopeeCreateExportRecord,
  shopeeCreateSubTask, shopeeGetSubTasks, shopeeUpdateSubTask,
  shopeeCreateExpectedImages, shopeeCheckSubTaskImages,
  shopeeSaveImage, shopeeCheckParentCompletion, shopeeRefundCredits, shopeeUpdateVariationExports,
} from './db.js';
import { generateToken, hashPassword, verifyPassword, authenticateRequest, DEFAULT_PASSWORD } from './auth.js';
import { processSkuUploadImage } from './sku-upload-image.js';
import {
  buildShopeeWorkbook, compareShopeeTemplateSemantics, parseShopeeTemplate, sha256Hex,
  SHOPEE_TEMPLATE_SEMANTIC_KEYS,
} from './shopee-template.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Expose-Headers': 'Content-Disposition',
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

async function requireTaskAccess(request, env, path, handler) {
  const taskId = getTaskId(path);
  const task = await getTaskIndex(env, taskId);
  if (!task) return error('任务不存在', 404);
  if (request.auth?.role !== 'admin' && task.user_id !== request.auth?.username) {
    return error('无权访问该任务', 403);
  }
  return handler(task);
}

// 登录速率限制
const loginAttempts = new Map();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW = 300;

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(processPendingQueue(env, ctx));
  },

  async queue(batch, env, ctx) {
    await processNativeCallbackQueue(batch, env, ctx);
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

      // --- Shopee 全局模板库（/stores 保留为旧客户端兼容别名） ---
      if ((path === '/api/shopee/template-profiles' || path === '/api/shopee/stores') && method === 'GET')
        return requireAuth(request, env, () => handleGetShopeeTemplateProfiles(request, env));
      if ((path === '/api/shopee/template-profiles' || path === '/api/shopee/stores') && method === 'POST')
        return requireAuth(request, env, () => handleUploadShopeeTemplate(request, env));
      if (path.match(/^\/api\/shopee\/template-profiles\/[^\/]+\/meta$/) && method === 'PUT')
        return requireAuth(request, env, () => handleUpdateShopeeTemplateMeta(request, env, path));
      if (path.match(/^\/api\/shopee\/template-profiles\/[^\/]+\/versions\/[^\/]+\/fields\/[^\/]+$/) && method === 'PUT')
        return requireAuth(request, env, () => handleMapShopeeTemplateField(request, env, path));
      if ((path.match(/^\/api\/shopee\/template-profiles\/[^\/]+$/) || path.match(/^\/api\/shopee\/stores\/[^\/]+$/)) && method === 'GET')
        return requireAuth(request, env, () => handleGetShopeeTemplateProfile(request, env, path));
      if ((path.match(/^\/api\/shopee\/template-profiles\/[^\/]+$/) || path.match(/^\/api\/shopee\/stores\/[^\/]+$/)) && method === 'PUT')
        return requireAuth(request, env, () => path.includes('/stores/') ? handleUpdateShopeeTemplateMeta(request, env, path) : handleAdminUpdateShopeeTemplateProfile(request, env, path));
      if ((path.match(/^\/api\/shopee\/template-profiles\/[^\/]+$/) || path.match(/^\/api\/shopee\/stores\/[^\/]+$/)) && method === 'DELETE')
        return requireAuth(request, env, () => handleDeleteShopeeTemplateProfile(request, env, path, url));

      // --- 统一任务 ---
      if (path === '/api/tasks/init' && method === 'POST')
        return requireAuth(request, env, () => handleInitTask(request, env));
      if (path === '/api/tasks' && method === 'GET')
        return requireAuth(request, env, () => handleGetTasks(env, ctx, request.auth, url));
      if (path.match(/^\/api\/tasks\/[^\/]+$/) && method === 'GET')
        return requireAuth(request, env, () => requireTaskAccess(request, env, path, task => handleGetTaskDetail(env, ctx, path, task)));
      if (path.match(/^\/api\/tasks\/[^\/]+$/) && method === 'PUT')
        return requireAuth(request, env, () => requireTaskAccess(request, env, path, task => handleUpdateTask(request, env, path, task)));
      if (path.match(/^\/api\/tasks\/[^\/]+$/) && method === 'DELETE')
        return requireAuth(request, env, () => requireTaskAccess(request, env, path, task => handleDeleteTask(env, path, task)));
      if (path.match(/^\/api\/tasks\/[^\/]+\/status$/) && method === 'PUT')
        return requireAuth(request, env, () => requireTaskAccess(request, env, path, task => handleUpdateTaskStatus(request, env, path, task)));
      if (path.match(/^\/api\/tasks\/[^\/]+\/push$/) && method === 'POST')
        return requireAuth(request, env, () => requireTaskAccess(request, env, path, task => handlePushTask(env, ctx, path, request, task)));
      if (path.match(/^\/api\/tasks\/[^\/]+\/plans$/) && method === 'GET')
        return requireAuth(request, env, () => requireTaskAccess(request, env, path, task => handleGetPlans(env, path, task)));
      if (path.match(/^\/api\/tasks\/[^\/]+\/plans\/[^\/]+\/retry$/) && method === 'POST')
        return requireAuth(request, env, () => requireTaskAccess(request, env, path, task => handleRetryPlan(env, path, request, ctx, task)));
      if (path.match(/^\/api\/tasks\/[^\/]+\/export$/) && method === 'GET')
        return requireAuth(request, env, () => requireTaskAccess(request, env, path, task => handleExportTask(env, path, task)));

      // --- 回调 ---
      if (path === '/api/callback' && method === 'POST')
        return handleCallback(request, env, ctx);
      if (path === '/api/internal/r2-upload-ticket' && method === 'POST')
        return handleR2UploadTicket(request, env);

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
      if (path.match(/^\/api\/users\/[^\/]+\/concurrency$/) && method === 'PUT')
        return requireAuth(request, env, () => handleUpdateUserConcurrency(request, env, path));
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

const RETIRED_CONCURRENCY_CONFIG_KEYS = new Set([
  'push_global_max_active',
  'push_release_per_minute',
  'push_release_per_task_per_minute',
  'push_batch_size',
  'image_queue_max_active',
  'image_queue_batch_size',
]);

async function handleGetConfig(request, env, url) {
  if (request.auth?.role !== 'admin') return error('无权访问', 403);
  const platform = url.searchParams.get('platform') || '';
  const config = await getConfig(env, platform);
  const safe = { ...config };
  delete safe.admin_password;
  delete safe.jwt_secret_name;
  for (const key of RETIRED_CONCURRENCY_CONFIG_KEYS) delete safe[key];
  return json({ success: true, config: safe, platform });
}

async function handleUpdateConfig(request, env) {
  if (request.auth?.role !== 'admin') return error('无权访问', 403);
  const body = await parseBody(request);
  if (!body || typeof body !== 'object') return error('无效的配置数据', 400);
  const platform = body._platform || '';
  delete body._platform;
  if (body.push_plan_timeout_minutes !== undefined) {
    const timeoutMinutes = Number(body.push_plan_timeout_minutes);
    if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < MIN_PUSH_PLAN_TIMEOUT_MINUTES || timeoutMinutes > MAX_PUSH_PLAN_TIMEOUT_MINUTES) {
      return error(`推送计划超时必须为${MIN_PUSH_PLAN_TIMEOUT_MINUTES}~${MAX_PUSH_PLAN_TIMEOUT_MINUTES}分钟`, 400);
    }
  }
  for (const [key, value] of Object.entries(body)) {
    if (RETIRED_CONCURRENCY_CONFIG_KEYS.has(key)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      await updateConfig(env, key, String(value), platform);
    }
  }
  return json({ success: true, message: '配置更新成功', platform });
}

// ========== Shopee 全局模板库 ===========

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function shopeeTemplateVersionLabel(version, manifest) {
  if (!version) return '';
  const date = String(version.version_created_at || version.created_at || '').slice(0, 10) || 'unknown';
  const fields = Number(version.field_count || 0);
  const logistics = Number(version.logistics_count ?? manifest?.shipping_channels?.length ?? 0);
  return `${date} · ${fields}F · ${logistics}L · ${String(version.sha256 || '').slice(0, 8)}`;
}

function serializeShopeeTemplateVersion(version) {
  if (!version) return null;
  const manifest = parseJson(version.manifest_json, {});
  const id = version.version_id || version.id;
  if (!id) return null;
  return {
    id,
    filename: version.filename,
    sha256: version.sha256,
    schema_hash: version.schema_hash,
    signature: version.signature,
    template_type: version.template_type,
    field_count: Number(version.field_count || 0),
    logistics_count: Number(version.logistics_count ?? manifest.shipping_channels?.length ?? 0),
    category_count: Number(version.category_count || 0),
    status: version.version_status || version.status,
    uploaded_by: version.version_uploaded_by || version.uploaded_by || '',
    has_sensitive_data: Number(version.has_sensitive_data || 0) === 1,
    sensitive_sheets: parseJson(version.sensitive_summary, manifest.sensitive_sheets || []),
    warnings: manifest.unknown_optional_tokens || [],
    unknown_required_tokens: manifest.unknown_required_tokens || [],
    created_at: version.version_created_at || version.created_at,
    label: shopeeTemplateVersionLabel(version, manifest),
    shipping_channels: manifest.shipping_channels || [],
  };
}

function serializeShopeeTemplateProfile(profile, version = profile) {
  const template = serializeShopeeTemplateVersion(version);
  const displayName = profile.user_alias || profile.system_name || profile.profile_code;
  const latestUpdatedBy = template?.uploaded_by || '';
  return {
    id: profile.id,
    market: profile.market,
    store_context_id: profile.store_context_id,
    template_context_id: profile.store_context_id,
    profile_code: profile.profile_code,
    system_name: profile.system_name,
    display_name: displayName,
    name: displayName,
    status: profile.status,
    latest_updated_by: latestUpdatedBy,
    can_update_template: true,
    user_alias: profile.user_alias || '',
    user_note: profile.user_note || '',
    is_favorite: Number(profile.is_favorite || 0) === 1,
    current_version_id: profile.current_version_id || null,
    updated_at: profile.updated_at,
    template,
  };
}

async function matchesShopeeTemplateVersion(env, version, sha256, schemaHash) {
  if (!version) return false;
  if (version.sha256 === sha256) return true;
  const manifest = parseJson(version.manifest_json, {});
  if (manifest.template_fingerprint_version === 2) return version.schema_hash === schemaHash;
  try {
    const object = await env.R2.get(version.r2_key);
    if (!object) return false;
    const parsed = parseShopeeTemplate(await object.arrayBuffer());
    const contentHash = await sha256Hex(new TextEncoder().encode(parsed.comparison_source));
    return contentHash === schemaHash;
  } catch (err) {
    console.warn(`Legacy Shopee template comparison failed for ${version.id}:`, err.message);
    return false;
  }
}

async function deleteShopeeTemplateVersionObjects(env, versions) {
  const results = await Promise.allSettled((versions || []).filter(version => version.r2_key).map(version => env.R2.delete(version.r2_key)));
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length) console.error(`Shopee template R2 cleanup failed for ${failures.length} object(s)`);
  return failures.length;
}

function shopeeTemplateProfileIdFromPath(path) {
  const parts = path.split('/');
  const marker = parts.indexOf('template-profiles');
  return decodeURIComponent(parts[marker >= 0 ? marker + 1 : 4] || '');
}

async function handleGetShopeeTemplateProfiles(request, env) {
  const result = await shopeeListTemplateProfiles(env, request.auth.username, request.auth.role === 'admin');
  const profiles = (result?.results || []).map(row => serializeShopeeTemplateProfile(row));
  return json({ success: true, profiles, stores: profiles });
}

async function handleGetShopeeTemplateProfile(request, env, path) {
  const profileId = shopeeTemplateProfileIdFromPath(path);
  const profile = await shopeeGetTemplateProfile(env, profileId, request.auth.username);
  if (!profile || (request.auth.role !== 'admin' && (profile.status !== 'active' || profile.deleted_at))) return error('模板档案不存在或不可用', 404);
  const currentVersion = profile.current_version_id ? await shopeeGetCurrentTemplateVersion(env, profileId) : null;
  const latestVersion = request.auth.role === 'admin' ? await shopeeGetLatestTemplateVersion(env, profileId) : currentVersion;
  const dataVersion = currentVersion || latestVersion;
  const categories = dataVersion ? (await shopeeGetTemplateCategories(env, dataVersion.id))?.results || [] : [];
  const manifest = parseJson(dataVersion?.manifest_json, {});
  const serialized = serializeShopeeTemplateProfile(profile, currentVersion || latestVersion);
  const response = {
    success: true,
    profile: serialized,
    store: serialized,
    categories,
    shipping_channels: manifest.shipping_channels || [],
  };
  if (request.auth.role === 'admin') {
    const versions = (await shopeeGetTemplateProfileVersions(env, profileId))?.results || [];
    const fields = latestVersion ? (await shopeeGetTemplateFields(env, latestVersion.id))?.results || [] : [];
    response.versions = versions.map(version => ({
      ...serializeShopeeTemplateVersion(version),
      is_current: version.id === profile.current_version_id,
      retention_role: version.id === profile.current_version_id ? 'current' : 'previous',
    }));
    const comparisonCurrent = versions.find(version => version.id === profile.current_version_id);
    const comparisonPrevious = versions.find(version => version.id !== profile.current_version_id);
    if (comparisonCurrent && comparisonPrevious) {
      const [currentCategories, previousCategories] = await Promise.all([
        shopeeGetTemplateCategories(env, comparisonCurrent.id),
        shopeeGetTemplateCategories(env, comparisonPrevious.id),
      ]);
      response.version_comparison = {
        current_version_id: comparisonCurrent.id,
        previous_version_id: comparisonPrevious.id,
        ...compareShopeeTemplateSemantics(
          parseJson(comparisonPrevious.manifest_json, {}), previousCategories?.results || [],
          parseJson(comparisonCurrent.manifest_json, {}), currentCategories?.results || [],
        ),
      };
    } else {
      response.version_comparison = null;
    }
    response.review_version = latestVersion && latestVersion.status !== 'ready' ? serializeShopeeTemplateVersion(latestVersion) : null;
    response.fields = fields;
    response.semantic_registry = [...new Set([...SHOPEE_TEMPLATE_SEMANTIC_KEYS, ...fields.map(field => field.semantic_key).filter(Boolean)])].sort();
  }
  return json(response);
}

function normalizeShopeeTemplateUserMeta(input, fallback = {}) {
  const alias = String(input.alias ?? input.name ?? fallback.user_alias ?? '').trim();
  const note = String(input.note ?? fallback.user_note ?? '').trim();
  const isFavorite = input.is_favorite === undefined ? Number(fallback.is_favorite || 0) === 1 : isEnabled(input.is_favorite);
  if (alias.length > 60) throw new Error('用户别名不能超过60字符');
  if (note.length > 500) throw new Error('用户备注不能超过500字符');
  return { alias, note, is_favorite: isFavorite };
}

async function handleUploadShopeeTemplate(request, env) {
  const formData = await parseBody(request);
  if (!(formData instanceof FormData)) return error('请使用 multipart/form-data 上传店铺模板', 400);
  const file = formData.get('file');
  if (!file || typeof file.arrayBuffer !== 'function') return error('请选择有效的 XLSX 模板文件', 400);
  const filename = String(file.name || '').trim();
  if (!/\.xlsx$/i.test(filename)) return error('仅支持 Shopee 下载的 .xlsx 基础模板', 400);
  if (file.size < 1 || file.size > 5 * 1024 * 1024) return error('模板文件大小必须在 1B 到 5MB 之间', 400);
  let userMeta;
  try {
    userMeta = normalizeShopeeTemplateUserMeta({ alias: formData.get('alias') ?? formData.get('name'), note: formData.get('note'), is_favorite: formData.get('is_favorite') });
  } catch (err) {
    return error(err.message, 400);
  }
  const buffer = await file.arrayBuffer();
  let parsed;
  try {
    parsed = parseShopeeTemplate(buffer);
  } catch (err) {
    return error(err.message || '模板解析失败', 400);
  }
  const market = 'VN';
  const storeContextId = parsed.manifest.store_context_id;
  const unknownRequired = parsed.manifest.unknown_required_tokens || [];
  if (unknownRequired.length) {
    return json({
      success: false,
      error: '模板包含系统无法识别的必填 token，不能安全导出',
      errors: unknownRequired,
    }, 400);
  }
  const requestedProfileId = String(formData.get('profile_id') || formData.get('store_id') || '').trim();
  let profile = requestedProfileId
    ? await shopeeGetTemplateProfile(env, requestedProfileId, request.auth.username)
    : await shopeeGetTemplateProfileByContext(env, market, storeContextId);
  if (requestedProfileId && !profile) return error('模板档案不存在', 404);
  if (profile && profile.store_context_id !== storeContextId) return error('该文件属于另一店铺上下文，store_context_id 不匹配', 400);
  if (profile?.status === 'deleted') return error('该模板档案已删除，请由管理员恢复后再上传', 409);
  const profileId = profile?.id || `shp-vn-${storeContextId}`;
  const profileCode = `SHP-VN-${storeContextId}`;
  if (!profile) {
    profile = await shopeeClaimTemplateProfile(env, {
      id: profileId,
      market,
      store_context_id: storeContextId,
      profile_code: profileCode,
      system_name: profileCode,
      created_by: request.auth.username,
    });
  }
  const sha256 = await sha256Hex(buffer);
  const schemaHash = await sha256Hex(new TextEncoder().encode(parsed.comparison_source));
  const existingVersions = profile.current_version_id
    ? (await shopeeGetTemplateProfileVersions(env, profileId))?.results || []
    : [];
  const currentVersion = existingVersions.find(version => version.id === profile.current_version_id)
    || (profile.current_version_id ? await shopeeGetCurrentTemplateVersion(env, profileId) : null);
  if (await matchesShopeeTemplateVersion(env, currentVersion, sha256, schemaHash)) {
    await shopeeUpdateTemplateUserMeta(env, profileId, request.auth.username, userMeta);
    const refreshed = await shopeeGetTemplateProfile(env, profileId, request.auth.username);
    const serialized = serializeShopeeTemplateProfile(refreshed, currentVersion);
    return json({
      success: true,
      duplicate: true,
      unchanged: true,
      profile: serialized,
      store: serialized,
      message: '模板已是最新，无需更新',
    });
  }
  for (const historicalVersion of existingVersions) {
    if (historicalVersion.id === currentVersion?.id) continue;
    if (await matchesShopeeTemplateVersion(env, historicalVersion, sha256, schemaHash)) {
      return json({
        success: false,
        error: '上传的是已保留的上一版本，当前已有更新模板，已阻止版本回退',
        code: 'SHOPEE_TEMPLATE_ROLLBACK_BLOCKED',
        historical_version: true,
        current_version_id: currentVersion?.id || null,
        matched_version_id: historicalVersion.id,
        latest_updated_by: currentVersion?.uploaded_by || '',
      }, 409);
    }
  }
  const sensitiveSheets = parsed.manifest.sensitive_sheets || [];
  const versionStatus = 'ready';
  const versionId = uuid(20);
  const r2Key = `ews/shopee-template-library/${profileId}/${versionId}.xlsx`;
  try {
    await env.R2.put(r2Key, buffer, { httpMetadata: { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } });
    await shopeeSaveTemplateVersion(env, {
      id: profileId,
      market,
      store_context_id: storeContextId,
      profile_code: profileCode,
      system_name: profile?.system_name || profileCode,
      status: 'active',
      created_by: profile.created_by,
    }, {
      id: versionId,
      uploaded_by: request.auth.username,
      filename,
      r2_key: r2Key,
      sha256,
      schema_hash: schemaHash,
      signature: parsed.manifest.signature,
      template_type: parsed.manifest.template_type,
      field_count: parsed.manifest.field_count,
      logistics_count: parsed.manifest.shipping_channels.length,
      category_count: parsed.manifest.category_count,
      manifest_json: JSON.stringify(parsed.manifest),
      status: versionStatus,
      has_sensitive_data: sensitiveSheets.length > 0,
      sensitive_summary: JSON.stringify(sensitiveSheets),
      approved_by: request.auth.username,
      approved_at: new Date().toISOString(),
    }, parsed.manifest.fields, parsed.categories, userMeta);
  } catch (err) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM ews_shopee_template_version_categories WHERE version_id=?").bind(versionId),
      env.DB.prepare("DELETE FROM ews_shopee_template_fields WHERE version_id=?").bind(versionId),
      env.DB.prepare("DELETE FROM ews_shopee_template_versions WHERE id=?").bind(versionId),
      env.DB.prepare("DELETE FROM ews_shopee_template_profiles WHERE id=? AND current_version_id IS NULL AND NOT EXISTS (SELECT 1 FROM ews_shopee_template_versions WHERE profile_id=?)").bind(profileId, profileId),
    ]).catch(() => {});
    await env.R2.delete(r2Key).catch(() => {});
    const concurrentVersion = await shopeeGetTemplateVersionByHash(env, profileId, sha256).catch(() => null);
    const concurrentProfile = concurrentVersion ? await shopeeGetTemplateProfile(env, profileId, request.auth.username).catch(() => null) : null;
    if (concurrentVersion && concurrentProfile?.current_version_id === concurrentVersion.id) {
      await shopeeUpdateTemplateUserMeta(env, profileId, request.auth.username, userMeta);
      const serializedConcurrent = serializeShopeeTemplateProfile(concurrentProfile, concurrentVersion);
      return json({
        success: true,
        duplicate: true,
        unchanged: true,
        profile: serializedConcurrent,
        store: serializedConcurrent,
        message: '模板已由并发请求更新，无需重复保存',
      });
    }
    console.error('Shopee template save failed:', err.message);
    return error('模板保存失败，请稍后重试', 503);
  }
  const savedProfile = await shopeeGetTemplateProfile(env, profileId, request.auth.username);
  const savedVersion = await shopeeGetTemplateVersion(env, versionId);
  const serialized = serializeShopeeTemplateProfile(savedProfile, savedVersion);
  const warnings = [];
  const retainedVersionIds = new Set([versionId, currentVersion?.id].filter(Boolean));
  const versions = (await shopeeGetTemplateProfileVersions(env, profileId))?.results || [];
  const staleVersions = versions.filter(version => !retainedVersionIds.has(version.id));
  const deletedVersions = await shopeeDeleteTemplateVersions(env, profileId, staleVersions, versionId);
  const r2CleanupFailures = await deleteShopeeTemplateVersionObjects(env, deletedVersions);
  const cleanupFailures = r2CleanupFailures;
  if (cleanupFailures) warnings.push(`${cleanupFailures} 个过期模板对象清理失败，已记录服务器日志`);
  if (sensitiveSheets.length) warnings.push(`检测到非空隐藏表：${sensitiveSheets.map(sheet => sheet.name).join('、')}，已记录风险标记`);
  if (parsed.manifest.unknown_optional_tokens?.length) warnings.push(`存在 ${parsed.manifest.unknown_optional_tokens.length} 个未知可选 token，导出时将留空`);
  return json({
    success: true,
    updated: !!currentVersion,
    profile: serialized,
    store: serialized,
    review_required: false,
    warnings,
    message: currentVersion ? '检测到模板更新，已替换当前版本并保留上一版本' : '模板已通过结构推理并成为当前版本',
  }, 201);
}

async function handleUpdateShopeeTemplateMeta(request, env, path) {
  const profileId = shopeeTemplateProfileIdFromPath(path);
  const profile = await shopeeGetTemplateProfile(env, profileId, request.auth.username);
  if (!profile || profile.status === 'deleted') return error('模板档案不存在', 404);
  let meta;
  try { meta = normalizeShopeeTemplateUserMeta(await parseBody(request) || {}, profile); }
  catch (err) { return error(err.message, 400); }
  await shopeeUpdateTemplateUserMeta(env, profileId, request.auth.username, meta);
  const refreshed = await shopeeGetTemplateProfile(env, profileId, request.auth.username);
  return json({ success: true, profile: serializeShopeeTemplateProfile(refreshed), message: '个人别名和备注已更新' });
}

async function handleMapShopeeTemplateField(request, env, path) {
  if (request.auth?.role !== 'admin') return error('无权访问', 403);
  const parts = path.split('/');
  const profileId = decodeURIComponent(parts[4] || '');
  const versionId = decodeURIComponent(parts[6] || '');
  const token = decodeURIComponent(parts[8] || '');
  const semanticKey = String((await parseBody(request))?.semantic_key || '').trim();
  if (!SHOPEE_TEMPLATE_SEMANTIC_KEYS.includes(semanticKey) && !/^channel_id\.\d+$/.test(semanticKey)) return error('语义字段不在系统 token 注册表中', 400);
  const version = await shopeeGetTemplateVersion(env, versionId);
  if (!version || version.profile_id !== profileId) return error('模板版本不存在', 404);
  const fields = (await shopeeGetTemplateFields(env, versionId))?.results || [];
  if (!fields.some(field => field.token === token)) return error('模板字段不存在', 404);
  if (fields.some(field => field.token !== token && field.semantic_key === semanticKey)) return error('该语义字段已映射到当前版本的另一 token', 409);
  await shopeeMapTemplateField(env, versionId, token, semanticKey, request.auth.username);
  return json({ success: true, message: 'token 语义映射已保存' });
}

async function handleAdminUpdateShopeeTemplateProfile(request, env, path) {
  if (request.auth?.role !== 'admin') return error('无权访问', 403);
  const profileId = shopeeTemplateProfileIdFromPath(path);
  const profile = await shopeeGetTemplateProfile(env, profileId, request.auth.username);
  if (!profile) return error('模板档案不存在', 404);
  const body = await parseBody(request) || {};
  const systemName = String(body.system_name ?? profile.system_name).trim();
  if (!systemName || systemName.length > 80) return error('系统名称必须为1~80字符', 400);
  const status = String(body.status || (profile.status === 'disabled' ? 'disabled' : 'active'));
  if (!['active', 'disabled'].includes(status)) return error('档案状态仅支持 active 或 disabled', 400);
  const approveVersionId = String(body.approve_version_id || '').trim();
  if (approveVersionId) {
    const version = await shopeeGetTemplateVersion(env, approveVersionId);
    if (!version || version.profile_id !== profileId || version.deleted_at) return error('待审核版本不存在', 404);
    const unmappedCount = await shopeeCountUnmappedRequiredFields(env, approveVersionId);
    if (unmappedCount) return error(`仍有 ${unmappedCount} 个未知必填 token 未映射`, 409);
    if (Number(version.has_sensitive_data || 0) === 1 && !isEnabled(body.confirm_sensitive)) return error('该版本含店铺私有隐藏数据，必须明确确认后才能共享', 409);
    await shopeeApproveTemplateVersion(env, profileId, approveVersionId, request.auth.username);
  }
  const current = await shopeeGetCurrentTemplateVersion(env, profileId);
  if (status === 'active' && !current) return error('档案没有已批准版本，不能启用', 409);
  await shopeeUpdateTemplateProfile(env, profileId, systemName, status);
  const refreshed = await shopeeGetTemplateProfile(env, profileId, request.auth.username);
  return json({ success: true, profile: serializeShopeeTemplateProfile(refreshed), message: approveVersionId ? '模板版本已审核并启用' : '模板档案已更新' });
}

async function handleDeleteShopeeTemplateProfile(request, env, path, url) {
  if (request.auth?.role !== 'admin') return error('无权访问', 403);
  const profileId = shopeeTemplateProfileIdFromPath(path);
  const profile = await shopeeGetTemplateProfile(env, profileId, request.auth.username);
  if (!profile) return error('模板档案不存在', 404);
  if (url.searchParams.get('purge') !== '1') {
    await shopeeSoftDeleteTemplateProfile(env, profileId);
    return json({ success: true, message: '模板档案已软删除，历史任务仍可使用保留版本导出' });
  }
  if (profile.status !== 'deleted' || !profile.deleted_at) return error('只能彻底清理已软删除的模板档案', 409);
  const deletedAt = new Date(`${String(profile.deleted_at).replace(' ', 'T')}Z`).getTime();
  if (!Number.isFinite(deletedAt) || Date.now() - deletedAt < 30 * 86400000) return error('模板档案软删除后需保留30天', 409);
  if (await shopeeGetTemplateProfileTaskCount(env, profileId)) return error('仍有任务引用该模板档案，禁止彻底清理', 409);
  const versions = (await shopeeGetTemplateProfileVersions(env, profileId))?.results || [];
  try { await Promise.all(versions.map(version => env.R2.delete(version.r2_key))); }
  catch (err) { return error('R2 原始模板清理失败，D1 记录已保留', 503); }
  await shopeePurgeTemplateProfile(env, profileId);
  return json({ success: true, message: '模板档案、保留版本和 R2 原始文件已清理' });
}

// ========== 用户管理 ==========

async function handleGetUsers(request, env) {
  if (request.auth?.role !== 'admin') return error('无权访问', 403);
  const result = await getUserList(env);
  return json({ success: true, users: (result?.results || []).map(u => ({
    id: u.id, username: u.username, role: u.role, display_name: u.display_name,
    platform_access: u.role === 'admin' ? 'allow' : normalizePlatformAccess(u.platform_access),
    image_concurrency_limit: normalizeUserImageConcurrencyLimit(u.image_concurrency_limit),
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
  const requestedConcurrency = body?.image_concurrency_limit;
  if (requestedConcurrency !== undefined && (!Number.isInteger(Number(requestedConcurrency)) || Number(requestedConcurrency) < 1 || Number(requestedConcurrency) > 20)) return error('图片并发上限必须为1~20', 400);
  await createUser(env, { id: username, username, password_hash: pwdHash, role: role === 'admin' ? 'admin' : 'user', platform_access: normalizePlatformAccess(body?.platform_access), image_concurrency_limit: requestedConcurrency, created_by: request.auth.username });
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

async function handleUpdateUserConcurrency(request, env, path) {
  if (request.auth?.role !== 'admin') return error('无权访问', 403);
  const userId = path.split('/')[3];
  const body = await parseBody(request);
  const limit = Number(body?.image_concurrency_limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) return error('图片并发上限必须为1~20', 400);
  const user = await getUserByUsername(env, userId);
  if (!user) return error('用户不存在', 404);
  await updateUserImageConcurrencyLimit(env, user.id, limit);
  return json({ success: true, image_concurrency_limit: limit, message: '用户图片并发上限已更新' });
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
const MAX_SKU_IMAGE_PROMPT_LENGTH = 300;
const SKU_RANDOM_ID_LENGTH = 8;
const SKU_PREFIX_LENGTH = SKU_RANDOM_ID_LENGTH + 1;
const JST_SKU_MAX_LENGTH = 80;
const SHOPEE_SKU_MAX_LENGTH = 99;
const JST_USER_SKU_MAX_LENGTH = JST_SKU_MAX_LENGTH - SKU_PREFIX_LENGTH;
const SHOPEE_USER_SKU_MAX_LENGTH = SHOPEE_SKU_MAX_LENGTH - SKU_PREFIX_LENGTH;
const SHOPEE_DESCRIPTION_MIN_LENGTH = 100;
const SHOPEE_DESCRIPTION_MAX_LENGTH = 3000;
const SHOPEE_PREORDER_BLOCKED_CHANNEL_IDS = Object.freeze(['5012']);
const JST_TEMPLATE_COLUMNS = Object.freeze([
  '款式编码','商品编码','颜色','规格','商品主图','商品详情图','图片地址','商品名称','推荐文案','商品描述','宝贝链接',
  '库存','重量(kg)','基本售价','市场|吊牌价','最低分销控价','最高分销控价','供应商名','3:4主图','长图','透明素材图','白底图',
]);

function normalizeShopeeVariationImageMode(value, fallback = 'upload') {
  if (value === 'option1') return 'ai';
  return ['upload','ai','none'].includes(value) ? value : fallback;
}

function normalizeShopeeProductType(value, variations) {
  if (['single','one','two'].includes(value)) return value;
  return (variations || []).some(variation => String(variation?.option2 || '').trim()) ? 'two' : 'one';
}

function normalizeShopeeShippingChannels(value, allowedChannels = null) {
  let channels = value;
  if (typeof channels === 'string') {
    try { channels = JSON.parse(channels); } catch (_) { channels = []; }
  }
  const allowed = Array.isArray(allowedChannels) ? new Set(allowedChannels.map(String)) : null;
  return [...new Set((Array.isArray(channels) ? channels : []).map(String).filter(channel => /^\d+$/.test(channel) && (!allowed || allowed.has(channel))))];
}

function normalizeShopeePreOrderShippingChannels(channels, preOrderDts) {
  if (preOrderDts === null || preOrderDts === undefined || preOrderDts === '') return channels;
  return channels.filter(channel => !SHOPEE_PREORDER_BLOCKED_CHANNEL_IDS.includes(channel));
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
      group = { key, name: variation.option1 || '', image: variation.image_per_variation || '', description: variation.sku_description || '', variations: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    if (!group.image && variation.image_per_variation) group.image = variation.image_per_variation;
    if (!group.description && variation.sku_description) group.description = variation.sku_description;
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
  if (value === 'option1') return 'ai';
  return value === 'ai' ? 'ai' : 'upload';
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

function isGeneratedTaskImageKey(taskPrefix, key) {
  if (!key.startsWith(taskPrefix)) return false;
  const relative = key.slice(taskPrefix.length);
  const parts = relative.split('/');
  return parts.length === 2
    && /^[A-Za-z0-9_-]+$/.test(parts[0])
    && /^(main|sub|detail|sku)_\d+(?:_[A-Za-z0-9_-]+)?\.jpg$/.test(parts[1]);
}

async function deleteGeneratedTaskObjects(env, taskId) {
  const safeTaskId = String(taskId || '').replace(/[^A-Za-z0-9_-]/g, '_');
  const taskPrefix = `ews/${safeTaskId}/`;
  let cursor;
  let deleted = 0;
  do {
    const options = { prefix: taskPrefix };
    if (cursor) options.cursor = cursor;
    const objects = await env.R2.list(options);
    const keys = objects.objects.map(object => object.key).filter(key => isGeneratedTaskImageKey(taskPrefix, key));
    for (let index = 0; index < keys.length; index += 100) await env.R2.delete(keys.slice(index, index + 100));
    deleted += keys.length;
    cursor = objects.truncated ? objects.cursor : undefined;
  } while (cursor);
  return deleted;
}

async function resetGeneratedTaskArtifacts(env, taskId, platform) {
  const prefix = platform === 'shopee' ? 'ews_shopee' : 'ews_jst';
  const deletedObjects = await deleteGeneratedTaskObjects(env, taskId);
  if (deletedObjects > 0) console.log('reset task generated images deleted:', taskId, deletedObjects);
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
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit')) || 10, 1), 100);
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

async function handleGetTaskDetail(env, ctx, path, idx) {
  const taskId = getTaskId(path);
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

async function handleUpdateTask(request, env, path, idx) {
  const taskId = getTaskId(path);
  const body = await parseBody(request);

  if (idx.platform === 'shopee') {
    const { template_profile_id, store_id, name, source_brief, product_type, main_description, reference_title, reference_image, auxiliary_images, generate_count, mode, category_id, cover_image, images, length_cm, width_cm, height_cm, gtin, variation_name1, variation_name2, variation_image_mode, size_chart_template_id, size_chart_image, pre_order_dts, shipping_channels, variations } = body || {};
    const taskName = String(name || '').trim();
    if (!taskName) return error('任务名称不能为空', 400);
    if (taskName.length > 30) return error('任务名称不能超过30字符', 400);
    const templateProfileId = String(template_profile_id || store_id || '').trim();
    if (!templateProfileId) return error('请选择 Shopee 全局模板档案', 400);
    const templateProfile = await shopeeGetTemplateProfile(env, templateProfileId, idx.user_id);
    if (!templateProfile || templateProfile.status !== 'active' || templateProfile.deleted_at) return error('所选 Shopee 模板档案不存在或不可用', 400);
    const templateVersion = await shopeeGetCurrentTemplateVersion(env, templateProfileId);
    if (!templateVersion || templateVersion.status !== 'ready') return error('所选模板档案没有已批准版本', 400);
    const templateManifest = parseJson(templateVersion.manifest_json, {});
    const templateShipping = Array.isArray(templateManifest.shipping_channels) ? templateManifest.shipping_channels : [];
    const allowedShippingIds = templateShipping.map(channel => String(channel.id));
    if (!allowedShippingIds.length) return error('店铺模板没有可用物流渠道，请重新上传模板', 400);
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
    const variationImageMode = normalizeShopeeVariationImageMode(variation_image_mode, 'upload');
    const normalizedImageMode = productType === 'single' ? 'none' : variationImageMode;
    const normalizedVariations = [];
    const combinationKeys = new Set();
    const skuCodes = new Set();
    let lowestPrice = Infinity;
    let highestPrice = 0;
    for (let i = 0; i < variations.length; i++) {
      const v = variations[i];
      const pricing = normalizeVariantPricing(v, true);
      if (pricing.error) return error('变体#' + (i + 1) + pricing.error, 400);
      const stock = v.stock === undefined || v.stock === null || v.stock === '' ? 999 : Number(v.stock);
      if (!Number.isInteger(stock) || stock < 0 || stock > 10000000) return error(`变体#${i + 1}库存必须为0~10000000`, 400);
      const weightKg = v.weight_kg === undefined || v.weight_kg === null || v.weight_kg === '' ? 0.2 : Number(v.weight_kg);
      if (!Number.isFinite(weightKg) || weightKg <= 0 || weightKg * 1000 > 100000000) return error(`变体#${i + 1}重量必须大于0且导出后不超过100000000g`, 400);
      const sku = String(v.sku || '').trim();
      if (sku.length > SHOPEE_USER_SKU_MAX_LENGTH) return error(`变体#${i + 1}商家SKU不能超过${SHOPEE_USER_SKU_MAX_LENGTH}字符（系统会添加${SKU_PREFIX_LENGTH}字符随机前缀）`, 400);
      const skuKey = sku.toLocaleLowerCase();
      if (skuKey && skuCodes.has(skuKey)) return error(`变体#${i + 1}商家SKU重复`, 400);
      if (skuKey) skuCodes.add(skuKey);
      const skuDescription = normalizedImageMode === 'ai' ? String(v.sku_description || '').trim() : '';
      if (skuDescription.length > MAX_SKU_IMAGE_PROMPT_LENGTH) return error(`变体#${i + 1}SKU图片提示词不能超过${MAX_SKU_IMAGE_PROMPT_LENGTH}字符`, 400);
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
        stock, sku, sku_description: skuDescription, weight_kg: weightKg,
      });
    }
    if (highestPrice / lowestPrice > 5) return error('最高SKU价格除以最低SKU价格不能超过5', 400);
    const hasTier2 = normalizedVariations.some(variation => variation.option2);
    if (productType === 'one' && hasTier2) return error('一维规格不能填写二级规格值', 400);
    if (productType === 'one' && normalizedVariations.length > 20) return error('一维规格最多20个规格值', 400);
    if (productType === 'two' && (!variationName2 || variationName2.length > 14)) return error('二维规格的二级规格名必须为1~14字符', 400);
    if (productType === 'two' && normalizedVariations.some(variation => !variation.option2)) return error('二维规格下每个SKU组合都必须填写二级规格值', 400);
    const variationGroups = getShopeeVariationGroups(normalizedVariations, normalizedImageMode);
    if (normalizedImageMode !== 'none') {
      for (const group of variationGroups) {
        const imageUrls = [...new Set(group.variations.map(variation => variation.image_per_variation).filter(Boolean))];
        if (imageUrls.length !== 1) return error(`一级规格值“${group.name}”必须且只能上传一张${normalizedImageMode === 'ai' ? 'SKU参考图' : 'SKU成品图'}`, 400);
        const prompts = [...new Set(group.variations.map(variation => variation.sku_description).filter(Boolean))];
        if (prompts.length > 1) return error(`一级规格值“${group.name}”只能配置一套SKU图片提示词`, 400);
        for (const variation of group.variations) {
          variation.image_per_variation = imageUrls[0];
          variation.sku_description = prompts[0] || '';
        }
      }
    }
    const dimensions = [length_cm, width_cm, height_cm].map(parseNumberOrNull);
    const dimensionCount = dimensions.filter(value => value !== null).length;
    if (dimensionCount !== 0 && dimensionCount !== 3) return error('长、宽、高必须同时填写或全部留空', 400);
    if (dimensions.some(value => value !== null && (value <= 0 || value > 10000000))) return error('长、宽、高必须大于0且不超过10000000', 400);
    const preOrderDts = pre_order_dts === undefined || pre_order_dts === null || pre_order_dts === '' ? null : parseInt(pre_order_dts);
    const requestedChannels = normalizeShopeeShippingChannels(shipping_channels);
    const unsupportedChannels = requestedChannels.filter(channel => !allowedShippingIds.includes(channel));
    if (unsupportedChannels.length) return error('当前店铺模板不支持物流渠道: ' + unsupportedChannels.join(', '), 400);
    const rawChannels = normalizeShopeeShippingChannels(requestedChannels, allowedShippingIds);
    const channels = normalizeShopeePreOrderShippingChannels(rawChannels, preOrderDts);
    if (!channels.length) {
      if (preOrderDts !== null && rawChannels.some(channel => SHOPEE_PREORDER_BLOCKED_CHANNEL_IDS.includes(channel))) return error('预售商品不能使用5012 / Trong Ngày，请至少选择其他物流渠道', 400);
      return error('至少选择一个物流渠道', 400);
    }
    for (const channel of channels) {
      const channelLimit = Number(templateShipping.find(item => String(item.id) === channel)?.price_limit);
      if (Number.isFinite(channelLimit) && channelLimit > 0 && highestPrice > channelLimit) return error(`物流渠道${channel}允许的最高价格为${channelLimit}`, 400);
    }
    const sizeChartTemplate = String(size_chart_template_id || '').trim();
    const sizeChartImage = String(size_chart_image || '').trim();
    if (sizeChartTemplate && sizeChartImage) return error('尺码表模板和尺码表图片只能填写一个', 400);
    if (preOrderDts !== null && (!Number.isInteger(preOrderDts) || preOrderDts < 5 || preOrderDts > 30)) return error('预售DTS必须为5~30天', 400);
    const categoryId = String(category_id || '').trim();
    if (categoryId && !/^\d+$/.test(categoryId)) return error('Category ID 必须为数字', 400);
    const templateCategory = categoryId ? await shopeeGetTemplateCategory(env, templateVersion.id, categoryId) : null;
    if (categoryId && !templateCategory) return error('所选 Category ID 不在当前模板版本中', 400);
    if (preOrderDts !== null && templateCategory?.dts_min !== null && templateCategory?.dts_min !== undefined) {
      if (preOrderDts < Number(templateCategory.dts_min) || preOrderDts > Number(templateCategory.dts_max)) {
        return error(`该分类的 Pre-order DTS 范围为 ${templateCategory.dts_range}`, 400);
      }
    }
    await env.DB.prepare("UPDATE ews_tasks SET name=?, status='pending', updated_at=datetime('now') WHERE id=?").bind(taskName, taskId).run();
    await shopeeCreateProduct(env, {
      id: taskId, task_id: taskId, template_profile_id: templateProfileId, template_version_id: templateVersion.id, name: taskName, category_id: categoryId,
      source_brief: sourceBrief, product_type: productType,
      main_description: main_description || '',
      reference_title: String(reference_title || '').trim(),
      reference_image: reference_image || '', auxiliary_images: auxiliary_images || '[]',
      generate_count: shopeeGenerateCount,
      mode: mode === 'dedup' ? 'dedup' : 'full',
      main_image_count: 9, detail_image_count: 0,
      cover_image: cover_image || '', images: images || '[]',
      weight_kg: 0.2, length_cm: dimensions[0], width_cm: dimensions[1], height_cm: dimensions[2], gtin: gtin || '',
      variation_name1: productType === 'single' ? '' : variationName1, variation_name2: productType === 'two' ? variationName2 : '',
      variation_name1_export: '', variation_name2_export: '', variation_image_mode: normalizedImageMode,
      size_chart_template_id: sizeChartTemplate, size_chart_image: sizeChartImage, pre_order_dts: preOrderDts,
      shipping_channels: JSON.stringify(channels),
    });
    await shopeeReplaceVariations(env, taskId, normalizedVariations);
    return json({ success: true, task_id: taskId, message: '商品创建成功' });
  }

  if (idx.platform === 'jst') {
    const { name, topic_items, source_brief, description, recommended_copy, product_link, supplier_name, main_description, detail_description, auxiliary_images, reference_image, generate_count, stock, weight, product_type, variation_image_mode, variants, mode, main_image_count, detail_image_count } = body || {};
    if (!name) return error('任务名称不能为空', 400);
    if (!reference_image) return error('核心参考图不能为空', 400);
    const topicItems = String(topic_items || '').trim();
    if (topicItems.length > 1000) return error('参考标题不能超过1000字符', 400);
    const sourceBrief = String(source_brief ?? description ?? '').trim();
    if (sourceBrief.length < 10 || sourceBrief.length > 2000) return error('商品事实必须为10~2000字符', 400);
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
    const jstImageMode = normalizeJstVariationImageMode(variation_image_mode, productType);
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
      const minDistributionPrice = parseNumberOrNull(v.min_distribution_price);
      const maxDistributionPrice = parseNumberOrNull(v.max_distribution_price);
      for (const [raw,label,parsed] of [[v.min_distribution_price,'最低分销控价',minDistributionPrice],[v.max_distribution_price,'最高分销控价',maxDistributionPrice]]) {
        if (raw !== undefined && raw !== null && raw !== '' && parsed === null) return error(`变体#${i + 1}${label}必须为数字`, 400);
      }
      if ([minDistributionPrice,maxDistributionPrice].some(value => value !== null && value < 0)) return error(`变体#${i + 1}分销控价不能小于0`, 400);
      if (minDistributionPrice !== null && maxDistributionPrice !== null && maxDistributionPrice < minDistributionPrice) return error(`变体#${i + 1}最高分销控价不能低于最低分销控价`, 400);
      const skuCode = String(v.sku_code || v.sku || '').trim();
      if (skuCode.length > JST_USER_SKU_MAX_LENGTH) return error(`变体#${i + 1}商家SKU不能超过${JST_USER_SKU_MAX_LENGTH}字符（系统会添加${SKU_PREFIX_LENGTH}字符随机前缀）`, 400);
      if (skuCode && skuCodes.has(skuCode.toLocaleLowerCase())) return error(`变体#${i + 1}商家SKU重复`, 400);
      if (skuCode) skuCodes.add(skuCode.toLocaleLowerCase());
      const skuDescription = jstImageMode === 'ai' ? String(v.sku_description || '').trim() : '';
      if (skuDescription.length > MAX_SKU_IMAGE_PROMPT_LENGTH) return error(`变体#${i + 1}SKU图片提示词不能超过${MAX_SKU_IMAGE_PROMPT_LENGTH}字符`, 400);
      normalizedVariants.push({
        id: v.id || uuid(), task_id: taskId,
        tier1_name: tier1Name, tier1_value: tier1Value,
        tier2_name: tier2Name, tier2_value: tier2Value,
        sku_image: productType === 'single' ? '' : String(v.sku_image || ''),
        price: pricing.price, price_float_enabled: pricing.price_float_enabled,
        price_min: pricing.price_min, price_max: pricing.price_max, price_precision: pricing.price_precision,
        market_price: null, min_distribution_price: minDistributionPrice, max_distribution_price: maxDistributionPrice,
        stock: variantStock, sku_code: skuCode,
        description: skuDescription, sort_order: i,
      });
    }
    if (productType !== 'single' && new Set(normalizedVariants.map(variant => variant.tier1_name)).size !== 1) return error('全部SKU必须使用相同的一级规格名', 400);
    if (productType === 'two' && new Set(normalizedVariants.map(variant => variant.tier2_name)).size !== 1) return error('全部SKU必须使用相同的二级规格名', 400);
    if (jstImageMode !== 'none') {
      for (const group of getJstVariationGroups(normalizedVariants)) {
        const imageUrls = [...new Set(group.variations.map(variation => variation.sku_image).filter(Boolean))];
        if (imageUrls.length !== 1) return error(`一级规格值“${group.name}”必须且只能上传一张${jstImageMode === 'ai' ? 'SKU参考图' : 'SKU成品图'}`, 400);
        const prompts = [...new Set(group.variations.map(variation => variation.description).filter(Boolean))];
        if (prompts.length > 1) return error(`一级规格值“${group.name}”只能配置一套SKU图片提示词`, 400);
        for (const variation of group.variations) {
          variation.sku_image = imageUrls[0];
          variation.description = prompts[0] || '';
        }
      }
    }

    await jstUpdateTask(env, taskId, {
      name: String(name).slice(0, 30), topic_items: topicItems, source_brief: sourceBrief, description: productDescription,
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

async function handleDeleteTask(env, path, idx) {
  const taskId = getTaskId(path);
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

async function handleUpdateTaskStatus(request, env, path, idx) {
  const taskId = getTaskId(path);
  const body = await parseBody(request);
  const { status } = body || {};
  if (!['pending','processing','completed','failed','partial_failed'].includes(status)) return error('无效的状态值', 400);
  if (idx.platform === 'jst') await jstUpdateTaskStatus(env, taskId, status);
  if (idx.platform === 'shopee') await env.DB.prepare("UPDATE ews_shopee_products SET status=?, updated_at=datetime('now') WHERE id=?").bind(status, taskId).run();
  await updateTaskIndexStatus(env, taskId, status);
  return json({ success: true, message: '状态更新成功' });
}

// ========== JST 推送 ==========

async function handlePushTask(env, ctx, path, request, idx) {
  const taskId = getTaskId(path);
  if (idx.platform === 'jst') return jstHandlePush(env, taskId, ctx, request);
  if (idx.platform === 'shopee') return shopeeHandlePush(env, taskId, ctx, request);
  return error('不支持的平台', 400);
}

function buildJstMetadataBatches(subTasks, variants, productType) {
  const metadataVariants = productType === 'single' ? [] : variants.map(variant => ({
    id: variant.id,
    option1: variant.tier1_value || '',
    option2: variant.tier2_value || '',
    tier1_name: variant.tier1_name || '',
    tier2_name: variant.tier2_name || '',
  }));
  const batches = [];
  let products = [];
  let skuTitleCount = 0;
  for (const subTask of subTasks) {
    const exceedsProductLimit = products.length >= 10;
    const exceedsSkuLimit = metadataVariants.length > 0 && skuTitleCount + metadataVariants.length > 100;
    if (products.length > 0 && (exceedsProductLimit || exceedsSkuLimit)) {
      batches.push({ products, variants: metadataVariants });
      products = [];
      skuTitleCount = 0;
    }
    products.push(subTask);
    skuTitleCount += metadataVariants.length;
  }
  if (products.length > 0) batches.push({ products, variants: metadataVariants });
  return batches;
}

function deduplicatedPlanCount(enabled, countPerSet, generateCount, mode) {
  if (!enabled || countPerSet < 1) return 0;
  return countPerSet * (mode === 'dedup' ? 1 : generateCount);
}

async function pushCreditPreflightError(env, ownerId, requiredCredits) {
  if (!ownerId || requiredCredits < 1) return '';
  const availableCredits = await getUserCredits(env, ownerId);
  if (availableCredits >= requiredCredits) return '';
  return `算力不足：本次预计需要${requiredCredits}点，当前可用${availableCredits}点`;
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
  const ownerId = taskOwner?.user_id || request.auth?.username || '';
  const pushUser = await getUserByUsername(env, ownerId);
  applyUserWorkflowOverrides(config, pushUser?.webhook_config, 'jst');
  const workflowFlags = workflowExecutionFlags(config);
  const callbackSecret = config.callback_secret || '';
  const baseUrl = `${new URL(request.url).origin}/api/callback`;
  const metadataWebhookUrl = workflowFlags.title ? config.n8n_title_webhook || '' : '';
  const skuImageWebhookUrl = workflowFlags.skuImage ? config.n8n_sku_image_webhook || '' : '';
  const mainWebhookUrl = config.n8n_main_webhook || '';
  const subImageWebhookUrl = config.n8n_sub_image_webhook || '';
  const detailWebhookUrl = workflowFlags.detail ? config.n8n_detail_webhook || '' : '';
  const mainImageCount = Math.min(Math.max(detail.main_image_count || 5, 1), 9);
  const detailImageCount = Math.min(Math.max(detail.detail_image_count || 5, 1), 9);
  const generateCount = detail.generate_count || 1;
  const productType = normalizeJstProductType(detail.product_type, detail.variants || []);
  const variationImageMode = normalizeJstVariationImageMode(detail.variation_image_mode, productType);
  const variationGroups = productType === 'single' ? [] : getJstVariationGroups(detail.variants || []);
  const skuImageGroups = variationImageMode === 'ai' ? variationGroups : [];

  const missingEnabledWebhooks = [];
  if (workflowFlags.title && !metadataWebhookUrl) missingEnabledWebhooks.push('商品元数据');
  if (workflowFlags.skuImage && skuImageGroups.length > 0 && !skuImageWebhookUrl) missingEnabledWebhooks.push('SKU图片');
  if (missingEnabledWebhooks.length) return error('请先配置已开启的 JST 工作流 Webhook: ' + missingEnabledWebhooks.join('、'), 400);
  if (!metadataWebhookUrl && !mainWebhookUrl && !subImageWebhookUrl && !detailWebhookUrl && !skuImageWebhookUrl)
    return error('请先在系统配置页配置 JST 工作流 Webhook 地址后再推送', 400);

  const mode = detail.mode || 'full';
  const metadataSubTasks = Array.from({ length: generateCount }, (_, index) => ({ sub_task_id: String(index), set_index: index }));
  const requiredCredits = (metadataWebhookUrl ? buildJstMetadataBatches(metadataSubTasks, detail.variants || [], productType).length : 0)
    + (mainWebhookUrl ? generateCount : 0)
    + deduplicatedPlanCount(!!subImageWebhookUrl, Math.max(0, mainImageCount - 1), generateCount, mode)
    + deduplicatedPlanCount(!!detailWebhookUrl, detailImageCount, generateCount, mode)
    + deduplicatedPlanCount(!!skuImageWebhookUrl, skuImageGroups.length, generateCount, mode);
  if (!testMode) {
    const creditError = await pushCreditPreflightError(env, ownerId, requiredCredits);
    if (creditError) return error(creditError, 400);
  }

  await resetGeneratedTaskArtifacts(env, taskId, 'jst');

  const subTaskIds = [];
  for (let i = 0; i < generateCount; i++) {
    const subId = uuid(); subTaskIds.push(subId);
    await jstCreateSubTask(env, { id: subId, parent_task_id: taskId, set_index: i });
    await jstCreateExpectedImages(env, taskId, subId, i, skuImageGroups.length, mode, mainImageCount, detailImageCount,
      !!mainWebhookUrl, !!subImageWebhookUrl, !!detailWebhookUrl, !!skuImageWebhookUrl);
  }
  await env.DB.prepare("UPDATE ews_jst_tasks SET status='processing', queue_mode='auto', updated_at=datetime('now') WHERE id=?").bind(taskId).run();
  const subTasks = subTaskIds.map((id, i) => ({ sub_task_id: id, set_index: i, style_code: id.slice(0, 8) }));
  const allJobs = [];

  if (metadataWebhookUrl) {
    const metadataBatches = buildJstMetadataBatches(subTasks, detail.variants || [], productType);
    for (let batchIndex = 0; batchIndex < metadataBatches.length; batchIndex++) {
      const batch = metadataBatches[batchIndex];
      const planId = uuid();
      allJobs.push({ plan_id: planId, webhook_type: 'metadata', sub_task_id: batch.products[0]?.sub_task_id || '', url: metadataWebhookUrl,
        data: { task_id: taskId, plan_id: planId, batch_index: batchIndex, batch_total: metadataBatches.length,
          source_brief: detail.source_brief || detail.description || '', reference_title: detail.topic_items || '',
          product_type: productType, products: batch.products, variants: batch.variants,
          callback_secret: callbackSecret, callback_url: baseUrl } });
    }
  }
  // main_1
  if (mainWebhookUrl) for (const st of subTasks) allJobs.push({ webhook_type: 'main_1', sub_task_id: st.sub_task_id, url: mainWebhookUrl,
    data: { task_id: taskId, sub_task_id: st.sub_task_id, set_index: st.set_index, reference_image: detail.reference_image,
      main_description: detail.main_description || '', auxiliary_images: detail.auxiliary_images || '', image_type: 'main', image_position: 1, callback_secret: callbackSecret, callback_url: baseUrl } });
  // sub_2~N
  if (subImageWebhookUrl) for (let pos = 2; pos <= mainImageCount; pos++) for (const st of subTasks) {
    if (mode === 'dedup' && st.set_index > 0) continue;
    allJobs.push({ webhook_type: 'sub_' + pos, sub_task_id: st.sub_task_id, url: subImageWebhookUrl,
      data: { task_id: taskId, sub_task_id: st.sub_task_id, set_index: st.set_index, reference_image: detail.reference_image,
        main_description: detail.main_description || '', auxiliary_images: detail.auxiliary_images || '', image_type: 'sub', image_position: pos, callback_secret: callbackSecret, callback_url: baseUrl } });
  }
  // detail_1~M
  if (detailWebhookUrl) for (let pos = 1; pos <= detailImageCount; pos++) for (const st of subTasks) {
    if (mode === 'dedup' && st.set_index > 0) continue;
    allJobs.push({ webhook_type: 'detail_' + pos, sub_task_id: st.sub_task_id, url: detailWebhookUrl,
      data: { task_id: taskId, sub_task_id: st.sub_task_id, set_index: st.set_index, reference_image: detail.reference_image,
        detail_description: detail.detail_description || '', auxiliary_images: detail.auxiliary_images || '', image_type: 'detail', image_position: pos, callback_secret: callbackSecret, callback_url: baseUrl } });
  }
  // sku
  if (skuImageWebhookUrl && skuImageGroups.length > 0) for (const st of subTasks) {
    if (mode === 'dedup' && st.set_index > 0) continue;
    for (let v = 0; v < skuImageGroups.length; v++) {
      const group = skuImageGroups[v];
      allJobs.push({ webhook_type: 'sku_' + (v+1), sub_task_id: st.sub_task_id, url: skuImageWebhookUrl,
        data: { task_id: taskId, sub_task_id: st.sub_task_id, set_index: st.set_index,
          sku_image: group.image || '',
          sku_description: group.description || '', image_type: 'sku', image_position: v+1, callback_secret: callbackSecret, callback_url: baseUrl } });
    }
  }

  // 写入计划
  const planRecords = [];
  for (let bi = 0; bi < allJobs.length; bi++) {
    const j = allJobs[bi];
    const planId = j.plan_id || uuid();
    planRecords.push({ id: planId, task_id: taskId, sub_task_id: j.sub_task_id, webhook_type: j.webhook_type, webhook_url: j.url || '', user_id: ownerId,
      payload: JSON.stringify({ ...j.data, plan_id: planId, workflow_type: j.webhook_type }), batch_order: bi });
  }
  if (planRecords.length > 0) await jstCreatePushPlans(env, planRecords);

  if (testMode) {
    await env.DB.prepare("UPDATE ews_jst_tasks SET status='pending', queue_mode='manual', updated_at=datetime('now') WHERE id=?").bind(taskId).run();
    await updateTaskIndexStatus(env, taskId, 'pending');
    return json({ success: true, task_id: taskId, sub_tasks: subTasks, test_mode: true,
      total_plans: planRecords.length, jobs_count: planRecords.length, required_credits: requiredCredits,
      message: '测试模式：已创建 ' + subTasks.length + ' 个子任务、' + planRecords.length + ' 个推送计划' });
  }
  await updateTaskIndexStatus(env, taskId, 'processing');
  ctx.waitUntil(jstReleaseTaskQueue(env, taskId, ctx));
  return json({ success: true, task_id: taskId, sub_tasks: subTasks, total_plans: planRecords.length, jobs_count: planRecords.length, required_credits: requiredCredits,
    message: '已创建 ' + planRecords.length + ' 个推送计划' });
}

// ========== Shopee 推送（与 JST 对齐） ==========
async function shopeeHandlePush(env, taskId, ctx, request) {
  const body = await parseBody(request).catch(() => ({}));
  const testMode = body?.test_mode === true;
  const config = await getConfig(env, 'shopee');
  const taskOwner = await getOne(env, "SELECT user_id FROM ews_tasks WHERE id=?", [taskId]);
  const ownerId = taskOwner?.user_id || request.auth?.username || '';
  const pushUser = await getUserByUsername(env, ownerId);
  applyUserWorkflowOverrides(config, pushUser?.webhook_config, 'shopee');
  const workflowFlags = workflowExecutionFlags(config);
  const detail = await shopeeGetProduct(env, taskId);
  if (!detail) return error('商品不存在', 404);
  if (detail.status !== 'pending') return error('只能推送等待中的任务', 400);
  const productType = normalizeShopeeProductType(detail.product_type, detail.variations || []);
  const variationImageMode = normalizeShopeeVariationImageMode(detail.variation_image_mode, 'upload');
  const variantCombos = productType === 'single' ? [] : detail.variations || [];
  const variationGroups = getShopeeVariationGroups(variantCombos, variationImageMode);
  const skuImageGroups = variationImageMode === 'ai' ? variationGroups : [];
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

  const mainCount = 9;
  const generateCount = detail.generate_count || 1;
  const mode = detail.mode || 'full';
  const requiredCredits = (titleWebhookUrl ? 1 : 0)
    + (mainWebhookUrl ? generateCount : 0)
    + deduplicatedPlanCount(!!subImageWebhookUrl, mainCount - 1, generateCount, mode)
    + deduplicatedPlanCount(!!skuImageWebhookUrl, skuImageGroups.length, generateCount, mode);
  if (!testMode) {
    const creditError = await pushCreditPreflightError(env, ownerId, requiredCredits);
    if (creditError) return error(creditError, 400);
  }

  await resetGeneratedTaskArtifacts(env, taskId, 'shopee');

  const callbackSecret = config.callback_secret || '';
  const baseUrl = new URL(request.url).origin + '/api/callback';
  const refImg = detail.reference_image || '';
  const auxImgs = detail.auxiliary_images || '';

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
    data: { task_id: taskId, source_brief: detail.source_brief || '', reference_title: detail.reference_title || '',
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
        data: { task_id: taskId, sub_task_id: st.sub_task_id, set_index: st.set_index,
          sku_image: group.image,
          sku_description: group.description || '',
          image_type: 'sku', image_position: vi+1, callback_secret: callbackSecret, callback_url: baseUrl } });
    }
  }

  const planRecords = [];
  for (let bi = 0; bi < allJobs.length; bi++) {
    const j = allJobs[bi];
    const planId = uuid();
    planRecords.push({ id: planId, task_id: taskId, sub_task_id: j.sub_task_id, webhook_type: j.webhook_type, user_id: ownerId,
      webhook_url: j.url || '', payload: JSON.stringify({ ...j.data, plan_id: planId, workflow_type: j.webhook_type }), batch_order: bi });
  }
  if (planRecords.length > 0) await shopeeCreatePushPlans(env, planRecords);

  if (testMode) {
    await updateTaskIndexStatus(env, taskId, 'pending');
    await env.DB.prepare("UPDATE ews_shopee_products SET status='pending', updated_at=datetime('now') WHERE id=?").bind(taskId).run();
    return json({ success: true, task_id: taskId, sub_tasks: subTasks, test_mode: true, total_plans: planRecords.length, jobs_count: planRecords.length, required_credits: requiredCredits,
      message: '测试模式：已创建 ' + subTasks.length + ' 个子任务、' + planRecords.length + ' 个推送计划' });
  }
  ctx.waitUntil(shopeeReleaseTaskQueue(env, taskId, ctx));
  return json({ success: true, task_id: taskId, sub_tasks: subTasks, total_plans: planRecords.length, jobs_count: planRecords.length, required_credits: requiredCredits, message: '已创建 ' + planRecords.length + ' 个推送计划' });
}

function workflowPlanWhereClause(flags, alias = '') {
  const column = alias ? `${alias}.webhook_type` : 'webhook_type';
  if (flags.primaryImagesOnly) return ` AND (${column}='main' OR ${column}='main_1' OR ${column} LIKE 'sub_%')`;
  const conditions = [`${column}<>'sku_title'`];
  if (!flags.title) conditions.push(`${column}<>'title'`, `${column}<>'metadata'`);
  if (!flags.skuImage) conditions.push(`${column} NOT GLOB 'sku_[0-9]*'`);
  return conditions.length ? ` AND ${conditions.join(' AND ')}` : '';
}

const FAST_PLAN_RELEASE_BATCH = 10;
const JST_METADATA_CONCURRENCY = 2;
const MAX_QUEUE_USERS_PER_RUN = 100;
const MAX_QUEUE_DISPATCHES_PER_RUN = 100;
const QUEUE_USER_TURN_SIZE = 10;
const PUSH_PLAN_MAX_RETRIES = 3;
const PUSH_PLAN_RETRY_DELAYS_SECONDS = [30, 120, 300];

async function getPendingPlansForRelease(env, planTable, taskId, imageLimit, metadataLimit, flags, dispatchBudget) {
  const safeTable = normalizePushPlanTable(planTable);
  const workflowWhere = workflowPlanWhereClause(flags);
  const budget = Math.max(0, parseInt(dispatchBudget) || 0);
  if (budget < 1) return { results: [] };
  const fastLimit = Math.min(FAST_PLAN_RELEASE_BATCH, budget);
  const fast = await query(env, `SELECT * FROM ${safeTable}
    WHERE task_id=? AND status='pending' AND (next_retry_at='' OR next_retry_at<=datetime('now'))${workflowWhere} AND is_image=0 AND webhook_type<>'metadata'
    ORDER BY batch_order ASC, created_at ASC LIMIT ?`, [taskId, fastLimit]);
  const fastPlans = fast?.results || [];
  let remaining = Math.max(0, budget - fastPlans.length);
  const allowedMetadata = safeTable === 'ews_jst_push_plans' ? Math.min(Math.max(0, metadataLimit), remaining) : 0;
  let metadataPlans = [];
  if (allowedMetadata > 0) {
    const metadata = await query(env, `SELECT * FROM ${safeTable}
      WHERE task_id=? AND status='pending' AND (next_retry_at='' OR next_retry_at<=datetime('now'))${workflowWhere} AND webhook_type='metadata'
      ORDER BY batch_order ASC, created_at ASC LIMIT ?`, [taskId, allowedMetadata]);
    metadataPlans = metadata?.results || [];
    remaining = Math.max(0, remaining - metadataPlans.length);
  }
  const allowedImages = Math.min(Math.max(0, imageLimit), remaining);
  if (allowedImages < 1) return { results: fastPlans.concat(metadataPlans) };
  const images = await query(env, `SELECT * FROM ${safeTable}
    WHERE task_id=? AND status='pending' AND (next_retry_at='' OR next_retry_at<=datetime('now'))${workflowWhere} AND is_image=1
    ORDER BY batch_order ASC, created_at ASC LIMIT ?`, [taskId, allowedImages]);
  return { results: fastPlans.concat(metadataPlans, images?.results || []) };
}

async function shopeeReleaseTaskQueue(env, taskId, ctx, dispatchBudget) {
  try {
    return await releaseTaskPlans(env, 'ews_shopee_push_plans', 'shopee', taskId, ctx, dispatchBudget);
  } catch (err) { console.error('shopeeReleaseTaskQueue error:', err.message); }
  return 0;
}

async function pushToWebhook(url, data) {
  if (!url) {
    const missingUrl = new Error('Webhook地址未配置');
    missingUrl.retryable = false;
    throw missingUrl;
  }
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  if (!resp.ok) {
    const responseError = new Error('Webhook响应异常: HTTP ' + resp.status);
    responseError.retryable = resp.status === 408 || resp.status === 425 || resp.status === 429 || resp.status >= 500;
    throw responseError;
  }
  return true;
}

async function markPushPlanFailed(env, planTable, planId, message, expectedStatus = 'processing') {
  const safeTable = normalizePushPlanTable(planTable);
  const currentStatus = expectedStatus === 'pending' ? 'pending' : 'processing';
  const plan = await getOne(env, `SELECT task_id FROM ${safeTable} WHERE id=?`, [planId]);
  const result = await env.DB.prepare(`UPDATE ${safeTable}
    SET status='failed', retry_count=?, error=?, processing_at='', next_retry_at='', updated_at=datetime('now')
    WHERE id=? AND status=?`)
    .bind(PUSH_PLAN_MAX_RETRIES, message || '推送失败', planId, currentStatus).run();
  if (d1Changes(result) > 0 && plan?.task_id) await reconcileTaskStatusForPushPlans(env, safeTable, plan.task_id, message || '推送失败');
  return d1Changes(result) > 0;
}

async function refundTaskCredit(env, taskId) {
  const taskOwner = await getOne(env, "SELECT user_id FROM ews_tasks WHERE id=?", [taskId]);
  if (taskOwner?.user_id) await updateUserCredits(env, taskOwner.user_id, 1, 'add');
}

async function schedulePushPlanRetry(env, planTable, planId, taskId, retryCount, message) {
  const nextRetryCount = (parseInt(retryCount) || 0) + 1;
  if (nextRetryCount > PUSH_PLAN_MAX_RETRIES) return false;
  const safeTable = normalizePushPlanTable(planTable);
  const delaySeconds = PUSH_PLAN_RETRY_DELAYS_SECONDS[nextRetryCount - 1];
  const retryMessage = `${message || '推送失败'}；${delaySeconds}秒后自动重试 (${nextRetryCount}/${PUSH_PLAN_MAX_RETRIES})`;
  const result = await env.DB.prepare(`UPDATE ${safeTable}
    SET status='pending', retry_count=?, error=?, processing_at='', next_retry_at=datetime('now', ?), updated_at=datetime('now')
    WHERE id=? AND task_id=? AND status='processing'`)
    .bind(nextRetryCount, retryMessage, `+${delaySeconds} seconds`, planId, taskId).run();
  if (d1Changes(result) < 1) return false;
  await refundTaskCredit(env, taskId);
  return true;
}

async function completePushPlanFromCallback(env, planTable, taskId, webhookType, subTaskId = '') {
  const safeTable = normalizePushPlanTable(planTable);
  const subTaskClause = subTaskId ? ' AND sub_task_id=?' : '';
  const params = [taskId, webhookType];
  if (subTaskId) params.push(subTaskId);
  const completed = await env.DB.prepare(`UPDATE ${safeTable} SET status='done', error='', next_retry_at='', updated_at=datetime('now') WHERE task_id=? AND webhook_type=?${subTaskClause} AND status='processing'`).bind(...params).run();
  if (d1Changes(completed) > 0) return true;
  const donePlan = await getOne(env, `SELECT id FROM ${safeTable} WHERE task_id=? AND webhook_type=?${subTaskClause} AND status='done'`, params);
  if (donePlan) return true;
  const pendingPlan = await getOne(env, `SELECT id FROM ${safeTable} WHERE task_id=? AND webhook_type=?${subTaskClause} AND status='pending'`, params);
  if (pendingPlan) {
    const taskOwner = await getOne(env, "SELECT user_id FROM ews_tasks WHERE id=?", [taskId]);
    if (taskOwner?.user_id && !(await consumeUserCredit(env, taskOwner.user_id))) return false;
    const recovered = await env.DB.prepare(`UPDATE ${safeTable} SET status='done', error='Late callback accepted', next_retry_at='', updated_at=datetime('now') WHERE id=? AND status='pending'`).bind(pendingPlan.id).run();
    if (d1Changes(recovered) < 1 && taskOwner?.user_id) await updateUserCredits(env, taskOwner.user_id, 1, 'add');
    return d1Changes(recovered) > 0;
  }
  const timedOutPlan = await getOne(env, `SELECT id FROM ${safeTable} WHERE task_id=? AND webhook_type=?${subTaskClause} AND status='failed' AND error LIKE 'Push plan timed out after %'`, params);
  if (!timedOutPlan) return false;
  const taskOwner = await getOne(env, "SELECT user_id FROM ews_tasks WHERE id=?", [taskId]);
  if (taskOwner?.user_id && !(await consumeUserCredit(env, taskOwner.user_id))) return false;
  const recovered = await env.DB.prepare(`UPDATE ${safeTable} SET status='done', error='Late callback accepted', next_retry_at='', updated_at=datetime('now') WHERE id=? AND status='failed' AND error LIKE 'Push plan timed out after %'`).bind(timedOutPlan.id).run();
  if (d1Changes(recovered) < 1 && taskOwner?.user_id) await updateUserCredits(env, taskOwner.user_id, 1, 'add');
  return d1Changes(recovered) > 0;
}

async function completePushPlanByIdFromCallback(env, planTable, taskId, planId) {
  const safeTable = normalizePushPlanTable(planTable);
  const plan = await getOne(env, `SELECT id, status FROM ${safeTable} WHERE id=? AND task_id=?`, [planId, taskId]);
  if (!plan) return false;
  if (plan.status === 'done') return true;
  if (plan.status === 'processing') {
    const completed = await env.DB.prepare(`UPDATE ${safeTable}
      SET status='done', error='', processing_at='', next_retry_at='', updated_at=datetime('now')
      WHERE id=? AND task_id=? AND status='processing'`).bind(planId, taskId).run();
    return d1Changes(completed) > 0;
  }
  const acceptsLateCallback = plan.status === 'pending' || plan.status === 'failed';
  if (!acceptsLateCallback) return false;
  const taskOwner = await getOne(env, "SELECT user_id FROM ews_tasks WHERE id=?", [taskId]);
  if (taskOwner?.user_id && !(await consumeUserCredit(env, taskOwner.user_id))) return false;
  const recovered = await env.DB.prepare(`UPDATE ${safeTable}
    SET status='done', error='Late callback accepted', processing_at='', next_retry_at='', updated_at=datetime('now')
    WHERE id=? AND task_id=? AND status=?`).bind(planId, taskId, plan.status).run();
  if (d1Changes(recovered) < 1 && taskOwner?.user_id) await updateUserCredits(env, taskOwner.user_id, 1, 'add');
  return d1Changes(recovered) > 0;
}

async function getUserImageActiveCount(env, userId) {
  const active = await getOne(env, `SELECT
    ((SELECT COUNT(*) FROM ews_jst_push_plans WHERE user_id=? AND status='processing' AND is_image=1)
    + (SELECT COUNT(*) FROM ews_shopee_push_plans WHERE user_id=? AND status='processing' AND is_image=1)) AS cnt`, [userId, userId]);
  return active?.cnt || 0;
}

async function getUserMetadataActiveCount(env, userId) {
  const active = await getOne(env, `SELECT COUNT(*) AS cnt FROM ews_jst_push_plans
    WHERE user_id=? AND status='processing' AND webhook_type='metadata'`, [userId]);
  return active?.cnt || 0;
}

async function claimPushPlan(env, planTable, plan, taskId, userId, imageConcurrencyLimit) {
  const safeTable = normalizePushPlanTable(planTable);
  if (safeTable === 'ews_jst_push_plans' && plan.webhook_type === 'metadata') {
    const claim = await env.DB.prepare(`UPDATE ${safeTable}
      SET status='processing', error='', processing_at=datetime('now'), next_retry_at='', updated_at=datetime('now')
      WHERE id=? AND task_id=? AND status='pending' AND (next_retry_at='' OR next_retry_at<=datetime('now'))
      AND (SELECT COUNT(*) FROM ews_jst_push_plans WHERE user_id=? AND status='processing' AND webhook_type='metadata') < ?`)
      .bind(plan.id, taskId, userId, JST_METADATA_CONCURRENCY).run();
    return d1Changes(claim) > 0;
  }
  if (!plan.is_image) {
    const claim = await env.DB.prepare(`UPDATE ${safeTable}
      SET status='processing', error='', processing_at=datetime('now'), next_retry_at='', updated_at=datetime('now')
      WHERE id=? AND task_id=? AND status='pending' AND (next_retry_at='' OR next_retry_at<=datetime('now'))`)
      .bind(plan.id, taskId).run();
    return d1Changes(claim) > 0;
  }
  const claim = await env.DB.prepare(`UPDATE ${safeTable}
      SET status='processing', error='', processing_at=datetime('now'), next_retry_at='', updated_at=datetime('now')
      WHERE id=? AND task_id=? AND status='pending'
      AND (next_retry_at='' OR next_retry_at<=datetime('now'))
      AND ((SELECT COUNT(*) FROM ews_jst_push_plans WHERE user_id=? AND status='processing' AND is_image=1)
      + (SELECT COUNT(*) FROM ews_shopee_push_plans WHERE user_id=? AND status='processing' AND is_image=1)) < ?`)
    .bind(plan.id, taskId, userId, userId, imageConcurrencyLimit).run();
  return d1Changes(claim) > 0;
}

async function dispatchPushPlan(env, planTable, taskId, plan) {
  try {
    let payload;
    try { payload = JSON.parse(plan.payload); }
    catch (err) { err.retryable = false; throw err; }
    await pushToWebhook(plan.webhook_url, payload);
  } catch (err) {
    if (err.retryable !== false && await schedulePushPlanRetry(env, planTable, plan.id, taskId, plan.retry_count, err.message)) return;
    const terminalMessage = err.retryable === false ? err.message : `${err.message}；已达到自动重试上限`;
    const failed = await markPushPlanFailed(env, planTable, plan.id, terminalMessage);
    if (!failed) return;
    await refundTaskCredit(env, taskId);
  }
}

async function releaseTaskPlans(env, planTable, platform, taskId, ctx, dispatchBudget) {
  const config = await getConfig(env, platform);
  const taskOwner = await getOne(env, "SELECT user_id FROM ews_tasks WHERE id=?", [taskId]);
  const ownerId = taskOwner?.user_id || '';
  const workflowUser = await getUserByUsername(env, ownerId || 'admin');
  applyUserWorkflowOverrides(config, workflowUser?.webhook_config, platform);
  const workflowFlags = workflowExecutionFlags(config);
  const imageConcurrencyLimit = normalizeUserImageConcurrencyLimit(workflowUser?.image_concurrency_limit);
  const imageActive = await getUserImageActiveCount(env, ownerId);
  const imageAvailable = Math.max(0, imageConcurrencyLimit - imageActive);
  const metadataActive = platform === 'jst' ? await getUserMetadataActiveCount(env, ownerId) : 0;
  const metadataAvailable = Math.max(0, JST_METADATA_CONCURRENCY - metadataActive);
  const budget = Math.max(1, Math.min(parseInt(dispatchBudget) || (imageConcurrencyLimit + FAST_PLAN_RELEASE_BATCH), imageConcurrencyLimit + FAST_PLAN_RELEASE_BATCH));
  const pendingPlans = await getPendingPlansForRelease(env, planTable, taskId, imageAvailable, metadataAvailable, workflowFlags, budget);
  const plans = pendingPlans?.results || [];
  let dispatched = 0;
  for (const plan of plans) {
    if (!plan.webhook_url) {
      await markPushPlanFailed(env, planTable, plan.id, 'Webhook地址未配置', 'pending');
      continue;
    }
    const claimed = await claimPushPlan(env, planTable, plan, taskId, ownerId, imageConcurrencyLimit);
    if (!claimed) continue;
    if (taskOwner?.user_id && !(await consumeUserCredit(env, taskOwner.user_id))) {
      await markPushPlanFailed(env, planTable, plan.id, '算力不足');
      continue;
    }
    dispatched++;
    ctx.waitUntil(dispatchPushPlan(env, planTable, taskId, plan));
  }
  return dispatched;
}

async function jstReleaseTaskQueue(env, taskId, ctx, dispatchBudget) {
  try {
    return await releaseTaskPlans(env, 'ews_jst_push_plans', 'jst', taskId, ctx, dispatchBudget);
  } catch (err) { console.error('jstReleaseTaskQueue error:', err.message); }
  return 0;
}

async function runQueueStage(name, action) {
  try {
    return await action();
  } catch (err) {
    console.error(`${name} error:`, err.message);
  }
}

async function acquirePushPlanSchedulerLease(env) {
  const result = await env.DB.prepare(`UPDATE ews_queue_scheduler_state
    SET state_value=datetime('now', '+55 seconds'), updated_at=datetime('now')
    WHERE state_key='push_plan_dispatch_lease'
      AND (state_value='' OR state_value < datetime('now'))`).run();
  return d1Changes(result) > 0;
}

async function releasePendingPushPlans(env, ctx) {
  if (!(await acquirePushPlanSchedulerLease(env))) return;
  try {
    await dispatchPendingPushPlansFairly(env, ctx);
  } finally {
    await env.DB.prepare(`UPDATE ews_queue_scheduler_state
      SET state_value='', updated_at=datetime('now')
      WHERE state_key='push_plan_dispatch_lease'`).run();
  }
}

async function dispatchPendingPushPlansFairly(env, ctx) {
  const cursor = await getOne(env, "SELECT state_value FROM ews_queue_scheduler_state WHERE state_key='push_plan_last_user'");
  const lastUserId = cursor?.state_value || '';
  const result = await query(env, `WITH task_candidates AS (
    SELECT 'jst' AS platform, p.task_id,
      COALESCE(NULLIF(p.user_id, ''), NULLIF(i.user_id, ''), 'admin') AS user_id,
      MIN(p.created_at) AS oldest, MAX(CASE WHEN p.is_image=0 THEN 1 ELSE 0 END) AS has_fast
    FROM ews_jst_push_plans p
      JOIN ews_tasks i ON i.id=p.task_id
      JOIN ews_jst_tasks t ON t.id=p.task_id
    WHERE p.status='pending' AND (p.next_retry_at='' OR p.next_retry_at<=datetime('now'))
      AND t.status IN ('processing','partial_failed')
      AND COALESCE(t.queue_mode, 'auto') != 'manual'
    GROUP BY p.task_id, COALESCE(NULLIF(p.user_id, ''), NULLIF(i.user_id, ''), 'admin')
    UNION ALL
    SELECT 'shopee' AS platform, p.task_id,
      COALESCE(NULLIF(p.user_id, ''), NULLIF(i.user_id, ''), 'admin') AS user_id,
      MIN(p.created_at) AS oldest, MAX(CASE WHEN p.is_image=0 THEN 1 ELSE 0 END) AS has_fast
    FROM ews_shopee_push_plans p
      JOIN ews_tasks i ON i.id=p.task_id
    WHERE p.status='pending' AND (p.next_retry_at='' OR p.next_retry_at<=datetime('now'))
      AND i.status IN ('processing','partial_failed')
    GROUP BY p.task_id, COALESCE(NULLIF(p.user_id, ''), NULLIF(i.user_id, ''), 'admin')
  ), ranked AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY has_fast DESC, oldest ASC, task_id ASC) AS task_rank
    FROM task_candidates
  )
  SELECT platform, task_id, user_id, oldest FROM ranked
  WHERE task_rank=1
  ORDER BY CASE WHEN user_id > ? THEN 0 ELSE 1 END, user_id ASC LIMIT ?`, [lastUserId, MAX_QUEUE_USERS_PER_RUN]);
  let candidates = result?.results || [];
  let remainingDispatches = MAX_QUEUE_DISPATCHES_PER_RUN;
  let servedUserId = '';
  while (remainingDispatches > 0 && candidates.length) {
    const nextRound = [];
    for (const row of candidates) {
      if (remainingDispatches < 1) break;
      const turnBudget = Math.min(QUEUE_USER_TURN_SIZE, remainingDispatches);
      const dispatched = row.platform === 'jst'
        ? await jstReleaseTaskQueue(env, row.task_id, ctx, turnBudget)
        : await shopeeReleaseTaskQueue(env, row.task_id, ctx, turnBudget);
      servedUserId = row.user_id;
      remainingDispatches -= dispatched || 0;
      if (dispatched === turnBudget && remainingDispatches > 0) nextRound.push(row);
    }
    candidates = nextRound;
  }
  if (servedUserId) {
    await env.DB.prepare(`INSERT INTO ews_queue_scheduler_state (state_key, state_value, updated_at)
      VALUES ('push_plan_last_user', ?, datetime('now'))
      ON CONFLICT(state_key) DO UPDATE SET state_value=excluded.state_value, updated_at=excluded.updated_at`)
      .bind(servedUserId).run();
  }
}

async function processPendingQueue(env, ctx) {
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
const MIN_IMAGE_QUEUE_ACTIVE = 4;
const MAX_IMAGE_QUEUE_ACTIVE = 12;
const IMAGE_QUEUE_MAX_ATTEMPTS = 5;
const MIN_PUSH_PLAN_TIMEOUT_MINUTES = 20;
const DEFAULT_PUSH_PLAN_TIMEOUT_MINUTES = 20;
const MAX_PUSH_PLAN_TIMEOUT_MINUTES = 1440;
const CALLBACK_QUEUE_INLINE_MAX_BYTES = 48 * 1024;
const CALLBACK_INBOX_PREFIX = 'ews-callback-inbox/';
const R2_UPLOAD_TICKET_TTL_SECONDS = 300;
const R2_UPLOAD_MAX_BYTES = 1900000;

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
  return Math.min(Math.max(n, MIN_PUSH_PLAN_TIMEOUT_MINUTES), MAX_PUSH_PLAN_TIMEOUT_MINUTES);
}

async function getPushPlanTimeoutMinutes(env) {
  const config = await getConfig(env);
  return parsePushPlanTimeoutMinutes(config.push_plan_timeout_minutes);
}

async function getImageQueueLimits(env) {
  const stats = await getOne(env, `SELECT
    SUM(CASE WHEN status='processing' AND processing_at >= datetime('now', '-2 minutes') THEN 1 ELSE 0 END) AS active,
    SUM(CASE WHEN status='pending' OR (status='processing' AND processing_at < datetime('now', '-2 minutes')) THEN 1 ELSE 0 END) AS queued
    FROM ews_image_queue`);
  const active = stats?.active || 0;
  const outstanding = active + (stats?.queued || 0);
  const maxActive = Math.min(MAX_IMAGE_QUEUE_ACTIVE, Math.max(MIN_IMAGE_QUEUE_ACTIVE, Math.ceil(outstanding / 2)));
  return {
    batchSize: Math.max(1, Math.min(MAX_IMAGE_QUEUE_ACTIVE, maxActive - active)),
    maxActive,
  };
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
  const jstRows = await query(env, `SELECT DISTINCT task_id FROM ews_jst_push_plans
    WHERE status IN ('failed','pending','processing') LIMIT 100`);
  for (const row of (jstRows?.results || [])) await reconcileTaskStatusForPushPlans(env, 'ews_jst_push_plans', row.task_id);
  const shopeeRows = await query(env, `SELECT DISTINCT task_id FROM ews_shopee_push_plans
    WHERE status IN ('failed','pending','processing') LIMIT 100`);
  for (const row of (shopeeRows?.results || [])) await reconcileTaskStatusForPushPlans(env, 'ews_shopee_push_plans', row.task_id);
}

async function recoverStalePushPlans(env) {
  const timeoutMinutes = await getPushPlanTimeoutMinutes(env);
  const staleModifier = `-${timeoutMinutes} minutes`;
  for (const table of ['ews_jst_push_plans', 'ews_shopee_push_plans']) {
    const rows = await query(env, `SELECT id, task_id, retry_count FROM ${table}
      WHERE status='processing' AND processing_at < datetime('now', ?)
      ORDER BY processing_at ASC LIMIT 50`, [staleModifier]);
    for (const row of (rows?.results || [])) {
      const message = `Push plan timed out after ${timeoutMinutes} minutes without callback`;
      if (await schedulePushPlanRetry(env, table, row.id, row.task_id, row.retry_count, message)) continue;
      const failed = await markPushPlanFailed(env, table, row.id, `${message}；已达到自动重试上限`);
      if (failed) await refundTaskCredit(env, row.task_id);
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

async function recoverStaleCallbackQueue(env) {
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
  const planTable = idx.platform === 'shopee' ? 'ews_shopee_push_plans' : 'ews_jst_push_plans';
  const whType = `${row.image_type}_${parseInt(row.image_position) || 1}`;
  const result = await env.DB.prepare(`UPDATE ${planTable}
    SET status='failed', retry_count=?, error=?, processing_at='', next_retry_at='', updated_at=datetime('now')
    WHERE task_id=? AND sub_task_id=? AND webhook_type=? AND status='processing'`)
    .bind(PUSH_PLAN_MAX_RETRIES, reason, row.task_id, row.sub_task_id || '', whType).run();
  if (d1Changes(result) > 0) {
    await refundTaskCredit(env, row.task_id);
    await failTaskForPushPlan(env, planTable, row.task_id, reason);
    return 'failed';
  }
  const plan = await getOne(env, `SELECT status FROM ${planTable} WHERE task_id=? AND sub_task_id=? AND webhook_type=?`, [row.task_id, row.sub_task_id || '', whType]);
  return plan?.status || 'missing_plan';
}

async function clearFailedImageQueueForPlan(env, plan) {
  const match = /^(main|sub|detail|sku)_(\d+)$/.exec(plan.webhook_type || '');
  if (!match) return;
  await env.DB.prepare(`DELETE FROM ews_image_queue
    WHERE task_id=? AND sub_task_id=? AND image_type=? AND image_position=? AND status='failed'`)
    .bind(plan.task_id, plan.sub_task_id || '', match[1], parseInt(match[2])).run();
}

async function recoverStaleImageQueue(env) {
  const reason = '图片队列处理超时，已达到最大重试次数';
  const exhausted = await query(env, `SELECT * FROM ews_image_queue
    WHERE status='processing' AND attempts >= ?
      AND (processing_at IS NULL OR processing_at='' OR processing_at < datetime('now', '-2 minutes'))
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
        AND (processing_at IS NULL OR processing_at='' OR processing_at < datetime('now', '-2 minutes'))`)
      .bind(reason, row.id, IMAGE_QUEUE_MAX_ATTEMPTS).run();
    if (d1Changes(result) < 1) continue;
  }
  await env.DB.prepare(`UPDATE ews_image_queue
    SET status='pending', error='图片队列处理超时，重新入队', updated_at=datetime('now')
    WHERE status='processing' AND attempts < ?
      AND (processing_at IS NULL OR processing_at='' OR processing_at < datetime('now', '-2 minutes'))`)
    .bind(IMAGE_QUEUE_MAX_ATTEMPTS).run();
}

function imageObjectKey(taskId, subTaskId, imageType, imagePosition, planId) {
  const safe = value => String(value || '').replace(/[^A-Za-z0-9_-]/g, '_');
  return `ews/${safe(taskId)}/${safe(subTaskId)}/${safe(imageType)}_${parseInt(imagePosition)}_${safe(planId)}.jpg`;
}

async function findUploadTicketPlan(env, idx, body) {
  const imageType = String(body.image_type || '').trim();
  const imagePosition = parseInt(body.image_position);
  if (!['main', 'sub', 'detail', 'sku'].includes(imageType)) throw callbackPermanentError('无效的图片类型');
  if (!Number.isInteger(imagePosition) || imagePosition < 1) throw callbackPermanentError('图片位置无效');
  const subTaskId = String(body.sub_task_id || '').trim();
  if (!subTaskId) throw callbackPermanentError('缺少 sub_task_id');
  const subTaskTable = idx.platform === 'shopee' ? 'ews_shopee_sub_tasks' : 'ews_jst_sub_tasks';
  const subTask = await getOne(env, `SELECT id FROM ${subTaskTable} WHERE id=? AND parent_task_id=?`, [subTaskId, body.task_id]);
  if (!subTask) throw callbackPermanentError('sub_task_id 不属于当前任务');
  const planTable = idx.platform === 'shopee' ? 'ews_shopee_push_plans' : 'ews_jst_push_plans';
  const plan = await findProcessingCallbackPlan(env, planTable, body.task_id, `${imageType}_${imagePosition}`, subTaskId, String(body.plan_id || '').trim());
  if (!plan) throw callbackPermanentError('图片计划不存在或不在处理中');
  return { plan, imageType, imagePosition, subTaskId };
}

async function createR2PresignedPut(env, key, planId, sha256) {
  const accountId = String(env.R2_ACCOUNT_ID || '').trim();
  const accessKeyId = String(env.R2_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(env.R2_SECRET_ACCESS_KEY || '').trim();
  if (!accountId || !accessKeyId || !secretAccessKey) throw new Error('R2 S3 上传凭据尚未配置');
  const bucket = String(env.R2_BUCKET_NAME || 'ossapac').trim();
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  const url = new URL(`https://${accountId}.r2.cloudflarestorage.com/${encodeURIComponent(bucket)}/${encodedKey}`);
  url.searchParams.set('X-Amz-Expires', String(R2_UPLOAD_TICKET_TTL_SECONDS));
  const headers = {
    'content-type': 'image/jpeg',
    'x-amz-meta-plan-id': planId,
    'x-amz-meta-sha256': sha256,
  };
  const signer = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto', retries: 0 });
  const request = await signer.sign(url, { method: 'PUT', headers, aws: { signQuery: true, allHeaders: true } });
  return { uploadUrl: request.url, headers };
}

async function handleR2UploadTicket(request, env) {
  const body = await parseBody(request);
  if (!body || typeof body !== 'object' || typeof body.get === 'function') return error('无效的请求体', 400);
  const taskId = String(body.task_id || '').trim();
  if (!taskId) return error('缺少 task_id', 400);
  const idx = await getTaskIndex(env, taskId);
  if (!idx) return error('任务不存在', 404);
  const config = await getConfig(env, idx.platform || '');
  const receivedSecret = body.secret ?? body.callback_secret;
  if (config.callback_secret && receivedSecret !== config.callback_secret) return error('上传票据密钥无效', 403);
  const contentType = String(body.content_type || '').toLowerCase();
  const sizeBytes = parseInt(body.size_bytes);
  const sha256 = String(body.sha256 || '').toLowerCase();
  if (contentType !== 'image/jpeg') return error('上传图片必须为 image/jpeg', 400);
  if (!Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > R2_UPLOAD_MAX_BYTES) return error(`上传图片必须小于 ${R2_UPLOAD_MAX_BYTES} bytes`, 400);
  if (!/^[a-f0-9]{64}$/.test(sha256)) return error('图片 sha256 无效', 400);
  try {
    const ticketPlan = await findUploadTicketPlan(env, idx, { ...body, task_id: taskId });
    const r2Key = imageObjectKey(taskId, ticketPlan.subTaskId, ticketPlan.imageType, ticketPlan.imagePosition, ticketPlan.plan.id);
    const signed = await createR2PresignedPut(env, r2Key, ticketPlan.plan.id, sha256);
    return json({
      success: true,
      method: 'PUT',
      upload_url: signed.uploadUrl,
      headers: signed.headers,
      r2_key: r2Key,
      expires_in: R2_UPLOAD_TICKET_TTL_SECONDS,
      max_size: R2_UPLOAD_MAX_BYTES,
    });
  } catch (err) {
    if (err.permanent) return error(err.message, 400);
    console.error('R2 upload ticket failed:', err.message);
    return json({ success: false, retryable: true, error: err.message || 'R2上传票据签发失败' }, 503);
  }
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
    const queueId = uuid(16);
    const payload = { ...body };
    delete payload.secret;
    delete payload.callback_secret;
    const serializedPayload = JSON.stringify(payload);
    let payloadKey = '';
    const queueMessage = { id: queueId, task_id, platform: idx.platform || '' };
    if (new TextEncoder().encode(serializedPayload).byteLength > CALLBACK_QUEUE_INLINE_MAX_BYTES) {
      payloadKey = `${CALLBACK_INBOX_PREFIX}${queueId}.json`;
      await env.R2.put(payloadKey, serializedPayload, {
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
        customMetadata: { 'queue-id': queueId },
      });
      queueMessage.payload_key = payloadKey;
    } else {
      queueMessage.payload = payload;
    }
    try {
      await env.CALLBACK_EVENTS.send(queueMessage);
    } catch (err) {
      if (payloadKey) await env.R2.delete(payloadKey).catch(() => {});
      throw err;
    }
    return json({ success: true, queued: true, queue_id: queueId, message: '回调已入队' });
  } catch (err) {
    console.error('callback enqueue failed:', err.message);
    return json({ success: false, queued: false, retryable: true, error: '回调队列写入失败，请稍后重试' }, 503);
  }
}

function nativeCallbackPayloadKey(value) {
  const key = String(value || '');
  if (!key.startsWith(CALLBACK_INBOX_PREFIX) || !/^ews-callback-inbox\/[A-Za-z0-9_-]+\.json$/.test(key)) {
    throw callbackPermanentError('回调 inbox key 无效');
  }
  return key;
}

async function loadNativeCallbackPayload(env, item) {
  if (item.payload && typeof item.payload === 'object') return item.payload;
  const payloadKey = nativeCallbackPayloadKey(item.payload_key);
  const object = await env.R2.get(payloadKey);
  if (!object) throw new Error('回调 inbox 数据尚不可用');
  let payload;
  try { payload = JSON.parse(await object.text()); }
  catch (_) { throw callbackPermanentError('回调 inbox 数据不是有效 JSON'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw callbackPermanentError('回调 inbox 数据无效');
  return payload;
}

async function deleteNativeCallbackPayload(env, value) {
  let payloadKey;
  try { payloadKey = nativeCallbackPayloadKey(value); }
  catch (_) { return; }
  await env.R2.delete(payloadKey);
}

async function processNativeCallbackQueue(batch, env, ctx) {
  for (const message of batch.messages) {
    const item = message.body || {};
    let payload;
    try {
      payload = await loadNativeCallbackPayload(env, item);
      await processCallbackPayload(env, ctx, payload, true);
      if (item.payload_key) await deleteNativeCallbackPayload(env, item.payload_key);
      message.ack();
    } catch (err) {
      const permanent = err.permanent === true;
      const exhausted = message.attempts >= CALLBACK_QUEUE_MAX_ATTEMPTS;
      if (permanent || exhausted) {
        await failCallbackPushPlan(env, {
          task_id: item.task_id || payload?.task_id || '',
          platform: item.platform || '',
          payload: JSON.stringify(payload || {}),
        }, permanent ? (err.message || '回调数据无效') : `${err.message || '回调处理失败'}；已达到自动重试上限`);
        if (item.payload_key) await deleteNativeCallbackPayload(env, item.payload_key);
        message.ack();
      } else {
        message.retry({ delaySeconds: Math.min(300, 30 * message.attempts) });
      }
      console.error('native callback queue item failed:', message.id, err.message);
    }
  }
}

async function processCallbackQueue(env, ctx, preferredId) {
  try {
    if (preferredId) {
      const preferred = await getOne(env, "SELECT * FROM ews_callback_queue WHERE id=?", [preferredId]);
      const claimed = preferred ? await processCallbackQueueRow(env, ctx, preferred) : false;
      if (claimed && ctx) ctx.waitUntil(processCallbackQueue(env, ctx));
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

function callbackWebhookType(payload) {
  let webhookType = String(payload.workflow_type || '').trim();
  if (!webhookType) {
    if (payload.products !== undefined) webhookType = 'title';
    else if (payload.image_type && payload.image_position) webhookType = `${payload.image_type}_${parseInt(payload.image_position) || 1}`;
  }
  return webhookType;
}

async function findProcessingCallbackPlan(env, planTable, taskId, webhookType, subTaskId, planId = '') {
  if (planId) return getOne(env, `SELECT id, retry_count FROM ${planTable} WHERE id=? AND task_id=? AND webhook_type=? AND status='processing'`, [planId, taskId, webhookType]);
  const subTaskWhere = webhookType === 'title' ? '' : ' AND sub_task_id=?';
  const params = [taskId, webhookType];
  if (subTaskWhere) params.push(subTaskId || '');
  return getOne(env, `SELECT id, retry_count FROM ${planTable} WHERE task_id=? AND webhook_type=?${subTaskWhere} AND status='processing'`, params);
}

async function failCallbackPushPlan(env, row, reason) {
  let payload;
  try { payload = JSON.parse(row.payload || '{}'); } catch (_) { return; }
  const webhookType = callbackWebhookType(payload);
  if (!webhookType) return;
  const planTable = row.platform === 'shopee' ? 'ews_shopee_push_plans' : 'ews_jst_push_plans';
  const plan = await findProcessingCallbackPlan(env, planTable, row.task_id, webhookType, payload.sub_task_id, payload.plan_id);
  if (!plan) return;
  if (await markPushPlanFailed(env, planTable, plan.id, reason)) await refundTaskCredit(env, row.task_id);
}

async function handleWorkflowErrorCallback(env, idx, body) {
  const webhookType = callbackWebhookType(body);
  if (!webhookType) throw callbackPermanentError('错误回调缺少 workflow_type');
  const planTable = idx.platform === 'shopee' ? 'ews_shopee_push_plans' : 'ews_jst_push_plans';
  const plan = await findProcessingCallbackPlan(env, planTable, body.task_id, webhookType, body.sub_task_id, body.plan_id);
  if (!plan) return;
  const reason = String(body.error || '工作流执行失败').trim();
  const retryable = body.retryable !== false;
  if (retryable && await schedulePushPlanRetry(env, planTable, plan.id, body.task_id, plan.retry_count, reason)) return;
  const terminalReason = retryable ? `${reason}；已达到自动重试上限` : reason;
  if (await markPushPlanFailed(env, planTable, plan.id, terminalReason)) await refundTaskCredit(env, body.task_id);
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

async function processImageQueue(env, ctx, preferredId) {
  try {
    const limits = await getImageQueueLimits(env);
    if (preferredId) {
      const preferred = await getOne(env, "SELECT * FROM ews_image_queue WHERE id=?", [preferredId]);
      const claimed = preferred ? await processImageQueueRow(env, ctx, preferred, limits) : false;
      if (claimed && ctx) ctx.waitUntil(processImageQueue(env, ctx));
      return;
    }
    await recoverStaleImageQueue(env);
    const candidates = await query(env, `SELECT * FROM ews_image_queue
      WHERE attempts < ? AND (
        (status='pending' AND (attempts=0 OR updated_at <= datetime('now', '-30 seconds')))
        OR (status='processing' AND processing_at < datetime('now', '-2 minutes'))
      )
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
      AND (
        (status='pending' AND (attempts=0 OR updated_at <= datetime('now', '-30 seconds')))
        OR (status='processing' AND processing_at < datetime('now', '-2 minutes'))
      )
      AND (SELECT COUNT(*) FROM ews_image_queue WHERE status='processing' AND processing_at >= datetime('now', '-2 minutes')) < ?`)
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

async function processUploadedR2Image(env, platform, taskId, subTaskId, setIndex, imageType, imagePosition, planId, r2Key, sha256, publicUrl) {
  if (!planId) throw callbackPermanentError('R2图片回调缺少 plan_id');
  const expectedKey = imageObjectKey(taskId, subTaskId, imageType, imagePosition, planId);
  if (r2Key !== expectedKey) throw callbackPermanentError('R2图片路径与任务计划不匹配');
  const object = await env.R2.head(r2Key);
  if (!object) throw new Error('R2图片尚未写入完成');
  const contentType = String(object.httpMetadata?.contentType || '').toLowerCase();
  const storedSha256 = String(object.customMetadata?.sha256 || '').toLowerCase();
  const storedPlanId = String(object.customMetadata?.['plan-id'] || '');
  const invalid = object.size < 1
    || object.size > R2_UPLOAD_MAX_BYTES
    || contentType !== 'image/jpeg'
    || !/^[a-f0-9]{64}$/.test(sha256)
    || storedSha256 !== sha256
    || storedPlanId !== planId;
  if (invalid) {
    await env.R2.delete(r2Key).catch(() => {});
    throw callbackPermanentError('R2图片校验失败');
  }
  const fullUrl = publicUrl ? `${publicUrl.replace(/\/+$/, '')}/${r2Key}` : r2Key;
  if (platform === 'shopee') await shopeeSaveImage(env, { parent_task_id: taskId, sub_task_id: subTaskId, set_index: setIndex, image_type: imageType, position: imagePosition, image_url: fullUrl });
  else await jstSaveImage(env, { id: '', parent_task_id: taskId, sub_task_id: subTaskId, variant_id: null, set_index: setIndex, image_type: imageType, position: imagePosition, image_url: fullUrl });
  return { type: imageType, position: imagePosition, url: fullUrl };
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
  if (!sub_task_id) throw callbackPermanentError('图片回调缺少 sub_task_id');
  const subTaskTable = isShopee ? 'ews_shopee_sub_tasks' : 'ews_jst_sub_tasks';
  const subTask = await getOne(env, `SELECT id, set_index FROM ${subTaskTable} WHERE id=? AND parent_task_id=?`, [sub_task_id, task_id]);
  if (!subTask) throw callbackPermanentError('图片回调的 sub_task_id 不属于当前任务');
  const image_type = row.image_type;
  const image_position = parseInt(row.image_position) || 1;
  const whType = `${image_type}_${image_position}`;
  if (row.r2_key) {
    await processUploadedR2Image(env, idx.platform, task_id, sub_task_id, subTask.set_index, image_type, image_position,
      String(row.plan_id || ''), String(row.r2_key || ''), String(row.sha256 || '').toLowerCase(), publicUrl);
    const completed = row.plan_id
      ? await completePushPlanByIdFromCallback(env, planTable, task_id, row.plan_id)
      : await completePushPlanFromCallback(env, planTable, task_id, whType, sub_task_id);
    if (!completed) throw new Error('图片计划暂时无法完成，请稍后重试');
  } else if (row.image_url) {
    await processOneImage(env, idx.platform, task_id, sub_task_id, subTask.set_index, image_type, image_position, row.image_url, publicUrl);
    const completed = row.plan_id
      ? await completePushPlanByIdFromCallback(env, planTable, task_id, row.plan_id)
      : await completePushPlanFromCallback(env, planTable, task_id, whType, sub_task_id);
    if (!completed) throw new Error('图片计划暂时无法完成，请稍后重试');
  } else {
    const planInfo = await env.DB.prepare(`SELECT id, webhook_url, payload, retry_count FROM ${planTable} WHERE task_id=? AND sub_task_id=? AND webhook_type=? AND status='processing'`)
      .bind(task_id, sub_task_id, whType).first();
    const workflowError = String(row.error_message || '').trim();
    if (planInfo) {
      const failureMessage = workflowError || '图片下载或写入失败';
      const retryable = !workflowError || row.error_retryable !== 0;
      const scheduled = retryable && await schedulePushPlanRetry(env, planTable, planInfo.id, task_id, planInfo.retry_count, failureMessage);
      if (!scheduled) {
        const reason = retryable ? `${failureMessage}；已达到自动重试上限` : failureMessage;
        const failed = await markPushPlanFailed(env, planTable, planInfo.id, reason);
        if (failed) await refundCredits(env, task_id);
      }
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
  const { task_id, sub_task_id, products, image_type, image_position, image_url, r2_key, error: errMsg } = body;
  if (!task_id) throw callbackPermanentError('缺少 task_id');
  const idx = await getTaskIndex(env, task_id);
  if (!idx) throw callbackPermanentError('任务不存在');

  const config = await getConfig(env, idx.platform || '');
  if (!trustedQueuePayload) {
    const receivedSecret = body.secret ?? body.callback_secret;
    if (config.callback_secret && receivedSecret !== config.callback_secret) throw callbackPermanentError('回调密钥无效');
  }

  const isShopee = idx.platform === 'shopee';
  const callbackWorkflowType = String(body.workflow_type || '').trim();
  if (callbackWorkflowType === 'sku_title' || (!isShopee && callbackWorkflowType === 'title')) {
    throw callbackPermanentError('旧版独立标题工作流已停用，请使用metadata聚合元数据工作流');
  }
  if (errMsg && image_type === undefined && image_url === undefined && r2_key === undefined) {
    await handleWorkflowErrorCallback(env, idx, body);
    return { success: true, sub_task_id, workflow_error: true };
  }
  if (products !== undefined && !Array.isArray(products)) throw callbackPermanentError('products 必须是数组');
  if (body.titles !== undefined || body.product_title !== undefined || body.sku_titles !== undefined) {
    throw callbackPermanentError('旧版独立标题回调已停用，请使用products聚合元数据回调');
  }
  const updateSubTask = isShopee ? shopeeUpdateSubTask : jstUpdateSubTask;
  const checkSubTaskImages = isShopee ? shopeeCheckSubTaskImages : jstCheckSubTaskImages;
  const checkParentCompletion = isShopee ? shopeeCheckParentCompletion : jstCheckParentCompletion;

  if (Array.isArray(products) && !isShopee) {
    if (callbackWebhookType(body) !== 'metadata') throw callbackPermanentError('聚水潭products回调必须使用metadata工作流');
    const planId = String(body.plan_id || '').trim();
    if (!planId) throw callbackPermanentError('商品元数据回调缺少plan_id');
    const metadataPlan = await getOne(env, `SELECT id, payload FROM ews_jst_push_plans
      WHERE id=? AND task_id=? AND webhook_type='metadata'`, [planId, task_id]);
    if (!metadataPlan) throw callbackPermanentError('商品元数据plan_id无效或不属于当前任务');
    let planPayload;
    try { planPayload = JSON.parse(metadataPlan.payload || '{}'); }
    catch (_) { throw callbackPermanentError('商品元数据计划内容无效'); }
    const expectedProducts = Array.isArray(planPayload.products) ? planPayload.products : [];
    const expectedVariants = Array.isArray(planPayload.variants) ? planPayload.variants : [];
    if (products.length !== expectedProducts.length) throw callbackPermanentError(`商品元数据数量不匹配: ${products.length} vs ${expectedProducts.length}`);
    const productsById = new Map(products.map(item => [String(item?.sub_task_id || ''), item]));
    if (productsById.has('') || productsById.size !== products.length) throw callbackPermanentError('商品元数据的sub_task_id不能为空或重复');
    const expectedVariantIds = new Set(expectedVariants.map(variant => String(variant?.id || '')));
    if (expectedVariantIds.has('') || expectedVariantIds.size !== expectedVariants.length) throw callbackPermanentError('商品元数据计划的变体ID无效');
    const normalizedProducts = [];
    const normalizedSkuTitles = [];
    for (let productIndex = 0; productIndex < expectedProducts.length; productIndex++) {
      const subTaskId = String(expectedProducts[productIndex]?.sub_task_id || '');
      const item = productsById.get(subTaskId);
      if (!item) throw callbackPermanentError(`商品元数据缺少sub_task_id: ${subTaskId}`);
      const productTitle = normalizeGeneratedTitles([item.product_title], 1, 1, 200, `商品标题#${productIndex + 1}`)[0];
      const recommendedCopy = normalizeGeneratedTitles([item.recommended_copy], 1, 1, 1000, `推荐文案#${productIndex + 1}`)[0];
      const productDescription = normalizeGeneratedTitles([item.product_description], 1, 1, 3000, `商品描述#${productIndex + 1}`)[0];
      const skuTitles = item.sku_titles === undefined && expectedVariants.length === 0 ? [] : item.sku_titles;
      if (!Array.isArray(skuTitles)) throw callbackPermanentError(`第${productIndex + 1}套sku_titles必须是数组`);
      if (skuTitles.length !== expectedVariants.length) throw callbackPermanentError(`第${productIndex + 1}套SKU标题数量不匹配: ${skuTitles.length} vs ${expectedVariants.length}`);
      const skuTitlesByVariant = new Map(skuTitles.map(sku => [String(sku?.variant_id || ''), sku]));
      if (skuTitlesByVariant.has('') || skuTitlesByVariant.size !== skuTitles.length) throw callbackPermanentError(`第${productIndex + 1}套SKU标题的variant_id不能为空或重复`);
      for (let variantIndex = 0; variantIndex < expectedVariants.length; variantIndex++) {
        const variantId = String(expectedVariants[variantIndex].id);
        const skuTitle = skuTitlesByVariant.get(variantId);
        if (!skuTitle || !expectedVariantIds.has(variantId)) throw callbackPermanentError(`第${productIndex + 1}套缺少变体${variantId}的SKU标题`);
        normalizedSkuTitles.push({
          id: `${subTaskId}_${variantId}`,
          sub_task_id: subTaskId,
          variant_id: variantId,
          title: normalizeGeneratedTitles([skuTitle.title], 1, 1, 30, `SKU标题#${productIndex + 1}-${variantIndex + 1}`)[0],
        });
      }
      normalizedProducts.push({ sub_task_id: subTaskId, product_title: productTitle, recommended_copy: recommendedCopy, product_description: productDescription });
    }
    await jstSaveMetadataBatch(env, task_id, normalizedProducts, normalizedSkuTitles);
    if (!(await completePushPlanByIdFromCallback(env, 'ews_jst_push_plans', task_id, planId))) throw new Error('商品元数据计划暂时无法完成，请稍后重试');
    for (const item of normalizedProducts) {
      const imageStatus = await jstCheckSubTaskImages(env, item.sub_task_id);
      if (imageStatus.total === imageStatus.completed) await jstUpdateSubTask(env, item.sub_task_id, { status: 'completed' });
    }
  // Shopee 商品元数据回调
  } else if (Array.isArray(products)) {
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
  }
  if (products && isShopee) await completePushPlanFromCallback(env, 'ews_shopee_push_plans', task_id, 'title');

  let imageHandled = false;
  const hasImageCallback = image_type !== undefined || image_url !== undefined || r2_key !== undefined || (errMsg && sub_task_id);
  if (hasImageCallback) {
    if (!['main','sub','detail','sku'].includes(image_type)) throw callbackPermanentError('无效的图片类型');
    if (!sub_task_id) throw callbackPermanentError('图片回调缺少 sub_task_id');
    const normalizedPosition = parseInt(image_position);
    if (!Number.isInteger(normalizedPosition) || normalizedPosition < 1) throw callbackPermanentError('图片回调的 image_position 无效');
    if (!r2_key && !image_url && !errMsg) throw callbackPermanentError('图片回调缺少 r2_key、image_url 或 error');
    const subTaskTable = isShopee ? 'ews_shopee_sub_tasks' : 'ews_jst_sub_tasks';
    const callbackSubTask = await getOne(env, `SELECT id, set_index FROM ${subTaskTable} WHERE id=? AND parent_task_id=?`, [sub_task_id, task_id]);
    if (!callbackSubTask) throw callbackPermanentError('图片回调的 sub_task_id 不属于当前任务');
    await processImageQueuePayload(env, ctx, {
      ...body,
      set_index: callbackSubTask.set_index,
      image_position: normalizedPosition,
      error_message: body.error || '',
      error_retryable: body.retryable === false ? 0 : 1,
    });
    imageHandled = true;
  }

  if (!imageHandled) {
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

  return { success: true, sub_task_id, image_handled: imageHandled };
}

const SHOPEE_ITEM_IMAGE_LIMIT_BYTES = 2 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 15000;
const MAX_SOURCE_IMAGE_BYTES = 16 * 1024 * 1024;

function isShopeeItemImage(platform, imageType) {
  return platform === 'shopee' && (imageType === 'main' || imageType === 'sub');
}

async function fetchImageWithTimeout(imageUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    return await fetch(imageUrl, { signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) throw new Error('图片下载超过 15 秒');
    throw err;
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

function detectImageContentType(buffer, declaredType) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return String(declaredType || '').split(';', 1)[0].trim().toLowerCase();
}

async function processOneImage(env, platform, task_id, sub_task_id, set_index, image_type, image_position, image_url, publicUrl) {
  try {
    const resp = await fetchImageWithTimeout(image_url);
    if (!resp.ok) {
      const message = `图片下载失败: HTTP ${resp.status}`;
      if (resp.status >= 400 && resp.status < 500 && ![408, 429].includes(resp.status)) throw callbackPermanentError(message);
      throw new Error(message);
    }
    let buffer = await readImageResponse(resp);
    let contentType = detectImageContentType(buffer, resp.headers.get('content-type') || 'image/jpeg');
    if (!/^image\//i.test(contentType) && !/^application\/octet-stream\b/i.test(contentType)) {
      throw callbackPermanentError(`图片格式不受支持: ${contentType || 'unknown'}`);
    }
    if (isShopeeItemImage(platform, image_type)) {
      if (buffer.byteLength > SHOPEE_ITEM_IMAGE_LIMIT_BYTES) throw callbackPermanentError('Shopee 主图/附图超过 2MB');
    }
    const ext = contentType === 'image/png' ? 'png' : 'jpg';
    const fileName = `${image_type}_${image_position}.${ext}`;
    const r2Key = `ews/${task_id}/${sub_task_id}/${fileName}`;
    await env.R2.put(r2Key, buffer, { httpMetadata: { contentType } });
    const fullUrl = publicUrl ? `${publicUrl.replace(/\/+$/, '')}/${r2Key}` : r2Key;
    if (platform === 'shopee') await shopeeSaveImage(env, { parent_task_id: task_id, sub_task_id, set_index, image_type, position: image_position, image_url: fullUrl });
    else await jstSaveImage(env, { id: '', parent_task_id: task_id, sub_task_id, variant_id: null, set_index, image_type, position: image_position, image_url: fullUrl });
    return { type: image_type, position: image_position, url: fullUrl };
  } catch (err) {
    console.error('processOneImage failed:', task_id, sub_task_id, `${image_type}_${image_position}`, err.message);
    throw err;
  }
}

// ========== 推送计划 ==========

async function handleGetPlans(env, path, idx) {
  const taskId = getTaskId(path);
  const plansTable = idx.platform === 'jst' ? 'ews_jst_push_plans' : 'ews_shopee_push_plans';
  const imagesTable = idx.platform === 'jst' ? 'ews_jst_task_images' : 'ews_shopee_task_images';
  const [config, results] = await Promise.all([
    getConfig(env),
    env.DB.batch([
      env.DB.prepare(`SELECT * FROM ${plansTable} WHERE task_id=? ORDER BY batch_order ASC, webhook_type ASC`).bind(taskId),
      env.DB.prepare(`SELECT status, COUNT(*) as cnt FROM ${plansTable} WHERE task_id=? GROUP BY status`).bind(taskId),
      env.DB.prepare(`SELECT sub_task_id, image_type, position, image_url FROM ${imagesTable} WHERE parent_task_id=? AND status='completed' AND image_url<>''`).bind(taskId),
    ]),
  ]);
  const publicUrl = (config.r2_public_url || '').replace(/\/+$/, '');
  const plans = results[0]?.results || [];
  const stats = results[1]?.results || [];
  const imageUrls = new Map((results[2]?.results || []).map(image => [
    `${image.sub_task_id || ''}|${image.image_type}|${parseInt(image.position) || 1}`,
    image.image_url || '',
  ]));
  const s = { pending: 0, processing: 0, done: 0, failed: 0, total: 0 };
  for (const r of stats) { s[r.status] = r.cnt; s.total += r.cnt; }
  return json({ success: true, plans: plans.map(p => {
    let preview_url = '';
    const imagePlan = /^(main|sub|detail|sku)_(\d+)$/.exec(p.webhook_type || '');
    let imageType = imagePlan?.[1] || '';
    let imagePosition = parseInt(imagePlan?.[2]) || 0;
    if (!imageType) {
      try {
        const payload = JSON.parse(p.payload || '{}');
        imageType = ['main','sub','detail','sku'].includes(payload.image_type) ? payload.image_type : '';
        imagePosition = parseInt(payload.image_position) || 0;
      } catch (_) {}
    }
    if (imageType && imagePosition && p.sub_task_id) {
      preview_url = imageUrls.get(`${p.sub_task_id}|${imageType}|${imagePosition}`) || '';
      if (preview_url && !/^https?:\/\//i.test(preview_url) && publicUrl) preview_url = `${publicUrl}/${preview_url.replace(/^\/+/, '')}`;
    }
    const { user_id, is_image, ...publicPlan } = p;
    return { ...publicPlan, preview_url };
  }), stats: s });
}

async function handleRetryPlan(env, path, request, ctx, idx) {
  const parts = path.split('/');
  const taskId = parts[3], planId = parts[5];
  const plansTable = idx.platform === 'jst' ? 'ews_jst_push_plans' : 'ews_shopee_push_plans';
  const plan = await getOne(env, `SELECT * FROM ${plansTable} WHERE id=?`, [planId]);
  if (!plan || plan.task_id !== taskId) return error('计划不存在', 404);
  if (plan.status === 'processing') return error('计划正在处理中，请勿重复推送', 409);
  await clearFailedImageQueueForPlan(env, plan);
  await env.DB.prepare(`UPDATE ${plansTable} SET status='pending', retry_count=0, error='', processing_at='', next_retry_at='', updated_at=datetime('now') WHERE id=?`).bind(planId).run();
  await reconcileTaskStatusForPushPlans(env, plansTable, taskId, 'retry plan resumed', { resumeWhenNoFailures: true });
  if (idx.platform === 'jst') ctx.waitUntil(jstReleaseTaskQueue(env, taskId, ctx));
  else ctx.waitUntil(shopeeReleaseTaskQueue(env, taskId, ctx));
  return json({ success: true, queued: true, message: '计划已重新加入统一推送队列' });
}

// ========== 导出 ==========

async function handleExportTask(env, path, idx) {
  const taskId = getTaskId(path);
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
  const subTaskRecords = detail.sub_tasks || [];
  const subTaskIds = subTaskRecords.map(st => st.id);
  const exportStatements = [env.DB.prepare('SELECT webhook_type FROM ews_jst_push_plans WHERE task_id=?').bind(taskId)];
  if (subTaskIds.length > 0) {
    const placeholders = subTaskIds.map(() => '?').join(',');
    exportStatements.push(env.DB.prepare(`SELECT sub_task_id, variant_id, title FROM ews_jst_sku_titles WHERE sub_task_id IN (${placeholders})`).bind(...subTaskIds));
  }
  const exportResults = await env.DB.batch(exportStatements);
  const plannedTypes = new Set((exportResults[0]?.results || []).map(plan => plan.webhook_type));
  const metadataPlanned = plannedTypes.has('metadata');
  const skuTitlePlanned = metadataPlanned;
  const skuImagePlanned = [...plannedTypes].some(type => /^sku_\d+$/.test(type));

  const skuTitleMap = {};
  for (const row of (exportResults[1]?.results || [])) skuTitleMap[row.sub_task_id + '_' + row.variant_id] = row.title;
  const imageMap = new Map(images.map(image => [image.sub_task_id + '|' + image.image_type + '|' + image.position, image.image_url || '']));
  const subTaskMap = new Map(subTaskRecords.map(subTask => [subTask.id, subTask]));

  function recordedImg(subTaskId, type, pos) {
    return imageMap.get(subTaskId + '|' + type + '|' + pos) || '';
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
    if (variationImageMode === 'upload') return variant.sku_image || '';
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
    const subTask = subTaskMap.get(subTaskId);
    const setLabel = '第' + (setIdx + 1) + '套';
    const exportedSkuCodes = new Set();
    if (!subTaskId) { addExportError(setLabel + ' 缺少子任务'); continue; }
    if (!(subTask?.title || detail.topic_items || '').trim()) addExportError(setLabel + ' 缺少商品标题；请启用商品元数据工作流或填写参考标题');
    if (metadataPlanned && !(subTask?.recommended_copy || '').trim()) addExportError(setLabel + ' 缺少AI推荐文案');
    if (metadataPlanned && !(subTask?.description || '').trim()) addExportError(setLabel + ' 缺少AI商品描述');
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
      const styleCode = subTaskId ? subTaskId.slice(0, 8) : `${taskId.slice(0, 8)}-S${setIdx + 1}`;
      const skuSuffix = String(variant.sku_code || '').trim() || `V${vIdx + 1}`;
      const exportedSkuCode = `${styleCode}-${skuSuffix}`.toLocaleLowerCase();
      if (exportedSkuCodes.has(exportedSkuCode)) addExportError(setLabel + ' SKU#' + (vIdx + 1) + ' 导出商品编码重复');
      if (exportedSkuCode.length > JST_SKU_MAX_LENGTH) addExportError(setLabel + ' SKU#' + (vIdx + 1) + ` 导出商品编码超过${JST_SKU_MAX_LENGTH}字符`);
      exportedSkuCodes.add(exportedSkuCode);
      const skuGroupKey = shopeeVariationGroupKey(variant.tier1_value);
      if (variationImageMode === 'upload' && !checkedSkuImages.has(skuGroupKey) && !getSkuUrl(setIdx, subTaskId, variant)) addExportError(setLabel + ' 一级规格“' + (variant.tier1_value || '') + '”缺少自上传SKU图片');
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
    const subTask = subTaskMap.get(subTaskId);
    const productTitle = subTask?.title || detail.topic_items || '';
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
        '推荐文案': subTask?.recommended_copy || detail.recommended_copy || '',
        '商品描述': subTask?.description || detail.description || detail.source_brief || '', '宝贝链接': detail.product_link || '',
        '库存': variant.stock ?? detail.stock ?? 999, '重量(kg)': detail.weight ?? 1.0, '基本售价': exportPrice,
        '市场|吊牌价': exportPrice,
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
function validateShopeeRow(product, variations, templateManifest, templateCategory) {
  var warnings = []; var errors = [];
  var n = product.name || '';
  var desc = product.description || '';
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
      var weightKg = parseFloat(variations[i].weight_kg);
      var weightG = isNaN(weightKg) ? 0 : Math.round(weightKg * 1000);
      if (isNaN(weightKg) || weightKg <= 0 || weightG > 100000000) errors.push('变体#' + (i+1) + ' 重量(Weight)导出为g，必须在0~100000000g之间（当前: ' + (isNaN(weightKg) ? '空' : weightG + 'g') + '）');
      else if (weightKg > 100) warnings.push('变体#' + (i+1) + ' 重量较大(' + weightKg + 'kg)，导出会转换为' + weightG + 'g，请确认单位是否正确');
      if (variations[i].sku && variations[i].sku.length > SHOPEE_USER_SKU_MAX_LENGTH) errors.push('变体#' + (i+1) + ' 商家SKU不能超过' + SHOPEE_USER_SKU_MAX_LENGTH + '字符（随机前缀另占' + SKU_PREFIX_LENGTH + '字符）');
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
  var templateShipping = Array.isArray(templateManifest?.shipping_channels) ? templateManifest.shipping_channels : [];
  var allowedShippingIds = templateShipping.map(function(channel) { return String(channel.id); });
  var shippingChannels = normalizeShopeeShippingChannels(product.shipping_channels, allowedShippingIds);
  var blockedPreOrderChannels = product.pre_order_dts === null || product.pre_order_dts === undefined || product.pre_order_dts === ''
    ? []
    : shippingChannels.filter(function(channel) { return SHOPEE_PREORDER_BLOCKED_CHANNEL_IDS.includes(channel); });
  shippingChannels = normalizeShopeePreOrderShippingChannels(shippingChannels, product.pre_order_dts);
  if (blockedPreOrderChannels.length) warnings.push('Pre-order DTS 已自动关闭不支持预售的物流渠道: ' + blockedPreOrderChannels.join(', '));
  if (!shippingChannels.length) errors.push(blockedPreOrderChannels.length ? '预售商品不能使用5012 / Trong Ngày，请至少开启其他物流渠道' : '至少需要开启一个物流渠道');
  for (var ci = 0; ci < shippingChannels.length; ci++) {
    var channelLimit = Number(templateShipping.find(function(channel) { return String(channel.id) === shippingChannels[ci]; })?.price_limit);
    if (channelLimit && highest > channelLimit) errors.push('物流渠道' + shippingChannels[ci] + '允许的最高价格为' + channelLimit);
  }
  if (product.size_chart_template_id && product.size_chart_image) errors.push('尺码表模板和尺码表图片只能填写一个');

  // 分类ID
  if (categoryId && !/^\d+$/.test(categoryId)) warnings.push('分类ID(Category)应为数字（当前: ' + categoryId + '）');
  if (categoryId && !templateCategory) errors.push('分类ID不在当前店铺模板中');
  if (product.pre_order_dts !== null && product.pre_order_dts !== undefined && product.pre_order_dts !== '' && templateCategory?.dts_min !== null && templateCategory?.dts_min !== undefined) {
    var dts = Number(product.pre_order_dts);
    if (dts < Number(templateCategory.dts_min) || dts > Number(templateCategory.dts_max)) errors.push('当前分类的Pre-order DTS范围为' + templateCategory.dts_range);
  }

  // HS Code
  if (hsCode && !/^\d{4,8}$/.test(hsCode)) warnings.push('HS Code应为4/6/8位数字（当前: ' + hsCode + '）');

  // GTIN
  if (gtin && !/^\d{8,14}$/.test(gtin)) warnings.push('GTIN应为8~14位数字（当前: ' + gtin + '）');

  // Parent SKU / SKU 重复检查
  var skuSet = {};
  for (var vi = 0; vi < variations.length; vi++) {
    var sku = variations[vi].sku || '';
    if (sku) {
      if (skuSet[sku]) errors.push('SKU "' + sku + '" 重复（变体#' + (vi+1) + '），店内不可重复');
      skuSet[sku] = true;
    }
  }

  return { errors: errors, warnings: warnings, valid: errors.length === 0 };
}

async function shopeeHandleExport(env, taskId) {
  const product = await shopeeGetProduct(env, taskId);
  if (!product) return error('商品不存在', 404);
  if (!product.template_profile_id) return error('任务未关联 Shopee 全局模板档案，请重新保存任务', 409);
  const templateProfile = await shopeeGetTemplateProfile(env, product.template_profile_id);
  if (!templateProfile) return error('任务关联的模板档案不存在', 409);
  const currentVersion = await shopeeGetCurrentTemplateVersion(env, product.template_profile_id);
  const templateVersion = currentVersion || (product.template_version_id ? await shopeeGetTemplateVersion(env, product.template_version_id) : null);
  if (!templateVersion) return error('模板档案没有可用于导出的版本', 409);
  const templateManifest = parseJson(templateVersion.manifest_json, {});
  const registeredFields = (await shopeeGetTemplateFields(env, templateVersion.id))?.results || [];
  const fieldMappings = new Map(registeredFields.map(field => [field.token, field]));
  templateManifest.fields = (templateManifest.fields || []).map(field => {
    const registered = fieldMappings.get(field.token);
    return { ...field, semantic_key: registered?.semantic_key || field.semantic_key || '' };
  });
  const unknownMandatoryFields = templateManifest.fields.filter(field => {
    const registered = fieldMappings.get(field.token);
    const mappingStatus = registered?.mapping_status || field.mapping_status || '';
    if (registered?.semantic_key || field.semantic_key) return false;
    if (mappingStatus) return mappingStatus === 'unmapped_required';
    const requirement = String(field.requirement || '');
    return !/conditional|có điều kiện/i.test(requirement) && /mandatory|required|bắt buộc/i.test(requirement);
  });
  if (unknownMandatoryFields.length) {
    return json({ success: false, error: '模板版本仍有未映射的必填 token', errors: unknownMandatoryFields.map(field => `${field.label || field.key} (${field.token || field.key})`) }, 409);
  }
  const templateCategory = product.category_id ? await shopeeGetTemplateCategory(env, templateVersion.id, product.category_id) : null;
  const skuImagePlan = await getOne(env, "SELECT 1 AS present FROM ews_shopee_push_plans WHERE task_id=? AND webhook_type GLOB 'sku_[0-9]*' LIMIT 1", [taskId]);
  const skuImagePlanned = !!skuImagePlan?.present;
  const variations = product.variations || [];
  const productType = normalizeShopeeProductType(product.product_type, variations);
  const isSingleProduct = productType === 'single';
  const firstGeneratedDescription = String(product.sub_tasks?.[0]?.description || '').trim();

  // 校验
  var validation = validateShopeeRow({ ...product, description: firstGeneratedDescription }, variations, templateManifest, templateCategory);
  // 有错误则拒绝导出，有警告则附带
  if (!validation.valid) {
    return json({ success: false, error: '数据校验失败', errors: validation.errors, warnings: validation.warnings }, 400);
  }

  const rows = [];
  const mode = product.mode || 'full';
  const variationImageMode = normalizeShopeeVariationImageMode(product.variation_image_mode, 'upload');
  const variationGroups = getShopeeVariationGroups(isSingleProduct ? [] : variations, variationImageMode);
  const variationImagePositions = new Map();
  for (let groupIndex = 0; groupIndex < variationGroups.length; groupIndex++) {
    for (const variation of variationGroups[groupIndex].variations) variationImagePositions.set(variation.id, groupIndex + 1);
  }
  const mainImgTotal = Math.min(Math.max(product.main_image_count || 9, 5), 9);
  const expectedSetCount = Math.max(parseInt(product.generate_count) || 1, 1);
  const subTasks = (product.sub_tasks && product.sub_tasks.length) ? product.sub_tasks : [];
  const imageMap = new Map((product.images_rec || []).map(image => [image.sub_task_id + '|' + image.image_type + '|' + image.position, image.image_url || '']));
  const allowedShippingIds = (templateManifest.shipping_channels || []).map(channel => String(channel.id));
  var shippingChannels = normalizeShopeePreOrderShippingChannels(normalizeShopeeShippingChannels(product.shipping_channels, allowedShippingIds), product.pre_order_dts);

  function generatedImage(type, pos, setIdx, subTaskId) {
    return imageMap.get(subTaskId + '|' + type + '|' + pos) || '';
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
    if (variationImageMode === 'upload') return v.image_per_variation || '';
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
  function weightInGrams(variation) {
    const kg = parseFloat(variation.weight_kg);
    return isNaN(kg) ? '' : Math.round(kg * 1000);
  }
  function styleCodeFor(subTask, setIdx) {
    return subTask.id ? subTask.id.slice(0, 8) : `${taskId.slice(0, 8)}-S${setIdx + 1}`;
  }
  function parentSkuFor(subTask, setIdx) {
    return product.parent_sku ? `${product.parent_sku}-${setIdx + 1}` : styleCodeFor(subTask, setIdx);
  }
  function skuCodeFor(subTask, setIdx, v, variationsIdx) {
    const randomId = styleCodeFor(subTask, setIdx);
    return v.sku ? `${randomId}-${v.sku}` : `${randomId}-V${variationsIdx + 1}`;
  }

  const exportErrors = [];
  function addExportError(msg) {
    if (exportErrors.length < 80) exportErrors.push(msg);
  }
  if (subTasks.length === 0) addExportError('请先推送并完成AI生成任务，当前没有商品套图子任务');
  if (subTasks.length > 0 && subTasks.length < expectedSetCount) addExportError('AI商品套图数量不足: ' + subTasks.length + '/' + expectedSetCount);
  if (!isSingleProduct && !product.variation_name1_export) addExportError('缺少AI规范化一级规格名');
  if (productType === 'two' && !product.variation_name2_export) addExportError('缺少AI规范化二级规格名');
  const exportedSkuCodes = new Set();
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
      const skuKey = skuCode.toLocaleLowerCase();
      if (exportedSkuCodes.has(skuKey)) addExportError(setLabel + ' 变体#' + (vi + 1) + ' 导出SKU重复');
      exportedSkuCodes.add(skuKey);
      if (!isSingleProduct && (option1.length < 1 || option1.length > 20)) addExportError(setLabel + ' 变体#' + (vi + 1) + ' 缺少合规一级规格值(1~20字符)');
      if (productType === 'two' && (option2.length < 1 || option2.length > 20)) addExportError(setLabel + ' 变体#' + (vi + 1) + ' 缺少合规二级规格值(1~20字符)');
      if (!isSingleProduct && variationImageMode === 'upload' && !getSkuUrl(setIdx, subTask.id || '', vi, v)) addExportError(setLabel + ' 变体#' + (vi + 1) + ' 缺少自上传SKU变体图');
      if (!isSingleProduct && variationImageMode === 'ai' && skuImagePlanned && !getSkuUrl(setIdx, subTask.id || '', vi, v)) addExportError(setLabel + ' 变体#' + (vi + 1) + ' 缺少AI SKU变体图');
      if (skuCode.length > SHOPEE_SKU_MAX_LENGTH) addExportError(setLabel + ' 变体#' + (vi + 1) + ` 导出SKU超过${SHOPEE_SKU_MAX_LENGTH}字符`);
    }
  }
  if (exportErrors.length) {
    return json({ success: false, error: 'Shopee资源未生成完成，已阻止导出', errors: exportErrors, warnings: validation.warnings }, 400);
  }

  // 先构造平台语义字段，再由店铺模板隐藏 token 决定实际列位置。
  function makeRow(subTask, setIdx, variationsIdx) {
    var v = variations[variationsIdx];
    var images = productImages(setIdx, subTask.id || '');
    var coverImage = getImg(setIdx, subTask.id || '', 'main', 1);
    var parentSku = parentSkuFor(subTask, setIdx);
    var option1 = option1For(subTask, v);
    var option2 = option2For(v);
    var skuCode = skuCodeFor(subTask, setIdx, v, variationsIdx);
    var exportPrice = exportPriceForVariant(v, taskId, setIdx, variationsIdx);
    const row = {
      ps_category: product.category_id || '',
      ps_product_name: subTask.title || '',
      ps_product_description: productDescriptionFor(subTask),
      ps_sku_parent_short: parentSku,
      et_title_variation_integration_no: isSingleProduct ? '' : parentSku,
      et_title_variation_1: isSingleProduct ? '' : product.variation_name1_export || '',
      et_title_option_for_variation_1: option1,
      et_title_image_per_variation: getSkuUrl(setIdx, subTask.id || '', variationsIdx, v),
      et_title_variation_2: productType === 'two' ? product.variation_name2_export || '' : '',
      et_title_option_for_variation_2: option2,
      ps_price: exportPrice,
      ps_stock: v.stock ?? '',
      ps_sku_short: skuCode,
      ps_new_size_chart: product.size_chart_template_id || '',
      et_title_size_chart: product.size_chart_image || '',
      ps_gtin_code: product.gtin || '',
      ps_item_cover_image: coverImage,
      ps_item_image_1: images[0] || '',
      ps_item_image_2: images[1] || '',
      ps_item_image_3: images[2] || '',
      ps_item_image_4: images[3] || '',
      ps_item_image_5: images[4] || '',
      ps_item_image_6: images[5] || '',
      ps_item_image_7: images[6] || '',
      ps_item_image_8: images[7] || '',
      ps_weight: weightInGrams(v),
      ps_length: product.length_cm ?? '',
      ps_width: product.width_cm ?? '',
      ps_height: product.height_cm ?? '',
      ps_product_pre_order_dts: product.pre_order_dts ?? '',
      ps_brand: product.brand_id || '',
      et_title_reason: '',
    };
    for (const channel of (templateManifest.shipping_channels || [])) row[`channel_id.${channel.id}`] = shipping(String(channel.id));
    return row;
  }

  for (let si = 0; si < subTasks.length; si++) {
    const subTask = subTasks[si];
    const setIdx = subTask.set_index ?? si;
    for (let vi = 0; vi < variations.length; vi++) rows.push(makeRow(subTask, setIdx, vi));
  }

  const categoryRequiredKeys = templateManifest.category_required_fields?.[String(product.category_id || '')] || [];
  const missingCategoryFields = categoryRequiredKeys.filter(key => {
    const field = templateManifest.fields.find(candidate => candidate.key === key);
    const dataKey = field?.semantic_key || field?.key || key;
    return rows.some(row => row[dataKey] === undefined || row[dataKey] === null || row[dataKey] === '');
  });
  if (missingCategoryFields.length) {
    const labels = missingCategoryFields.map(key => {
      const field = templateManifest.fields.find(candidate => candidate.key === key);
      return `${field?.label || key} (${key})`;
    });
    return json({ success: false, error: '所选 Category ID 存在尚未填写的类目必填字段', errors: labels }, 400);
  }

  const templateObject = await env.R2.get(templateVersion.r2_key);
  if (!templateObject) return error('模板原始文件不存在，请重新上传该模板版本', 409);
  try {
    const workbook = buildShopeeWorkbook(await templateObject.arrayBuffer(), templateManifest, rows);
    const safeName = String(product.name || taskId.slice(0, 8)).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 60) || taskId.slice(0, 8);
    const filename = `Shopee_${safeName}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    return new Response(workbook, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="Shopee_export.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error('Shopee workbook build failed:', err.message);
    return error('店铺模板写入失败，请重新上传最新模板', 500);
  }
}

// ========== 上传 ==========

async function handleUpload(request, env) {
  const formData = await parseBody(request);
  if (!(formData instanceof FormData)) return error('请使用 multipart/form-data 格式上传', 400);
  const file = formData.get('file');
  if (!file || typeof file.arrayBuffer !== 'function') return error('请选择有效文件', 400);
  const taskId = formData.get('task_id'); if (!taskId) return error('缺少 task_id', 400);
  const folder = String(formData.get('folder') || 'uploads');
  const task = await getTaskIndex(env, taskId);
  if (!task) return error('任务不存在', 404);
  if (request.auth?.role !== 'admin' && task.user_id !== request.auth?.username) return error('无权访问该任务', 403);
  const imageTypes = ['image/jpeg','image/png','image/webp','image/gif'];
  const isSizeChartPdf = folder === 'size-chart' && file.type === 'application/pdf';
  if (!imageTypes.includes(file.type) && !isSizeChartPdf) return error('仅支持 JPG/PNG/WebP/GIF，尺码表可使用 PDF', 400);
  if (folder === 'sku-upload' && !['image/jpeg','image/png'].includes(file.type)) return error('SKU成品图仅支持 JPG 或 PNG', 400);
  const maxSize = folder === 'size-chart' ? 2 * 1024 * 1024 : 10 * 1024 * 1024;
  if (file.size > maxSize) return error(folder === 'size-chart' ? '尺码表文件不能超过 2MB' : '文件大小不能超过 10MB', 400);
  let buffer = await file.arrayBuffer();
  let contentType = detectImageContentType(buffer, file.type);
  let extension = isSizeChartPdf ? 'pdf' : ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[contentType] || 'bin');
  let processing = null;
  if (folder === 'sku-upload') {
    try {
      processing = await processSkuUploadImage(buffer, contentType);
    } catch (err) {
      return error(err.message || 'SKU图片处理失败', 400);
    }
    buffer = processing.buffer;
    contentType = processing.contentType;
    extension = processing.extension;
  }
  const key = `ews/${taskId}/${folder}/${uuid()}.${extension}`;
  await env.R2.put(key, buffer, { httpMetadata: { contentType } });
  const config = await getConfig(env);
  const publicUrl = config.r2_public_url || '';
  if (!publicUrl) {
    await env.R2.delete(key);
    return error('R2公开域名未配置，无法生成图片URL', 503);
  }
  return json({
    success: true,
    key,
    url: `${publicUrl.replace(/\/+$/, '')}/${key}`,
    content_type: contentType,
    size_bytes: buffer.byteLength,
    ...(processing ? { image_processing: { quality: processing.quality, resized: processing.resized, width: processing.width, height: processing.height } } : {}),
    message: '上传成功',
  });
}
