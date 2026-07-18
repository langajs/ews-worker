import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const directory = path.dirname(fileURLToPath(import.meta.url));
const imageServiceUrl = String(process.env.IMAGE_SERVICE_URL || 'http://ews-image-sidecar:3000').replace(/\/+$/, '');
const files = [
  '聚水潭SKU图.json',
  '聚水潭主图.json',
  '聚水潭详情图.json',
  '聚水潭附图.json',
  '虾皮sku图.json',
  '虾皮主图.json',
  '虾皮附图.json',
];

const sidecarBody = `={{ {
  source_url: $json.image_url,
  ticket_url: String($node['提取参数'].json.callbackUrl || '').replace('/api/callback', '/api/internal/r2-upload-ticket'),
  callback_secret: $node['提取参数'].json.callbackSecret,
  task_id: $node['提取参数'].json.taskId,
  plan_id: $node['Webhook'].json.body.plan_id || '',
  sub_task_id: $node['提取参数'].json.subTaskId,
  set_index: $node['提取参数'].json.setIndex,
  image_type: $node['提取参数'].json.imageType,
  image_position: $node['提取参数'].json.imagePosition
} }}`;

const failureCallbackBody = `={{ {
  callback_secret: $json.callback_secret,
  task_id: $json.task_id,
  plan_id: $json.plan_id,
  sub_task_id: $json.sub_task_id,
  set_index: $json.set_index,
  image_type: $json.image_type,
  image_position: $json.image_position,
  error: $json.error,
  retryable: $json.retryable !== false
} }}`;

const failureNotificationCode = `const response = $input.first().json || {};
const original = $node['提取参数'].json;

function errorText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value.message) return String(value.message);
  if (value.description) return String(value.description);
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

const error = response.timedOut
  ? '图片生成超过900秒，已终止轮询'
  : errorText(response.error) || errorText(response.status) || '图片生成失败';

return {
  callback_secret: original.callbackSecret,
  task_id: original.taskId,
  plan_id: $node['Webhook'].json.body.plan_id || '',
  sub_task_id: original.subTaskId,
  set_index: original.setIndex,
  image_type: original.imageType,
  image_position: original.imagePosition,
  error,
  retryable: response.retryable !== false,
  callbackUrl: original.callbackUrl,
};`;

function edge(node, index = 0) {
  return { node, type: 'main', index };
}

function upsertNode(workflow, names, create, update) {
  const aliases = Array.isArray(names) ? names : [names];
  let node = workflow.nodes.find(item => aliases.includes(item.name));
  if (!node) {
    node = create();
    workflow.nodes.push(node);
  }
  update(node);
}

for (const file of files) {
  const filename = path.join(directory, file);
  const parsed = JSON.parse(await readFile(filename, 'utf8'));
  const workflow = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!workflow?.nodes || !workflow?.connections) throw new Error(`${file} 不是有效的n8n工作流`);
  upsertNode(workflow, ['提交图片处理队列', '处理并上传R2'], () => ({
    parameters: {},
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.4,
    position: [1040, -96],
    id: randomUUID(),
    name: '提交图片处理队列',
  }), node => {
    node.name = '提交图片处理队列';
    node.parameters = {
      method: 'POST',
      url: `${imageServiceUrl}/v1/image-jobs`,
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: sidecarBody,
      options: { timeout: 10000 },
    };
    node.onError = 'continueRegularOutput';
    node.position = [1040, -96];
  });
  upsertNode(workflow, ['图片队列已接收', 'R2上传成功'], () => ({
    parameters: {},
    type: 'n8n-nodes-base.if',
    typeVersion: 2.3,
    position: [1280, -96],
    id: randomUUID(),
    name: '图片队列已接收',
  }), node => {
    node.name = '图片队列已接收';
    const conditionId = node.parameters?.conditions?.conditions?.[0]?.id || randomUUID();
    node.parameters = {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 3 },
        conditions: [{
          id: conditionId,
          leftValue: "={{ $json.success ? 'true' : 'false' }}",
          rightValue: 'true',
          operator: { type: 'string', operation: 'equals', name: 'filter.operator.equals' },
        }],
        combinator: 'and',
      },
      options: {},
    };
    node.position = [1280, -96];
  });

  const failure = workflow.nodes.find(node => node.name === '失败通知');
  if (failure) {
    failure.position = [1520, 96];
    failure.parameters.jsCode = failureNotificationCode;
  }
  const failureCallback = workflow.nodes.find(node => node.name === '失败回调');
  if (failureCallback) {
    failureCallback.position = [1760, 96];
    failureCallback.parameters.jsonBody = failureCallbackBody;
  }

  workflow.nodes = workflow.nodes.filter(node => node.name !== '成功回调');
  delete workflow.connections['处理并上传R2'];
  delete workflow.connections['R2上传成功'];
  delete workflow.connections['成功回调'];
  workflow.connections['组装结果'] = { main: [[edge('提交图片处理队列')]] };
  workflow.connections['提交图片处理队列'] = { main: [[edge('图片队列已接收')]] };
  workflow.connections['图片队列已接收'] = { main: [[], [edge('失败通知')]] };
  await writeFile(filename, `${JSON.stringify(Array.isArray(parsed) ? [workflow] : workflow, null, 2)}\n`, 'utf8');
}
