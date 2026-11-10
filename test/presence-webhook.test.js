'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { test } = require('node:test');
const { PresenceWebhook } = require('../lib/presence-webhook');

const TOKEN = 'a'.repeat(64); // Synthetic, only used by these loopback tests.
const EVENT = { eventId: 'synthetic-message-1', locationId: 'home', event: 'arrived', occurredAt: '2026-11-10T00:00:00.000Z' };

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cadillac-webhook-'));
  const tokenFile = path.join(directory, 'token');
  fs.writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const received = [];
  const server = new PresenceWebhook({
    tokenFile, port: 0,
    onEvent: event => { received.push(event); return { accepted: true }; },
    ...options,
  });
  t.after(async () => {
    await server.shutdown();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, tokenFile, server, received };
}

function send(address, { method = 'POST', pathname = '/presence/event', body = JSON.stringify(EVENT),
  headers = {}, chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: address.port, path: pathname, method,
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    request.on('error', reject);
    if (chunked) {
      request.write(body.slice(0, 2000));
      request.end(body.slice(2000));
    } else request.end(body);
  });
}

test('authenticated JSON reaches the event monitor and concurrent starts share one listener', async (t) => {
  const { server, received } = fixture(t);
  const [first, second] = await Promise.all([server.start(), server.start()]);
  assert.deepEqual(first, second);
  assert.equal(first.address, '127.0.0.1');
  const response = await send(first);
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { accepted: true });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(received, [EVENT]);
  assert.equal(response.body.includes(EVENT.eventId), false);
  assert.deepEqual(await server.start(), first);
});

test('duplicate events are acknowledged without claiming a new change', async (t) => {
  const { server } = fixture(t, { onEvent: () => ({ accepted: false, duplicate: true }) });
  const response = await send(await server.start());
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { accepted: false });
});

