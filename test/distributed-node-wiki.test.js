import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowFiles = [
  '聚水潭SKU图.json',
  '聚水潭主图.json',
  '聚水潭商品元数据.json',
  '聚水潭详情图.json',
  '聚水潭附图.json',
  '虾皮sku图.json',
  '虾皮主图.json',
  '虾皮商品元数据.json',
  '虾皮附图.json',
];
const imageSidecarFiles = [
  'Dockerfile',
  'package.json',
  'package-lock.json',
  'src/app.js',
  'src/config.js',
  'src/errors.js',
  'src/image.js',
  'src/pipeline.js',
  'src/queue.js',
  'src/security.js',
  'src/server.js',
  'src/worker-api.js',
  'src/worker.js',
];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function base64(value) {
  return Buffer.from(value, 'utf8').toString('base64');
}

function buildInstaller() {
  const powershellTemplate = read('n8n/deploy/install-ews-node.ps1');
  const cmdTemplate = read('n8n/deploy/install-ews-node.cmd');
  const workflows = workflowFiles.map(name => {
    const content = read(`n8n/${name}`);
    const parsed = JSON.parse(content);
    const workflow = Array.isArray(parsed) ? parsed[0] : parsed;
    return { name, id: workflow.id, content: JSON.stringify(workflow) };
  });
  const imageSidecar = imageSidecarFiles.map(name => ({ name, content: read(`n8n/image-sidecar/${name}`) }));
  const powershell = powershellTemplate
    .replace('__EWS_WORKFLOW_BUNDLE_B64__', base64(JSON.stringify(workflows)))
    .replace('__EWS_IMAGE_SIDECAR_BUNDLE_B64__', base64(JSON.stringify(imageSidecar)));
  const chunks = base64(powershell).match(/.{1,7000}/g);
  const lines = chunks.map((line, index) => `${index === 0 ? '>' : '>>'} "%EWS_PAYLOAD_B64%" echo ${line}`).join('\r\n');
  return cmdTemplate.replace('__EWS_POWERSHELL_PAYLOAD_LINES__', lines);
}

