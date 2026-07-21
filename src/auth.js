// EWS - JWT 认证模块 + 用户管理
// 使用 Web Crypto API 实现 JWT（HMAC-SHA256）+ 密码哈希（SHA-256）

const JWT_EXPIRY = 24 * 60 * 60;
const DEFAULT_PASSWORD = 'admin123';

async function getJwtSecretKey(env) {
  const encoder = new TextEncoder();
  if (env.JWT_SECRET) {
    return await crypto.subtle.importKey('raw', encoder.encode(env.JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  }
  let stored = await env.DB.prepare(
    "SELECT value FROM ews_config WHERE key = ? AND platform = ''"
  ).bind('jwt_secret_name').first();
  if (!stored) {
    // 自动生成
    const keyBytes = new Uint8Array(32);
    crypto.getRandomValues(keyBytes);
    const keyHex = Array.from(keyBytes).map(b => b.toString(16).padStart(2, '0')).join('');
    await env.DB.prepare(
      "INSERT INTO ews_config (key, value, platform, updated_at) VALUES (?, ?, '', datetime('now')) ON CONFLICT(key, platform) DO UPDATE SET value = ?, updated_at = datetime('now')"
    ).bind('jwt_secret_name', keyHex, keyHex).run();
    stored = { value: keyHex };
  }
  return await crypto.subtle.importKey('raw', encoder.encode(stored.value),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function generateToken(env, username, role) {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = btoa(JSON.stringify({
    sub: username, role, iat: now, exp: now + JWT_EXPIRY
  }));
  const key = await getJwtSecretKey(env);
  const signature = await crypto.subtle.sign('HMAC', key,
    new TextEncoder().encode(header + '.' + payload));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return header + '.' + payload + '.' + sigB64;
}

async function hashPassword(password) {
  const saltBytes = new Uint8Array(4);
  crypto.getRandomValues(saltBytes);
  const salt = Array.from(saltBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(salt + password));
  const hashB64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
  return `sha256$${salt}$${hashB64}`;
}

async function verifyPassword(password, stored) {
  if (!stored || stored === '$2a$10$EWS_DEFAULT_HASH') return password === DEFAULT_PASSWORD;
  if (stored.startsWith('$2a$')) {
    // bcrypt 旧格式兼容
    try {
      const bcrypt = require('bcryptjs');
      return bcrypt.compareSync(password, stored);
    } catch { return password === DEFAULT_PASSWORD; }
  }
  if (stored.startsWith('sha256$')) {
    const parts = stored.split('$');
    if (parts.length !== 3) return false;
    const encoder = new TextEncoder();
    const hash = await crypto.subtle.digest('SHA-256', encoder.encode(parts[1] + password));
    const hashB64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
    return hashB64 === parts[2];
  }
  return false;
}

async function authenticateRequest(request, env) {
  let token = '';
  const authHeader = request.headers.get('Authorization') || '';
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else {
    const cookie = request.headers.get('Cookie') || '';
    const match = cookie.match(/(?:^|;\s*)ews_token=([^;]+)/);
    if (match) token = decodeURIComponent(match[1]);
  }
  if (!token) return { valid: false };

  try {
    const parts = token.split('.');
    if (parts.length !== 3) return { valid: false };
    const key = await getJwtSecretKey(env);
    const valid = await crypto.subtle.verify('HMAC', key,
      Uint8Array.from(atob(parts[2]), c => c.charCodeAt(0)),
      new TextEncoder().encode(parts[0] + '.' + parts[1]));
    if (!valid) return { valid: false };

    const payload = JSON.parse(atob(parts[1]));
    if (payload.exp < Math.floor(Date.now() / 1000)) return { valid: false };

    // 从 ews_users 验证用户仍有效
    let user;
    try {
      user = await env.DB.prepare("SELECT u.*,g.name AS group_name,g.status AS group_status FROM ews_users u LEFT JOIN ews_groups g ON g.id=u.group_id WHERE u.username = ?").bind(payload.sub).first();
    } catch (_) {}
    if (!user || user.is_active === 0 || (user.role !== 'admin' && user.group_status !== 'active')) return { valid: false };

    return {
      valid: true,
      username: payload.sub,
      role: user.role || payload.role || 'user',
      platform_access: user.platform_access || 'allow',
      group_id: user.group_id || '',
      group_name: user.group_name || '',
    };
  } catch {
    return { valid: false };
  }
}

export { generateToken, hashPassword, verifyPassword, authenticateRequest, DEFAULT_PASSWORD };
