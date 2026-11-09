'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { parseArgs, run, performCheck, CHECK_TIMEOUT_MS } = require('../bin/check-connection');

class FakeWorker extends EventEmitter {
  constructor() {
    super();
    this.stdoutDrains = 0;
    this.stderrDrains = 0;
    this.terminations = 0;
    this.stdout = { resume: () => { this.stdoutDrains += 1; } };
    this.stderr = { resume: () => { this.stderrDrains += 1; } };
  }
  async terminate() {
    this.terminations += 1;
    this.emit('exit', 0);
    return 0;
  }
}

function sanitizedFailure(error) {
  assert.equal(error.code, 'CHECK_FAILED');
  assert.equal(`${error}\n${error.stack}\n${JSON.stringify(error)}`.includes('secret-token'), false);
  assert.equal(error.cause, undefined);
  return true;
}

test('connection check defaults to inspect and accepts location, unlock, or lock explicitly', () => {
  assert.deepEqual(parseArgs([], { env: {}, home: '/example/home' }), {
    action: 'inspect',
    credentialsFile: '/example/home/.homebridge/cadillac-onstar/credentials.json',
    stateDir: '/example/home/.homebridge/cadillac-onstar',
    browserPath: '/example/home/.homebridge/cadillac-onstar/.cache/browsers',
  });
  for (const action of ['inspect', 'location', 'unlock', 'lock']) {
    assert.deepEqual(parseArgs([action, '--credentials-file', '/example/private/credentials.json'], { env: {} }), {
      action, credentialsFile: '/example/private/credentials.json', stateDir: '/example/private',
      browserPath: '/example/private/.cache/browsers',
    });
  }
});

test('start, stop, unknown actions, and invalid arguments fail before worker creation', () => {
  let workerCreations = 0;
  const createWorker = () => { workerCreations += 1; return new FakeWorker(); };
  for (const args of [
    ['start'], ['cancelStart'], ['stop'], ['remoteStart'], ['alert'], ['cancelAlert'], ['findCar'],
    ['unlockDoor'], ['LOCK'], ['unknown'],
    ['inspect', '--credentials-file', 'relative.json'], ['inspect', '--browser-path', 'relative-browser'],
    ['inspect', '--credentials-file', '/example/credentials.json', 'extra'],
    ['inspect', 42], ['inspect', '--credentials-file', {}], null, 'start',
  ]) {
    assert.throws(() => run(args, createWorker), { code: 'INVALID_ARGUMENTS' });
  }
  assert.equal(workerCreations, 0);
});

test('help does not create a worker or read credentials', async () => {
  assert.match(await run(['--help'], () => { throw new Error('worker must not start'); }), /Usage: cadillac-onstar-check/);
});

test('success drains worker output and returns only the fixed sanitized summary', async () => {
  for (const [action, summary] of [
    ['inspect', 'OnStar vehicle connection verified.'],
    ['unlock', 'Door-unlock command completed.'],
    ['lock', 'Door-lock command completed.'],
  ]) {
    const worker = new FakeWorker();
    let options;
    const pending = run([action], (value) => { options = value; return worker; });
    assert.equal(options.action, action);
    assert.equal(worker.stdoutDrains, 1);
    assert.equal(worker.stderrDrains, 1);
    worker.emit('message', { ok: true, response: 'secret-token', message: 'secret-token' });
    assert.equal(await pending, summary);
    assert.equal(worker.terminations, 1);
  }
});

test('failed, ambiguous, crashed, or exited workers reject pending checks without exposing errors', async (t) => {
  for (const [name, event, value] of [
    ['reported failure', 'message', { ok: false, error: 'secret-token' }],
    ['ambiguous response', 'message', { ok: 'true', error: 'secret-token' }],
    ['crash', 'error', new Error('secret-token')],
    ['exit without success', 'exit', 0],
  ]) {
    await t.test(name, async () => {
      const worker = new FakeWorker();
      const pending = run([], () => worker);
      worker.emit(event, value);
      worker.emit('message', { ok: true });
      await assert.rejects(pending, sanitizedFailure);
      assert.equal(worker.terminations, 1);
    });
  }
});

test('worker creation and termination failures remain sanitized', async () => {
  await assert.rejects(run([], () => { throw new Error('secret-token'); }), sanitizedFailure);
  const worker = new FakeWorker();
  worker.terminate = async () => { throw new Error('secret-token'); };
  const pending = run([], () => worker);
  worker.emit('message', { ok: true });
  await assert.rejects(pending, sanitizedFailure);
});

