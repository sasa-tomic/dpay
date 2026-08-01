#!/usr/bin/env bash
# Verify the repository, build signed release artifacts, and upload the exact verified AAB to
# Google Play's internal-testing track. The APK is still staged for direct sideloading.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"

PLAY_CREDENTIALS="${DPAY_PLAY_SERVICE_ACCOUNT_JSON:-$HOME/.config/dpay/android/play-service-account.json}"
if [ -z "${ANDROID_PUBLISHER_CREDENTIALS:-}" ]; then
  [ -f "$PLAY_CREDENTIALS" ] || {
    echo "FAIL: Google Play service-account credentials not found: $PLAY_CREDENTIALS" >&2
    echo "Set DPAY_PLAY_SERVICE_ACCOUNT_JSON or place the JSON there. See app/android/app/play-signing/README.md." >&2
    exit 1
  }
  PLAY_CREDENTIALS="$(realpath "$PLAY_CREDENTIALS")"
  export DPAY_PLAY_SERVICE_ACCOUNT_JSON="$PLAY_CREDENTIALS"
fi

# Epoch seconds are monotonic, fit Play's 2,100,000,000 ceiling until 2036, and make the common
# one-command path unique without mutating a tracked version file. Operators may override it.
export DPAY_VERSION_CODE="${DPAY_VERSION_CODE:-$(date +%s)}"
if ! [[ "$DPAY_VERSION_CODE" =~ ^[1-9][0-9]*$ ]] || [ "$DPAY_VERSION_CODE" -gt 2100000000 ]; then
  echo "FAIL: DPAY_VERSION_CODE must be an integer from 1 through 2100000000" >&2
  exit 1
fi

echo "== Google Play internal release =="
echo "   version code: $DPAY_VERSION_CODE"
echo "   version name: ${DPAY_VERSION_NAME:-1.0}"
echo

echo "== verify repository =="
just verify

echo "== build and certificate-check signed APK + AAB =="
bash scripts/build-apk.sh

BUILT_AAB="$ROOT/app/android/app/build/outputs/bundle/release/app-release.aab"
[ -f "$BUILT_AAB" ] || { echo "FAIL: verified AAB not found: $BUILT_AAB" >&2; exit 1; }

# GPP uploads every bundle in artifact-dir. Isolate one immutable copy so an old build can never be
# swept into the same release and the uploaded bytes are exactly those build-apk.sh verified.
UPLOAD_DIR="$ROOT/.dev/releases/play-$DPAY_VERSION_CODE"
[ ! -e "$UPLOAD_DIR" ] || {
  echo "FAIL: release staging directory already exists: $UPLOAD_DIR" >&2
  echo "Choose a new DPAY_VERSION_CODE; existing staged releases are never overwritten." >&2
  exit 1
}
mkdir -p "$UPLOAD_DIR"
UPLOAD_AAB="$UPLOAD_DIR/dpay-release-$DPAY_VERSION_CODE.aab"
install -m 0644 "$BUILT_AAB" "$UPLOAD_AAB"
BUILT_SHA="$(sha256sum "$BUILT_AAB" | cut -d' ' -f1)"
UPLOAD_SHA="$(sha256sum "$UPLOAD_AAB" | cut -d' ' -f1)"
[ "$BUILT_SHA" = "$UPLOAD_SHA" ] || { echo "FAIL: staged AAB hash mismatch" >&2; exit 1; }

echo "== upload exact verified AAB to internal testing =="
(
  cd app/android
  DPAY_PLAY_PUBLISH=1 ./gradlew --console=plain :app:publishBundle --artifact-dir "$UPLOAD_DIR"
)

echo
echo "== Google Play upload complete =="
echo "   track: internal (completed)"
echo "   AAB:  $UPLOAD_AAB"
echo "   sha:  $UPLOAD_SHA"
echo "   APK:  $ROOT/deploy/dist/dpay.apk (direct sideload)"
