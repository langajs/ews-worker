import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('distributed node deployment script is self-contained', () => {
  const script = fs.readFileSync(path.join(root, 'n8n/deploy/deploy-extra-node.ps1'), 'utf8');
  assert.match(script, /\[string\]\$CredentialsDirectory = ''/);
  assert.match(script, /\$composeContent = @'/);
  assert.match(script, /import:credentials --separate --input=\/tmp\/ews-credentials/);
  assert.match(script, /n8n import:workflow --separate --input=\/workflows/);
  assert.doesNotMatch(script, /sk-[A-Za-z0-9_-]{16,}/);
});

test('admin deployment wiki keeps its protected details out of the static shell', () => {
  const workerWiki = fs.readFileSync(path.join(root, 'src/admin-deployment-wiki.js'), 'utf8');
  const workerEntry = fs.readFileSync(path.join(root, 'src/index.js'), 'utf8');
  const frontendShell = fs.readFileSync(path.join(root, '../ews-frontend/admin-deployment-wiki.html'), 'utf8');
  assert.match(workerWiki, /GrsaiApp/);
  assert.match(workerWiki, /\/api\/admin\/wiki\/distributed-n8n\/script/);
  assert.match(workerEntry, /requireAuth\(request, env, \(\) => handleGetDistributedN8nWiki\(request\)\)/);
  assert.match(workerEntry, /requireAuth\(request, env, \(\) => handleDownloadDistributedN8nScript\(request\)\)/);
  assert.match(workerEntry, /request\.auth\?\.role === 'admin'/);
  assert.match(workerEntry, /'Cache-Control': 'private, no-store, max-age=0'/);
  assert.doesNotMatch(frontendShell, /GrsaiApp|Ua1TBIbDcAu3z8pU|proxy_pass/);
  assert.match(frontendShell, /getDistributedN8nWiki\(\)/);
});
