'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { loadCredentials } = require('../lib/credentials');

function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onstar-credentials-test-'));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'credentials.json');
  const config = {
    authMode: 'savedSession',
    vin: '1GYS4RKL0PR123456',
    username: 'synthetic@example.test',
    deviceId: '8e934cd0-8093-4bee-9ac4-5034e02f7548',
    tokenLocation: path.join(dir, 'tokens'),
    ...overrides,
  };
  fs.writeFileSync(filename, JSON.stringify(config), { mode: 0o600 });
  return { filename, config, dir };
}

test('saved sessions require identity and token location without PIN, password, or TOTP', (t) => {
  const { filename, config } = fixture(t);
  const loaded = loadCredentials(filename);
  assert.equal(loaded.authMode, 'savedSession');
  for (const key of ['vin', 'username', 'deviceId', 'tokenLocation']) {
    assert.equal(loaded[key], config[key]);
  }
  for (const key of ['onStarPin', 'password', 'onStarTOTP']) {
    assert.equal(Object.hasOwn(loaded, key), false);
  }
  assert.equal(loaded.checkRequestStatus, true);
  assert.equal(loaded.retryOn429ForPost, false);
  assert.equal(fs.statSync(config.tokenLocation).mode & 0o077, 0);
});

test('saved-session mode discards supplied login secrets and does not pass them to the SDK', (t) => {
  const { filename } = fixture(t, {
    password: 'secret-password', onStarTOTP: 'secret-totp', onStarPin: 'secret-pin',
  });
  const loaded = loadCredentials(filename);
  for (const key of ['password', 'onStarTOTP', 'onStarPin']) {
    assert.equal(Object.hasOwn(loaded, key), false);
  }
  assert.equal(JSON.stringify(loaded).includes('secret-'), false);
});

test('omitting authentication mode defaults to saved-session mode', (t) => {
  const { filename } = fixture(t, { authMode: undefined });
  assert.equal(loadCredentials(filename).authMode, 'savedSession');
});

test('saved-session identity and token-path omissions fail closed', async (t) => {
  for (const key of ['vin', 'username', 'deviceId', 'tokenLocation']) {
    await t.test(key, (child) => {
      const { filename } = fixture(child, { [key]: undefined });
      assert.throws(() => loadCredentials(filename), { code: 'CREDENTIALS' });
    });
  }
});

test('unknown authentication modes and malformed identity fields fail closed', async (t) => {
  for (const overrides of [
    { authMode: 'unsupported' },
    { vin: 'not-a-vin' },
    { deviceId: 'not-a-device-id' },
    { tokenLocation: 'relative/tokens' },
  ]) {
    await t.test(JSON.stringify(overrides), (child) => {
      const { filename } = fixture(child, overrides);
      assert.throws(() => loadCredentials(filename), { code: 'CREDENTIALS' });
    });
  }
});

test('publicly readable credential or token locations are rejected without exposing their contents', (t) => {
  const { filename, config } = fixture(t, { password: 'secret-password' });
  fs.chmodSync(filename, 0o644);
  assert.throws(() => loadCredentials(filename), (error) => {
    assert.equal(error.code, 'CREDENTIALS');
    assert.equal(`${error}\n${error.stack}\n${JSON.stringify(error)}`.includes('secret-password'), false);
    return true;
  });
  fs.chmodSync(filename, 0o600);
  fs.mkdirSync(config.tokenLocation, { mode: 0o755 });
  fs.chmodSync(config.tokenLocation, 0o755);
  assert.throws(() => loadCredentials(filename), { code: 'CREDENTIALS' });
});
