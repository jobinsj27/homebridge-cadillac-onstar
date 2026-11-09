'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../lib/worker.js'), 'utf8');

function workerWith(client) {
  const messages = []; let dispatch;
  const localRequire = name => {
    if (name === 'node:worker_threads') return {
      workerData: { credentialsFile: '/synthetic/private/credentials.json' },
      parentPort: { postMessage: message => messages.push(JSON.parse(JSON.stringify(message))),
        on: (_event, listener) => { dispatch = listener; } },
    };
    if (name === './credentials') return { loadCredentials: () => ({}) };
    if (name === './sdk') return { createClient: () => client };
    if (name === './location') return require('../lib/location');
    return require(name);
  };
  vm.runInNewContext(source, { require: localRequire, process: { env: {} }, console });
  return { messages, dispatch };
}

test('location worker exposes only minimized validated GPS data, not account or raw telemetry', async () => {
  const probe = workerWith({ location: async () => ({ status: 'success', response: { data: {
    vehicle: { vin: 'SECRET_VIN' }, telemetry: { occurredTs: '2026-01-01T00:00:00Z',
      processingTs: '2026-01-02T00:00:00Z', data: { session: { updatePending: 'NONE' },
        position: { lat: 12, lng: 34, geohash: 'SECRET_GEOHASH' }, additional: 'SECRET_PAYLOAD' } },
  } } }) });
  await probe.dispatch({ method: 'location' });
  assert.deepEqual(probe.messages, [{ ready: true }, { result: { latitude: 12, longitude: 34, observedAt: 1767225600000 } }]);
  assert.doesNotMatch(JSON.stringify(probe.messages), /SECRET|processingTs|vehicle|telemetry/);
});

test('malformed location and underlying exceptions expose no raw values', async () => {
  for (const [location, error] of [[async () => ({ status: 'success', response: { data: { secret: 'SECRET_PAYLOAD' } } }), 'LOCATION_UNAVAILABLE'],
    [async () => { throw new Error('SECRET_PASSWORD'); }, 'COMMAND_FAILED']]) {
    const probe = workerWith({ location });
    await probe.dispatch({ method: 'location' });
    assert.deepEqual(probe.messages, [{ ready: true }, { error }]);
  }
});

test('malformed status objects and unrecognized strings never cross the worker boundary', async () => {
  const probe = workerWith({ alert: async () => ({ status: { token: 'SECRET' },
    response: { data: { status: 'SECRET_PASSWORD', commandResponse: { status: ['SECRET_ARRAY'] } } } }) });
  await probe.dispatch({ method: 'alert' });
  assert.doesNotMatch(JSON.stringify(probe.messages), /SECRET/);
  assert.equal(probe.messages.at(-1).result.status, undefined);
});

test('alert requests retain confirmation statuses while discarding SDK response details', async () => {
  for (const method of ['alert', 'cancelAlert']) {
    const calls = [];
    const probe = workerWith({ [method]: async () => {
      calls.push(method);
      return { status: 'success', response: { data: { status: 'COMPLETE', private: 'SECRET' } } };
    } });
    await probe.dispatch({ method });
    assert.deepEqual(calls, [method]);
    assert.deepEqual(probe.messages.at(-1), { result: { status: 'success', error: false,
      response: { data: { status: 'COMPLETE', error: false } } } });
  }
});

test('worker rejects methods outside the explicit runtime allowlist', async () => {
  const probe = workerWith(new Proxy({}, { get() { throw new Error('Unexpected SDK call'); } }));
  for (const method of ['getVehicleDetails', 'setChargeLevelTarget', 'unlockTrunk', 'constructor']) {
    await probe.dispatch({ method });
    assert.deepEqual(probe.messages.at(-1), { error: 'COMMAND_FAILED' });
  }
});
