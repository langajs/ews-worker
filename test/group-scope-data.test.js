import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  createUserWithCreditCharge,
  deleteUserWithCreditRefund,
  getTaskCount,
  getTaskList,
  getTaskOwners,
  shopeeReplaceGroupTemplates,
  shopeeReplaceTemplateGroups,
  transferUserCredits,
  updateUserGroup,
} from '../src/db.js';

class D1Statement {
  constructor(database, sql, params = []) {
    this.database = database;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new D1Statement(this.database, this.sql, params);
  }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.params) };
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.params) || null;
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: result.changes }, changes: result.changes };
  }
}

function createEnv(schema) {
  const database = new DatabaseSync(':memory:');
  database.exec(schema);
  return {
    database,
    env: {
      DB: {
        prepare(sql) { return new D1Statement(database, sql); },
        async batch(statements) { return Promise.all(statements.map(statement => statement.run())); },
      },
    },
  };
}

test('task queries expose the full group only to group admins', async () => {
  const { database, env } = createEnv(`
    CREATE TABLE ews_tasks (
      id TEXT PRIMARY KEY, platform TEXT NOT NULL, status TEXT NOT NULL,
      user_id TEXT NOT NULL, group_id TEXT NOT NULL,
      created_at TEXT NOT NULL, completed_at TEXT
    );
    INSERT INTO ews_tasks VALUES
      ('task-a1','jst','pending','user-a','group-a',datetime('now'),NULL),
      ('task-a2','shopee','pending','user-b','group-a',datetime('now'),NULL),
      ('task-b1','jst','pending','user-c','group-b',datetime('now'),NULL);
  `);
  try {
    const groupRows = await getTaskList(env, '', 'manager-a', 'group_admin', 'group-a');
    assert.deepEqual(groupRows.results.map(row => row.id).sort(), ['task-a1', 'task-a2']);
    assert.equal(await getTaskCount(env, '', 'manager-a', 'group_admin', 'group-a'), 2);

    const userRows = await getTaskList(env, '', 'user-a', 'user', 'group-a');
    assert.deepEqual(userRows.results.map(row => row.id), ['task-a1']);
    assert.equal(await getTaskCount(env, '', 'user-a', 'user', 'group-a'), 1);

    const adminRows = await getTaskList(env, '', 'admin', 'admin', 'default');
    assert.equal(adminRows.results.length, 3);
  } finally {
    database.close();
  }
});

test('moving a user keeps existing tasks in their creation-time group', async () => {
  const { database, env } = createEnv(`
    CREATE TABLE ews_users (id TEXT PRIMARY KEY, group_id TEXT NOT NULL);
    CREATE TABLE ews_tasks (
      id TEXT PRIMARY KEY, platform TEXT NOT NULL, status TEXT NOT NULL,
      user_id TEXT NOT NULL, group_id TEXT NOT NULL,
      created_at TEXT NOT NULL, completed_at TEXT
    );
    INSERT INTO ews_users VALUES ('user-a','group-a');
    INSERT INTO ews_tasks VALUES
      ('task-a1','jst','pending','user-a','group-a',datetime('now'),NULL),
      ('task-a2','shopee','completed','user-a','group-a',datetime('now'),datetime('now'));
  `);
  try {
    await updateUserGroup(env, 'user-a', 'group-b');

    assert.equal(database.prepare('SELECT group_id FROM ews_users WHERE id=?').get('user-a').group_id, 'group-b');
    assert.deepEqual(database.prepare('SELECT id,group_id FROM ews_tasks ORDER BY id').all().map(row => `${row.id}:${row.group_id}`), [
      'task-a1:group-a',
      'task-a2:group-a',
    ]);

    const ownerRows = await getTaskList(env, '', 'user-a', 'user', 'group-b');
    assert.deepEqual(ownerRows.results.map(row => row.id).sort(), ['task-a1', 'task-a2']);
    assert.equal((await getTaskList(env, '', 'manager-a', 'group_admin', 'group-a')).results.length, 2);
    assert.equal((await getTaskList(env, '', 'manager-b', 'group_admin', 'group-b')).results.length, 0);
  } finally {
    database.close();
  }
});

