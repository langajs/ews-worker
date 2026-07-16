import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const directory = path.dirname(fileURLToPath(import.meta.url));
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

const callbackBody = `={{ {
  callback_secret: $node['提取参数'].json.callbackSecret,
  task_id: $node['提取参数'].json.taskId,
  plan_id: $node['Webhook'].json.body.plan_id || '',
  sub_task_id: $node['提取参数'].json.subTaskId,
  set_index: $node['提取参数'].json.setIndex,
  image_type: $node['提取参数'].json.imageType,
  image_position: $node['提取参数'].json.imagePosition,
  r2_key: $json.r2_key,
  size_bytes: $json.size_bytes,
  sha256: $json.sha256,
  content_type: $json.content_type,
  etag: $json.etag
} }}`;

const failureCallbackBody = `={{ {
  callback_secret: $json.callback_secret,
  task_id: $json.task_id,
  sub_task_id: $json.sub_task_id,
  set_index: $json.set_index,
  image_type: $json.image_type,
  image_position: $json.image_position,
  error: $json.error,
  retryable: $json.retryable !== false
} }}`;

function edge(node, index = 0) {
  return { node, type: 'main', index };
}

function upsertNode(workflow, name, create, update) {
  let node = workflow.nodes.find(item => item.name === name);
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
  upsertNode(workflow, '处理并上传R2', () => ({
    parameters: {},
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.4,
    position: [1040, -96],
    id: randomUUID(),
    name: '处理并上传R2',
  }), node => {
    node.parameters = {
      method: 'POST',
      url: 'http://ews-image-sidecar:3000/process-upload',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: sidecarBody,
      options: { timeout: 120000 },
    };
    node.onError = 'continueRegularOutput';
    node.position = [1040, -96];
  });
  upsertNode(workflow, 'R2上传成功', () => ({
    parameters: {},
    type: 'n8n-nodes-base.if',
    typeVersion: 2.3,
    position: [1280, -96],
    id: randomUUID(),
    name: 'R2上传成功',
  }), node => {
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

  const success = workflow.nodes.find(node => node.name === '成功回调');
  if (!success) throw new Error(`${file} 缺少成功回调节点`);
  success.parameters.url = "={{ $node['提取参数'].json.callbackUrl }}";
  success.parameters.jsonBody = callbackBody;
  success.position = [1520, -96];
  const failure = workflow.nodes.find(node => node.name === '失败通知');
  if (failure) {
    failure.position = [1520, 96];
    failure.parameters.jsCode = failure.parameters.jsCode.replace(
      '  error,\n  callbackUrl: original.callbackUrl,',
      '  error,\n  retryable: response.retryable !== false,\n  callbackUrl: original.callbackUrl,'
    );
  }
  const failureCallback = workflow.nodes.find(node => node.name === '失败回调');
  if (failureCallback) {
    failureCallback.position = [1760, 96];
    failureCallback.parameters.jsonBody = failureCallbackBody;
  }

  workflow.connections['组装结果'] = { main: [[edge('处理并上传R2')]] };
  workflow.connections['处理并上传R2'] = { main: [[edge('R2上传成功')]] };
  workflow.connections['R2上传成功'] = { main: [[edge('成功回调')], [edge('失败通知')]] };
  await writeFile(filename, `${JSON.stringify(Array.isArray(parsed) ? [workflow] : workflow, null, 2)}\n`, 'utf8');
}
