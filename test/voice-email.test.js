'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { test } = require('node:test');
const { parseAlert } = require('../lib/alert-parser');
const { parseVoiceEmail } = require('../lib/voice-email');

const now = Date.UTC(2026, 10, 10, 4);
const config = { vehicleName: 'Escalade', locationName: 'homebridge', locationId: 'home',
  shortCode: '63628', notBefore: '2026-11-10T03:00:00.000Z', maxAgeSeconds: 3600, now };
const auth = 'mx.google.com; dkim=pass header.i=@google.com header.s=synthetic; '
  + 'dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=txt.voice.google.com';
const part = text => ({ mimeType: 'text/plain', body: { data: Buffer.from(text).toString('base64url') } });
const message = (text = 'Escalade arrived at homebridge') => ({ id: 'abcdef0123456789',
  internalDate: String(now - 1000), payload: { mimeType: 'multipart/alternative', headers: [
    { name: 'Authentication-Results', value: auth },
    { name: 'From', value: 'Google Voice <15555550123.63628.syntheticID@txt.voice.google.com>' },
    { name: 'Subject', value: 'New text message from 63628' },
  ], parts: [part(text), { mimeType: 'text/html', body: { data: Buffer.from('<p>ignored</p>').toString('base64url') } }] } });
const parse = (value, overrides = {}) => parseVoiceEmail(value, { ...config, ...overrides }, parseAlert);
const header = (value, name, contents) => {
  value.payload.headers.find(item => item.name.toLowerCase() === name.toLowerCase()).value = contents;
  return value;
};
const instructions = 'To respond to this text message, reply to this email or visit Google Voice.';
const footer = ['YOUR ACCOUNT <https://voice.google.com> HELP CENTER',
  '<https://support.google.com/voice#topic=1707989> HELP FORUM',
  '<https://productforums.google.com/forum/#!forum/voice>',
  "This email was sent to you because you indicated that you'd like to receive",
  "email notifications for text messages. If you don't want to receive such",
  'emails in the future, please update your email notification settings',
  '<https://voice.google.com/settings#messages>.', 'Google LLC', '1600 Amphitheatre Pkwy',
  'Mountain View CA 94043 USA'].join('\r\n');

test('authenticated numbered-sender alert returns only stable event fields using Gmail delivery time', () => {
  assert.deepEqual(parse(message()), { eventId: 'gmail:abcdef0123456789', locationId: 'home',
    event: 'arrived', occurredAt: new Date(now - 1000).toISOString() });
  const m = message('Escalade departed from homebridge');
  m.payload.headers.push({ name: 'Date', value: 'Tue, 1 Jan 2000 00:00:00 GMT' });
  assert.equal(parse(m).event, 'departed');
  assert.equal(parse(m).occurredAt, new Date(now - 1000).toISOString());
});

test('authenticated no-reply sender requires the exact short-code subject', () => {
  const m = header(message(), 'From', 'Google Voice <voice-noreply@google.com>');
  assert.equal(parse(m)?.event, 'arrived');
  for (const subject of ['New text message from 15555550123', 'New text message from 63628 fake',
    'Re: New text message from 63628', '63628', '']) {
    const invalid = header(message(), 'From', 'voice-noreply@google.com');
    assert.equal(parse(header(invalid, 'Subject', subject)), null);
  }
});

test('only first Authentication-Results from mx.google.com can establish authentication', () => {
  for (const value of ['', 'other.example; dkim=pass header.i=@google.com; dmarc=pass header.from=google.com',
    auth.replace('dkim=pass', 'dkim=fail'), auth.replace('dmarc=pass', 'dmarc=fail'),
    auth.replace('header.i=@google.com', 'header.i=@attacker.example'),
    auth.replace('header.from=txt.voice.google.com', 'header.from=attacker.example'),
    'mx.google.com; dkim=pass header.i=@attacker.example (header.i=@google.com); dmarc=pass header.from=google.com',
    'mx.google.com; dkim=pass header.i=@google.com.attacker.example; dmarc=pass header.from=google.com',
    'mx.google.com; spf=pass header.i=@google.com; dmarc=pass header.from=google.com']) {
    const m = header(message(), 'Authentication-Results', value);
    m.payload.headers.push({ name: 'Authentication-Results', value: auth });
    assert.equal(parse(m), null, value);
  }
  const m = message();
  m.payload.headers.push({ name: 'Authentication-Results', value: 'attacker.example; dkim=fail' });
  assert.equal(parse(m)?.event, 'arrived');
  const d = header(message(), 'Authentication-Results',
    'mx.google.com;\r\n\tdkim=pass\theader.d=google.com;\r\n dmarc=pass header.from=google.com');
  assert.equal(parse(d)?.event, 'arrived');
});

