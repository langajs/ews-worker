import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const directory = path.dirname(fileURLToPath(import.meta.url));
const files = ['虾皮sku图.json', '虾皮主图.json', '虾皮附图.json'];
const backupCredential = {
  httpHeaderAuth: {
    id: 'bkpImgApi20260722',
    name: 'EWS Backup Image API',
  },
};

const primaryCreateResultCode = `const response = $input.first().json || {};
const original = $node['提取参数'].json;

function errorText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value.message) return String(value.message);
  if (value.description) return String(value.description);
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

const serviceTaskId = String(response.id || '').trim();
const responseError = errorText(response.error)
  || errorText(response.message)
  || errorText(response.description)
  || (Number(response.statusCode) >= 400 ? '图片服务HTTP ' + response.statusCode : '')
  || (!serviceTaskId ? '图片服务未返回任务ID' : '');

return {
  provider: 'grsai',
  grsaiTaskId: serviceTaskId,
  status: serviceTaskId ? String(response.status || 'pending') : 'failed',
  error: responseError,
  taskId: original.taskId,
  subTaskId: original.subTaskId,
  setIndex: original.setIndex,
  imageType: original.imageType,
  imagePosition: original.imagePosition,
  callbackSecret: original.callbackSecret,
  callbackUrl: original.callbackUrl,
  startedAt: Date.now(),
  timedOut: false,
};`;

const primaryQueryResultCode = `const response = $input.first().json || {};
const task = $node['提取任务ID'].json;
const elapsedSeconds = Math.floor((Date.now() - task.startedAt) / 1000);

function errorText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value.message) return String(value.message);
  if (value.description) return String(value.description);
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

const results = Array.isArray(response.results) ? response.results : [];
const imageUrl = String(results[0]?.url || '').trim();
let status = String(response.status || '').trim();
let error = errorText(response.error)
  || errorText(response.message)
  || errorText(response.description)
  || (Number(response.statusCode) >= 400 ? '图片查询HTTP ' + response.statusCode : '');
if (!status && error) status = 'failed';
if (!status) status = 'pending';
if (status === 'succeeded' && !imageUrl) {
  status = 'failed';
  error = '图片服务返回成功但没有图片URL';
}

return {
  provider: 'grsai',
  grsaiTaskId: task.grsaiTaskId,
  status,
  progress: response.progress,
  results,
  error,
  taskId: task.taskId,
  subTaskId: task.subTaskId,
  setIndex: task.setIndex,
  imageType: task.imageType,
  imagePosition: task.imagePosition,
  callbackSecret: task.callbackSecret,
  callbackUrl: task.callbackUrl,
  elapsedSeconds,
  timedOut: elapsedSeconds >= 900,
};`;

const backupCreateBody = `={{ {
  model: 'gpt-image-2',
  prompt: $node['提取参数'].json.finalPrompt,
  params: {
    aspect_ratio: '1:1',
    images: $node['提取参数'].json.imagesArray,
    n: 1,
    quality: 'auto',
    resolution: '1K',
    response_format: 'url',
    size: '1024x1024'
  }
} }}`;

const backupCreateResultCode = `const response = $input.first().json || {};
const original = $node['是否切换备用模型'].json;

function errorText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value.message) return String(value.message);
  if (value.description) return String(value.description);
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

const backupTaskId = String(response.task_id || response.id || '').trim();
const imageUrl = String(response.result_url || response.data?.[0]?.url || response.results?.[0]?.url || '').trim();
const state = String(response.state || '').toLowerCase();
let error = errorText(response.error)
  || errorText(response.message)
  || errorText(response.description)
  || (Number(response.statusCode) >= 400 ? '备用图片服务HTTP ' + response.statusCode : '');
let status = imageUrl ? 'succeeded' : (backupTaskId ? 'pending' : 'failed');
if (state === 'failed') status = 'failed';
if (state === 'success' && !imageUrl) {
  status = 'failed';
  error = error || '备用图片服务返回成功但没有图片URL';
}
if (status === 'failed' && !error) error = '备用图片服务未返回任务ID或图片URL';

const startedAt = Number(original.startedAt) || Date.now();
const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
return {
  provider: 'backup',
  backupTaskId,
  status,
  results: imageUrl ? [{ url: imageUrl }] : [],
  error,
  taskId: original.taskId,
  subTaskId: original.subTaskId,
  setIndex: original.setIndex,
  imageType: original.imageType,
  imagePosition: original.imagePosition,
  callbackSecret: original.callbackSecret,
  callbackUrl: original.callbackUrl,
  startedAt,
  elapsedSeconds,
  timedOut: elapsedSeconds >= 900,
};`;

