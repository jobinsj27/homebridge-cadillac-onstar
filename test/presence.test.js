'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { normalizePresenceConfig, PresenceMonitor, distanceMeters } = require('../lib/presence');

const place = { id: 'home', name: 'Home', latitude: 0, longitude: 0 };
const config = (overrides = {}) => ({ enabled: true, locations: [place], pollIntervalSeconds: 60, ...overrides });
const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

class Clock {
  time = 1000000;
  timers = new Map();
  next = 1;
  now = () => this.time;
  setTimer = (callback, delay) => {
    const id = this.next++;
    this.timers.set(id, { callback, at: this.time + delay });
    return id;
  };
  clearTimer = (id) => this.timers.delete(id);
  async advance(milliseconds) {
    const until = this.time + milliseconds;
    let runs = 0;
    while (true) {
      const pending = [...this.timers].sort((a, b) => a[1].at - b[1].at).find(([, timer]) => timer.at <= until);
      if (!pending) break;
      if (++runs > 1000) throw new Error('Unexpected timer loop');
      const [id, timer] = pending;
      this.time = timer.at;
      this.timers.delete(id);
      timer.callback();
      await flush();
    }
    this.time = until;
    await flush();
  }
}

function fixture(options = {}) {
  const clock = new Clock();
  const events = [];
  let latitude = 0;
  let accuracyMeters;
  let response;
  let calls = 0;
  const monitor = new PresenceMonitor({ config: config(options), now: clock.now,
    setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    readLocation: async () => {
      calls += 1;
      if (response) return response();
      return { latitude, longitude: 0, observedAt: clock.now(), accuracyMeters };
    }, onUpdate: (event) => events.push(event) });
  return { clock, events, monitor, calls: () => calls,
    move: (metres, accuracy) => { latitude = metres / 6371008.8 * 180 / Math.PI; accuracyMeters = accuracy; },
    respond: (fn) => { response = fn; } };
}

test('presence is opt-in and disabled configurations do not poll', async () => {
  for (const value of [undefined, null, {}, { enabled: false, locations: 'dormant-invalid-value' }]) {
    assert.deepEqual(normalizePresenceConfig(value), {
      enabled: false, locations: [], pollIntervalSeconds: 300,
      maxLocationAgeSeconds: 600, confirmationSamples: 2, exposeSwitch: false,
    });
    const monitor = new PresenceMonitor({ config: value, readLocation: () => assert.fail('disabled poll') });
    monitor.start();
    monitor.shutdown();
  }
});

test('enabled configuration validates locations, unique identity and numeric limits without exposing values', () => {
  const invalid = [
    false, [], { enabled: 'true' }, config({ locations: [] }), config({ locations: Array(21).fill(place) }),
    config({ locations: [place, place] }), config({ locations: [{ ...place, id: 'secret address/id' }] }),
    config({ locations: [{ ...place, name: '' }] }), config({ locations: [{ ...place, name: 'x'.repeat(49) }] }),
    config({ locations: [{ ...place, latitude: NaN }] }), config({ locations: [{ ...place, longitude: Infinity }] }),
    config({ locations: [{ ...place, latitude: 91 }] }), config({ locations: [{ ...place, longitude: '0' }] }),
    config({ locations: [{ ...place, arrivalRadiusMeters: 0 }] }),
    config({ locations: [{ ...place, arrivalRadiusMeters: 300, departureRadiusMeters: 250 }] }),
    config({ locations: [{ ...place, arrivalRadiusMeters: 150, departureRadiusMeters: 150 }] }),
    config({ locations: [{ ...place, departureRadiusMeters: 100001 }] }),
    config({ pollIntervalSeconds: 59 }), config({ pollIntervalSeconds: 86401 }),
    config({ maxLocationAgeSeconds: 59 }), config({ pollIntervalSeconds: 300, maxLocationAgeSeconds: 60 }),
    config({ confirmationSamples: 0 }), config({ confirmationSamples: 6 }), config({ confirmationSamples: 1.5 }),
    config({ exposeSwitch: 'false' }),
  ];
  for (const value of invalid) {
    assert.throws(() => normalizePresenceConfig(value), (error) => {
      assert.equal(error.code, 'PRESENCE_CONFIG');
      assert.equal(error.message, 'Invalid presence configuration.');
      return true;
    });
  }
  const normalized = normalizePresenceConfig(config({ locations: [{ id: 'home', latitude: -90, longitude: 180 }] }));
  assert.equal(normalized.locations[0].name, 'home');
  assert.equal(normalized.locations[0].arrivalRadiusMeters, 150);
  assert.equal(normalized.locations[0].departureRadiusMeters, 250);
});

