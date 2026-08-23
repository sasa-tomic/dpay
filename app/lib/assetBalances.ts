// Phase 3 — per-asset balance aggregation for the unified wallet selection (2026-08-12 unified
// asset selection rewrite).
//
// `buildAssetBalances` is the ONE pure mapper from the wallet's raw balance sources (IC polled
// balances + the SOL hook state + the Solana-USDC hook state) to a `Record<AssetId, BalanceView>`
// keyed by the STABLE asset id. Every surface that renders an asset amount — the header balance,
// the Balances sheet rows — reads from this single map, so the header and the sheet can NEVER
// disagree on an amount or a zero/dim state.
//
// PURE: no React, no network. Its output is a deterministic function of (catalog, assets, the
// balance inputs); it is safe to unit-test directly and to call on every render (wrapped in a
// useMemo upstream). No-swap / no-cross-talk: each entry is computed from its OWN source only —
// an IC asset reads `icBalances[currency]`, SOL reads `solState`, USDC reads `usdcState`. An IC
// USDC row and the Solana USDC row are financially isolated (invariant #8).

import {type CurrencyDescriptor, fmtCurrencyAmount} from '../config/catalog';
import {type SelectableAsset} from '../config/assets';
import {usd, fmtAsset} from './format';
import {cmpRaw} from './amount';
import {SOL_DECIMALS, SOL_UNIT} from '../solana/identity';
import {USDC_DECIMALS} from '../solana/spl';
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
// asset + rail (DEMO is special-cased below to always 'ok' so it never dims, preserving the
// pre-Phase-3 "primary currency never dims" affordance).
export type BalanceStatus = 'ok' | 'zero' | 'absent' | 'unavailable' | 'error' | 'loading';

// One asset's rendered amount + status. `displayText` is the fully-formatted amount string the UI
// shows verbatim (e.g. "∂100.00", "0 BTC", "—", "1.50 USDC"). It already includes any offline
// approximation prefix for DEMO ("~∂91.00") so the header and the sheet read byte-identical text.
export type BalanceView = {displayText: string; status: BalanceStatus};

// The SOL hook status union (mirrors `SolBalanceStatus` from hooks/useSolanaBalances.ts without a
// React import — structural typing keeps this module pure/testable).
export type SolStateInput = {balance: string | null; status: 'loading' | 'ok' | 'unavailable' | 'error'};

// The USDC hook status union (mirrors `SolUsdcStatus`). 'absent' (no ATA) stays distinct from
// 'balance' (a real, possibly-zero amount) and from 'unavailable' (offline/incoherent) — plan
// invariant #10.
export type UsdcStateInput = {amount: string | null; decimals: number | null; status: 'loading' | 'absent' | 'balance' | 'unavailable' | 'error'};

/**
 * Build the per-asset balance map for the current asset list + balance sources. Every asset in
 * `assets` gets an entry; the map is keyed by the stable `AssetId`. Pure — call on every render.
 */
export function buildAssetBalances(args: {
  catalog: CurrencyDescriptor[];
  assets: SelectableAsset[];
  icBalances: Record<number, string>;       // keyed by IC currency id (the poll's raw map)
  primaryBalance: string | null;            // the DEMO (currency-0) balance (`shownBalance`)
  online: boolean;                          // IC relay online (drives DEMO's "~" offline prefix)
  solState: SolStateInput;
  usdcState: UsdcStateInput;
}): Record<AssetId, BalanceView> {
  const {catalog, assets, icBalances, primaryBalance, online, solState, usdcState} = args;
  const out: Partial<Record<AssetId, BalanceView>> = {};
  for (const a of assets) {
    if (a.protocol === 'ic') {
      out[a.id] = a.currency === 0
        ? demoView(primaryBalance, online)
        : icAssetView(catalog, a.currency, icBalances[a.currency] ?? '0');
    } else if (a.token === 'SOL') {
      out[a.id] = solView(solState);
    } else {
      // a.token === 'USDC'
      out[a.id] = usdcView(usdcState);
    }
  }
  return out as Record<AssetId, BalanceView>;
}

