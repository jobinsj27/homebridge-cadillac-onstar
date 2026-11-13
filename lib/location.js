'use strict';

const unavailable = () => Object.assign(new Error('Location unavailable.'), { code: 'LOCATION_UNAVAILABLE' });

// This digital-twin shape was checked on a 2023 Escalade ESV. Never substitute
// the response/processing time for the time the vehicle observed its position.
function normalizeLocationResult(result) {
  const data = result?.response?.data;
  const telemetry = data?.telemetry;
  const position = telemetry?.data?.position;
  const timestamp = telemetry?.occurredTs;
  if (result?.status !== 'success' || result.error || data?.error
      || telemetry?.data?.session?.updatePending !== 'NONE'
      || (Array.isArray(data?.operation?.warnings) && data.operation.warnings.length)
      || typeof position?.lat !== 'number' || !Number.isFinite(position.lat) || Math.abs(position.lat) > 90
      || typeof position?.lng !== 'number' || !Number.isFinite(position.lng) || Math.abs(position.lng) > 180
      || typeof timestamp !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp)
      || !Number.isFinite(Date.parse(timestamp))) throw unavailable();
  return { latitude: position.lat, longitude: position.lng, observedAt: Date.parse(timestamp) };
}

module.exports = { normalizeLocationResult };
