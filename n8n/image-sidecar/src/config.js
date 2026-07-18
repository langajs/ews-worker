function integer(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function ticketOrigin(value) {
  const parsed = new URL(String(value || 'https://ewsz.langaj.cc'));
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('TICKET_ORIGIN 必须使用 HTTP 或 HTTPS');
  return parsed.origin;
}

export function loadConfig(environment = process.env) {
  const serviceSecret = String(environment.IMAGE_SERVICE_SECRET || '').trim();
  if (!serviceSecret) throw new Error('缺少 IMAGE_SERVICE_SECRET');
  return Object.freeze({
    port: integer(environment.PORT, 3000, 1, 65535),
    host: String(environment.HOST || '0.0.0.0'),
    redisUrl: String(environment.REDIS_URL || 'redis://valkey:6379'),
    queueName: String(environment.QUEUE_NAME || 'ews-image-processing'),
    queueConcurrency: integer(environment.WORKER_CONCURRENCY, 8, 1, 32),
    queueAttempts: integer(environment.JOB_ATTEMPTS, 4, 1, 10),
    maxQueueDepth: integer(environment.MAX_QUEUE_DEPTH, 10000, 100, 100000),
    maxSourceBytes: integer(environment.MAX_SOURCE_BYTES, 16 * 1024 * 1024, 1024, 64 * 1024 * 1024),
    maxOutputBytes: integer(environment.MAX_OUTPUT_BYTES, 1900000, 100000, 10 * 1024 * 1024),
    jpegQuality: integer(environment.JPEG_QUALITY, 88, 1, 100),
    downloadTimeoutMs: integer(environment.DOWNLOAD_TIMEOUT_MS, 30000, 1000, 120000),
    workerRequestTimeoutMs: integer(environment.WORKER_REQUEST_TIMEOUT_MS, 15000, 1000, 60000),
    callbackAttempts: integer(environment.CALLBACK_ATTEMPTS, 5, 1, 10),
    ticketOrigin: ticketOrigin(environment.TICKET_ORIGIN),
    serviceSecret,
    sourceHostAllowlist: String(environment.SOURCE_HOST_ALLOWLIST || '')
      .split(',').map(value => value.trim().toLowerCase()).filter(Boolean),
    logLevel: String(environment.LOG_LEVEL || 'info'),
  });
}
