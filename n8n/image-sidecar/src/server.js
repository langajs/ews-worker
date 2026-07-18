import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createImageQueue, createRedis } from './queue.js';

const config = loadConfig();
const redis = createRedis(config);
const queue = createImageQueue(config, redis);
const app = buildApp({ config, queue, redis });

async function shutdown(signal) {
  app.log.info({ signal }, 'shutting down image API');
  await app.close();
  await queue.close();
  await redis.quit();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await app.listen({ port: config.port, host: config.host });
