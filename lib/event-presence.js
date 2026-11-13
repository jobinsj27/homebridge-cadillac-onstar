'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const MAX_FILE_BYTES = 65536;
const MAX_EVENT_IDS = 256;
const PLACE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/;
const EVENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const failure = (code) => Object.assign(new Error({
  EVENT_INVALID: 'Invalid presence event.',
  EVENT_STALE: 'Presence event is older than the accepted state.',
  EVENT_STORE: 'Private presence state is unavailable.',
}[code]), { code });
const ownKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const digest = value => createHash('sha256').update(value).digest('hex');

function parseTimestamp(value) {
  if (typeof value !== 'string') throw failure('EVENT_INVALID');
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  const timestamp = Date.parse(value);
  if (!match || !Number.isSafeInteger(timestamp) || timestamp < 0
      || new Date(timestamp).toISOString() !== `${match[1]}.${(match[2] || '').padEnd(3, '0')}Z`) {
    throw failure('EVENT_INVALID');
  }
  return timestamp;
}

// This monitor consumes boundary events, not GPS observations. A parked car
// does not become unknown merely because no new boundary event has occurred.
class EventPresenceMonitor {
  constructor({ config, stateFile, onUpdate = () => {}, now = Date.now } = {}) {
    if (!config || !Array.isArray(config.locations) || config.locations.length < 1
        || config.locations.length > 20 || typeof stateFile !== 'string' || !path.isAbsolute(stateFile)
        || !Number.isInteger(config.maxEventAgeSeconds ?? 3600)
        || (config.maxEventAgeSeconds ?? 3600) < 1 || (config.maxEventAgeSeconds ?? 3600) > 86400) {
      throw failure('EVENT_INVALID');
    }
    const ids = config.locations.map(place => place?.id);
    if (ids.some(id => typeof id !== 'string' || !PLACE_ID.test(id)) || new Set(ids).size !== ids.length) {
      throw failure('EVENT_INVALID');
    }
    this.config = config;
    this.stateFile = stateFile;
    this.storageUid = process.getuid?.();
    this.checkedStorageUid = false;
    this.maxEventAgeSeconds = config.maxEventAgeSeconds ?? 3600;
    this.onUpdate = onUpdate;
    this.now = now;
    this.states = new Map(ids.map(id => [id, { id, present: null, available: false, observedAt: null }]));
    this.eventIds = [];
    this.fingerprint = null;
    this.running = false;
    this.closed = false;
    this.failed = false;
  }

  snapshot(state, changed = false, baseline = false) {
    return { id: state.id, present: state.present, available: state.available,
      changed, baseline, observedAt: state.observedAt };
  }

  getState(id) {
    const state = this.states.get(id);
    return state ? this.snapshot(state) : undefined;
  }

  notify(state, changed = false, baseline = false) {
    try {
      Promise.resolve(this.onUpdate(this.snapshot(state, changed, baseline))).catch(() => {});
    } catch { /* Consumers cannot invalidate an already persisted event. */ }
  }

