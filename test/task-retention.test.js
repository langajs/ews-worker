import test from 'node:test';
import assert from 'node:assert/strict';
import { isTaskExpired, TASK_RETENTION_DAYS } from '../src/db.js';

const NOW = Date.parse('2026-07-22T12:00:00Z');

test('completed tasks retain seven days from completion', () => {
  const task = {
    status: 'completed',
    created_at: '2026-07-01 00:00:00',
    completed_at: '2026-07-16 12:00:00',
  };
  assert.equal(isTaskExpired(task, NOW), false);
});

test('failed tasks expire from creation time', () => {
  const task = {
    status: 'failed',
    created_at: '2026-07-14 11:59:59',
    updated_at: '2026-07-22 11:00:00',
  };
  assert.equal(isTaskExpired(task, NOW), true);
});

test('a task is still visible at the exact retention boundary', () => {
  const task = { status: 'failed', created_at: '2026-07-15 12:00:00' };
  assert.equal(TASK_RETENTION_DAYS, 7);
  assert.equal(isTaskExpired(task, NOW), false);
});

test('invalid timestamps do not expire a task accidentally', () => {
  assert.equal(isTaskExpired({ status: 'failed', created_at: 'invalid' }, NOW), false);
});
