import assert from 'node:assert/strict';
import test from 'node:test';

import { runAuthenticatedRoute } from '../src/route-auth.js';

test('authenticated D1 failures return JSON with CORS instead of a rejected fetch', async () => {
  const request = new Request('https://example.test/api/tasks/example');
  const response = await runAuthenticatedRoute(
    request,
    {},
    async () => { throw new Error('simulated D1 failure'); },
    async () => ({ valid: true, username: 'admin', role: 'admin' }),
    {
      unauthorized: () => new Response(null, { status: 401 }),
      failed: err => new Response(JSON.stringify({ success: false, error: err.message }), {
        status: 500,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json',
        },
      }),
    },
  );
  const body = await response.json();

  assert.equal(request.auth.username, 'admin');
  assert.equal(response.status, 500);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(response.headers.get('Content-Type'), 'application/json');
  assert.deepEqual(body, { success: false, error: 'simulated D1 failure' });
});
