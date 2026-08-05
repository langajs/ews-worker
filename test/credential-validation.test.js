import assert from 'node:assert/strict';
import test from 'node:test';

import { isValidNewPassword, isValidNewUsername } from '../src/credential-validation.js';

test('new usernames accept only one to sixteen ASCII letters or digits', () => {
  for (const value of ['a', '123456', 'User2026', 'Ab12Cd34Ef56Gh78']) {
    assert.equal(isValidNewUsername(value), true, value);
  }
  for (const value of ['', 'Ab12Cd34Ef56Gh789', '中文用户', 'user-name', 'user_name', 'user name', 'user@name', 123]) {
    assert.equal(isValidNewUsername(value), false, String(value));
  }
});

test('new passwords accept the safe character allowlist from six to thirty-two characters', () => {
  for (const value of ['abc123', 'ABCdef', '123456', 'A1._@-', 'user-2026@test.com', 'A'.repeat(32)]) {
    assert.equal(isValidNewPassword(value), true, value);
  }
  for (const value of ['', 'abc12', 'A'.repeat(33), '密码abc123', 'abc 123', 'abc/123', 'abc\\123', 'abc"123', "abc'123", 123456]) {
    assert.equal(isValidNewPassword(value), false, String(value));
  }
});
