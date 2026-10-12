import {Fragment} from 'react';
import {Pressable, Text, View} from 'react-native';
import {S} from '../styles';
import {C} from '../config/palette';
import {IconExternalLink} from './icons';
import {InstrLine} from './InstrLine';
import {M} from '../i18n';
import {decimalSep, formatMonthDayYear} from '../i18n/intl';
import {
  fundingRoute, bankRouteApplies, BANK_ROUTE_PROVIDER,
  FUNDING_PROVIDERS, FUNDING_SOURCES_READ_ON,
  type FundingProvider, type PublishedCost, type PublishedRate,
} from '../config/funding';
import type {SelectableAsset} from '../config/assets';
import type {DepositMechanism} from '../config/catalog';
import type {HomeCurrency} from '../config/currency';

/**
 * "Don't have any yet?" — the step BEFORE the address, on every deposit surface (founder direction
 * 2026-09-09; design and measured evidence in `docs/specs/2026-09-09-funding-routes-plan.md`, which
 * this file does not restate).
 *
 * Every deposit sheet in the app already answers "how does this asset reach me" correctly — an
 * address on three of them, a wallet to connect on the fourth. None of them answered "I don't have
 * any" — and the target user is a traveller who does not. This section is that answer, per asset,
 * in the same shape as `IcrcAccountSection`: a card inside the sheet, no new navigation, no new
 * surface to find.
 *
 * It is BUILT BY THE SURFACE THAT ROUTED TO THE SHEET and handed down as a node, never assembled by
 * the sheet itself. That is not a style choice: the mechanism that picks the sheet is the mechanism
 * the instruction must be written from, and a sheet composing its own could describe a deposit it
 * does not implement — which is exactly what shipped (see `DepositMechanism` in config/catalog.ts).
 * The sheet still owns WHERE and IN WHICH PHASE it renders, because "don't have any yet?" over a
 * completed deposit is nonsense and only the sheet knows it completed.
 *
 * ── What this deliberately is NOT ───────────────────────────────────────────────────────────────
 * Not a widget, not an embedded provider, and not a deep link carrying the user's address into a
 * provider's flow. Those are more useful and they are a SEPARATE founder decision, because choosing
 * which widget opens is routing discretion under `docs/REGULATORY.md` §4 item 5 — the founder asked
 * for counsel before that is built. So provider domains render as plain text the user reads and
 * types: dpay names routes and hands off nothing.
 *
 * Not a rate, either. dpay computes no price here. Each figure is the provider's own published
 * number, relayed with the date it was read (§4 item 7), and the qualifier that comes with it —
 * "up to" is a ceiling, not a price, and most providers additionally take a margin inside the rate
 * they quote. The attribution line says both of those out loud, because a table of percentages that
 * omitted them would be a false claim under `CLAUDE.md`'s external-claims rule.
 */
