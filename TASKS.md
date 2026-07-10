# Tasks

## Active

### Week 1 — Ledger (target: Jul 14)

- [ ] **Build canister ledger** - balances, Ed25519 signature verification, nonce/expiry/cap checks, atomic transfer
- [ ] **Write canister tests** - cover valid pay, nonce reuse, expired auth, over-cap, insufficient balance
- [ ] **Deploy canister to ICP testnet** - pre-seed two demo accounts at init
- [ ] **Scaffold relay skeleton** - Node + Express + `@dfinity/agent`, wired to the canister

## Waiting On

## Someday

### Week 2 — App core (target: Jul 21)

- [ ] **On-device keygen + secure storage** - generate key on first run, Android Keystore via `react-native-keychain`
- [ ] **Two-mode RN UI** - Pay mode + Receive mode, `$` balance display
- [ ] **QR generate + scan** - request QR (merchant) and signed-authorization QR (payer)
- [ ] **Offline build-and-sign** - `{from,to,amount,nonce,expiry}`, signed with no connectivity
- [ ] **Merchant submit via relay + receipt screen** - full happy path across two devices

### Week 3 — Reliability + polish (target: Jul 28)

- [ ] **Harden relay** - idempotency (nonce key), retries + timeouts, pre-flight health check, demo safe-mode fallback
- [ ] **Airplane-mode demo flow** - the ~60-second two-phone sequence
- [ ] **Error states + balance animation + UI polish**
- [ ] **Full demo rehearsal** - dry run on the actual devices

### Week 4 — Buffer (target: Aug 4)

- [ ] **(Optional) Swap to real ckUSDC on testnet** - so "real chain-key USD" is literally true
- [ ] **Bug fixes + dry run against the actual pitch**

## Done
