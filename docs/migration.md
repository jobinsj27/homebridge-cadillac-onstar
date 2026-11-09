# Migrate the legacy Escalade plugin

Fresh installations do not need this procedure. It is for the earlier local
`homebridge-escalade-onstar` package using the `EscaladeOnStar` platform on its own
paired Homebridge child bridge.

The new package is `homebridge-cadillac-onstar`, with platform `CadillacOnStar`.
Changing only the platform name or `accessoryUuidPrefix` is insufficient:
Homebridge routes cached accessories by their stored plugin and platform owners
before calling the plugin. The [cache serializer](https://github.com/homebridge/homebridge/blob/latest/src/platformAccessory.ts)
stores those owners in `plugin` and `platform`; the [restore code](https://github.com/homebridge/homebridge/blob/v1.11.2/src/bridgeService.ts#L264-L298)
uses them to find the active platform.

## What is preserved

The helper keeps the complete `_bridge` configuration, including its username,
port and any pairing options. It retains every existing accessory UUID and all
other cache fields. It updates only the selected platform configuration, exact
legacy entries in plugin allow/disable lists, and the owners of known legacy
accessories. Unrelated platform and cache entries remain unchanged.

The four-switch layout retains Start, Stop, Lock and Unlock. For the earlier
Start/Doors layout, Start retains its identity; on the next launch the new plugin
removes the obsolete Doors accessory and adds Stop, Lock and Unlock. The helper
does not remove the Doors entry itself.

Credentials, token files, browser downloads and `persist` are never opened or
modified by the helper. Existing explicit credential and browser paths remain in
the configuration. If the legacy configuration omitted `browserPath`, its old
fallback beside the credentials file is retained. Existing accessory names supply
the default `vehicleName` during migration.

## Stop and back up first

Stop the **whole Homebridge service**, including its child bridges, using the
normal service/container controls for your installation. Keep it stopped until
the entire procedure is finished. Stopping only the selected child bridge is
insufficient: the main process or UI could still overwrite configuration.

Run the commands as the same operating-system account that owns Homebridge
storage. Substitute your real storage directory and the existing child bridge's
`_bridge.username`; do not generate a new username or pair a replacement bridge.
These are local paths and a bridge identifier, not your OnStar account login.

```sh
HB_STORAGE="/absolute/path/to/homebridge"
HB_CHILD_USERNAME="AA:BB:CC:DD:EE:FF"
```

Before changing packages, back up `config.json`, the complete `accessories`
directory and the complete `persist` directory. Keep an installer or package
archive for the old plugin, plus a separate private backup of its credentials and
saved tokens. A filesystem backup of the Homebridge identity files can be made
while the service is stopped:

```sh
umask 077
mkdir -p "$HB_STORAGE/cadillac-onstar/migration-backups"
tar -czf "$HB_STORAGE/cadillac-onstar/migration-backups/pre-migration-$(date +%Y%m%d-%H%M%S).tgz" \
  -C "$HB_STORAGE" config.json accessories persist
```

These backups contain private configuration and HomeKit pairing material. Keep
them private; do not attach them to an issue or commit them to Git.

## Preview and apply

Install the new package while Homebridge remains stopped, without removing the
old package yet. Use your installation's normal npm location. For plugins kept
in the Homebridge storage directory:

```sh
npm install --prefix "$HB_STORAGE" --omit=dev --ignore-scripts github:jobinsj27/homebridge-cadillac-onstar#v0.3.0
node "$HB_STORAGE/node_modules/homebridge-cadillac-onstar/bin/migrate-legacy.js" \
  --storage-dir "$HB_STORAGE" --child-bridge-username "$HB_CHILD_USERNAME"
```

The helper defaults to a dry run. It prints a fixed summary without displaying
configuration, credentials, pairing codes or cache contents. It requires exactly
one matching platform and a recognized legacy accessory set. Unexpected owners,
UUIDs, duplicate identities, shared bridge identities, symlinked input files or
incomplete layouts stop the migration. There is no force option.

It selects the child cache at
`accessories/cachedAccessories.<UPPERCASE_USERNAME_WITHOUT_COLONS>`, matching
[Homebridge's child-bridge naming](https://github.com/homebridge/homebridge/blob/latest/src/childBridgeService.ts#L656-L660).
The helper currently supports that standard child-bridge layout only. It does
not migrate a shared main bridge or a custom cache layout.

After reviewing the dry run and confirming Homebridge is still stopped:

```sh
node "$HB_STORAGE/node_modules/homebridge-cadillac-onstar/bin/migrate-legacy.js" \
  --storage-dir "$HB_STORAGE" --child-bridge-username "$HB_CHILD_USERNAME" --apply
```

Applying creates byte-exact backups of the two files it changes in a new private
directory under `cadillac-onstar/migration-backups`. Backup files and replacement
files use mode 0600; backup directories use mode 0700. It detects input changes
between planning and writing. Each file is replaced by an atomic rename, but the
pair of replacements is not one filesystem transaction. The helper cannot prove
that Homebridge is stopped, particularly on remotely mounted storage.

The resulting platform uses `CadillacOnStar` and
`"accessoryUuidPrefix": "homebridge-escalade-onstar"`. Keep that namespace
unchanged after migration. The existing `_bridge`, credentials file and browser
override remain in place. The helper does not import the OnStar SDK, authenticate,
contact the vehicle, install packages or restart any service.

Remove only the old npm package, using the same npm location in which it was
installed. For the local installation above:

```sh
npm uninstall --prefix "$HB_STORAGE" --ignore-scripts homebridge-escalade-onstar
```

Do not remove private account directories, backups, `accessories` or `persist`.
If either plugin was installed globally or in a different prefix, use the
corresponding package-management location rather than the local example.

Start Homebridge. Confirm that the existing child bridge loads the new plugin and
shows four momentary switches in Apple Home. No vehicle command is needed to
verify that migration succeeded. The plugin sends no command on startup or GET.

## Interrupted migration or rollback

If applying fails, keep Homebridge stopped. Review the private backups before
continuing. The helper accepts an interrupted state in which one file has already
been migrated; rerun the dry run and then `--apply` to complete the same migration.
A fully migrated state is a no-op, so repeating the helper does not create new
accessories or extra backups.

To roll back, keep Homebridge stopped, restore the old package, and restore the
original config and selected child cache from the pre-migration checkpoint. The
first helper backup also contains both original files; later backups made while
recovering an interruption may already contain one migrated file, so do not assume
the newest backup is an original pair. If pairing files changed after a restart,
restore the corresponding complete `persist` checkpoint as well. Preserve their
owner and private permissions. Restart only after the package, config and cache
agree. Do not reset the bridge or remove it from Apple Home as part of a routine
migration.
