#!/usr/bin/env bash
# Build signed dpay release APK/AAB artifacts and stage the APK for the relay to serve.
#
# Unlike scripts/rn-run.sh (which also installs, launches, and screenshots on a connected device),
# this needs NO device: it produces the Play bundle and the signed APK the landing page hands out at
# GET /download/dpay.apk. It:
#   1. cross-compiles dpay-ffi (the shared Rust core) for arm64-v8a + x86_64 (scripts/ndk-build-ffi.sh),
#   2. syncs the .so + UniFFI Kotlin binding into the app (single source of truth — same core the tests run),
#   3. verifies the committed default relay URL in app/relayConfig.ts matches the release URL,
#   4. builds a release APK and Play AAB for just the two ABIs we ship a native lib for,
#   5. verifies both artifacts are signed by app/play-signing/upload_cert.pem, and
#   6. stages the APK to deploy/dist/dpay.apk so `just image` / the running relay serves it.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"

export ANDROID_HOME="${ANDROID_HOME:-/home/sat/Android/Sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
# Respect a valid JAVA_HOME; otherwise (unset, or an inherited-but-bogus value) ask the JVM itself.
[ -x "${JAVA_HOME:-}/bin/javac" ] || export JAVA_HOME="$(java -XshowSettings:properties -version 2>&1 | sed -n 's/.*java\.home = //p')"
export PATH="$ANDROID_HOME/platform-tools:$PATH"

# The two ABIs we ship a libdpay_ffi.so for: arm64-v8a (real phones) and x86_64 (emulator). Building
# only these keeps the download small and avoids shipping ABIs whose native core is missing.
ABIS="arm64-v8a,x86_64"

# The APK's BUILD IDENTITY (founder 2026-10-04: the app must tell the user there is a newer
# version, and the app can only decide "newer" against a build commit). Captured HERE at build
# start and baked two ways: into the JS bundle (app/lib/buildStamp.ts, overwritten below before
# gradle bundles the JS) and as a one-line .commit file staged beside the APK for the relay to
# serve at GET /api/v1/update. The EXIT trap ALWAYS restores the committed placeholder — the tree
# stays clean even when the build fails halfway.
BUILD_SHA="$(git -C "$ROOT" rev-parse HEAD)"
restore_build_stamp() { git -C "$ROOT" checkout -- app/lib/buildStamp.ts 2>/dev/null || true; }
trap restore_build_stamp EXIT

# Default relay a fresh install talks to. app/relayConfig.ts is the HAND-EDITED source of this value
# (no longer regenerated here); a release build must ship the env-derived public URL, so we derive
# what it SHOULD be and verify the committed file matches. Override the expected value with
# DPAY_RELAY_URL; else derive https://<host> from deploy/.env's DPAY_PUBLIC_HOSTNAME.
RELAY_URL="${DPAY_RELAY_URL:-}"
if [ -z "$RELAY_URL" ]; then
  # deploy/.env is generated — refresh from its sources first (fails closed when sops is unusable).
  bash "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts/gen-deploy-env.sh" -q
  host="$(grep -E '^DPAY_PUBLIC_HOSTNAME=' deploy/.env | tail -1 | cut -d= -f2- | tr -d '"'"'"' ')"
  [ -n "$host" ] && RELAY_URL="https://$host"
fi
[ -n "$RELAY_URL" ] || { echo "FAIL: no relay URL — set DPAY_RELAY_URL or DPAY_PUBLIC_HOSTNAME in deploy/.env"; exit 1; }
COMMITTED_RELAY="$(sed -n "s/^export const RELAY_DEFAULT = '\(.*\)';\$/\1/p" app/relayConfig.ts | head -1)"
[ -n "$COMMITTED_RELAY" ] || { echo "FAIL: app/relayConfig.ts does not export RELAY_DEFAULT"; exit 1; }
if [ "$COMMITTED_RELAY" != "$RELAY_URL" ]; then
  echo "FAIL: app/relayConfig.ts RELAY_DEFAULT='$COMMITTED_RELAY' != release URL '$RELAY_URL'."
  echo "       Edit app/relayConfig.ts (the hand-edited source) so it matches before building a release APK."
  exit 1
fi
echo "== default relay verified in app/relayConfig.ts: $RELAY_URL =="

echo "== verify the baked Solana RPC endpoint (staged relay + live getHealth) =="
bash scripts/stage-relay-probe.sh

