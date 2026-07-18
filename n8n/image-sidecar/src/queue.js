import { createHash } from 'node:crypto';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export function createRedis(config) {
  return new IORedis(config.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  });
}

export function imageJobId(body) {
  const digest = createHash('sha256').update(`${body.plan_id}\n${body.source_url}`).digest('hex').slice(0, 32);
  return `img-${digest}`;
}

export function createImageQueue(config, connection) {
  return new Queue(config.queueName, {
    connection,
    defaultJobOptions: {
      attempts: config.queueAttempts,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 86400, count: 10000 },
      removeOnFail: { age: 604800, count: 20000 },
    },
  });
}
