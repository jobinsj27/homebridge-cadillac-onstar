'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { failure } = require('./controller');

// The upstream library writes raw auth errors and request URLs to console.
// Isolate and discard its output rather than changing Homebridge's console.
function createClient(credentialsFile, browserPath) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'worker.js'), {
      workerData: { credentialsFile, browserPath }, stdout: true, stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    let pending;
    let ready = false;
    let closed = false;
    const fail = () => {
      closed = true;
      if (!ready) reject(failure('CREDENTIALS'));
      pending?.reject(failure('COMMAND_FAILED'));
      pending = undefined;
    };
    worker.on('error', fail);
    worker.on('exit', fail);
    const client = { shutdown: () => { fail(); void worker.terminate(); } };
    for (const method of ['start', 'cancelStart', 'lockDoor', 'unlockDoor']) {
      client[method] = () => new Promise((resolveCommand, rejectCommand) => {
        if (closed || pending) return rejectCommand(failure('COMMAND_FAILED'));
        pending = { resolve: resolveCommand, reject: rejectCommand };
        worker.postMessage({ method });
      });
    }
    worker.on('message', (message) => {
      if (message.ready) { ready = true; resolve(client); return; }
      if (message.error === 'CREDENTIALS') { fail(); void worker.terminate(); return; }
      const request = pending;
      pending = undefined;
      if (message.error) request?.reject(failure('COMMAND_FAILED'));
      else request?.resolve(message.result);
    });
  });
}

module.exports = { createClient };
