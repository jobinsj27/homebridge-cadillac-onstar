'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function privateDirectory(dirname) {
  fs.mkdirSync(dirname, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dirname);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) {
    throw new Error('PRIVATE_DIRECTORY_REQUIRED');
  }
  return dirname;
}

function readPrivateJSON(filename) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('PRIVATE_FILE_REQUIRED');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

function writePrivateJSON(filename, value, { exclusive = false } = {}) {
  privateDirectory(path.dirname(filename));
  if (exclusive) {
    fs.writeFileSync(filename, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return;
  }
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('PRIVATE_FILE_REQUIRED');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, filename);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

module.exports = { privateDirectory, readPrivateJSON, writePrivateJSON };
