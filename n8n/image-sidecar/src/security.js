import { timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ProcessingError } from './errors.js';

export function secretsEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ''));
  const expectedBuffer = Buffer.from(String(expected || ''));
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function isPrivateIpv4(address, options = {}) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part))) return true;
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || parts[0] >= 224
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (!options.allowBenchmarkDns && parts[0] === 198 && [18, 19].includes(parts[1]));
}

function isPrivateAddress(address, options = {}) {
  const normalized = String(address || '').toLowerCase().split('%')[0];
  const family = isIP(normalized);
  if (family === 4) return isPrivateIpv4(normalized, options);
  if (family !== 6) return true;
  if (normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith('::ffff:')) return isPrivateIpv4(normalized.slice(7));
  return false;
}

function hostAllowed(hostname, allowlist) {
  if (!allowlist.length) return true;
  return allowlist.some(allowed => hostname === allowed || hostname.endsWith(`.${allowed}`));
}

export function parsePublicSourceUrl(value, config) {
  let parsed;
  try { parsed = new URL(String(value || '')); }
  catch (_) { throw new ProcessingError('图片源URL无效', false); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new ProcessingError('图片源URL无效', false);
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostAllowed(hostname, config.sourceHostAllowlist)) throw new ProcessingError('图片源域名不在允许列表', false);
  if (isIP(hostname) && isPrivateAddress(hostname)) throw new ProcessingError('图片源URL不允许访问内网', false);
  if (hostname === 'localhost' || hostname.endsWith('.local')) throw new ProcessingError('图片源URL不允许访问内网', false);
  return parsed;
}

export async function assertPublicResolution(url, config) {
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(hostname)) return;
  let addresses;
  try { addresses = await lookup(hostname, { all: true, verbatim: true }); }
  catch (_) { throw new ProcessingError('图片源域名解析失败', true); }
  const resolutionOptions = { allowBenchmarkDns: config.allowBenchmarkDns === true };
  if (!addresses.length || addresses.some(item => isPrivateAddress(item.address, resolutionOptions))) {
    throw new ProcessingError('图片源URL解析到内网地址', false);
  }
}

export function validateImageJob(body, config) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ProcessingError('请求体必须是JSON对象', false);
  if (!secretsEqual(body.callback_secret, config.serviceSecret)) throw new ProcessingError('图片服务鉴权失败', false);
  const required = ['source_url', 'ticket_url', 'task_id', 'plan_id', 'sub_task_id', 'image_type', 'image_position'];
  if (required.some(key => body[key] === undefined || String(body[key]).trim() === '')) {
    throw new ProcessingError('图片处理请求缺少必要字段', false);
  }
  parsePublicSourceUrl(body.source_url, config);
  const ticket = new URL(String(body.ticket_url));
  if (ticket.origin !== config.ticketOrigin || ticket.pathname !== '/api/internal/r2-upload-ticket') {
    throw new ProcessingError('上传票据地址无效', false);
  }
  const imagePosition = Number.parseInt(body.image_position, 10);
  if (!Number.isInteger(imagePosition) || imagePosition < 1) throw new ProcessingError('图片位置无效', false);
  return {
    source_url: String(body.source_url),
    ticket_url: ticket.href,
    callback_secret: String(body.callback_secret),
    task_id: String(body.task_id),
    plan_id: String(body.plan_id),
    sub_task_id: String(body.sub_task_id),
    set_index: Number.parseInt(body.set_index, 10) || 0,
    image_type: String(body.image_type),
    image_position: imagePosition,
  };
}
