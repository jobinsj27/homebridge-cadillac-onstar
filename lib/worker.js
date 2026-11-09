'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const path = require('node:path');
const { loadCredentials } = require('./credentials');
const { createClient } = require('./sdk');
const { normalizeLocationResult } = require('./location');

let client;
try {
  const config = loadCredentials(workerData.credentialsFile);
  const browserPath = workerData.browserPath || path.join(path.dirname(workerData.credentialsFile), '.cache', 'browsers');
  if (!path.isAbsolute(browserPath)) throw new Error();
  process.env.PLAYWRIGHT_BROWSERS_PATH = browserPath;
  client = createClient(config);
  parentPort.postMessage({ ready: true });
} catch {
  parentPort.postMessage({ error: 'CREDENTIALS' });
}

let busy = false;
const safeStatus = value => typeof value === 'string'
  && ['success', 'failure', 'failed', 'complete', 'completed', 'in_progress', 'inprogress', 'in progress'].includes(value.toLowerCase())
  ? value : undefined;
parentPort.on('message', async ({ method }) => {
  if (!client || busy || !['start', 'cancelStart', 'lockDoor', 'unlockDoor', 'alert', 'cancelAlert', 'location'].includes(method)) {
    parentPort.postMessage({ error: 'COMMAND_FAILED' });
    return;
  }
  busy = true;
  try {
    const result = await client[method]();
    if (method === 'location') {
      // Only validated coordinates and their observation timestamp cross the
      // boundary. Raw telemetry, account data and SDK errors stay in the worker.
      parentPort.postMessage({ result: normalizeLocationResult(result) });
      return;
    }
    const data = result?.response?.data;
    // Only statuses cross back into Homebridge, never the response/error object.
    parentPort.postMessage({ result: {
      status: safeStatus(result?.status),
      error: Boolean(result?.error),
      response: { data: {
        status: safeStatus(data?.status),
        error: Boolean(data?.error),
        ...(data?.commandResponse ? { commandResponse: {
          status: safeStatus(data.commandResponse.status),
          error: Boolean(data.commandResponse.error || data.commandResponse.body?.error),
        } } : {}),
      } },
    } });
  } catch (error) {
    parentPort.postMessage({ error: method === 'location' && error?.code === 'LOCATION_UNAVAILABLE'
      ? 'LOCATION_UNAVAILABLE' : 'COMMAND_FAILED' });
  } finally {
    busy = false;
  }
});
