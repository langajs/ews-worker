import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowFiles = ['虾皮sku图.json', '虾皮主图.json', '虾皮附图.json'];

function workflow(name) {
  const parsed = JSON.parse(fs.readFileSync(path.join(root, 'n8n', name), 'utf8'));
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

function runCreateResult(code, response) {
  const execute = new Function('$input', '$node', code);
  return execute(
    { first: () => ({ json: response }) },
    { 提取参数: { json: { taskId: 'task', subTaskId: 'sub', setIndex: 0, imageType: 'main', imagePosition: 1, callbackSecret: 'secret', callbackUrl: 'https://callback.example' } } },
  );
}

function runExpression(expression, json) {
  const source = expression.replace(/^=\{\{\s*/, '').replace(/\s*\}\}$/, '');
  return new Function('$json', `return (${source});`)(json);
}

test('Shopee image workflows preserve errors and fall back on every primary failure', () => {
  for (const file of workflowFiles) {
    const data = workflow(file);
    const requestNode = data.nodes.find(node => node.name === 'gpt-image-2');
    const resultNode = data.nodes.find(node => node.name === '提取任务ID');
    const fallbackNode = data.nodes.find(node => node.name === '是否切换备用模型');

    assert.equal(requestNode.parameters.options.response.response.fullResponse, true, file);
    assert.equal(requestNode.parameters.options.response.response.neverError, true, file);
    assert.equal(requestNode.parameters.options.response.response.responseFormat, 'autodetect', file);
    const fallbackExpression = fallbackNode.parameters.conditions.conditions[0].leftValue;
    assert.doesNotMatch(fallbackExpression, /excessive system load/, file);
    assert.equal(runExpression(fallbackExpression, { provider: 'grsai', status: 'failed', error: 'upstream failed' }), true, file);
    assert.equal(runExpression(fallbackExpression, { provider: 'grsai', status: 'pending', timedOut: true }), true, file);
    assert.equal(runExpression(fallbackExpression, { provider: 'backup', status: 'failed', error: 'backup failed' }), false, file);
    assert.equal(runExpression(fallbackExpression, { provider: 'grsai', status: 'running' }), false, file);

    const overloaded = runCreateResult(resultNode.parameters.jsCode, {
      body: { error: 'excessive system load' },
      statusCode: 503,
    });
    assert.equal(overloaded.status, 'failed', file);
    assert.equal(overloaded.error, 'excessive system load', file);

    const accepted = runCreateResult(resultNode.parameters.jsCode, {
      body: { id: 'provider-job', status: 'running' },
      statusCode: 200,
    });
    assert.equal(accepted.grsaiTaskId, 'provider-job', file);
    assert.equal(accepted.status, 'running', file);
    assert.equal(accepted.error, '', file);

    const empty = runCreateResult(resultNode.parameters.jsCode, {
      body: {},
      statusCode: 200,
    });
    assert.equal(empty.status, 'failed', file);
    assert.equal(empty.error, '图片服务返回空响应 (HTTP 200)', file);
  }
});
