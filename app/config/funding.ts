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
// ── Why these are ceilings and conditional rows, not prices — the reason `cap` exists ───────────
// Measured 2026-09-12 against each provider's own disclosure: NOT ONE of them publishes a price.
// MoonPay and Ramp publish maxima ("up to 4.5%"), some split by currency or transfer type (Ramp's
// card is 3.9% for USD/EUR/GBP and 5.45% for other currencies), Transak publishes per-method rates
// conditional on EUR, and all four take a spread that is not counted as a fee at all — Transak
// states its quote is CoinGecko mid plus a spread of 0% to 2.5%, while Coinbase, MoonPay and Ramp
// disclose a spread without putting a figure on it. Printing "MoonPay: 4.5%" would therefore be
// false twice over: a ceiling presented as a price, and a cost omitted. `cap` carries that
// distinction into the copy so the screen cannot accidentally state a number as if it were what
// the user will pay.
import {prettyNetwork, type SelectableAsset} from './assets';
import type {DepositMechanism} from './catalog';
import type {HomeCurrency} from './currency';

/**
 * A published percentage, in the SHAPE the provider published it. The qualifier is not
 * decoration — each kind is a different claim, and collapsing them is how a screen ends up
 * lying:
 *
 *   - `flat`   — the provider states this rate outright (Coinbase: 2.5% by card).
 *   - `cap`    — a MAXIMUM ("up to 4.5%"). Never a price. Rendering it as flat overstates
 *                certainty; rendering it as a floor understates the cost.
 *   - `floor`  — a MINIMUM ("from 1%"). The user pays this or more.
 *
 * This type began as `{pct, cap: boolean}` and was wrong within a day: it forced Coinbase's flat
 * 2.5% to render as "from 2.5%", which is a different and false claim.
 */
export type PublishedRate =
  | {kind: 'flat'; pct: number}
  | {kind: 'cap'; pct: number}
  | {kind: 'floor'; pct: number};

/**
 * One payment method's published cost. The 2026-09-12 re-read found two of the four providers
 * (Transak, Ramp) publishing per-method tables with conditional rows, so a method is a LIST of
 * these, each carrying exactly what its own disclosure says and nothing else:
 *
 *   - `rate`    — the published percentage, in its published shape (`PublishedRate`).
 *   - `fixed`   — an amount published ON TOP of the percentage (Transak card: "3.5% + €1").
 *                 Verbatim, in the currency the provider publishes it in — a foreign-currency
 *                 amount, not a number to localise.
 *   - `min`     — a published MINIMUM the method's fee cannot fall below (Transak SEPA:
 *                 "0.99% min €1"). Also verbatim.
 *   - `applies` — where the provider splits one method into conditional rows, the qualifier
 *                 naming WHICH currencies (EUR vs non-EUR; USD/EUR/GBP vs other) or WHICH
 *                 transfer variant (Ramp's manual/easy/Pix) the row is for. A conditional rate
 *                 stays its own row: folding "3.5%" and "5.5%" into a range would average two
 *                 different published claims into one neither makes.
 *
 * A method the provider publishes no figure for is OMITTED from the list entirely (MoonPay's
 * bank), never shown as zero and never paraphrased as "varies": dpay prints what is published
 * or nothing. The `varies` kind this model once carried was removed when Transak — its only
 * user — started publishing figures; an unreachable shape is a way to be wrong quietly.
 */
export type PublishedCost = {
  method: 'card' | 'bank' | 'sepa' | 'walletPay';
  rate: PublishedRate;
  fixed?: string;
  min?: string;
  applies?: 'eur' | 'non-eur' | 'usd-eur-gbp' | 'other-currencies' | 'manual' | 'easy' | 'pix';
};

export type FundingProvider = {
  /** Stable key for testIDs. Never shown. */
  key: string;
  /** The brand name, shown verbatim. Not translated — a company name is not a message. */
  name: string;
  /** Every published method rate, in the provider's own order. */
  costs: readonly PublishedCost[];
  /** Verbatim, in the currency the provider publishes it in — a foreign-currency amount, not a
   *  number to localise. Null when the provider publishes no minimum. */
  minFee: string | null;
  /** A margin the provider discloses ON TOP of the fee, where it quantifies one — as a
   *  `PublishedRate`, not a bare number, because Transak publishes "0% to 2.5%": rendering the top
   *  of that range as "plus 2.5% margin" would state a ceiling as the margin, which is the same
   *  overstatement `cap` exists for on the fee itself. A spread the provider DISCLOSES without
   *  quantifying (Coinbase, MoonPay, Ramp — read 2026-09-12) is null here and named by the
   *  section's shared caveat line instead. */
  spread: PublishedRate | null;
  /** MoonPay (read 2026-09-12): non-USD purchases carry a higher minimum fee. The RANGE is
   *  published (+0.25% to 10%); which currency gets which uplift is not. Stated as a range with
   *  the variation named — never the top alone, never a midpoint. Material here because dpay's
   *  home market is CHF, which is not USD. */
  nonUsdUplift?: {fromPct: number; toPct: number};
  /** The published disclosure this row was read from. Shown so the user can check it. */
  source: string;
};

/** The date every figure in `FUNDING_PROVIDERS` was read from its source. ONE date for the whole
 *  table, deliberately: a per-row date invites half the table going stale unnoticed. Re-reading is
 *  a tripwire filed in `OPEN_ISSUES.md`. */
