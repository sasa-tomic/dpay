import {Text, View} from 'react-native';
import {S} from '../styles';
import {InstrLine} from './InstrLine';
import {M} from '../i18n';
import {decimalSep, formatMonthDayYear} from '../i18n/intl';
import {
  fundingRoute, bankRouteApplies, BANK_ROUTE_PROVIDER,
  FUNDING_PROVIDERS, FUNDING_SOURCES_READ_ON,
  type PublishedRate,
} from '../config/funding';
import type {SelectableAsset} from '../config/assets';
import type {HomeCurrency} from '../config/currency';

/**
 * "Don't have any yet?" — the step BEFORE the address, on every deposit surface (founder direction
 * 2026-09-09; design and measured evidence in `docs/specs/2026-09-09-funding-routes-plan.md`, which
 * this file does not restate).
 *
 * Every deposit sheet in the app already answers "where do I send it" correctly. None of them
 * answered "I don't have any" — and the target user is a traveller who does not. This section is
 * that answer, per asset, in the same shape as `IcrcAccountSection`: a card inside the sheet, no
 * new navigation, no new surface to find.
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
export function FundingRoutes({asset, isTestnet, homeCurrency}: {
  asset: SelectableAsset;
  /** Server-declared (`isTestnetCurrency`), never inferred from a label. A test coin has no seller
   *  and gets a faucet instruction instead of a provider list. */
  isTestnet: boolean;
  homeCurrency: HomeCurrency | null;
}) {
  const route = fundingRoute(asset, isTestnet);
  // Play money is not money: it has no seller, its faucet is one tap away on the accounts route,
  // and a "where to buy this" card over it would be the exact solicitation shape the first-run work
  // exists to remove.
  if (route.kind === 'none') {
    return null;
  }
  return (
    <View testID="funding-routes" style={S.instrCard}>
      <Text style={S.depositStatusTitle}>{M.deposit.funding.title}</Text>

      {route.kind === 'testnet' ? (
        <Text testID="funding-testnet" style={S.dim2}>
          {M.deposit.funding.testnetOnly(route.symbol, route.networkLabel)}
        </Text>
      ) : route.kind === 'buy' ? (
        <InstrLine runs={M.deposit.funding.buyThenSend(route.token, route.networkLabel)} />
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
          {FUNDING_PROVIDERS.map(p => (
            <View key={p.key} testID={`funding-provider-${p.key}`} style={S.fundingProviderRow}>
              <Text style={S.fundingProviderName}>{p.name}</Text>
              <Text style={S.fundingProviderCost}>{costLine(p.card, p.bank, p.minFee, p.spreadPct)}</Text>
              <Text style={S.fundingProviderSource} selectable={true}>{p.source}</Text>
            </View>
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

/** One provider's published cost, assembled from whichever parts that provider actually publishes.
 *  A missing part is OMITTED rather than shown as zero or as "unknown": Transak publishes no single
 *  card percentage, and inventing one — or implying the card is free — is the failure mode this
 *  whole section exists to avoid. */
function costLine(card: PublishedRate | null, bank: PublishedRate | null, minFee: string | null, spreadPct: number | null): string {
  const parts: string[] = [];
  if (card !== null) parts.push(M.deposit.funding.costCard(rate(card)));
  if (bank !== null) parts.push(M.deposit.funding.costBank(rate(bank)));
  if (minFee !== null) parts.push(M.deposit.funding.costMin(minFee));
  if (spreadPct !== null) parts.push(M.deposit.funding.costSpread(pct(spreadPct)));
  return parts.join(' · ');
}

/** A published rate rendered AS PUBLISHED. The qualifier is the whole point: a cap is not a price
 *  and a floor is not a cap, and a provider that publishes no figure for a method must say so
 *  rather than be given one. An earlier version of this had a single `cap` boolean and rendered
 *  Coinbase's flat 2.5% as "from 2.5%" — a different, false claim. */
function rate(r: PublishedRate): string {
  switch (r.kind) {
    case 'flat': return pct(r.pct);
    case 'cap': return M.deposit.funding.upTo(pct(r.pct));
    case 'floor': return M.deposit.funding.from(pct(r.pct));
    case 'varies': return M.deposit.funding.varies;
  }
}

/** A percentage in the reader's own number convention — `2.5%` in English, `2,5%` in German. The
 *  separator comes from the same ICU probe every amount in the app is formatted through, so a
 *  percentage cannot end up punctuated differently from the money beside it. */
function pct(v: number): string {
  return `${String(v).replace('.', decimalSep())}%`;
}
