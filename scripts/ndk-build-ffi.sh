#!/usr/bin/env bash
# Cross-compile dpay-ffi (the UniFFI cdylib over the shared dpay-core) for Android.
#
# Produces the exact native libraries the phone loads: one per ABI. arm64-v8a is the real-device
# target the plan calls for; x86_64 is what the headless emulator runs, so the on-device test can
# execute autonomously here. Output lands in the Android app's jniLibs tree.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"

export CARGO_HOME="$ROOT/.dev/cargo" RUSTUP_HOME="$ROOT/.dev/rustup"
export PATH="$ROOT/.dev/cargo/bin:$PATH"

# Use the newest installed NDK by default (override with ANDROID_NDK_HOME). Auto-detecting means a
# future `sdkmanager "ndk;<newer>"` is picked up with no edit here.
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/home/sat/Android/Sdk}}"
NDK="${ANDROID_NDK_HOME:-$(ls -d "$SDK"/ndk/* 2>/dev/null | sort -V | tail -1)}"
test -d "$NDK" || { echo "FAIL: no Android NDK found under $SDK/ndk"; exit 1; }
TOOLS="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin"
API=24
JNILIBS="$ROOT/android/app/src/main/jniLibs"
echo "== NDK: $(basename "$NDK") =="

# Align native lib LOAD segments to 16 KB. Android 15 (API 35) can use 16 KB memory pages and Google
# Play requires 16 KB-aligned .so for new/updated apps; a cargo link defaults to 4 KB, so pass the
# flag ourselves (backward compatible — 16 KB-aligned libs still run on 4 KB-page devices).
PAGE16="-Clink-arg=-Wl,-z,max-page-size=16384"

# rust target triple  ->  android ABI dir name
declare -A ABI=(
  [aarch64-linux-android]=arm64-v8a
  [x86_64-linux-android]=x86_64
)

export AR="$TOOLS/llvm-ar"

for triple in "${!ABI[@]}"; do
  abi="${ABI[$triple]}"
  cc="$TOOLS/${triple}${API}-clang"
  test -x "$cc" || { echo "FAIL: no NDK clang for $triple ($cc)"; exit 1; }

  # Per-target linker + cc (cargo/cc read these env vars, upper-cased triple with _).
  up="$(echo "$triple" | tr 'a-z-' 'A-Z_')"
  export "CARGO_TARGET_${up}_LINKER=$cc"
  export "CARGO_TARGET_${up}_RUSTFLAGS=$PAGE16"
  export "CC_${triple//-/_}=$cc"
  export "AR_${triple//-/_}=$TOOLS/llvm-ar"

  echo "== build dpay-ffi cdylib for $triple ($abi) =="
  # --lib only: skip the uniffi-bindgen bin (needs the host-only `cli` feature).
  cargo build -p dpay-ffi --lib --release --target "$triple"

  so="$ROOT/target/$triple/release/libdpay_ffi.so"
  test -f "$so" || { echo "FAIL: no .so produced at $so"; exit 1; }
  "$TOOLS/llvm-strip" --strip-unneeded "$so"

  mkdir -p "$JNILIBS/$abi"
  cp -f "$so" "$JNILIBS/$abi/libdpay_ffi.so"
  out="$JNILIBS/$abi/libdpay_ffi.so"
  echo "   -> $(file -b "$out")"
  # Sanity: the UniFFI scaffolding must export the crate's checksum/contract symbols.
  n=$("$TOOLS/llvm-nm" -D "$out" | grep -c 'uniffi_dpay_ffi' || true)
  echo "   exported uniffi_dpay_ffi_* symbols: $n"
  [ "$n" -gt 0 ] || { echo "FAIL: no uniffi symbols exported — binding would not load"; exit 1; }
  # Enforce 16 KB LOAD alignment (Android 15 / Play requirement).
  phdr="$("$TOOLS/llvm-readelf" -l "$out")"
  align="$(awk '/LOAD/{print $NF; exit}' <<<"$phdr")"
  echo "   LOAD alignment: $align"
  [ "$align" = "0x4000" ] || { echo "FAIL: $abi not 16 KB-aligned (align=$align)"; exit 1; }
done

echo
echo "== NDK build OK: $(ls "$JNILIBS") =="
