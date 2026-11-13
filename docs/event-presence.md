# Presence from arrival and departure alerts

The optional `events` presence source accepts authenticated arrival/departure events from a separate relay. It updates the same occupancy sensors and optional status switches as GPS presence, with no scheduled vehicle-location requests. Keep the existing place IDs and accessory namespace when switching sources to preserve accessory identifiers.

This feature is unreleased. Its compatibility baseline is the **2023 Cadillac Escalade ESV**. OnStar SMS enrollment and forwarding an ordinary Google Voice text to Gmail have been confirmed. Forwarding and interpreting actual Cadillac arrival/departure alerts, and the complete relay-to-Homebridge route, still need live validation. A [Gmail polling relay](gmail-relay.md) is available for testing with provisional SMS wording.

## Configure the event receiver

Use a dedicated private directory outside the plugin installation and source checkout. Run this once as the operating-system user that runs Homebridge, after replacing the example directory:

```sh
node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const directory = '/absolute/homebridge/storage/cadillac-events';
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const stat = fs.lstatSync(directory);
if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) {
  throw new Error('Use a private mode-0700 directory.');
}
fs.writeFileSync(path.join(directory, 'webhook-token'),
  crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
NODE
```

The command creates a token without printing it and refuses to replace an existing token file. Store the same token in the relay's credential store. Do not paste the token into Homebridge configuration, a URL, logs, or a public issue.

Add this `presence` object to the existing `CadillacOnStar` platform configuration:

```json
{
  "presence": {
    "enabled": true,
    "source": "events",
    "exposeSwitch": true,
    "locations": [{ "id": "home", "name": "Home" }],
    "webhook": {
      "host": "127.0.0.1",
      "port": 8584,
      "tokenFile": "/absolute/homebridge/storage/cadillac-events/webhook-token",
      "stateFile": "/absolute/homebridge/storage/cadillac-events/state.json",
      "maxEventAgeSeconds": 3600
    }
  }
}
```

Coordinates and GPS polling settings are not used in event mode. Configure the actual location boundary and both arrival and departure alerts in myCadillac. The relay maps that place to the configured `locationId`.

`tokenFile` and `stateFile` must be separate absolute paths. The token is a private regular file containing 32–256 random characters from letters, digits, `_`, and `-`; the example generates 64 hexadecimal characters. The plugin creates and updates its private state file. Keep its directory mode `0700` and its files mode `0600`; symlinks and unsafe storage are rejected. Preserve this directory across container replacements.

The receiver binds to loopback by default. For a relay in another container, use a deliberately configured private network listener and service. Protect any connection crossing an untrusted network with TLS and access controls. Do not expose an unencrypted receiver or Homebridge's management or HomeKit ports directly to the internet.

## Event contract

Send `POST /presence/event` with `Content-Type: application/json` and the header `Authorization: Bearer <private token>`. The body has this shape:

```json
{
  "eventId": "stable-source-message-id",
  "locationId": "home",
  "event": "arrived",
  "occurredAt": "2026-01-01T12:00:00.000Z"
}
```

The timestamp and ID above are illustrative. Send the genuine event timestamp as a UTC ISO 8601 string ending in `Z`, with optional milliseconds, and a stable identifier for the source message; do not submit this example to a live bridge. Timezone-offset strings are not accepted. `event` is either `arrived` or `departed`. The request body is limited to 4 KiB and must not contain raw message content, addresses, tracking links, coordinates, or account credentials.

Use the original event time when the alert supplies a trustworthy timestamp. If only its delivery time is available, document that limitation: ordering by delivery cannot identify every delayed or out-of-order SMS. Never replace the timestamp with the retry time. Retries must retain the same event ID, timestamp, and payload.

The receiver rejects unknown places, invalid payloads, events older than `maxEventAgeSeconds`, and timestamps more than 30 seconds in the future. It ignores recognized duplicates and rejects events that would move a place backwards in time. A successful response means the event was accepted or already processed; it does not prove the alert describes the car's current physical position.

## Build the SMS-to-event relay

A possible route is:

**Cadillac boundary alert → Google Voice → Gmail → relay → Homebridge event receiver**

Google Voice offers **Settings → Messages → Forward messages to email**, separately from voicemail email notifications. Enable forwarding before testing with a new message. OnStar currently lists Google Voice among its supported SMS carriers; confirm actual alert delivery on the configured number. [Google Voice forwarding instructions](https://support.google.com/voice/answer/165221?hl=en), [OnStar SMS policy](https://www.onstar.com/legal/user-terms/texting).

The included [Gmail relay](gmail-relay.md) checks forwarded messages using read-only Google authorization. It maps a Cadillac alert name to a stable Homebridge place ID. The assumed wording still needs verification against live SMS.

## State and validation

Before the first accepted event, the place is unknown and Home reports it unavailable. The first event establishes a baseline without publishing a crossing notification. Restoring saved state after a restart also establishes a silent baseline. Later arrival/departure changes update the sensor and switch together and can trigger Home automations. The switch remains a read-only status mirror.

Accepted state and duplicate-detection information are persisted before an update is published. A storage failure prevents further updates and makes presence unavailable. The saved state contains no coordinates or SMS bodies, but it does contain place IDs, event identifiers, and timestamps; treat it as private.

Event state has no GPS freshness expiry: a parked car can remain Home for days without a new message. `maxEventAgeSeconds` limits newly submitted events, not how long an accepted state remains visible. Missing or delayed alerts can leave the last known state incorrect. Neither silence nor a disconnected relay means the car departed.

Validate the complete path with actual departure and arrival messages, beginning with a harmless notification or light. Also test duplicate delivery, a restart, and loss of relay connectivity. Confirm that event mode sends no background GPS requests before relying on the reduction in polling. Keep door, engine, and horn controls out of this validation. Review the [presence automation guidance](presence.md#create-automations) before connecting consequential routines.
