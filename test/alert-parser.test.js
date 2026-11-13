'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { test } = require('node:test');
const { parseAlert } = require('../lib/alert-parser');

const sample = overrides => ({ text: 'Escalade arrived at homebridge', vehicleName: 'Escalade',
  locationName: 'homebridge', locationId: 'home', eventId: 'gmail:message-1',
  occurredAt: '2026-11-10T04:00:00.000Z', ...overrides });

test('provisional arrival and departure phrases map configured alert names to stable place IDs', () => {
  assert.deepEqual(parseAlert(sample()), { eventId: 'gmail:message-1', locationId: 'home',
    event: 'arrived', occurredAt: '2026-11-10T04:00:00.000Z' });
  assert.deepEqual(parseAlert(sample({ text: 'Escalade departed from homebridge' })), {
    eventId: 'gmail:message-1', locationId: 'home', event: 'departed', occurredAt: '2026-11-10T04:00:00.000Z',
  });
});

test('parser accepts only documented optional prefixes, final period, case, and horizontal spacing', () => {
  for (const text of ['  ESCALADE  arrived at HOMEbridge.  ', 'OnStar: Escalade arrived at homebridge',
    'Vehicle Locate: Escalade arrived at homebridge.', 'onstar:Escalade arrived at homebridge',
    'Escalade\tarrived\u00a0at homebridge']) {
    assert.equal(parseAlert(sample({ text }))?.event, 'arrived', text);
  }
  for (const text of ['OnStar: Escalade departed from homebridge.',
    'Vehicle Locate: Escalade departed from homebridge']) {
    assert.equal(parseAlert(sample({ text }))?.event, 'departed', text);
  }
});

test('vehicle and location matching is literal and does not interpret regular-expression characters', () => {
  const input = sample({ vehicleName: 'Family SUV (A)+', locationName: 'House.* [main]',
    text: 'Family SUV (A)+ arrived at House.* [main]' });
  assert.equal(parseAlert(input)?.event, 'arrived');
  assert.equal(parseAlert({ ...input, text: 'Family SUV AAA arrived at House next main' }), null);
  for (const text of ['Escalade ESV arrived at homebridge', 'OtherCar arrived at homebridge',
    'Escalade arrived at Home', 'Escalade arrived at homebridge office',
    'Escalade arrived at myhomebridge', 'Escalade arrived at homebridge2']) {
    assert.equal(parseAlert(sample({ text })), null, text);
  }
});

test('enrollment, unrelated messages, quoted history, and contradictory bodies never become events', () => {
  for (const text of ['You have successfully enrolled in OnStar Vehicle Locate.', 'Y', 'STOP', 'test',
    'Example: Escalade arrived at homebridge', '"Escalade arrived at homebridge"',
    '> Escalade arrived at homebridge', 'Escalade arrived at homebridge yesterday',
    'Escalade did not arrive at homebridge', 'Escalade arrived at homebridge. Reply STOP to end.',
    'Escalade arrived at homebridge and departed from homebridge',
    'Escalade arrived at homebridge\nEscalade departed from homebridge',
    'Vehicle Locate:\nEscalade arrived at homebridge',
    'OnStar: Vehicle Locate: Escalade arrived at homebridge',
    'Escalade arrived at homebridge https://example.com/',
    'Escalade arrived at homebridge..', '<p>Escalade arrived at homebridge</p>']) {
    assert.equal(parseAlert(sample({ text })), null, text);
  }
});

test('control characters, invisible marks, multiline inputs and oversized bodies are ignored', () => {
  for (const text of ['', ' '.repeat(2049), '\nEscalade arrived at homebridge',
    'Escalade arrived at homebridge\r\n', 'Escalade\u200b arrived at homebridge',
    '\ufeffEscalade arrived at homebridge', 'Escalade arrived at homebridge\u202e',
    'Escalade arrived at homebridge\u0000']) {
    assert.equal(parseAlert(sample({ text })), null);
  }
});

test('invalid or missing configuration and source metadata are ignored without throwing', () => {
  for (const input of [undefined, null, [], '', 1, true]) assert.equal(parseAlert(input), null);
  for (const [field, values] of Object.entries({
    text: [undefined, null, 3, {}], vehicleName: ['', ' ', 'x'.repeat(129), 'Escalade\n', 3],
    locationName: ['', ' ', 'x'.repeat(129), 'homebridge\r', null],
    locationId: ['', '../home', 'a'.repeat(49), ' home', null],
    eventId: ['', '../message', 'a'.repeat(129), 'message 1', {}, null],
    occurredAt: [undefined, null, 1, 'not-a-date', '2026-02-30T00:00:00.000Z',
      '2026-11-10T04:00:00+00:00', '2026-11-10', '2026-11-10T24:00:00Z',
      '2026-11-10T04:00:00.0000Z', '1969-12-31T23:59:59Z'],
  })) {
    for (const value of values) assert.equal(parseAlert(sample({ [field]: value })), null, field);
  }
});

test('UTC fractional precision is preserved and time freshness remains the receiver responsibility', () => {
  for (const occurredAt of ['2026-11-10T04:00:00Z', '2026-11-10T04:00:00.1Z',
    '2026-11-10T04:00:00.12Z', '2026-11-10T04:00:00.123Z', '2000-01-01T00:00:00Z',
    '2099-12-31T23:59:59Z']) {
    assert.equal(parseAlert(sample({ occurredAt })).occurredAt, occurredAt);
  }
});

test('parser returns only event fields, never mutates input, and needs no runtime imports', () => {
  const input = Object.freeze(sample({ rawMessage: 'private-content', token: 'private-token' }));
  const output = parseAlert(input);
  assert.deepEqual(Object.keys(output), ['eventId', 'locationId', 'event', 'occurredAt']);
  assert.equal(input.text, 'Escalade arrived at homebridge');
  assert.doesNotMatch(JSON.stringify(output), /private/);
  const embedded = vm.runInNewContext(`(${parseAlert.toString()})`);
  assert.equal(JSON.stringify(embedded(input)), JSON.stringify(output));
});
