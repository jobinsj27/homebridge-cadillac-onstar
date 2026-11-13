'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { EventPresenceMonitor } = require('../lib/event-presence');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cadillac-events-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'private', 'presence.json');
  const config = { enabled: true, source: 'events', locations: [{ id: 'home', name: 'Home' },
    { id: 'work', name: 'Work' }], maxEventAgeSeconds: 3600, ...options };
  const updates = [];
  let time = Date.UTC(2026, 0, 1);
  const now = () => time;
  const monitor = new EventPresenceMonitor({ config, stateFile, now, onUpdate: event => updates.push(event) });
  return { root, stateFile, config, monitor, updates, now,
    advance: milliseconds => { time += milliseconds; },
    event: (overrides = {}) => ({ eventId: 'message-1', locationId: 'home', event: 'arrived',
      occurredAt: new Date(time).toISOString(), ...overrides }),
    restore: (onUpdate = event => updates.push(event)) => new EventPresenceMonitor({ config, stateFile, now, onUpdate }) };
}

const code = expected => error => {
  assert.equal(error.code, expected);
  assert.ok(['Invalid presence event.', 'Presence event is older than the accepted state.',
    'Private presence state is unavailable.'].includes(error.message));
  return true;
};

test('event presence begins unknown and retains a confirmed event without polling or GPS expiry', t => {
  const f = fixture(t);
  f.monitor.start();
  f.monitor.start();
  assert.deepEqual(f.monitor.getState('home'), { id: 'home', present: null, available: false,
    changed: false, baseline: false, observedAt: null });
  assert.equal(f.monitor.getState('missing'), undefined);
  f.advance(10 * 60 * 1000);
  assert.equal(f.monitor.getState('home').available, false);
  assert.deepEqual(f.monitor.accept(f.event()), { accepted: true, duplicate: false });
  const observation = f.monitor.getState('home').observedAt;
  f.advance(366 * 86400 * 1000);
  assert.equal(f.monitor.getState('home').available, true);
  assert.equal(f.monitor.getState('home').present, true);
  assert.equal(f.monitor.getState('home').observedAt, observation);
  assert.equal(f.updates.length, 1);
  assert.equal(Object.hasOwn(f.monitor, 'pollTimer'), false);
  assert.equal(Object.hasOwn(f.monitor, 'expiryTimer'), false);
});

test('first events establish silent baselines and only subsequent crossings are transitions', t => {
  const f = fixture(t);
  f.monitor.start();
  f.monitor.accept(f.event());
  assert.equal(f.updates[0].baseline, true);
  assert.equal(f.updates[0].changed, false);
  f.advance(1000);
  f.monitor.accept(f.event({ eventId: 'message-2' }));
  assert.equal(f.updates[1].baseline, false);
  assert.equal(f.updates[1].changed, false);
  f.advance(1000);
  f.monitor.accept(f.event({ eventId: 'message-3', event: 'departed' }));
  assert.equal(f.updates[2].present, false);
  assert.equal(f.updates[2].changed, true);
  f.monitor.accept(f.event({ eventId: 'message-4', locationId: 'work', event: 'departed' }));
  assert.equal(f.updates[3].present, false);
  assert.equal(f.updates[3].baseline, true);
  assert.equal(f.updates[3].changed, false);
  f.advance(1000);
  f.monitor.accept(f.event({ eventId: 'message-5' }));
  assert.equal(f.updates[4].changed, true);
  assert.equal(f.updates[4].present, true);
});

test('state is stored privately before publishing and restored silently across restarts', t => {
  const f = fixture(t);
  const events = [];
  const monitor = f.restore(event => {
    const stored = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
    assert.equal(stored.states.find(state => state.id === event.id).present, event.present);
    events.push(event);
  });
  monitor.start();
  monitor.accept(f.event());
  assert.equal(fs.statSync(path.dirname(f.stateFile)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(f.stateFile).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(f.stateFile))), ['version', 'states', 'eventIds']);
  monitor.shutdown();
  assert.equal(monitor.getState('home').available, false);
  f.advance(7 * 86400 * 1000);
  const restored = f.restore();
  restored.start();
  assert.equal(restored.getState('home').present, true);
  assert.equal(restored.getState('home').available, true);
  assert.equal(restored.getState('work').available, false);
  assert.equal(f.updates.length, 1);
  assert.equal(f.updates[0].baseline, true);
  assert.equal(f.updates[0].changed, false);
  assert.equal(events.length, 1);
});

