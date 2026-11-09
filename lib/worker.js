'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const path = require('node:path');
const { loadCredentials } = require('./credentials');
const { createClient } = require('./sdk');

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
parentPort.on('message', async ({ method }) => {
  if (!client || busy || !['start', 'cancelStart', 'lockDoor', 'unlockDoor'].includes(method)) {
    parentPort.postMessage({ error: 'COMMAND_FAILED' });
    return;
  }
  busy = true;
  try {
    const result = await client[method]();
    const data = result?.response?.data;
    // Only statuses cross back into Homebridge, never the response/error object.
    parentPort.postMessage({ result: {
      status: result?.status,
      error: Boolean(result?.error),
      response: { data: {
        status: data?.status,
        error: Boolean(data?.error),
        ...(data?.commandResponse ? { commandResponse: {
          status: data.commandResponse.status,
          error: Boolean(data.commandResponse.error || data.commandResponse.body?.error),
        } } : {}),
      } },
    } });
  } catch {
    parentPort.postMessage({ error: 'COMMAND_FAILED' });
  } finally {
    busy = false;
  }
});
