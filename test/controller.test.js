'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { VehicleController, isComplete, SESSION_MS } = require('../lib/controller');

const completed = () => ({
  status: 'success',
  response: { data: { commandResponse: { status: 'success' } } },
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeClock() {
  let now = 1_000;
  const timers = new Set();
  return {
    now: () => now,
    setTimer(fn, delay) {
      const timer = { fn, at: now + delay, unref() {} };
      timers.add(timer);
      return timer;
    },
    clearTimer(timer) { timers.delete(timer); },
    advance(ms) {
      const target = now + ms;
      while (true) {
        const timer = [...timers].filter((item) => item.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (!timer) break;
        timers.delete(timer);
        now = timer.at;
        timer.fn();
      }
      now = target;
    },
  };
}

function fixture(overrides = {}, options = {}) {
  const calls = [];
  const changes = [];
  const clock = fakeClock();
  const client = {};
  for (const method of ['start', 'cancelStart', 'lockDoor', 'unlockDoor']) {
    client[method] = async () => {
      calls.push(method);
      return overrides[method] ? overrides[method]() : completed();
    };
  }
  const controller = new VehicleController({
    createClient: async () => client,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onChange: (...args) => changes.push(args),
    lockStateTtlMs: 500,
    ...options,
  });
  return { controller, calls, changes, clock };
}

const hasCode = (code) => (error) => {
  assert.equal(error.code, code);
  return true;
};

async function flushMicrotasks() {
  for (let count = 0; count < 8; count += 1) await Promise.resolve();
}

test('initial reads and shutdown never send a vehicle command', async () => {
  const { controller, calls, clock } = fixture();
  assert.equal(controller.getStart(), null);
  assert.equal(controller.getLocked(), null);
  clock.advance(SESSION_MS * 2);
  assert.equal(controller.getStart(), null);
  assert.equal(controller.getLocked(), null);
  await controller.shutdown();
  assert.equal(controller.getStart(), null);
  assert.equal(controller.getLocked(), null);
  assert.deepEqual(calls, []);
});

test('confirmed start expires at 15 minutes without a cancel command', async () => {
  const { controller, calls, clock } = fixture();
  assert.equal(SESSION_MS, 15 * 60 * 1_000);
  await controller.setStart(true);
  assert.equal(controller.getStart(), true);
  clock.advance(SESSION_MS - 1);
  assert.equal(controller.getStart(), true);
  clock.advance(1);
  assert.equal(controller.getStart(), false);
  assert.deepEqual(calls, ['start']);
  await controller.shutdown();
});

test('repeated on during a confirmed local session neither restarts nor extends it', async () => {
  const { controller, calls, clock } = fixture();
  await controller.setStart(true);
  clock.advance(SESSION_MS / 2);
  await controller.setStart(true);
  assert.deepEqual(calls, ['start']);
  clock.advance(SESSION_MS / 2);
  assert.equal(controller.getStart(), false);
  await controller.shutdown();
});

test('an explicit off cancels remote start, including when the initial state is unknown', async () => {
  const { controller, calls } = fixture();
  await controller.setStart(false);
  assert.equal(controller.getStart(), false);
  await controller.setStart(true);
  await controller.setStart(false);
  assert.equal(controller.getStart(), false);
  assert.deepEqual(calls, ['cancelStart', 'start', 'cancelStart']);
  await controller.shutdown();
});

test('in-flight commands reject concurrent actions without queuing or replay', async () => {
  const pending = deferred();
  const { controller, calls } = fixture({ start: () => pending.promise });
  const first = controller.setStart(true);
  await flushMicrotasks();
  assert.deepEqual(calls, ['start']);
  await assert.rejects(controller.setLocked(false), hasCode('BUSY'));
  await assert.rejects(controller.setStart(false), hasCode('BUSY'));
  await assert.rejects(controller.setStart(true), hasCode('BUSY'));
  pending.resolve(completed());
  await first;
  await flushMicrotasks();
  assert.equal(controller.getStart(), true);
  assert.equal(controller.getLocked(), null);
  assert.deepEqual(calls, ['start']);
  await controller.shutdown();
});

test('a rejected busy action does not erase an already confirmed lock state', async () => {
  const pending = deferred();
  const { controller, calls } = fixture({ start: () => pending.promise });
  await controller.setLocked(true);
  const starting = controller.setStart(true);
  await flushMicrotasks();
  await assert.rejects(controller.setLocked(false), hasCode('BUSY'));
  assert.equal(controller.getLocked(), true);
  pending.resolve(completed());
  await starting;
  assert.deepEqual(calls, ['lockDoor', 'start']);
  await controller.shutdown();
});

test('lock and unlock confirmations become unknown after their state TTL', async () => {
  const { controller, calls, clock } = fixture();
  await controller.setLocked(true);
  assert.equal(controller.getLocked(), true);
  clock.advance(499);
  assert.equal(controller.getLocked(), true);
  clock.advance(1);
  assert.equal(controller.getLocked(), null);
  await controller.setLocked(false);
  assert.equal(controller.getLocked(), false);
  clock.advance(500);
  assert.equal(controller.getLocked(), null);
  assert.deepEqual(calls, ['lockDoor', 'unlockDoor']);
  await controller.shutdown();
});

test('an explicit repeated lock command refreshes confirmation and its expiry', async () => {
  const { controller, calls, clock } = fixture();
  await controller.setLocked(true);
  clock.advance(400);
  await controller.setLocked(true);
  clock.advance(100);
  assert.equal(controller.getLocked(), true);
  clock.advance(400);
  assert.equal(controller.getLocked(), null);
  assert.deepEqual(calls, ['lockDoor', 'lockDoor']);
  await controller.shutdown();
});

test('only an explicit nested completion with a successful wrapper is trusted', () => {
  for (const status of ['success', 'SUCCESS', 'complete', 'COMPLETED']) {
    assert.equal(isComplete({ status: 'success', response: { data: { status } } }), true);
    assert.equal(isComplete({ status: 'success', response: { data: { commandResponse: { status } } } }), true);
  }
  for (const response of [
    undefined, null, {}, true,
    { status: 'success' },
    { status: 'success', response: { data: {} } },
    { status: 'success', response: { data: { status: 'IN_PROGRESS' } } },
    { status: 'success', response: { data: { status: 'PENDING' } } },
    { status: 'success', response: { data: { status: 'QUEUED' } } },
    { status: 'success', response: { data: { status: 'FAILED' } } },
    { status: 'failure', response: { data: { status: 'SUCCESS' } } },
    { status: 'success', error: 'authorization rejected', response: { data: { status: 'SUCCESS' } } },
  ]) {
    assert.equal(isComplete(response), false, JSON.stringify(response));
  }
});

test('ambiguous start results stay unknown and are never automatically retried', async (t) => {
  for (const response of [
    { status: 'success' },
    { status: 'success', response: { data: { status: 'IN_PROGRESS' } } },
    { status: 'failure', response: { data: { status: 'SUCCESS' } } },
  ]) {
    await t.test(JSON.stringify(response), async () => {
      const { controller, calls, clock } = fixture({ start: () => response });
      await assert.rejects(controller.setStart(true), hasCode('COMMAND_FAILED'));
      assert.equal(controller.getStart(), null);
      clock.advance(SESSION_MS * 2);
      assert.equal(controller.getStart(), null);
      assert.deepEqual(calls, ['start']);
      await controller.shutdown();
    });
  }
});

test('failed unlock invalidates the earlier locked confirmation', async () => {
  const { controller, calls, clock } = fixture({
    unlockDoor: () => ({ status: 'success', response: { data: { status: 'PENDING' } } }),
  });
  await controller.setLocked(true);
  await assert.rejects(controller.setLocked(false), hasCode('COMMAND_FAILED'));
  assert.equal(controller.getLocked(), null);
  clock.advance(SESSION_MS);
  assert.equal(controller.getLocked(), null);
  assert.deepEqual(calls, ['lockDoor', 'unlockDoor']);
  await controller.shutdown();
});

test('failed cancel invalidates the earlier running confirmation', async () => {
  const { controller, calls, clock } = fixture({
    cancelStart: () => { throw new Error('upstream timeout'); },
  });
  await controller.setStart(true);
  await assert.rejects(controller.setStart(false), hasCode('COMMAND_FAILED'));
  assert.equal(controller.getStart(), null);
  clock.advance(SESSION_MS * 2);
  assert.equal(controller.getStart(), null);
  assert.deepEqual(calls, ['start', 'cancelStart']);
  await controller.shutdown();
});

test('credential failures expose only sanitized errors and send no command', async () => {
  const secrets = ['secret-account@example.test', 'secret-access-token', 'secret-pin-1234'];
  const upstream = new Error(secrets.join(' '));
  upstream.credentials = { token: secrets[1] };
  const { controller, calls } = fixture({}, {
    createClient: async () => { throw upstream; },
  });
  await assert.rejects(controller.setStart(true), (error) => {
    assert.equal(error.code, 'CREDENTIALS');
    const visible = [String(error), error.stack, JSON.stringify(error)].join(' ');
    for (const secret of secrets) assert.equal(visible.includes(secret), false);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(controller.getStart(), null);
  assert.deepEqual(calls, []);
  await controller.shutdown();
});

test('command failures cannot expose upstream credentials in their errors', async () => {
  const secret = 'secret-refresh-token';
  const { controller, calls } = fixture({
    lockDoor: () => { throw new Error(`Authorization: Bearer ${secret}`); },
  });
  await assert.rejects(controller.setLocked(true), (error) => {
    assert.equal(error.code, 'COMMAND_FAILED');
    assert.equal(`${error}\n${error.stack}\n${JSON.stringify(error)}`.includes(secret), false);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(controller.getLocked(), null);
  assert.deepEqual(calls, ['lockDoor']);
  await controller.shutdown();
});

test('invalid nonboolean actions and actions after shutdown send no commands', async () => {
  const { controller, calls } = fixture();
  for (const value of [undefined, null, 0, 1, 'true', 'false', {}]) {
    await assert.rejects(controller.setStart(value), hasCode('INVALID_VALUE'));
    await assert.rejects(controller.setLocked(value), hasCode('INVALID_VALUE'));
  }
  await controller.shutdown();
  await assert.rejects(controller.setStart(true), hasCode('CLOSED'));
  await assert.rejects(controller.setLocked(false), hasCode('CLOSED'));
  assert.deepEqual(calls, []);
});

test('shutdown clears local display state and sends no stop or unlock command', async () => {
  const { controller, calls, clock, changes } = fixture();
  await controller.setStart(true);
  await controller.setLocked(true);
  await controller.shutdown();
  const changeCount = changes.length;
  clock.advance(SESSION_MS * 2);
  assert.equal(controller.getStart(), null);
  assert.equal(controller.getLocked(), null);
  assert.equal(changes.length, changeCount);
  assert.deepEqual(calls, ['start', 'lockDoor']);
});

test('a command completing after shutdown cannot republish state or schedule expiry', async () => {
  const pending = deferred();
  const { controller, calls, changes, clock } = fixture({ start: () => pending.promise });
  const starting = controller.setStart(true);
  await flushMicrotasks();
  await controller.shutdown();
  const changeCount = changes.length;
  pending.resolve(completed());
  await assert.rejects(starting, hasCode('CLOSED'));
  clock.advance(SESSION_MS * 2);
  assert.equal(controller.getStart(), null);
  assert.equal(changes.length, changeCount);
  assert.deepEqual(calls, ['start']);
});
