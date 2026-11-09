#!/usr/bin/env node
'use strict';

// Interactive email/SMS sign-in only. This helper never imports the vehicle API.
// OAuth settings follow OnStarJS2 2.16.7; all tokens remain in the private directory.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { parseOptions, PATH_HELP } = require('./options');
const { privateDirectory, readPrivateJSON, writePrivateJSON } = require('./private-files');

const BASE = 'https://custlogin.gm.com/gmb2cprod.onmicrosoft.com/b2c_1a_seamless_mobile_signuporsignin/v2.0/';
const CLIENT_ID = '3ff30506-d242-4bed-835b-422bf992622e';
const REDIRECT = 'msauth.com.gm.myChevrolet://auth';
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const USAGE = `Usage: cadillac-onstar-login [options]

Open a visible GM sign-in browser and save an email/SMS-verified session.
Complete verification in the browser, or use the private login-control.json file.
This helper never imports the vehicle API or sends vehicle commands.
  --inspect-page          Inspect the initial page without entering credentials
  --no-sandbox            Disable Chromium sandbox only when your container requires it
${PATH_HELP}`;

function parseArgs(args, context) {
  return parseOptions(args, { ...context, login: true });
}

async function pageMetadata(page) {
  return page.evaluate(() => {
    const visible = element => !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
    const body = document.body?.innerText || '';
    return {
      title: document.title.slice(0, 100),
      accessDenied: /access denied|request (?:was )?blocked/i.test(body),
      incorrectCode: /(?:incorrect|invalid|expired) (?:verification )?code/i.test(body),
      inputs: [...document.querySelectorAll('input')].filter(visible).map(e => ({ id: e.id, name: e.name, type: e.type })),
      buttons: [...document.querySelectorAll('button,input[type="submit"],a[role="button"]')].filter(visible)
        .map(e => ({ id: e.id, text: (e.innerText || e.value || '').slice(0, 100), disabled: e.disabled === true })),
    };
  });
}