test('one-click CMD embeds the complete production workflow bundle', () => {
  const cmdTemplate = read('n8n/deploy/install-ews-node.cmd');
  const powershellTemplate = read('n8n/deploy/install-ews-node.ps1');
  const installerModule = read('src/distributed-n8n-installer.js');
  const generated = buildInstaller();

  assert.match(cmdTemplate, /certutil\.exe -f -decode/);
  assert.match(cmdTemplate, /powershell\.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass/);
  assert.match(cmdTemplate, /if not defined EWS_NO_PAUSE pause/);
  assert.match(powershellTemplate, /Decode-Value \$env:EWS_NODE_NAME_B64/);
  assert.match(powershellTemplate, /\$N8nImage = 'n8nio\/n8n:2\.25\.7'/);
  assert.match(powershellTemplate, /function Get-N8nSettings/);
  assert.match(powershellTemplate, /function Test-DockerEngine/);
  assert.match(powershellTemplate, /function Test-DockerCommand/);
  assert.match(powershellTemplate, /function Install-DockerDesktop/);
  assert.match(powershellTemplate, /desktop\.docker\.com\/win\/main\/\$architecture/);
  assert.match(powershellTemplate, /SecurityProtocolType\]::Tls12/);
  assert.match(powershellTemplate, /BITS download is unavailable/);
  assert.match(powershellTemplate, /Get-AuthenticodeSignature/);
  assert.match(powershellTemplate, /'--accept-license'/);
  assert.match(powershellTemplate, /function Wait-DockerDesktop/);
  assert.match(powershellTemplate, /function Ensure-DockerImage/);
  assert.match(powershellTemplate, /function Wait-DockerContainerNetwork/);
  assert.match(powershellTemplate, /function Write-ImageServiceSource/);
  assert.match(powershellTemplate, /function Install-LocalImageService/);
  assert.match(powershellTemplate, /function Ensure-LocalImageService/);
  assert.match(powershellTemplate, /Get-Command docker\.exe/);
  assert.match(powershellTemplate, /Start-Process -FilePath \$dockerDesktopPath/);
  assert.match(powershellTemplate, /Linux container engine ready within/);
  assert.match(powershellTemplate, /\$containerInfo = \$containerJson \| ConvertFrom-Json/);
  assert.match(powershellTemplate, /docker build --tag \$ImageServiceImage \$sourceRoot/);
  assert.match(powershellTemplate, /'ews-image-valkey'/);
  assert.match(powershellTemplate, /'ews-image-sidecar'/);
  assert.match(powershellTemplate, /'ews-image-worker'/);
  assert.match(powershellTemplate, /Wait-LocalImageService \$apiContainer \$CallbackSecret/);
  assert.match(powershellTemplate, /\/v1\/stats/);
  assert.match(powershellTemplate, /\$null -ne \$setupFlag/);
  assert.match(powershellTemplate, /owner setup did not complete/);
  assert.match(powershellTemplate, /OwnerPassword -notmatch '\[A-Z\]'/);
  assert.match(powershellTemplate, /OwnerPassword -notmatch '\\d'/);
  assert.match(powershellTemplate, /import:credentials --separate --input=\/tmp\/ews-credentials/);
  assert.match(powershellTemplate, /docker exec -u 0 \$ContainerName node -e/);
  assert.match(powershellTemplate, /n8n import:workflow --separate --input=\/workflows/);
  assert.match(powershellTemplate, /Expected 9 workflows/);
  assert.match(powershellTemplate, /Expected 7 image workflows/);
  assert.match(powershellTemplate, /\$workflowEntries = \$WorkflowBundleJson \| ConvertFrom-Json/);
  assert.doesNotMatch(powershellTemplate, /\$workflowEntries = @\(/);
  assert.match(powershellTemplate, /docker network connect \$ImageDockerNetwork \$ContainerName/);
  assert.match(powershellTemplate, /\$ImageDockerNetwork = Ensure-LocalImageService \$ImageServiceBundleJson \$CallbackSecret \$TicketOrigin/);
  assert.doesNotMatch(powershellTemplate, /range \$name, \$_ := \.NetworkSettings\.Networks/);
  assert.match(powershellTemplate, /docker network ls --filter/);
  assert.match(powershellTemplate, /docker volume ls --filter/);
  assert.doesNotMatch(powershellTemplate, /docker network inspect \$NetworkName/);
  assert.doesNotMatch(powershellTemplate, /& docker (?:network|volume) inspect \$\w+ 2>\$null/);
  assert.match(powershellTemplate, /Test-DockerCommand -Arguments @\('network', 'inspect', \$networkName\)/);
  assert.match(powershellTemplate, /Ensure-DockerImage \$N8nImage/);
  assert.match(powershellTemplate, /Ensure-DockerImage \$ValkeyImage/);
  assert.ok(powershellTemplate.lastIndexOf('Wait-DockerDesktop') < powershellTemplate.lastIndexOf('Ensure-LocalImageService'));
  assert.match(installerModule, /install-ews-node\.cmd/);
  assert.match(installerModule, /workflowEntry\('聚水潭SKU图\.json'/);
  assert.match(installerModule, /content: JSON\.stringify\(workflow\)/);
  assert.match(installerModule, /sidecarEntry\('Dockerfile', sidecarDockerfile\)/);
  assert.match(installerModule, /sidecarEntry\('src\/worker\.js', sidecarWorker\)/);
  assert.match(installerModule, /IMAGE_SIDECAR_PLACEHOLDER/);
  assert.match(installerModule, /\.{1,7000}/);
  assert.ok(Math.max(...generated.split(/\r?\n/).map(line => line.length)) < 8191);
  assert.doesNotMatch(generated, /__EWS_WORKFLOW_BUNDLE_B64__|__EWS_IMAGE_SIDECAR_BUNDLE_B64__|__EWS_POWERSHELL_PAYLOAD_LINES__/);
  assert.match(generated, /__EWS_NODE_NAME_B64__/);
  assert.doesNotMatch(generated, /sk-[A-Za-z0-9_-]{16,}/);

  const imageWorkflowCount = workflowFiles.filter(name => read(`n8n/${name}`).includes('http://ews-image-sidecar:3000/v1/image-jobs')).length;
  assert.equal(imageWorkflowCount, 7);
});

test('browser parameter injection keeps secrets out of plaintext', () => {
  const values = {
    '__EWS_NODE_NAME_B64__': base64('test-node'),
    '__EWS_DOMAIN_B64__': base64('test-node.example.com'),
    '__EWS_OWNER_EMAIL_B64__': base64('owner@example.com'),
    '__EWS_OWNER_PASSWORD_B64__': base64('Owner-password-2026'),
    '__EWS_GRSAI_KEY_B64__': base64('grsai-secret-value'),
    '__EWS_DEEPSEEK_KEY_B64__': base64('deepseek-secret-value'),
    '__EWS_BACKUP_KEY_B64__': base64('backup-secret-value'),
    '__EWS_IMAGE_SERVICE_URL_B64__': base64('http://ews-image-sidecar:3000'),
    '__EWS_CALLBACK_SECRET_B64__': base64('callback-secret-value'),
    '__EWS_TICKET_ORIGIN_B64__': base64('https://ewsz.langaj.cc'),
    '__EWS_PORT__': '5692',
  };
  let generated = buildInstaller();
  for (const [token, value] of Object.entries(values)) generated = generated.split(token).join(value);

  assert.doesNotMatch(generated, /__EWS_(?:NODE_NAME|DOMAIN|OWNER_EMAIL|OWNER_PASSWORD|GRSAI_KEY|DEEPSEEK_KEY|BACKUP_KEY|IMAGE_SERVICE_URL|CALLBACK_SECRET|TICKET_ORIGIN|PORT)/);
  assert.doesNotMatch(generated, /Owner-password-2026|grsai-secret-value|deepseek-secret-value|backup-secret-value|callback-secret-value/);

  const payloadBase64 = [...generated.matchAll(/^>{1,2} "%EWS_PAYLOAD_B64%" echo ([A-Za-z0-9+/=]+)$/gm)].map(match => match[1]).join('');
  const payload = Buffer.from(payloadBase64, 'base64').toString('utf8');
  assert.match(payload, /\$WorkflowBundleJson = Decode-Value '[A-Za-z0-9+/=]+'/);
  const sidecarBundleBase64 = payload.match(/\$ImageServiceBundleJson = Decode-Value '([A-Za-z0-9+/=]+)'/)[1];
  const sidecarBundle = JSON.parse(Buffer.from(sidecarBundleBase64, 'base64').toString('utf8'));
  assert.deepEqual(sidecarBundle.map(entry => entry.name), imageSidecarFiles);
  assert.match(sidecarBundle.find(entry => entry.name === 'src/app.js').content, /from 'fastify'/);
  assert.match(payload, /http:\/\/ews-image-sidecar:3000\/v1\/image-jobs/);
});

test('admin deployment wiki protects installer details and uses CMD flow', () => {
  const workerWiki = read('src/admin-deployment-wiki.js');
  const workerEntry = read('src/index.js');
  const frontendShell = fs.readFileSync(path.join(root, '../ews-frontend/admin-deployment-wiki.html'), 'utf8');
  const frontendApi = fs.readFileSync(path.join(root, '../ews-frontend/js/api.js'), 'utf8');

  assert.match(workerWiki, /可双击运行的 CMD/);
  assert.match(workerWiki, /Docker Desktop 缺失时自动下载并安装/);
  assert.match(workerWiki, /已有 Docker Engine 和镜像直接复用/);
  assert.match(workerWiki, /Cloudflare Tunnel/);
  assert.match(workerEntry, /requireAuth\(request, env, \(\) => handleGetDistributedN8nWiki\(request\)\)/);
  assert.match(workerEntry, /requireAuth\(request, env, \(\) => handleDownloadDistributedN8nScript\(request\)\)/);
  assert.match(workerEntry, /request\.auth\?\.role === 'admin'/);
  assert.match(workerEntry, /'Cache-Control': 'private, no-store, max-age=0'/);
  assert.match(frontendShell, /生成一键部署脚本/);
  assert.match(frontendShell, /只在当前浏览器内注入/);
  assert.match(frontendShell, /API\.getConfig\(\)/);
  assert.match(frontendShell, /id="callbackSecret"/);
  assert.match(frontendShell, /默认地址会在本机自动部署/);
  assert.match(frontendShell, /ownerPassword\.length < 8 \|\| values\.ownerPassword\.length > 64/);
  assert.match(frontendShell, /!\/\[A-Z\]\/\.test\(values\.ownerPassword\)/);
  assert.match(frontendShell, /!\/\\d\/\.test\(values\.ownerPassword\)/);
  assert.match(frontendShell, /install-ews-' \+ nodeName \+ '\.cmd'/);
  assert.match(frontendShell, /cloudflare\/cloudflared:latest/);
  assert.match(frontendShell, /getDistributedN8nWiki\(\)/);
  assert.match(frontendApi, /install-ews-node\.cmd/);
  assert.doesNotMatch(frontendShell, /Ua1TBIbDcAu3z8pU|11xE3AjgQ1iUHDdR|bkpImgApi20260722/);
});