  privateDirectory() {
    const directory = path.dirname(this.stateFile);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) {
      throw failure('EVENT_STORE');
    }
    // NFS can map the bridge UID to a different owner on this volume. An
    // exclusively created file tells us which UID the filesystem assigns us.
    if (!this.checkedStorageUid && this.storageUid !== undefined && stat.uid !== this.storageUid) {
      const probe = path.join(directory, '.owner-' + randomUUID());
      const fd = fs.openSync(probe, 'wx', 0o600);
      try { this.storageUid = fs.fstatSync(fd).uid; }
      finally { fs.closeSync(fd); fs.unlinkSync(probe); }
    }
    this.checkedStorageUid = true;
    if (!this.owned(stat)) throw failure('EVENT_STORE');
    return directory;
  }

  owned(stat) { return this.storageUid === undefined || stat.uid === this.storageUid; }

  readStore() {
    this.privateDirectory();
    let stat;
    try { stat = fs.lstatSync(this.stateFile); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600
        || !this.owned(stat) || stat.size > MAX_FILE_BYTES) throw failure('EVENT_STORE');
    const fd = fs.openSync(this.stateFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let bytes;
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev
          || (opened.mode & 0o777) !== 0o600 || !this.owned(opened) || opened.size > MAX_FILE_BYTES) {
        throw failure('EVENT_STORE');
      }
      // Keep the allocation bounded even if another process grows the file.
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = fs.readSync(fd, buffer, length, buffer.length - length, null);
        if (read === 0) break;
        length += read;
      }
      if (length > MAX_FILE_BYTES) throw failure('EVENT_STORE');
      bytes = buffer.subarray(0, length);
    } finally { fs.closeSync(fd); }
    const value = JSON.parse(bytes.toString('utf8'));
    if (!ownKeys(value, ['version', 'states', 'eventIds']) || value.version !== 1
        || !Array.isArray(value.states) || value.states.length > 20
        || !Array.isArray(value.eventIds) || value.eventIds.length > MAX_EVENT_IDS
        || value.eventIds.some(id => typeof id !== 'string' || !EVENT_ID.test(id))
        || new Set(value.eventIds).size !== value.eventIds.length) throw failure('EVENT_STORE');
    const places = new Set();
    for (const state of value.states) {
      if (!ownKeys(state, ['id', 'present', 'observedAt']) || typeof state.id !== 'string'
          || !PLACE_ID.test(state.id) || places.has(state.id) || typeof state.present !== 'boolean'
          || !Number.isSafeInteger(state.observedAt) || state.observedAt < 0
          || state.observedAt > this.now() + 30000) throw failure('EVENT_STORE');
      places.add(state.id);
    }
    return { value, fingerprint: digest(bytes) };
  }

  failStore() {
    this.failed = true;
    this.running = false;
    for (const state of this.states.values()) {
      const available = state.available;
      state.available = false;
      if (available) this.notify(state);
    }
    return failure('EVENT_STORE');
  }

  start() {
    if (this.closed || this.running || this.config.enabled !== true) return;
    if (this.failed) throw failure('EVENT_STORE');
    try {
      const stored = this.readStore();
      if (stored) {
        this.eventIds = stored.value.eventIds;
        this.fingerprint = stored.fingerprint;
        for (const saved of stored.value.states) {
          const state = this.states.get(saved.id);
          if (state) Object.assign(state, saved, { available: true });
        }
      }
      this.running = true;
      for (const state of this.states.values()) if (state.available) this.notify(state, false, true);
    } catch { throw this.failStore(); }
  }

  writeStore(states, eventIds) {
    const unchanged = () => {
      const current = this.readStore();
      if ((current?.fingerprint ?? null) !== this.fingerprint) throw failure('EVENT_STORE');
    };
    unchanged();
    const bytes = Buffer.from(JSON.stringify({ version: 1,
      states: [...states.values()].filter(state => typeof state.present === 'boolean')
        .map(({ id, present, observedAt }) => ({ id, present, observedAt })), eventIds }) + '\n');
    if (bytes.length > MAX_FILE_BYTES) throw failure('EVENT_STORE');
    const temporary = `${this.stateFile}.${randomUUID()}.tmp`;
    let created = false;
    try {
      const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT
        | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      created = true;
      try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      unchanged();
      fs.renameSync(temporary, this.stateFile);
      created = false;
      const directoryFd = fs.openSync(path.dirname(this.stateFile), fs.constants.O_RDONLY);
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      this.fingerprint = digest(bytes);
    } finally {
      if (created) {
        try { fs.unlinkSync(temporary); } catch { /* Do not obscure the safe storage error. */ }
      }
    }
  }

  accept(event) {
    if (this.failed) throw failure('EVENT_STORE');
    if (!this.running || this.closed || !ownKeys(event, ['eventId', 'locationId', 'event', 'occurredAt'])
        || typeof event.eventId !== 'string' || !EVENT_ID.test(event.eventId)
        || typeof event.locationId !== 'string' || !this.states.has(event.locationId)
        || !['arrived', 'departed'].includes(event.event)) throw failure('EVENT_INVALID');
    const observedAt = parseTimestamp(event.occurredAt);
    // A retry remains harmless after its timestamp ages out. Changed payloads
    // under the same ID are also ignored rather than becoming new crossings.
    if (this.eventIds.includes(event.eventId)) return { accepted: false, duplicate: true };
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0 || observedAt > now + 30000) throw failure('EVENT_INVALID');
    const previous = this.states.get(event.locationId);
    if (now - observedAt > this.maxEventAgeSeconds * 1000
        || (previous.observedAt !== null && observedAt <= previous.observedAt)) throw failure('EVENT_STALE');
    const present = event.event === 'arrived';
    const baseline = previous.present === null;
    const changed = !baseline && previous.present !== present;
    const state = { id: previous.id, present, available: true, observedAt };
    const next = new Map(this.states);
    next.set(state.id, state);
    const eventIds = [...this.eventIds, event.eventId].slice(-MAX_EVENT_IDS);
    try { this.writeStore(next, eventIds); }
    catch { throw this.failStore(); }
    this.states = next;
    this.eventIds = eventIds;
    this.notify(state, changed, baseline);
    return { accepted: true, duplicate: false };
  }

  shutdown() {
    this.closed = true;
    this.running = false;
    for (const state of this.states.values()) state.available = false;
  }
}

module.exports = { EventPresenceMonitor };
