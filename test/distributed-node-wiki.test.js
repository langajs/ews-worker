import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

function injectInstallerValue(value) {
  return String(value).replace(/'/g, "''");
}

function bundleAssignmentLines(variable, value) {
  const chunks = value.match(/.{1,4000}/g) || [''];
  return [
    `$${variable} = ''`,
    ...chunks.map(chunk => `$${variable} += '${chunk}'`),
  ].join('\r\n');
}

function joinBundle(payload, variable) {
  const pattern = new RegExp(`\\$${variable} \\+= '([A-Za-z0-9+/=]+)'`, 'g');
  return [...payload.matchAll(pattern)].map(match => match[1]).join('');
}

function buildInstaller() {
  const powershellTemplate = read('n8n/deploy/install-ews-node.ps1');
  const cmdTemplate = read('n8n/deploy/install-ews-node.cmd');
  const imageSidecar = imageSidecarFiles.map(name => ({ name, content: read(`n8n/image-sidecar/${name}`) }));
  const powershell = powershellTemplate
    .replace('__EWS_IMAGE_SIDECAR_BUNDLE_B64__', () => bundleAssignmentLines('ImageServiceBundleBase64', base64(JSON.stringify(imageSidecar))));
  const payload = `__EWS_PS1_BEGIN__\n${powershell.trim()}\n__EWS_PS1_END__`;
  const generated = cmdTemplate.replace('__EWS_POWERSHELL_PAYLOAD__', () => payload);
  return generated.replace(/\r?\n/g, '\r\n');
}

function rebuildPayload(generated) {
  const match = generated.match(/__EWS_PS1_BEGIN__\r?\n([\s\S]*?)\r?\n__EWS_PS1_END__/);
  return match ? match[1] : '';
}

test('one-click CMD deploys the runtime without workflows or model credentials', () => {
  const cmdTemplate = read('n8n/deploy/install-ews-node.cmd');
  const powershellTemplate = read('n8n/deploy/install-ews-node.ps1');
  const installerModule = read('src/distributed-n8n-installer.js');
  const generated = buildInstaller();

  assert.doesNotMatch(cmdTemplate, /certutil|EWS_PAYLOAD_B64/);
  assert.match(cmdTemplate, /powershell\.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass/);
  assert.match(cmdTemplate, /goto :extract_payload/);
  assert.match(cmdTemplate, /if not defined EWS_NO_PAUSE pause/);
  assert.match(powershellTemplate, /\$NodeName = '__EWS_NODE_NAME__'/);
  assert.doesNotMatch(powershellTemplate, /Decode-Value|EWS_NODE_NAME_B64/);
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
  assert.match(powershellTemplate, /Updating Docker image/);
  assert.doesNotMatch(powershellTemplate, /Using local Docker image/);
  assert.doesNotMatch(powershellTemplate, /Reusing the local image service/);
  assert.match(powershellTemplate, /function Wait-DockerContainerNetwork/);
  assert.match(powershellTemplate, /function Write-ImageServiceSource/);
  assert.match(powershellTemplate, /\[Convert\]::FromBase64String\(\$BundleBase64\)/);
  assert.match(powershellTemplate, /\[Text\.Encoding\]::UTF8\.GetString\(\$bundleBytes\)/);
  assert.match(powershellTemplate, /\$parsedEntries = \$bundleJson \| ConvertFrom-Json/);
  assert.doesNotMatch(powershellTemplate, /\$BundleBase64 \| ConvertFrom-Json/);
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
  assert.doesNotMatch(powershellTemplate, /import:credentials|import:workflow|publish:workflow|list:workflow/);
  assert.doesNotMatch(powershellTemplate, /WorkflowBundleJson|WorkflowDirectory|CredentialDirectory/);
  assert.doesNotMatch(powershellTemplate, /GrsaiKey|DeepseekKey|BackupKey|Ua1TBIbDcAu3z8pU|11xE3AjgQ1iUHDdR|bkpImgApi20260722/);
  assert.match(powershellTemplate, /docker network connect \$ImageDockerNetwork \$ContainerName/);
  assert.match(powershellTemplate, /\$ImageDockerNetwork = Ensure-LocalImageService \$ImageServiceBundleBase64 \$CallbackSecret \$TicketOrigin/);
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
  assert.doesNotMatch(installerModule, /workflowEntry|WORKFLOWS|WORKFLOW_PLACEHOLDER|from '\.\.\/n8n\/[^/]+\.json'/);
  assert.match(installerModule, /sidecarEntry\('Dockerfile', sidecarDockerfile\)/);
  assert.match(installerModule, /sidecarEntry\('src\/worker\.js', sidecarWorker\)/);
  assert.match(installerModule, /IMAGE_SIDECAR_PLACEHOLDER/);
  assert.match(installerModule, /PS1_BEGIN_MARKER/);
  assert.ok(Math.max(...generated.split(/\r?\n/).map(line => line.length)) < 8191);
  assert.doesNotMatch(generated, /__EWS_WORKFLOW_BUNDLE_B64__|__EWS_IMAGE_SIDECAR_BUNDLE_B64__|__EWS_POWERSHELL_PAYLOAD__/);
  assert.match(generated, /__EWS_NODE_NAME__/);
  assert.doesNotMatch(generated, /sk-[A-Za-z0-9_-]{16,}/);

  const payload = rebuildPayload(generated);
  assert.doesNotMatch(payload, /WorkflowBundleJson|import:credentials|import:workflow|publish:workflow|list:workflow/);
  assert.match(payload, /\$ImageServiceBundleBase64 = ''/);
  assert.match(payload, /^function Install-DockerDesktop/m);
  assert.doesNotMatch(payload, /Ua1TBIbDcAu3z8pU|11xE3AjgQ1iUHDdR|bkpImgApi20260722/);
});

test('browser parameter injection embeds plaintext values', () => {
  const values = {
    '__EWS_NODE_NAME__': 'test-node',
    '__EWS_DOMAIN__': 'test-node.example.com',
    '__EWS_OWNER_EMAIL__': 'owner@example.com',
    '__EWS_OWNER_PASSWORD__': 'Owner-password-2026',
    '__EWS_IMAGE_SERVICE_URL__': 'http://ews-image-sidecar:3000',
    '__EWS_CALLBACK_SECRET__': 'callback-secret-value',
    '__EWS_TICKET_ORIGIN__': 'https://ewsz.langaj.cc',
    '__EWS_PORT__': '5692',
  };
  let generated = buildInstaller();
  for (const [token, value] of Object.entries(values)) generated = generated.split(token).join(injectInstallerValue(value));

  assert.doesNotMatch(generated, /__EWS_(?:NODE_NAME|DOMAIN|OWNER_EMAIL|OWNER_PASSWORD|IMAGE_SERVICE_URL|CALLBACK_SECRET|TICKET_ORIGIN|PORT)__/);

  const payload = rebuildPayload(generated);
  assert.match(payload, /\$NodeName = 'test-node'/);
  assert.match(payload, /\$OwnerPassword = 'Owner-password-2026'/);
  assert.doesNotMatch(payload, /GrsaiKey|DeepseekKey|BackupKey/);
  assert.match(payload, /\$Port = \[int\]'5692'/);
  const sidecarBundleBase64 = joinBundle(payload, 'ImageServiceBundleBase64');
  const sidecarBundle = JSON.parse(Buffer.from(sidecarBundleBase64, 'base64').toString('utf8'));
  assert.deepEqual(sidecarBundle.map(entry => entry.name), imageSidecarFiles);
  assert.match(sidecarBundle.find(entry => entry.name === 'src/app.js').content, /from 'fastify'/);
  assert.match(payload, /\$ImageServiceInput = 'http:\/\/ews-image-sidecar:3000'\.Trim\(\)/);
});

test('Windows PowerShell decodes the generated image service bundle', { skip: process.platform !== 'win32' }, () => {
  const payload = rebuildPayload(buildInstaller());
  const sidecarBundleBase64 = joinBundle(payload, 'ImageServiceBundleBase64');
  const command = "$base64 = [Console]::In.ReadToEnd(); $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($base64)); $parsed = $json | ConvertFrom-Json; @($parsed).Count";
  const count = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    input: sidecarBundleBase64,
    encoding: 'utf8',
  }).trim();
  assert.equal(count, String(imageSidecarFiles.length));
});

