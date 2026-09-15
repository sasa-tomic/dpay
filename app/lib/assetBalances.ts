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
import type {SolanaReadFailure} from '../solana';
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
//
// `failure` is WHY an 'error' status has no fact (R3, spec 2026-09-09: three states never collapsed
// into one). Set ONLY on status 'error' — null everywhere else — so the outage note can say the
// right sentence: endpoint-refused vs phone-offline vs path-down-while-online vs untrustworthy
// bytes. `import type` from the seam keeps this module pure (the type is erased; no network code).
export type BalanceView = {displayText: string; status: BalanceStatus; failure: SolanaReadFailure | null};

// The SOL hook status union (mirrors `SolBalanceStatus` from hooks/useSolanaBalances.ts without a
// React import — structural typing keeps this module pure/testable). `failure` mirrors the hook's
// SOL-state field: why an 'error' status has no fact, null otherwise.
export type SolStateInput = {balance: string | null; status: 'loading' | 'ok' | 'unavailable' | 'error'; failure?: SolanaReadFailure | null};

// The SPL-token hook status union (mirrors `SolTokenStatus`). 'absent' (no token account) stays
// distinct from 'balance' (a real, possibly-zero amount) and from 'unavailable'
// (offline/incoherent) — plan invariant #10. One shape for EVERY registered token (USDC, EURC, …).
// `failure` mirrors the hook's per-mint field.
export type TokenStateInput = {amount: string | null; decimals: number | null; status: 'loading' | 'absent' | 'balance' | 'unavailable' | 'error'; failure?: SolanaReadFailure | null};

/** Back-compat alias — the per-mint token input carries the exact former USDC-only shape. */
export type UsdcStateInput = TokenStateInput;

/**
 * Build the per-asset balance map for the current asset list + balance sources. Every asset in
 * `assets` gets an entry; the map is keyed by the stable `AssetId`. Pure — call on every render.
 *
 * SPL tokens are keyed BY MINT: `tokenStates[mint]` is that token's hook state; each solana asset
 * row reads its own mint's entry (USDC and EURC are financially isolated — invariant #8).
 *
 * `approx` is the per-asset APPROXIMATE flag (founder requirement 2026-09-15: a balance view whose
 * data is STALE — offline for over a minute, or hydrated from the cross-restart cache — is marked
 * "~", the same marker DEMO has always carried offline). It is DERIVED upstream (Wallet: last-good
 * timestamp per asset vs a ticking `now`) and only ever PREFIXES a displayed amount here — it never
 * upgrades a status (an approximate zero is still a zero) and never invents a value ('—' stays '—').
 */
