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
**merchant terminal**. It prints a URL. Open it **on the laptop**:

```
http://localhost:8787/
```

(Use `localhost` — browsers only allow the webcam on `localhost`/https.)

### 2. Phone — the payer app

Plug in an Android phone (USB debugging on) or use the emulator, then:

```bash
just app
```

The dpay app installs and opens as **“You,” pre-funded with $100.00**. Turn on **airplane mode** to
prove the next step is fully offline.

### 3. The flow — two scans (~30 seconds)

1. **Laptop (1 · Charge):** enter the amount → **Create request** → a **request QR** appears
   (it encodes *who to pay, how much, and a single-use request id*).
2. **Phone:** **Scan to pay** → point at the laptop's request QR → the phone shows
   **“Pay $X to Café Demo”** → **Approve**. It signs offline, in the Rust core, and shows a
   **signed QR**.
3. **Laptop (2 · Collect):** the camera scans the phone's signed QR → **Paid ✓**, the payer's
   balance drops. (Either camera fussy? Each side has a **paste** box — same result.)
4. **Settle the same request again** → **“Already paid — not charged twice.”** The merchant's
   request id *is* the ledger nonce, so a replay can never double-charge.

Why two scans: the amount and payee are chosen by the **merchant** (scan 1) and then **bound by the
payer's signature** (scan 2) — neither side can alter them, and the payer approves the exact amount
before signing. (A payer typing the amount would be neither.)

### Why this is the clean setup
- The merchant is a laptop page + the relay — reliable, and big enough for a room to see; the phone
  is the airplane-mode star.
- It settles on a **real** local replica, not a mock — the merchant balance actually moves on-chain.
- Both phones/screens have a **paste fallback**, so a fussy camera never derails the demo.

---

## Demo B — two phones (payer + seller)

The same app, two phones: one in **Pay** mode (airplane), one in **Receive** mode (online, with the
camera). The seller phone scans the payer’s QR and submits to the relay. More authentic to real
life, but the seller screen is small and the camera hop is on a phone (fussier). *(Seller-side
camera + submit is the follow-up build — see the repo notes.)*

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
