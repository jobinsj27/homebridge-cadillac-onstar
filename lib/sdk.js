'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { failure } = require('./controller');

const PINNED_VERSION = '2.16.7';
const PINNED_SHA256 = 'e9fd6353e6977a702927b3f4386246af624dd3dfe98af42831b6617a1de39ab6';

// OnStarJS has no public saved-session-only mode. Its refresh paths normally
// fall back to browser/password/TOTP login. Patch only this exact reviewed
// bundle in memory; never require the original as a fallback.
const SAVED_SESSION_PATCH = `
if (typeof GMAuth !== 'function' || typeof getGMAPIJWT !== 'function'
    || typeof jwt.decode !== 'function') {
  throw Object.assign(new Error('SDK_UNSUPPORTED'), { code: 'SDK_UNSUPPORTED' });
}
const savedSessionRequired = () => {
  throw Object.assign(new Error('SESSION_REQUIRED'), { code: 'SESSION_REQUIRED' });
};
for (const method of ['doFullAuthSequence', 'submitCredentials', 'initBrowser']) {
  if (typeof GMAuth.prototype[method] !== 'function') {
    throw Object.assign(new Error('SDK_UNSUPPORTED'), { code: 'SDK_UNSUPPORTED' });
  }
  Object.defineProperty(GMAuth.prototype, method, {
    value: savedSessionRequired, writable: false, configurable: false,
  });
}
getGMAPIJWT = async function(config) {
  for (const key of ['username', 'deviceId', 'tokenLocation']) {
    if (typeof config?.[key] !== 'string' || !config[key].trim()) {
      throw Object.assign(new Error('CREDENTIALS'), { code: 'CREDENTIALS' });
    }
  }
  for (const name of ['microsoft_tokens.json', 'gm_tokens.json']) {
    const filename = path.join(config.tokenLocation, name);
    if (fs.existsSync(filename)) fs.chmodSync(filename, 0o600);
  }
  const auth = new GMAuth(config);
  const token = await auth.authenticate();
  const decodedPayload = jwt.decode(token?.access_token);
  if (!decodedPayload || !Array.isArray(decodedPayload.vehs)) savedSessionRequired();
  return { token, auth, decodedPayload };
};
`;

function assertSupportedSource(source, version) {
  if (version !== PINNED_VERSION || typeof source !== 'string'
    || crypto.createHash('sha256').update(source).digest('hex') !== PINNED_SHA256) {
    throw failure('SDK_UNSUPPORTED');
  }
}

function secureTokenWrites(source) {
  // Refresh writes MS tokens directly, separately from saveTokens. Protect all
  // three reviewed write sites from their first write; rename preserves mode.
  if (typeof source !== 'string') throw failure('SDK_UNSUPPORTED');
  for (const [statement, count, replacement] of [
    ['fs.writeFileSync(this.MSTokenPath, JSON.stringify(tokenSet));', 2, 'cadillacWritePrivateToken(this.MSTokenPath, tokenSet);'],
    ['fs.writeFileSync(tokenFilePath, JSON.stringify(this.currentGMAPIToken));', 1, 'cadillacWritePrivateToken(tokenFilePath, this.currentGMAPIToken);'],
  ]) {
    if (source.split(statement).length - 1 !== count) throw failure('SDK_UNSUPPORTED');
    source = source.replaceAll(statement, replacement);
  }
  // A bounded worker may be stopped during a stalled request. Never leave the
  // last saved session truncated if it stops during a token file write.
  return source + `\nfunction cadillacWritePrivateToken(filename, value) {
    const temporary = filename + '.' + Date.now() + '.' + Math.random().toString(16).slice(2) + '.tmp';
    let descriptor;
    let created = false;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      created = true;
      fs.writeFileSync(descriptor, JSON.stringify(value));
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, filename);
    } finally {
      if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} }
      if (created) { try { fs.unlinkSync(temporary); } catch {} }
    }
  }\n`;
}

let savedSessionSdk;
function loadSdk() {
  if (savedSessionSdk) return savedSessionSdk;
  try {
    const filename = require.resolve('onstarjs2');
    const source = fs.readFileSync(filename, 'utf8');
    const metadata = JSON.parse(fs.readFileSync(path.join(path.dirname(filename), '../package.json'), 'utf8'));
    assertSupportedSource(source, metadata.version);
    const isolated = new Module(filename, module);
    isolated.filename = filename;
    isolated.paths = Module._nodeModulePaths(path.dirname(filename));
    isolated._compile(secureTokenWrites(source) + '\n' + SAVED_SESSION_PATCH, filename);
    if (typeof isolated.exports.default?.create !== 'function') throw failure('SDK_UNSUPPORTED');
    savedSessionSdk = isolated.exports.default;
    return savedSessionSdk;
  } catch {
    throw failure('SDK_UNSUPPORTED');
  }
}

function createClient(config) {
  if (!config || (config.authMode !== undefined && config.authMode !== 'savedSession')) {
    throw failure('CREDENTIALS');
  }
  // Passwords, authenticator seeds, and legacy PINs never enter this runtime.
  const { vin, username, deviceId, tokenLocation } = config;
  const client = loadSdk().create({
    vin, username, deviceId, tokenLocation,
    checkRequestStatus: true, requestPollingIntervalSeconds: 6,
    requestPollingTimeoutSeconds: 90, retryOn429ForPost: false,
  });
  const location = client.location.bind(client);
  client.location = async () => {
    // Leave room for authentication and transport within the worker's 35-second
    // deadline. An incomplete refresh is rejected by the location parser.
    const service = client.requestService;
    service.setRequestPollingTimeoutSeconds(20);
    const previousRetries = service.config.max429Retries;
    service.config.max429Retries = 0;
    try { return await location(); }
    finally {
      service.setRequestPollingTimeoutSeconds(90);
      service.config.max429Retries = previousRetries;
    }
  };
  return client;
}

module.exports = { createClient, assertSupportedSource, secureTokenWrites, SAVED_SESSION_PATCH, PINNED_VERSION, PINNED_SHA256 };
