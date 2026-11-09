# Cadillac OnStar for Homebridge

Four momentary Apple Home switches for Cadillac vehicles with OnStar remote commands.

This is an independent, unofficial integration using [OnStarJS2](https://github.com/BigThunderSR/OnStarJS). It is not affiliated with or endorsed by Cadillac, General Motors, OnStar, Apple, or Homebridge.

| Switch | Turning it on requests |
| --- | --- |
| Cadillac Start | Remote start |
| Cadillac Stop | Cancellation of a remote-start session |
| Cadillac Lock | Lock all doors |
| Cadillac Unlock | Unlock all doors |

Each switch resets off after its request completes or fails. Turning a switch off sends no command. These are command buttons, not indicators of engine or door state. The display prefix is configurable.

Stop cancels remote start; it is not a general-purpose engine kill switch after a driver takes over. Use remote start only outdoors, never in an enclosed garage.

## Compatibility and limits

- An active GM/OnStar account and a connected-service plan that allows remote commands. Confirm the desired commands work in myCadillac first.
- One vehicle per Homebridge instance of this singular platform.
- Linux or macOS, including Linux Homebridge containers. The private-file tools use POSIX permissions; Windows users should use a Linux Homebridge environment.
- Node.js 22.12+, 24, or 26, and Homebridge 1.8+ or 2.x.
- A saved GM session established through the included manual email/SMS sign-in tool. No OnStar PIN or authenticator setup key is required.
- Chromium is needed for manual sign-in only. Runtime vehicle commands use the saved session.

Development and real lock/unlock validation used a 2023 Cadillac Escalade ESV. Other Cadillac models and regions have not been validated. There are no liftgate controls, telemetry polling, battery/fuel indicators, or live lock-state reporting.

Remote-start duration is controlled by the vehicle. The plugin keeps a 15-minute local duplicate-start guard after a confirmed request; it does not impose a universal 15-minute runtime on all Cadillac models. Consult your vehicle's manual for its limits. The guard clears when Homebridge restarts.

## Install

Install the tagged GitHub release in the same environment that runs Homebridge:

```sh
npm install -g github:jobinsj27/homebridge-cadillac-onstar#v0.3.0
```

For Homebridge installations that manage plugins in a local storage directory, run the equivalent install there using your usual Homebridge plugin-management workflow. Do not install a second Homebridge service.

Once the npm release is available, the package name to search for in Homebridge UI is **homebridge-cadillac-onstar**. npm publication makes it eligible for normal plugin discovery; Homebridge verification is a separate review. This plugin does not claim verified status.

Installing the package does not sign in, download a browser, or send vehicle commands. An unconfigured platform remains inactive.

## Set up a saved session

Use a private directory inside your Homebridge storage, outside the plugin directory and any source repository. Run the tools as the same operating-system user as Homebridge:

```sh
cadillac-onstar-setup --state-dir /absolute/homebridge/storage/cadillac-onstar
cadillac-onstar-install-browser --state-dir /absolute/homebridge/storage/cadillac-onstar
```

The setup command creates a private credential template, a generated device ID, and a token directory. Edit the template locally to supply your account username, password, and vehicle VIN. Never put these values in Homebridge's public configuration or a GitHub issue.

Then sign in and check the saved session:

```sh
cadillac-onstar-login --state-dir /absolute/homebridge/storage/cadillac-onstar
cadillac-onstar-check inspect --state-dir /absolute/homebridge/storage/cadillac-onstar
```

The login tool opens GM's sign-in page for email/SMS verification. Containers need a graphical or virtual display and Chromium's operating-system dependencies. The inspection command reads vehicle details; it sends no door or engine command.

See [the authentication guide](docs/authentication.md) for containers, virtual displays, private verification-code entry, custom paths, and reconnecting an expired session. The runtime never falls back to automatic password login. You can remove the password from the private credential file after a successful sign-in.

## Configure Homebridge

Add a **CadillacOnStar** platform in the Homebridge UI settings, or use:

```json
{
  "platform": "CadillacOnStar",
  "name": "Cadillac",
  "vehicleName": "Cadillac",
  "model": "OnStar Vehicle",
  "credentialsFile": "/absolute/homebridge/storage/cadillac-onstar/credentials.json"
}
```

Replace the example path with the actual private file. Set `vehicleName` to the prefix you want on all four switches, such as `Family SUV`. The `model` field is a display label only; the private VIN selects the vehicle.

Use a child bridge so reconnecting or restarting the integration does not interrupt unrelated accessories. In Homebridge UI, enable its child bridge and pair that bridge's QR code or setup code in Apple Home. [Homebridge child-bridge instructions](https://github.com/homebridge/homebridge/wiki/Child-Bridges).

| Option | Default | Purpose |
| --- | --- | --- |
| `name` | `Cadillac` | Platform label |
| `vehicleName` | `Cadillac` | Switch-name prefix |
| `model` | `OnStar Vehicle` | Display-only model label |
| `credentialsFile` | Unset | Absolute path to private mode-0600 credentials; required to activate controls |
| `browserPath` | Cache under Homebridge storage | Optional absolute browser-download path; used only for manual sign-in support |
| `accessoryUuidPrefix` | `homebridge-cadillac-onstar` | Advanced migration option; leave unchanged after pairing |

Keep credential and token files mode `0600` and their private directories mode `0700`. Browser downloads belong in a `.cache` directory, which Homebridge UI excludes from its backups. Saved tokens remain outside that directory and should be treated as account credentials.

## Command behavior

Only an explicit on-write sends a command. Startup, reconnection, reads, off-writes, switch resets, timers, and shutdown send no vehicle commands.

Only one command may run at a time. Additional requests are rejected as busy rather than queued. Failed requests are not retried by the plugin. OnStarJS2 retains its upstream API-version fallback behavior.

A repeated Start request during a locally tracked session is ignored rather than extending the session. Stop is sent when explicitly requested even if the plugin did not start the session, including after a Homebridge restart.

OnStar can take longer than Apple Home's request timeout. Home may show No Response while the plugin waits for completion. Avoid repeated taps while a command is pending. Changes made with the key fob or myCadillac are not reflected here.

All four accessories use HomeKit's Switch service, including Unlock. They do not have the secure-accessory behavior of a HomeKit LockMechanism.

## Upgrading the original local plugin

The original development package was named `homebridge-escalade-onstar`. Its source and deployment-specific installers were not part of this public package.

Changing the npm name also changes Homebridge's cached plugin ownership. Setting `accessoryUuidPrefix` to `homebridge-escalade-onstar` preserves the accessory UUID calculation, but does not by itself move the cached accessories to the new platform. Do not install both plugins with the same namespace.

See [the migration guide](docs/migration.md) before replacing a paired local installation. New users should keep the default namespace.

## Troubleshooting and privacy

Check myCadillac first when commands fail. GM authentication changes, plan entitlements, vehicle connectivity, and remote-start limits still apply. If the saved session expires or is revoked, sign in again manually.

The runtime isolates the unofficial SDK and discards its console output because upstream messages may contain account data. Only fixed status/error categories reach Homebridge. The SDK version and bundle checksum are pinned; an unexpected upstream version fails closed until reviewed.

There is no analytics or automatic diagnostics polling. See [SECURITY.md](SECURITY.md) for sensitive-file handling and vulnerability reports. Do not upload credentials, saved tokens, browser profiles, private login files, or unreviewed SDK logs.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run check:sdk
npm run check:package
```

Unit tests use fake clients and clocks. The SDK check blocks network/process activity and exercises the pinned adapter with synthetic inputs. Package inspection checks the distribution allowlist and common secret patterns. None of these checks sends a vehicle command.

CI runs the same checks on Node.js 22, 24, and 26. See [CONTRIBUTING.md](CONTRIBUTING.md) for release and contribution guidance.

## License

[MIT](LICENSE). OnStarJS2 and its dependencies retain their own licenses. Cadillac and OnStar names identify compatibility and are trademarks of their respective owners.
