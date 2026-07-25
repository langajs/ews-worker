import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { getUpdateLogWiki } from '../src/update-log.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('update log combines live audit metrics, releases, stack and roadmap', () => {
  const wiki = getUpdateLogWiki({
    active_profiles: 7,
    current_versions: 7,
    preorder_ready_profiles: 7,
    preorder_products: 114,
    last_template_update: '2026-07-25 10:00:00',
  });

  assert.equal(wiki.audit.active_profiles, 7);
  assert.equal(wiki.audit.preorder_products, 114);
  assert.ok(wiki.releases.length >= 3);
  assert.ok(wiki.stack.some(item => item.components.includes('Cloudflare Workers')));
  assert.ok(wiki.template_flow.some(item => item.step === '导出'));
  assert.ok(wiki.template_audit.some(item => item.title.includes('预售物流')));
  assert.ok(wiki.roadmap.some(item => item.priority === 'P0'));
});

test('update_log uses the protected wiki endpoint and stays admin-only', () => {
  const indexSource = fs.readFileSync(path.join(root, 'src/index.js'), 'utf8');
  const frontend = fs.readFileSync(path.join(root, '../ews-frontend/update_log.html'), 'utf8');
  const api = fs.readFileSync(path.join(root, '../ews-frontend/js/api.js'), 'utf8');
  const nav = fs.readFileSync(path.join(root, '../ews-frontend/js/nav.js'), 'utf8');

  assert.match(indexSource, /\/api\/admin\/wiki\/update-log/);
  assert.match(indexSource, /handleGetUpdateLog\(request, env\)/);
  assert.match(indexSource, /adminWikiError\(request\)/);
  assert.match(indexSource, /Cache-Control': 'private, no-store, max-age=0'/);
  assert.match(frontend, /await requireAuth\(\)/);
  assert.match(frontend, /ews_role'\) !== 'admin'/);
  assert.match(frontend, /API\.getUpdateLog\(\)/);
  assert.doesNotMatch(frontend, /Cloudflare Workers、D1、R2/);
  assert.match(api, /getUpdateLog\(\).*\/api\/admin\/wiki\/update-log/);
  assert.match(nav, /update_log\.html/);
});
