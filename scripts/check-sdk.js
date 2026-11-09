'use strict';

// Exercise the real pinned SDK's guarded loader using synthetic configuration.
// No account authentication or vehicle method is called.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let blockedCalls = 0;
function forbidden() {
  blockedCalls += 1;
  throw Object.assign(new Error('OFFLINE_CHECK_NETWORK_OR_PROCESS'), { code: 'OFFLINE_CHECK_NETWORK_OR_PROCESS' });
}
for (const name of ['node:http', 'node:https']) {
  const transport = require(name);
  transport.request = forbidden;
  transport.get = forbidden;
}
const net = require('node:net');
net.connect = net.createConnection = net.Socket.prototype.connect = forbidden;
require('node:tls').connect = forbidden;
globalThis.fetch = forbidden;
const processes = require('node:child_process');
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  processes[method] = forbidden;
}
require('node:worker_threads').Worker = class {
  constructor() { forbidden(); }
};

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cadillac-sdk-smoke-'));
  fs.chmodSync(directory, 0o700);
  try {
    const { createClient } = require('../lib/sdk');
    const client = createClient({
      authMode: 'savedSession',
      vin: '1GYS4RKL0PR123456',
      username: 'offline-smoke@example.invalid',
      deviceId: '8e934cd0-8093-4bee-9ac4-5034e02f7548',
      tokenLocation: directory,
    });
    for (const method of ['start', 'cancelStart', 'lockDoor', 'unlockDoor', 'getVehicleDetails']) {
      assert.equal(typeof client[method], 'function');
    }
    assert.deepEqual(fs.readdirSync(directory), []);
    const browserCLI = require('../bin/install-browser').resolveBrowserCLI();
    assert.equal(path.basename(browserCLI), 'cli.js');
    assert.equal(fs.statSync(browserCLI).isFile(), true);
    // Homebridge 2 loads plugins with dynamic import, including CJS defaults.
    const plugin = await import(pathToFileURL(path.join(__dirname, '../index.js')).href);
    assert.equal(typeof plugin.default, 'function');
    let registered = false;
    plugin.default({ registerPlatform(name, platform, constructor) {
      assert.equal(name, 'homebridge-cadillac-onstar');
      assert.equal(typeof platform, 'string');
      assert.equal(typeof constructor, 'function');
      registered = true;
    } });
    assert.equal(registered, true);
    assert.equal(blockedCalls, 0);
    process.stdout.write('Pinned SDK and plugin initializer loaded offline; no authentication or vehicle commands.\n');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  const code = ['SDK_UNSUPPORTED', 'CREDENTIALS', 'OFFLINE_CHECK_NETWORK_OR_PROCESS'].includes(error?.code)
    ? error.code : 'OFFLINE_SMOKE_FAILED';
  process.stderr.write(`Offline SDK check failed: ${code}.\n`);
  process.exitCode = 1;
});
