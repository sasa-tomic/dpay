// Where a user who holds NOTHING actually gets some — the missing first step (founder direction
// 2026-09-09, `docs/specs/2026-09-09-funding-routes-plan.md`).
//
// THE GAP THIS CLOSES. Every deposit surface in the app correctly shows an address, a QR, a fee and
// an arrival time. All of that assumes the user already holds the asset somewhere else. The target
// user is a traveller who does not, and for whom "send VCHF from an Internet Computer wallet" is a
// complete sentence and a dead end — it names a thing they have never heard of and does not say
// how to get one. This module names the step before the address.
//
// ── The rules this data is shaped by, and why it is data ────────────────────────────────────────
// `docs/REGULATORY.md` §4 (the checklist — read it there, it is not restated here) forbids labelling
// a route "best", forbids dpay exercising routing discretion, forbids venue-paid compensation, and
// requires that a provider's rate be RELAYED, attributed and timestamped, never computed. So:
//
//   • Providers are ordered ALPHABETICALLY. That is a rule, not a preference — no ranking exists to
//     be read as a recommendation, and nothing is pre-selected or highlighted.
//   • Inclusion is a stated RULE, applied here: a provider is listed if it delivers an asset this
//     wallet holds, to a destination address the user supplies, accepts a consumer card or bank
//     transfer, and has no commercial relationship with dpay. The spec names the two providers that
//     satisfy it and are omitted for screen length (Banxa, Mercuryo) — that omission must never be
//     described to a user as a shortlist.
//   • Every figure below is the provider's OWN published number, with the date it was read. dpay
//     computes nothing, blends nothing and averages nothing.
//
// ── Why these are ranges and not prices, which is the whole reason `cap` exists ─────────────────
// Measured 2026-09-09 against each provider's own disclosure: NOT ONE of them publishes a price.
// They publish a maximum ("up to 4.5%"), and three of the four take a spread that is not counted as
// a fee at all — Transak states its quote is CoinGecko mid plus 2.5%, MoonPay says the spread is
// baked into the displayed price. Printing "MoonPay: 4.5%" would therefore be false twice over: a
// ceiling presented as a price, and a cost omitted. `cap` carries that distinction into the copy so
// the screen cannot accidentally state a number as if it were what the user will pay.
import {prettyNetwork, type SelectableAsset} from './assets';
import type {DepositMechanism} from './catalog';
import type {HomeCurrency} from './currency';

/**
 * A published cost component, in the SHAPE the provider published it. The four kinds are not
 * decoration — each is a different claim, and collapsing them is how a screen ends up lying:
 *
 *   - `flat`   — the provider states this rate outright (Coinbase: 2.5% by card).
 *   - `cap`    — a MAXIMUM ("up to 4.5%"). Never a price. Rendering it as flat overstates
 *                certainty; rendering it as a floor understates the cost.
 *   - `floor`  — a MINIMUM ("from 1%"). The user pays this or more.
 *   - `varies` — the provider publishes no single figure for this method (Transak's is
 *                per-corridor). Saying so is honest; inventing a number from a worked example and
 *                presenting it as published is not.
 *
 * This type began as `{pct, cap: boolean}` and was wrong within a day: it forced Coinbase's flat
 * 2.5% to render as "from 2.5%", which is a different and false claim.
 */
export type PublishedRate =
  | {kind: 'flat'; pct: number}
  | {kind: 'cap'; pct: number}
  | {kind: 'floor'; pct: number}
  | {kind: 'varies'};

export type FundingProvider = {
  /** Stable key for testIDs. Never shown. */
  key: string;
  /** The brand name, shown verbatim. Not translated — a company name is not a message. */
  name: string;
  card: PublishedRate | null;
  bank: PublishedRate | null;
  /** Verbatim, in the currency the provider publishes it in — a foreign-currency amount, not a
   *  number to localise. Null when the provider publishes no minimum. */
  minFee: string | null;
  /** A margin the provider discloses ON TOP of the fee, where it quantifies one. */
  spreadPct: number | null;
  /** The published disclosure this row was read from. Shown so the user can check it. */
  source: string;
};

/** The date every figure in `FUNDING_PROVIDERS` was read from its source. ONE date for the whole
 *  table, deliberately: a per-row date invites half the table going stale unnoticed. Re-reading is
 *  a tripwire filed in `OPEN_ISSUES.md`. */
