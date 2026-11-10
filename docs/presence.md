# Vehicle location presence

This opt-in feature compares the vehicle's observed position with saved places such as Home or Work. It exposes an occupancy sensor for each place. The compatibility and testing baseline is the **2023 Cadillac Escalade ESV**; another model's capabilities are not assumed.

This guide describes unreleased functionality. Both stale and fresh telemetry were checked on the target Escalade. An earlier response contained a GPS observation over two hours old despite a recent server processing time; the packaged location checker later confirmed a fresh observation aged two seconds. Actual arrival/departure boundary crossings still must be validated on the target vehicle before relying on an automation. Location presence does not change the vehicle's locks, engine, horn, or lights.

## Configure places

In the Homebridge plugin settings, enable presence and add a place with a stable ID, a display name, coordinates, and arrival/departure radii. Keep the place ID unchanged after creating automations; changing its name is safe. Each place gets an accessory named `<vehicleName> at <place name>`.

The following JSON illustrates the shape. Its coordinates are deliberately synthetic; replace them with your chosen place before enabling the feature.

```json
{
  "presence": {
    "enabled": true,
    "pollIntervalSeconds": 300,
    "maxLocationAgeSeconds": 600,
    "confirmationSamples": 2,
    "exposeSwitch": false,
    "locations": [
      {
        "id": "home",
        "name": "Home",
        "latitude": 0,
        "longitude": 0,
        "arrivalRadiusMeters": 150,
        "departureRadiusMeters": 250
      }
    ]
  }
}
```

Add this `presence` object to the existing `CadillacOnStar` platform configuration. Coordinates remain in that configuration and its Homebridge backups. Do not paste your actual Home or Work coordinates into a public issue.

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Starts location polling and registers presence accessories |
| `locations` | Empty | One to twenty named places when enabled |
| `locations[].id` | Required | Stable, unique ID, up to 48 letters, digits, hyphens, or underscores; begins with a letter or digit |
| `locations[].name` | Place ID | Place label used in Home, up to 48 characters |
| `locations[].latitude` | Required | Latitude in degrees, from −90 through 90 |
| `locations[].longitude` | Required | Longitude in degrees, from −180 through 180 |
| `locations[].arrivalRadiusMeters` | `150` | Arrival distance; an integer from 1 through 100,000 metres |
| `locations[].departureRadiusMeters` | `250` | Departure distance; an integer up to 100,000 metres and greater than arrival radius |
| `pollIntervalSeconds` | `300` | Time between location polls; an integer from 60 through 86,400 seconds |
| `maxLocationAgeSeconds` | `600` | Maximum observation age; an integer from 60 through 86,400 seconds and at least the polling interval |
| `confirmationSamples` | `2` | Consecutive distinct fresh observations required to establish a state change; an integer from 1 through 5 |
| `exposeSwitch` | `false` | Adds a status-switch mirror beside each occupancy sensor |

One location poll is shared across every configured place. Multiple places do not multiply vehicle requests. Background polling does not start when presence is disabled.

GM can finish a requested GPS update asynchronously. If an update is still pending, the plugin checks that same request every 30 seconds without sending another vehicle refresh request. These follow-up checks stop after a three-minute pending window; normal polling resumes after completion or timeout. Waiting does not count as a location confirmation or extend the age of an older fix.

## Presence and freshness

A place is present when accepted observations establish that the car is within its arrival boundary. After presence is established, it remains present until observations establish that the car is beyond its larger departure boundary. Readings between the two boundaries retain the established state. This gap helps prevent GPS drift from repeatedly triggering automations.

Observations must have valid coordinates and a usable vehicle observation time. The time the plugin received an HTTP response is not a substitute for the time the vehicle position was observed. Cached repeats, older observations, missing timestamps, incomplete refreshes, or stale data cannot count as new confirmation samples. When an accuracy estimate is available, a reading whose uncertainty overlaps a boundary does not establish a crossing.

A failed refresh does not immediately discard a previously confirmed state whose GPS observation is still fresh. Failed, incomplete, or stale responses never extend that observation's expiry. Once it expires, reads report an error and the occupancy sensor reports a fault; the last confirmed value may remain cached. Missing data never means “away.” One new fresh observation matching the previous confirmed state can restore availability. A different or previously unknown state still requires the configured confirmation samples. Recovery establishes a baseline without inventing an arrival or departure during the outage.

Initial confirmation after startup also establishes a baseline. The plugin does not send an arrival/departure notification for that baseline. A Home hub or another automation client may independently reevaluate a cached or newly read value when reconnecting, so test restart and reconnection behavior with your own automations.

## Polling and response time

