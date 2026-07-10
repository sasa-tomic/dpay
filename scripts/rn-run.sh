#!/usr/bin/env bash
# Build + install + run the dpay React Native app on the connected emulator/device, then prove the
# running app actually invoked the shared Rust core (dpay-core via the UniFFI native module).
#
# It builds a self-contained release APK (JS bundled, debug-signed — no Metro server needed),
# installs and launches it, asserts the on-device self-check marker in logcat, and drives the
# Pay -> Approve flow to screenshot the real offline-signed "Paid" state.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"

export ANDROID_HOME="${ANDROID_HOME:-/home/sat/Android/Sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export JAVA_HOME="${JAVA_HOME:-$(dirname "$(dirname "$(readlink -f "$(command -v javac)")")")}"
export PATH="$ANDROID_HOME/platform-tools:$PATH"
APP_ID=com.dpay
SHOTS="$ROOT/app/shots"; mkdir -p "$SHOTS"

echo "== require a booted device =="
adb wait-for-device
[ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = "1" ] || { echo "FAIL: device not booted"; exit 1; }

echo "== resync NDK .so + UniFFI binding into the app (single source of truth) =="
bash scripts/ndk-build-ffi.sh >/tmp/ndk.log 2>&1 || { echo "FAIL ndk"; tail -20 /tmp/ndk.log; exit 1; }
mkdir -p app/android/app/src/main/jniLibs app/android/app/src/main/java/uniffi/dpay_ffi
cp -r android/app/src/main/jniLibs/* app/android/app/src/main/jniLibs/
cp crates/dpay-ffi/bindings/kotlin/uniffi/dpay_ffi/dpay_ffi.kt app/android/app/src/main/java/uniffi/dpay_ffi/dpay_ffi.kt

echo "== build release APK (bundles JS) =="
cd app/android
./gradlew --console=plain :app:assembleRelease "$@"
cd "$ROOT"
APK="$(ls -t app/android/app/build/outputs/apk/release/*.apk | head -1)"
echo "   APK: ${APK#$ROOT/}  ($(du -h "$APK" | cut -f1))"

echo "== install + launch =="
adb install -r "$APK" >/dev/null
adb logcat -c || true
adb shell am start -n "$APP_ID/.MainActivity" >/dev/null

echo "== wait for the on-device self-check marker (proves the app called dpay-core) =="
MARK=""
for _ in $(seq 1 30); do
  MARK="$(adb logcat -d 2>/dev/null | grep -m1 'DPAY_SELFCHECK' || true)"
  [ -n "$MARK" ] && break
  sleep 1
done
echo "   $MARK"
echo "$MARK" | grep -q 'DPAY_SELFCHECK PASS' || { echo "FAIL: self-check did not pass"; adb logcat -d | grep -iE 'dpay|ReactNativeJS|AndroidRuntime' | tail -30; exit 1; }

# Best-effort UI drive for screenshots (non-fatal): tap a node by its visible text via uiautomator.
tap_text() {
  local needle="$1"
  adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 || return 1
  local bounds
  bounds="$(adb shell cat /sdcard/ui.xml 2>/dev/null | tr '>' '\n' | grep -F "$needle" | grep -oE 'bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"' | head -1)"
  [ -n "$bounds" ] || return 1
  local n; n="$(echo "$bounds" | grep -oE '[0-9]+')"
  local x1 y1 x2 y2; read -r x1 y1 x2 y2 <<<"$(echo "$n" | tr '\n' ' ')"
  adb shell input tap $(((x1 + x2) / 2)) $(((y1 + y2) / 2))
  sleep 1
}

shot() { adb exec-out screencap -p > "$SHOTS/$1"; echo "   shot: app/shots/$1"; }

echo "== screenshots =="
sleep 2; shot 01-pay-home.png
tap_text 'Simulate scan' && sleep 1 && shot 02-review.png || echo "   (skip review shot)"
tap_text 'Approve' && sleep 2 && shot 03-paid.png || echo "   (skip paid shot)"

echo
echo "== RN app PASSED: running on-device app signed via dpay-core (self-check green) =="
