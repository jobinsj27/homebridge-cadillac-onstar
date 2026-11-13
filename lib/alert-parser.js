'use strict';

// Match myCadillac notifications and forwarded Vehicle Locate texts. The caller
// must authenticate the email/SMS source and extract one SMS body first.
function parseAlert(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const { text, vehicleName, locationName, locationId, eventId, occurredAt } = input;
  const controls = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;
  const normalized = value => value.replace(/[ \t\u00a0]+/g, ' ').trim().toLowerCase();
  const validName = value => typeof value === 'string' && value.length <= 128
    && !controls.test(value) && normalized(value).length > 0;
  if (typeof text !== 'string' || text.length === 0 || text.length > 2048 || controls.test(text)
      || !validName(vehicleName) || !validName(locationName)
      || typeof locationId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(locationId)
      || typeof eventId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(eventId)
      || typeof occurredAt !== 'string') return null;
  const timestampFormat = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(occurredAt);
  const timestamp = Date.parse(occurredAt);
  if (!timestampFormat || !Number.isSafeInteger(timestamp) || timestamp < 0
      || new Date(timestamp).toISOString()
        !== `${timestampFormat[1]}.${(timestampFormat[2] || '').padEnd(3, '0')}Z`) return null;

  const vehicle = normalized(vehicleName);
  const place = normalized(locationName);
  let body = normalized(text);
  // Prefixes are an explicit allowlist, not a search for an event somewhere in
  // an arbitrary email, enrollment confirmation, quote, or message history.
  body = body.replace(/^(?:onstar|vehicle locate): */, '');
  const optOut = '. send "stop" to end vehicle locate texts.';
  if (body.endsWith(optOut)) body = body.slice(0, -optOut.length);
  else if (body.endsWith('.')) body = body.slice(0, -1);
  const matches = phrase => body === vehicle + ' ' + phrase + ' ' + place
    || body === vehicle + ' has ' + phrase + ' ' + place;
  const direction = matches('arrived at') ? 'arrived' : matches('departed from') ? 'departed' : null;
  if (!direction) return null;
  return { eventId, locationId, event: direction, occurredAt };
}

module.exports = { parseAlert };