export function FundingRoutes({asset, isTestnet, mechanism, homeCurrency, onBuy}: {
  asset: SelectableAsset;
  /** Server-declared (`isTestnetCurrency`), never inferred from a label. A test coin has no seller
   *  and gets a faucet instruction instead of a provider list. */
  isTestnet: boolean;
  /** How money actually arrives for this asset — supplied by whichever surface CHOSE the deposit
   *  sheet (`depositMechanism`), so this card and the screen it sits on are written from the same
   *  fact. Deriving it here from the asset's chain name is what produced "send it to the address
   *  above" on a wallet-signed ckERC20 deposit. */
  mechanism: DepositMechanism;
  homeCurrency: HomeCurrency | null;
  /**
   * The Mt Pelerin buy opener (plan R1 step 3, §8 item 2): the founder directive upgrades the
   * inert provider rows to a named interactive option, and this row sits among them as an
   * ALPHABETICAL peer - no highlight, no "best". PRESENT ONLY when this card's asset is an EVM
   * catalog row with a delivery chain in `MTP_ASSET_DELIVERY` (the caller owns that gate, so a
   * SOL or IC row never grows the row and passes nothing).
   */
  onBuy?: () => void;
}) {
  const route = fundingRoute(asset, isTestnet, mechanism);
  // Play money is not money: it has no seller, its faucet is one tap away on the accounts route,
  // and a "where to buy this" card over it would be the exact solicitation shape the first-run work
  // exists to remove.
  if (route.kind === 'none') {
    return null;
  }
  // The row's alphabetical slot, DERIVED from the list (never a hardcoded index): first provider
  // whose name sorts after "Mt Pelerin" - Ramp today. Absent opener, no row anywhere.
  const mtpSlot = onBuy != null
    ? FUNDING_PROVIDERS.findIndex(p => p.name.localeCompare('Mt Pelerin') > 0)
    : -1;
  return (
    <View testID="funding-routes" style={S.instrCard}>
      <Text style={S.depositStatusTitle}>{M.deposit.funding.title}</Text>

      {route.kind === 'testnet' ? (
        <Text testID="funding-testnet" style={S.dim2}>
          {route.viaWallet
            ? M.deposit.funding.testnetOnlyWallet(route.symbol, route.chain)
            : M.deposit.funding.testnetOnly(route.symbol, route.chain)}
        </Text>
      ) : route.kind === 'buy' ? (
        <InstrLine runs={M.deposit.funding.buyThenSend(route.token, route.chain)} />
      ) : route.kind === 'bridge' ? (
        // Two sentences, not one with a conditional clause: the ERC-20 case needs a SECOND holding
        // the user must go and get, and the native case needs a margin on the one they are already
        // buying. Collapsing them would understate one and overstate the other.
        <InstrLine testID="funding-bridge" runs={route.gasToken !== null
          ? M.deposit.funding.bridgeWithGas(route.token, route.chain, route.gasToken)
          : M.deposit.funding.bridgeSelfGas(route.token, route.chain)} />
      ) : (
        <InstrLine runs={M.deposit.funding.buyThenConvert(route.viaToken, route.targetSymbol)} />
      )}

      {/* The Swiss bank alternative, named only where the approval behind it actually reaches. DFX
          holds a Swiss sale approval, so offering it to a EUR or USD wallet would be promising a
          route that refuses them. */}
      {route.kind === 'convert' && bankRouteApplies(homeCurrency) ? (
        <Text testID="funding-bank-route" style={S.dim2}>
          {M.deposit.funding.bankRoute(BANK_ROUTE_PROVIDER)}
        </Text>
      ) : null}

      {/* A test coin has no providers to list, and printing card fees under one would be absurd. */}
      {route.kind === 'testnet' ? null : (
        <>
          <Text style={S.depositStatusTitle}>{M.deposit.funding.providersTitle}</Text>
          {FUNDING_PROVIDERS.map((p, i) => (
            <Fragment key={p.key}>
              {/* The one interactive peer: opens the Mt Pelerin buy sheet (the sheet owns the
                  review, the facts and the open-failure note). Row grammar identical to the
                  inert ones - the external-link glyph is the only affordance cue. */}
              {i === mtpSlot && onBuy != null ? (
                <Pressable
                  testID="funding-provider-mtp"
                  style={S.fundingProviderRow}
                  onPress={onBuy}
                  accessibilityRole="button"
                  accessibilityLabel={M.deposit.mtp.entryLabel}
                  accessibilityState={{disabled: false}}>
                  <View style={S.fundingProviderHead}>
                    <Text style={S.fundingProviderName}>{'Mt Pelerin'}</Text>
                    <IconExternalLink size={14} color={C.sub} />
                  </View>
                  <Text style={S.fundingProviderCost}>{M.deposit.mtp.fundingLine}</Text>
                  <Text style={S.fundingProviderSource} selectable={true}>{'developers.mtpelerin.com'}</Text>
                </Pressable>
              ) : null}
              <View testID={`funding-provider-${p.key}`} style={S.fundingProviderRow}>
                <Text style={S.fundingProviderName}>{p.name}</Text>
                <Text style={S.fundingProviderCost}>{costLine(p)}</Text>
                <Text style={S.fundingProviderSource} selectable={true}>{p.source}</Text>
              </View>
            </Fragment>
          ))}
          <Text testID="funding-attribution" style={S.dim2}>
            {M.deposit.funding.attribution(formatMonthDayYear(new Date(FUNDING_SOURCES_READ_ON)))}
          </Text>
          <Text testID="funding-no-endorsement" style={S.dim2}>{M.deposit.funding.noEndorsement}</Text>
        </>
      )}
    </View>
  );
}