test('special characters in injected values survive the plaintext payload extraction', { skip: process.platform !== 'win32' }, () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ews-installer-test-'));
  const cmdPath = path.join(tmpDir, 'test.cmd');
  const ps1Path = path.join(tmpDir, 'out.ps1');
  const dataRows = [
    'function Test {',
    "  $OwnerPassword = 'Owner''s-pw&<2026|>%x%'",
    "  $CallbackSecret = 'callback^secret-value'.Trim()",
    "  if ($x -notmatch '^[a-z0-9]{0,31}$') { throw }",
    '}',
  ];
  const ps1PathArg = ps1Path.replace(/\\/g, '/');
  try {
    const cmd = [
      '@echo off',
      'setlocal EnableExtensions DisableDelayedExpansion',
      'chcp 65001 >nul',
      'goto :extract_payload',
      '',
      '__EWS_PS1_BEGIN__',
      ...dataRows,
      '__EWS_PS1_END__',
      '',
      ':extract_payload',
      `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$c=[IO.File]::ReadAllText('%~f0');$s=$c.IndexOf('__EWS_PS1_BEGIN__')+18;$e=$c.IndexOf('__EWS_PS1_END__');if($s -lt 0 -or $e -le $s){Write-Error 'markers missing';exit 1};[IO.File]::WriteAllText('${ps1PathArg}',$c.Substring($s,$e-$s).Trim(),(New-Object Text.UTF8Encoding($false)))"`,
      'exit /b 0',
    ];
    fs.writeFileSync(cmdPath, cmd.join('\r\n'));
    execFileSync('cmd.exe', ['/d', '/c', cmdPath], { encoding: 'utf8' });
    const out = fs.readFileSync(ps1Path, 'utf8');
    assert.equal(out, dataRows.join('\r\n'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('admin deployment wiki protects installer details and uses CMD flow', () => {
  const workerWiki = read('src/admin-deployment-wiki.js');
  const workerEntry = read('src/index.js');
  const frontendShell = fs.readFileSync(path.join(root, '../ews-frontend/admin-deployment-wiki.html'), 'utf8');
  const frontendApi = fs.readFileSync(path.join(root, '../ews-frontend/js/api.js'), 'utf8');

  assert.match(workerWiki, /一份可双击运行的 CMD/);
  assert.match(workerWiki, /Docker Desktop 缺失时自动下载并安装/);
  assert.match(workerWiki, /始终拉取最新 n8n 与 Valkey 镜像/);
  assert.match(workerWiki, /Cloudflare Tunnel/);
  assert.match(workerEntry, /requireAuth\(request, env, \(\) => handleGetDistributedN8nWiki\(request\)\)/);
  assert.match(workerEntry, /requireAuth\(request, env, \(\) => handleDownloadDistributedN8nScript\(request\)\)/);
  assert.match(workerEntry, /request\.auth\?\.role === 'admin'/);
  assert.match(workerEntry, /'Cache-Control': 'private, no-store, max-age=0'/);
  assert.match(frontendShell, /生成一键部署脚本/);
  assert.match(frontendShell, /模型凭证不写入安装脚本/);
  assert.match(frontendShell, /API\.getConfig\(\)/);
  assert.match(frontendShell, /id="callbackSecret"/);
  assert.match(frontendShell, /默认地址会在本机自动部署/);
  assert.match(frontendShell, /人工导入 9 个 workflow JSON/);
  assert.match(frontendShell, /不会导入、修改或发布任何工作流/);
  assert.match(frontendShell, /ownerPassword\.length < 8 \|\| values\.ownerPassword\.length > 64/);
  assert.match(frontendShell, /!\/\[A-Z\]\/\.test\(values\.ownerPassword\)/);
  assert.match(frontendShell, /!\/\\d\/\.test\(values\.ownerPassword\)/);
  assert.match(frontendShell, /install-ews-' \+ nodeName \+ '\.cmd'/);
  assert.match(frontendShell, /cloudflare\/cloudflared:latest/);
  assert.match(frontendShell, /getDistributedN8nWiki\(\)/);
  assert.match(frontendApi, /install-ews-node\.cmd/);
  assert.doesNotMatch(frontendShell, /Ua1TBIbDcAu3z8pU|11xE3AjgQ1iUHDdR|bkpImgApi20260722/);
  assert.doesNotMatch(frontendShell, /id="(?:grsaiKey|deepseekKey|backupKey)"/);
});