test('task filters search visible users, task ids, sub-task ids and names without crossing scope', async () => {
  const { database, env } = createEnv(`
    CREATE TABLE ews_tasks (
      id TEXT PRIMARY KEY, platform TEXT NOT NULL, name TEXT NOT NULL,
      status TEXT NOT NULL, user_id TEXT NOT NULL, group_id TEXT NOT NULL,
      created_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE TABLE ews_jst_sub_tasks (id TEXT PRIMARY KEY, parent_task_id TEXT NOT NULL);
    CREATE TABLE ews_shopee_sub_tasks (id TEXT PRIMARY KEY, parent_task_id TEXT NOT NULL);
    INSERT INTO ews_tasks VALUES
      ('task-a1','jst','Summer Shirt','pending','user-a','group-a',datetime('now'),NULL),
      ('task-a2','shopee','Literal 100% Cotton','pending','user-b','group-a',datetime('now'),NULL),
      ('task-a-old','jst','Archived Shirt','completed','user-a','group-a',datetime('now','-1 day'),datetime('now')),
      ('task-b1','jst','Summer Shoes','pending','user-c','group-b',datetime('now'),NULL);
    INSERT INTO ews_jst_sub_tasks VALUES ('sub-a1','task-a1'),('sub-b1','task-b1');
    INSERT INTO ews_shopee_sub_tasks VALUES ('sub-a2','task-a2');
  `);
  try {
    const dates = database.prepare("SELECT strftime('%Y-%m-%d', datetime('now', '+8 hours')) AS today, strftime('%Y-%m-%d', datetime('now', '-1 day', '+8 hours')) AS yesterday").get();
    const scope = ['', 'manager-a', 'group_admin', 'group-a'];
    assert.deepEqual((await getTaskOwners(env, scope[1], scope[2], scope[3])).results.map(row => row.user_id), ['user-a', 'user-b']);
    assert.deepEqual((await getTaskList(env, ...scope, 0, 0, { userIds: ['user-a', 'user-b'] })).results.map(row => row.id).sort(), ['task-a-old', 'task-a1', 'task-a2']);
    assert.equal((await getTaskList(env, ...scope, 0, 0, { userIds: ['user-c'] })).results.length, 0);
    assert.equal((await getTaskList(env, ...scope, 0, 0, { groupId: 'group-b' })).results.length, 0);
    assert.deepEqual((await getTaskList(env, ...scope, 0, 0, { taskOrSubTaskId: 'sub-a1' })).results.map(row => row.id), ['task-a1']);
    assert.equal((await getTaskList(env, ...scope, 0, 0, { taskOrSubTaskId: 'sub-b1' })).results.length, 0);
    assert.deepEqual((await getTaskList(env, ...scope, 0, 0, { name: 'summer' })).results.map(row => row.id), ['task-a1']);
    assert.deepEqual((await getTaskList(env, ...scope, 0, 0, { name: '100%' })).results.map(row => row.id), ['task-a2']);
    assert.deepEqual((await getTaskList(env, ...scope, 0, 0, { createdDate: dates.yesterday })).results.map(row => row.id), ['task-a-old']);
    assert.deepEqual((await getTaskList(env, ...scope, 0, 0, { createdDate: dates.today })).results.map(row => row.id).sort(), ['task-a1', 'task-a2']);
    assert.equal(await getTaskCount(env, ...scope, { taskOrSubTaskId: 'task-b1' }), 0);
    assert.deepEqual((await getTaskList(env, '', 'admin', 'admin', 'default', 0, 0, { groupId: 'group-b' })).results.map(row => row.id), ['task-b1']);
    assert.deepEqual((await getTaskOwners(env, 'admin', 'admin', 'default', { groupId: 'group-b' })).results.map(row => row.user_id), ['user-c']);
  } finally {
    database.close();
  }
});

test('group admin credit transfers preserve totals and reject overdrafts', async () => {
  const { database, env } = createEnv(`
    CREATE TABLE ews_users (id TEXT PRIMARY KEY, credits INTEGER NOT NULL);
    INSERT INTO ews_users VALUES ('manager-a',300),('user-a',200);
  `);
  try {
    assert.equal(await transferUserCredits(env, 'manager-a', 'user-a', 0), false);
    assert.equal(await transferUserCredits(env, 'manager-a', 'user-a', 1.5), false);
    assert.equal(await transferUserCredits(env, 'manager-a', 'user-a', 100), true);
    assert.deepEqual(database.prepare('SELECT id,credits FROM ews_users ORDER BY id').all().map(row => `${row.id}:${row.credits}`), ['manager-a:200', 'user-a:300']);
    assert.equal(await transferUserCredits(env, 'manager-a', 'user-a', 201), false);
    assert.equal(await transferUserCredits(env, 'user-a', 'manager-a', 301), false);
    assert.deepEqual(database.prepare('SELECT id,credits FROM ews_users ORDER BY id').all().map(row => `${row.id}:${row.credits}`), ['manager-a:200', 'user-a:300']);
    assert.equal(await transferUserCredits(env, 'user-a', 'manager-a', 300), true);
    assert.deepEqual(database.prepare('SELECT id,credits FROM ews_users ORDER BY id').all().map(row => `${row.id}:${row.credits}`), ['manager-a:500', 'user-a:0']);
  } finally {
    database.close();
  }
});

