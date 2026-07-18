import Fastify from 'fastify';
import { ProcessingError } from './errors.js';
import { imageJobId } from './queue.js';
import { secretsEqual, validateImageJob } from './security.js';

function requestSecret(request) {
  const authorization = String(request.headers.authorization || '');
  if (authorization.startsWith('Bearer ')) return authorization.slice(7);
  return String(request.headers['x-image-service-secret'] || '');
}

function requireAdminAuth(request, reply, config) {
  if (secretsEqual(requestSecret(request), config.serviceSecret)) return true;
  reply.code(401).send({ success: false, retryable: false, error: '图片服务鉴权失败' });
  return false;
}

export function buildApp({ config, queue, redis }) {
  const app = Fastify({
    logger: { level: config.logLevel, redact: ['req.headers.authorization', 'req.body.callback_secret'] },
    bodyLimit: 64 * 1024,
    requestTimeout: 10000,
  });

  app.get('/healthz', async () => ({ success: true, status: 'alive' }));
  app.get('/readyz', async (_, reply) => {
    try {
      await redis.ping();
      return { success: true, status: 'ready' };
    } catch (_) {
      return reply.code(503).send({ success: false, status: 'not_ready' });
    }
  });

  app.post('/v1/image-jobs', async (request, reply) => {
    let body;
    try { body = validateImageJob(request.body, config); }
    catch (error) {
      const status = error.message === '图片服务鉴权失败' ? 401 : 400;
      return reply.code(status).send({ success: false, retryable: false, error: error.message });
    }
    const jobId = imageJobId(body);
    const existing = await queue.getJob(jobId);
    let uploadResult = null;
    if (existing) {
      const state = await existing.getState();
      if (!['completed', 'failed'].includes(state)) {
        return reply.code(202).send({ success: true, status: state, job_id: jobId, duplicate: true });
      }
      if (state === 'completed' && existing.returnvalue?.success === true) {
        uploadResult = existing.data.upload_result || null;
      }
    }
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized');
    const depth = Object.values(counts).reduce((total, count) => total + count, 0);
    if (depth >= config.maxQueueDepth) {
      reply.header('retry-after', '30');
      return reply.code(429).send({ success: false, retryable: true, error: '图片处理队列已满' });
    }
    if (existing) await existing.remove();
    await queue.add('process-image', uploadResult ? { ...body, upload_result: uploadResult } : body, { jobId });
    return reply.code(202).send({
      success: true,
      status: 'accepted',
      job_id: jobId,
      duplicate: Boolean(existing),
      callback_replay: Boolean(uploadResult),
    });
  });

  app.get('/v1/image-jobs/:jobId', async (request, reply) => {
    if (!requireAdminAuth(request, reply, config)) return;
    const job = await queue.getJob(request.params.jobId);
    if (!job) return reply.code(404).send({ success: false, error: '任务不存在' });
    return {
      success: true,
      job_id: job.id,
      status: await job.getState(),
      progress: job.progress,
      attempts_made: job.attemptsMade,
      result: job.returnvalue || null,
      failed_reason: job.failedReason || '',
    };
  });

  app.post('/v1/image-jobs/:jobId/retry', async (request, reply) => {
    if (!requireAdminAuth(request, reply, config)) return;
    const job = await queue.getJob(request.params.jobId);
    if (!job) return reply.code(404).send({ success: false, error: '任务不存在' });
    if (await job.getState() !== 'failed') return reply.code(409).send({ success: false, error: '只有失败任务可以重试' });
    await job.retry();
    return reply.code(202).send({ success: true, status: 'accepted', job_id: job.id });
  });

  app.get('/v1/stats', async (request, reply) => {
    if (!requireAdminAuth(request, reply, config)) return;
    return { success: true, counts: await queue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed') };
  });

  app.setErrorHandler((error, _, reply) => {
    app.log.error({ err: error }, 'request failed');
    const known = error instanceof ProcessingError;
    reply.code(known ? 400 : 503).send({
      success: false,
      retryable: known ? error.retryable !== false : true,
      error: known ? error.message : '图片服务暂时不可用',
    });
  });
  return app;
}
