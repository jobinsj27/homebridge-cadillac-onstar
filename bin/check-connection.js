#!/usr/bin/env node
'use strict';

const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { loadCredentials } = require('../lib/credentials');
const { createClient } = require('../lib/sdk');
const { isComplete, failure } = require('../lib/controller');
const { normalizeLocationResult } = require('../lib/location');
const { ACTIONS, parseOptions, PATH_HELP } = require('./options');

const CHECK_TIMEOUT_MS = 120000;
const LOCATION_MAX_AGE_MS = 600000;

const SUMMARIES = Object.freeze({
  inspect: 'OnStar vehicle connection verified.',
  unlock: 'Door-unlock command completed.',
  lock: 'Door-lock command completed.',
});
const USAGE = `Usage: cadillac-onstar-check [inspect|location|unlock|lock] [options]

The default inspect action reads vehicle details. Location requests telemetry and
reports observation age only, without coordinates. Lock and unlock send the named
door command only when explicitly selected. Engine and alert actions are not supported.
${PATH_HELP}`;

function parseArgs(args, context) {
  return parseOptions(args, { ...context, action: true });
}

function run(args, createWorker = (options) => new Worker(__filename, {
  workerData: options, stdout: true, stderr: true,
}), { now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
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
    let deadline;
    const finish = (summary) => {
      if (settled) return;
      settled = true;
      clearTimer(deadline);
      Promise.resolve().then(() => worker.terminate()).then(() => {
        if (summary) resolve(summary);
        else reject(failure('CHECK_FAILED'));
      }, () => reject(failure('CHECK_FAILED')));
    };
    worker.on('message', (message) => {
      if (message?.ok !== true) return finish();
      if (options.action !== 'location') return finish(SUMMARIES[options.action]);
      const observedAt = message.location?.observedAt;
      const currentTime = now();
      if (typeof observedAt !== 'number' || !Number.isFinite(observedAt) || observedAt <= 0
        || !Number.isFinite(currentTime) || observedAt > currentTime) return finish();
      const ageMs = currentTime - observedAt;
      const state = ageMs <= LOCATION_MAX_AGE_MS ? 'FRESH' : 'STALE';
      finish(`OnStar location verified: ${state}; observation age ${Math.floor(ageMs / 1000)} seconds.`);
    });
    worker.on('error', () => finish());
    worker.on('exit', () => finish());
    deadline = setTimer(() => finish(), CHECK_TIMEOUT_MS);
    deadline?.unref?.();
  });
}

async function performCheck(action, client, vin) {
  if (!ACTIONS.includes(action)) throw failure('CHECK_FAILED');
  if (action === 'inspect') {
    const result = await client.getVehicleDetails();
    const details = result?.data?.vehicleDetails;
    if (!details || typeof details !== 'object' || Array.isArray(details)
      || Object.keys(details).length === 0) throw failure('CHECK_FAILED');
    if (details.vin !== undefined && (typeof details.vin !== 'string'
      || details.vin.toUpperCase() !== vin.toUpperCase())) throw failure('CHECK_FAILED');
  } else if (action === 'location') {
    const location = normalizeLocationResult(await client.location());
    // Coordinates never leave this CLI worker, even after a valid response.
    return { ok: true, location: { observedAt: location.observedAt } };
  } else {
    const result = action === 'unlock' ? await client.unlockDoor() : await client.lockDoor();
    if (!isComplete(result)) throw failure('CHECK_FAILED');
  }
  return { ok: true };
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
    parentPort.postMessage(await performCheck(action, client, config.vin));
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

module.exports = { parseArgs, run, performCheck, USAGE, CHECK_TIMEOUT_MS };
