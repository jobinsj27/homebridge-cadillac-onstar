'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { parseArgs, run } = require('../bin/check-connection');

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

test('connection check defaults to inspect and only accepts inspect, unlock, or lock', () => {
  assert.deepEqual(parseArgs([], { env: {}, home: '/example/home' }), {
    action: 'inspect',
    credentialsFile: '/example/home/.homebridge/cadillac-onstar/credentials.json',
    stateDir: '/example/home/.homebridge/cadillac-onstar',
    browserPath: '/example/home/.homebridge/cadillac-onstar/.cache/browsers',
  });
  for (const action of ['inspect', 'unlock', 'lock']) {
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
    ['start'], ['cancelStart'], ['stop'], ['remoteStart'], ['unlockDoor'], ['LOCK'], ['unknown'],
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
