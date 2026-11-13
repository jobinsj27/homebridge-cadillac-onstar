#!/usr/bin/env node
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { OAuth2Client, CodeChallengeMethod } = require('google-auth-library');
const { readPrivateJSON, privateDirectory, writePrivateJSON } = require('./private-files');
const { SCOPE } = require('../lib/gmail');

async function authorize(clientFile, destination) {
  if (![clientFile, destination].every(p => typeof p === 'string' && path.isAbsolute(p))) throw new Error();
  privateDirectory(path.dirname(destination));
  if (fs.existsSync(destination)) throw new Error();
  const { installed } = readPrivateJSON(clientFile);
  if (!installed?.client_id || !installed.client_secret) throw new Error();
  const server = http.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const redirect = 'http://127.0.0.1:' + server.address().port;
  const auth = new OAuth2Client(installed.client_id, installed.client_secret, redirect);
  const state = randomBytes(32).toString('hex');
  try {
    const pkce = await auth.generateCodeVerifierAsync();
    const url = auth.generateAuthUrl({ scope: [SCOPE], access_type: 'offline', prompt: 'consent',
      state, code_challenge_method: CodeChallengeMethod.S256, code_challenge: pkce.codeChallenge });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error()), 300000);
      server.once('close', () => clearTimeout(timer));
      server.on('request', (req, res) => {
        if (!URL.canParse(req.url, redirect)) { res.writeHead(400).end(); return; }
        const query = new URL(req.url, redirect);
        if (req.method !== 'GET' || query.pathname !== '/' || query.searchParams.get('state') !== state) {
          res.writeHead(400).end(); return;
        }
        clearTimeout(timer);
        const received = query.searchParams.get('code');
        res.setHeader('Cache-Control','no-store');
        res.end('Return to the terminal for the authorization result.');
        if (received) resolve(received); else reject(new Error());
      });
      process.stdout.write('Open this link on this computer to authorize Gmail read access.\n' + url + '\n');
    });
    const { tokens } = await auth.getToken({ code, codeVerifier: pkce.codeVerifier, redirect_uri: redirect });
    if (!tokens.refresh_token || tokens.scope !== SCOPE) throw new Error();
    writePrivateJSON(destination, { clientId: installed.client_id, clientSecret: installed.client_secret,
      refreshToken: tokens.refresh_token, authorizedAt: new Date().toISOString() }, { exclusive: true });
    process.stdout.write('Private Gmail authorization file created.\n');
  } finally { server.close(); server.closeAllConnections(); }
}

if (process.argv.length !== 4) {
  console.log('Usage: cadillac-onstar-gmail /absolute/desktop-client.json /absolute/private/gmail-session.json');
  process.exitCode = process.argv.includes('--help') ? 0 : 1;
} else authorize(...process.argv.slice(2)).catch(() => {
  process.stderr.write('Gmail sign-in did not complete. Check private file permissions, Google consent and the unused output path.\n');
  process.exitCode = 1;
});
