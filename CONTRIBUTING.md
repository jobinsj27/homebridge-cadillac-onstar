# Contributing

Use Node.js 22.12 or later in the 22, 24, or 26 release lines. These match the [current Homebridge support policy](https://github.com/homebridge/homebridge/wiki/How-To-Update-Node.js).

```sh
npm ci --ignore-scripts
npm test
npm run check:sdk
npm run check:package
```

These checks use synthetic data. They do not authenticate an account or contact a vehicle. The SDK smoke check blocks network and process-launch APIs and only constructs the pinned SDK client. Browser installation is not needed for these checks.

Keep changes focused and explain their behavior and validation in the pull request. Preserve the following properties:

- Only explicit On writes issue vehicle commands. False writes, reads, startup, reconnects, and shutdown do not.
- A switch reset updates its display after HomeKit acknowledges the write; it does not invoke another command.
- Concurrent commands are rejected without queuing, replay, or automatic retry.
- Background authentication uses saved sessions and cannot fall back to browser login.
- Credentials, session tokens, browser profiles, and raw upstream responses stay out of logs, tests, issues, and commits.

The dependency `onstarjs2` is pinned to a reviewed source hash. Updating it requires reviewing the authentication paths and token-write sites, updating the guard deliberately, and retaining the offline regression tests. Do not relax the guard to make a new dependency version load.

Manual vehicle checks require the owner's explicit consent and suitable physical conditions. Keep such checks outside CI. Never run a remote-start check with the vehicle in an enclosed space.

For a release, update the version and changelog, run all checks, review `npm pack --dry-run --ignore-scripts`, and confirm the public package contains no private state. Publishing requires a separate maintainer action and npm account authorization. This repository's CI does not publish packages and does not require an npm token.
