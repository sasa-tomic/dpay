// Phase 3 — per-asset balance aggregation for the unified wallet selection (2026-08-12 unified
// asset selection rewrite).
//
// `buildAssetBalances` is the ONE pure mapper from the wallet's raw balance sources (IC polled
// balances + the SOL hook state + the per-mint Solana token hook states) to a
// `Record<AssetId, BalanceView>` keyed by the STABLE asset id. Every surface that renders an
// asset amount — the header balance, the Balances sheet rows — reads from this single map, so the
// header and the sheet can NEVER disagree on an amount or a zero/dim state.
//
// PURE: no React, no network. Its output is a deterministic function of (catalog, assets, the
// balance inputs); it is safe to unit-test directly and to call on every render (wrapped in a
// useMemo upstream). No-swap / no-cross-talk: each entry is computed from its OWN source only —
// an IC asset reads `icBalances[currency]`, SOL reads `solState`, an SPL token reads its OWN
// mint's state. An IC USDC row and the Solana USDC row are financially isolated (invariant #8).

import {M} from '../i18n';
import {type CurrencyDescriptor, fmtCurrencyAmountCompact} from '../config/catalog';
import {type SelectableAsset} from '../config/assets';
import {usd, fmtAssetCompact} from './format';
import {cmpRaw} from './amount';
import {SOL_DECIMALS, SOL_UNIT} from '../solana/identity';
import type {AssetId} from './types';

// The unified per-asset balance status. Every value is meaningful for styling/gating:
//   - 'ok'           ⇒ a known, non-zero balance; full color, no dim.
//   - 'zero'         ⇒ a known zero balance (unfunded IC asset, 0-lamport SOL, 0-USDC); dim.
//   - 'absent'       ⇒ Solana USDC with no ATA on chain (a known zero-by-absence); dim.
//   - 'unavailable'  ⇒ the rail is offline / not configured (empty RPC); '—'; dim.
//   - 'error'        ⇒ the last poll failed; the PRIOR balance is preserved (never zeroed); '—' or
//                      stale value; dim. Honest: a stale value is not a confident value.
//   - 'loading'      ⇒ the first poll has not returned yet; '—'; dim.
//
// The Balances sheet dims (`zero` prop) whenever `status !== 'ok'` — the one rule covers every
// asset + rail, DEMO included: there is no exemption anywhere in this module.
export type BalanceStatus = 'ok' | 'zero' | 'absent' | 'unavailable' | 'error' | 'loading';

// One asset's rendered amount + status. `displayText` is the fully-formatted amount string the UI
// shows verbatim (e.g. "∂100.00", "0 BTC", "—", "1.50 USDC"). Balances are a GLANCEABLE surface, so
// every non-DEMO amount here is the COMPACT rendering (trailing zeros trimmed to the asset's floor;
// "≈"/"<" when a display cap hides value) — see `fmtAssetCompact`. The exact, padded string belongs
// on the surfaces where the user commits money, and is never sourced from this map. `displayText`
// already includes any offline approximation marker for DEMO ("~∂91.00") so the header and the
// sheet read byte-identical text.
export type BalanceView = {displayText: string; status: BalanceStatus};

// The SOL hook status union (mirrors `SolBalanceStatus` from hooks/useSolanaBalances.ts without a
// React import — structural typing keeps this module pure/testable).
export type SolStateInput = {balance: string | null; status: 'loading' | 'ok' | 'unavailable' | 'error'};

// The SPL-token hook status union (mirrors `SolTokenStatus`). 'absent' (no token account) stays
// distinct from 'balance' (a real, possibly-zero amount) and from 'unavailable'
// (offline/incoherent) — plan invariant #10. One shape for EVERY registered token (USDC, EURC, …).
export type TokenStateInput = {amount: string | null; decimals: number | null; status: 'loading' | 'absent' | 'balance' | 'unavailable' | 'error'};

/** Back-compat alias — the per-mint token input carries the exact former USDC-only shape. */
export type UsdcStateInput = TokenStateInput;

/**
 * Build the per-asset balance map for the current asset list + balance sources. Every asset in
 * `assets` gets an entry; the map is keyed by the stable `AssetId`. Pure — call on every render.
 *
 * SPL tokens are keyed BY MINT: `tokenStates[mint]` is that token's hook state; each solana asset
 * row reads its own mint's entry (USDC and EURC are financially isolated — invariant #8).
 */
export function buildAssetBalances(args: {
  catalog: CurrencyDescriptor[];
  assets: SelectableAsset[];
  icBalances: Record<number, string>;       // keyed by IC currency id (the poll's raw map)
  primaryBalance: string | null;            // the DEMO (currency-0) balance (`shownBalance`)
  online: boolean;                          // IC relay online (drives DEMO's "~" offline prefix)
  solState: SolStateInput;
  tokenStates: Record<string, TokenStateInput>;  // keyed by SPL mint pubkey
}): Record<AssetId, BalanceView> {
  const {catalog, assets, icBalances, primaryBalance, online, solState, tokenStates} = args;
  const out: Partial<Record<AssetId, BalanceView>> = {};
  for (const a of assets) {
    if (a.protocol === 'ic') {
      out[a.id] = a.currency === 0
        ? demoView(primaryBalance, online)
        : icAssetView(catalog, a.currency, icBalances[a.currency] ?? '0');
    } else if (a.token === 'SOL') {
      out[a.id] = solView(solState, a.minFractionDigits);
    } else {
      // A registered SPL token (USDC, EURC, …): its own mint's state, own symbol, own decimals —
      // no cross-token fallback, ever.
      out[a.id] = tokenView(tokenStates[a.mint ?? ''] ?? {amount: null, decimals: null, status: 'loading'}, a.symbol, a.decimals, a.minFractionDigits);
    }
  }
  return out as Record<AssetId, BalanceView>;
}