export const FUNDING_SOURCES_READ_ON = '2026-09-12';

/**
 * The providers, ALPHABETICALLY. Do not reorder. Do not add a "recommended" flag. Do not add a
 * referral parameter to any source URL — item 6 of the §4 checklist is not a preference.
 */
export const FUNDING_PROVIDERS: readonly FundingProvider[] = [
  {
    key: 'coinbase',
    name: 'Coinbase',
    // Re-read 2026-09-12: the FAQ's card fee is worded for credit cards and states no separate
    // debit figure, so the row carries the one number the source publishes — no more precision
    // than that. The 0.5% is the ACH figure, riding the generic `bank` label it always had. The
    // spread is now DISCLOSED but not quantified: null below, named by the shared caveat line.
    costs: [
      {method: 'card', rate: {kind: 'flat', pct: 2.5}},
      {method: 'bank', rate: {kind: 'flat', pct: 0.5}},
    ],
    minFee: null,
    spread: null,
    source: 'docs.cdp.coinbase.com/onramp/additional-resources/faq',
  },
  {
    key: 'moonpay',
    name: 'MoonPay',
    costs: [{method: 'card', rate: {kind: 'cap', pct: 4.5}}],
    // The DIRECT minimum; partner sites carry $4.50. dpay hands off nothing — plain domains the
    // user types, no partner or referral links (§4 item 6) — so the direct figure is the one
    // that applies from this screen.
    minFee: '$3.99',
    // No `bank` cost row: re-read 2026-09-10, still true 2026-09-12 — the pricing disclosure
    // publishes NO bank-specific figure any more. The only "1%" on the page is the Virtual
    // Account Transaction Fee ("typically about 1%") — a different product, and "typically" is
    // neither a floor nor a cap. A "from 1%" this table could no longer point at would be
    // exactly the stale claim it exists to avoid, so the method is omitted rather than kept.
    // The spread is likewise disclosed but not quantified — shared caveat line, no number.
    spread: null,
    // NEW at the 2026-09-12 re-read: non-USD purchases carry a minimum-fee uplift, published
    // only as a range (+0.25% to 10%) with no per-currency figure. dpay's home market is CHF —
    // for this wallet's users this is the rule, not the corner case.
    nonUsdUplift: {fromPct: 0.25, toPct: 10},
    source: 'moonpay.com/legal/pricing_disclosure',
  },
  {
    key: 'ramp',
    name: 'Ramp',
    // Re-read 2026-09-12, and this is the row ticket F2 existed for: the card ceiling is 3.9%
    // only for USD/EUR/GBP — for other currencies, CHF among them, it is 5.45%. This table used
    // to carry the 3.9% alone, which understated the cost for exactly this wallet's home
    // market. Both rows render, each with its own qualifier, so a CHF user can see the number
    // that applies to them.
    costs: [
      {method: 'card', rate: {kind: 'cap', pct: 3.9}, applies: 'usd-eur-gbp'},
      {method: 'card', rate: {kind: 'cap', pct: 5.45}, applies: 'other-currencies'},
      // Bank transfer is split by transfer type. The single 1.4% this table used to carry was
      // the MANUAL figure — presenting it as THE bank cost understated easy (2.4%) and Pix
      // (2.9%).
      {method: 'bank', rate: {kind: 'flat', pct: 1.4}, applies: 'manual'},
      {method: 'bank', rate: {kind: 'flat', pct: 2.4}, applies: 'easy'},
      {method: 'bank', rate: {kind: 'flat', pct: 2.9}, applies: 'pix'},
    ],
    minFee: '€2.49',
    // Ramp discloses a spread without quantifying it — named by the shared caveat line.
    spread: null,
    source: 'rampnetwork.com/pricing-policy',
  },
  {
    key: 'transak',
    name: 'Transak',
    // Re-read 2026-09-12: the fee tables on this page are published TEXT now, not the images
    // the 09-10 read found, and they carry per-method, per-currency rates — so the `varies`
    // this row used to carry is no longer honest (figures ARE published). Card: 3.5% + €1 in
    // EUR, 5.5% + €1 outside it. Apple & Google Pay: 3.5% / 5.5% with a €1 minimum. SEPA:
    // 0.99% with the same €1 minimum. Off-ramp figures exist on the same page; this screen is
    // the on-ramp, so they are not carried here.
    costs: [
      {method: 'card', rate: {kind: 'flat', pct: 3.5}, fixed: '€1', applies: 'eur'},
      {method: 'card', rate: {kind: 'flat', pct: 5.5}, fixed: '€1', applies: 'non-eur'},
      {method: 'walletPay', rate: {kind: 'flat', pct: 3.5}, min: '€1', applies: 'eur'},
      {method: 'walletPay', rate: {kind: 'flat', pct: 5.5}, min: '€1', applies: 'non-eur'},
      {method: 'sepa', rate: {kind: 'flat', pct: 0.99}, min: '€1'},
    ],
    minFee: null,
    // The quote is "CoinGecko at the time of the transaction, plus a spread of 0% to 2.5%,
    // depending on how volatile the currency is" (unchanged since the 2026-09-10 re-read).
    // Transcribed as the ceiling of that range, rendered "up to 2.5%".
    spread: {kind: 'cap', pct: 2.5},
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
  // reach; everything else on this rail (VCHF) is bought as ICP and converted by a swap the
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