const backupQueryResultCode = `const response = $input.first().json || {};
const task = $node['解析备用创建结果'].json;
const elapsedSeconds = Math.floor((Date.now() - task.startedAt) / 1000);

function errorText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value.message) return String(value.message);
  if (value.description) return String(value.description);
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

const state = String(response.state || '').toLowerCase();
const imageUrl = String(response.result_url || response.data?.[0]?.url || response.results?.[0]?.url || '').trim();
let error = errorText(response.error)
  || errorText(response.message)
  || errorText(response.description)
  || (Number(response.statusCode) >= 400 ? '备用图片查询HTTP ' + response.statusCode : '');
let status = state === 'success' ? 'succeeded' : (state === 'failed' ? 'failed' : 'pending');
if (response.is_final === true && state !== 'success') status = 'failed';
if (status === 'succeeded' && !imageUrl) {
  status = 'failed';
  error = error || '备用图片服务返回成功但没有图片URL';
}
if (status === 'failed' && !error) error = String(response.status || response.status_group || '备用图片服务生成失败');

return {
  provider: 'backup',
  backupTaskId: task.backupTaskId,
  status,
  progress: response.progress,
  results: imageUrl ? [{ url: imageUrl }] : [],
  error,
  taskId: task.taskId,
  subTaskId: task.subTaskId,
  setIndex: task.setIndex,
  imageType: task.imageType,
  imagePosition: task.imagePosition,
  callbackSecret: task.callbackSecret,
  callbackUrl: task.callbackUrl,
  startedAt: task.startedAt,
  elapsedSeconds,
  timedOut: elapsedSeconds >= 900,
};`;

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
  return node;
}

function codeNode(name, position, jsCode) {
  return {
    parameters: { jsCode },
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position,
    id: randomUUID(),
    name,
  };
}

function httpNode(name, position) {
  return {
    parameters: {},
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.4,
    position,
    id: randomUUID(),
    name,
  };
}

function ifNode(name, position) {
  return {
    parameters: {},
    type: 'n8n-nodes-base.if',
    typeVersion: 2.3,
    position,
    id: randomUUID(),
    name,
  };
}