// DEMO (ic:0) — the primary play-money currency, graded by the SAME rule as every other asset:
// funded ⇒ 'ok', a zero balance ⇒ 'zero' (dims), an unknown one ⇒ 'loading' ('—'). It used to be
// exempt — always 'ok' — which made a ∂0.00 wallet render at full colour and stamp `fundsReady`
// (defect D4, docs/specs/2026-09-08-first-run-redesign.md). The exemption's rationale was
// backwards: the top-up affordance is the faucet button on the same row, so dimming a zero
// balance costs nothing and is simply the truth.
//
// The offline approximation marker is baked in so the header and the Balances row read the same
// text (the offline hand-off debits DEMO and the poll resets on reconnect; the marker tells the
// user the number is their best-known, not authoritative). It never upgrades the status: an
// approximate zero is still a zero. The marker itself is catalog copy — "~" is not how every
// locale writes "about".
function demoView(primaryBalance: string | null, online: boolean): BalanceView {
  if (primaryBalance == null) return {displayText: '—', status: 'loading'};
  const amount = usd(primaryBalance);
  return {
    displayText: online ? amount : M.wallet.balance.approxAmount(amount),
    status: cmpRaw(primaryBalance, '0') > 0 ? 'ok' : 'zero',
  };
}

// A non-DEMO IC catalog asset. A not-yet-polled asset defaults to '0' (the poll seeds '0'); funded ⇒
// 'ok', unfunded ⇒ 'zero' (dims). The amount is formatted via the catalog's per-currency COMPACT
// formatter (backs `displayName`/`familyDisplay`'s unit + decimals) so ckBTC renders "0.0005 BTC",
// never a misleading dollar amount.
function icAssetView(catalog: CurrencyDescriptor[], currency: number, balance: string): BalanceView {
  return {
    displayText: fmtCurrencyAmountCompact(catalog, currency, balance),
    status: cmpRaw(balance, '0') > 0 ? 'ok' : 'zero',
  };
}

// Native SOL. 'ok' ⇒ check the value for a zero balance; 'unavailable' ⇒ the RPC is empty/offline
// (the jest/e2e default — renders '—'); 'error' ⇒ PRESERVES the prior balance (never zeroes it —
// plan invariant: an RPC failure must not look like a zero balance); 'loading' ⇒ first poll pending.
function solView(solState: SolStateInput, minFractionDigits: number): BalanceView {
  switch (solState.status) {
    case 'ok':
      if (solState.balance == null) return {displayText: '—', status: 'unavailable'};
      if (cmpRaw(solState.balance, '0') === 0) return {displayText: fmtAssetCompact(solState.balance, SOL_DECIMALS, SOL_UNIT, undefined, minFractionDigits), status: 'zero'};
      return {displayText: fmtAssetCompact(solState.balance, SOL_DECIMALS, SOL_UNIT, undefined, minFractionDigits), status: 'ok'};
    case 'unavailable':
      return {displayText: '—', status: 'unavailable'};
    case 'error':
      return {
        displayText: solState.balance == null ? '—' : fmtAssetCompact(solState.balance, SOL_DECIMALS, SOL_UNIT, undefined, minFractionDigits),
        status: 'error',
      };
    case 'loading':
    default:
      return {displayText: '—', status: 'loading'};
  }
}

// A registered Solana SPL token (USDC, EURC, …). 'balance' ⇒ a real amount (zero ⇒ 'zero', dims);
// 'absent' ⇒ the device's token account for this mint does not exist on chain (a KNOWN
// zero-by-absence, rendered as "0 <symbol>" — distinct from a zero balance only in status, and
// from offline — invariant #10); 'unavailable' ⇒ the rail is misconfigured/offline; 'error' ⇒
// preserves the prior amount (never zeroes); 'loading' ⇒ first poll pending. The decimals come
// from the ASSET row (registry-pinned), NOT a per-token fallback — an unknown state never invents
// a token it isn't. The unit is the asset's symbol (distinct from any IC sibling's
// "SYM · Ethereum" label — invariant #5).
function tokenView(state: TokenStateInput, symbol: string, decimals: number, minFractionDigits: number): BalanceView {
  switch (state.status) {
    case 'balance':
      if (state.amount == null) return {displayText: '—', status: 'zero'};
      if (cmpRaw(state.amount, '0') === 0) return {displayText: fmtAssetCompact(state.amount, decimals, symbol, undefined, minFractionDigits), status: 'zero'};
      return {displayText: fmtAssetCompact(state.amount, decimals, symbol, undefined, minFractionDigits), status: 'ok'};
    case 'absent':
      // D3: a missing token account is a KNOWN zero (the RPC answered — the account simply doesn't
      // exist), so render a real "0.00 <symbol>" with normal formatting. The '—' placeholder is
      // reserved strictly for unknown/unreachable states (offline / error / loading). Status stays
      // 'absent' so the row still dims and the receive/send setup-gate surfaces keep their trigger.
      return {displayText: fmtAssetCompact('0', decimals, symbol, undefined, minFractionDigits), status: 'absent'};
    case 'unavailable':
      return {displayText: '—', status: 'unavailable'};
    case 'error':
      return {
        displayText: state.amount == null ? '—' : fmtAssetCompact(state.amount, decimals, symbol, undefined, minFractionDigits),
        status: 'error',
      };
    case 'loading':
    default:
      return {displayText: '—', status: 'loading'};
  }
}