async function main(args) {
  const options = parseArgs(args);
  if (options.help) { console.log(USAGE); return; }
  process.umask(0o077);
  const { credentialsFile: filename, inspectOnly, stateDir: base, browserPath, noSandbox } = options;
  const config = readPrivateJSON(filename);
  if (![config.username, config.password, config.tokenLocation].every(v => typeof v === 'string' && v)
    || !path.isAbsolute(config.tokenLocation)) throw new Error('CREDENTIALS_REQUIRED');
  privateDirectory(base);
  const controlFile = path.join(base, 'login-control.json');
  const stateFile = path.join(base, 'login-state.json');
  if (fs.existsSync(controlFile)) throw new Error('STALE_CONTROL_FILE');
  privateDirectory(config.tokenLocation);
  privateDirectory(browserPath);
  process.env.PLAYWRIGHT_BROWSERS_PATH = browserPath;
  const upstreamRequire = createRequire(require.resolve('onstarjs2'));
  const { Issuer, generators, custom } = upstreamRequire('openid-client');
  const { chromium } = upstreamRequire('patchright');
  const issuer = await Issuer.discover(BASE + '.well-known/openid-configuration');
  for (const key of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    if (new URL(issuer.metadata[key]).origin !== 'https://custlogin.gm.com') throw new Error('UNEXPECTED_OAUTH_ORIGIN');
  }
  const client = new issuer.Client({ client_id: CLIENT_ID, redirect_uris: [REDIRECT],
    response_types: ['code'], token_endpoint_auth_method: 'none' });
  client[custom.clock_tolerance] = 120;
  const verifier = generators.codeVerifier();
  const state = generators.nonce();
  const authorizationUrl = client.authorizationUrl({
    scope: `https://gmb2cprod.onmicrosoft.com/${CLIENT_ID}/Test.Read openid profile offline_access`,
    code_challenge: generators.codeChallenge(verifier), code_challenge_method: 'S256',
    bundleID: 'com.gm.myChevrolet', mode: 'dark',
    evar25: 'mobile_mychevrolet_chevrolet_us_app_launcher_sign_in_or_create_account',
    channel: 'lightreg', ui_locales: 'en-US', brand: 'chevrolet', state,
  });
  let captured, phase = 'starting', context, page;
  let navigation = {};
  const profile = fs.mkdtempSync(path.join(base, 'browser-profile-'));
  const publish = data => {
    writePrivateJSON(stateFile, { phase, navigation, ...data });
  };
  const capture = value => {
    try {
      const url = new URL(value);
      if (url.protocol.toLowerCase() !== 'msauth.com.gm.mychevrolet:' || url.hostname !== 'auth') return;
      if (url.searchParams.get('state') !== state || !url.searchParams.get('code')) return;
      captured = { code: url.searchParams.get('code'), state: url.searchParams.get('state') };
    } catch { /* Ignore unrelated browser requests. */ }
  };
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: false, channel: 'chromium', viewport: { width: 1024, height: 900 },
      chromiumSandbox: !noSandbox,
      args: ['--disable-dev-shm-usage'],
    });
    page = await context.newPage();
    page.setDefaultTimeout(60000);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    cdp.on('Network.requestWillBeSent', event => {
      capture(event.request.url);
      const headers = event.redirectResponse?.headers;
      if (headers) capture(headers.location || headers.Location);
    });
    cdp.on('Network.responseReceived', event => {
      const location = event.response.headers.location || event.response.headers.Location;
      if (location) capture(location);
    });
    cdp.on('Network.responseReceivedExtraInfo', event => capture(event.headers.location || event.headers.Location));
    context.on('request', request => capture(request.url()));
    phase = 'email'; publish({}); console.log('Opening GM sign-in.');
    const response = await page.goto(authorizationUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(5000);
    navigation = { status: response?.status(), type: response?.headers()['content-type'],
      documentLength: (await page.content()).length,
      host: new URL(page.url()).hostname, path: new URL(page.url()).pathname };
    const initial = await pageMetadata(page);
    publish(initial);
    if (initial.accessDenied) throw new Error('ACCESS_DENIED');
    if (inspectOnly) {
      console.log('Login page metadata saved; no credentials entered.');
      return;
    }
    if (new URL(page.url()).origin !== 'https://custlogin.gm.com') throw new Error('UNEXPECTED_LOGIN_ORIGIN');
    await page.locator('input[type="email"], input[name="logonIdentifier"]').first().fill(config.username);
    await page.locator('button#continue').click();
    phase = 'password'; publish({});
    await page.locator('input[type="password"]').first().waitFor();
    if (new URL(page.url()).origin !== 'https://custlogin.gm.com') throw new Error('UNEXPECTED_LOGIN_ORIGIN');
    await page.locator('input[type="password"]').first().fill(config.password);
    // No navigation reloads or resubmissions: one password attempt only.
    await page.locator('button[type="submit"], button#continue, input[type="submit"]').filter({ visible: true }).first().click();
    phase = 'verification'; publish({});
    console.log('GM credentials submitted once. Complete email or SMS verification in the browser.');
    const deadline = Date.now() + 15 * 60 * 1000;
    let lastSnapshot;
    while (!captured && Date.now() < deadline) {
      if (!/^https:\/\/custlogin\.gm\.com\//i.test(page.url())) throw new Error('UNEXPECTED_LOGIN_ORIGIN');
      const snapshot = await pageMetadata(page);
      if (snapshot.accessDenied) throw new Error('ACCESS_DENIED');
      if (snapshot.incorrectCode) throw new Error('VERIFICATION_CODE_REJECTED');
      const serialized = JSON.stringify(snapshot);
      if (serialized !== lastSnapshot) { publish(snapshot); console.log('Verification page updated; private login-state.json is ready.'); lastSnapshot = serialized; }
      if (fs.existsSync(controlFile)) {
        const command = readPrivateJSON(controlFile);
        fs.unlinkSync(controlFile);
        if (command.action === 'code' && typeof command.code === 'string' && /^\d{4,8}$/.test(command.code) && typeof command.inputId === 'string') {
          if (!snapshot.inputs.some(e => e.id === command.inputId && e.type !== 'password')) throw new Error('INVALID_CONTROL');
          await page.locator(`[id=${JSON.stringify(command.inputId)}]`).fill(command.code);
        } else if (command.action === 'click' && typeof command.buttonId === 'string' && command.buttonId) {
          if (!snapshot.buttons.some(e => e.id === command.buttonId && !e.disabled)) throw new Error('INVALID_CONTROL');
          await page.locator(`[id=${JSON.stringify(command.buttonId)}]`).click();
        } else if (command.action === 'cancel') { throw new Error('CANCELLED'); }
        else { throw new Error('INVALID_CONTROL'); }
        lastSnapshot = undefined;
      }
      await sleep(1000);
    }
    if (!captured) throw new Error('VERIFICATION_TIMEOUT');
    phase = 'token-exchange'; publish({});
    const tokenSet = await client.callback(REDIRECT, captured, { code_verifier: verifier, state });
    if (!tokenSet.access_token || !tokenSet.refresh_token) throw new Error('TOKEN_RESPONSE_INCOMPLETE');
    const now = Math.floor(Date.now() / 1000);
    const tokens = { ...tokenSet, refresh_obtained_at: now };
    if (typeof tokenSet.refresh_expires_in === 'number') tokens.refresh_expires_at = now + tokenSet.refresh_expires_in;
    const destination = path.join(config.tokenLocation, 'microsoft_tokens.json');
    writePrivateJSON(destination, tokens);
    phase = 'complete'; publish({});
    console.log('GM sign-in completed. Session saved privately; no vehicle commands sent.');
  } catch (error) {
    const known = new Set(['ACCESS_DENIED','VERIFICATION_CODE_REJECTED','VERIFICATION_TIMEOUT','UNEXPECTED_LOGIN_ORIGIN','INVALID_CONTROL','CANCELLED','TOKEN_RESPONSE_INCOMPLETE']);
    const snapshot = page ? await pageMetadata(page).catch(() => ({})) : {};
    const reason = snapshot.accessDenied ? 'ACCESS_DENIED' : known.has(error.message) ? error.message : error.name === 'TimeoutError' ? 'PAGE_TIMEOUT' : 'LOGIN_FAILED';
    publish({ ...snapshot, failed: true, reason });
    console.log(`GM login stopped at ${phase}: ${reason}. No retry was attempted.`);
    process.exitCode = 1;
  } finally {
    if (context) await context.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
    if (fs.existsSync(controlFile)) fs.unlinkSync(controlFile);
  }
}

if (require.main === module) main(process.argv.slice(2)).catch((error) => {
  console.error(error.code === 'INVALID_ARGUMENTS' ? USAGE : 'Cannot initialize private GM sign-in helper. Check private paths, credentials, and browser installation.'); process.exitCode = 1;
});

module.exports = { parseArgs, main, pageMetadata, USAGE };
