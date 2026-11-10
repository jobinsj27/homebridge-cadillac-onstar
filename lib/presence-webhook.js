'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { timingSafeEqual } = require('node:crypto');

const MAX_BODY_BYTES = 4096;
const failure = (code) => Object.assign(new Error('Presence webhook unavailable.'), { code });
const owned = stat => typeof process.getuid !== 'function' || stat.uid === process.getuid();

function loadToken(filename) {
  let descriptor;
  try {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error();
    const directory = fs.lstatSync(path.dirname(filename));
    if (!directory.isDirectory() || directory.isSymbolicLink()
        || (directory.mode & 0o777) !== 0o700 || !owned(directory)) throw new Error();
    const before = fs.lstatSync(filename);
    if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o777) !== 0o600 || !owned(before)) throw new Error();
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
        || (opened.mode & 0o777) !== 0o600 || !owned(opened) || opened.size < 32 || opened.size > 258) throw new Error();
    // Bound the read even if another process replaces or grows this file.
    const bytes = Buffer.alloc(259);
    const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    const source = bytes.subarray(0, count).toString('utf8');
    if (!/^[A-Za-z0-9_-]{32,256}(?:\r?\n)?$/.test(source)) throw new Error();
    return Buffer.from(source.trimEnd(), 'ascii');
  } catch {
    throw failure('WEBHOOK_TOKEN');
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* Do not expose filesystem errors. */ }
    }
  }
}

class PresenceWebhook {
  constructor({ host = '127.0.0.1', port = 8584, tokenFile, onEvent, onError = () => {} } = {}) {
    if (typeof host !== 'string' || net.isIP(host) === 0
        || !Number.isInteger(port) || port < 0 || port > 65535
        || typeof onEvent !== 'function' || typeof onError !== 'function') throw failure('WEBHOOK_CONFIG');
    this.host = host;
    this.port = port;
    this.tokenFile = tokenFile;
    this.onEvent = onEvent;
    this.onError = onError;
    this.closed = false;
    this.server = null;
    this.starting = null;
    this.stopping = null;
  }

  async start() {
    if (this.closed) throw failure('WEBHOOK_CLOSED');
    if (this.starting) return this.starting;
    const token = loadToken(this.tokenFile);
    this.abortController = new AbortController();
    const server = http.createServer({ maxHeaderSize: 8192 }, (request, response) => {
      this.handle(request, response, token);
    });
    this.server = server;
    server.requestTimeout = 10000;
    server.headersTimeout = 10000;
    server.keepAliveTimeout = 1000;
    server.maxConnections = 32;
    server.maxRequestsPerSocket = 100;
    server.setTimeout(10000, socket => socket.destroy());
    server.on('clientError', (_error, socket) => {
      if (socket.writable && socket.bytesWritten === 0) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      } else if (socket.writable) socket.end();
      else socket.destroy();
    });
    this.starting = new Promise((resolve, reject) => {
      let started = false;
      this.cancelStart = () => reject(failure('WEBHOOK_CLOSED'));
      server.on('error', () => {
        if (this.closed) return;
        const error = failure('WEBHOOK_LISTEN');
        if (!started) {
          reject(error);
          return;
        }
        try { Promise.resolve(this.onError(error)).catch(() => {}); }
        catch { /* A diagnostic callback cannot expose or crash the listener. */ }
      });
      try {
        server.listen({ host: this.host, port: this.port, signal: this.abortController.signal }, () => {
          if (this.closed) {
            server.close();
            reject(failure('WEBHOOK_CLOSED'));
            return;
          }
          started = true;
          this.cancelStart = null;
          server.unref();
          resolve(server.address());
        });
      } catch { reject(failure('WEBHOOK_LISTEN')); }
    });
    return this.starting;
  }

  handle(request, response, token) {
    const reply = (status, body) => {
      if (response.writableEnded || response.destroyed) return;
      response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Connection': 'close',
        ...(status === 405 ? { Allow: 'POST' } : {}),
      });
      response.end(JSON.stringify(body));
    };
    request.on('error', () => reply(400, { accepted: false }));
    if (this.closed) { reply(503, { accepted: false }); return; }
    // Authentication happens before body listeners are attached. Neither query
    // parameters nor SMS/email contents can supply credentials.
    const authorization = request.headers.authorization;
    const authorizationCount = request.rawHeaders.reduce((count, value, index) =>
      count + Number(index % 2 === 0 && value.toLowerCase() === 'authorization'), 0);
    const supplied = typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? Buffer.from(authorization.slice(7), 'utf8') : Buffer.alloc(0);
    if (authorizationCount !== 1 || supplied.length !== token.length || !timingSafeEqual(supplied, token)) {
      reply(401, { accepted: false });
      return;
    }
    if (request.url !== '/presence/event') { reply(404, { accepted: false }); return; }
    if (request.method !== 'POST') { reply(405, { accepted: false }); return; }
    if (!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(request.headers['content-type'] || '')) {
      reply(415, { accepted: false });
      return;
    }
    const length = request.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
      reply(413, { accepted: false });
      return;
    }
    let size = 0;
    let rejected = false;
    const chunks = [];
    request.on('data', (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        chunks.length = 0;
        reply(413, { accepted: false });
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (rejected || response.writableEnded || response.destroyed) return;
      if (this.closed) { reply(503, { accepted: false }); return; }
      let event;
      try { event = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { reply(400, { accepted: false }); return; }
      try {
        const result = this.onEvent(event);
        if (result && typeof result.then === 'function') {
          // The state store commits synchronously before an event is accepted.
          // Do not silently acknowledge an unexpected async handler.
          Promise.resolve(result).catch(() => {});
          throw new Error();
        }
        reply(200, { accepted: result !== false && result?.accepted !== false });
      } catch (error) {
        const statuses = { EVENT_INVALID: 400, EVENT_STALE: 409, EVENT_STORE: 503 };
        const status = Object.hasOwn(statuses, error?.code) ? statuses[error.code] : 500;
        reply(status, { accepted: false });
      }
    });
  }

  async shutdown() {
    if (this.stopping) return this.stopping;
    this.closed = true;
    this.cancelStart?.();
    this.cancelStart = null;
    this.abortController?.abort();
    const server = this.server;
    if (!server) return;
    this.stopping = new Promise(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    return this.stopping;
  }
}

module.exports = { PresenceWebhook };
