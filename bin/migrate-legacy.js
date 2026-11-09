#!/usr/bin/env node
'use strict';

// Offline config/cache migration only. No Homebridge, SDK, or network imports.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const OLD_PLUGIN = 'homebridge-escalade-onstar';
const OLD_PLATFORM = 'EscaladeOnStar';
const NEW_PLUGIN = 'homebridge-cadillac-onstar';
const NEW_PLATFORM = 'CadillacOnStar';
// Original HAP UUIDs generated from `${OLD_PLUGIN}:${key}`. Never recompute
// these from display names, account details, or a new package namespace.
const LEGACY_IDS = Object.freeze({
  start: 'e8da5629-cdfc-4384-a19c-cd263a4a1ae5',
  stop: 'e60ec22b-0f62-4763-a857-0c617b7982f5',
  lock: 'ece7f52f-9a99-41ea-b313-db744dbac7a5',
  unlock: 'c2ed39c6-0a80-414d-b764-b69f7a513191',
  doors: '625ae974-c583-47e4-a31a-b19184fa066a',
});
const MESSAGES = Object.freeze({
  ARGUMENTS: 'Use --storage-dir <absolute-directory> --child-bridge-username <MAC> [--apply]. Stop Homebridge before applying.',
  INPUT: 'Cannot read the expected regular config/cache files. Check the storage directory and stopped child bridge selection.',
  SCOPE: 'Migration scope could not be confirmed. Expected one legacy child bridge and its known cached accessories; nothing was changed.',
  CHANGED: 'Config or cache changed during migration. Keep Homebridge stopped and review the files before retrying.',
  APPLY: 'Migration could not finish. Keep Homebridge stopped and review private migration backups before retrying.',
});
const fail = code => Object.assign(new Error(MESSAGES[code]), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function parseArgs(args) {
  const options = { apply: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (seen.has(option)) throw fail('ARGUMENTS');
    seen.add(option);
    if (option === '--apply') options.apply = true;
    else if (option === '--storage-dir' || option === '--child-bridge-username') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw fail('ARGUMENTS');
      options[option === '--storage-dir' ? 'storageDir' : 'username'] = value;
    } else throw fail('ARGUMENTS');
  }
  if (typeof options.storageDir !== 'string' || !path.isAbsolute(options.storageDir)
    || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(options.username || '')) throw fail('ARGUMENTS');
  options.storageDir = path.resolve(options.storageDir);
  options.username = options.username.toUpperCase();
  return options;
}

function regularFile(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile()) throw fail('INPUT');
  return fs.readFileSync(filename);
}

function directory(filename) {
  if (!fs.lstatSync(filename).isDirectory()) throw fail('INPUT');
}

function alias(value) {
  return [OLD_PLATFORM, `${OLD_PLUGIN}.${OLD_PLATFORM}`, NEW_PLATFORM, `${NEW_PLUGIN}.${NEW_PLATFORM}`].includes(value);
}

function planMigration(options) {
  let configPath, cachePath, configBytes, cacheBytes, config, cache;
  try {
    directory(options.storageDir);
    directory(path.join(options.storageDir, 'accessories'));
    configPath = path.join(options.storageDir, 'config.json');
    cachePath = path.join(options.storageDir, 'accessories', `cachedAccessories.${options.username.replaceAll(':', '')}`);
    configBytes = regularFile(configPath);
    cacheBytes = regularFile(cachePath);
    config = JSON.parse(configBytes);
    cache = JSON.parse(cacheBytes);
  } catch { throw fail('INPUT'); }
  if (!object(config) || !Array.isArray(config.platforms) || !Array.isArray(cache)
    || !config.platforms.every(object) || !cache.every(object)) throw fail('SCOPE');
  const candidates = config.platforms.filter(entry => alias(entry.platform));
  const platform = candidates[0];
  if (candidates.length !== 1 || typeof platform?._bridge?.username !== 'string'
    || platform._bridge.username.toUpperCase() !== options.username
    || typeof platform.credentialsFile !== 'string' || !path.isAbsolute(platform.credentialsFile)
    || (platform.browserPath !== undefined && (typeof platform.browserPath !== 'string' || !path.isAbsolute(platform.browserPath)))
    || (platform.accessoryUuidPrefix !== undefined && platform.accessoryUuidPrefix !== OLD_PLUGIN)) throw fail('SCOPE');
  const bridges = [...config.platforms, ...(Array.isArray(config.accessories) ? config.accessories : [])]
    .filter(entry => typeof entry?._bridge?.username === 'string' && entry._bridge.username.toUpperCase() === options.username);
  if (bridges.length !== 1 || (typeof config.bridge?.username === 'string'
    && config.bridge.username.toUpperCase() === options.username)) throw fail('SCOPE');

  const knownIds = new Map(Object.entries(LEGACY_IDS).map(([key, id]) => [id, key]));
  const found = new Set();
  const seenIds = new Set();
  let migratedAccessories = 0;
  for (const entry of cache) {
    if (typeof entry.UUID !== 'string' || seenIds.has(entry.UUID.toLowerCase())) throw fail('SCOPE');
    seenIds.add(entry.UUID.toLowerCase());
    const key = knownIds.get(entry.UUID.toLowerCase());
    const oldOwner = entry.plugin === OLD_PLUGIN && entry.platform === OLD_PLATFORM;
    const newOwner = entry.plugin === NEW_PLUGIN && entry.platform === NEW_PLATFORM;
    const related = [OLD_PLUGIN, NEW_PLUGIN].includes(entry.plugin) || [OLD_PLATFORM, NEW_PLATFORM].includes(entry.platform);
    if ((related && (!key || (!oldOwner && !newOwner))) || (key && !related)) throw fail('SCOPE');
    if (key) {
      found.add(key);
      if (oldOwner) migratedAccessories++;
      entry.plugin = NEW_PLUGIN;
      entry.platform = NEW_PLATFORM;
    }
  }
  const layout = [...found].sort().join(',');
  if (!['doors,start', 'lock,start,stop,unlock', 'doors,lock,start,stop,unlock'].includes(layout)) throw fail('SCOPE');

  platform.platform = NEW_PLATFORM;
  platform.accessoryUuidPrefix = OLD_PLUGIN;
  if (!platform.vehicleName) {
    const startName = cache.find(entry => entry.UUID.toLowerCase() === LEGACY_IDS.start)?.displayName;
    platform.vehicleName = typeof startName === 'string' && startName.endsWith(' Start')
      ? startName.slice(0, -6) : 'Escalade';
  }
  // Preserve the legacy fallback when the original config omitted an override.
  platform.browserPath ??= path.join(path.dirname(platform.credentialsFile), '.cache', 'browsers');
  for (const key of ['plugins', 'disabledPlugins']) {
    if (config[key] === undefined) continue;
    if (!Array.isArray(config[key]) || !config[key].every(value => typeof value === 'string')) throw fail('SCOPE');
    config[key] = config[key].map(value => value === OLD_PLUGIN ? NEW_PLUGIN : value)
      .filter((value, index, values) => value !== NEW_PLUGIN || values.indexOf(value) === index);
  }
  const configNext = Buffer.from(JSON.stringify(config, null, 2) + '\n');
  const cacheNext = Buffer.from(JSON.stringify(cache, null, 2) + '\n');
  const changed = JSON.stringify(JSON.parse(configBytes)) !== JSON.stringify(config)
    || JSON.stringify(JSON.parse(cacheBytes)) !== JSON.stringify(cache);
  return { configPath, cachePath, configBytes, cacheBytes, configNext, cacheNext,
    changed, matchedAccessories: found.size, migratedAccessories };
}

