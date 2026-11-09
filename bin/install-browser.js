#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { parseOptions, PATH_HELP } = require('./options');
const { privateDirectory } = require('./private-files');

const USAGE = `Usage: cadillac-onstar-install-browser [options]

Download the Chromium revision required by the installed OnStarJS2 dependency.
This does not read credentials, sign in, or send vehicle commands.
${PATH_HELP}`;

function resolveBrowserCLI() {
  const upstreamRequire = createRequire(require.resolve('onstarjs2'));
  return path.join(path.dirname(upstreamRequire.resolve('patchright/package.json')), 'cli.js');
}

function installBrowser(args, { context, resolveCLI = resolveBrowserCLI, spawn = spawnSync } = {}) {
  const options = parseOptions(args, context);
  if (options.help) return { help: true };
  privateDirectory(options.stateDir);
  privateDirectory(options.browserPath);
  const result = spawn(process.execPath, [resolveCLI(), 'install', 'chromium'], {
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: options.browserPath },
    stdio: 'inherit',
  });
  if (result.error || result.signal || result.status !== 0) throw new Error('BROWSER_INSTALL_FAILED');
  return options;
}

if (require.main === module) {
  try {
    const result = installBrowser(process.argv.slice(2));
    if (result.help) process.stdout.write(USAGE + '\n');
  } catch (error) {
    process.stderr.write(error.code === 'INVALID_ARGUMENTS' ? USAGE + '\n'
      : 'Browser installation failed. Check the package installation, private directory permissions, and operating-system browser dependencies.\n');
    process.exitCode = 1;
  }
}

module.exports = { installBrowser, resolveBrowserCLI, USAGE };