test('display names, unrelated addresses and ambiguous envelope headers cannot impersonate the short code', () => {
  for (const from of ['63628 <attacker@example.com>', 'voice-noreply@google.com.attacker.example',
    '63628 <15555550123.12345.synthetic@txt.voice.google.com>',
    '15555550123.63628.synthetic@txt.voice.google.com.attacker.example',
    'Google Voice <voice-noreply@google.com>, other@example.com',
    'Google Voice\r\n <voice-noreply@google.com>',
    '63628@txt.voice.google.com', 'voice-noreply+63628@google.com']) {
    assert.equal(parse(header(message(), 'From', from)), null, from);
  }
  for (const name of ['From', 'Subject']) {
    const m = message();
    m.payload.headers.push({ name, value: m.payload.headers.find(item => item.name === name).value });
    assert.equal(parse(m), null);
  }
});

test('known Voice link and Google footer are removed while unknown wrappers remain rejected', () => {
  const body = '\r\n<https://voice.google.com/u/0/messages/synthetic-conversation>\r\n'
    + 'Escalade departed from homebridge\r\n' + instructions + '\r\n' + footer;
  assert.equal(parse(message(body))?.event, 'departed');
  assert.equal(parse(message('Escalade arrived at homebridge\nTo respond to this text message, visit Google Voice.'))?.event,
    'arrived');
  for (const body of [
    '<https://voice.google.com.attacker.example/thread>\nEscalade arrived at homebridge',
    '<https://example.com>\nEscalade arrived at homebridge',
    'Your new text:\nEscalade arrived at homebridge',
    'Escalade arrived at homebridge\nReply STOP to unsubscribe.',
    'Escalade arrived at homebridge\n' + instructions + '\nEscalade departed from homebridge',
    'Escalade arrived at homebridge\n' + instructions + '\nUnrecognized footer',
    'Escalade arrived at homebridge\nEscalade departed from homebridge',
  ]) assert.equal(parse(message(body)), null, body);
});

test('ordinary, enrollment, quoted, and other vehicle/place texts never become presence events', () => {
  for (const body of ['test', 'Hiya', 'You are successfully enrolled in OnStar Vehicle Locate.',
    'Escalade arrived at Home', 'OtherVehicle arrived at homebridge', '"Escalade arrived at homebridge"']) {
    assert.equal(parse(message(body)), null);
  }
});

test('cutoff, age, and future checks use delivery timestamp without rewriting it on retries', () => {
  for (const time of [now - 3600001, now + 30001, -1, 1.5]) {
    const m = message(); m.internalDate = String(time);
    assert.equal(parse(m), null);
  }
  assert.equal(parse(message(), { notBefore: new Date(now).toISOString() }), null);
  assert.equal(parse(message(), { notBefore: new Date(now + 1).toISOString() }), null);
  const m = message();
  assert.deepEqual(parse(m), parse(m, { now: now + 1000 }));
  for (const overrides of [{ notBefore: undefined }, { notBefore: 'bad' }, { maxAgeSeconds: 0 },
    { maxAgeSeconds: 86401 }, { now: 'now' }, { shortCode: '63628.' }]) assert.equal(parse(m, overrides), null);
  for (const id of ['', 'gmail:abc', '../abc', 'x'.repeat(16)]) {
    const m = message(); m.id = id; assert.equal(parse(m), null);
  }
});