export const FUNDING_SOURCES_READ_ON = '2026-09-09';

/**
 * The providers, ALPHABETICALLY. Do not reorder. Do not add a "recommended" flag. Do not add a
 * referral parameter to any source URL — item 6 of the §4 checklist is not a preference.
 */
export const FUNDING_PROVIDERS: readonly FundingProvider[] = [
  {
    key: 'coinbase',
    name: 'Coinbase',
    card: {kind: 'flat', pct: 2.5},
    bank: {kind: 'flat', pct: 0.5},
    minFee: null,
    spreadPct: null,
    source: 'docs.cdp.coinbase.com/onramp',
  },
  {
    key: 'moonpay',
    name: 'MoonPay',
    card: {kind: 'cap', pct: 4.5},
    bank: {kind: 'floor', pct: 1},
    minFee: '$3.99',
    // Disclosed but not quantified by MoonPay ("the spread is included in the price shown"), so it
    // is named in the shared caveat line rather than given a number this table cannot source.
    spreadPct: null,
    source: 'moonpay.com/legal/pricing_disclosure',
  },
  {
    key: 'ramp',
    name: 'Ramp',
    card: {kind: 'cap', pct: 3.9},
    bank: {kind: 'cap', pct: 1.4},
    minFee: '€2.49',
    spreadPct: null,
    source: 'rampnetwork.com/pricing-policy',
  },
  {
    key: 'transak',
    name: 'Transak',
    // Transak publishes no single percentage for either method — its rate is per-corridor, and the
    // 0.99% that appears in its docs is a worked EXAMPLE, not a published rate. Presenting a
    // derived number as the provider's own figure is exactly the overstatement this table exists
    // to avoid, so both methods say `varies` and the spread it genuinely does publish carries the
    // cost signal.
    card: {kind: 'varies'},
    bank: {kind: 'varies'},
    minFee: null,
    spreadPct: 2.5,
    source: 'support.transak.com/en/articles/7845942',
  },
];

/**
 * How a user gets the asset a deposit surface is showing.
 *
 *  - `buy`    — a provider sells this exact token and can pay it out on `chain`, where the sheet is
 *               showing an address. The complete, one-hop route.
 *  - `bridge` — the asset is minted by a transaction the user's OWN EVM wallet signs. There is no
 *               address to send to, and the fee is a separate holding of `gasToken`. Telling this
 *               user to "send it to the address above" is not a vaguer instruction than the truth,
 *               it is a different and wrong one — see `DepositMechanism` in `config/catalog.ts`.
 *  - `convert`— no provider sells it anywhere (measured 2026-09-04: nine catalogues, zero
 *               occurrences for VCHF/ckUSDC/ckBTC/ckETH). The user buys the token named in
 *               `viaToken` and converts in-app, signing the swap on their own device.
 *  - `testnet`— a test coin: no cash value, no seller, and a faucet instead of a provider. It still
 *               carries the mechanism (`viaWallet`), because a faucet coin on the ckERC20 rail
 *               reaches the wallet through the same signed transaction the mainnet one does.
 *  - `none`   — play money, or a row too incomplete to instruct on. No route, and none is invented.
 */
export type FundingRoute =
  | {kind: 'buy'; token: string; chain: string}
  | {kind: 'bridge'; token: string; chain: string; gasToken: string | null}
  | {kind: 'convert'; viaToken: string; targetSymbol: string}
  | {kind: 'testnet'; symbol: string; chain: string; viaWallet: boolean}
  | {kind: 'none'};

/** Native ICP — the ONE Internet Computer asset a card can reach (measured 2026-09-04). It is what
 *  makes the `convert` route exist at all, so it is named once here rather than spelled in three
 *  branches. */
const ICP_TOKEN = 'ICP';

/** The chain an `icrc-transfer` deposit is sent FROM. Not `asset.network`: on a chain-key row that
 *  field names the chain the asset is BACKED by, which is the one chain this address cannot be
 *  reached from. Spelled by the same helper every other surface names the IC with, so a rename
 *  reaches this file too. */
const IC_CHAIN = prettyNetwork('internet-computer');

