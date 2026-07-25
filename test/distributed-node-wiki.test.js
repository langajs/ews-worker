import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('distributed node deployment script is self-contained', () => {
  const script = fs.readFileSync(path.join(root, 'n8n/deploy/deploy-extra-node.ps1'), 'utf8');
  assert.match(script, /\[string\]\$CredentialsDirectory = ''/);
  assert.match(script, /\[ValidateSet\('direct', 'tunnel'\)\]/);
  assert.match(script, /\[string\]\$TunnelToken = ''/);
  assert.match(script, /\[string\]\$OriginCertPath = ''/);
  assert.match(script, /\$composeContent = @'/);
  assert.match(script, /cloudflare\/cloudflared:latest/);
  assert.match(script, /TUNNEL_TOKEN: \$\{CLOUDFLARE_TUNNEL_TOKEN\}/);
  assert.match(script, /n8nio\/n8n:stable/);
  assert.match(script, /127\.0\.0\.1:/);
  assert.match(script, /N8N_SSL_CERT: \/certs\/origin\.pem/);
  assert.match(script, /import:credentials --separate --input=\/tmp\/ews-credentials/);
  assert.match(script, /n8n import:workflow --separate --input=\/workflows/);
  assert.doesNotMatch(script, /sk-[A-Za-z0-9_-]{16,}/);
});

test('admin deployment wiki keeps its protected details out of the static shell', () => {
  const workerWiki = fs.readFileSync(path.join(root, 'src/admin-deployment-wiki.js'), 'utf8');
  const workerEntry = fs.readFileSync(path.join(root, 'src/index.js'), 'utf8');
  const frontendShell = fs.readFileSync(path.join(root, '../ews-frontend/admin-deployment-wiki.html'), 'utf8');
  assert.match(workerWiki, /GrsaiApp/);
  assert.match(workerWiki, /本地主机 · Cloudflare Tunnel/);
  assert.match(workerWiki, /云服务器 · Cloudflare DNS/);
  assert.match(workerWiki, /Full \(strict\)/);
  assert.match(workerWiki, /标准流程只依赖 Docker Engine 或 Docker Desktop/);
  assert.match(workerWiki, /--entrypoint node n8nio\/n8n:stable/);
  assert.match(workerWiki, /docker exec "\$CONTAINER" n8n import:workflow/);
  assert.doesNotMatch(workerWiki, /Linux 首次启动.*pwsh/);
  assert.match(workerWiki, /\/api\/admin\/wiki\/distributed-n8n\/script/);
  assert.match(workerEntry, /requireAuth\(request, env, \(\) => handleGetDistributedN8nWiki\(request\)\)/);
  assert.match(workerEntry, /requireAuth\(request, env, \(\) => handleDownloadDistributedN8nScript\(request\)\)/);
  assert.match(workerEntry, /request\.auth\?\.role === 'admin'/);
  assert.match(workerEntry, /'Cache-Control': 'private, no-store, max-age=0'/);
  assert.doesNotMatch(frontendShell, /GrsaiApp|Ua1TBIbDcAu3z8pU|proxy_pass/);
  assert.match(frontendShell, /wikiMode/);
  assert.match(frontendShell, /TUNNEL_TOKEN/);
  assert.match(frontendShell, /getDistributedN8nWiki\(\)/);
});
