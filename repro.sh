#!/usr/bin/env bash
# Drives the reproduction on a dedicated, freshly created iOS simulator.
# Prerequisites: npm install, npm run prebuild, pod install in ios/, npm run export:ota.
set -euo pipefail
cd "$(dirname "$0")"

BUNDLE_ID=org.example.authlaunchrepro
APP=.build/Build/Products/Release-iphonesimulator/AuthLaunchRepro.app
SIM_NAME=expo-auth-launch-repro
DEVICE_TYPE=${DEVICE_TYPE:-com.apple.CoreSimulator.SimDeviceType.iPhone-17}

if [ "${SKIP_BUILD:-0}" != 1 ]; then
  xcodebuild -workspace ios/AuthLaunchRepro.xcworkspace -scheme AuthLaunchRepro \
    -configuration Release -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath .build -jobs "${JOBS:-4}" build
fi

UDID=$(xcrun simctl create "$SIM_NAME" "$DEVICE_TYPE")
trap 'kill "${SERVER_PID:-}" 2>/dev/null || true; xcrun simctl shutdown "$UDID" 2>/dev/null || true; xcrun simctl delete "$UDID"' EXIT
xcrun simctl boot "$UDID"
xcrun simctl bootstatus "$UDID" -b >/dev/null
# A freshly booted simulator can reject installs ("Failed to create promise") for a few seconds.
for attempt in 1 2 3 4 5 6; do xcrun simctl install "$UDID" "$APP" && break; [ "$attempt" = 6 ] && exit 1; sleep 10; done

rm -rf .evidence && mkdir -p .evidence
node server.mjs > .evidence/server.log 2>&1 &
SERVER_PID=$!
sleep 1

scenario() { curl -fsS "http://127.0.0.1:18765/scenario?set=$1" >/dev/null; }
wait_for() { for _ in $(seq 1 60); do grep -q "\"event\":\"$1\"" .evidence/events.jsonl 2>/dev/null && return; sleep 1; done; echo "timed out waiting for $1" >&2; exit 1; }
count() { grep -c "\"event\":\"$1\"" .evidence/events.jsonl 2>/dev/null || true; }
override() {
  # The override is JSON-encoded Data in the app's standard UserDefaults plist (flushed by cfprefsd).
  sleep 2
  local plist; plist="$(xcrun simctl get_app_container "$UDID" "$BUNDLE_ID" data)/Library/Preferences/$BUNDLE_ID.plist"
  echo "--- UserDefaults dev.expo.updates.updatesConfigOverride after: $1" >> .evidence/userdefaults.txt
  # plutil key paths split on '.', so decode the <data> element of the XML form instead.
  plutil -convert xml1 -o - "$plist" | node -e '
    const xml = require("fs").readFileSync(0, "utf8");
    const m = xml.match(/<key>dev\.expo\.updates\.updatesConfigOverride<\/key>\s*<data>([^<]*)<\/data>/);
    console.log(m ? Buffer.from(m[1].replace(/\s/g, ""), "base64").toString("utf8") : "(absent)");' >> .evidence/userdefaults.txt
}

echo '## 1. embedded launch: fetch with token A, rotate override to token B, reloadAsync()'
scenario rotate
xcrun simctl launch "$UDID" "$BUNDLE_ID" >/dev/null
wait_for reload-rejected
override 'rotation to B'

echo '## 2. cold launch with the persisted token-B override'
scenario idle
xcrun simctl terminate "$UDID" "$BUNDLE_ID"
xcrun simctl launch "$UDID" "$BUNDLE_ID" >/dev/null
for _ in $(seq 1 60); do [ "$(count launch)" -ge 2 ] && break; sleep 1; done
override 'cold launch'

echo '## 3. restore token A, reloadAsync(): the same downloaded update becomes launchable again'
scenario restore-A
xcrun simctl terminate "$UDID" "$BUNDLE_ID"
xcrun simctl launch "$UDID" "$BUNDLE_ID" >/dev/null
for _ in $(seq 1 60); do [ "$(count launch)" -ge 4 ] && break; sleep 1; done
override 'restore to A'
scenario idle
sleep 2

echo '## evidence'
grep '"kind":"app"\|"kind":"request"' .evidence/events.jsonl | node -e '
  const lines = require("fs").readFileSync(0, "utf8").trim().split("\n").map(JSON.parse);
  for (const e of lines) {
    if (e.kind === "request") { console.log(`server ${e.path} Authorization=${e.authorization}`); continue; }
    const extra = e.result ? ` result=${JSON.stringify({ isNew: e.result.isNew, manifestId: e.result.manifest?.id })}` : "";
    const error = e.error ? ` error=${JSON.stringify(e.error)}` : "";
    console.log(`app ${e.event} bundle=${e.bundleKind} updateId=${e.updateId} embedded=${e.isEmbeddedLaunch} emergency=${e.isEmergencyLaunch} reason=${JSON.stringify(e.emergencyLaunchReason ?? null)}${extra}${error}`);
    if (e.logs) for (const l of e.logs.filter(l => /launchable|relaunch|reload/i.test(l.message))) console.log(`  updates-log ${l.level}: ${l.message}`);
  }'
cat .evidence/userdefaults.txt
