import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';

const config = {
  logLevel: 'silent',
  maxQueueDepth: 100,
  serviceSecret: 'test-secret',
  sourceHostAllowlist: [],
  ticketOrigin: 'https://ewsz.langaj.cc',
};

const payload = {
  source_url: 'https://oss.langaj.cc/ews/task/image.jpg',
  ticket_url: 'https://ewsz.langaj.cc/api/internal/r2-upload-ticket',
  callback_secret: 'test-secret',
  task_id: 'task',
  plan_id: 'plan',
  sub_task_id: 'subtask',
  set_index: 0,
  image_type: 'main',
  image_position: 1,
};

function fakeQueue() {
  const jobs = new Map();
  const added = [];
  return {
    added,
    jobs,
    async getJobCounts() { return { waiting: jobs.size, active: 0, delayed: 0, prioritized: 0 }; },
    async getJob(jobId) { return jobs.get(jobId) || null; },
    async add(_, data, options) {
      const job = {
        id: options.jobId,
        data,
        progress: 0,
        attemptsMade: 0,
        returnvalue: null,
        failedReason: '',
        state: 'waiting',
        async getState() { return this.state; },
        async remove() { jobs.delete(this.id); },
      };
      jobs.set(job.id, job);
      added.push(job);
      return job;
    },
  };
}

test('重复活动任务不重复入队', async () => {
  const queue = fakeQueue();
  const app = buildApp({ config, queue, redis: { ping: async () => 'PONG' } });
  const first = await app.inject({ method: 'POST', url: '/v1/image-jobs', payload });
  const second = await app.inject({ method: 'POST', url: '/v1/image-jobs', payload });
  assert.equal(first.statusCode, 202);
  assert.equal(second.statusCode, 202);
  assert.equal(second.json().duplicate, true);
  assert.equal(queue.added.length, 1);
  await app.close();
});

test('已完成任务重复提交时只重放callback', async () => {
  const queue = fakeQueue();
  const app = buildApp({ config, queue, redis: { ping: async () => 'PONG' } });
  const first = await app.inject({ method: 'POST', url: '/v1/image-jobs', payload });
  const completed = queue.jobs.get(first.json().job_id);
  completed.state = 'completed';
  completed.returnvalue = { success: true };
  completed.data.upload_result = { r2_key: 'ews/task/image.jpg', size_bytes: 1000, sha256: 'abc', content_type: 'image/jpeg' };
  const replay = await app.inject({ method: 'POST', url: '/v1/image-jobs', payload });
  assert.equal(replay.statusCode, 202);
  assert.equal(replay.json().callback_replay, true);
  assert.equal(queue.added.length, 2);
  assert.equal(queue.added[1].data.upload_result.r2_key, 'ews/task/image.jpg');
  await app.close();
});
