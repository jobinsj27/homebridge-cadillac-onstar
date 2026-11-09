'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { failure } = require('./controller');

function loadCredentials(filename) {
  try {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error();
    const stat = fs.statSync(filename);
    if (!stat.isFile() || (stat.mode & 0o077)) throw new Error();
    const source = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (source.authMode !== undefined && source.authMode !== 'savedSession') throw new Error();
    const config = { authMode: 'savedSession' };
    for (const key of ['vin', 'username', 'deviceId', 'tokenLocation']) {
      if (typeof source[key] !== 'string' || !source[key].trim()) throw new Error();
      config[key] = source[key];
    }
    if (!/^[A-HJ-NPR-Z0-9]{17}$/i.test(config.vin)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(config.deviceId)
      || !path.isAbsolute(config.tokenLocation)) throw new Error();
    fs.mkdirSync(config.tokenLocation, { recursive: true, mode: 0o700 });
    const tokenStat = fs.statSync(config.tokenLocation);
    if (!tokenStat.isDirectory() || (tokenStat.mode & 0o077)) throw new Error();
    return {
      ...config, checkRequestStatus: true, requestPollingIntervalSeconds: 6,
      requestPollingTimeoutSeconds: 90, retryOn429ForPost: false,
    };
  } catch {
    throw failure('CREDENTIALS');
  }
}

module.exports = { loadCredentials };
