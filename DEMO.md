# dpay — how to run the live demo

Two ways to show the offline-pay / online-confirm flow. **Demo A (phone + laptop)** is the
recommended one: one phone, one laptop, one camera hop, a big visible screen.

---

## One-time setup (Linux dev machine)

React Native's bundler (Metro) needs file-watch headroom. If a build fails with
`EMFILE: too many open files, watch` or `inotify_init … user limit`, raise the limit **once**:

```bash
sudo sysctl fs.inotify.max_user_instances=512
# persist across reboots:
echo 'fs.inotify.max_user_instances=512' | sudo tee /etc/sysctl.d/60-inotify.conf
```

(Everything else — Rust, dfx, the Android SDK/NDK, the emulator — is already vendored under
`.dev/` and `third_party/`.)

---

## Demo A — phone (payer) + laptop (merchant)   ★ recommended

**What the audience sees:** a phone in airplane mode signs a payment; the laptop scans it and it
settles on the ledger in seconds; scanning again is refused.

### 1. Laptop — start the merchant side (one command)

```bash
just demo
```

This boots a local IC replica, deploys the `dpay` canister (real ledger), and starts the relay +
**web wallet** (the real app in the browser — its **Receive** tab is the merchant terminal). It
prints a URL. Open it **on the laptop**:

```
http://localhost:8787/wallet
```

(Use `localhost` — browsers only allow the webcam on `localhost`/https.)

### 2. Phone — the payer app

Plug in an Android phone (USB debugging on) or use the emulator, then:

```bash
just app
```

The dpay app installs and opens as **“You.”** On a fresh install the wallet starts at **$0** —
fund it once from the demo faucet (**Accounts ▸ the Demo $ row ▸ the faucet button**; $100 per
wallet, rate-limited by pubkey). The green dot next to the balance means the wallet can see the
ledger.

Two operator settings point the phone at THIS laptop's demo (Settings ▸ Advanced, once per
install):

- **Relay list** → the laptop's URL (`http://<laptop-tailscale-ip>:8787`; on the Android
  emulator `http://10.0.2.2:8787` reaches the laptop's loopback).
- **IC gateway** → where the wallet submits Internet Computer transactions. Leave it empty for
  the real IC; for this demo point it at the laptop's replica (`http://10.0.2.2:4943` on the
  emulator, `http://<laptop-ip>:4943` on a physical phone on the same LAN/tailnet). This is an
  operator/testing override — normal use never touches it.

### 3. The flow (~15 seconds when online)

1. **Laptop (Receive tab):** enter the amount → the **request QR** appears
   (it encodes *who to pay, how much, and a single-use request id*).
2. **Phone:** point the camera at the request QR → **“Pay $X to Café Demo”** → **Approve**.
   - **Online (normal):** the phone submits straight to the ledger; its balance drops and the
     payment lands in the laptop’s **Recent** list (DEMO balance ticks up) within a few seconds —
     no second scan. The open request itself confirms only on the ingest paths below (camera,
     NFC, or the payer’s shared receipt); for the online path **Recent + balances are the settle
     evidence**. *(Verified 2026-09-12: a $3.50 link payment settled on-ledger and in both
     Recent lists; the request screen’s flip is scan/NFC/receipt-only by design.)*
   - **Offline / flaky link:** after 5s the phone shows a **signed QR**; the laptop's **Scan payer's
     signed QR**
      camera scans it (the terminal ingests by camera only — there is no paste box;
      **Share auth code** on the phone copies the same code for support use).
3. Both **Recent** lists (phone + laptop) show the payment.
4. **Submit the payer's signed QR a second time** → the balances do not move and **Recent** gains
   no second row: the payer signed one envelope, and the IC admits a given envelope's request id
   once, so handing the same bytes over twice settles once.
   > Say it as "the same slip, handed over twice, settles once" — NOT as a ledger nonce. On this
   > rail the request id rides as the ICRC memo and the ledger does not key on it
   > (`dpay_core::PaymentRequest`). Do not promise an "Already paid" screen: that copy renders only
   > on a ledger `Duplicate`, which this rail cannot produce. **Driven 2026-09-07** (the phone's
   > signed code submitted twice through the real terminal): the gateway takes the identical bytes
   > as a free dedup, balances and both Recent lists stay unchanged, and the terminal settles on
   > the honest dim line *"Couldn't confirm this payment yet — if the payer paid, it lands with the
   > next balance refresh."*

Amount + payee are chosen by the **merchant** (the request) and **bound by the payer's signature**,
so neither side can alter them and the payer approves the exact amount before signing.

### Why this is the clean setup
- The merchant side is the real app (web wallet) + the relay — one surface, reliable, and big
  enough for a room to see.
- It settles on a **real** local replica, not a mock — balances actually move on-chain, and the
  phone shows its **live** balance.
- Online is a one-tap direct pay; the QR "dance" is the automatic offline fallback. A fussy camera
  on the phone side never derails it (**Share auth code**); the terminal's ingest is camera-only
  today.

---

## Demo B — two phones, peer-to-peer (Alice ⇄ Bob)

The same app on both phones, each with its **own generated key + username** and **Pay / Receive**
modes. Either can pay the other.

1. **Both phones:** `just app` → on first launch, enter a username (say **Alice** on one, **Bob** on
   the other) → **Create & fund wallet**. Each generates a key on-device and gets **$100** from the
   demo faucet. (`just demo` must be up so the faucet + ledger are reachable over Tailscale.)
2. **Bob** taps **Receive** → enters an amount → shows a **request QR** (carries Bob's account + name).
3. **Alice** taps **Pay** → scans Bob's QR → **"Pay $X to Bob"** → **Approve**.
   - Online → Alice pays directly; both balances move and it lands in both **Recent** lists.
     Alice's **Share receipt** hands Bob the proof, which flips his open request to
     **"Received $X"** (verified against the ledger history, never just the shared link).
   - Bob offline / flaky → Alice shows a signed QR; Bob taps **"Payer offline? Scan their QR"** and
     scans it to submit.
4. Swap roles — Bob can now pay Alice back from what he received.

Identity is a real on-device key + faucet funding (no shared demo accounts). The username rides in
the QR as **unsigned display metadata**; the account is the source of truth. *(Out of scope, as
always: a real fiat/ckUSDC on-ramp instead of the faucet.)*

---

## What proves the tech without any phones

```bash
just deploy    # real dfx replica settles the offline-signed payment; a replay is refused
just sim       # narrated end-to-end: offline sign → Paid ✓ → double-spend refused → expired refused
just test-live # relay → live canister over ic-agent
just verify    # the whole offline inner loop (core + canister + relay + UI), in ~7s
```

---

## Troubleshooting

- **Build fails with `EMFILE` / `inotify`** → raise `fs.inotify.max_user_instances` (see setup).
- **Webcam won’t scan** → the terminal has no paste fallback today (camera-only ingest); use
  Chrome on `localhost` and show it the phone’s signed QR.
- **Phone balance stuck at 0 / “offline”** → check the two operator settings (relay list + IC
  gateway, Demo A §2) still point at the laptop, and that `just demo` is up.
- **“Refused”** on the terminal → the payment was rejected by the canister (expired, over-cap,
  insufficient funds, or a reused nonce) — the reason is shown.
- **Reset balances** → re-run `just demo` (it deploys a fresh `--clean` replica each time).