/**
 * Which route applies to `asset`, given the mechanism its deposit surface actually implements.
 *
 * PURE, and exported for its own test rather than being inlined into the component: "can a
 * traveller fund this row, and how" is a claim about the world, and it needs to be checkable
 * without rendering anything.
 *
 * `mechanism` is passed in rather than derived here, and that is the whole correction of
 * 2026-09-09: this function's first version inferred it from `asset.network`, which is a DISPLAY
 * fact about backing, not a fact about how money arrives. `depositMechanism()` reads the catalog's
 * own `minter_family`/`token_contract`, and the same value picks the sheet — so the instruction is
 * written from the mechanism that is actually running.
 */
export function fundingRoute(asset: SelectableAsset, isTestnet: boolean, mechanism: DepositMechanism): FundingRoute {
  // Nothing to deposit: play money (its faucet is one tap away on the accounts route) or a row too
  // incomplete for an honest instruction. Checked FIRST — a test coin with no mechanism still has
  // nothing to say.
  if (mechanism === 'none') return {kind: 'none'};

  // Where a buyer would have to be paid out. For a wallet-signed deposit it is the EVM chain the
  // transaction runs on; for an address it is the chain that address lives on — which for an
  // Internet Computer account is the IC, whatever chain the asset is backed by.
  const chain = mechanism === 'icrc-transfer' ? IC_CHAIN : asset.network;
  // An IC row with no declared network cannot be instructed on without inventing one. Fail closed:
  // no card is worse than no card that names the wrong chain.
  if (chain === null) return {kind: 'none'};
  const viaWallet = mechanism === 'evm-wallet' || mechanism === 'evm-wallet-native';

  // A testnet coin has no cash value and no seller — offering to buy one would be nonsense, and
  // routing it to MoonPay is exactly what a naive `network !== 'Internet Computer'` check does.
  // `isTestnet` is the relay's own declaration (`isTestnetCurrency`), passed in rather than sniffed
  // from a label, because label-sniffing is the inference this codebase deliberately deleted.
  if (isTestnet) return {kind: 'testnet', symbol: asset.symbol, chain, viaWallet};

  if (viaWallet) {
    // The token to buy is the BACKING asset, which is what `symbol` already names (the wallet shows
    // backing symbols, never wrapper ids) — but it is bought INTO the user's own Ethereum wallet,
    // not sent to dpay, and the gas is a holding they must have before they start.
    return {kind: 'bridge', token: asset.symbol, chain, gasToken: mechanism === 'evm-wallet' ? gasToken(asset) : null};
  }
  if (mechanism === 'send-to-address') {
    // ckBTC is minted by sending real BTC to the real Bitcoin address the sheet already shows, and
    // every Solana row is bought and sent to a Solana address the same way. One hop, no conversion.
    return {kind: 'buy', token: asset.symbol, chain};
  }
  // `icrc-transfer`: an Internet Computer account. Native ICP is the ONE asset here a card can
  // reach; everything else on this rail (VCHF, VEUR) is bought as ICP and converted by a swap the
  // user signs on their own device.
  return asset.linkToken === ICP_TOKEN
    ? {kind: 'buy', token: ICP_TOKEN, chain}
    : {kind: 'convert', viaToken: ICP_TOKEN, targetSymbol: asset.symbol};
}

/** The gas coin for an ERC-20 bridge deposit, carried on the asset so the route stays pure. The
 *  catalog resolves it from the row's own `gas_ledger` (`gasTokenOf`); a row that cannot say falls
 *  back to null, which the copy renders as "leave a little extra for the fee" rather than naming a
 *  coin the catalog did not declare. */
function gasToken(asset: SelectableAsset): string | null {
  return asset.protocol === 'ic' ? asset.gasToken : null;
}

/** The Swiss bank route to VCHF — the ONLY measured fiat path to any Internet Computer asset other
 *  than native ICP (DFX.swiss, CHF 100 → 96.51 VCHF, min CHF 10, full KYC, Swiss sale approval
 *  only; measured 2026-09-04). Named for CHF only, because that approval is what bounds it. */
export const BANK_ROUTE_PROVIDER = 'DFX.swiss';

export function bankRouteApplies(home: HomeCurrency | null): boolean {
  return home === 'CHF';
}
