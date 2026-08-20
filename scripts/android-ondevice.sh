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

# Newest cached Gradle distribution. AGP 8.7.3 (android/build.gradle) requires Gradle >= 8.9; the
# wrapper dists cache both -bin and -all layouts under a hashed subdir, so find the gradle binary and
# pick the highest version rather than hardcoding a single (easily stale) distribution.
GRADLE="$(find "$HOME"/.gradle/wrapper/dists -type f -path '*/bin/gradle' 2>/dev/null \
  | awk -F/ '{full=$0;v="";for(i=1;i<=NF;i++)if($i~/^gradle-[0-9]/){split($i,g,"-");v=g[2]} if(v!="")print v"\t"full}' \
  | sort -Vr | head -1 | cut -f2-)"
test -x "$GRADLE" || { echo "FAIL: no cached gradle found under ~/.gradle/wrapper/dists"; exit 1; }
GV="$(printf '%s' "$GRADLE" | awk -F/ '{for(i=1;i<=NF;i++)if($i~/^gradle-[0-9]/){split($i,g,"-");print g[2];exit}}')"
awk -v v="$GV" 'BEGIN{split(v,a,"."); exit !(a[1]>8 || (a[1]==8 && a[2]>=9))}' \
  || { echo "FAIL: cached gradle $GV is < 8.9 (AGP 8.7.3 needs >= 8.9); run an android/ build once to cache a newer dist"; exit 1; }
echo "   gradle: $GV ($GRADLE)"

echo "== require a booted device =="
adb wait-for-device
BOOTED="$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')"
[ "$BOOTED" = "1" ] || { echo "FAIL: no fully-booted device (sys.boot_completed=$BOOTED)"; exit 1; }
echo "   device: $(adb devices | awk 'NR==2{print $1}')  abi=$(adb shell getprop ro.product.cpu.abi | tr -d '\r')"

# A leftover foreground app instance (e.g. a prior `just app` gate launch) holds the back camera
# as a HIGHER-priority client, so the camera-frame instrumented test in its own test process gets
# REJECTED by the camera service ("Higher-priority client using camera") and fails with 0 frames.
# Force-stop the app so the gate is deterministic regardless of gate ordering.
if adb shell am force-stop org.kalaj.dpay 2>/dev/null; then
  echo "   force-stopped org.kalaj.dpay (releases any held camera)"
fi

echo "== build NDK .so for both ABIs =="
bash scripts/ndk-build-ffi.sh >/tmp/ndk-build.log 2>&1 || { echo "FAIL: ndk build"; tail -20 /tmp/ndk-build.log; exit 1; }
echo "   jniLibs: $(cd android/app/src/main/jniLibs && ls -1 | tr '\n' ' ')"

echo "== gradle connectedDebugAndroidTest =="
cd android
"$GRADLE" --console=plain --no-daemon :app:connectedDebugAndroidTest "$@"
echo
echo "== on-device gate PASSED =="
echo "   HTML report: android/app/build/reports/androidTests/connected/debug/index.html"