test('duplicate IDs cannot change state even with changed payloads, age or a restart', t => {
  const f = fixture(t);
  f.monitor.start();
  const original = f.event();
  f.monitor.accept(original);
  f.advance(1000);
  assert.deepEqual(f.monitor.accept(f.event({ event: 'departed' })), { accepted: false, duplicate: true });
  assert.deepEqual(f.monitor.accept(f.event({ locationId: 'work' })), { accepted: false, duplicate: true });
  assert.equal(f.monitor.getState('home').present, true);
  assert.equal(f.monitor.getState('work').available, false);
  assert.equal(f.updates.length, 1);
  f.monitor.shutdown();
  const restored = f.restore();
  restored.start();
  f.advance(7200000);
  assert.deepEqual(restored.accept(original), { accepted: false, duplicate: true });
  assert.equal(restored.getState('home').present, true);
});

test('strict events reject malformed dates, unknown locations, fields, IDs and future timestamps', t => {
  const f = fixture(t);
  f.monitor.start();
  const invalid = [null, [], {}, f.event({ eventId: '' }), f.event({ eventId: 'secret value / test' }),
    f.event({ eventId: 'a'.repeat(129) }), f.event({ locationId: 'missing' }),
    f.event({ event: 'arrive' }), f.event({ coordinates: 'private' }), f.event({ occurredAt: 123 }),
    f.event({ occurredAt: '2026-02-30T12:00:00.000Z' }), f.event({ occurredAt: '2026-13-01T00:00:00Z' }),
    f.event({ occurredAt: '2026-01-01' }), f.event({ occurredAt: '2026-01-01T00:00:30.001Z' })];
  for (const event of invalid) assert.throws(() => f.monitor.accept(event), code('EVENT_INVALID'));
  assert.equal(fs.existsSync(f.stateFile), false);
  assert.equal(f.monitor.getState('home').available, false);
  f.monitor.accept(f.event({ occurredAt: '2026-01-01T00:00:00Z' }));
  f.advance(1000);
  f.monitor.accept(f.event({ eventId: 'message-2', occurredAt: '2026-01-01T00:00:01.0Z' }));
  assert.equal(f.monitor.getState('home').observedAt, f.now());
});

test('expired and reordered events never overwrite newer state', t => {
  const f = fixture(t);
  f.monitor.start();
  assert.throws(() => f.monitor.accept(f.event({ occurredAt: new Date(f.now() - 3600001).toISOString() })),
    code('EVENT_STALE'));
  f.monitor.accept(f.event());
  assert.throws(() => f.monitor.accept(f.event({ eventId: 'message-2', event: 'departed' })), code('EVENT_STALE'));
  assert.throws(() => f.monitor.accept(f.event({ eventId: 'message-3', event: 'departed',
    occurredAt: new Date(f.now() - 1).toISOString() })), code('EVENT_STALE'));
  assert.equal(f.monitor.getState('home').present, true);
  assert.equal(f.updates.length, 1);
});

test('corrupt, oversized and nonprivate existing stores are preserved and fail closed', async t => {
  const scenarios = {
    corrupt: filename => fs.writeFileSync(filename, '{private broken data', { mode: 0o600 }),
    shape: filename => fs.writeFileSync(filename, JSON.stringify({ version: 1, states: [], eventIds: [], secret: true }), { mode: 0o600 }),
    oversized: filename => fs.writeFileSync(filename, 'x'.repeat(65537), { mode: 0o600 }),
    nonprivate: filename => fs.writeFileSync(filename, '{}', { mode: 0o644 }),
    invalidState: filename => fs.writeFileSync(filename, JSON.stringify({ version: 1,
      states: [{ id: 'home', present: 'yes', observedAt: Date.UTC(2026, 0, 1) }], eventIds: [] }), { mode: 0o600 }),
  };
  for (const [name, prepare] of Object.entries(scenarios)) await t.test(name, child => {
    const f = fixture(child);
    fs.mkdirSync(path.dirname(f.stateFile), { mode: 0o700 });
    prepare(f.stateFile);
    const before = fs.readFileSync(f.stateFile);
    assert.throws(() => f.monitor.start(), code('EVENT_STORE'));
    assert.throws(() => f.monitor.accept(f.event()), code('EVENT_STORE'));
    assert.equal(f.monitor.getState('home').available, false);
    assert.deepEqual(fs.readFileSync(f.stateFile), before);
  });
});

test('symlink files, symlink directories and nonprivate directories are rejected', async t => {
  for (const kind of ['file', 'directory', 'nonprivate-directory']) await t.test(kind, child => {
    const f = fixture(child);
    const target = path.join(f.root, 'target');
    if (kind === 'file') {
      fs.mkdirSync(path.dirname(f.stateFile), { mode: 0o700 });
      fs.writeFileSync(target, '{}', { mode: 0o600 });
      fs.symlinkSync(target, f.stateFile);
    } else if (kind === 'directory') {
      fs.mkdirSync(target, { mode: 0o700 });
      fs.symlinkSync(target, path.dirname(f.stateFile));
    } else fs.mkdirSync(path.dirname(f.stateFile), { mode: 0o755 });
    assert.throws(() => f.monitor.start(), code('EVENT_STORE'));
    assert.equal(f.monitor.getState('home').available, false);
    if (kind === 'file') assert.equal(fs.readFileSync(target, 'utf8'), '{}');
  });
});

