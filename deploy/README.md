# dpay public-demo deploy

Runs the **relay** (dpay's only online piece) as a container behind **Caddy**, which serves a
configurable public FQDN and terminates TLS. Deploy anywhere Docker runs — a VPS (Hetzner), a home
box behind a Cloudflare Tunnel, whatever. Same files run locally for testing.

```
relay (dpay-relay :8787)  ──  Caddy (:443, DPAY_FQDN, auto-TLS)  ──  Internet
        FakeLedger                reverse_proxy
```

## Quick start (local)

```sh
cd deploy
docker compose up -d --build          # DPAY_FQDN defaults to localhost
curl -sk https://localhost/health     # {"status":"ok"}   (-k: Caddy's local self-signed cert)
```

Open `https://localhost/` for the merchant terminal. Point the phone app's relay URL
(`app/relayConfig.ts`, or the in-app Settings field) at your `https://<DPAY_FQDN>`.

## Real deploy

```sh
cp .env.example .env        # set DPAY_FQDN=relay.dpay.example
docker compose up -d --build
```

Caddy auto-provisions a Let's Encrypt cert for `DPAY_FQDN` on first request — the box must have
ports **80 and 443** publicly reachable so the ACME challenge succeeds. Issued certs live in the
`caddy_data` volume, so restarts don't re-hit Let's Encrypt.

Behind a Cloudflare Tunnel instead of a public IP? Point `cloudflared` at `https://caddy` (or skip
Caddy's TLS and terminate at Cloudflare) — the relay itself doesn't care.

## Configuration (`.env`)

| Var | Default | Meaning |
|-----|---------|---------|
| `DPAY_FQDN` | `localhost` | Public hostname Caddy serves + gets a TLS cert for |
| `DPAY_RELAY_UPSTREAM` | `relay:8787` | Where Caddy forwards (the relay service:port) |
| `DPAY_PER_TX_CAP` | `100000` | Per-transaction cap, minor units ($1000.00) |
| `CADDY_HTTP_PORT` / `CADDY_HTTPS_PORT` | `80` / `443` | Host ports Caddy publishes |

The relay is published only to Caddy over the compose network, not to the host. To hit it directly
(bypassing Caddy) uncomment the loopback `ports` mapping in `docker-compose.yml`.

## Is the relay stateless?

**Effectively yes — treat it as stateless.** Its only in-process state is an idempotency cache
(receipts keyed by payment nonce) and an inert `safe_mode` flag; neither is persisted. The durable
source of truth — balances and single-use nonces — lives in the **ledger** (the ICP canister on the
real settlement path; an in-memory `FakeLedger` in this default image). The canister independently
refuses a replayed nonce, so a relay restart can never cause a double-charge.

Consequences:

- **Restart freely.** No volume is needed for the relay; nothing is lost that matters to money.
- **Run a single replica.** The idempotency cache is per-process. With >1 replica (or right after a
  restart) a *repeat* submit of an already-settled payment misses the local cache and reaches the
  ledger, which rejects the replayed nonce as an *error* rather than replaying the cached `200 {…,
  "replayed": true}`. Fine for a demo; for horizontal scaling, back idempotency with a shared store
  (e.g. the canister's `/receipt` lookup, or Redis).

## Default image = self-contained (FakeLedger)

The image builds `dpay-relay` with default features: an in-memory ledger pre-funded with the demo
accounts (payer at $5000.00). No canister, replica, or network dependency — the full offline-sign →
submit → "Paid ✓" flow works with just this container. Fund a fresh phone account via
`POST /faucet {"account":"<32-byte-hex>"}`.

The real-canister settlement path is behind the crate's `agent` cargo feature (not compiled into
this image; it pulls in `ic-agent`/`pocket-ic`). To ship it, add `--features agent` to the build and
set `DPAY_CANISTER_ID` / `DPAY_IC_URL` — see `crates/dpay-relay/src/main.rs`.
