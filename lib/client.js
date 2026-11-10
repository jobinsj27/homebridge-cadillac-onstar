'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { failure } = require('./controller');
const LOCATION_TIMEOUT_MS = 120000;

// The upstream library writes raw auth errors and request URLs to console.
// Isolate and discard its output rather than changing Homebridge's console.
function createClient(credentialsFile, browserPath, {
  setTimer = setTimeout, clearTimer = clearTimeout,
  readyTimeoutMs = 15000, locationTimeoutMs = LOCATION_TIMEOUT_MS, commandTimeoutMs = 120000,
} = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'worker.js'), {
      workerData: { credentialsFile, browserPath }, stdout: true, stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    let pending;
    let ready = false;
    let closed = false;
    let startupTimer;
    let termination;
    const fail = () => {
      closed = true;
      clearTimer(startupTimer);
      clearTimer(pending?.timer);
      if (!ready) reject(failure('CREDENTIALS'));
      pending?.reject(failure('COMMAND_FAILED'));
      pending = undefined;
    };
    worker.on('error', fail);
    worker.on('exit', fail);
    const terminate = () => {
      if (!termination) {
        fail();
        termination = Promise.resolve().then(() => worker.terminate()).catch(() => {});
      }
      return termination;
    };
    startupTimer = setTimer(terminate, readyTimeoutMs);
    startupTimer?.unref?.();
    const client = { get closed() { return closed; }, shutdown: terminate };
    for (const method of ['start', 'cancelStart', 'lockDoor', 'unlockDoor', 'alert', 'cancelAlert', 'location']) {
      client[method] = () => new Promise((resolveCommand, rejectCommand) => {
        if (closed || pending) return rejectCommand(failure('COMMAND_FAILED'));
        pending = { method, resolve: resolveCommand, reject: rejectCommand };
        // A hung library request must never hold the vehicle's shared gate
        // forever. Closing the worker also prevents late response cross-talk.
        pending.timer = setTimer(terminate, method === 'location' ? locationTimeoutMs : commandTimeoutMs);
        pending.timer?.unref?.();
        try { worker.postMessage({ method }); } catch { terminate(); }
      });
    }
    worker.on('message', (message) => {
      if (closed) return;
      if (message.ready) { clearTimer(startupTimer); ready = true; resolve(client); return; }
      if (message.error === 'CREDENTIALS') { terminate(); return; }
      const request = pending;
      pending = undefined;
      clearTimer(request?.timer);
      if (message.error) request?.reject(failure(request?.method === 'location'
        && ['LOCATION_UNAVAILABLE', 'LOCATION_PENDING'].includes(message.error)
        ? message.error : 'COMMAND_FAILED'));
      else request?.resolve(message.result);
    });
  });
}

module.exports = { createClient, LOCATION_TIMEOUT_MS };