test('one shared location poll establishes baselines and emits only confirmed arrival/departure transitions', async () => {
  const f = fixture({ locations: [place, { ...place, id: 'work', longitude: 0.02 }] });
  f.monitor.start();
  f.monitor.start();
  await flush();
  assert.equal(f.calls(), 1);
  assert.equal(f.monitor.getState('home').present, null);
  await f.clock.advance(60000);
  assert.equal(f.calls(), 2);
  assert.equal(f.monitor.getState('home').present, true);
  assert.equal(f.monitor.getState('work').present, false);
  assert.equal(f.events.filter(e => e.changed).length, 0);
  assert.equal(f.events.filter(e => e.baseline).length, 2);
  f.move(400);
  await f.clock.advance(60000);
  assert.equal(f.monitor.getState('home').present, true);
  await f.clock.advance(60000);
  assert.deepEqual(f.events.filter(e => e.changed).map(e => [e.id, e.present]), [['home', false]]);
  f.move(0);
  await f.clock.advance(120000);
  assert.deepEqual(f.events.filter(e => e.changed).map(e => [e.id, e.present]), [['home', false], ['home', true]]);
  assert.equal(f.calls(), 6);
  assert.equal(f.monitor.getState('unknown'), undefined);
  f.monitor.shutdown();
});

test('hysteresis and accuracy prevent noisy boundaries from producing false transitions', async () => {
  const f = fixture();
  f.move(100, 100); // The uncertainty overlaps the arrival boundary.
  f.monitor.start();
  await flush();
  await f.clock.advance(60000);
  assert.equal(f.monitor.getState('home').present, null);
  f.move(100, 10);
  await f.clock.advance(120000);
  assert.equal(f.monitor.getState('home').present, true);
  f.move(300, 100); // The uncertainty overlaps the departure boundary.
  await f.clock.advance(120000);
  assert.equal(f.monitor.getState('home').present, true);
  f.move(400);
  await f.clock.advance(60000); // One departure candidate.
  f.move(200);
  await f.clock.advance(60000); // Hysteresis band resets the candidate.
  f.move(400);
  await f.clock.advance(60000);
  assert.equal(f.monitor.getState('home').present, true);
  await f.clock.advance(60000);
  assert.equal(f.monitor.getState('home').present, false);
  assert.equal(f.events.filter(e => e.changed).length, 1);
  f.monitor.shutdown();
});

test('duplicate and out-of-order observations neither confirm a crossing nor extend freshness', async () => {
  const f = fixture({ maxLocationAgeSeconds: 180 });
  const initial = f.clock.now();
  f.respond(() => ({ latitude: 0, longitude: 0, observedAt: initial }));
  f.monitor.start();
  await flush();
  await f.clock.advance(60000);
  assert.equal(f.monitor.getState('home').present, null);
  f.respond(() => ({ latitude: 0, longitude: 0, observedAt: f.clock.now() }));
  await f.clock.advance(60000);
  assert.equal(f.monitor.getState('home').present, true);
  const confirmedAt = f.clock.now();
  f.respond(() => ({ latitude: 1, longitude: 1, observedAt: confirmedAt - 1 }));
  await f.clock.advance(120000);
  assert.equal(f.monitor.getState('home').present, true);
  assert.equal(f.monitor.getState('home').observedAt, confirmedAt);
  await f.clock.advance(60000);
  assert.equal(f.monitor.getState('home').available, false);
  assert.equal(f.monitor.getState('home').present, true);
  assert.equal(f.events.some(e => e.changed), false);
  f.monitor.shutdown();
});

test('stale, future and malformed observations never become an away reading', async () => {
  for (const sample of [
    { latitude: 10, longitude: 10, observedAt: 1 },
    { latitude: 10, longitude: 10, observedAt: 1000001 },
    { latitude: '10', longitude: 10, observedAt: 1000000 },
    { latitude: 10, longitude: 10, observedAt: '1000000' },
    { latitude: 10, longitude: 10, observedAt: 1000000, accuracyMeters: -1 },
    { latitude: 10, longitude: 10, observedAt: 1000000, accuracyMeters: Infinity },
    null,
  ]) {
    const f = fixture({ confirmationSamples: 1 });
    f.respond(() => sample);
    f.monitor.start();
    await flush();
    assert.equal(f.monitor.getState('home').present, null);
    assert.equal(f.monitor.getState('home').available, false);
    assert.equal(f.events.some(e => e.changed), false);
    f.monitor.shutdown();
  }
});

