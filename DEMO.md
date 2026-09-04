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

The dpay app installs and opens as **“You,” with a live $100.00 balance** read from the ledger.
`just app` bakes the **Tailscale** URL of this laptop into the app (a real phone reaches the laptop
over your tailnet); it's shown at the bottom of the app under **ledger** and is editable. The green
dot next to the balance means the wallet can see the ledger.

### 3. The flow (~15 seconds when online)

1. **Laptop (Receive tab):** enter the amount → the **request QR** appears
   (it encodes *who to pay, how much, and a single-use request id*).
2. **Phone:** point the camera at the request QR → **“Pay $X to Café Demo”** → **Approve**.
   - **Online (normal):** the phone submits straight to the ledger; the laptop shows
     **“Received …”** within ~1s (it polls the chain), and the phone's balance drops. No second scan.
   - **Offline / flaky link:** after 5s the phone shows a **signed QR**; the laptop's **Scan payer's
     signed QR**
     camera scans it (or use the **Share auth code** button → paste box).
3. Both **Recent** lists (phone + laptop) show the payment.
4. **Submit the payer's signed QR a second time** → the balances do not move and **Recent** gains
   no second row: the payer signed one envelope, and the IC admits a given envelope's request id
   once, so handing the same bytes over twice settles once.
   > Say it as "the same slip, handed over twice, settles once" — NOT as a ledger nonce. On this
   > rail the request id rides as the ICRC memo and the ledger does not key on it
   > (`dpay_core::PaymentRequest`). Do not promise an "Already paid" screen: that copy renders only
   > on a ledger `Duplicate`, which this rail cannot produce. **Drive this step once before showing
   > it** — it is an open gate in `OPEN_ISSUES.md`, not a formality.

Amount + payee are chosen by the **merchant** (the request) and **bound by the payer's signature**,
so neither side can alter them and the payer approves the exact amount before signing.

### Why this is the clean setup
- The merchant side is the real app (web wallet) + the relay — one surface, reliable, and big
  enough for a room to see.
- It settles on a **real** local replica, not a mock — balances actually move on-chain, and the
  phone shows its **live** balance.
- Online is a one-tap direct pay; the QR "dance" is the automatic offline fallback. A fussy camera
  never derails it (paste / share on both sides).

---

## Demo B — two phones, peer-to-peer (Alice ⇄ Bob)

The same app on both phones, each with its **own generated key + username** and **Pay / Receive**
modes. Either can pay the other.

1. **Both phones:** `just app` → on first launch, enter a username (say **Alice** on one, **Bob** on
   the other) → **Create & fund wallet**. Each generates a key on-device and gets **$100** from the
   demo faucet. (`just demo` must be up so the faucet + ledger are reachable over Tailscale.)
2. **Bob** taps **Receive** → enters an amount → shows a **request QR** (carries Bob's account + name).
3. **Alice** taps **Pay** → scans Bob's QR → **"Pay $X to Bob"** → **Approve**.
   - Online → Alice pays directly; **Bob's screen flips to "Received $X from Alice"** within ~1s, both
     balances move, and it lands in both **Recent** lists.
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
- **Webcam won’t scan** → use the **paste** box on the terminal; it takes the same code.
- **“Refused”** on the terminal → the payment was rejected by the canister (expired, over-cap,
  insufficient funds, or a reused nonce) — the reason is shown.
- **Reset balances** → re-run `just demo` (it deploys a fresh `--clean` replica each time).
