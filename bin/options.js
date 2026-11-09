'use strict';

const os = require('node:os');
const path = require('node:path');

const ACTIONS = Object.freeze(['inspect', 'unlock', 'lock']);

function invalidArguments() {
  return Object.assign(new Error('Invalid command-line arguments.'), { code: 'INVALID_ARGUMENTS' });
}

function absolutePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)) {
    throw invalidArguments();
  }
  return path.normalize(value);
}

function parseOptions(args, { action = false, login = false, env = process.env, home = os.homedir() } = {}) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw invalidArguments();
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true };
  const flags = new Map();
  let selectedAction;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (['--credentials-file', '--state-dir', '--browser-path'].includes(arg)) {
      if (flags.has(arg) || i + 1 >= args.length || args[i + 1].startsWith('--')) throw invalidArguments();
      flags.set(arg, absolutePath(args[++i]));
    } else if (login && ['--inspect-page', '--no-sandbox'].includes(arg)) {
      if (flags.has(arg)) throw invalidArguments();
      flags.set(arg, true);
    } else if (action && ACTIONS.includes(arg) && selectedAction === undefined) {
      selectedAction = arg;
    } else {
      throw invalidArguments();
    }
  }

  const credentialsOverride = flags.get('--credentials-file') || env.HOMEBRIDGE_CADILLAC_ONSTAR_CREDENTIALS_FILE;
  const storage = env.HOMEBRIDGE_STORAGE_PATH || path.join(home, '.homebridge');
  const stateDir = absolutePath(flags.get('--state-dir') || env.HOMEBRIDGE_CADILLAC_ONSTAR_STATE_DIR
    || (credentialsOverride ? path.dirname(absolutePath(credentialsOverride)) : path.join(absolutePath(storage), 'cadillac-onstar')));
  const credentialsFile = absolutePath(credentialsOverride || path.join(stateDir, 'credentials.json'));
  const browserPath = absolutePath(flags.get('--browser-path') || env.PLAYWRIGHT_BROWSERS_PATH
    || path.join(stateDir, '.cache', 'browsers'));
  return {
    credentialsFile, stateDir, browserPath,
    ...(action ? { action: selectedAction || 'inspect' } : {}),
    ...(login ? { inspectOnly: flags.has('--inspect-page'), noSandbox: flags.has('--no-sandbox') } : {}),
  };
}

const PATH_HELP = `  --credentials-file PATH  Absolute path to private credentials.json
  --state-dir PATH         Absolute path for login state and private browser profiles
  --browser-path PATH      Absolute Patchright browser installation directory
  --help                  Show this help without accessing files or the network

Defaults: HOMEBRIDGE_CADILLAC_ONSTAR_STATE_DIR, or
<HOMEBRIDGE_STORAGE_PATH>/cadillac-onstar, or ~/.homebridge/cadillac-onstar.
An explicit credentials file supplies the default state directory.
HOMEBRIDGE_CADILLAC_ONSTAR_CREDENTIALS_FILE and PLAYWRIGHT_BROWSERS_PATH
can also supply the corresponding paths.`;

module.exports = { ACTIONS, PATH_HELP, absolutePath, invalidArguments, parseOptions };
