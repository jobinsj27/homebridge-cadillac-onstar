# Email and SMS sign-in

The plugin uses a saved GM session. The sign-in utility supports accounts that verify by email or SMS; it does not require an authenticator setup key or an OnStar PIN. It opens GM's sign-in page, submits the credentials once, and lets you complete verification. The utility does not import the vehicle API or send vehicle commands.

These utilities use POSIX file permissions and are intended for Linux and macOS, including Linux Homebridge containers. Run them as the same operating-system user that runs Homebridge. On Windows, use a Linux Homebridge environment.

## Create private files

After installing the plugin, run:

```sh
cadillac-onstar-setup --state-dir /absolute/path/to/private-cadillac-state
```

Use a private directory inside your Homebridge storage, outside the plugin installation and outside your source repository. The command creates:

- `credentials.json`, with mode `0600` and empty account fields.
- `tokens/`, with mode `0700`.
- `.cache/browsers/`, with mode `0700`.

It generates a device ID, contacts no service, and refuses to overwrite an existing credential file. Edit `credentials.json` locally to set your Cadillac/GM account's `username` and `password`, and your 17-character `vin`. Keep the generated `deviceId` and absolute `tokenLocation`. Do not paste credentials, verification codes, or token files into an issue or chat.

Set the plugin's `credentialsFile` option to the absolute path of that file. The Homebridge process must be able to read it and write to the token directory.

## Install the matching browser

```sh
cadillac-onstar-install-browser --state-dir /absolute/path/to/private-cadillac-state
```

This explicitly downloads the Chromium revision used by the installed OnStarJS2 dependency. It does not read credentials or sign in. Linux hosts also need Chromium's operating-system libraries and a graphical display; install those through your operating system or container image. Browser installation is not an npm post-install step.

## Sign in

On a host with a graphical desktop:

```sh
cadillac-onstar-login --state-dir /absolute/path/to/private-cadillac-state
```

After the utility submits the account credentials, complete GM's email or SMS verification in the browser. A successful login saves the session under the configured token directory and closes the temporary browser profile. The runtime can then refresh this session without retaining the account password. You may remove the `password` field afterward; restore it privately when another manual login is needed.

If the browser cannot launch in a container because its sandbox is unavailable, use `--no-sandbox` only in that trusted container. A display such as Xvfb is still required. `--inspect-page` opens the initial page without entering credentials; it saves private page metadata for troubleshooting.

The helper makes one credential submission. It stops on a rejected code or after a 15-minute verification timeout. It does not repeatedly retry your password. An expired or revoked session requires another manual sign-in.

## Remote hosts without an accessible browser window

A visible browser can run on a virtual display while you complete the verification through private files in the state directory. The helper writes `login-state.json` containing the current phase and visible input/button IDs. It excludes input values and page body text; button labels may still contain masked account information, so keep this file private.

Use a local editor to create `login-control.json` with mode `0600`, containing one of the following commands. Replace the placeholders with IDs from the current state file. Enter the actual verification code only in this private file, never as a shell argument.

```json
{"action":"click","buttonId":"<current-send-or-verify-button-id>"}
```

```json
{"action":"code","inputId":"<current-verification-input-id>","code":"<your-verification-code>"}
```

```json
{"action":"cancel"}
```

The helper consumes and deletes each control file. Filling a code does not submit it: send a separate `click` command for the current verification button. Wait for the state file to update before issuing the next command. A control file left over before a new login is rejected; remove that stale file locally after checking its purpose. The helper never writes verification codes to its console output.

## Check the saved session

```sh
cadillac-onstar-check inspect --state-dir /absolute/path/to/private-cadillac-state
```

`inspect` reads vehicle details and prints a fixed success/failure summary. It is also the default action. The utility accepts `lock` and `unlock` only when you explicitly request those physical door commands. It has no start or stop action. SDK stdout and stderr are discarded so authentication data is not echoed by the check utility.

## Path options

All paths must be absolute. Each utility accepts `--credentials-file`, `--state-dir`, `--browser-path`, and `--help`. If you only supply a credential file, its parent directory becomes the default state directory. A browser path must point to the same directory for installation and login.

Without explicit flags, environment variables can supply paths:

| Variable | Purpose |
| --- | --- |
| `HOMEBRIDGE_CADILLAC_ONSTAR_STATE_DIR` | Private state directory |
| `HOMEBRIDGE_CADILLAC_ONSTAR_CREDENTIALS_FILE` | Private credential file |
| `HOMEBRIDGE_STORAGE_PATH` | Parent storage directory; the utilities append `cadillac-onstar` |
| `PLAYWRIGHT_BROWSERS_PATH` | Matching browser installation directory |

Otherwise the default is `~/.homebridge/cadillac-onstar`. Services and containers often use a different Homebridge storage location, so use explicit paths in those environments. `--help` performs no file access, login, download, or vehicle operation.

## Private state and troubleshooting

Credentials and token files must be regular files readable only by their owner. State and token directories must have mode `0700`. The utilities reject permissive files and symlink destinations instead of silently changing their permissions. Move private state with Homebridge's operating-system user and preserve its permissions when migrating hosts.

If GM blocks the login page or changes its authentication flow, the unofficial integration may need an update. Use the myCadillac app to verify that the account and connected-service plan work. Report only the helper's fixed error category and software versions; do not attach credential files, saved sessions, browser profiles, control files, or private page metadata.
