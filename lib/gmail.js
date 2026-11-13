'use strict';

const { OAuth2Client } = require('google-auth-library');
const { readPrivateJSON } = require('../bin/private-files');
const { parseAlert } = require('./alert-parser');
const { parseVoiceEmail } = require('./voice-email');

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';

function openMailbox(file) {
  const { clientId, clientSecret, refreshToken, authorizedAt } = readPrivateJSON(file);
  if (![clientId, clientSecret, refreshToken].every(v => typeof v === 'string' && v.length)
      || !Number.isFinite(Date.parse(authorizedAt))) throw new Error('Invalid Gmail authorization file.');
  const auth = new OAuth2Client(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  const get = async (url, params, signal) => (await auth.request({
    url, params, signal, timeout: 15000, retry: false,
  })).data;
  return { authorizedAt,
    list: (after, signal, pageToken) => get(API, { pageToken, q: 'after:' + after + ' {from:voice-noreply@google.com from:txt.voice.google.com}',
      maxResults: 50, fields: 'messages/id,nextPageToken' }, signal),
    read: (id, signal) => get(API + '/' + id, { format: 'full' }, signal) };
}

class GmailPoller {
  constructor({ config, mailbox, accept, warn = () => {}, now = Date.now }) {
    Object.assign(this, { config, mailbox, accept, warn, now });
    this.seen = new Map();
    this.stopSignal = new AbortController();
    this.failures = 0;
  }

  async check() {
    const signal = this.stopSignal.signal;
    const after = this.now() - 3600000;
    for (const [id, timestamp] of this.seen) if (timestamp < after) this.seen.delete(id);
    const events = [];
    let pageToken;
    do {
      const page = await this.mailbox.list(Math.floor(after / 1000), signal, pageToken);
      for (const { id } of page.messages || []) {
        if (signal.aborted) return;
        if (!/^[0-9a-f]{1,64}$/i.test(id) || this.seen.has(id)) continue;
        let message;
        try {
          message = await this.mailbox.read(id, signal);
        } catch (error) {
          if (error.response?.status === 404) continue;
          throw error;
        }
        const event = parseVoiceEmail(message, { ...this.config, now: this.now(),
          notBefore: this.mailbox.authorizedAt, maxAgeSeconds: 3600 }, parseAlert);
        if (event) events.push({ event, id });
        else this.seen.set(id, this.now());
      }
      pageToken = page.nextPageToken;
    } while (pageToken && !signal.aborted);
    events.sort((a, b) => Date.parse(a.event.occurredAt) - Date.parse(b.event.occurredAt));
    for (const { event, id } of events) {
      if (signal.aborted) return;
      try { this.accept(event); }
      catch (error) { if (error.code !== 'EVENT_STALE') throw error; }
      this.seen.set(id, this.now());
    }
  }

  start() {
    if (this.started || this.stopSignal.signal.aborted) return;
    this.started = true;
    const tick = async () => {
      let delay = 60000;
      try { await this.check(); this.failures = 0; }
      catch (error) {
        if (this.stopSignal.signal.aborted) return;
        if (!this.failures) this.warn('Gmail presence check failed. Check Google authorization and connectivity.');
        delay = Math.min(3600000, 60000 * 2 ** Math.min(++this.failures, 6));
        const header = error.response?.headers?.get?.('retry-after');
        if (header) {
          const wait = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - this.now();
          if (Number.isFinite(wait)) delay = Math.max(delay, Math.min(wait, 2147483647));
        }
      }
      if (!this.stopSignal.signal.aborted) {
        this.timer = setTimeout(tick, delay);
        this.timer.unref();
      }
    };
    void tick();
  }

  shutdown() { this.stopSignal.abort(); clearTimeout(this.timer); }
}

module.exports = { GmailPoller, openMailbox, SCOPE };
