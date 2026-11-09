# Security

Security fixes target the latest published release. This unofficial integration can issue vehicle commands; a saved OnStar session must be treated as a credential.

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/jobinsj27/homebridge-cadillac-onstar/security/advisories/new) when available. If that channel is unavailable, open an issue asking the maintainer for a private contact method without describing an exploitable vulnerability or attaching private data.

Do not include account passwords, verification codes, refresh or access tokens, VINs, credential files, browser profiles, unredacted logs, or Homebridge backups in a report. Synthetic examples and the affected package version are usually sufficient to begin an investigation.

The plugin pins the upstream SDK, verifies its source, disables background browser-login fallbacks, restricts token-file permissions, and discards upstream worker output. Report any path that bypasses those controls or sends a vehicle command without an explicit request.
