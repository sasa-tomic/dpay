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
import {currencyRails, currencyUnitOf, isStableCurrency, type HomeCurrency} from '../config/currency';
import {usd, fmtAssetCompact, fmtMoneyCompact} from './format';
import {cmpRaw} from './amount';
import {SOL_DECIMALS, SOL_UNIT} from '../solana/identity';
import type {SolanaReadFailure} from '../solana';
import type {EvmReadFailure} from '../evm/errors';
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
// `amountRaw` is the SAME fact in raw smallest units ("124000000"), carried exactly when the
// status is 'ok' (a known, positive balance) and null for every placeholder ('—'), known-zero,
// absent and unknown view: `amountRaw != null` ⟺ `status === 'ok'`. It is the machine-readable
// twin any LOGIC (ranking, gating) reads, so no money decision ever parses `displayText` — the
// 2026-10-01 audit's "readiness keyed on displayText / float compares" class. Comparisons are
// valid only within ONE asset unit (same currency, same decimals) — never across.
//
// `failure` is WHY an 'error' status has no fact (R3, spec 2026-09-09: three states never collapsed
// into one). Set ONLY on status 'error' — null everywhere else — so the outage note can say the
// right sentence: endpoint-refused vs phone-offline vs path-down-while-online vs untrustworthy
// bytes. `import type` from the seam keeps this module pure (the type is erased; no network code).
export type BalanceView = {displayText: string; status: BalanceStatus; failure: SolanaReadFailure | null; amountRaw?: string | null};

// The SOL hook status union (mirrors `SolBalanceStatus` from hooks/useSolanaBalances.ts without a
// React import — structural typing keeps this module pure/testable). `failure` mirrors the hook's
// SOL-state field: why an 'error' status has no fact, null otherwise.
export type SolStateInput = {balance: string | null; status: 'loading' | 'ok' | 'unavailable' | 'error'; failure?: SolanaReadFailure | null};

// The SPL-token hook status union (mirrors `SolTokenStatus`). 'absent' (no token account) stays
// distinct from 'balance' (a real, possibly-zero amount) and from 'unavailable'
// (offline/incoherent) — plan invariant #10. One shape for EVERY registered token (USDC, EURC, …).
// `failure` mirrors the hook's per-mint field.
export type TokenStateInput = {amount: string | null; decimals: number | null; status: 'loading' | 'absent' | 'balance' | 'unavailable' | 'error'; failure?: SolanaReadFailure | null};

