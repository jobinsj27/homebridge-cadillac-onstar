'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { pageMetadata } = require('../bin/manual-login');

test('CLI help and invalid arguments work without credential access or SDK loading', () => {
  for (const name of ['manual-login', 'setup', 'install-browser', 'check-connection']) {
    const script = path.join(__dirname, '..', 'bin', `${name}.js`);
    const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0, name);
    assert.match(help.stdout, /Usage:/);
    const invalid = spawnSync(process.execPath, [script, '--password', 'private-sentinel-value'], { encoding: 'utf8' });
    assert.equal(invalid.status, 1, name);
    assert.equal((invalid.stdout + invalid.stderr).includes('private-sentinel-value'), false);
  }
});

test('page metadata excludes input values and document body text', async () => {
  const original = global.document;
  const input = { id: 'verificationCode', name: 'code', type: 'text', value: 'private-sentinel-value', offsetWidth: 10 };
  try {
    global.document = { title: 'GM sign-in', body: { innerText: 'Private account information' },
      querySelectorAll: selector => selector === 'input' ? [input] : [],
    };
    const snapshot = await pageMetadata({ evaluate: callback => callback() });
    assert.deepEqual(snapshot.inputs, [{ id: 'verificationCode', name: 'code', type: 'text' }]);
    assert.equal(JSON.stringify(snapshot).includes('private-sentinel-value'), false);
    assert.equal(JSON.stringify(snapshot).includes('Private account information'), false);
  } finally {
    if (original === undefined) delete global.document;
    else global.document = original;
  }
});