echo "== cross-compile dpay-ffi (.so per ABI) + sync into the app =="
bash scripts/ndk-build-ffi.sh
mkdir -p app/android/app/src/main/jniLibs
cp -r android/app/src/main/jniLibs/* app/android/app/src/main/jniLibs/

echo "== generate fresh Kotlin binding from the host cdylib (never ships a stale binding) =="
# The .kt must match the FFI source the .so was built from. Build the host cdylib + the in-crate
# bindgen (same pinned uniffi) and generate straight into the app's java tree. UniFFI's interface
# checksum is target-independent, so a binding generated from the host .so loads the cross-compiled
# .so (same source) without checksum mismatch — exactly what crates/dpay-ffi/verify.sh relies on.
export CARGO_HOME="$ROOT/.dev/cargo" RUSTUP_HOME="$ROOT/.dev/rustup"
export PATH="$ROOT/.dev/cargo/bin:$PATH"
cargo build -p dpay-ffi --features cli
JAVA_PKG="app/android/app/src/main/java"
rm -rf "$JAVA_PKG/uniffi"
target/debug/uniffi-bindgen generate --library target/debug/libdpay_ffi.so --language kotlin --out-dir "$JAVA_PKG" --no-format
test -f "$JAVA_PKG/uniffi/dpay_ffi/dpay_ffi.kt" || { echo "FAIL: Kotlin binding not generated"; exit 1; }

echo "== stamp the build commit into the JS bundle (the EXIT trap restores the placeholder) =="
# Exactly the two lines the app imports as BUILD_COMMIT. Must land BEFORE gradle bundles the JS
# (the bundle is the only consumer that has to carry the SHA) and is never committed: the trap
# above restores the tracked placeholder on every exit path.
printf '// GENERATED by scripts/build-apk.sh - the release APK'"'"'s build commit. The committed placeholder is empty.\nexport const BUILD_COMMIT = '"'"'%s'"'"';\n' "$BUILD_SHA" > "$ROOT/app/lib/buildStamp.ts"

echo "== build release APK + AAB ($ABIS) =="
cd app/android
./gradlew --console=plain :app:assembleRelease :app:bundleRelease -PreactNativeArchitectures="$ABIS" "$@"
cd "$ROOT"

APK="$(find app/android/app/build/outputs/apk/release -maxdepth 1 -name '*.apk' -printf '%T@ %p\n' | sort -nr | sed -n '1s/^[^ ]* //p')"
[ -n "$APK" ] || { echo "FAIL: no APK produced"; exit 1; }
# The relay-facing half of the build identity: the SHA as a one-line file BESIDE the APK, so
# deploy/build.sh stages it next to the bytes and the relay's GET /api/v1/update can answer
# "which build is newest" honestly. Derived from the actual output file (the name may vary).
printf '%s\n' "$BUILD_SHA" > "$APK.commit"
AAB="$(find app/android/app/build/outputs/bundle/release -maxdepth 1 -name '*.aab' -printf '%T@ %p\n' | sort -nr | sed -n '1s/^[^ ]* //p')"
[ -n "$AAB" ] || { echo "FAIL: no AAB produced"; exit 1; }

UPLOAD_CERT="app/android/app/play-signing/upload_cert.pem"
[ -f "$UPLOAD_CERT" ] || { echo "FAIL: public upload certificate missing: $UPLOAD_CERT"; exit 1; }
APKSIGNER="$(find "$ANDROID_HOME/build-tools" -mindepth 2 -maxdepth 2 -type f -name apksigner -print | sort -V | tail -1)"
[ -x "$APKSIGNER" ] || { echo "FAIL: apksigner not found under $ANDROID_HOME/build-tools"; exit 1; }

EXPECTED_CERT_SHA256="$(openssl x509 -in "$UPLOAD_CERT" -outform DER | sha256sum | cut -d' ' -f1)"
APK_VERIFY="$("$APKSIGNER" verify --print-certs "$APK")"
APK_CERT_SHA256="$(printf '%s\n' "$APK_VERIFY" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p')"
[ "$APK_CERT_SHA256" = "$EXPECTED_CERT_SHA256" ] || {
  echo "FAIL: APK signer $APK_CERT_SHA256 does not match upload certificate $EXPECTED_CERT_SHA256"
  exit 1
}

"$JAVA_HOME/bin/jarsigner" -verify "$AAB" >/dev/null 2>&1 || { echo "FAIL: AAB signature verification failed"; exit 1; }
AAB_CERT_SHA256="$("$JAVA_HOME/bin/keytool" -printcert -rfc -jarfile "$AAB" | openssl x509 -outform DER | sha256sum | cut -d' ' -f1)"
[ "$AAB_CERT_SHA256" = "$EXPECTED_CERT_SHA256" ] || {
  echo "FAIL: AAB signer $AAB_CERT_SHA256 does not match upload certificate $EXPECTED_CERT_SHA256"
  exit 1
}

mkdir -p deploy/dist
install -m 0644 "$APK" deploy/dist/dpay.apk
echo
echo "== signed release artifacts ready =="
echo "   APK:     ${APK#$ROOT/}  ($(du -h "$APK" | cut -f1))"
echo "   APK sha: $(sha256sum "$APK" | cut -d' ' -f1)"
echo "   build:   $BUILD_SHA (staged as ${APK#$ROOT/}.commit + baked into the bundle)"
echo "   staged:  deploy/dist/dpay.apk"
echo "   AAB:     ${AAB#$ROOT/}  ($(du -h "$AAB" | cut -f1))"
echo "   AAB sha: $(sha256sum "$AAB" | cut -d' ' -f1)"
echo "   signer:  SHA-256 $EXPECTED_CERT_SHA256 (APK + AAB verified)"
echo
echo "   serve locally:  DPAY_APK_PATH=$ROOT/deploy/dist/dpay.apk cargo run -p dpay-relay"
echo "   or bake into image:  just image  (Dockerfile COPYs dist/dpay.apk)"
