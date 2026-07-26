#!/usr/bin/env bash
# Build the dpay-relay container image.
#
#   host build (in-project toolchain, --features agent)  →  deploy/dist/dpay-relay  →  docker build
#
# Why a host build rather than a builder stage: the toolchain, the cargo cache and the vendored
# crates already live in-project (see CLAUDE.md), so this reuses the warm cache and takes seconds
# instead of recompiling ic-agent from scratch inside Docker on every image build.
#
# The cost of that choice is glibc coupling: the binary links against the host's glibc, so the
# runtime base must ship one at least as new. We pick a base that satisfies the host automatically,
# then *prove* the pairing by running the binary inside the finished image — a broken pairing fails
# here, loudly, instead of as a crash-looping container on a VPS.
#
# Env:
#   DPAY_RUNTIME_BASE   override the runtime base image (default: chosen from the host's glibc)
#   DPAY_IMAGE          image name:tag (default dpay-relay:latest)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"

export CARGO_HOME="$ROOT/.dev/cargo" RUSTUP_HOME="$ROOT/.dev/rustup"
export PATH="$ROOT/.dev/cargo/bin:$PATH"

IMAGE="${DPAY_IMAGE:-dpay-relay:latest}"
# Same target dir the `agent`-feature builds already use (test-live, demo.sh): keeping the heavy
# ic-agent feature build out of ./target means the no-feature inner loop never rebuilds behind it.
TARGET_DIR="$ROOT/.dev/target-relay"

command -v docker >/dev/null 2>&1 || { echo "docker not found on PATH" >&2; exit 1; }

echo "== build dpay-relay (release, --features agent) =="
CARGO_TARGET_DIR="$TARGET_DIR" cargo build -q --release --locked -p dpay-relay --features agent
BIN="$TARGET_DIR/release/dpay-relay"
[ -x "$BIN" ] || { echo "expected a binary at $BIN" >&2; exit 1; }

mkdir -p deploy/dist
install -m 0755 "$BIN" deploy/dist/dpay-relay

# --- pick a runtime base whose glibc is at least the host's -----------------------------------
# The binary can't require a newer glibc than the one it was built against, so the host's version is
# a safe upper bound (and needs no binutils to read out of the ELF).
# awk (not `head -1`): `head` closes the pipe after line 1, which races `ldd` into a SIGPIPE that
# `set -o pipefail` turns into a spurious build abort. awk reads to EOF, so ldd never gets SIGPIPE.
# ldd's first line ends with the bare version ("ldd (Ubuntu GLIBC 2.39-0ubuntu8.7) 2.39") → $NF.
HOST_GLIBC="$(ldd --version | awk 'NR==1{print $NF}')"
newest() { printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1; }

if [ -n "${DPAY_RUNTIME_BASE:-}" ]; then
  BASE="$DPAY_RUNTIME_BASE"
elif [ "$(newest "$HOST_GLIBC" 2.36)" = "2.36" ]; then
  BASE="debian:bookworm-slim"      # glibc 2.36
elif [ "$(newest "$HOST_GLIBC" 2.39)" = "2.38" ]; then
  BASE="ubuntu:24.04"              # glibc 2.39
elif [ "$(newest "$HOST_GLIBC" 2.39)" = "2.39" ]; then
  BASE="ubuntu:24.04"              # glibc 2.39
else
  echo "host glibc $HOST_GLIBC is newer than any base this script knows about." >&2
  echo "Set DPAY_RUNTIME_BASE to an image with glibc >= $HOST_GLIBC, or build a static musl binary." >&2
  exit 1
fi
echo "== docker build $IMAGE (host glibc $HOST_GLIBC → runtime base $BASE) =="
docker build -t "$IMAGE" --build-arg "RUNTIME_BASE=$BASE" deploy

# --- prove the binary actually runs in that base ------------------------------------------------
# A glibc mismatch shows up here as "GLIBC_2.xx not found" rather than in production. We feed it a
# deliberately invalid ledger so it exits immediately on the config check (exit 2) without needing a
# ledger, a port, or a network: reaching that error *is* proof that the dynamic linker was happy.
echo "== smoke: binary loads under $BASE =="
out="$(docker run --rm -e DPAY_LEDGER=__invalid__ "$IMAGE" 2>&1 || true)"
if ! grep -q "bad configuration" <<<"$out"; then
  echo "the relay binary did not run inside $BASE:" >&2
  echo "$out" >&2
  echo >&2
  echo "If this says 'GLIBC_x.yz not found', the runtime base is older than the build host." >&2
  echo "Set DPAY_RUNTIME_BASE to a newer image and re-run." >&2
  exit 1
fi

echo
echo "✓ $IMAGE  ($(docker image inspect -f '{{.Size}}' "$IMAGE" | awk '{printf "%.0f MB", $1/1024/1024}'))"
echo "  next: cd deploy && cp .env.example .env && \$EDITOR .env && docker compose up -d"