test('a hung poll cannot overlap other polls or keep a previous location fresh', async () => {
  const f = fixture({ confirmationSamples: 1, maxLocationAgeSeconds: 120 });
  let resolvePending;
  f.monitor.start();
  await flush();
  f.respond(() => new Promise(resolve => { resolvePending = resolve; }));
  await f.clock.advance(60000);
  assert.equal(f.calls(), 2);
  await f.clock.advance(600000);
  assert.equal(f.calls(), 2);
  assert.equal(f.monitor.getState('home').available, false);
  assert.equal(f.monitor.getState('home').present, true);
  assert.equal(f.events.some(e => e.changed), false);
  resolvePending({ latitude: 1, longitude: 1, observedAt: f.clock.now() });
  await flush();
  assert.equal(f.monitor.getState('home').present, false);
  assert.equal(f.events.at(-1).baseline, true);
  assert.equal(f.events.at(-1).changed, false);
  f.monitor.shutdown();
});

test('a status read rejects stale state even before a delayed expiry callback has run', async () => {
  const f = fixture({ confirmationSamples: 1, maxLocationAgeSeconds: 120 });
  f.monitor.start();
  await flush();
  assert.equal(f.monitor.getState('home').available, true);
  f.clock.time += 120000; // Model a clock jump or delayed event loop without firing timers.
  assert.equal(f.monitor.getState('home').available, false);
  assert.equal(f.monitor.getState('home').present, true);
  assert.equal(f.calls(), 1);
  assert.equal(f.events.some(e => e.changed), false);
  f.monitor.shutdown();
});

test('outages preserve the last state and recovery establishes a new baseline without a synthetic crossing', async () => {
  const f = fixture({ maxLocationAgeSeconds: 120 });
  f.monitor.start();
  await flush();
  await f.clock.advance(60000);
  f.respond(() => { throw new Error('secret-account-details'); });
  await f.clock.advance(60000);
  assert.equal(f.monitor.getState('home').present, true);
  assert.equal(f.monitor.getState('home').available, true);
  await f.clock.advance(60000); // The observation expires before the retry succeeds.
  assert.equal(f.monitor.getState('home').available, false);
  f.respond(() => ({ latitude: 1, longitude: 1, observedAt: f.clock.now() }));
  await f.clock.advance(120000); // First read after the second failure backs off.
  assert.equal(f.monitor.getState('home').available, false);
  await f.clock.advance(60000);
  assert.equal(f.monitor.getState('home').present, false);
  assert.equal(f.monitor.getState('home').available, true);
  assert.equal(f.events.at(-1).baseline, true);
  assert.equal(f.events.some(e => e.changed), false);
  assert.equal(JSON.stringify(f.events).includes('secret'), false);
  f.monitor.shutdown();
});

test('one transient failure retains a fresh confirmed state and retries at the configured cadence', async () => {
  const f = fixture();
  f.monitor.start();
  await flush();
  await f.clock.advance(60000);
  const confirmedAt = f.monitor.getState('home').observedAt;
  f.respond(() => { throw new Error('network'); });
  await f.clock.advance(60000);
  assert.equal(f.monitor.getState('home').available, true);
  assert.equal(f.monitor.getState('home').observedAt, confirmedAt);
  assert.equal(f.calls(), 3);
  f.respond(() => ({ latitude: 0, longitude: 0, observedAt: f.clock.now() }));
  await f.clock.advance(59999);
  assert.equal(f.calls(), 3);
  await f.clock.advance(1);
  assert.equal(f.calls(), 4);
  assert.equal(f.monitor.getState('home').available, true);
  assert.equal(f.monitor.getState('home').observedAt, f.clock.now());
  assert.equal(f.events.some(e => !e.available && e.present !== null), false);
  assert.equal(f.events.some(e => e.changed), false);
  f.monitor.shutdown();
});

