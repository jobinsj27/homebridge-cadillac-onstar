# Cadillac OnStar for Homebridge

Momentary Apple Home controls and optional vehicle-location presence, developed around the 2023 Cadillac Escalade ESV.

The configurable controls, Find Car, and location-presence features on this branch are unreleased. The published `0.3.0` release provides the original four command switches.

This is an independent, unofficial integration using [OnStarJS2](https://github.com/BigThunderSR/OnStarJS). It is not affiliated with or endorsed by Cadillac, General Motors, OnStar, Apple, or Homebridge.

| Switch | Turning it on requests |
| --- | --- |
| Cadillac Start | Remote start |
| Cadillac Stop | Cancellation of a remote-start session |
| Cadillac Lock | Lock all doors |
| Cadillac Unlock | Unlock all doors |
| Cadillac Find Car *(optional)* | Sound the horn and flash the lights |
| Cadillac Stop Alert *(optional)* | Cancel the horn-and-lights alert |

Each command switch resets off after its request completes or fails. Turning a command switch off sends no command. These are command buttons, not indicators of engine, door, or alert state. The display prefix is configurable. The original four controls are enabled by default; Find Car and Stop Alert are an optional pair.

Optional **Cadillac at Home** or **Cadillac at Work** occupancy sensors report whether the vehicle is inside a configured location boundary. They can trigger Apple Home automations. Presence is disabled by default and requires fresh vehicle-location data; see [the presence guide](docs/presence.md).

Stop cancels remote start; it is not a general-purpose engine kill switch after a driver takes over. Use remote start only outdoors, never in an enclosed garage.

## Compatibility and limits

- An active GM/OnStar account and a connected-service plan that allows remote commands. Confirm the desired commands work in myCadillac first.
- One vehicle per Homebridge instance of this singular platform.
- Linux or macOS, including Linux Homebridge containers. The private-file tools use POSIX permissions; Windows users should use a Linux Homebridge environment.
- Node.js 22.12+, 24, or 26, and Homebridge 1.8+ or 2.x.
- A saved GM session established through the included manual email/SMS sign-in tool. No OnStar PIN or authenticator setup key is required.
- Chromium is needed for manual sign-in only. Runtime vehicle commands use the saved session.

The compatibility and testing baseline is a **2023 Cadillac Escalade ESV**. Real lock/unlock validation and both stale and fresh location-response checks used that vehicle. The packaged location checker confirmed a fresh GPS observation aged two seconds; an earlier response contained a GPS observation over two hours old despite a recent server processing time. Its reported capabilities also confirmed alert and cancel-alert support. Actual arrival/departure boundary crossings and physical horn-and-lights activation remain untested. Other models and regions have not been validated. There are no EV charging controls, liftgate controls, battery/fuel indicators, or live lock-state reporting.

For location presence, the vehicle and connected-service plan must support locating the vehicle. Confirm Vehicle Locate works in myCadillac. A successful HTTP response or a map pin alone does not prove that the location is recent enough for an automation.

Remote-start duration is controlled by the vehicle. The plugin keeps a 15-minute local duplicate-start guard after a confirmed request; it does not impose a universal 15-minute runtime on all Cadillac models. Consult your vehicle's manual for its limits. The guard clears when Homebridge restarts.

## Install

Install the published release in the same environment that runs Homebridge:

```sh
npm install -g --ignore-scripts homebridge-cadillac-onstar@0.3.0
```

For Homebridge installations that manage plugins in a local storage directory, run the equivalent install there using your usual Homebridge plugin-management workflow. Do not install a second Homebridge service.

The package name to search for in Homebridge UI is **homebridge-cadillac-onstar**. npm publication makes it eligible for normal plugin discovery; Homebridge verification is a separate review. This plugin does not claim verified status.

Use `--ignore-scripts` to keep browser installation explicit: the pinned OnStarJS2 dependency has its own Chromium-download `postinstall` script. A UI-managed installation that allows dependency lifecycle scripts may run that download. The plugin itself has no installation script that signs in or sends vehicle commands. An unconfigured platform remains inactive.

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

Replace the example path with the actual private file. Set `vehicleName` to the prefix you want on the accessories, such as `Family SUV`. The `model` field is a display label only; the private VIN selects the vehicle.

Use a child bridge so reconnecting or restarting the integration does not interrupt unrelated accessories. In Homebridge UI, enable its child bridge and pair that bridge's QR code or setup code in Apple Home. [Homebridge child-bridge instructions](https://github.com/homebridge/homebridge/wiki/Child-Bridges).

| Option | Default | Purpose |
| --- | --- | --- |
| `name` | `Cadillac` | Platform label |
| `vehicleName` | `Cadillac` | Accessory-name prefix |
| `model` | `OnStar Vehicle` | Display-only model label |
| `credentialsFile` | Unset | Absolute path to private mode-0600 credentials; required to activate controls |
| `browserPath` | Cache under Homebridge storage | Optional absolute browser-download path; used only for manual sign-in support |
| `accessoryUuidPrefix` | `homebridge-cadillac-onstar` | Advanced migration option; leave unchanged after pairing |
| `controls.start`, `controls.stop`, `controls.lock`, `controls.unlock` | `true` | Show the corresponding command switch |
| `controls.findCar` | `false` | Show both Find Car and Stop Alert |
| `presence.enabled` | `false` | Enable location polling and named-place presence sensors |
| `presence.locations` | Empty | Named coordinates and arrival/departure boundaries; see the presence guide |

Keep credential and token files mode `0600` and their private directories mode `0700`. Browser downloads belong in a `.cache` directory, which Homebridge UI excludes from its backups. Saved tokens remain outside that directory and should be treated as account credentials.

For example, to hide remote start and enable the alert controls, add:

```json
"controls": {
  "start": false,
  "stop": true,
  "lock": true,
  "unlock": true,
  "findCar": true
}
```

Omitted flags keep their defaults. Use JSON booleans, not strings. Disabling a control removes its accessory from Homebridge; re-enabling it uses the same accessory identifier. Removing an accessory can affect Home automations that refer to it, so review those automations when changing enabled controls. Renaming the display prefix does not change identifiers.

## Command behavior

Only an explicit on-write to a command switch requests an engine, door, or alert action. Startup, reconnection, accessory reads, off-writes, switch resets, timers, and shutdown do not request those actions. When presence is enabled, background timers separately request vehicle-location telemetry; HomeKit reads use the latest local result.

Only one vehicle operation may run at a time. Additional command requests are rejected as busy rather than queued. A background location poll skips a busy command; a manual command during an in-flight location read also returns Busy. Runtime location reads have a 35-second deadline. Failed commands are not retried by the plugin. OnStarJS2 retains its upstream API-version fallback behavior.

A repeated Start request during a locally tracked session is ignored rather than extending the session. Stop is sent when explicitly requested even if the plugin did not start the session, including after a Homebridge restart.

OnStar can take longer than Apple Home's request timeout. Home may show No Response while the plugin waits for completion. Avoid repeated taps while a command is pending. Changes made with the key fob or myCadillac are not reflected here.

Command accessories use HomeKit's Switch service, including Unlock. They do not have the secure-accessory behavior of a HomeKit LockMechanism. Find Car and Stop Alert use this same momentary behavior; Stop Alert cancels an existing alert without needing a locally remembered Find Car request.

## Vehicle presence and automations

Configure one or more places to expose a sensor such as **Cadillac at Home**. One vehicle-location request supplies all places. Separate arrival and departure radii and consecutive fresh observations help avoid false changes near a boundary.

Failed refreshes retain an established state only while its GPS observation remains fresh. Once that observation expires, the sensor becomes unavailable; it does not mean the vehicle departed. One new fresh fix matching the previous state can restore availability; a different or unknown state still requires confirmation samples. Initial readings and recovery from an outage establish a baseline without emitting an arrival/departure notification. The optional switch mirror is a status indicator whose manual writes are rejected, not a way to change the vehicle's reported location.

Presence follows the **vehicle**, not its occupants. For a cleaning routine, add Apple Home's “nobody is home” condition if people may remain home after the car leaves. Location polling has cloud and vehicle delays, so it does not establish that a car has cleared a garage doorway. Use the garage door's normal obstruction protection and appropriate additional conditions for garage automations.

See [the presence guide](docs/presence.md) for configuration, freshness rules, polling, test steps, and privacy.

## Upgrading the original local plugin

The original development package was named `homebridge-escalade-onstar`. Its source and deployment-specific installers were not part of this public package.

Changing the npm name also changes Homebridge's cached plugin ownership. Setting `accessoryUuidPrefix` to `homebridge-escalade-onstar` preserves the accessory UUID calculation, but does not by itself move the cached accessories to the new platform. Do not install both plugins with the same namespace.

See [the migration guide](docs/migration.md) before replacing a paired local installation. New users should keep the default namespace.

## Troubleshooting and privacy

Check myCadillac first when commands fail. GM authentication changes, plan entitlements, vehicle connectivity, and remote-start limits still apply. If the saved session expires or is revoked, sign in again manually.

The runtime isolates the unofficial SDK and discards its console output because upstream messages may contain account data. Commands expose fixed status/error categories; location presence uses only validated location observations. Raw SDK responses and errors are not logged. The SDK version and bundle checksum are pinned; an unexpected upstream version fails closed until reviewed.

There is no analytics or automatic diagnostics polling. Vehicle-location polling runs only when explicitly enabled. The plugin does not store trip history. Place coordinates are part of your Homebridge configuration and its backups; remove them before sharing configuration. See [SECURITY.md](SECURITY.md) for sensitive-file handling and vulnerability reports. Do not upload credentials, saved tokens, browser profiles, private login files, coordinates, or unreviewed SDK logs.

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
