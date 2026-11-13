'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cadillac-package-check-'));
try {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const output = execFileSync(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [packed] = JSON.parse(output);
  const artifact = path.join(temporary, packed.filename);
  const paths = packed.files.map((file) => file.path);
  const topLevel = new Set(['package.json', 'index.js', 'config.schema.json', 'README.md', 'LICENSE', 'CHANGELOG.md']);
  for (const name of paths) {
    assert.ok(topLevel.has(name) || /^(lib|bin)\/[a-z0-9-]+\.js$/.test(name)
      || /^docs\/[a-z0-9-]+\.md$/.test(name), `Unexpected package path: ${name}`);
  }
  for (const name of [...topLevel, 'lib/sdk.js', 'bin/setup.js', 'bin/manual-login.js', 'bin/check-connection.js', 'bin/install-browser.js', 'bin/migrate-legacy.js']) {
    assert.ok(paths.includes(name), `Missing package path: ${name}`);
  }
  const archivePaths = execFileSync('tar', ['-tzf', artifact], { encoding: 'utf8' })
    .trim().split('\n').filter((name) => !name.endsWith('/')).map((name) => name.replace(/^package\//, ''));
  assert.deepEqual(archivePaths.sort(), [...paths].sort());
  for (const name of paths) {
    const contents = execFileSync('tar', ['-xOf', artifact, `package/${name}`], { encoding: 'utf8' });
    for (const pattern of [
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
      /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/,
      /\bnpm_[A-Za-z0-9]{30,}\b/,
      /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
      /\/Users\/[A-Za-z0-9_.-]+\//,
    ]) assert.equal(pattern.test(contents), false, `Potential private data in ${name}`);
  }
  const metadata = JSON.parse(execFileSync('tar', ['-xOf', artifact, 'package/package.json'], { encoding: 'utf8' }));
  assert.equal(metadata.name, 'homebridge-cadillac-onstar');
  assert.equal(metadata.private, undefined);
  assert.equal(metadata.license, 'MIT');
  assert.equal(metadata.dependencies.onstarjs2, '2.16.7');
  assert.ok(metadata.keywords.includes('homebridge-plugin'));
  assert.ok(metadata.keywords.includes('supports-hap'));
  assert.deepEqual(metadata.bin, {
    'cadillac-onstar-setup': 'bin/setup.js',
    'cadillac-onstar-install-browser': 'bin/install-browser.js',
    'cadillac-onstar-login': 'bin/manual-login.js',
    'cadillac-onstar-check': 'bin/check-connection.js',
    'cadillac-onstar-migrate': 'bin/migrate-legacy.js',
    'cadillac-onstar-gmail': 'bin/gmail.js',
  });
  process.stdout.write(`Package inspected: ${paths.length} allowed files; no private state or credentials included.\n`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
