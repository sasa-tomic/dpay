# 2026-08-08 — SOL UX + integrity + codebase sweep

> Triggered by founder report: paying with SOL showed raw blockchain error ("Attempt to debit on
> account but found no record of a prior credit"). That specific bug is fixed in `30045a8`
> (shared `friendlySolError`). This plan covers the broader sweep that surfaced.

## Research (done — 4 parallel subagents)
- **E2e audit:** architecturally excellent; SOL coverage lopsided (merchant broadcast / SOL withdraw
  / SOL errors / testnet toggle uncovered); suite flaky under contention (fail-fast + tight timeouts).
- **Codebase audit:** strong discipline; remaining = LOW (empty NFC catches, DEMO_USD ×8,
  sol-devnet-test.ts in prod tree).
- **SOL rail audit:** F1 expiry unenforced, F2 merchant doesn't bind solpay→solreq, F3 no sig verify,
  F4 USDC non-functional w/o ATAs, F9 devnet/mainnet blind spot, F6 devnet-pool mislabel, F8 resync
  no retry.
- **Device UX:** devnet indicator missing (fund-loss risk), keyboard covers CTA, wrong default tab,
  unfunded dead-end, ETH label, active-rail chip missing.

## Work units (file-owned partition — no cross-subagent file overlap)

### DONE
- [x] Reported bug: shared `friendlySolError` + broadcastSolPayment regex (commit `30045a8`).

### Owner: lead (central config — single file, no conflict)
- [ ] `config/constants.ts`: `IS_SOLANA_DEVNET` (derive from SOLANA_RPC_URL ~devnet) + `SOL_BROADCAST_TIMEOUT_MS`.
- [ ] `solana/errors.ts`: refine "no record of credit" message to be honest about BOTH unfunded AND
      devnet-pool lag (so it's never wrong).
- [ ] `scripts/check-prod-sol.mjs`: prod-build guard — fail if a release SOLANA_RPC_URL points at devnet
      or rate-limited public mainnet. Wire into release path.

### Subagent A — SOL rail correctness + UX (owns: solana/payments.ts, SolPayMode.tsx,
###            SolReceiveMode.tsx, solana.ts, Wallet.tsx)
- [ ] A1 **Enforce `exp` on SOL rail** (RED-first): pure `isSolReqExpired(req, now)` in
      solana/payments.ts (jest); reject in SolPayMode.onScan; show countdown on SolReceiveMode.
- [ ] A2 **Bind scanned solpay → open solreq** before broadcast in SolReceiveMode.onSignedQr +
      SolNfcTap submit: assert to/cur/amt match reqSnapshot; clear error on mismatch.
- [ ] A3 **Unfunded escape hatch**: thread `onShowDeposit` from Wallet → SolPayMode; "Show my SOL
      address" button on the setup error + stale screens.
- [ ] A4 **resyncNonce retry/backoff** (mirror createNonceAccount 3×/500ms; extract shared helper).
- [ ] A5 **Devnet indicator** on SOL screens (badge when IS_SOLANA_DEVNET; warning line on receive sheet).
- [ ] A6 **Default landing tab → Balances** (new user has nothing to pay) + active-rail/asset chip.
- [ ] A7 **SOL_BROADCAST_TIMEOUT_MS** reuse at the 3 SOL_SEND_TIMEOUT_MS*2 sites.

### Subagent B — onboarding + cleanup (owns: Onboarding.tsx, NfcTap.tsx, SolNfcTap.tsx,
###            useNfcTapState.ts, BalancesSheet.tsx, sol-devnet-test.ts)
- [ ] B1 **Keyboard covers "Create wallet" CTA** — KeyboardAvoidingView / windowSoftInputMode.
- [ ] B2 **NFC empty catches → console.warn** (NfcTap.tsx ~3, SolNfcTap.tsx ~5, useNfcTapState.ts ~2).
- [ ] B3 **ETH sub-label** "ETH" → "Ethereum".
- [ ] B4 **Move `app/sol-devnet-test.ts`** → `.dev/sol-devnet-test.ts` (prod-tree cleanliness).

### Subagent C — e2e coverage (after A+B land; owns: e2e/tests/*, e2e harness)
- [ ] C1 SOL merchant broadcast flow (SolReceiveMode → broadcast via stub → Received).
- [ ] C2 SOL withdraw flow (SolanaWithdrawSheet, stub RPC).
- [ ] C3 SOL error path (stub returns rejection → friendly error shown).
- [ ] C4 Testnet-toggle coverage (seed FakeLedger catalog with a testnet currency).
- [ ] C5 Stabilize flakes: `02-faucet` timeout bump; `05-deposit-credited` race; `--no-failfast` triage mode.
- [ ] C6 Regenerate FLOWS.md + fix AGENTS.md "44 flows" → 51.

### Subagent D — defense-in-depth (optional, after A)
- [ ] D1 Merchant-side ed25519.verify of solpay.tx before broadcast (F3).
- [ ] D2 Gate/hide USDC toggle until ATA auto-create (F4).

## Gates after each unit: `just check` + jest + e2e + device gate for any touch path.
