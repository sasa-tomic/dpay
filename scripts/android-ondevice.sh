#!/usr/bin/env bash
# On-device fidelity gate: run the shared dpay-core on a real Android runtime.
#
# Builds the NDK .so (both ABIs), then builds + runs the instrumented test on the connected
# emulator/device via Gradle's connectedAndroidTest. The test asserts byte-identical signing, QR,
# verify, validate, and tamper behaviour against the host — proving the phone runs the exact code
# Claude tests headlessly.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"

export ANDROID_HOME="${ANDROID_HOME:-/home/sat/Android/Sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
# Respect a valid JAVA_HOME; otherwise (unset, or an inherited-but-bogus value) ask the JVM itself.
[ -x "${JAVA_HOME:-}/bin/javac" ] || export JAVA_HOME="$(java -XshowSettings:properties -version 2>&1 | sed -n 's/.*java\.home = //p')"
export PATH="$ANDROID_HOME/platform-tools:$PATH"

# Cached Gradle 8.9 distribution (matches AGP 8.7.3). Glob the hashed dir.
GRADLE="$(ls -d "$HOME"/.gradle/wrapper/dists/gradle-8.9-bin/*/gradle-8.9/bin/gradle 2>/dev/null | head -1)"
test -x "$GRADLE" || { echo "FAIL: cached gradle 8.9 not found"; exit 1; }

echo "== require a booted device =="
adb wait-for-device
BOOTED="$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')"
[ "$BOOTED" = "1" ] || { echo "FAIL: no fully-booted device (sys.boot_completed=$BOOTED)"; exit 1; }
echo "   device: $(adb devices | awk 'NR==2{print $1}')  abi=$(adb shell getprop ro.product.cpu.abi | tr -d '\r')"

echo "== build NDK .so for both ABIs =="
bash scripts/ndk-build-ffi.sh >/tmp/ndk-build.log 2>&1 || { echo "FAIL: ndk build"; tail -20 /tmp/ndk-build.log; exit 1; }
echo "   jniLibs: $(cd android/app/src/main/jniLibs && ls -1 | tr '\n' ' ')"

echo "== gradle connectedDebugAndroidTest =="
cd android
"$GRADLE" --console=plain --no-daemon :app:connectedDebugAndroidTest "$@"
echo
echo "== on-device gate PASSED =="
echo "   HTML report: android/app/build/reports/androidTests/connected/debug/index.html"
