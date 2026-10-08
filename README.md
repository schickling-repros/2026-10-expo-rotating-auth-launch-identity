# expo-updates (iOS, SDK 57) — rotating an `Authorization` header override makes downloaded updates unlaunchable

On iOS, the launcher only considers an update launchable when the update's stored
`url` **and its entire stored `requestHeaders` dictionary** equal the controller's
current config. A per-request credential (for example a short-lived `Authorization`
bearer) configured through `Updates.setUpdateRequestHeadersOverride` therefore
becomes part of every update's launch identity. Rotating the token after the
download (token A → token B) leaves the downloaded update — and the embedded
update, which carries the build-time headers — ineligible. The override is also
persisted in `UserDefaults`, so the mismatch survives a cold launch.

Everything here is synthetic: a loopback manifest server (`server.mjs`), tokens
`Bearer synthetic-token-A` / `Bearer synthetic-token-B`, no EAS project.

## Reproduction

Requires macOS with Xcode and an iOS simulator runtime, Node, CocoaPods. The scripts expect the
port `127.0.0.1:18765` to be free.

```bash
npm install
npm run prebuild
(cd ios && pod install)
npm run export:ota          # the "downloaded" bundle served by server.mjs
./repro.sh                  # Release simulator build, temporary simulator, 3 steps
```

`repro.sh` builds `Release-iphonesimulator`, creates and later deletes a dedicated
simulator, starts `server.mjs` on `127.0.0.1:18765`, and drives three steps:

1. Embedded launch → `setUpdateRequestHeadersOverride({ Authorization: 'Bearer synthetic-token-A' })`
   → `fetchUpdateAsync()` → `setUpdateRequestHeadersOverride({ Authorization: 'Bearer synthetic-token-B' })`
   → `reloadAsync()`.
2. Terminate and cold launch (token B override is still persisted).
3. Override back to token A → `reloadAsync()`.

The app posts `Updates.updateId`, `isEmbeddedLaunch`, `isEmergencyLaunch`,
`emergencyLaunchReason`, errors, and relevant `readLogEntriesAsync()` lines to
the server; the server records the `Authorization` header of each manifest/asset
request. Evidence lands in `.evidence/`.

## Expected

A credential that is only needed to authorize the HTTP request should not change
which already-downloaded, verified update is launchable. After step 1, `reloadAsync()`
should launch the downloaded update.

## Actual

Observed on a Release simulator build (iOS 26.5 simulator, Xcode 27.0), `./repro.sh` output
(update IDs differ per run; full run in [`evidence/simulator-run.txt`](evidence/simulator-run.txt)):

```text
app launch bundle=embedded updateId=75c97a59-… embedded=true emergency=false reason=null
server /manifest Authorization=Bearer synthetic-token-A
server /bundle Authorization=Bearer synthetic-token-A
app download bundle=embedded … result={"isNew":true,"manifestId":"353b16f7-…"}
app rotated-to-B bundle=embedded …
app reload-rejected bundle=embedded … error="Error: UpdatesReloadException: Could not reload application. Ensure you have set the `appContext` property of AppController. (at EXUpdates/RelaunchProcedure.swift:95)"
  updates-log error: Failed to relaunch: No launchable updates found in database: Unknown error
app launch bundle=embedded updateId=null embedded=false emergency=true reason="No launchable updates found in database: Unknown error"
app launch bundle=embedded updateId=null embedded=false emergency=true reason="No launchable updates found in database: Unknown error"
app restored-A bundle=embedded updateId=null embedded=false emergency=true …
app launch bundle=downloaded updateId=353b16f7-… embedded=false emergency=true reason="No launchable updates found in database: Unknown error"
--- UserDefaults dev.expo.updates.updatesConfigOverride after: rotation to B
(absent)
--- UserDefaults dev.expo.updates.updatesConfigOverride after: cold launch
{"requestHeaders":{"Authorization":"Bearer synthetic-token-B"}}
--- UserDefaults dev.expo.updates.updatesConfigOverride after: restore to A
{"requestHeaders":{"Authorization":"Bearer synthetic-token-A"}}
```

1. The update downloads successfully with token A (`isNew: true`), but after rotating the
   override to token B, `reloadAsync()` rejects. JS sees a generic
   `UpdatesReloadException: Could not reload application. Ensure you have set the appContext…`;
   the expo-updates log has the real cause, `Failed to relaunch: No launchable updates found in database`.
   The embedded update does not rescue this either, because it carries the build-time token A.
2. Cold launch with the persisted token-B override: no crash, but an **emergency launch** of the
   embedded bundle (`updateId: null`, `isEmergencyLaunch: true`,
   `emergencyLaunchReason: "No launchable updates found in database"`). The downloaded update is
   still on disk but ignored.
3. Overriding back to token A and calling `reloadAsync()` launches the same downloaded update
   (`bundle=downloaded`, same manifest ID), which shows the update itself is intact — only the
   header comparison excluded it. (`isEmergencyLaunch` still reports `true` after that reload.)

The override is persisted: the token-B override is readable from the app's `UserDefaults` plist
after the process exits. The "(absent)" read right after rotation is only because the
preferences file had not been flushed while the app was still running.

A credential that is minted per session would therefore need to be identical at download time,
reload time and every later cold launch for a downloaded update to stay launchable, and it is
stored in plain `UserDefaults`.

## Source

`expo-updates@57.0.25`, `ios/EXUpdates/`:

- `SelectionPolicy/LauncherSelectionPolicyFilterAware.swift:22-27` — after runtime/manifest
  filters: `($0.url == nil && $0.requestHeaders == nil) || ($0.url == config.updateUrl && $0.requestHeaders == config.requestHeaders)`.
- `UpdatesConfig.swift:238` / `:406-424` and `UpdatesConfigOverride.swift:9-31` — the header
  override is read from / written to `UserDefaults` key `dev.expo.updates.updatesConfigOverride`
  and merged into `config.requestHeaders` at startup.
- `EnabledAppController.swift:337-345` — `setUpdateRequestHeadersOverride` validates keys against the
  embedded headers, saves the override and swaps the controller config.
- `Update/EmbeddedUpdate.swift:61-62` — the embedded update carries
  `originalEmbeddedUpdateUrl` / `originalEmbeddedRequestHeaders`, so it also stops matching after
  any header override.
- `UpdatesError.swift:127,135` — `Failed to relaunch: No launchable updates found in database`.

## Question

Is there a supported way to send a per-request (non-persisted) credential such as
`Authorization` that is excluded from launch identity? If launch identity must
include request headers (e.g. `expo-channel-name`), could a header allowlist /
denylist for identity, or a non-persisted header hook, be provided?

## Versions

- expo 57.0.24
- expo-updates 57.0.25
- react-native 0.86.3
- react 19.2.3
- Xcode 27.0, iOS simulator runtime iOS 26.5 (23F73), device type iPhone 17
- Node 24.20.0, npm 11.19.0, CocoaPods 1.16.x
- macOS 27.0 (arm64)

## Related Issue

ISSUE_PLACEHOLDER