test('missing, incorrect, query-string and duplicate bearer credentials cannot submit events', async (t) => {
  const { server, received } = fixture(t);
  const address = await server.start();
  for (const headers of [
    { Authorization: '' },
    { Authorization: `Bearer ${'b'.repeat(64)}` },
    { Authorization: `Bearer ${'b'.repeat(32)}` },
    { Authorization: `Basic ${TOKEN}` },
    { Authorization: [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`] },
  ]) {
    const response = await send(address, { headers, body: '{invalid-json' });
    assert.equal(response.status, 401);
    assert.equal(response.body.includes(TOKEN), false);
  }
  const query = await send(address, { headers: { Authorization: '' }, pathname: `/presence/event?token=${TOKEN}` });
  assert.equal(query.status, 401);
  assert.deepEqual(received, []);
});

test('authentication is checked before accepting or waiting for any request body', async (t) => {
  const { server, received } = fixture(t);
  const address = await server.start();
  const response = await new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: address.port, path: '/presence/event', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': 4000 } }, incoming => {
      incoming.resume();
      incoming.on('end', () => resolve(incoming.statusCode));
    });
    request.setTimeout(1000, () => request.destroy(new Error('Authentication waited for a body')));
    request.on('error', reject);
    request.flushHeaders();
    // Intentionally never send the advertised body.
  });
  assert.equal(response, 401);
  assert.deepEqual(received, []);
});

test('only the exact endpoint and POST method are exposed', async (t) => {
  const { server, received } = fixture(t);
  const address = await server.start();
  assert.equal((await send(address, { pathname: '/' })).status, 404);
  assert.equal((await send(address, { pathname: '/presence/event?unexpected=1' })).status, 404);
  const get = await send(address, { method: 'GET' });
  assert.equal(get.status, 405);
  assert.equal(get.headers.allow, 'POST');
  assert.deepEqual(received, []);
});

test('non-JSON, malformed JSON and oversized bodies are rejected before the monitor', async (t) => {
  const { server, received } = fixture(t);
  const address = await server.start();
  assert.equal((await send(address, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await send(address, { body: '{invalid' })).status, 400);
  const body = JSON.stringify({ extra: 'z'.repeat(5000) });
  assert.equal((await send(address, { body, headers: { 'Content-Length': Buffer.byteLength(body) } })).status, 413);
  assert.equal((await send(address, { body, chunked: true })).status, 413);
  assert.deepEqual(received, []);
  assert.equal((await send(address, { headers: { 'Content-Type': 'application/json; charset=utf-8' } })).status, 200);
});

test('event validation, ordering and store failures return safe status codes', async (t) => {
  for (const [code, status] of [['EVENT_INVALID', 400], ['EVENT_STALE', 409], ['EVENT_STORE', 503], ['UNKNOWN', 500], ['__proto__', 500]]) {
    await t.test(code, async (child) => {
      const { server } = fixture(child, { onEvent: () => {
        throw Object.assign(new Error(`private-message ${TOKEN}`), { code });
      } });
      const response = await send(await server.start());
      assert.equal(response.status, status);
      assert.deepEqual(JSON.parse(response.body), { accepted: false });
      assert.equal(response.body.includes('private-message'), false);
      assert.equal(response.body.includes(TOKEN), false);
    });
  }
});

test('unexpected asynchronous handlers are not acknowledged and do not leak rejected promises', async (t) => {
  const { server } = fixture(t, { onEvent: async () => { throw new Error('private-message'); } });
  const response = await send(await server.start());
  assert.equal(response.status, 500);
});

test('token loading rejects public permissions, symlinks, directories, malformed data and relative paths', async (t) => {
  for (const kind of ['public', 'readonly', 'symlink', 'directory', 'parentPublic', 'parentSymlink', 'foreignOwner', 'short', 'spaces', 'json', 'large', 'relative', 'missing']) {
    await t.test(kind, async (child) => {
      const { tokenFile, directory, server } = fixture(child);
      if (kind === 'public') fs.chmodSync(tokenFile, 0o644);
      if (kind === 'readonly') fs.chmodSync(tokenFile, 0o400);
      if (kind === 'symlink') {
        const destination = path.join(directory, 'original');
        fs.renameSync(tokenFile, destination);
        fs.symlinkSync(destination, tokenFile);
      }
      if (kind === 'directory') { fs.unlinkSync(tokenFile); fs.mkdirSync(tokenFile, { mode: 0o700 }); }
      if (kind === 'parentPublic') fs.chmodSync(directory, 0o755);
      if (kind === 'parentSymlink') {
        const link = path.join(directory, 'link');
        fs.symlinkSync(directory, link);
        server.tokenFile = path.join(link, 'token');
      }
      if (kind === 'foreignOwner' && typeof process.getuid === 'function') {
        const original = fs.lstatSync;
        child.mock.method(fs, 'lstatSync', (...args) => {
          const stat = original(...args);
          stat.uid = process.getuid() + 1;
          return stat;
        });
      }
      if (kind === 'short') fs.writeFileSync(tokenFile, 'a'.repeat(31));
      if (kind === 'spaces') fs.writeFileSync(tokenFile, `${TOKEN} `);
      if (kind === 'json') fs.writeFileSync(tokenFile, JSON.stringify({ token: TOKEN }));
      if (kind === 'large') fs.writeFileSync(tokenFile, 'a'.repeat(10000));
      if (kind === 'relative') server.tokenFile = 'relative/token';
      if (kind === 'missing') fs.unlinkSync(tokenFile);
      await assert.rejects(server.start(), error => {
        assert.equal(error.code, 'WEBHOOK_TOKEN');
        assert.equal(String(error).includes(tokenFile), false);
        assert.equal(String(error).includes(TOKEN), false);
        return true;
      });
      assert.equal(server.server, null);
    });
  }
});

test('bind failures are sanitized without invoking the runtime error callback', async (t) => {
  const original = fixture(t);
  const address = await original.server.start();
  let runtimeErrors = 0;
  const conflict = fixture(t, { port: address.port, onError: () => { runtimeErrors++; } });
  await assert.rejects(conflict.server.start(), error => {
    assert.equal(error.code, 'WEBHOOK_LISTEN');
    assert.equal(String(error).includes(String(address.port)), false);
    return true;
  });
  assert.equal(runtimeErrors, 0);
});

test('runtime errors contain only a safe code and callback failures are contained', async (t) => {
  const seen = [];
  const { server } = fixture(t, { onError: async error => {
    seen.push(error);
    throw new Error('consumer diagnostic failure');
  } });
  await server.start();
  server.server.emit('error', new Error(`private-message ${TOKEN}`));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].code, 'WEBHOOK_LISTEN');
  assert.equal(String(seen[0]).includes(TOKEN), false);
});

test('shutdown is idempotent and terminal; a new instance can reuse the port', async (t) => {
  const { server } = fixture(t);
  const address = await server.start();
  await Promise.all([server.shutdown(), server.shutdown()]);
  await assert.rejects(server.start(), { code: 'WEBHOOK_CLOSED' });
  const replacement = fixture(t, { port: address.port });
  assert.equal((await send(await replacement.server.start())).status, 200);
});

test('shutdown during startup settles the startup promise and closes the listener', async (t) => {
  const { server } = fixture(t);
  const starting = server.start();
  const rejection = assert.rejects(starting, { code: 'WEBHOOK_CLOSED' });
  await server.shutdown();
  await rejection;
  assert.equal(server.server.listening, false);
});

test('invalid bind configuration fails before any listener is created', () => {
  for (const options of [{ host: 'localhost' }, { host: '' }, { port: -1 }, { port: 65536 }, { port: '8584' }, { onEvent: null }]) {
    assert.throws(() => new PresenceWebhook({ onEvent: () => {}, ...options }), { code: 'WEBHOOK_CONFIG' });
  }
});
