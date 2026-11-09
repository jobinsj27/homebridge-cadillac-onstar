'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { setup } = require('../bin/setup');
const { installBrowser } = require('../bin/install-browser');
const { privateDirectory, readPrivateJSON, writePrivateJSON } = require('../bin/private-files');

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cadillac-cli-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('setup creates only private template state and never overwrites existing credentials', (t) => {
  const directory = path.join(temporary(t), 'state');
  const result = setup(['--state-dir', directory], { env: {} });
  const credentials = readPrivateJSON(result.credentialsFile);
  assert.equal(credentials.authMode, 'savedSession');
  assert.equal(credentials.username, '');
  assert.equal(credentials.password, '');
  assert.equal(credentials.vin, '');
  assert.match(credentials.deviceId, /^[0-9a-f-]{14}4[0-9a-f-]{21}$/);
  assert.equal(credentials.tokenLocation, path.join(directory, 'tokens'));
  assert.equal(fs.statSync(result.credentialsFile).mode & 0o777, 0o600);
  for (const dirname of [directory, credentials.tokenLocation, result.browserPath]) {
    assert.equal(fs.statSync(dirname).mode & 0o777, 0o700);
  }
  const before = fs.readFileSync(result.credentialsFile, 'utf8');
  assert.throws(() => setup(['--state-dir', directory], { env: {} }), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(result.credentialsFile, 'utf8'), before);
});

test('private readers and writers reject permissive files and symlink destinations', (t) => {
  const directory = temporary(t);
  const file = path.join(directory, 'state.json');
  writePrivateJSON(file, { placeholder: true });
  fs.chmodSync(file, 0o644);
  assert.throws(() => readPrivateJSON(file));
  assert.throws(() => writePrivateJSON(file, { replaced: true }));
  fs.chmodSync(file, 0o600);
  const link = path.join(directory, 'link.json');
  fs.symlinkSync(file, link);
  assert.throws(() => readPrivateJSON(link));
  assert.throws(() => writePrivateJSON(link, { replaced: true }));
  assert.deepEqual(readPrivateJSON(file), { placeholder: true });
  const directoryLink = path.join(directory, 'linked-state');
  fs.symlinkSync(directory, directoryLink);
  assert.throws(() => privateDirectory(directoryLink));
  const publicDir = path.join(directory, 'public-state');
  fs.mkdirSync(publicDir, { mode: 0o755 });
  assert.throws(() => setup(['--state-dir', publicDir], { env: {} }));
  assert.equal(fs.existsSync(path.join(publicDir, 'credentials.json')), false);
});

test('private state updates are atomic and leave no temporary files', (t) => {
  const directory = temporary(t);
  const file = path.join(directory, 'state.json');
  writePrivateJSON(file, { phase: 'initial' });
  writePrivateJSON(file, { phase: 'complete' });
  assert.deepEqual(readPrivateJSON(file), { phase: 'complete' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(directory), ['state.json']);
});

test('browser installation uses the selected private path and never reads credentials', (t) => {
  const directory = path.join(temporary(t), 'state');
  let invocation;
  installBrowser(['--state-dir', directory], { context: { env: {} },
    resolveCLI: () => '/example/pinned-patchright/cli.js',
    spawn: (...args) => { invocation = args; return { status: 0 }; },
  });
  assert.deepEqual(invocation[1], ['/example/pinned-patchright/cli.js', 'install', 'chromium']);
  assert.equal(invocation[2].env.PLAYWRIGHT_BROWSERS_PATH, path.join(directory, '.cache', 'browsers'));
  assert.equal(fs.existsSync(path.join(directory, 'credentials.json')), false);
});

test('setup and browser help perform no setup or process execution', () => {
  assert.deepEqual(setup(['--help']), { help: true });
  assert.deepEqual(installBrowser(['--help'], {
    resolveCLI: () => { throw new Error('must not resolve'); }, spawn: () => { throw new Error('must not spawn'); },
  }), { help: true });
});
