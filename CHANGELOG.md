# Changelog

## Unreleased

- Optional controls for the existing Start, Stop, Lock, and Unlock switches, preserving their accessory identifiers.
- Optional momentary Find Car and Stop Alert controls for the 2023 Cadillac Escalade ESV compatibility baseline.
- Opt-in named-place occupancy sensors with optional status-switch mirrors, shared vehicle-location polling, separate arrival/departure boundaries, and fresh-sample confirmation.
- Unavailable location handling, polling backoff, and baseline establishment after startup or connection loss to avoid inventing arrivals or departures.
- Presence configuration and validation guidance, with no EV charging or liftgate features.
- A bounded `cadillac-onstar-check location` command reporting observation age and freshness without coordinates.
- Corrected installation guidance for the upstream dependency's browser-download lifecycle script; explicit installs use `--ignore-scripts`.

The 2023 Escalade ESV reported alert and cancel-alert capability. Both stale and fresh location telemetry were validated: an earlier GPS observation was over two hours old, and the packaged location checker later reported a fresh observation aged two seconds. Actual arrival/departure boundary crossings and physical horn-and-lights activation remain untested.

## 0.3.0 — 2026-11-08

First public release as `homebridge-cadillac-onstar`.

- Four momentary Homebridge switches for Start, Stop, Lock, and Unlock.
- Fifteen-minute local remote-start tracking with duplicate-start protection.
- Saved-session authentication with a pinned, source-verified OnStarJS dependency and browser-login fallbacks disabled in the background worker.
- Private token storage, sanitized command failures, and no queued or automatic command retries.
- Setup, interactive sign-in, and connection-check command-line helpers.
- Offline regression tests, package-content inspection, and CI for Node.js 22, 24, and 26.
