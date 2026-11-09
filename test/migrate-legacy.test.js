'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mock, test } = require('node:test');
const { parseArgs, planMigration, applyMigration, migrate, LEGACY_IDS } = require('../bin/migrate-legacy');

const username = 'AA:BB:CC:DD:EE:FF';
const oldPlugin = 'homebridge-escalade-onstar';
const newPlugin = 'homebridge-cadillac-onstar';
const childBridge = { username, port: 43210, pin: '123-45-678', name: 'Existing paired bridge',
  setupID: 'ABCD', env: { EXISTING_OPTION: 'keep-me' } };

function fixture(t, keys = ['start', 'stop', 'lock', 'unlock']) {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'cadillac-migration-test-'));
  t.after(() => fs.rmSync(storage, { recursive: true, force: true }));
  fs.mkdirSync(path.join(storage, 'accessories'));
  fs.mkdirSync(path.join(storage, 'persist'));
  fs.writeFileSync(path.join(storage, 'persist', 'pairing-sentinel.json'), 'private-pairing-must-stay');
  fs.writeFileSync(path.join(storage, 'credentials.json'), 'private-account-must-stay', { mode: 0o600 });
  const configPath = path.join(storage, 'config.json');
  const cachePath = path.join(storage, 'accessories', 'cachedAccessories.AABBCCDDEEFF');
  const config = {
    bridge: { username: '11:22:33:44:55:66' },
    platforms: [{ platform: 'Other', privateOption: 'unrelated-value' },
      { platform: 'EscaladeOnStar', name: 'Existing log label', credentialsFile: path.join(storage, 'credentials.json'),
        browserPath: path.join(storage, 'old-browser-cache'), _bridge: childBridge }],
    plugins: ['homebridge-other', oldPlugin],
  };
  const cache = [
    { UUID: 'unrelated-uuid', plugin: 'homebridge-other', platform: 'Other', context: { keep: true } },
    ...keys.map(key => ({ UUID: LEGACY_IDS[key], plugin: oldPlugin, platform: 'EscaladeOnStar',
      displayName: `Escalade ${key[0].toUpperCase()}${key.slice(1)}`, context: { kind: key },
      services: [{ UUID: 'synthetic-service', characteristics: [{ value: true }] }] })),
  ];
  const save = () => {
    fs.writeFileSync(configPath, JSON.stringify(config));
    fs.writeFileSync(cachePath, JSON.stringify(cache));
  };
  save();
  const args = ['--storage-dir', storage, '--child-bridge-username', username];
  return { storage, configPath, cachePath, config, cache, save, args,
    readConfig: () => JSON.parse(fs.readFileSync(configPath)),
    readCache: () => JSON.parse(fs.readFileSync(cachePath)) };
}

test('dry run validates scope without changing files, creating backups, or displaying private values', t => {
  const f = fixture(t);
  const before = [fs.readFileSync(f.configPath), fs.readFileSync(f.cachePath)];
  const summary = migrate(f.args);
  assert.match(summary, /^Dry run: 4/);
  assert.doesNotMatch(summary, /123-45-678|private-account|AABBCC|unrelated-value/);
  assert.deepEqual(fs.readFileSync(f.configPath), before[0]);
  assert.deepEqual(fs.readFileSync(f.cachePath), before[1]);
  assert.equal(fs.existsSync(path.join(f.storage, 'cadillac-onstar')), false);
});

