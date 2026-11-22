#!/bin/bash
# Boots an iPhone and an iPad simulator in Spanish (Mexico) and runs the UI test
# that walks the Settings app through the Screen Time steps.
set -uo pipefail
cd "$(dirname "$0")"
OUT="${1:-$PWD/out}"
mkdir -p "$OUT"
DD="${RUNNER_TEMP:-/tmp}/shots-dd"

xcodebuild -version | tee "$OUT/xcode-version.txt"
xcrun simctl list runtimes | tee "$OUT/runtimes.txt"

xcodebuild -project SettingsShots.xcodeproj -scheme SettingsShots \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath "$DD" build-for-testing \
  | tail -n 30

pick() {
  xcrun simctl list devices available -j | python3 -c '
import json, re, sys
pats = sys.argv[1:]
devs = json.load(sys.stdin)["devices"]
for pat in pats:
    best = None
    for rt, ds in devs.items():
        m = re.search(r"iOS-(\d+)-(\d+)", rt)
        if not m:
            continue
        v = (int(m.group(1)), int(m.group(2)))
        for d in ds:
            if re.fullmatch(pat, d["name"]) and (best is None or v > best[0]):
                best = (v, d["udid"], d["name"], rt)
    if best:
        print(best[1])
        print("picked", best[2], best[3], file=sys.stderr)
        break
' "$@"
}

run_one() {
  local prefix="$1"; shift
  local udid
  udid=$(pick "$@")
  [ -n "$udid" ] || { echo "no simulator for $prefix"; return; }
  xcrun simctl list devices | grep "$udid" | tee "$OUT/$prefix-device.txt"
  xcrun simctl boot "$udid" || true
  xcrun simctl bootstatus "$udid" -b
  xcrun simctl spawn "$udid" defaults write "Apple Global Domain" AppleLanguages -array es-MX es-419
  xcrun simctl spawn "$udid" defaults write "Apple Global Domain" AppleLocale -string es_MX
  xcrun simctl shutdown "$udid"
  xcrun simctl boot "$udid"
  xcrun simctl bootstatus "$udid" -b
  xcrun simctl ui "$udid" appearance light || true
  sleep 20
  xcrun simctl status_bar "$udid" override --time 9:41 --batteryState charged --batteryLevel 100 \
    --wifiBars 3 --cellularBars 4 --dataNetwork wifi --operatorName "" || true
  TEST_RUNNER_SHOTS_DIR="$OUT" TEST_RUNNER_SHOTS_PREFIX="$prefix" \
  xcodebuild -project SettingsShots.xcodeproj -scheme SettingsShots \
    -destination "id=$udid" -derivedDataPath "$DD" \
    -resultBundlePath "${RUNNER_TEMP:-/tmp}/$prefix.xcresult" test-without-building \
    2>&1 | grep -E "SHOTS:|error|passed|failed" | tee "$OUT/$prefix-xcodebuild.txt"
  xcrun simctl shutdown "$udid" || true
}

run_one ios 'iPhone 1[0-9] Pro' 'iPhone 2[0-9] Pro' 'iPhone.*Pro' 'iPhone.*'
run_one ipad 'iPad Pro 11-inch.*' 'iPad Air 11-inch.*' 'iPad Pro.*' 'iPad.*'
ls -la "$OUT"