test('location summaries use observation time and expose only whole age seconds and freshness', async () => {
  const now = Date.UTC(2026, 0, 1, 12);
  for (const [ageMs, expected] of [
    [59999, 'FRESH; observation age 59 seconds.'],
    [600000, 'FRESH; observation age 600 seconds.'],
    [600001, 'STALE; observation age 600 seconds.'],
    [7200000, 'STALE; observation age 7200 seconds.'],
  ]) {
    const worker = new FakeWorker();
    const pending = run(['location'], () => worker, { now: () => now });
    worker.emit('message', { ok: true, location: { observedAt: now - ageMs,
      latitude: 'secret-token', longitude: 'secret-token' }, message: 'secret-token' });
    assert.equal(await pending, `OnStar location verified: ${expected}`);
    assert.equal(worker.terminations, 1);
  }
});

test('location rejects missing, future, nonnumeric, or ambiguous observation times', async () => {
  const now = Date.UTC(2026, 0, 1, 12);
  for (const location of [undefined, {}, { observedAt: 'secret-token' }, { observedAt: null },
    { observedAt: NaN }, { observedAt: Infinity }, { observedAt: 0 }, { observedAt: -1 },
    { observedAt: now + 1 }]) {
    const worker = new FakeWorker();
    const pending = run(['location'], () => worker, { now: () => now });
    worker.emit('message', { ok: true, location, response: 'secret-token' });
    await assert.rejects(pending, sanitizedFailure);
    assert.equal(worker.terminations, 1);
  }
});

test('a bounded check deadline terminates an unresponsive worker without replaying work', async () => {
  const worker = new FakeWorker();
  let callback;
  let scheduledDelay;
  let cleared;
  const handle = { unref() {} };
  const pending = run(['location'], () => worker, {
    setTimer: (fn, delay) => { callback = fn; scheduledDelay = delay; return handle; },
    clearTimer: (value) => { cleared = value; },
  });
  assert.equal(scheduledDelay, CHECK_TIMEOUT_MS);
  assert.equal(scheduledDelay, 120000);
  callback();
  worker.emit('message', { ok: true, location: { observedAt: Date.now() } });
  await assert.rejects(pending, sanitizedFailure);
  assert.equal(worker.terminations, 1);
  assert.equal(cleared, handle);
});

test('successful checks clear the deadline and late events cannot replace the result', async () => {
  const worker = new FakeWorker();
  let callback;
  let cleared;
  const handle = {};
  const pending = run(['inspect'], () => worker, {
    setTimer: (fn) => { callback = fn; return handle; },
    clearTimer: (value) => { cleared = value; },
  });
  worker.emit('message', { ok: true });
  callback();
  assert.equal(await pending, 'OnStar vehicle connection verified.');
  assert.equal(cleared, handle);
  assert.equal(worker.terminations, 1);
});

function locationResult() {
  return {
    status: 'success',
    response: { data: { telemetry: {
      occurredTs: '2026-01-01T10:00:00.000Z',
      processingTs: '2026-01-01T12:00:00.000Z',
      data: { position: { lat: 12.25, lng: -34.5 }, session: { updatePending: 'NONE' } },
    } } },
  };
}

test('worker location dispatch validates actual telemetry and returns no coordinates', async () => {
  const calls = [];
  const client = new Proxy({}, {
    get: (_target, method) => async () => {
      calls.push(method);
      assert.equal(method, 'location');
      return locationResult();
    },
  });
  assert.deepEqual(await performCheck('location', client), {
    ok: true, location: { observedAt: Date.parse('2026-01-01T10:00:00.000Z') },
  });
  assert.deepEqual(calls, ['location']);
});

test('worker rejects incomplete or untimestamped GPS even when HTTP status is success', async () => {
  for (const modify of [
    result => { result.response.data.telemetry.data.session.updatePending = 'PENDING'; },
    result => { delete result.response.data.telemetry.occurredTs; },
    result => { result.response.data.telemetry.data.position.lat = 'secret-token'; },
  ]) {
    const result = locationResult();
    modify(result);
    await assert.rejects(performCheck('location', { location: async () => result }),
      error => error.code === 'LOCATION_UNAVAILABLE' && !String(error).includes('secret-token'));
  }
});

test('worker action allowlist rejects engine and alert actions before touching the client', async () => {
  let calls = 0;
  const client = new Proxy({}, { get: () => { calls += 1; throw new Error('secret-token'); } });
  for (const action of ['start', 'cancelStart', 'alert', 'cancelAlert', undefined]) {
    await assert.rejects(performCheck(action, client), sanitizedFailure);
  }
  assert.equal(calls, 0);
});