test('unusable observations preserve a prior fresh state only until its original deadline', async () => {
  for (const unusable of [
    () => ({ latitude: 10, longitude: 10, observedAt: 1 }),
    now => ({ latitude: 10, longitude: 10, observedAt: now + 1 }),
    now => ({ latitude: '10', longitude: 10, observedAt: now }),
    () => null,
    () => { throw Object.assign(new Error('unavailable'), { code: 'LOCATION_UNAVAILABLE' }); },
  ]) {
    const f = fixture({ confirmationSamples: 1, maxLocationAgeSeconds: 180 });
    f.monitor.start();
    await flush();
    const confirmedAt = f.monitor.getState('home').observedAt;
    f.respond(() => unusable(f.clock.now()));
    await f.clock.advance(179999);
    assert.equal(f.monitor.getState('home').available, true);
    assert.equal(f.monitor.getState('home').observedAt, confirmedAt);
    await f.clock.advance(1);
    assert.equal(f.monitor.getState('home').available, false);
    assert.equal(f.monitor.getState('home').present, true);
    assert.equal(f.monitor.getState('home').observedAt, confirmedAt);
    assert.equal(f.events.some(e => e.changed), false);
    assert.equal(f.calls(), 4); // Invalid data retains the normal polling interval.
    f.monitor.shutdown();
  }
});

test('a failed read resets unconfirmed initial states and boundary crossings', async () => {
  for (const confirmed of [false, true]) {
    const f = fixture();
    f.monitor.start();
    await flush();
    if (confirmed) {
      await f.clock.advance(60000);
      f.move(400);
      await f.clock.advance(60000); // First departure candidate.
    }
    const prior = confirmed ? true : null;
    f.respond(() => { throw new Error('network'); });
    await f.clock.advance(60000);
    f.respond(() => ({ latitude: confirmed ? 1 : 0, longitude: 0, observedAt: f.clock.now() }));
    await f.clock.advance(60000);
    assert.equal(f.monitor.getState('home').present, prior);
    await f.clock.advance(60000);
    assert.equal(f.monitor.getState('home').present, !confirmed);
    assert.equal(f.events.filter(e => e.changed).length, confirmed ? 1 : 0);
    f.monitor.shutdown();
  }
});

test('one distinct fresh fix silently recovers the same confirmed state after expiry', async () => {
  for (const present of [false, true]) {
    const f = fixture({ maxLocationAgeSeconds: 120 });
    f.move(present ? 0 : 400);
    f.monitor.start();
    await flush();
    await f.clock.advance(60000);
    assert.equal(f.monitor.getState('home').present, present);
    f.respond(() => { throw new Error('network'); });
    await f.clock.advance(120000);
    assert.equal(f.monitor.getState('home').available, false);
    f.respond(() => ({ latitude: present ? 0 : 1, longitude: 0, observedAt: f.clock.now() }));
    await f.clock.advance(120000);
    assert.equal(f.monitor.getState('home').available, true);
    assert.equal(f.monitor.getState('home').present, present);
    assert.equal(f.events.at(-1).baseline, true);
    assert.equal(f.events.some(e => e.changed), false);
    f.monitor.shutdown();
  }
});

test('a delayed expiry callback cannot make fresh recovery publish a synthetic crossing', async () => {
  const f = fixture({ maxLocationAgeSeconds: 120 });
  f.monitor.start();
  await flush();
  await f.clock.advance(60000);
  f.move(400);
  await f.clock.advance(60000); // A pending departure is not yet confirmed.
  f.clock.time += 120000; // Do not run the expiry callback or any poll timer.
  f.monitor.accept({ latitude: 1, longitude: 0, observedAt: f.clock.now() });
  assert.equal(f.monitor.getState('home').available, false);
  assert.equal(f.monitor.getState('home').present, true);
  f.clock.time += 1;
  f.monitor.accept({ latitude: 1, longitude: 0, observedAt: f.clock.now() });
  assert.equal(f.monitor.getState('home').available, true);
  assert.equal(f.monitor.getState('home').present, false);
  assert.equal(f.events.at(-1).baseline, true);
  assert.equal(f.events.some(e => e.changed), false);
  f.monitor.shutdown();
});

