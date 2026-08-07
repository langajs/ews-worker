import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  canAdjustUserCredits,
  canAccessTask,
  canControlTask,
  canGrantPlatformAccess,
  canManageUser,
  canManageUserLifecycle,
  isGroupAdmin,
  isSystemAdmin,
  isUserManager,
  manageablePlatforms,
} from '../src/admin-access.js';
import { resolveWorkflowConfig } from '../src/workflow-config.js';

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

test('group admins cannot manage their own lifecycle or credits', () => {
  const self = { id: 'manager-a', role: 'group_admin', group_id: 'group-a' };
  const peer = { id: 'manager-peer', role: 'group_admin', group_id: 'group-a' };
  const user = { id: 'user-a', role: 'user', group_id: 'group-a' };
  assert.equal(canManageUserLifecycle(jstAdmin, self), false);
  assert.equal(canAdjustUserCredits(jstAdmin, self), false);
  assert.equal(canAdjustUserCredits(jstAdmin, peer), false);
  assert.equal(canManageUserLifecycle(jstAdmin, user), true);
  assert.equal(canAdjustUserCredits(jstAdmin, user), true);
  assert.equal(canAdjustUserCredits(systemAdmin, self), true);
});

test('group admin deletion refunds credits only for ordinary users', () => {
  const worker = read('src/index.js');
  assert.match(worker, /handleDeleteUser[\s\S]*if \(isGroupAdmin\(request\.auth\) && user\.role === 'user'\)[\s\S]*deleteUserWithCreditRefund/);
  assert.match(worker, /handleUpdateUserCredits[\s\S]*if \(isGroupAdmin\(request\.auth\)\)[\s\S]*transferUserCredits/);
});

test('group admins can access every task in their group and no task outside it', () => {
  assert.equal(canAccessTask(jstAdmin, { user_id: 'user-a', group_id: 'group-a' }), true);
  assert.equal(canAccessTask(jstAdmin, { user_id: 'manager-a', group_id: 'group-a' }), true);
  assert.equal(canAccessTask(jstAdmin, { user_id: 'manager-a', group_id: 'group-b' }), false);
  assert.equal(canAccessTask({ username: 'user-a', role: 'user', group_id: 'group-a' }, { user_id: 'user-b', group_id: 'group-a' }), false);
  assert.equal(canAccessTask(systemAdmin, { user_id: 'user-b', group_id: 'group-b' }), true);
  assert.equal(canControlTask(jstAdmin, { user_id: 'user-a', group_id: 'group-a' }), false);
  assert.equal(canControlTask(jstAdmin, { user_id: 'manager-a', group_id: 'group-a' }), true);
  assert.equal(canControlTask(systemAdmin, { user_id: 'user-b', group_id: 'group-b' }), true);
});

test('workflow webhooks resolve in user, group, global priority order', () => {
  const globalConfig = {
    n8n_title_webhook: 'https://global/title',
    n8n_main_webhook: 'https://global/main',
    n8n_sub_image_webhook: 'https://global/sub',
    n8n_title_enabled: 'true',
  };
  const groupConfig = JSON.stringify({ jst: {
    n8n_title_webhook: 'https://group/title',
    n8n_main_webhook: '',
    n8n_title_enabled: false,
    push_primary_images_only: true,
  } });
  const userConfig = JSON.stringify({ jst: {
    n8n_title_webhook: 'https://user/title',
    n8n_sub_image_webhook: '',
  } });
  assert.deepEqual(resolveWorkflowConfig(globalConfig, groupConfig, userConfig, 'jst'), {
    n8n_title_webhook: 'https://user/title',
    n8n_main_webhook: 'https://global/main',
    n8n_sub_image_webhook: 'https://global/sub',
    n8n_title_enabled: false,
  });
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
  const workflowMigration = read('migrations/0018_group_workflow_config.sql');
  const configPage = fs.readFileSync(path.join(root, '../ews-frontend/config.html'), 'utf8');
  const userPage = fs.readFileSync(path.join(root, '../ews-frontend/user-management.html'), 'utf8');
  const nav = fs.readFileSync(path.join(root, '../ews-frontend/js/nav.js'), 'utf8');

  assert.match(migration, /ALTER TABLE ews_groups ADD COLUMN callback_secret/);
  assert.match(migration, /ALTER TABLE ews_tasks ADD COLUMN group_id/);
  assert.match(workflowMigration, /ALTER TABLE ews_groups ADD COLUMN workflow_config/);
  assert.match(migration, /UPDATE ews_users[\s\S]*role = 'group_admin'[\s\S]*id <> 'admin'/);
  assert.match(worker, /callbackSecretForTask\(env, idx\)/);
  assert.match(worker, /getTaskList\(env, platform, auth\.username, taskRole, auth\.group_id/);
  assert.match(worker, /groupId: isSystemAdmin\(auth\) \? String\(url\.searchParams\.get\('group_id'\)/);
  assert.match(worker, /applyWorkflowOverrides\(config, group\?\.workflow_config, platform\)[\s\S]*applyWorkflowOverrides\(config, owner\?\.webhook_config, platform\)/);
  assert.match(worker, /if \(!user && loginName === 'admin'\)/);
  assert.match(worker, /delete body\.callback_secret/);
  assert.match(worker, /受限管理员不能切换用户分组/);
  assert.match(worker, /只有默认管理员可以创建受限管理员/);
  assert.doesNotMatch(configPage, /id="callbackSecret"/);
  assert.doesNotMatch(configPage, /id="tab-users"/);
  assert.match(configPage, /回调与 R2 回传密钥/);
  assert.match(configPage, /分组工作流配置/);
  assert.match(configPage, /id="groupWorkflowSelect"/);
  assert.match(configPage, /id="groupTemplateSelect"/);
  assert.match(configPage, /updateGroupTemplates/);
  assert.match(userPage, /id="webhookTabs"/);
  assert.match(userPage, /value="group_admin"/);
  assert.match(nav, /user-management\.html/);
  assert.match(nav, /role === 'group_admin'/);
});
