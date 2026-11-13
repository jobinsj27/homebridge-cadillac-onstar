# Changelog

## Unreleased

- Optional outbound Gmail relay for Google Voice boundary alerts, with read-only OAuth and provisional Escalade arrival/departure matching.

- Optional controls for the existing Start, Stop, Lock, and Unlock switches, preserving their accessory identifiers.
- Optional momentary Find Car and Stop Alert controls for the 2023 Cadillac Escalade ESV compatibility baseline.
- Opt-in named-place occupancy sensors with optional status-switch mirrors, shared vehicle-location polling, separate arrival/departure boundaries, and fresh-sample confirmation.
- Optional authenticated arrival/departure event source with no scheduled GPS polling, private persisted presence, duplicate detection, and timestamp ordering. It preserves place accessory identifiers and establishes silent baselines at startup.
- Event receiver setup and Google Voice-to-Gmail relay guidance. Gmail authorization, actual Cadillac message parsing, and live arrival/departure validation remain separate setup steps; enrollment and an ordinary SMS forwarding test do not establish the complete route.
- Unavailable location handling, polling backoff, and baseline establishment after startup or connection loss to avoid inventing arrivals or departures.
- Preserve still-fresh presence through a failed refresh, retry the first failure at the configured interval, and recover a previously confirmed state from one new matching fix. Freshness expiry and confirmation of changed states remain enforced.
- Add transition-only location health logs without coordinates, account information or raw API errors.
- Allow 90 seconds for an asynchronous vehicle GPS refresh within a 120-second runtime request deadline, so a normal delayed update is not cut short by the earlier 20/35-second limits.
- Collect a pending GPS refresh with passive follow-up checks every 30 seconds instead of starting another vehicle refresh; stop pending retries after three minutes and preserve genuine timestamp expiry.
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
