'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { mock, test } = require('node:test');
const workerThreads = require('node:worker_threads');

// The client boundary is exercised without loading OnStarJS or opening a socket.
class FakeWorker extends EventEmitter {
  static instances = [];

  constructor(filename, options) {
    super();
    this.filename = filename;
    this.options = options;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.messages = [];
    this.terminated = false;
    FakeWorker.instances.push(this);
  }

  postMessage(message) { this.messages.push(message); }
  async terminate() { this.terminated = true; return 0; }
}

const mockedWorker = mock.method(workerThreads, 'Worker', function (...args) {
  return new FakeWorker(...args);
});
const { createClient } = require('../lib/client');
mockedWorker.mock.restore();

async function readyClient() {
  const promise = createClient('/synthetic/private/credentials.json');
  const worker = FakeWorker.instances.at(-1);
  worker.emit('message', { ready: true });
  return { client: await promise, worker };
}

test('creating and shutting down the isolated client sends no vehicle command', async () => {
  const { client, worker } = await readyClient();
  assert.equal(worker.options.stdout, true);
  assert.equal(worker.options.stderr, true);
  assert.equal(worker.stdout.readableFlowing, true);
  assert.equal(worker.stderr.readableFlowing, true);
  assert.deepEqual(worker.messages, []);
  await client.shutdown();
  assert.equal(worker.terminated, true);
  assert.deepEqual(worker.messages, []);
});

test('a worker crash rejects an in-flight command without restarting or replaying it', async (t) => {
  for (const event of ['error', 'exit']) {
    await t.test(event, async () => {
      const { client, worker } = await readyClient();
      const initialWorkerCount = FakeWorker.instances.length;
      const command = client.start();
      assert.deepEqual(worker.messages, [{ method: 'start' }]);
      worker.emit(event, event === 'error' ? new Error('secret-worker-token') : 1);
      await assert.rejects(command, (error) => {
        assert.equal(error.code, 'COMMAND_FAILED');
        assert.equal(`${error}\n${error.stack}\n${JSON.stringify(error)}`.includes('secret-worker-token'), false);
        return true;
      });
      await assert.rejects(client.start(), { code: 'COMMAND_FAILED' });
      await assert.rejects(client.unlockDoor(), { code: 'COMMAND_FAILED' });
      assert.equal(FakeWorker.instances.length, initialWorkerCount);
      assert.deepEqual(worker.messages, [{ method: 'start' }]);
      await client.shutdown();
    });
  }
});

test('worker initialization errors are sanitized and never trigger a command', async () => {
  const initializing = createClient('/synthetic/private/credentials.json');
  const worker = FakeWorker.instances.at(-1);
  worker.emit('error', new Error('username=secret-user password=secret-password'));
  await assert.rejects(initializing, (error) => {
    assert.equal(error.code, 'CREDENTIALS');
    const visible = `${error}\n${error.stack}\n${JSON.stringify(error)}`;
    assert.equal(visible.includes('secret-user'), false);
    assert.equal(visible.includes('secret-password'), false);
    return true;
  });
  assert.deepEqual(worker.messages, []);
});

test('worker failure responses reject once and are never retried automatically', async () => {
  const { client, worker } = await readyClient();
  const command = client.unlockDoor();
  worker.emit('message', { error: 'COMMAND_FAILED' });
  await assert.rejects(command, { code: 'COMMAND_FAILED' });
  await Promise.resolve();
  assert.deepEqual(worker.messages, [{ method: 'unlockDoor' }]);
  await client.shutdown();
});

test('worker transport rejects concurrent requests without queuing them', async () => {
  const { client, worker } = await readyClient();
  const command = client.lockDoor();
  await assert.rejects(client.unlockDoor(), { code: 'COMMAND_FAILED' });
  const result = { status: 'success', response: { data: { status: 'SUCCESS' } } };
  worker.emit('message', { result });
  assert.deepEqual(await command, result);
  await Promise.resolve();
  assert.deepEqual(worker.messages, [{ method: 'lockDoor' }]);
  await client.shutdown();
});

function fakeClock() {
  const timers = new Map(); let next = 0;
  return { timers, setTimer: (callback, delay) => { const id = ++next; timers.set(id, { callback, delay }); return id; },
    clearTimer: (id) => timers.delete(id) };
}

test('location and alert methods dispatch only their explicit names', async () => {
  const { client, worker } = await readyClient();
  for (const method of ['location', 'alert', 'cancelAlert']) {
    const request = client[method]();
    assert.deepEqual(worker.messages.at(-1), { method });
    const result = method === 'location' ? { latitude: 12, longitude: 34, observedAt: 1000 } : { status: 'success' };
    worker.emit('message', { result }); assert.deepEqual(await request, result);
  }
  client.shutdown();
});

test('a hung location read times out and closes the worker without replay or late result delivery', async () => {
  const clock = fakeClock();
  const creating = createClient('/synthetic/credentials.json', undefined, clock);
  const worker = FakeWorker.instances.at(-1);
  assert.equal([...clock.timers.values()][0].delay, 15000);
  worker.emit('message', { ready: true }); const client = await creating;
  assert.equal(clock.timers.size, 0);
  const request = client.location();
  const rejected = assert.rejects(request, { code: 'COMMAND_FAILED' });
  assert.equal([...clock.timers.values()][0].delay, 35000);
  [...clock.timers.values()][0].callback();
  await rejected;
  assert.equal(worker.terminated, true); assert.equal(client.closed, true);
  worker.emit('message', { result: { latitude: 1, longitude: 2, observedAt: 3 } });
  await assert.rejects(client.lockDoor(), { code: 'COMMAND_FAILED' });
  assert.deepEqual(worker.messages, [{ method: 'location' }]);
  assert.equal(clock.timers.size, 0);
});

test('startup deadline closes a worker that never becomes ready', async () => {
  const clock = fakeClock();
  const request = createClient('/synthetic/credentials.json', undefined, clock);
  const rejected = assert.rejects(request, { code: 'CREDENTIALS' });
  [...clock.timers.values()][0].callback(); await rejected;
  assert.equal(FakeWorker.instances.at(-1).terminated, true);
  assert.equal(clock.timers.size, 0);
});

test('only the allowlisted unavailable-location code survives the worker boundary', async () => {
  const { client, worker } = await readyClient();
  for (const [code, expected] of [['LOCATION_UNAVAILABLE', 'LOCATION_UNAVAILABLE'], ['SECRET_RAW_ERROR', 'COMMAND_FAILED']]) {
    const request = client.location();
    worker.emit('message', { error: code });
    await assert.rejects(request, { code: expected });
  }
  await client.shutdown();
});