test('MIME accepts one text/plain body and ignores HTML and attached plaintext', () => {
  const m = message();
  m.payload.parts.push({ ...part('Escalade departed from homebridge'), filename: 'history.txt' });
  assert.equal(parse(m)?.event, 'arrived');
  m.payload.parts.push(part('Escalade departed from homebridge'));
  assert.equal(parse(m), null);
  const html = message(); html.payload.parts.shift();
  assert.equal(parse(html), null);
  const attached = message();
  attached.payload.parts[0].headers = [{ name: 'Content-Disposition', value: 'attachment' }];
  assert.equal(parse(attached), null);
  const inline = message();
  inline.payload.parts[0].headers = [{ name: 'Content-Disposition', value: 'inline' }];
  assert.equal(parse(inline)?.event, 'arrived');
});

test('raw message, MIME count/depth, and plaintext allocations are bounded', () => {
  const large = message(); large.unrelated = 'x'.repeat(131072);
  assert.equal(parse(large), null);
  assert.equal(parse(message('x'.repeat(16385))), null);
  const many = message();
  many.payload.parts.push(...Array.from({ length: 30 }, () => ({ mimeType: 'text/html', body: { data: '' } })));
  assert.equal(parse(many), null);
  const deep = message(); let current = deep.payload;
  for (let i = 0; i < 9; i += 1) {
    const child = { mimeType: 'multipart/mixed', parts: current.parts };
    current.parts = [child]; current = child;
  }
  assert.equal(parse(deep), null);
  const malformed = message(); malformed.payload.parts = {};
  assert.equal(parse(malformed), null);
});

test('base64url and UTF-8 decoding are strict and unsupported attachment fetches are rejected', () => {
  for (const data of ['%', 'a', 'AAAA=', 'SGVsbG8===', 'SGVsbG8+', 'SGVsbG8/', 'x'.repeat(22000),
    Buffer.from([0xc3, 0x28]).toString('base64url')]) {
    const m = message(); m.payload.parts[0].body.data = data;
    assert.equal(parse(m), null);
  }
  const m = message(); m.payload.parts[0].body.attachmentId = 'synthetic-attachment';
  assert.equal(parse(m), null);
  const padded = message();
  const body = padded.payload.parts[0].body;
  body.data += '='.repeat((4 - body.data.length % 4) % 4);
  assert.equal(parse(padded)?.event, 'arrived');
});

test('the embedded implementation uses no imports, does not mutate input, and does not leak rejected content', () => {
  const input = message();
  const before = JSON.stringify(input);
  const embedded = vm.runInNewContext(`(${parseVoiceEmail.toString()})`, { Buffer });
  assert.equal(JSON.stringify(embedded(input, config, parseAlert)), JSON.stringify(parse(input)));
  assert.equal(JSON.stringify(input), before);
  const throws = () => { throw new Error('private raw message'); };
  assert.equal(parseVoiceEmail(input, config, throws), null);
  for (const value of [null, undefined, [], 'body']) assert.equal(parse(value), null);
});

test('Gmail source delivers events oldest first and avoids repeat full-body downloads', async () => {
  const { GmailPoller } = require('../lib/gmail');
  const { normalizePresenceConfig } = require('../lib/presence');
  const normalized = normalizePresenceConfig({ enabled: true, source: 'gmail', locations: [{ id: 'home' }],
    gmail: { sessionFile: '/private/session', stateFile: '/private/state', locationName: 'homebridge' } });
  assert.equal(normalized.source, 'gmail');
  const departure = message('Escalade departed from homebridge');
  departure.id = 'b123';
  const arrival = message();
  arrival.id = 'a123';
  arrival.internalDate = String(Number(departure.internalDate) - 1000);
  const fetched = [], delivered = [];
  const poller = new GmailPoller({ config, now: () => now, accept: event => delivered.push(event.event),
    mailbox: { authorizedAt: config.notBefore, list: async () => ({ messages: [departure, arrival] }),
      read: async id => { fetched.push(id); return id === departure.id ? departure : arrival; } } });
  await poller.check();
  await poller.check();
  assert.deepEqual(fetched, ['b123', 'a123']);
  assert.deepEqual(delivered, ['arrived', 'departed']);
  poller.shutdown();
});
