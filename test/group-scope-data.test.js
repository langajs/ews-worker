import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  getTaskCount,
  getTaskList,
  shopeeReplaceGroupTemplates,
  shopeeReplaceTemplateGroups,
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