test('changed or corrupted storage during operation does not get overwritten or publish a crossing', t => {
  const f = fixture(t);
  f.monitor.start();
  f.monitor.accept(f.event());
  fs.writeFileSync(f.stateFile, 'external corruption');
  f.advance(1000);
  assert.throws(() => f.monitor.accept(f.event({ eventId: 'message-2', event: 'departed' })), code('EVENT_STORE'));
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), 'external corruption');
  assert.equal(f.monitor.getState('home').available, false);
  assert.equal(f.monitor.getState('home').present, true);
  assert.equal(f.updates.at(-1).available, false);
  assert.equal(f.updates.filter(event => event.changed).length, 0);
  assert.throws(() => f.monitor.accept(f.event({ eventId: 'message-3' })), code('EVENT_STORE'));
});

test('another writer cannot be silently overwritten even when its state file is valid', t => {
  const f = fixture(t);
  f.monitor.start();
  f.monitor.accept(f.event());
  const other = f.restore();
  other.start();
  f.advance(1000);
  other.accept(f.event({ eventId: 'other-message', event: 'departed' }));
  const before = fs.readFileSync(f.stateFile);
  f.advance(1000);
  assert.throws(() => f.monitor.accept(f.event({ eventId: 'message-2' })), code('EVENT_STORE'));
  assert.deepEqual(fs.readFileSync(f.stateFile), before);
  assert.equal(f.monitor.getState('home').available, false);
});

test('atomic write failures leave prior data intact, remove temporary files and fail closed', t => {
  const f = fixture(t);
  f.monitor.start();
  f.monitor.accept(f.event());
  const before = fs.readFileSync(f.stateFile);
  t.mock.method(fs, 'renameSync', () => { throw new Error('raw private diagnostic'); });
  f.advance(1000);
  assert.throws(() => f.monitor.accept(f.event({ eventId: 'message-2', event: 'departed' })), code('EVENT_STORE'));
  assert.deepEqual(fs.readFileSync(f.stateFile), before);
  assert.deepEqual(fs.readdirSync(path.dirname(f.stateFile)), ['presence.json']);
  assert.equal(f.monitor.getState('home').present, true);
  assert.equal(f.monitor.getState('home').available, false);
});

test('persisted event history is bounded and changing configured locations preserves matching states', t => {
  const f = fixture(t);
  f.monitor.start();
  for (let i = 0; i < 258; i += 1) {
    f.advance(1000);
    f.monitor.accept(f.event({ eventId: `message-${i}` }));
  }
  const saved = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  assert.equal(saved.eventIds.length, 256);
  assert.equal(saved.eventIds[0], 'message-2');
  f.monitor.shutdown();
  const changed = new EventPresenceMonitor({ config: { ...f.config,
    locations: [{ id: 'home' }, { id: 'school' }] }, stateFile: f.stateFile, now: f.now });
  changed.start();
  assert.equal(changed.getState('home').present, true);
  assert.equal(changed.getState('school').available, false);
  assert.equal(changed.getState('work'), undefined);
});

test('shutdown cannot restart, write or emit departure, and consumer failures are isolated', async t => {
  const f = fixture(t);
  const monitor = f.restore(() => { throw new Error('consumer error'); });
  monitor.start();
  monitor.accept(f.event());
  const stored = fs.readFileSync(f.stateFile);
  monitor.shutdown();
  monitor.start();
  assert.throws(() => monitor.accept(f.event({ eventId: 'message-2' })), code('EVENT_INVALID'));
  assert.deepEqual(fs.readFileSync(f.stateFile), stored);
  assert.equal(monitor.getState('home').present, true);
  assert.equal(monitor.getState('home').available, false);
  const asyncConsumer = f.restore(async () => { throw new Error('async consumer error'); });
  asyncConsumer.start();
  f.advance(1000);
  asyncConsumer.accept(f.event({ eventId: 'message-3', event: 'departed' }));
  await Promise.resolve();
  assert.equal(asyncConsumer.getState('home').present, false);
});

test('disabled event monitoring creates no storage and accepts no events', t => {
  const f = fixture(t, { enabled: false });
  f.monitor.start();
  assert.equal(fs.existsSync(path.dirname(f.stateFile)), false);
  assert.throws(() => f.monitor.accept(f.event()), code('EVENT_INVALID'));
  assert.equal(f.updates.length, 0);
});
