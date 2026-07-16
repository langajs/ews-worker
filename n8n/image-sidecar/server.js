import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import sharp from 'sharp';

const PORT = parseInt(process.env.PORT || '3000');
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || '4');
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1900000;
const JPEG_QUALITY = 88;
const TICKET_ORIGIN = process.env.TICKET_ORIGIN || 'https://ewsz.langaj.cc';

let active = 0;
const waiters = [];

function processingError(message, retryable = true) {
  const error = new Error(message);
  error.retryable = retryable;
  return error;
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function withSlot(handler) {
  if (active >= MAX_CONCURRENCY) await new Promise(resolve => waiters.push(resolve));
  active++;
  try {
    return await handler();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('请求体超过64KB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function publicHttpUrl(value) {
  let url;
  try { url = new URL(String(value || '')); }
  catch (_) { throw processingError('图片源URL无效', false); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw processingError('图片源URL无效', false);
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || /^127\./.test(host) || /^10\./.test(host)
    || /^192\.168\./.test(host) || /^169\.254\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === '::1') throw processingError('图片源URL不允许访问内网', false);
  return url;
}

async function fetchBuffer(sourceUrl) {
  let url = publicHttpUrl(sourceUrl);
  let response;
  for (let redirect = 0; redirect <= 3; redirect++) {
    response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    if (!location || redirect === 3) throw processingError('图片下载重定向无效', false);
    url = publicHttpUrl(new URL(location, url).href);
  }
  if (!response.ok) {
    const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
    throw processingError(`图片下载失败: HTTP ${response.status}`, retryable);
  }
  const declaredSize = parseInt(response.headers.get('content-length') || '0');
  if (declaredSize > MAX_SOURCE_BYTES) throw processingError('源图片超过16MB', false);
  if (!response.body) throw processingError('图片服务没有返回响应体');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_SOURCE_BYTES) throw processingError('源图片超过16MB', false);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function encodeJpeg(input) {
  const metadata = await sharp(input, { limitInputPixels: 40_000_000 }).metadata();
  if (!metadata.width || !metadata.height) throw processingError('无法识别图片尺寸', false);
  let width = metadata.width;
  let height = metadata.height;
  let output = await sharp(input, { limitInputPixels: 40_000_000 })
    .rotate()
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: JPEG_QUALITY, chromaSubsampling: '4:2:0' })
    .toBuffer();
  for (let attempt = 0; output.length > MAX_OUTPUT_BYTES && attempt < 4; attempt++) {
    const scale = Math.min(0.95, Math.sqrt(MAX_OUTPUT_BYTES / output.length) * 0.97);
    width = Math.max(1, Math.floor(width * scale));
    height = Math.max(1, Math.floor(height * scale));
    output = await sharp(input, { limitInputPixels: 40_000_000 })
      .rotate()
      .flatten({ background: '#ffffff' })
      .resize({ width, height, fit: 'inside', kernel: sharp.kernel.linear, withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY, chromaSubsampling: '4:2:0' })
      .toBuffer();
  }
  if (output.length > MAX_OUTPUT_BYTES) throw processingError('图片压缩后仍超过1.9MB', false);
  return output;
}

function ticketUrl(value) {
  let url;
  try { url = new URL(String(value || '')); }
  catch (_) { throw processingError('上传票据地址无效', false); }
  if (url.origin !== TICKET_ORIGIN || url.pathname !== '/api/internal/r2-upload-ticket') throw processingError('上传票据地址无效', false);
  return url;
}

async function requestUploadTicket(body, image, sha256) {
  const response = await fetch(ticketUrl(body.ticket_url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      callback_secret: body.callback_secret,
      task_id: body.task_id,
      plan_id: body.plan_id,
      sub_task_id: body.sub_task_id,
      set_index: body.set_index,
      image_type: body.image_type,
      image_position: body.image_position,
      content_type: 'image/jpeg',
      size_bytes: image.length,
      sha256,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.success !== true || !result.upload_url || !result.r2_key) {
    const retryable = result.retryable === true || response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
    throw processingError(result.error || `上传票据签发失败: HTTP ${response.status}`, retryable);
  }
  return result;
}

async function uploadImage(ticket, image) {
  const response = await fetch(ticket.upload_url, {
    method: ticket.method || 'PUT',
    headers: ticket.headers || { 'content-type': 'image/jpeg' },
    body: image,
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw processingError(`R2上传失败: HTTP ${response.status}`, true);
  return String(response.headers.get('etag') || '').replace(/^"|"$/g, '');
}

async function processAndUpload(body) {
  const required = ['source_url', 'ticket_url', 'callback_secret', 'task_id', 'plan_id', 'sub_task_id', 'image_type', 'image_position'];
  if (required.some(key => body[key] === undefined || body[key] === '')) throw processingError('图片处理请求缺少必要字段', false);
  const source = await fetchBuffer(body.source_url);
  const image = await encodeJpeg(source);
  const sha256 = createHash('sha256').update(image).digest('hex');
  const ticket = await requestUploadTicket(body, image, sha256);
  const etag = await uploadImage(ticket, image);
  return {
    success: true,
    r2_key: ticket.r2_key,
    size_bytes: image.length,
    sha256,
    content_type: 'image/jpeg',
    etag,
  };
}

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') return json(response, 200, { success: true, active, waiting: waiters.length });
  if (request.method !== 'POST' || request.url !== '/process-upload') return json(response, 404, { success: false, error: 'Not Found' });
  try {
    const body = await readJson(request);
    const result = await withSlot(() => processAndUpload(body));
    return json(response, 200, result);
  } catch (error) {
    return json(response, 200, { success: false, retryable: error.retryable !== false, error: error.message || '图片处理失败' });
  }
});

server.requestTimeout = 120000;
server.listen(PORT, '0.0.0.0');
