# dpay relay — container + Cloudflare Tunnel

Runs the **relay** (dpay's only online piece) as a container, exposed to the public internet through a
**Cloudflare Tunnel**. `cloudflared` dials *out* to Cloudflare's edge, so the host publishes **no
inbound ports**; TLS terminates at the edge and the tunnel reaches the relay by service name over the
compose network. DNS, DDoS protection, and WAF are handled by Cloudflare. Deploy anywhere Docker runs.

```
relay.dpay.example  ──proxied CNAME──▶  <tunnel-uuid>.cfargotunnel.com
   ▼  Cloudflare edge         (TLS, DDoS, WAF)
   ▼  cloudflared container    (remotely managed tunnel + token)   ← outbound-only, no host ports
   ▼  relay :8787              (plain HTTP on the compose network)
   ▼  ic-agent ──TLS──▶        a canister on a real IC network  (DPAY_LEDGER=ic)
                               or the in-memory demo ledger      (DPAY_LEDGER=memory)
```

**The image is configuration-free.** Which ledger, which network, which canister — all env, all in
`.env`. The public hostname is configured in Cloudflare Zero Trust. The same image runs the offline demo, a
rehearsal against a local `dfx` replica, and mainnet.

**Public surface.** `/` serves the marketing landing page, `/wallet` the web wallet (the real
RN-web app; `/merchant` 308-redirects there), `/privacy` the app and website privacy policy, the
JSON API lives under `/api/v1/`
(`/api/v1/health`, `/api/v1/pay`, `/api/v1/faucet`, `/api/v1/balance/{hex}`,
`/api/v1/receipt/{nonce}`), and the Android app is at `/download/dpay.apk`.

## One-time tunnel setup

The tunnel is *remotely managed*: its config lives in Cloudflare and `cloudflared` runs it with a
token. All Compose needs is that token in `deploy/.env` as `CF_TUNNEL_TOKEN`. Get it either way below.

### Automated — one command, no dashboard

`deploy/tunnel-provision.sh` (`just tunnel-provision`) does the whole manual setup below headlessly:
it creates the tunnel, points its ingress at `relay:8787`, publishes the proxied DNS record, and
writes `CF_TUNNEL_TOKEN` into `deploy/.env`. It needs a **scoped API token** (create at *My Profile →
API Tokens* — **not** the Global API Key) with exactly two permissions:

- **Account · Cloudflare Tunnel · Edit**
- **Zone · DNS · Edit**

```sh
export CF_API_TOKEN=<the scoped token>          # provisioning-time secret — never written to .env
export DPAY_PUBLIC_HOSTNAME=relay.dpay.example  # the hostname to serve; its zone must be on this account
just tunnel-provision
```

The zone is detected from the hostname; set `CF_ACCOUNT_ID` only if the token spans more than one
account, and `DPAY_TUNNEL_NAME` to override the default `dpay-relay`. It is create-only — if the
tunnel already exists it stops rather than clobber it. `just tunnel-destroy` (same two env vars)
removes the tunnel + DNS record, so the redo loop is `tunnel-destroy` → `tunnel-provision`.

Not `wrangler`: wrangler manages Workers/Pages, not Tunnels. This drives the Cloudflare tunnel REST
API directly (`curl` + `jq`), which is why it can hand you the exact `CF_TUNNEL_TOKEN` Compose wants.

### Manual — Cloudflare Zero Trust dashboard

In **Cloudflare Zero Trust**, open **Networks → Connectors → Cloudflare Tunnels**, create a tunnel
named `dpay-relay`, then:

1. Copy only the token from the displayed install command (`--token eyJ...`) into
   `deploy/.env` as `CF_TUNNEL_TOKEN=eyJ...`. The token is a secret; the tunnel UUID is not the token.
2. Under the tunnel's **Public Hostnames**, add your hostname (for example `relay.dpay.example`).
3. Set its service type to **HTTP** and URL to `relay:8787`, then save it.

Cloudflare creates the DNS route when the public hostname is saved. No local `cloudflared` login,
credentials JSON, or tunnel UUID is needed by Compose.

## Build + run

```sh
just image                    # host-built binary (--features agent) → slim runtime image; verified
cd deploy
cp .env.example .env          # set DPAY_CANISTER_ID and CF_TUNNEL_TOKEN
docker compose up -d          # relay + cloudflared
curl -sS https://relay.dpay.example/api/v1/health   # {"status":"ok"}
docker compose logs cloudflared | grep -i "Registered tunnel connection"   # tunnel is up
```

`just up` does the build + up in one step (and refuses to start if the tunnel token is not set);
`just compose-down` stops it. `docker compose logs -f` follows both services.

Nothing is published to the host — the relay is reachable only to cloudflared over the compose network,
and cloudflared only reaches out. To hit the relay directly (e.g. a relay-only bring-up with
`docker compose up -d relay`, or the local-replica rehearsal), uncomment the loopback `ports` mapping
in `docker-compose.yml`.

## Configuration (`.env`)

| Var | Default | Meaning |
|-----|---------|---------|
| `DPAY_LEDGER` | `ic` | `ic` = real facade + ICRC ledgers via ic-agent · `memory` = in-memory demo catalog |
| `DPAY_CANISTER_ID` | — | **Required on `ic`.** The facade canister (the catalog source) |
| `DPAY_IC_URL` | `https://icp-api.io` | Mainnet, or `http://host.docker.internal:4943` for a `dfx` replica on the host |
| `DPAY_IC_FETCH_ROOT_KEY` | auto | `true` for a local replica, `false` on mainnet — see below |
| `DPAY_ENABLE_FAUCET` | `false` | (test-helpers build only) Serve `POST /api/v1/faucet`, which credits demo funds |
| `CF_TUNNEL_TOKEN` | — | **Required.** Secret token copied from the Cloudflare tunnel install command |
| `DPAY_CLOUDFLARED_IMAGE` | `cloudflare/cloudflared:2026.7.1` | Pinned tunnel image; override only if needed |

The public hostname is configured on the tunnel in Cloudflare Zero Trust, not in `.env`.

### Three things that are money-critical, not ops trivia

**1. The root key is the trust root.** `ic-agent` verifies every reply against the network's root
key. A local replica has its own random one, so it must be *fetched* — but fetching it from a
network you don't own means trusting whatever key that endpoint hands back, which throws away the
verification that makes a receipt mean anything: a hostile boundary node could forge "Paid ✓" for a
payment that never settled. So: `true` locally, `false` on mainnet. Leave it blank and the relay
infers it from the URL (`true` only for loopback); it **refuses to start** on `fetch=true` +
mainnet.

**2. It never degrades to a pretend ledger.** If `DPAY_LEDGER=ic` and the canister is unreachable
(or `DPAY_CANISTER_ID` is unset), the relay **exits** instead of coming up on the in-memory ledger
and issuing receipts for payments that never settled. With `restart: unless-stopped` that is a
visible crash loop — which is the correct failure mode. `/api/v1/health` is likewise red when the
canister is unreachable, not merely when the socket is open. (cloudflared `depends_on` the relay being
*healthy*, so the tunnel doesn't even come up until the relay can actually settle.)

**3. The faucet mints.** `POST /api/v1/faucet` calls the canister's `mint`, which is **unauthenticated** in
the current canister. Exposed on a real ledger that is an open money printer, so it is off unless
`DPAY_ENABLE_FAUCET=true`. Turn it on only against a throwaway replica. (Gating `mint` on the
canister side — issuer-only — is still to do; the relay flag does not fix the canister. It's an
accepted gap for the current demo phase — there is no real money on the canister — and a hard gate
before the pilot.)

## Rehearse against a local replica before mainnet

The pre-mainnet gate: the real container, the real ic-agent path, a replica you own — no Cloudflare
account needed (bring up the relay alone and hit it on loopback). One catch: a container reaches a
host replica through `host.docker.internal`, so the replica must listen **beyond loopback** — start
it with `--host 0.0.0.0:4943`, not dfx's default `127.0.0.1` (otherwise the relay can't reach it and
— correctly — refuses to start).

```sh
# 1. a persistent replica bound so the container can reach it, with the canister installed:
dfx start --clean --host 0.0.0.0:4943 --background
cargo build -p dpay-canister --target wasm32-unknown-unknown --release
cargo run -q -p dpay-fixture                     # deterministic init args → dfx/args/
dfx deploy dpay_canister --argument-file dfx/args/init.arg
CID=$(dfx canister id dpay_canister)

# 2. point the relay at it; bring up the relay alone (uncomment the loopback `ports` in compose):
cd deploy && cat > .env <<EOF
DPAY_LEDGER=ic
DPAY_CANISTER_ID=$CID
DPAY_IC_URL=http://host.docker.internal:4943
DPAY_IC_FETCH_ROOT_KEY=true
DPAY_ENABLE_FAUCET=true
EOF
docker compose up -d relay && curl -sS http://127.0.0.1:8787/api/v1/health   # {"status":"ok"}
```

`host.docker.internal` resolves via the `extra_hosts` mapping in the compose file.

For mainnet, deploy the canister first, then bring up the relay:

```sh
icp-cli new-identity dpay                        # once — this identity BECOMES the canister controller
echo 'DPAY_DFX_IDENTITY=dpay' >> deploy/.env      # (a cycles-funded identity; see below)
just deploy-ic                                    # builds + deploys as `dpay`, writes DPAY_CANISTER_ID to .env
just tunnel-provision                             # publishes the tunnel (or set CF_TUNNEL_TOKEN by hand)
just up
```

`just deploy-ic` requires `DPAY_DFX_IDENTITY` — the identity that deploys **becomes the canister
controller** (upgrade authority), so it is explicit, not "whatever identity is active." It writes the
resulting `DPAY_CANISTER_ID` back into `deploy/.env` for you. Re-running it is a **redeploy**: because
this demo canister has **no stable memory**, it makes you choose `DPAY_DEPLOY_MODE=reinstall` (wipe +
re-fund) or `=upgrade` (push code, lose all balances) rather than silently wiping state. Two hard gates
before a pilot: give the controller to NNS/SNS governance (or blackhole it), and add stable storage so
upgrades preserve balances. The relay needs **no** identity — it settles anonymously; the payer's
Ed25519 signature is the authority (the caller principal is irrelevant to `pay`).

## Why the binary is built on the host

The toolchain, cargo cache and vendored crates already live in-project, so `deploy/build.sh` reuses
the warm cache (seconds) instead of recompiling `ic-agent` inside Docker on every image build. The
cost is glibc coupling: the binary links against the build host's glibc, so the runtime base must
ship one at least as new. `build.sh` picks a base that satisfies the host, then **runs the binary
inside the finished image** to prove the pairing — a mismatch fails at build time, loudly, not as a
crash-looping container on a VPS. Override with `DPAY_RUNTIME_BASE` if you need to.

If you'd rather cut the coupling entirely, build a static `x86_64-unknown-linux-musl` binary and use
a `scratch`/`distroless` base — same Dockerfile shape, one more toolchain target.

## Is the relay stateless?

**Yes — it is stateless (and value-blind by design since the 2026-08-19 cutover).** The relay has
NO settlement surface at all: it serves the read-only catalog/balances/history routes and hosts the
web wallet + APK. Its only in-process state is the test-helpers-only fake-IC gateway (absent from
the prod image). No value can move through it — the app signs `/api/v2` envelopes itself and the
IC (canisters + ICRC ledgers) is the sole mover and durable source of truth. It runs with a
read-only root filesystem and no capabilities.

Consequences:

- **Restart freely.** No volume; nothing is lost that matters to money.
- **Run a single replica.** The idempotency cache is per-process. With >1 replica (or right after a
  restart) a *repeat* submit of an already-settled payment misses the local cache and reaches the
  ledger, which rejects the replayed nonce as an *error* rather than replaying the cached
  `200 {…, "replayed": true}`. Fine for a demo; for horizontal scaling, back idempotency with a
  shared store (e.g. a `/receipt` lookup against the canister, or Redis).
