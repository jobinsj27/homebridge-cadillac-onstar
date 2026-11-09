# Changelog

## 0.3.0 — 2026-11-08

First public release as `homebridge-cadillac-onstar`.

- Four momentary Homebridge switches for Start, Stop, Lock, and Unlock.
- Fifteen-minute local remote-start tracking with duplicate-start protection.
- Saved-session authentication with a pinned, source-verified OnStarJS dependency and browser-login fallbacks disabled in the background worker.
- Private token storage, sanitized command failures, and no queued or automatic command retries.
- Setup, interactive sign-in, and connection-check command-line helpers.
- Offline regression tests, package-content inspection, and CI for Node.js 22, 24, and 26.
