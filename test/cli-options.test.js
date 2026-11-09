'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseOptions } = require('../bin/options');
const { parseArgs: loginArgs } = require('../bin/manual-login');

const context = { env: {}, home: '/example/home' };

test('portable paths use Homebridge storage and explicit overrides without a homelab default', () => {
  const defaults = parseOptions([], context);
  assert.equal(defaults.stateDir, '/example/home/.homebridge/cadillac-onstar');
  assert.equal(parseOptions([], { env: { HOMEBRIDGE_STORAGE_PATH: '/example/storage' } }).stateDir,
    '/example/storage/cadillac-onstar');
  const explicit = parseOptions(['--state-dir', '/example/state', '--credentials-file', '/example/separate/account.json',
    '--browser-path', '/example/browsers'], { env: { HOMEBRIDGE_STORAGE_PATH: '/ignored' } });
  assert.deepEqual(explicit, { stateDir: '/example/state', credentialsFile: '/example/separate/account.json', browserPath: '/example/browsers' });
});

test('environment paths and credentials parent are honored with flag precedence', () => {
  const env = { HOMEBRIDGE_CADILLAC_ONSTAR_CREDENTIALS_FILE: '/example/account/credentials.json',
    PLAYWRIGHT_BROWSERS_PATH: '/example/browser-cache' };
  assert.deepEqual(parseOptions([], { env }), { stateDir: '/example/account', credentialsFile: '/example/account/credentials.json',
    browserPath: '/example/browser-cache' });
  assert.equal(parseOptions(['--state-dir', '/chosen'], { env: { ...env, HOMEBRIDGE_CADILLAC_ONSTAR_STATE_DIR: '/other' } }).stateDir, '/chosen');
});

test('ambiguous, unknown, relative, missing, duplicate, and NUL arguments are rejected', () => {
  for (const args of [null, {}, ['--unknown'], ['--state-dir'], ['--state-dir', 'relative'],
    ['--credentials-file', '~/credentials.json'], ['--state-dir', '/one', '--state-dir', '/two'],
    ['--credentials-file', '/a\0b'], ['--state-dir', '--credentials-file', '/example/file'],
    ['--help', '--state-dir', '/example'], ['inspect'], ['location'], ['--inspect-page'], ['--no-sandbox'], [42]]) {
    assert.throws(() => parseOptions(args, context), { code: 'INVALID_ARGUMENTS' });
  }
  assert.throws(() => parseOptions([], { env: { HOMEBRIDGE_STORAGE_PATH: 'relative' } }), { code: 'INVALID_ARGUMENTS' });
});

test('login-only flags are opt in and cannot smuggle an action or credentials into the CLI', () => {
  const options = loginArgs(['--inspect-page', '--state-dir', '/example/state', '--no-sandbox'], context);
  assert.equal(options.inspectOnly, true);
  assert.equal(options.noSandbox, true);
  assert.equal(loginArgs([], context).noSandbox, false);
  for (const args of [['lock'], ['start'], ['location'], ['--password', 'secret-marker'], ['--inspect-page', '--inspect-page']]) {
    assert.throws(() => loginArgs(args, context), { code: 'INVALID_ARGUMENTS' });
  }
  assert.deepEqual(loginArgs(['--help'], context), { help: true });
});

test('location is accepted only by helpers that explicitly enable check actions', () => {
  assert.equal(parseOptions(['location'], { ...context, action: true }).action, 'location');
  assert.equal(parseOptions([], { ...context, action: true }).action, 'inspect');
  for (const options of [context, { ...context, login: true }]) {
    assert.throws(() => parseOptions(['location'], options), { code: 'INVALID_ARGUMENTS' });
  }
  assert.throws(() => parseOptions(['inspect', 'location'], { ...context, action: true }),
    { code: 'INVALID_ARGUMENTS' });
});