// DEMO (ic:0) — the primary play-money currency. NEVER marked 'zero' (it is always faucet-top-up-able,
// so dimming it would mislead); null balance ⇒ '—'. The offline "~" approximation prefix is baked in
// so the header and the Balances row read the same text (the offline hand-off debits DEMO and the
// poll resets on reconnect; "~" tells the user the number is their best-known, not authoritative).
function demoView(primaryBalance: string | null, online: boolean): BalanceView {
  if (primaryBalance == null) return {displayText: '—', status: 'ok'};
  return {displayText: `${online ? '' : '~'}${usd(primaryBalance)}`, status: 'ok'};
}

// A non-DEMO IC catalog asset. A not-yet-polled asset defaults to '0' (the poll seeds '0'); funded ⇒
// 'ok', unfunded ⇒ 'zero' (dims). The amount is formatted via the catalog's per-currency formatter
// (backs `displayName`/`familyDisplay`'s unit + decimals) so ckBTC renders "0.00050000 BTC", never a
// misleading dollar amount.
function icAssetView(catalog: CurrencyDescriptor[], currency: number, balance: string): BalanceView {
  return {
    displayText: fmtCurrencyAmount(catalog, currency, balance),
    status: cmpRaw(balance, '0') > 0 ? 'ok' : 'zero',
  };
}

// Native SOL. 'ok' ⇒ check the value for a zero balance; 'unavailable' ⇒ the RPC is empty/offline
// (the jest/e2e default — renders '—'); 'error' ⇒ PRESERVES the prior balance (never zeroes it —
// plan invariant: an RPC failure must not look like a zero balance); 'loading' ⇒ first poll pending.
function solView(solState: SolStateInput): BalanceView {
  switch (solState.status) {
    case 'ok':
      if (solState.balance == null) return {displayText: '—', status: 'unavailable'};
      if (cmpRaw(solState.balance, '0') === 0) return {displayText: fmtAsset(solState.balance, SOL_DECIMALS, SOL_UNIT), status: 'zero'};
      return {displayText: fmtAsset(solState.balance, SOL_DECIMALS, SOL_UNIT), status: 'ok'};
    case 'unavailable':
      return {displayText: '—', status: 'unavailable'};
    case 'error':
      return {
        displayText: solState.balance == null ? '—' : fmtAsset(solState.balance, SOL_DECIMALS, SOL_UNIT),
        status: 'error',
      };
    case 'loading':
    default:
      return {displayText: '—', status: 'loading'};
  }
}

// Solana USDC (an SPL token). 'balance' ⇒ a real amount (zero ⇒ 'zero', dims); 'absent' ⇒ the
// device's USDC ATA does not exist on chain (a KNOWN zero-by-absence, rendered as "0 USDC" —
// distinct from a zero balance only in status, and from offline — invariant #10); 'unavailable' ⇒
// the rail is misconfigured/offline; 'error' ⇒ preserves the prior amount (never zeroes);
// 'loading' ⇒ first poll pending. The unit is always 'USDC' (distinct from any IC USDC's
// "USDC · Ethereum" label — invariant #5).
function usdcView(usdcState: UsdcStateInput): BalanceView {
  const decimals = usdcState.decimals ?? USDC_DECIMALS;
  switch (usdcState.status) {
    case 'balance':
      if (usdcState.amount == null) return {displayText: '—', status: 'zero'};
      if (cmpRaw(usdcState.amount, '0') === 0) return {displayText: fmtAsset(usdcState.amount, decimals, 'USDC'), status: 'zero'};
      return {displayText: fmtAsset(usdcState.amount, decimals, 'USDC'), status: 'ok'};
    case 'absent':
      // D3: a missing ATA is a KNOWN zero (the RPC answered — the account simply doesn't exist), so
      // render a real "0 USDC" with normal formatting. The '—' placeholder is reserved strictly for
      // unknown/unreachable states (offline / error / loading). Status stays 'absent' so the row
      // still dims and the receive/send setup-gate surfaces keep their trigger.
      return {displayText: fmtAsset('0', decimals, 'USDC'), status: 'absent'};
    case 'unavailable':
      return {displayText: '—', status: 'unavailable'};
    case 'error':
      return {
        displayText: usdcState.amount == null ? '—' : fmtAsset(usdcState.amount, decimals, 'USDC'),
        status: 'error',
      };
    case 'loading':
    default:
      return {displayText: '—', status: 'loading'};
  }
}