/** One provider's published cost, assembled from whichever parts that provider actually
 *  publishes. A method with no published figure is OMITTED rather than shown as zero or as
 *  "unknown" (MoonPay's bank): inventing a figure — or implying the method is free — is the
 *  failure mode this whole section exists to avoid. Conditional rates each keep their own
 *  segment with their qualifier, so the user can pick out the number that applies to them
 *  rather than read a mushed range. */
function costLine(p: FundingProvider): string {
  const parts: string[] = p.costs.map(c => methodPart(c));
  if (p.minFee !== null) parts.push(M.deposit.funding.costMin(p.minFee));
  // Published only as a range with no per-currency figure — rendered as exactly that, never as
  // its top (which would state a ceiling as the uplift) nor as a midpoint nobody published.
  if (p.nonUsdUplift !== undefined) {
    parts.push(M.deposit.funding.nonUsdUplift(pct(p.nonUsdUplift.fromPct), pct(p.nonUsdUplift.toPct)));
  }
  // The spread goes through the same `rate` shape-rendering as the fees, for the same reason:
  // Transak publishes "0% to 2.5%", and "plus 2.5% margin" would state the ceiling as the margin.
  if (p.spread !== null) parts.push(M.deposit.funding.costSpread(rate(p.spread)));
  return parts.join(' · ');
}

/** One method's published cost, AS PUBLISHED: the rate in its published shape, then any fixed
 *  amount published on top of it (Transak's "3.5% + €1"), then any published minimum beneath it
 *  (its "0.99% min €1"), then — where the row is conditional — the qualifier naming which
 *  currencies or transfer variant it is for. */
function methodPart(c: PublishedCost): string {
  const label = c.method === 'card' ? M.deposit.funding.costCard
    : c.method === 'bank' ? M.deposit.funding.costBank
    : c.method === 'sepa' ? M.deposit.funding.costSepa
    : M.deposit.funding.costWalletPay;
  let part = label(rate(c.rate));
  if (c.fixed !== undefined) part += ` ${M.deposit.funding.plusFixed(c.fixed)}`;
  if (c.min !== undefined) part += `, ${M.deposit.funding.costMin(c.min)}`;
  if (c.applies !== undefined) part += ` (${qualifier(c.applies)})`;
  return part;
}

/** The qualifier a conditional rate is published for. Ramp's transfer variants stay verbatim
 *  (manual/easy/Pix are the provider's own method names, like the provider names themselves);
 *  the currency scopes are translated. */
function qualifier(a: NonNullable<PublishedCost['applies']>): string {
  switch (a) {
    case 'eur': return M.deposit.funding.qEur;
    case 'non-eur': return M.deposit.funding.qNonEur;
    case 'usd-eur-gbp': return M.deposit.funding.qUsdEurGbp;
    case 'other-currencies': return M.deposit.funding.qOtherCurrencies;
    case 'manual': return M.deposit.funding.qManual;
    case 'easy': return M.deposit.funding.qEasy;
    case 'pix': return M.deposit.funding.qPix;
  }
}

/** A published rate rendered AS PUBLISHED. The qualifier is the whole point: a cap is not a price
 *  and a floor is not a cap, and a provider that publishes no figure for a method must be
 *  omitted rather than be given one. An earlier version of this had a single `cap` boolean and
 *  rendered Coinbase's flat 2.5% as "from 2.5%" — a different, false claim. */
function rate(r: PublishedRate): string {
  switch (r.kind) {
    case 'flat': return pct(r.pct);
    case 'cap': return M.deposit.funding.upTo(pct(r.pct));
    case 'floor': return M.deposit.funding.from(pct(r.pct));
  }
}

/** A percentage in the reader's own number convention — `2.5%` in English, `2,5%` in German. The
 *  separator comes from the same ICU probe every amount in the app is formatted through, so a
 *  percentage cannot end up punctuated differently from the money beside it. */
function pct(v: number): string {
  return `${String(v).replace('.', decimalSep())}%`;
}