The default interval is five minutes, with two confirmation observations. A boundary change therefore is not immediate: detection includes the wait for successive polls, GM's response time, and the age of the vehicle's data. A default configuration can take several minutes to confirm a change. Reducing the interval does not guarantee that GM will provide a new observation sooner.

The SDK's location operation requests a telemetry refresh from the vehicle. No generally safe continuous polling rate is documented by this integration. The defaults are configurable design choices, not an OnStar service guarantee or battery-life guarantee. Begin conservatively, especially for a vehicle parked for long periods. The first transport failure retries at the configured interval; repeated transport failures use exponential backoff. Stale, missing, or invalid GPS observations retain the configured polling cadence so a new fix can be noticed promptly when the car moves. Do not increase the maximum observation age simply to make an old parked position appear healthy. Fixed log messages report failed or stale refreshes and their recovery without including locations or raw API errors.

Only one vehicle operation runs at a time. A background location poll skips a busy command. A manual command arriving during an in-flight location read returns Busy and is not queued or replayed. The SDK allows up to 90 seconds for a vehicle telemetry refresh to finish; each runtime location request has a 120-second deadline, including authentication and network overhead. A new worker has a separate 15-second startup limit. The separate command-line check below permits up to 120 seconds. Neither an expired deadline nor a transport failure means the car has departed.

Location observations need compatible hardware, a suitable connected-service plan, a working saved session, and usable vehicle connectivity. Confirm Vehicle Locate works in myCadillac before enabling polling. Avoid repeatedly refreshing both the app and the plugin while investigating a delayed response.

## Create automations

In Apple Home, create an automation using **A Sensor Detects Something**, select the vehicle's place sensor, then select the detected or no-longer-detected condition and the accessories or scene to control. The exact labels depend on the Home version. A home hub is required for Home automations. See [Apple's automation instructions](https://support.apple.com/en-in/102313).

Examples include turning on driveway lights when the car arrives, locking household doors after it leaves, or starting a supported cleaning routine. Vehicle presence is not people presence: someone can remain home when the car leaves, or come home without that car. Add a **nobody is home** condition when that is what the routine requires; see [Apple's sensor-trigger conditions](https://support.apple.com/en-euro/guide/shortcuts/apdb450f6291/ios).

The optional `<vehicleName> at <place name> Switch` mirrors the same presence result for clients that prefer a switch tile. Its manual writes are rejected and may show an error in Home. Tapping it does not change presence or send a vehicle command. Use the occupancy sensor for the primary automation trigger.

A location boundary does not prove that the car is inside a garage, has cleared its doorway, or that the path is clear. Retain the garage door's own safety sensors and use appropriate additional conditions. Cloud location is not a replacement for a clearance or obstruction sensor.

## Validate before enabling consequential automations

Check the location data without exposing coordinates:

```sh
cadillac-onstar-check location --state-dir /absolute/homebridge/storage/cadillac-onstar
```

This explicitly requests vehicle-location telemetry and prints only a fixed summary, `FRESH` or `STALE`, and the observation age in whole seconds. It uses the GPS observation timestamp, not the server processing time. Its freshness threshold is 600 seconds; it does not read the Homebridge presence settings. A valid but old fix succeeds with a `STALE` label. An incomplete refresh, unusable observation, or failed request fails without printing coordinates, account identifiers, or raw API errors. This check does not establish that the location is accurate or that the vehicle is inside a configured place.

The check command accepts `inspect`, `location`, `lock`, and `unlock`; its default remains `inspect`. It cannot start or stop the engine or activate an alert. Location and inspection are the only actions needed for presence validation.

1. Verify location access and observation age on the target Escalade using the check above, without issuing engine or alert commands.
2. Begin with a harmless notification or light. Compare its state against the car's actual location and myCadillac while parked, after leaving, and after returning.
3. Check that multiple readings confirm a boundary crossing and that the state does not oscillate near the boundary. Increase the boundary separation if needed.
4. Test Homebridge restart, interrupted connectivity, and recovery. None should be interpreted as an invented departure or arrival.
5. Only then connect the sensor to the intended routine and test that routine's other conditions.

Test lock, engine, and alert controls separately and deliberately. Presence testing does not require starting the engine, locking or unlocking the car, or sounding the horn through the plugin.

## Privacy

The feature needs your chosen place coordinates and the latest vehicle observation. It does not maintain a trip history. Runtime logs must not include coordinates, raw GM responses, tokens, or account identifiers. Homebridge's configuration and backups can contain your saved place coordinates; treat them as private and redact them from support reports.

Automated tests use synthetic positions and fake clients. A passing automated test does not establish the quality or timeliness of the live vehicle's location data.
