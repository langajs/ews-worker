import { ProcessingError } from './errors.js';

function callbackUrl(ticketUrl, config) {
  const parsed = new URL(ticketUrl);
  if (parsed.origin !== config.ticketOrigin || parsed.pathname !== '/api/internal/r2-upload-ticket') {
    throw new ProcessingError('上传票据地址无效', false);
  }
  parsed.pathname = '/api/callback';
  parsed.search = '';
  parsed.hash = '';
  return parsed;
}

function retryableStatus(status) {
  return [408, 425, 429].includes(status) || status >= 500;
}

async function postJson(url, payload, config) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(config.workerRequestTimeoutMs),
  });
  const result = await response.json().catch(() => ({}));
  return { response, result };
}

export async function requestUploadTicket(body, image, sha256, config) {
  const { response, result } = await postJson(body.ticket_url, {
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
  }, config);
  if (!response.ok || result.success !== true || !result.upload_url || !result.r2_key) {
    const retryable = result.retryable === true || retryableStatus(response.status);
    throw new ProcessingError(result.error || `上传票据签发失败: HTTP ${response.status}`, retryable);
  }
  return result;
}

export async function uploadImage(ticket, image, config) {
  const uploadUrl = new URL(String(ticket.upload_url || ''));
  if (uploadUrl.protocol !== 'https:') throw new ProcessingError('R2上传地址无效', false);
  const response = await fetch(uploadUrl, {
    method: ticket.method || 'PUT',
    headers: ticket.headers || { 'content-type': 'image/jpeg' },
    body: image,
    signal: AbortSignal.timeout(config.downloadTimeoutMs),
  });
  if (!response.ok) {
    const retryable = [401, 403].includes(response.status) || retryableStatus(response.status);
    throw new ProcessingError(`R2上传失败: HTTP ${response.status}`, retryable);
  }
  return String(response.headers.get('etag') || '').replace(/^"|"$/g, '');
}

export async function sendWorkerCallback(body, outcome, config) {
  const payload = {
    callback_secret: body.callback_secret,
    task_id: body.task_id,
    plan_id: body.plan_id,
    sub_task_id: body.sub_task_id,
    set_index: body.set_index,
    image_type: body.image_type,
    image_position: body.image_position,
    ...outcome,
  };
  let lastError;
  for (let attempt = 1; attempt <= config.callbackAttempts; attempt++) {
    try {
      const { response, result } = await postJson(callbackUrl(body.ticket_url, config), payload, config);
      if (response.ok && result.success === true) return result;
      const retryable = result.retryable === true || retryableStatus(response.status);
      lastError = new ProcessingError(result.error || `Worker回调失败: HTTP ${response.status}`, retryable);
      if (!retryable) break;
    } catch (error) {
      lastError = error instanceof ProcessingError ? error : new ProcessingError(error?.message || 'Worker回调失败', true);
    }
    if (attempt < config.callbackAttempts) await new Promise(resolve => setTimeout(resolve, Math.min(5000, attempt * 500)));
  }
  throw lastError || new ProcessingError('Worker回调失败', true);
}