test('repeated failures back off with a cap while BUSY skips without invalidating a fresh location', async () => {
  const f = fixture({ confirmationSamples: 1, maxLocationAgeSeconds: 86400 });
  f.monitor.start();
  await flush();
  f.respond(() => { throw Object.assign(new Error('busy'), { code: 'BUSY' }); });
  await f.clock.advance(60000);
  assert.equal(f.monitor.getState('home').available, true);
  assert.equal(f.calls(), 2);
  await f.clock.advance(60000);
  assert.equal(f.calls(), 3);
  f.respond(() => { throw new Error('network'); });
  await f.clock.advance(60000);
  for (const delay of [60000, 120000, 240000, 480000, 960000, 1920000, 3600000, 3600000]) {
    const count = f.calls();
    await f.clock.advance(delay - 1);
    assert.equal(f.calls(), count);
    await f.clock.advance(1);
    assert.equal(f.calls(), count + 1);
  }
  f.respond(() => ({ latitude: 0, longitude: 0, observedAt: f.clock.now() }));
  await f.clock.advance(3600000);
  const recovered = f.calls();
  await f.clock.advance(60000);
  assert.equal(f.calls(), recovered + 1); // A successful read resets the backoff.
  f.monitor.shutdown();
});

test('parked stale GPS and unavailable fixes retain the configured cadence until the next drive', async () => {
  const f = fixture({ confirmationSamples: 1 });
  f.respond(() => ({ latitude: 0, longitude: 0, observedAt: 1 }));
  f.monitor.start();
  await flush();
  await f.clock.advance(3600000);
  assert.equal(f.calls(), 61);
  assert.equal(f.monitor.getState('home').available, false);
  f.respond(() => { throw Object.assign(new Error('GPS fix unavailable'), { code: 'LOCATION_UNAVAILABLE' }); });
  await f.clock.advance(120000);
  assert.equal(f.calls(), 63);
  f.respond(() => ({ latitude: 0, longitude: 0, observedAt: f.clock.now() }));
  await f.clock.advance(60000);
  assert.equal(f.calls(), 64);
  assert.equal(f.monitor.getState('home').present, true);
  assert.equal(f.monitor.getState('home').available, true);
  assert.equal(f.events.at(-1).baseline, true);
  assert.equal(f.events.some(e => e.changed), false);
  f.monitor.shutdown();
});

test('shutdown discards in-flight results, clears timers and cannot be restarted', async () => {
  const f = fixture();
  let resolvePending;
  f.respond(() => new Promise(resolve => { resolvePending = resolve; }));
  f.monitor.start();
  await flush();
  f.monitor.shutdown();
  f.monitor.start();
  resolvePending({ latitude: 0, longitude: 0, observedAt: f.clock.now() });
  await flush();
  await f.clock.advance(86400000);
  assert.equal(f.calls(), 1);
  assert.equal(f.clock.timers.size, 0);
  assert.deepEqual(f.events, []);
});

test('consumer callback failures are contained and timer failures mark readings unavailable', async () => {
  for (const onUpdate of [() => { throw new Error('callback'); }, async () => { throw new Error('async callback'); }]) {
    const clock = new Clock();
    const monitor = new PresenceMonitor({ config: config({ confirmationSamples: 1 }),
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, onUpdate,
      readLocation: async () => ({ latitude: 0, longitude: 0, observedAt: clock.now() }) });
    monitor.start();
    await flush();
    await clock.advance(60000);
    assert.equal(monitor.getState('home').available, true);
    monitor.shutdown();
  }
  const monitor = new PresenceMonitor({ config: config({ confirmationSamples: 1 }), now: () => 1000,
    readLocation: async () => ({ latitude: 0, longitude: 0, observedAt: 1000 }),
    setTimer: () => { throw new Error('timer'); }, clearTimer: () => { throw new Error('clear'); } });
  monitor.start();
  await flush();
  assert.equal(monitor.getState('home').available, false);
  monitor.shutdown();
});

test('great-circle distances handle the antimeridian, poles and identical positions', () => {
  assert.equal(distanceMeters(place, place), 0);
  const crossing = distanceMeters({ latitude: 0, longitude: 179.999 }, { latitude: 0, longitude: -179.999 });
  assert.ok(crossing > 220 && crossing < 225);
  assert.ok(distanceMeters({ latitude: 90, longitude: 0 }, { latitude: 90, longitude: 180 }) < 0.001);
  assert.ok(Number.isFinite(distanceMeters({ latitude: 90, longitude: 0 }, { latitude: -90, longitude: 0 })));
});
