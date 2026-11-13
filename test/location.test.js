'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { normalizeLocationResult } = require('../lib/location');

function response() {
  return { status: 'success', response: { data: {
    vehicle: { vin: 'private-vehicle' },
    telemetry: {
      occurredTs: '2026-01-01T12:00:00.000Z', processingTs: '2026-01-01T14:00:00.000Z',
      data: { session: { updatePending: 'NONE' }, position: { lat: 12.34, lng: 56.78, geohash: 'private-geohash' } },
    }, operation: { requestId: 'private-request', warnings: [] },
  } } };
}

test('digital-twin sample uses vehicle observation time and exposes only validated location fields', () => {
  assert.deepEqual(normalizeLocationResult(response()), {
    latitude: 12.34, longitude: 56.78, observedAt: Date.parse('2026-01-01T12:00:00.000Z'),
  });
});

test('fresh HTTP/processing time cannot substitute for an absent observation time', () => {
  for (const timestamp of [undefined, null, '', '2026-01-01', 'not-a-date', 1767268800000]) {
    const value = response(); value.response.data.telemetry.occurredTs = timestamp;
    assert.throws(() => normalizeLocationResult(value), { code: 'LOCATION_UNAVAILABLE' });
  }
});

test('incomplete and unknown refresh statuses cannot be accepted as a position', () => {
  for (const status of ['PENDING', 'FAILED', '', undefined, null, 'SUCCESS']) {
    const value = response(); value.response.data.telemetry.data.session.updatePending = status;
    assert.throws(() => normalizeLocationResult(value), { code: 'LOCATION_UNAVAILABLE' });
  }
});

test('coordinate validation rejects coercions and bad ranges, including safe failure without raw details', () => {
  for (const [key, invalid] of [['lat', null], ['lat', '12.34'], ['lat', NaN], ['lat', Infinity], ['lat', 91], ['lng', -181]]) {
    const value = response(); value.response.data.telemetry.data.position[key] = invalid;
    assert.throws(() => normalizeLocationResult(value), error => {
      assert.equal(error.code, 'LOCATION_UNAVAILABLE');
      assert.doesNotMatch(String(error), /private|12\.34|56\.78/); return true;
    });
  }
  const zero = response(); zero.response.data.telemetry.data.position = { lat: 0, lng: 0 };
  assert.equal(normalizeLocationResult(zero).latitude, 0);
});

test('transport errors, operation warnings and legacy location-only responses are rejected', () => {
  const failed = response(); failed.status = 'failure';
  const errored = response(); errored.response.data.error = { message: 'private-error' };
  const warned = response(); warned.response.data.operation.warnings = [{ message: 'private-warning' }];
  for (const value of [undefined, {}, failed, errored, warned, { status: 'success', response: { data: { location: { lat: 12, long: 56 } } } }]) {
    assert.throws(() => normalizeLocationResult(value), { code: 'LOCATION_UNAVAILABLE' });
  }
});