export function buildAssetBalances(args: {
  catalog: CurrencyDescriptor[];
  assets: SelectableAsset[];
  icBalances: Record<number, string>;       // keyed by IC currency id (the poll's raw map)
  primaryBalance: string | null;            // the DEMO (currency-0) balance (`shownBalance`)
  approx?: Readonly<Partial<Record<AssetId, boolean>>>;  // per-asset stale marker (all four rails)
  solState: SolStateInput;
  tokenStates: Record<string, TokenStateInput>;  // keyed by SPL mint pubkey
}): Record<AssetId, BalanceView> {
  const {catalog, assets, icBalances, primaryBalance, approx, solState, tokenStates} = args;
  const out: Partial<Record<AssetId, BalanceView>> = {};
  for (const a of assets) {
    if (a.protocol === 'ic') {
      out[a.id] = a.currency === 0
        ? demoView(primaryBalance, approx?.[a.id] === true)
        : icAssetView(catalog, a.currency, icBalances[a.currency] ?? '0', approx?.[a.id] === true);
    } else if (a.token === 'SOL') {
      out[a.id] = solView(solState, a.minFractionDigits, approx?.[a.id] === true);
    } else {
      // A registered SPL token (USDC, EURC, …): its own mint's state, own symbol, own decimals —
      // no cross-token fallback, ever.
      out[a.id] = tokenView(tokenStates[a.mint ?? ''] ?? {amount: null, decimals: null, status: 'loading'}, a.symbol, a.decimals, a.minFractionDigits, approx?.[a.id] === true);
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
// locale writes "about". Since 2026-09-15 the marker is the ONE staleness rule for every asset
// (see `buildAssetBalances`); DEMO no longer carries a private offline rule of its own.
function demoView(primaryBalance: string | null, approx: boolean): BalanceView {
  if (primaryBalance == null) return {displayText: '—', status: 'loading', failure: null};
  const amount = usd(primaryBalance);
  return {
    displayText: approx ? M.wallet.balance.approxAmount(amount) : amount,
    status: cmpRaw(primaryBalance, '0') > 0 ? 'ok' : 'zero',
    failure: null,
  };
}

// A non-DEMO IC catalog asset. A not-yet-polled asset defaults to '0' (the poll seeds '0'); funded ⇒
// 'ok', unfunded ⇒ 'zero' (dims). The amount is formatted via the catalog's per-currency COMPACT
// formatter (backs `displayName`/`familyDisplay`'s unit + decimals) so ckBTC renders "0.0005 BTC",
// never a misleading dollar amount. `approx` prefixes the same "~" marker DEMO carries when the
// asset's last good read is stale (offline > 60 s, or hydrated from the cross-restart cache).
function icAssetView(catalog: CurrencyDescriptor[], currency: number, balance: string, approx: boolean): BalanceView {
  const amount = fmtCurrencyAmountCompact(catalog, currency, balance);
  return {
    displayText: approx ? M.wallet.balance.approxAmount(amount) : amount,
    status: cmpRaw(balance, '0') > 0 ? 'ok' : 'zero',
    failure: null,
  };
}

// Native SOL. 'ok' ⇒ check the value for a zero balance; 'unavailable' ⇒ the RPC is empty/offline
// (renders '—' only when NOTHING was ever read — founder requirement 2026-09-15 #3: a wallet
// funded at home and walked offline must still see its number, so a preserved balance renders,
// approx-marked, because it cannot be fresher than the last successful read); 'error' ⇒ PRESERVES
// the prior balance (never zeroes it — plan invariant: an RPC failure must not look like a zero
// balance); 'loading' ⇒ first poll pending.
function solView(solState: SolStateInput, minFractionDigits: number, approx: boolean): BalanceView {
  // The ONE staleness rule (2026-09-15): any branch that renders a real number marks it "~" when
  // the caller says the read is stale — the same marker + the same condition demoView has always
  // applied. Zero included (demoView marks zeros too): one rule, no per-amount special cases.
  const mark = (raw: string) => (approx ? M.wallet.balance.approxAmount(raw) : raw);
  const fmt = () => fmtAssetCompact(solState.balance ?? '0', SOL_DECIMALS, SOL_UNIT, undefined, minFractionDigits);
  switch (solState.status) {
    case 'ok':
      if (solState.balance == null) return {displayText: '—', status: 'unavailable', failure: null};
      if (cmpRaw(solState.balance, '0') === 0) return {displayText: mark(fmt()), status: 'zero', failure: null};
      return {displayText: mark(fmt()), status: 'ok', failure: null};
    case 'unavailable':
      return solState.balance == null
        ? {displayText: '—', status: 'unavailable', failure: null}
        : {displayText: mark(fmt()), status: 'unavailable', failure: null};
    case 'error':
      return {
        displayText: solState.balance == null ? '—' : mark(fmt()),
        status: 'error',
        // The CAUSE travels with the row (R3): the hook classified it at the transport seam; the
        // note picks its sentence from this field, never from a guess at the component.
        failure: solState.failure ?? null,
      };
    case 'loading':
    default:
      return {displayText: '—', status: 'loading', failure: null};
  }
}

// A registered Solana SPL token (USDC, EURC, …). 'balance' ⇒ a real amount (zero ⇒ 'zero', dims);
// 'absent' ⇒ the device's token account for this mint does not exist on chain (a KNOWN
// zero-by-absence, rendered as "0 <symbol>" — distinct from a zero balance only in status, and
// from offline — invariant #10); 'unavailable' ⇒ the rail is misconfigured/offline ('—' only when
// no fact exists — a preserved/persisted amount renders approx-marked, same rule as native SOL);
// 'error' ⇒ preserves the prior amount (never zeroes); 'loading' ⇒ first poll pending. The decimals
// come from the ASSET row (registry-pinned), NOT a per-token fallback — an unknown state never
// invents a token it isn't. The unit is the asset's symbol (distinct from any IC sibling's
// "SYM · Ethereum" label — invariant #5).
function tokenView(state: TokenStateInput, symbol: string, decimals: number, minFractionDigits: number, approx: boolean): BalanceView {
  // Same ONE staleness rule as solView/demoView: a rendered number carries "~" when the caller
  // says the read is stale. 'absent' included — the zero is a persisted fact, and a stale fact is
  // still approximate.
  const mark = (raw: string) => (approx ? M.wallet.balance.approxAmount(raw) : raw);
  const fmt = (raw: string) => fmtAssetCompact(raw, decimals, symbol, undefined, minFractionDigits);
  switch (state.status) {
    case 'balance':
      if (state.amount == null) return {displayText: '—', status: 'zero', failure: null};
      if (cmpRaw(state.amount, '0') === 0) return {displayText: mark(fmt(state.amount)), status: 'zero', failure: null};
      return {displayText: mark(fmt(state.amount)), status: 'ok', failure: null};
    case 'absent':
      // D3: a missing token account is a KNOWN zero (the RPC answered — the account simply doesn't
      // exist), so render a real "0.00 <symbol>" with normal formatting. The '—' placeholder is
      // reserved strictly for unknown/unreachable states (offline / error / loading). Status stays
      // 'absent' so the row still dims and the receive/send setup-gate surfaces keep their trigger.
      return {displayText: mark(fmt('0')), status: 'absent', failure: null};
    case 'unavailable':
      return state.amount == null
        ? {displayText: '—', status: 'unavailable', failure: null}
        : {displayText: mark(fmt(state.amount)), status: 'unavailable', failure: null};
    case 'error':
      return {
        displayText: state.amount == null ? '—' : mark(fmt(state.amount)),
        status: 'error',
        failure: state.failure ?? null,
      };
    case 'loading':
    default:
      return {displayText: '—', status: 'loading', failure: null};
  }
}
