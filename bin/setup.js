#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseOptions, PATH_HELP } = require('./options');
const { privateDirectory, writePrivateJSON } = require('./private-files');

const USAGE = `Usage: cadillac-onstar-setup [options]\n\nCreate a private credential template without contacting GM.\n${PATH_HELP}`;

function setup(args, context) {
  const options = parseOptions(args, context);
  if (options.help) return { help: true };
  const tokenLocation = path.join(options.stateDir, 'tokens');
  for (const directory of [options.stateDir, path.dirname(options.credentialsFile), tokenLocation, options.browserPath]) {
    privateDirectory(directory);
  }
  writePrivateJSON(options.credentialsFile, {
    authMode: 'savedSession',
    vin: '',
    username: '',
    password: '',
    deviceId: randomUUID(),
    tokenLocation,
  }, { exclusive: true });
  return options;
}

if (require.main === module) {
  try {
    const options = setup(process.argv.slice(2));
    process.stdout.write(options.help ? USAGE + '\n'
      : 'Private Cadillac OnStar template created. Edit credentials.json locally before signing in.\n');
  } catch (error) {
    process.stderr.write(error.code === 'INVALID_ARGUMENTS' ? USAGE + '\n'
      : error.code === 'EEXIST' ? 'Credentials already exist; nothing was overwritten.\n'
        : 'Cannot create private setup files. Use directories owned by the Homebridge user with mode 0700.\n');
    process.exitCode = 1;
  }
}

module.exports = { setup, USAGE };
