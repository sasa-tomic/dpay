#!/usr/bin/env bash
# dpay-ffi language-binding gate.
#
# Proves the phone app's languages call the SAME compiled dpay-core:
#   1. build the host cdylib (libdpay_ffi.so) — links dpay-core, exactly as ships,
#   2. generate Python bindings from that cdylib with the pinned uniffi bindgen,
#   3. run a Python roundtrip against the real .so (sign -> encode -> decode -> verify -> validate),
#   4. also generate the Kotlin binding as the Android artifact (generation-only here).
# Offline after the first crate fetch. Exits non-zero on any failure.
set -euo pipefail

# --- locate ourselves; work from the repo root so cargo sees the workspace -------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRATE_DIR="$SCRIPT_DIR"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT_DIR"

# Own build dir so we never collide with the other agent's cargo in this workspace.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT_DIR/.dev/target-ffi}"

PY_DIR="$CRATE_DIR/bindings/python"
KT_DIR="$CRATE_DIR/bindings/kotlin"

echo "== dpay-ffi: build host cdylib (+ uniffi-bindgen) =="
cargo build -p dpay-ffi --features cli

# Resolve the freshly built artifacts. Profile is `debug` (fast inner loop).
SO_PATH="$CARGO_TARGET_DIR/debug/libdpay_ffi.so"
BINDGEN="$CARGO_TARGET_DIR/debug/uniffi-bindgen"
test -f "$SO_PATH"  || { echo "FAIL: missing cdylib $SO_PATH"; exit 1; }
test -x "$BINDGEN"  || { echo "FAIL: missing bindgen $BINDGEN"; exit 1; }

echo "== dpay-ffi: generate Python bindings =="
rm -rf "$PY_DIR"; mkdir -p "$PY_DIR"
"$BINDGEN" generate --library "$SO_PATH" --language python --out-dir "$PY_DIR" --no-format
# The generated module dlopen()s lib{name}.so from its own directory — put the .so beside it.
cp -f "$SO_PATH" "$PY_DIR/"
test -f "$PY_DIR/dpay_ffi.py" || { echo "FAIL: no python binding generated"; exit 1; }

echo "== dpay-ffi: generate Kotlin (Android) binding artifact =="
rm -rf "$KT_DIR"; mkdir -p "$KT_DIR"
"$BINDGEN" generate --library "$SO_PATH" --language kotlin --out-dir "$KT_DIR" --no-format
KT_FILE="$(find "$KT_DIR" -name '*.kt' | head -1)"
test -n "$KT_FILE" || { echo "FAIL: no kotlin binding generated"; exit 1; }
echo "   kotlin artifact: ${KT_FILE#$ROOT_DIR/}"
if command -v kotlinc >/dev/null 2>&1; then
  echo "   kotlinc present — Kotlin binding could be compiled (skipped: no Android runtime here)"
else
  echo "   NOTE: kotlinc absent in sandbox — Kotlin generated but not compiled (device-gated)."
fi

echo "== dpay-ffi: Python roundtrip against the real compiled core =="
PYTHONPATH="$PY_DIR" python3 "$CRATE_DIR/test_ffi.py"

echo "== dpay-ffi: OK =="
