'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { assertSupportedSource, secureTokenWrites, SAVED_SESSION_PATCH, PINNED_VERSION } = require('../lib/sdk');

const identity = {
  username: 'synthetic@example.test',
  deviceId: '8e934cd0-8093-4bee-9ac4-5034e02f7548',
  tokenLocation: '/synthetic/private/tokens',
};

function patchedSdk(overrides = {}, filesystem = { existsSync: () => false }) {
  const browserCalls = [];
  const output = [];
  const hooks = {
    browser: (method) => { browserCalls.push(method); },
    authenticate: async () => ({ access_token: 'secret-access-token' }),
    decode: () => ({ vehs: ['1GYS4RKL0PR123456'] }),
    ...overrides,
  };
  const context = vm.createContext({
    hooks, fs: filesystem, path,
    console: {
      log: (...args) => output.push(args), warn: (...args) => output.push(args),
      error: (...args) => output.push(args), debug: (...args) => output.push(args),
    },
  });
  vm.runInContext(`
    class GMAuth {
      constructor(config) { this.config = config; }
      authenticate() { return hooks.authenticate(this); }
      async doFullAuthSequence() { return hooks.browser('doFullAuthSequence'); }
      async initBrowser() { return hooks.browser('initBrowser'); }
      async submitCredentials() { return hooks.browser('submitCredentials'); }
    }
    const jwt = { decode: (token) => hooks.decode(token) };
    let getGMAPIJWT = async () => { throw new Error('Original login wrapper must never run'); };
    ${SAVED_SESSION_PATCH}
    globalThis.sdk = { GMAuth, getGMAPIJWT };
  `, context);
  return { ...context.sdk, browserCalls, output };
}

test('SDK versions and source changes fail closed before any bundle is compiled', () => {
  assert.equal(PINNED_VERSION, '2.16.7');
  for (const version of ['2.16.6', '2.16.8', undefined]) {
    assert.throws(() => assertSupportedSource('untrusted bundle', version), { code: 'SDK_UNSUPPORTED' });
  }
  assert.throws(() => assertSupportedSource('altered bundle', PINNED_VERSION), { code: 'SDK_UNSUPPORTED' });
});

function temporaryTokenDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'onstar-token-modes-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const tokenWriterSource = `
class TokenWriter {
  constructor(directory) {
    this.MSTokenPath = path.join(directory, 'microsoft_tokens.json');
    this.GMTokenPath = path.join(directory, 'gm_tokens.json');
    this.currentGMAPIToken = { access_token: 'synthetic-gm-token' };
  }
  initialMicrosoftToken(tokenSet) {
    fs.writeFileSync(this.MSTokenPath, JSON.stringify(tokenSet));
  }
  refreshedMicrosoftToken(tokenSet) {
    fs.writeFileSync(this.MSTokenPath, JSON.stringify(tokenSet));
  }
  saveGMToken() {
    const tokenFilePath = this.GMTokenPath;
    fs.writeFileSync(tokenFilePath, JSON.stringify(this.currentGMAPIToken));
  }
}
globalThis.TokenWriter = TokenWriter;
`;

test('both Microsoft write paths and the GM write path create private token files', (t) => {
  const directory = temporaryTokenDirectory(t);
  const context = vm.createContext({ fs, path });
  vm.runInContext(secureTokenWrites(tokenWriterSource), context);
  const writer = new context.TokenWriter(directory);
  writer.initialMicrosoftToken({ access_token: 'synthetic-initial-ms-token' });
  assert.equal(fs.statSync(writer.MSTokenPath).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(writer.MSTokenPath, 'utf8')).access_token, 'synthetic-initial-ms-token');
  fs.unlinkSync(writer.MSTokenPath);
  writer.refreshedMicrosoftToken({ access_token: 'synthetic-refreshed-ms-token' });
  assert.equal(fs.statSync(writer.MSTokenPath).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(writer.MSTokenPath, 'utf8')).access_token, 'synthetic-refreshed-ms-token');
  writer.saveGMToken();
  assert.equal(fs.statSync(writer.GMTokenPath).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(writer.GMTokenPath, 'utf8')).access_token, 'synthetic-gm-token');
});

test('existing Microsoft and GM token files become private before authentication reads them', async (t) => {
  const directory = temporaryTokenDirectory(t);
  const contents = '{"access_token":"synthetic-existing-token"}';
  const filenames = ['microsoft_tokens.json', 'gm_tokens.json'].map((name) => path.join(directory, name));
  for (const filename of filenames) {
    fs.writeFileSync(filename, contents, { mode: 0o644 });
    fs.chmodSync(filename, 0o644);
  }
  let authenticated = false;
  const sdk = patchedSdk({ authenticate: async () => {
    authenticated = true;
    for (const filename of filenames) {
      assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
      assert.equal(fs.readFileSync(filename, 'utf8'), contents);
    }
    return { access_token: 'synthetic-existing-token' };
  } }, fs);
  await sdk.getGMAPIJWT({ ...identity, tokenLocation: directory });
  assert.equal(authenticated, true);
  assert.deepEqual(sdk.browserCalls, []);
  assert.deepEqual(sdk.output, []);
});

test('token write patches reject unexpected source shapes without creating a partial patch', () => {
  const microsoftWrite = 'fs.writeFileSync(this.MSTokenPath, JSON.stringify(tokenSet));';
  const gmWrite = 'fs.writeFileSync(tokenFilePath, JSON.stringify(this.currentGMAPIToken));';
  for (const source of [
    '',
    tokenWriterSource.replace(microsoftWrite, ''),
    tokenWriterSource + microsoftWrite,
    tokenWriterSource.replace(gmWrite, ''),
    tokenWriterSource + gmWrite,
  ]) {
    assert.throws(() => secureTokenWrites(source), { code: 'SDK_UNSUPPORTED' });
  }
});

test('the production loader refuses unsupported bundles without compiling or falling back to the original SDK', () => {
  const loaderSource = fs.readFileSync(path.join(__dirname, '../lib/sdk.js'), 'utf8');
  for (const version of ['unsupported', PINNED_VERSION]) {
    let compilations = 0;
    let originalLoads = 0;
    class FakeModule {
      static _nodeModulePaths() { return []; }
      _compile() { compilations += 1; throw new Error('Unsupported source must never execute'); }
    }
    const fakeRequire = (name) => {
      if (name === 'node:fs') return { readFileSync: (filename) => filename.endsWith('package.json')
        ? JSON.stringify({ version }) : 'untrusted SDK source secret-token' };
      if (name === 'node:module') return FakeModule;
      if (name === './controller') return require('../lib/controller');
      if (name === 'onstarjs2') { originalLoads += 1; throw new Error('No original SDK fallback'); }
      return require(name);
    };
    fakeRequire.resolve = () => '/synthetic/onstarjs2/dist/index.js';
    const fakeModule = { exports: {} };
    vm.runInNewContext(`(function(require, module, exports) { ${loaderSource}\n})(require, module, module.exports)`, {
      require: fakeRequire, module: fakeModule,
    });
    assert.throws(() => fakeModule.exports.createClient({ ...identity, authMode: 'savedSession' }), (error) => {
      assert.equal(error.code, 'SDK_UNSUPPORTED');
      assert.equal(`${error}\n${error.stack}\n${JSON.stringify(error)}`.includes('secret-token'), false);
      return true;
    });
    assert.equal(compilations, 0);
    assert.equal(originalLoads, 0);
  }
});

test('saved authentication succeeds using identity and a saved token without login secrets', async () => {
  let authenticated = 0;
  const sdk = patchedSdk({ authenticate: async () => {
    authenticated += 1;
    return { access_token: 'secret-access-token' };
  } });
  const result = await sdk.getGMAPIJWT(identity);
  assert.equal(authenticated, 1);
  assert.equal(result.token.access_token, 'secret-access-token');
  assert.equal(result.auth.config.username, identity.username);
  assert.deepEqual(Array.from(result.decodedPayload.vehs), ['1GYS4RKL0PR123456']);
  assert.deepEqual(sdk.browserCalls, []);
  assert.deepEqual(sdk.output, []);
});

test('every browser or credential-entry method is disabled and cannot be replaced', async () => {
  const sdk = patchedSdk();
  const auth = new sdk.GMAuth(identity);
  for (const method of ['doFullAuthSequence', 'initBrowser', 'submitCredentials']) {
    await assert.rejects(Promise.resolve().then(() => auth[method]()), { code: 'SESSION_REQUIRED' });
    const descriptor = Object.getOwnPropertyDescriptor(sdk.GMAuth.prototype, method);
    assert.equal(descriptor.writable, false);
    assert.equal(descriptor.configurable, false);
  }
  assert.deepEqual(sdk.browserCalls, []);
  assert.deepEqual(sdk.output, []);
});

test('expired saved sessions reject instead of falling back to browser login', async () => {
  const sdk = patchedSdk({ authenticate: (auth) => auth.doFullAuthSequence() });
  await assert.rejects(sdk.getGMAPIJWT(identity), (error) => {
    assert.equal(error.code, 'SESSION_REQUIRED');
    assert.equal(`${error}\n${error.stack}\n${JSON.stringify(error)}`.includes('secret-'), false);
    return true;
  });
  assert.deepEqual(sdk.browserCalls, []);
  assert.deepEqual(sdk.output, []);
});

test('missing identity or invalid decoded session data is rejected without browser fallback', async () => {
  const sdk = patchedSdk();
  for (const key of Object.keys(identity)) {
    await assert.rejects(sdk.getGMAPIJWT({ ...identity, [key]: undefined }), { code: 'CREDENTIALS' });
  }
  const invalid = patchedSdk({ decode: () => ({ account: 'secret-account-data' }) });
  await assert.rejects(invalid.getGMAPIJWT(identity), { code: 'SESSION_REQUIRED' });
  assert.deepEqual(sdk.browserCalls, []);
  assert.deepEqual(invalid.browserCalls, []);
  assert.deepEqual(sdk.output, []);
  assert.deepEqual(invalid.output, []);
});

test('an incompatible SDK authentication class cannot silently bypass the guards', () => {
  const context = vm.createContext({});
  assert.throws(() => vm.runInContext(`
    class GMAuth {}
    let getGMAPIJWT = async () => {};
    const jwt = {};
    ${SAVED_SESSION_PATCH}
  `, context), { code: 'SDK_UNSUPPORTED' });
});
