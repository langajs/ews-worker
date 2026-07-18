import { Worker } from 'bullmq';
import { loadConfig } from './config.js';
import { normalizeProcessingError } from './errors.js';
import { processAndUpload } from './pipeline.js';
import { createRedis } from './queue.js';
import { sendWorkerCallback } from './worker-api.js';

const config = loadConfig();
const redis = createRedis(config);

const worker = new Worker(config.queueName, async job => {
  let uploadResult = job.data.upload_result || null;
  if (!uploadResult) {
    try {
      uploadResult = await processAndUpload(job.data, config, stage => job.updateProgress({ stage }));
      await job.updateData({ ...job.data, upload_result: uploadResult });
    } catch (error) {
      const processingError = normalizeProcessingError(error);
      const currentAttempt = job.attemptsMade + 1;
      const maxAttempts = Number(job.opts.attempts || config.queueAttempts);
      if (processingError.retryable !== false && currentAttempt < maxAttempts) throw processingError;
      await job.updateProgress({ stage: 'failure_callback' });
      await sendWorkerCallback(job.data, {
        error: processingError.message,
        retryable: processingError.retryable !== false,
      }, config);
      return { success: false, retryable: processingError.retryable !== false, error: processingError.message };
    }
  }
  await job.updateProgress({ stage: 'success_callback' });
  await sendWorkerCallback(job.data, uploadResult, config);
  return { success: true, ...uploadResult };
}, {
  connection: redis,
  concurrency: config.queueConcurrency,
  lockDuration: 120000,
  maxStalledCount: 2,
});

worker.on('completed', job => console.info(JSON.stringify({ event: 'completed', job_id: job.id })));
worker.on('failed', (job, error) => console.error(JSON.stringify({ event: 'failed', job_id: job?.id, error: error?.message })));
worker.on('error', error => console.error(JSON.stringify({ event: 'worker_error', error: error?.message })));

async function shutdown(signal) {
  console.info(JSON.stringify({ event: 'shutdown', signal }));
  await worker.close();
  await redis.quit();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
