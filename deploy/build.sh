#!/usr/bin/env bash
# Build the dpay-relay container image.
#
#   web build of the real app (vite --mode web-prod)  →  e2e/dist-prod  ┐
#   host build (in-project toolchain, --features agent) → deploy/dist/dpay-relay  →  docker build
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
# The tree this compiles is committed first — see the gate in deploy/git-lib.sh.
#
# Env:
#   DPAY_RUNTIME_BASE   override the runtime base image (default: chosen from the host's glibc)
#   DPAY_IMAGE          image name:tag (default dpay-relay:latest)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"

# shellcheck source=deploy/git-lib.sh
source deploy/git-lib.sh
# First, before the minutes of web + cargo build below: a dirty tree is committed here
# (deploy/git-lib.sh `committed_tree_for`) — whatever is in the tree is what ships, so it is
# made a commit, and the image that follows is attributable to exactly that commit.
committed_tree_for "this relay image"

# Same reason, same place: the web bundle built below bakes app/config/constants.ts's Solana RPC
# endpoint into the /wallet bytes this image serves, so an unsafe or dead endpoint is a property of
# the image. The APK path has always been gated (scripts/build-apk.sh); this half — the one that
# publishes the endpoint in plaintext to every browser — was not. Strict mode: the relay THIS TREE
# builds is staged on loopback with the deploy env's provider endpoint and probed end to end
# (scripts/stage-relay-probe.sh) — code + key + upstream, never coupled to what is already live.
echo "== verify the baked Solana RPC endpoint (staged relay + live getHealth) =="
bash scripts/stage-relay-probe.sh

export CARGO_HOME="$ROOT/.dev/cargo" RUSTUP_HOME="$ROOT/.dev/rustup"
export PATH="$ROOT/.dev/cargo/bin:$PATH"

IMAGE="${DPAY_IMAGE:-dpay-relay:latest}"
# Same target dir the `agent`-feature builds already use (test-live, demo.sh): keeping the heavy
# ic-agent feature build out of ./target means the no-feature inner loop never rebuilds behind it.
TARGET_DIR="$ROOT/.dev/target-relay"

command -v docker >/dev/null 2>&1 || { echo "docker not found on PATH" >&2; exit 1; }

# --- prod web build of the REAL app (embedded by dpay-relay's build.rs, served at /wallet) ------
# /wallet IS app/App.tsx built for the web (react-native-web + the wasm DpayCore) — there is no
# hand-written wallet anymore. The dist is gitignored, so it MUST be built here, before cargo:
# dpay-relay fails to compile without it (deliberately loud — no stub wallet can ever ship).
echo "== web build (real app → e2e/dist-prod; embedded as /wallet) =="
( cd e2e && \
  { [ -d node_modules ] || npm install --prefer-offline --no-audit --no-fund --legacy-peer-deps; } && \
  node node_modules/vite/bin/vite.js build --mode web-prod )

echo "== build dpay-relay (release, --features agent) =="
CARGO_TARGET_DIR="$TARGET_DIR" cargo build -q --release --locked -p dpay-relay --features agent
BIN="$TARGET_DIR/release/dpay-relay"
[ -x "$BIN" ] || { echo "expected a binary at $BIN" >&2; exit 1; }

mkdir -p deploy/dist
install -m 0755 "$BIN" deploy/dist/dpay-relay

# --- stage the newest release APK for the landing page (optional) -------------------------------
# The relay serves an Android APK at GET /download/dpay.apk when DPAY_APK_PATH points at a file; the
# Dockerfile bakes deploy/dist/dpay.apk in via `COPY dist/dpay.ap[k]`. Stage the newest release APK
# here so the image can serve it. `find -printf | sort -nr | sed -n '1s///p'` reads its input to EOF
# (unlike `head -1` / `sort | sed -n 1p`, which close the pipe early and SIGPIPE the producer under
# `set -o pipefail`, aborting the build). Guard on the dir existing too: it doesn't exist until an
# Android release build has run, and `find` on a missing path exits non-zero — which pipefail would
# likewise turn into an abort. A missing APK is fine — the page falls back to "coming soon".
apk=""
apk_dir="app/android/app/build/outputs/apk/release"
if [ -d "$apk_dir" ]; then
  apk="$(find "$apk_dir" -maxdepth 1 -name '*.apk' -printf '%T@ %p\n' | sort -nr | sed -n '1s/^[^ ]* //p')"
fi
if [ -n "$apk" ]; then
  install -m 0644 "$apk" deploy/dist/dpay.apk
  # The build identity beside the bytes (scripts/build-apk.sh writes "<apk>.commit"): the one
  # answer GET /api/v1/update gives. An APK predating the stamp has no .commit — drop any stale
  # dist copy so the image can never serve an identity that does not belong to THESE bytes.
  if [ -f "$apk.commit" ]; then
    install -m 0644 "$apk.commit" deploy/dist/dpay.apk.commit
  else
    rm -f deploy/dist/dpay.apk.commit
  fi
  echo "== staged release APK $(basename "$apk") → deploy/dist/dpay.apk (+ .commit identity) =="
else
  rm -f deploy/dist/dpay.apk
  rm -f deploy/dist/dpay.apk.commit
  echo "== no release APK found — landing page will show 'coming soon' =="
fi

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
elif [ "$(newest "$HOST_GLIBC" 2.42)" = "2.42" ]; then
  BASE="ubuntu:25.10"              # glibc 2.42
elif [ "$(newest "$HOST_GLIBC" 2.43)" = "2.43" ]; then
  BASE="ubuntu:26.04"              # glibc 2.43
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
echo "  next: cd deploy && docker compose up -d   # deploy/.env is generated: just deploy-env (secrets: sops secrets/deploy.sops.json)"
