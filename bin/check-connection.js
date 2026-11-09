#!/usr/bin/env node
'use strict';

const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { loadCredentials } = require('../lib/credentials');
const { createClient } = require('../lib/sdk');
const { isComplete, failure } = require('../lib/controller');
const { parseOptions, PATH_HELP } = require('./options');

const SUMMARIES = Object.freeze({
  inspect: 'OnStar vehicle connection verified.',
  unlock: 'Door-unlock command completed.',
  lock: 'Door-lock command completed.',
});
const USAGE = `Usage: cadillac-onstar-check [inspect|unlock|lock] [options]

The default inspect action reads vehicle details. Lock and unlock send the named
door command only when explicitly selected. Start and stop are not supported.
${PATH_HELP}`;

function parseArgs(args, context) {
  return parseOptions(args, { ...context, action: true });
}

function run(args, createWorker = (options) => new Worker(__filename, {
  workerData: options, stdout: true, stderr: true,
})) {
  // Validate before creating any worker, reading credentials, or loading the SDK.
  const options = parseArgs(args);
  if (options.help) return Promise.resolve(USAGE);
  return new Promise((resolve, reject) => {
    let worker;
    try { worker = createWorker(options); }
    catch { reject(failure('CHECK_FAILED')); return; }
    worker.stdout.resume();
    worker.stderr.resume();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      Promise.resolve().then(() => worker.terminate()).then(() => {
        if (ok) resolve(SUMMARIES[options.action]);
        else reject(failure('CHECK_FAILED'));
      }, () => reject(failure('CHECK_FAILED')));
    };
    worker.on('message', (message) => finish(message?.ok === true));
    worker.on('error', () => finish(false));
    worker.on('exit', () => finish(false));
  });
}

async function runWorker(options) {
  try {
    // A second allowlist check also protects direct worker invocation.
    const { action, credentialsFile, browserPath } = parseArgs([
      options?.action, '--credentials-file', options?.credentialsFile,
      '--state-dir', options?.stateDir, '--browser-path', options?.browserPath,
    ]);
    const config = loadCredentials(credentialsFile);
    process.env.PLAYWRIGHT_BROWSERS_PATH = browserPath;
    const client = createClient(config);
    if (action === 'inspect') {
      const result = await client.getVehicleDetails();
      const details = result?.data?.vehicleDetails;
      if (!details || typeof details !== 'object' || Array.isArray(details)
        || Object.keys(details).length === 0) throw failure('CHECK_FAILED');
      if (details.vin !== undefined && (typeof details.vin !== 'string'
        || details.vin.toUpperCase() !== config.vin.toUpperCase())) throw failure('CHECK_FAILED');
    } else {
      const result = action === 'unlock' ? await client.unlockDoor() : await client.lockDoor();
      if (!isComplete(result)) throw failure('CHECK_FAILED');
    }
    parentPort.postMessage({ ok: true });
  } catch {
    parentPort.postMessage({ ok: false });
  }
}

if (require.main === module) {
  if (isMainThread) {
    Promise.resolve().then(() => run(process.argv.slice(2))).then(
      (summary) => { process.stdout.write(summary + '\n'); },
      (error) => {
        process.stderr.write(error?.code === 'INVALID_ARGUMENTS'
          ? USAGE + '\n'
          : 'OnStar check could not be confirmed. Check private credentials and the myCadillac app.\n');
        process.exitCode = 1;
      },
    );
  } else {
    void runWorker(workerData);
  }
}

module.exports = { parseArgs, run, USAGE };