test('apply preserves UUIDs, bridge identity, private files and unrelated entries with private byte-exact backups', t => {
  const f = fixture(t);
  const beforeConfig = fs.readFileSync(f.configPath);
  const beforeCache = fs.readFileSync(f.cachePath);
  assert.match(migrate([...f.args, '--apply']), /^Migrated 4/);
  const config = f.readConfig();
  const cache = f.readCache();
  assert.equal(config.platforms[1].platform, 'CadillacOnStar');
  assert.equal(config.platforms[1].accessoryUuidPrefix, oldPlugin);
  assert.equal(config.platforms[1].vehicleName, 'Escalade');
  assert.deepEqual(config.platforms[1]._bridge, childBridge);
  assert.equal(config.platforms[1].credentialsFile, f.config.platforms[1].credentialsFile);
  assert.equal(config.platforms[1].browserPath, f.config.platforms[1].browserPath);
  assert.deepEqual(config.plugins, ['homebridge-other', newPlugin]);
  assert.deepEqual(config.platforms[0], f.config.platforms[0]);
  assert.deepEqual(cache[0], f.cache[0]);
  cache.slice(1).forEach((entry, index) => {
    assert.deepEqual(entry, { ...f.cache[index + 1], plugin: newPlugin, platform: 'CadillacOnStar' });
  });
  assert.equal(fs.readFileSync(path.join(f.storage, 'credentials.json'), 'utf8'), 'private-account-must-stay');
  assert.equal(fs.readFileSync(path.join(f.storage, 'persist', 'pairing-sentinel.json'), 'utf8'), 'private-pairing-must-stay');
  const backups = path.join(f.storage, 'cadillac-onstar', 'migration-backups');
  const entries = fs.readdirSync(backups);
  assert.equal(entries.length, 1);
  const backup = path.join(backups, entries[0]);
  assert.deepEqual(fs.readFileSync(path.join(backup, 'config.json')), beforeConfig);
  assert.deepEqual(fs.readFileSync(path.join(backup, path.basename(f.cachePath))), beforeCache);
  for (const file of [f.configPath, f.cachePath, path.join(backup, 'config.json'), path.join(backup, path.basename(f.cachePath))]) {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  assert.equal(fs.statSync(backup).mode & 0o777, 0o700);
  assert.match(migrate([...f.args, '--apply']), /already complete/);
  assert.deepEqual(fs.readdirSync(backups), entries);
});

test('older two-accessory layout migrates both owners without deleting the Doors cache entry', t => {
  const f = fixture(t, ['start', 'doors']);
  delete f.config.platforms[1].browserPath;
  f.save();
  assert.match(migrate([...f.args, '--apply']), /^Migrated 2/);
  assert.deepEqual(f.readCache().slice(1).map(entry => entry.UUID), [LEGACY_IDS.start, LEGACY_IDS.doors]);
  assert.equal(f.readConfig().platforms[1].browserPath, path.join(f.storage, '.cache', 'browsers'));
});

test('scope mismatches fail closed before creating backups or replacing either input', async t => {
  const mutations = {
    wrongBridge: f => { f.config.platforms[1]._bridge = { username: '00:00:00:00:00:00' }; },
    unknownAccessory: f => { f.cache[1].UUID = 'unknown-owned-accessory'; },
    wrongOwner: f => { f.cache[1].plugin = 'homebridge-unrelated'; },
    duplicateUUID: f => { f.cache.push({ ...f.cache[1] }); },
    missingSwitch: f => { f.cache.pop(); },
    duplicatePlatform: f => { f.config.platforms.push({ ...f.config.platforms[1] }); },
    sharedBridge: f => { f.config.platforms[0]._bridge = { username }; },
    changedNamespace: f => { f.config.platforms[1].accessoryUuidPrefix = newPlugin; },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, t => {
    const f = fixture(t);
    mutate(f);
    f.save();
    const before = [fs.readFileSync(f.configPath), fs.readFileSync(f.cachePath)];
    assert.throws(() => migrate([...f.args, '--apply']), { code: 'SCOPE' });
    assert.deepEqual(fs.readFileSync(f.configPath), before[0]);
    assert.deepEqual(fs.readFileSync(f.cachePath), before[1]);
    assert.equal(fs.existsSync(path.join(f.storage, 'cadillac-onstar')), false);
  });
});

test('symlinked cache files are rejected without changing the target', t => {
  const f = fixture(t);
  const target = path.join(f.storage, 'cache-target');
  fs.renameSync(f.cachePath, target);
  const before = fs.readFileSync(target);
  fs.symlinkSync(target, f.cachePath);
  assert.throws(() => migrate([...f.args, '--apply']), { code: 'INPUT' });
  assert.deepEqual(fs.readFileSync(target), before);
});

test('an input changed after planning is never overwritten', t => {
  const f = fixture(t);
  const options = parseArgs(f.args);
  const plan = planMigration(options);
  fs.appendFileSync(f.configPath, '\n');
  assert.throws(() => applyMigration(plan, options), { code: 'CHANGED' });
  assert.equal(f.readConfig().platforms[1].platform, 'EscaladeOnStar');
  assert.equal(f.readCache()[1].plugin, oldPlugin);
});

test('rerunning completes an interruption between cache and config atomic replacements', t => {
  const f = fixture(t);
  const originalRename = fs.renameSync;
  const replacement = mock.method(fs, 'renameSync', (source, target) => {
    if (target === f.configPath) throw new Error('synthetic-private-filesystem-error');
    return originalRename(source, target);
  });
  assert.throws(() => migrate([...f.args, '--apply']), { code: 'APPLY' });
  replacement.mock.restore();
  assert.equal(f.readCache()[1].plugin, newPlugin);
  assert.equal(f.readConfig().platforms[1].platform, 'EscaladeOnStar');
  assert.match(migrate([...f.args, '--apply']), /^Migrated 4/);
  assert.equal(f.readConfig().platforms[1].platform, 'CadillacOnStar');
  assert.deepEqual(f.readConfig().platforms[1]._bridge, childBridge);
});

test('arguments require an explicit absolute storage directory and exact child identity', () => {
  for (const args of [[], ['--apply'], ['--storage-dir', 'relative', '--child-bridge-username', username],
    ['--storage-dir', '/synthetic', '--child-bridge-username', 'invalid'],
    ['--storage-dir', '/synthetic', '--child-bridge-username', username, '--apply', '--apply'],
    ['--storage-dir', '/synthetic', '--child-bridge-username', username, '--start']]) {
    assert.throws(() => parseArgs(args), { code: 'ARGUMENTS' });
  }
});
