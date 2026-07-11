# syntax=docker/dockerfile:1
#
# dpay-relay container — the merchant's submit-and-confirm service, the demo's only online piece.
# Build context is the repo root (see docker-compose.yml `build.context: ..`) because the relay is
# a workspace member that path-depends on dpay-core.
#
# Default build = in-memory FakeLedger (pre-funded demo accounts, no canister needed) — fully
# self-contained so the whole flow runs "anywhere" with nothing else to stand up. The real-canister
# path lives behind the crate's `agent` feature; not compiled here (it drags in ic-agent/pocket-ic).

##############################  builder  ##############################
FROM rust:1-bookworm AS builder
WORKDIR /src

# Only the pieces cargo needs to build the relay. The other member manifests must be present for
# workspace resolution, but `-p dpay-relay` compiles just the relay + dpay-core + their deps.
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates

# Cache the registry and target dir across builds (BuildKit). The release binary is produced inside
# the cache mount, so copy it out to a real path within the same RUN before the mount detaches.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p dpay-relay \
 && cp target/release/dpay-relay /usr/local/bin/dpay-relay

##############################  runtime  ##############################
FROM debian:bookworm-slim AS runtime

# curl for the container HEALTHCHECK; ca-certificates for TLS if the agent path is ever enabled.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Run unprivileged.
RUN useradd --system --no-create-home --uid 10001 dpay

COPY --from=builder /usr/local/bin/dpay-relay /usr/local/bin/dpay-relay

# Bind on all interfaces inside the container so Caddy (or a phone on the LAN) can reach it.
# Everything the relay serves (merchant page, jsQR/qrcode assets) is compiled in — no asset files.
ENV DPAY_RELAY_ADDR=0.0.0.0:8787 \
    DPAY_PER_TX_CAP=100000

EXPOSE 8787
USER dpay

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
    CMD curl -fsS "http://localhost:8787/health" || exit 1

ENTRYPOINT ["/usr/local/bin/dpay-relay"]
