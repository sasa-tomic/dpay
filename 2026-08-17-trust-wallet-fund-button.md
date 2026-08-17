# 2026-08-17 Trust Wallet fund-button — session plan

> Goal: one-tap "fund my dpay account from Trust Wallet" — a button on the Add-money / My-address
> surfaces that deep-links Trust Wallet's send screen with the user's dpay deposit address
> pre-filled. Research concluded 2026-08-17 (Trust developer docs + `third_party/wallet-core`
> registry analysis). **Status: NOT STARTED — picked up from the OPEN_ISSUES work order.**

## Research findings (verified 2026-08-17, do NOT re-derive)

- Trust's send deep link (official, current docs `developer.trustwallet.com/develop-for-trust/deeplinking`):
  `https://link.trustwallet.com/send?asset=<UAI>&address=<addr>[&amount=][&memo=]` — opens Trust's
  send screen pre-filled; the user reviews + confirms INSIDE Trust (dpay never sees a key — fully
  non-custodial). `https://` form preferred over `trust://` (routes to download landing if the app
  is absent instead of dead-tapping).
- UAI asset ids (from wallet-core `registry.json`, cloned at `third_party/wallet-core`): BTC = `c0`
  (coinId 0), ETH = `c60`, SOL = `c501` (coinId 501), SPL token = `c501_t<mint-base58>` (e.g. USDC
  mainnet mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`). **No testnet UAI ids exist** in
  the registry → testnet assets keep the copy/QR status quo.
- Trust also officially supports **WalletConnect v2 (EVM + Solana)** — dpay's existing WC onramp
  (`wallet.ts` → `walletconnect.ts`) already pairs with Trust via the `wc:` scheme + intent chooser
  (`openWalletApp`) and returns via `org.kalaj.dpay://` (PR13). Zero new work for ckETH/ckUSDC.
- Fire-and-forget: the send link gives NO return callback / no tx hash. Not a gap — deposit polling
  (`/deposit/refresh` for BTC-family; SOL balance refresh) already reconciles the outcome.
- Do NOT use the `data` param on the send link (unreliable for calldata) — that's why ckETH/ckUSDC
  stay on the WC path (dpay-built `depositEth` / approve+`depositErc20` calldata).

## Per-rail fit (the whole design decision)

| Rail | Deep link? | Asset id | Why |
|------|-----------|----------|-----|
| SOL mainnet in | YES — primary target | `c501` | deposit = plain transfer to the device's SOL address; no IC round trip |
| SOL USDC in | YES | `c501_t<USDC mint>` | plain SPL transfer to the user's ATA |
| BTC mainnet in | YES | `c0` | plain transfer to the ckBTC-minter-derived address |
| ckETH / ckUSDC in | NO — existing WC path | — | needs dpay-built calldata; WC + Trust already works |
| Testnet4 / Sepolia / devnet | NO — copy/QR status quo | — | no testnet UAI ids in Trust's registry |

## Implementation (est. 1–2 h, S effort)

1. **`app/trustwallet.ts`** (new, app-root module per convention — pure, zero deps):
   `trustWalletSendUrl(asset: 'SOL' | 'SOL-USDC' | 'BTC', address: string): string` — builds
   `https://link.trustwallet.com/send?...` with `encodeURIComponent` params; asset→UAI map lives
   here as consts. Amount deliberately omitted (user types it in Trust — dpay doesn't quote).
2. **Button** "Fund from Trust Wallet" on the native My-address surfaces, `Platform.OS === 'android'`
   gated (web keeps WC story; avoids a dead browser tab in the e2e harness):
   - `app/components/DepositSheet.tsx` (BTC family, when `address` is loaded + mainnet)
   - SOL address view (`app/components/SolanaReceiveSheet.tsx` / the `subMode === 'address'` branch
     of `SolReceiveMode.tsx`), SOL + USDC variants
   - `Linking.openURL(url)` fire-and-forget with honest failure copy if it throws (no Trust
     installed → the https link already handles the not-installed case, so treat throw as transient).
   - Same button shape/ghost-tier on both surfaces (CLAUDE.md "same UI surfaces" hard rule — this is
     an Add-money entry point, uniform across eligible rails; ineligible rails simply don't show it,
     same as the existing per-capability gating).
3. **Mainnet gating:** only render for mainnet currencies (BTC currency 1 / SOL mainnet rail /
   mainnet USDC). Testnet ckBTC (currency 3) etc. keep copy/QR.
4. **Tests (TDD where possible):**
   - jest golden tests for `trustWalletSendUrl` (byte-exact URLs incl. encoding).
   - jest render tests: button visible on android-gated path with address loaded, absent on testnet
     currency, absent on web (`Platform.OS` mock) — mock `Linking`, assert `openURL` called with the
     golden URL.
   - e2e: NO new flow needed (button is android-gated → invisible to the web harness by
     construction; jest owns coverage). Do not add web-visible chrome for it.
5. **Gates:** `just verify` full (typecheck with noUnusedLocals, jest, e2e 78/78 must stay green —
   the new button must not perturb existing flows or visual baselines). Not on a device-gate trigger
   path (no `app/android/**`, no wire consts, no StatusBar/SafeAreaView/scan-tree changes; RN
   `Linking` is core, no new native dep) — but run `just app` once at the end for belt-and-braces
   (self-check PASS) since it's cheap.
6. **Docs:** strike this entry from the OPEN_ISSUES work order when done; note the new module in
   `CODEBASE_ANALYSIS.md` app-module map; bump FLOWS.md only if a flow changed (none expected).

## Optional stretch (only if the above is green and time remains)

- Trust-specific WC entry on the ckERC20/ckETH pairing sheet: alongside the generic "Open in
  wallet" (chooser), a "Trust Wallet" button using `https://link.trustwallet.com/wc?uri=<url-encoded
  wc: uri>` — skips the chooser. Zero protocol change (same pairing URI, Trust-documented route).

## Explicitly rejected

- Building on the send link's `data` param (calldata via deep link) — unreliable; WC path owns it.
- Any amount pre-fill — dpay does not quote or imply conversion (no-swap non-negotiable).
- `trust://` scheme form — dead-taps when Trust is absent; the `https://` form self-heals.
- Testnet deep links — no UAI ids exist.