test('group admin user creation atomically charges two hundred credits', async () => {
  const { database, env } = createEnv(`
    CREATE TABLE ews_users (
      id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL, display_name TEXT, platform_access TEXT NOT NULL,
      group_id TEXT NOT NULL, image_concurrency_limit INTEGER NOT NULL,
      credits INTEGER NOT NULL, created_by TEXT
    );
    INSERT INTO ews_users VALUES ('manager-a','manager-a','hash','group_admin','','jst','group-a',20,199,'admin');
  `);
  const user = { id: 'user-a', username: 'user-a', password_hash: 'hash', role: 'user', platform_access: 'jst', group_id: 'group-a', image_concurrency_limit: 20, created_by: 'manager-a' };
  try {
    assert.equal(await createUserWithCreditCharge(env, user, 'manager-a', 0), false);
    assert.equal(await createUserWithCreditCharge(env, user, 'manager-a', 200), false);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ews_users').get().count, 1);
    assert.equal(database.prepare('SELECT credits FROM ews_users WHERE id=?').get('manager-a').credits, 199);
    database.prepare('UPDATE ews_users SET credits=400 WHERE id=?').run('manager-a');
    assert.equal(await createUserWithCreditCharge(env, user, 'manager-a', 200), true);
    assert.equal(database.prepare('SELECT credits FROM ews_users WHERE id=?').get('manager-a').credits, 200);
    assert.equal(database.prepare('SELECT credits FROM ews_users WHERE id=?').get('user-a').credits, 200);
  } finally {
    database.close();
  }
});

test('group admin user deletion atomically refunds remaining credits', async () => {
  const { database, env } = createEnv(`
    CREATE TABLE ews_users (
      id TEXT PRIMARY KEY, role TEXT NOT NULL, group_id TEXT NOT NULL,
      credits INTEGER NOT NULL
    );
    CREATE TABLE ews_shopee_template_user_meta (profile_id TEXT, user_id TEXT);
    INSERT INTO ews_users VALUES
      ('manager-a','group_admin','group-a',100),
      ('manager-b','group_admin','group-b',300),
      ('user-a','user','group-a',250),
      ('user-b','user','group-b',400);
    INSERT INTO ews_shopee_template_user_meta VALUES ('profile-a','user-a'),('profile-b','user-b');
  `);
  try {
    assert.equal(await deleteUserWithCreditRefund(env, 'user-b', 'manager-a', 'group-a'), false);
    assert.equal(await deleteUserWithCreditRefund(env, 'manager-a', 'manager-a', 'group-a'), false);
    assert.equal(database.prepare("SELECT credits FROM ews_users WHERE id='manager-a'").get().credits, 100);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM ews_shopee_template_user_meta WHERE user_id='user-b'").get().count, 1);
    assert.equal(await deleteUserWithCreditRefund(env, 'user-a', 'manager-a', 'group-a'), true);
    assert.equal(database.prepare("SELECT credits FROM ews_users WHERE id='manager-a'").get().credits, 350);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM ews_users WHERE id='user-a'").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM ews_shopee_template_user_meta WHERE user_id='user-a'").get().count, 0);
    assert.equal(await deleteUserWithCreditRefund(env, 'user-a', 'manager-a', 'group-a'), false);
    assert.equal(database.prepare("SELECT credits FROM ews_users WHERE id='manager-a'").get().credits, 350);
  } finally {
    database.close();
  }
});

test('template authorization supports multiple groups without cross-group removal', async () => {
  const { database, env } = createEnv(`
    CREATE TABLE ews_shopee_template_groups (
      profile_id TEXT NOT NULL, group_id TEXT NOT NULL,
      assigned_by TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
      PRIMARY KEY (profile_id, group_id)
    );
  `);
  try {
    await shopeeReplaceTemplateGroups(env, 'profile-1', ['group-a', 'group-b'], 'admin');
    assert.deepEqual(database.prepare('SELECT group_id FROM ews_shopee_template_groups WHERE profile_id=? ORDER BY group_id').all('profile-1').map(row => row.group_id), [
      'group-a',
      'group-b',
    ]);

    await shopeeReplaceGroupTemplates(env, 'group-a', ['profile-2'], 'admin');
    assert.deepEqual(database.prepare('SELECT profile_id,group_id FROM ews_shopee_template_groups ORDER BY group_id,profile_id').all().map(row => `${row.profile_id}:${row.group_id}`), [
      'profile-2:group-a',
      'profile-1:group-b',
    ]);
  } finally {
    database.close();
  }
});
