# syntax=docker/dockerfile:1
#
# dpay-relay container — the merchant's submit-and-confirm service, dpay's only online piece.
#
# Runtime-only image: the binary is built on the host by `deploy/build.sh` (with `--features agent`,
# so it can settle on a real canister) and copied in from `deploy/dist/`. The build context is this
# directory, not the repo root — nothing but the binary goes into the image.
#
# The binary is dynamically linked against the *host's* glibc, so RUNTIME_BASE must ship a glibc at
# least as new. build.sh picks a matching base automatically and then proves it by running the
# binary inside the image; don't build this Dockerfile by hand unless you know the pairing is right.
#
# The image is configuration-free: which ledger it settles on (a real canister on a real IC network,
# or the in-memory demo one) is entirely env — see crates/dpay-relay/src/main.rs.

ARG RUNTIME_BASE=ubuntu:24.04
FROM ${RUNTIME_BASE} AS runtime

# curl for the container HEALTHCHECK; ca-certificates so TLS to a real boundary node validates.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Run unprivileged.
RUN useradd --system --no-create-home --uid 10001 dpay

COPY dist/dpay-relay /usr/local/bin/dpay-relay

# Optional Android APK served by the landing page at `/` (download at GET /download/dpay.apk).
# build.sh stages the newest release APK to dist/dpay.apk when one exists; `dpay.ap[k]` is a glob
# that matches 0-or-1 files, so the COPY succeeds whether or not the APK is present (a bare
# `COPY dist/dpay.apk` would fail the build when absent). The relay reads DPAY_APK_PATH once at
# startup and treats a missing file as "no APK" → landing page shows "coming soon".
COPY dist/dpay.ap[k] /srv/dpay.apk
ENV DPAY_APK_PATH=/srv/dpay.apk

# Bind on all interfaces *inside the container* so the proxy (or a phone on the LAN) can reach it.
# Everything the relay serves (merchant page, jsQR/qrcode assets) is compiled in — no asset files.
# Deliberately NO default ledger config: an unconfigured container exits rather than guess.
ENV DPAY_RELAY_ADDR=0.0.0.0:8787

EXPOSE 8787
USER dpay

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
    CMD curl -fsS "http://localhost:8787/api/v1/health" || exit 1

ENTRYPOINT ["/usr/local/bin/dpay-relay"]