for (const file of files) {
  const filename = path.join(directory, file);
  const parsed = JSON.parse(await readFile(filename, 'utf8'));
  const workflow = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!workflow?.nodes || !workflow?.connections) throw new Error(`${file} 不是有效的 n8n 工作流`);

  const taskFailed = workflow.nodes.find(node => node.name === '任务失败');
  const wait = workflow.nodes.find(node => node.name === 'Wait');
  const primaryQuery = workflow.nodes.find(node => node.name === '查询结果');
  const primaryQueryResult = workflow.nodes.find(node => node.name === '重组查询');
  const primaryCreateResult = workflow.nodes.find(node => node.name === '提取任务ID');
  if (!taskFailed || !wait || !primaryQuery || !primaryQueryResult || !primaryCreateResult) {
    throw new Error(`${file} 缺少主图片服务节点`);
  }

  primaryCreateResult.parameters.jsCode = primaryCreateResultCode;
  primaryQueryResult.parameters.jsCode = primaryQueryResultCode;

  const fallbackPosition = [taskFailed.position[0] + 240, taskFailed.position[1] + 176];
  const backupCreatePosition = [fallbackPosition[0] + 240, fallbackPosition[1] + 160];
  const backupCreateResultPosition = [backupCreatePosition[0] + 240, backupCreatePosition[1]];
  const providerPosition = [wait.position[0] + 224, wait.position[1] + 176];
  const backupQueryPosition = [primaryQuery.position[0], primaryQuery.position[1] + 320];
  const backupQueryResultPosition = [primaryQueryResult.position[0], primaryQueryResult.position[1] + 320];

  upsertNode(workflow, '是否切换备用模型', () => ifNode('是否切换备用模型', fallbackPosition), node => {
    const conditionId = node.parameters?.conditions?.conditions?.[0]?.id || randomUUID();
    node.parameters = {
      conditions: {
        options: { caseSensitive: false, leftValue: '', typeValidation: 'strict', version: 3 },
        conditions: [{
          id: conditionId,
          leftValue: "={{ $json.provider !== 'backup' && !$json.timedOut && String($json.error || '').toLowerCase().includes('excessive system load') }}",
          rightValue: true,
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        }],
        combinator: 'and',
      },
      options: {},
    };
    node.position = fallbackPosition;
  });

  upsertNode(workflow, '备用模型创建任务', () => httpNode('备用模型创建任务', backupCreatePosition), node => {
    node.parameters = {
      method: 'POST',
      url: 'https://api.lk888.ai/v1/media/generate',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: backupCreateBody,
      options: { timeout: 120000 },
    };
    node.credentials = backupCredential;
    node.onError = 'continueRegularOutput';
    node.position = backupCreatePosition;
  });

  upsertNode(workflow, '解析备用创建结果', () => codeNode('解析备用创建结果', backupCreateResultPosition, backupCreateResultCode), node => {
    node.parameters = { jsCode: backupCreateResultCode };
    node.position = backupCreateResultPosition;
  });

  upsertNode(workflow, '是否备用模型任务', () => ifNode('是否备用模型任务', providerPosition), node => {
    const conditionId = node.parameters?.conditions?.conditions?.[0]?.id || randomUUID();
    node.parameters = {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 3 },
        conditions: [{
          id: conditionId,
          leftValue: '={{ $json.provider }}',
          rightValue: 'backup',
          operator: { type: 'string', operation: 'equals', name: 'filter.operator.equals' },
        }],
        combinator: 'and',
      },
      options: {},
    };
    node.position = providerPosition;
  });

  upsertNode(workflow, '备用模型查询结果', () => httpNode('备用模型查询结果', backupQueryPosition), node => {
    node.parameters = {
      url: "={{ 'https://api.lk888.ai/v1/media/status?task_id=' + encodeURIComponent($json.backupTaskId) }}",
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
      options: { timeout: 30000 },
    };
    node.credentials = backupCredential;
    node.onError = 'continueRegularOutput';
    node.position = backupQueryPosition;
  });

  upsertNode(workflow, '重组备用查询', () => codeNode('重组备用查询', backupQueryResultPosition, backupQueryResultCode), node => {
    node.parameters = { jsCode: backupQueryResultCode };
    node.position = backupQueryResultPosition;
  });

  workflow.connections['任务失败'] = { main: [[edge('是否切换备用模型')], [edge('Wait')]] };
  workflow.connections['是否切换备用模型'] = { main: [[edge('备用模型创建任务')], [edge('失败通知')]] };
  workflow.connections['备用模型创建任务'] = { main: [[edge('解析备用创建结果')]] };
  workflow.connections['解析备用创建结果'] = { main: [[edge('任务完成')]] };
  workflow.connections.Wait = { main: [[edge('是否备用模型任务')]] };
  workflow.connections['是否备用模型任务'] = { main: [[edge('备用模型查询结果')], [edge('查询结果')]] };
  workflow.connections['备用模型查询结果'] = { main: [[edge('重组备用查询')]] };
  workflow.connections['重组备用查询'] = { main: [[edge('任务完成')]] };

  await writeFile(filename, `${JSON.stringify(Array.isArray(parsed) ? [workflow] : workflow, null, 2)}\n`, 'utf8');
}
