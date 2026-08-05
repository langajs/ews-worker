import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  canGrantPlatformAccess,
  canManageUser,
  isGroupAdmin,
  isSystemAdmin,
  isUserManager,
  manageablePlatforms,
} from '../src/admin-access.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

const systemAdmin = { username: 'admin', role: 'admin', group_id: 'default', platform_access: 'allow' };
const jstAdmin = { username: 'manager-a', role: 'group_admin', group_id: 'group-a', platform_access: 'jst' };
const fullGroupAdmin = { username: 'manager-b', role: 'group_admin', group_id: 'group-b', platform_access: 'allow' };

test('only the default admin is the unrestricted system administrator', () => {
  assert.equal(isSystemAdmin(systemAdmin), true);
  assert.equal(isSystemAdmin({ ...systemAdmin, username: 'other-admin' }), false);
  assert.equal(isSystemAdmin(jstAdmin), false);
  assert.equal(isGroupAdmin(jstAdmin), true);
  assert.equal(isUserManager(jstAdmin), true);
  assert.equal(isUserManager({ role: 'user', group_id: 'group-a' }), false);
});

test('group admins can manage only non-system users in their own group', () => {
  assert.equal(canManageUser(jstAdmin, { id: 'user-a', role: 'user', group_id: 'group-a' }), true);
  assert.equal(canManageUser(jstAdmin, { id: 'manager-a', role: 'group_admin', group_id: 'group-a' }), true);
  assert.equal(canManageUser(jstAdmin, { id: 'user-b', role: 'user', group_id: 'group-b' }), false);
  assert.equal(canManageUser(jstAdmin, { id: 'admin', role: 'admin', group_id: 'group-a' }), false);
  assert.equal(canManageUser(systemAdmin, { id: 'user-b', role: 'user', group_id: 'group-b' }), true);
});

test('group admins cannot grant platform capabilities they do not have', () => {
  assert.equal(canGrantPlatformAccess(jstAdmin, 'jst'), true);
  assert.equal(canGrantPlatformAccess(jstAdmin, 'shopee'), false);
  assert.equal(canGrantPlatformAccess(jstAdmin, 'allow'), false);
  assert.deepEqual(manageablePlatforms(jstAdmin), ['jst']);
  assert.equal(canGrantPlatformAccess(fullGroupAdmin, 'jst'), true);
  assert.equal(canGrantPlatformAccess(fullGroupAdmin, 'shopee'), true);
  assert.equal(canGrantPlatformAccess(fullGroupAdmin, 'allow'), true);
  assert.deepEqual(manageablePlatforms(fullGroupAdmin), ['jst', 'shopee']);
});

test('group secret and user management integrations remain scoped', () => {
  const worker = read('src/index.js');
  const migration = read('migrations/0017_group_admin_permissions.sql');
  const configPage = fs.readFileSync(path.join(root, '../ews-frontend/config.html'), 'utf8');
  const userPage = fs.readFileSync(path.join(root, '../ews-frontend/user-management.html'), 'utf8');
  const nav = fs.readFileSync(path.join(root, '../ews-frontend/js/nav.js'), 'utf8');

  assert.match(migration, /ALTER TABLE ews_groups ADD COLUMN callback_secret/);
  assert.match(migration, /ALTER TABLE ews_tasks ADD COLUMN group_id/);
  assert.match(migration, /UPDATE ews_users[\s\S]*role = 'group_admin'[\s\S]*id <> 'admin'/);
  assert.match(worker, /callbackSecretForTask\(env, idx\)/);
  assert.match(worker, /if \(!user && loginName === 'admin'\)/);
  assert.match(worker, /delete body\.callback_secret/);
  assert.match(worker, /受限管理员不能切换用户分组/);
  assert.match(worker, /只有默认管理员可以创建受限管理员/);
  assert.doesNotMatch(configPage, /id="callbackSecret"/);
  assert.doesNotMatch(configPage, /id="tab-users"/);
  assert.match(configPage, /回调与 R2 回传密钥/);
  assert.match(userPage, /id="webhookTabs"/);
  assert.match(userPage, /value="group_admin"/);
  assert.match(nav, /user-management\.html/);
  assert.match(nav, /role === 'group_admin'/);
});