function privateDirectory(parent, name) {
  const filename = path.join(parent, name);
  if (!fs.existsSync(filename)) fs.mkdirSync(filename, { mode: 0o700 });
  directory(filename);
  fs.chmodSync(filename, 0o700);
  return filename;
}

function writePrivate(filename, contents) {
  const fd = fs.openSync(filename, 'wx', 0o600);
  try { fs.writeFileSync(fd, contents); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

function assertUnchanged(plan) {
  if (!regularFile(plan.configPath).equals(plan.configBytes)
    || !regularFile(plan.cachePath).equals(plan.cacheBytes)) throw fail('CHANGED');
}

function applyMigration(plan, options) {
  if (!plan.changed) return;
  let configTemp, cacheTemp;
  try {
    assertUnchanged(plan);
    const base = privateDirectory(options.storageDir, 'cadillac-onstar');
    const backups = privateDirectory(base, 'migration-backups');
    const backup = privateDirectory(backups, `${Date.now()}-${randomUUID()}`);
    writePrivate(path.join(backup, 'config.json'), plan.configBytes);
    writePrivate(path.join(backup, path.basename(plan.cachePath)), plan.cacheBytes);
    const suffix = `.cadillac-migration-${randomUUID()}.tmp`;
    configTemp = plan.configPath + suffix;
    cacheTemp = plan.cachePath + suffix;
    writePrivate(configTemp, plan.configNext);
    writePrivate(cacheTemp, plan.cacheNext);
    assertUnchanged(plan);
    // Each file is replaced atomically. Keep Homebridge stopped throughout;
    // after an interrupted pair of renames, rerunning completes the migration.
    fs.renameSync(cacheTemp, plan.cachePath);
    cacheTemp = undefined;
    fs.renameSync(configTemp, plan.configPath);
    configTemp = undefined;
  } catch (error) {
    throw fail(error?.code === 'CHANGED' ? 'CHANGED' : 'APPLY');
  } finally {
    for (const filename of [configTemp, cacheTemp]) {
      if (filename) { try { fs.unlinkSync(filename); } catch { /* Keep the original failure sanitized. */ } }
    }
  }
}

function migrate(args) {
  const options = parseArgs(args);
  const plan = planMigration(options);
  if (options.apply) applyMigration(plan, options);
  if (!plan.changed) return 'Migration already complete; no files changed.';
  return options.apply
    ? `Migrated ${plan.matchedAccessories} known accessories. Private config/cache backups saved under cadillac-onstar/migration-backups. Keep Homebridge stopped until package replacement is complete.`
    : `Dry run: ${plan.matchedAccessories} known accessories matched. Config and cache ownership would change; UUIDs, bridge identity, credentials and pairing files stay unchanged. Stop Homebridge, back up storage, then rerun with --apply.`;
}

if (require.main === module) {
  try { process.stdout.write(migrate(process.argv.slice(2)) + '\n'); }
  catch (error) {
    process.stderr.write((MESSAGES[error?.code] || MESSAGES.INPUT) + '\n');
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, planMigration, applyMigration, migrate, LEGACY_IDS };
