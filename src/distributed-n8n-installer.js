import INSTALLER_TEMPLATE from '../n8n/deploy/install-ews-node.ps1';
import CMD_TEMPLATE from '../n8n/deploy/install-ews-node.cmd';
import jstSku from '../n8n/聚水潭SKU图.json';
import jstMain from '../n8n/聚水潭主图.json';
import jstMetadata from '../n8n/聚水潭商品元数据.json';
import jstDetail from '../n8n/聚水潭详情图.json';
import jstSub from '../n8n/聚水潭附图.json';
import shopeeSku from '../n8n/虾皮sku图.json';
import shopeeMain from '../n8n/虾皮主图.json';
import shopeeMetadata from '../n8n/虾皮商品元数据.json';
import shopeeSub from '../n8n/虾皮附图.json';

const WORKFLOW_PLACEHOLDER = '__EWS_WORKFLOW_BUNDLE_B64__';
const PAYLOAD_PLACEHOLDER = '__EWS_POWERSHELL_PAYLOAD_LINES__';

function workflowEntry(name, content) {
  const parsed = JSON.parse(content);
  const workflow = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!workflow?.id || !workflow?.name || !Array.isArray(workflow?.nodes)) {
    throw new Error(`Invalid distributed n8n workflow: ${name}`);
  }
  return { name, id: workflow.id, content: JSON.stringify(workflow) };
}

const WORKFLOWS = Object.freeze([
  workflowEntry('聚水潭SKU图.json', jstSku),
  workflowEntry('聚水潭主图.json', jstMain),
  workflowEntry('聚水潭商品元数据.json', jstMetadata),
  workflowEntry('聚水潭详情图.json', jstDetail),
  workflowEntry('聚水潭附图.json', jstSub),
  workflowEntry('虾皮sku图.json', shopeeSku),
  workflowEntry('虾皮主图.json', shopeeMain),
  workflowEntry('虾皮商品元数据.json', shopeeMetadata),
  workflowEntry('虾皮附图.json', shopeeSub),
]);

function utf8ToBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function getDistributedN8nInstallerScript() {
  if (!INSTALLER_TEMPLATE.includes(WORKFLOW_PLACEHOLDER)) {
    throw new Error('Distributed n8n installer workflow placeholder is missing');
  }
  if (!CMD_TEMPLATE.includes(PAYLOAD_PLACEHOLDER)) {
    throw new Error('Distributed n8n CMD payload placeholder is missing');
  }
  const workflowBundle = utf8ToBase64(JSON.stringify(WORKFLOWS));
  const powershellPayload = INSTALLER_TEMPLATE.replace(WORKFLOW_PLACEHOLDER, workflowBundle);
  const payloadBase64 = utf8ToBase64(powershellPayload);
  const payloadLines = payloadBase64.match(/.{1,7000}/g).map((line, index) => (
    `${index === 0 ? '>' : '>>'} "%EWS_PAYLOAD_B64%" echo ${line}`
  )).join('\r\n');
  return CMD_TEMPLATE.replace(PAYLOAD_PLACEHOLDER, payloadLines);
}

export const DISTRIBUTED_N8N_INSTALLER_FILENAME = 'install-ews-node.cmd';