// The EVM per-asset state (the useEvmBalances hook's per-row shape): NO 'absent' arm — an EVM
// balanceOf answers 0 for any address, so a known zero is a 'balance' zero (the D10 note). The
// failure type is the EVM seam's own taxonomy (structurally the same four words).
export type EvmStateInput = {amount: string | null; status: 'loading' | 'balance' | 'unavailable' | 'error'; failure?: EvmReadFailure | null};

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
  evmStates?: Record<string, EvmStateInput>;     // keyed by EVM asset id (`evm:<chainId>:<TOKEN>`)
}): Record<AssetId, BalanceView> {
  const {catalog, assets, icBalances, primaryBalance, approx, solState, tokenStates, evmStates} = args;
  const out: Partial<Record<AssetId, BalanceView>> = {};
  for (const a of assets) {
    if (a.protocol === 'ic') {
      out[a.id] = a.currency === 0
        ? demoView(primaryBalance, approx?.[a.id] === true)
        : icAssetView(catalog, a.currency, icBalances[a.currency] ?? '0', approx?.[a.id] === true);
    } else if (a.protocol === 'evm') {
      // Its OWN row's state — one entry per (chain, token) id, never a cross-chain fallback
      // (the same financial isolation every other rail's rows keep).
      out[a.id] = evmView(evmStates?.[a.id] ?? {amount: null, status: 'loading'}, a.symbol, a.decimals, a.minFractionDigits, approx?.[a.id] === true);
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
  const positive = cmpRaw(primaryBalance, '0') > 0;
  return {
    displayText: approx ? M.wallet.balance.approxAmount(amount) : amount,
    status: positive ? 'ok' : 'zero',
    failure: null,
    amountRaw: positive ? primaryBalance : null,
  };
}

// A non-DEMO IC catalog asset. A not-yet-polled asset defaults to '0' (the poll seeds '0'); funded ⇒
// 'ok', unfunded ⇒ 'zero' (dims). The amount is formatted via the catalog's per-currency COMPACT
// formatter (backs `displayName`/`familyDisplay`'s unit + decimals) so ckBTC renders "0.0005 BTC",
// never a misleading dollar amount. `approx` prefixes the same "~" marker DEMO carries when the
// asset's last good read is stale (offline > 60 s, or hydrated from the cross-restart cache).
function icAssetView(catalog: CurrencyDescriptor[], currency: number, balance: string, approx: boolean): BalanceView {
  const amount = fmtCurrencyAmountCompact(catalog, currency, balance);
  const positive = cmpRaw(balance, '0') > 0;
  return {
    displayText: approx ? M.wallet.balance.approxAmount(amount) : amount,
    status: positive ? 'ok' : 'zero',
    failure: null,
    amountRaw: positive ? balance : null,
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
      return {displayText: mark(fmt()), status: 'ok', failure: null, amountRaw: solState.balance};
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
      return {displayText: mark(fmt(state.amount)), status: 'ok', failure: null, amountRaw: state.amount};
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

// One EVM token row (ZCHF·Arb, ZCHF·Eth, …). Same grading as the SOL token view minus the
// 'absent' arm (an EVM balanceOf answers 0 for any address — the D10 note): 'balance' ⇒ a real
// amount (zero ⇒ 'zero', dims); 'unavailable' ⇒ rail off/offline ('—' only when nothing was
// ever read); 'error' ⇒ preserves the prior amount (never zeroes); 'loading' ⇒ first poll
// pending. Addendum 1: display = raw / 10^decimals — no multiplier anywhere.
function evmView(state: EvmStateInput, symbol: string, decimals: number, minFractionDigits: number, approx: boolean): BalanceView {
  const mark = (raw: string) => (approx ? M.wallet.balance.approxAmount(raw) : raw);
  const fmt = (raw: string) => fmtAssetCompact(raw, decimals, symbol, undefined, minFractionDigits);
  switch (state.status) {
    case 'balance':
      if (state.amount == null) return {displayText: '—', status: 'zero', failure: null};
      if (cmpRaw(state.amount, '0') === 0) return {displayText: mark(fmt(state.amount)), status: 'zero', failure: null};
      return {displayText: mark(fmt(state.amount)), status: 'ok', failure: null, amountRaw: state.amount};
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

// ── Per-currency SUMMED balances (the currency-first redesign, founder forks #2 + #4) ───────────
//
// Fork #2: a multi-rail currency shows ONE summed currency balance across its rails — Revolut-style
// ("4.54 Fr"), never two rows of the same dollar. Fork #4: that sum renders in the CURRENCY unit
// (`4.54 Fr`, `$4.54`, `€4.54`; pure-token currencies keep their token unit `0.0005 BTC`), which
// supersedes the 2026-09-04 token-is-the-unit rule for balance display ONLY — history rows and
// every commit surface keep their own token units, and the peg disclosure lives where fees/quotes
// are shown (config/currency.ts rule 2).
//
// The sum is exact: each rail's raw smallest-unit amount is BigInt-scaled to the widest decimal
// count among the CONTRIBUTING rails before adding — no floats, no precision loss, no rounding
// (the same discipline as lib/amount.ts).
//
// Status rollup, and it is an honesty rule:
//   • a rail is READABLE when its per-asset view carries a known number ('ok' | 'zero', or
//     'absent' — a known zero-by-absence). Readable rails sum what is readable.
//   • an unreadable rail (loading / unavailable / error) contributes NOTHING to the sum and does
//     not zero it either — a partial read renders the readable part; the per-network disclosure
//     stays the existing RailUnreadableNote pattern, rendered once per affected network from the
//     per-rail views by the UI layer.
//   • NO readable rail at all: the rollup is 'loading' while every rail is still polling,
//     'error' when any rail's read failed, 'unavailable' otherwise — and the display is '—',
//     never a fabricated zero.
//
// PURE: no React, no network. Deterministic in (currencies, assets, catalog, the per-asset views,
// the raw balance inputs, the approx flags) — safe to unit-test directly and to call on every
// render (wrapped in a useMemo upstream).

// The display-precision CAP for one rail (catalog `display_decimals`, e.g. ckETH's 6-of-18).
// Solana rows carry no cap on the wire — their full decimal count is the display precision, the
// same rule `solView` applies. Never used to round: `fmtMoneyCompact` truncates toward zero and
// marks what it hid.
function railDisplayDecimals(catalog: CurrencyDescriptor[], rail: SelectableAsset): number {
  if (rail.protocol === 'ic') {
    const row = catalog.find(c => c.currency === rail.currency);
    return row?.display_decimals ?? rail.decimals;
  }
  return rail.decimals;
}

export function buildCurrencyBalances(args: {
  /** Which currencies to compute — the caller's visible list; a currency with no rail is skipped. */
  currencies: readonly HomeCurrency[];
  assets: SelectableAsset[];
  catalog: CurrencyDescriptor[];
  /** The per-asset views (buildAssetBalances' output) — the status authority for every rail. */
  views: Readonly<Partial<Record<AssetId, BalanceView>>>;
  /** IC raw balances keyed by currency id (the poll's own map). */
  icBalances: Record<number, string>;
  /** Native SOL raw balance (lamports), or null when never read. */
  solBalance: string | null;
  /** SPL raw amounts keyed by SPL mint, null when unknown/absent ('absent' status supplies '0'). */
  tokenAmounts: Record<string, string | null>;
  /** EVM raw amounts keyed by asset id (`evm:<chainId>:<TOKEN>`), null when never read. */
  evmAmounts?: Record<string, string | null>;
  /** The per-asset staleness flags — ANY contributing rail's flag marks the whole sum '~'. */
  approx: Readonly<Partial<Record<AssetId, boolean>>>;
}): Partial<Record<HomeCurrency, BalanceView>> {
  const {currencies, assets, catalog, views, icBalances, solBalance, tokenAmounts, evmAmounts, approx} = args;
  const out: Partial<Record<HomeCurrency, BalanceView>> = {};
  for (const currency of currencies) {
    const rails = currencyRails(currency, assets);
    if (rails.length === 0) continue;
    // The raw amount behind one rail's view, from the SAME inputs buildAssetBalances formats —
    // one number, two layers: the per-asset view formats it in the rail's token unit, the sum
    // scales + adds it in the currency unit. A status with no number is not a fact; 'absent'
    // (known zero-by-absence) is the one unread raw that is still a known zero.
    const rawOf = (rail: SelectableAsset): string | null => {
      const status = views[rail.id]?.status;
      if (status === 'ok' || status === 'zero') {
        if (rail.protocol === 'ic') return icBalances[rail.currency] ?? '0';
        if (rail.protocol === 'evm') return evmAmounts?.[rail.id] ?? null;
        return rail.token === 'SOL'
          ? solBalance
          : (tokenAmounts[rail.mint ?? ''] ?? null);
      }
      if (status === 'absent') return '0';
      return null;
    };
    const readable = rails.filter(r => rawOf(r) != null);
    if (readable.length === 0) {
      // Nothing readable: pick the rollup sentence's status honestly ('—' renders either way).
      const statuses = rails.map(r => views[r.id]?.status ?? 'loading');
      const status = statuses.every(s => s === 'loading')
        ? 'loading'
        : statuses.includes('error') ? 'error' : 'unavailable';
      out[currency] = {displayText: '—', status, failure: null};
      continue;
    }
    // Exact BigInt sum, scaled to the widest decimal count among the CONTRIBUTING rails. A
    // multiply loop, never `**`: the transpiler rewrites exponentiation to Math.pow, which
    // throws on BigInt operands (the same rule lib/amount.ts's pow10 documents).
    const maxDec = Math.max(...readable.map(r => r.decimals));
    let total = 0n;
    for (const rail of readable) {
      let scale = 1n;
      for (let i = 0; i < maxDec - rail.decimals; i++) scale *= 10n;
      total += BigInt(rawOf(rail)!) * scale;
    }
    const totalRaw = total.toString();
    const approxFlag = readable.some(r => approx[r.id] === true);
    const marked = (s: string) => (approxFlag ? M.wallet.balance.approxAmount(s) : s);
    // The unit is the currency's own format; a pure-token currency's unit IS its token, riding
    // as the suffix every token amount already carries.
    const unit = currencyUnitOf(currency) ?? {position: 'suffix' as const, symbol: currency};
    // Display precision: stables render money-style fixed 2 ("4.50 Fr" — the sketch's unit);
    // token currencies render at the PREFERRED rail's own display facts, so a single-rail token
    // currency's summed row is byte-identical to the per-rail row it replaces.
    const [preferred] = rails;
    const displayDecimals = isStableCurrency(currency)
      ? 2
      : railDisplayDecimals(catalog, preferred);
    const minFraction = isStableCurrency(currency) ? 2 : preferred.minFractionDigits;
    const positive = cmpRaw(totalRaw, '0') > 0;
    out[currency] = {
      displayText: marked(fmtMoneyCompact(totalRaw, maxDec, unit, displayDecimals, minFraction)),
      status: positive ? 'ok' : 'zero',
      failure: null,
      amountRaw: positive ? totalRaw : null,
    };
  }
  return out;
}
