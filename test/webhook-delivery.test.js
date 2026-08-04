import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workerSource = fs.readFileSync(path.join(root, 'src/index.js'), 'utf8');
const wranglerSource = fs.readFileSync(path.join(root, 'wrangler.toml'), 'utf8');

test('webhook delivery waits 300 seconds before retrying', () => {
  assert.match(workerSource, /const PUSH_WEBHOOK_TIMEOUT_MS = 300_000;/);
  assert.match(workerSource,
    /const PUSH_PLAN_DISPATCH_TIMEOUT_SECONDS = \(PUSH_WEBHOOK_TIMEOUT_MS \/ 1000\) \+ 60;/);
  assert.match(workerSource, /setTimeout\(\(\) => controller\.abort\(\), PUSH_WEBHOOK_TIMEOUT_MS\)/);
  assert.match(workerSource,
    /if \(err\?\.name === 'AbortError'\) \{[\s\S]*?timeout\.retryable = false;/);
  assert.match(workerSource, /kind: 'push_plan_dispatch'/);
  assert.match(workerSource, /await env\.PUSH_DISPATCH_EVENTS\.send\(/);
  assert.match(workerSource, /dispatch_started_at: dispatchClaim\.processing_at/);
  assert.match(workerSource, /if \(item\.kind === 'push_plan_dispatch'\)/);
  assert.match(workerSource,
    /SET status='processing',[\s\S]*?status='dispatching' AND processing_at=\? AND retry_count=\?/);
  assert.match(workerSource, /if \(d1Changes\(claimed\) > 0\) await dispatchPushPlan/);
  assert.match(workerSource,
    /SET status='processing', processing_at=datetime\('now'\)[\s\S]*?status='processing' AND processing_at=\? AND retry_count=\?/);
  assert.doesNotMatch(workerSource, /ctx\.waitUntil\(dispatchPushPlan\(/);
  assert.match(wranglerSource, /binding = "PUSH_DISPATCH_EVENTS"\s+queue = "ews-push-dispatch-events"/);
  assert.match(wranglerSource, /queue = "ews-push-dispatch-events"[\s\S]*?max_batch_size = 1[\s\S]*?max_concurrency = 20/);
});
