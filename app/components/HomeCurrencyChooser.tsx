import {useState} from 'react';
import {Pressable, SafeAreaView, ScrollView, StatusBar, Text, View, type TextStyle} from 'react-native';
import {C} from '../config/palette';
import {S, isDark} from '../styles';
import {M} from '../i18n';
import {Logo} from './Logo';
import {IconCheck} from './icons';
import {AssetGlyph} from './AssetGlyph';
import {RailLiquidityNote} from './RailLiquidityNote';
import {type SelectableAsset, linkNetworkOf, prettyNetwork} from '../config/assets';
import {type CurrencyDescriptor} from '../config/catalog';
import {
  type HomeCurrency,
  type RailBalances,
  chooseRail,
  currencyName,
  currencyRails,
  offerableCurrencies,
  railFees,
  railLineLabel,
  railLiquidity,
  railRampLine,
} from '../config/currency';

// The first-run home-currency chooser — "which currency do you think in?".
//
// Renders INSTEAD of the wallet while no currency has been chosen, for a brand-new wallet and for
// an existing one upgrading into this build alike. One mount point, one code path: the question is
// "is a currency stored?", never "is this a new user?".
//
// Three things it deliberately does NOT do:
//
//   • It never offers a currency the catalog cannot realise. The list comes from
//     `offerableCurrencies` over the SAME visible-asset list the wallet itself uses. Offering a
//     currency that resolves to nothing would be the dead end the founder's 2026-08-29 rule
//     forbids.
//   • It never prints the currency as a unit next to an amount. Each row names the currency as a
//     heading and then lists EVERY rail the wallet could hold it on — "VCHF · Internet Computer" —
//     because VCHF is a third party's token, not francs. A two-rail currency shows both lines; the
//     rail dpay would pick (`chooseRail`) is listed first with its reason, so the choice the wallet
//     will make is stated before the user commits, not discovered after.
//   • It never states a fact the catalog cannot back. The per-rail detail (Stage 5, EUR dual-rail)
//     renders exactly: the rail line, the chain tag, the pick reason (`chooseRail`), the fee fact
//     (`railFees`, in the rail's own unit — the SAME `M.receive.rail` vocabulary the Receive
//     disclosure uses), the liquidity statement (`railLiquidityLine`), and the ramp statement
//     (`railRampLine`). No adjectives a catalog field cannot back.
//
// The expansion is INLINE and pick-scoped: tapping a row picks it, and only a MULTI-rail currency
// also opens the detail panel inside that card (a single-rail currency — CHF — has nothing to
// compare, so it confirms exactly as before). The card's own testIDs (home-currency-<CCY>,
// btn-home-currency-continue) are byte-stable — the ~106-flow preamble rides them.
//
// The empty case is a REAL failure, not a state to paper over: if the catalog carries no rail for
// any currency, the wallet's own asset list is broken, so the screen says so and names the relay
// setting rather than showing an empty list with a dead Continue button.
export function HomeCurrencyChooser({assets, balances, catalog, onChoose}: {
  assets: SelectableAsset[];
  balances?: RailBalances | null;
  catalog: readonly CurrencyDescriptor[];
  onChoose: (c: HomeCurrency) => void;
}) {
  const offerable = offerableCurrencies(assets);
  // Pre-select the first offerable currency so Continue is never a dead button, and so a user who
  // just wants to get on with it taps once. The selection is still explicit — the row shows a
  // check and Continue commits it.
  const [picked, setPicked] = useState<HomeCurrency | null>(offerable.length > 0 ? offerable[0] : null);
  // Whether the picked card shows its per-rail detail panel. Tapping a row sets it from the
  // currency's own rail count, so single-rail currencies NEVER open it and Continue behaves
  // exactly as it did before the detail existed.
  const [detail, setDetail] = useState(false);

  return (
    <SafeAreaView style={S.root}>
      <StatusBar barStyle={isDark() ? 'light-content' : 'dark-content'} backgroundColor={C.bg} translucent={false} />
      <ScrollView contentContainerStyle={S.onboard} keyboardShouldPersistTaps="handled">
        <Logo size={72} />
        <Text testID="home-currency-title" style={S.wordmarkBig}>{M.wallet.homeCurrency.chooseTitle}</Text>
        <Text style={S.onboardSub}>{M.wallet.homeCurrency.chooseBody}</Text>

        {offerable.length === 0 ? (
          // Fail loud and name the fix. The bundled catalog is compiled into the app, so reaching
          // this means the asset list itself is broken — the actionable lever is the server URL.
          <Text testID="home-currency-none" style={S.warnNote}>{M.wallet.homeCurrency.noneAvailable}</Text>
        ) : null}

        {offerable.map(currency => {
          const rails = currencyRails(currency, assets);
          const choice = chooseRail(currency, assets, balances);
          const ordered = choice === null
            ? rails
            : [choice.rail, ...rails.filter(r => r.id !== choice.rail.id)];
          const active = picked === currency;
          return (
            <Pressable
              key={currency}
              testID={`home-currency-${currency}`}
              style={[S.assetCard, active && S.assetCardActive]}
              onPress={() => {
                setPicked(currency);
                setDetail(currencyRails(currency, assets).length > 1);
              }}
              accessibilityRole="radio"
              accessibilityLabel={M.wallet.homeCurrency.a11y(currencyName(currency))}
              accessibilityState={{checked: active, disabled: false}}
            >
              <View style={S.assetSelect}>
                {ordered.length > 0 ? <AssetGlyph asset={ordered[0]} /> : null}
                <View style={S.pickTextCol}>
                  <View style={S.assetTitleRow}>
                    <Text style={S.assetLabel}>{currencyName(currency)}</Text>
                    {active ? <View style={S.pickCheck}><IconCheck size={18} color={C.brand} /></View> : null}
                  </View>
                  {ordered.map((rail, i) => (
                    <Text key={rail.id} style={S.assetSub}>
                      {i === 0 && choice !== null
                        ? M.wallet.homeCurrency.railWithReason(railLineLabel(rail), M.wallet.homeCurrency.railReason[choice.reason])
                        : railLineLabel(rail)}
                    </Text>
                  ))}
                </View>
              </View>
              {detail && active && rails.length > 1 ? (
                <RailGroupDetail currency={currency} assets={assets} balances={balances} catalog={catalog} onBack={() => setDetail(false)} />
              ) : null}
            </Pressable>
          );
        })}

        <Pressable
          testID="btn-home-currency-continue"
          style={[S.primary, picked === null && S.disabledFlat]}
          disabled={picked === null}
          onPress={() => { if (picked !== null) onChoose(picked); }}
          accessibilityRole="button"
          accessibilityLabel={M.wallet.homeCurrency.confirm}
          accessibilityState={{disabled: picked === null}}
        >
          <Text style={S.primaryText}>{M.wallet.homeCurrency.confirm}</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

// The heading line of one detail row: the rail line itself, flexed so the chain tag sits at the
// row's right edge (the same label·value shape as assetTitleRow above it).
const detailHead: TextStyle = {flex: 1, marginTop: 0};

/**
 * The per-rail detail panel (Stage 5) — one block per rail of the currency's group, in
 * `currencyRails` order (preferred first), each stating ONLY catalog-backed facts: the rail line,
 * the settlement chain as a tag pill, the wallet's pick reason when this rail IS the pick, the
 * fee fact in the rail's own unit (the SAME `M.receive.rail` vocabulary RailDisclosure renders —
 * one fee voice everywhere), the liquidity statement (warn tone on thin, plain line on deep), and
 * the ramp statement. The Back button collapses the panel WITHOUT unpicking the row — the check
 * stays, Continue still commits the picked currency.
 *
 * Exported for the jest structural pins (the collapsed-card no-fourth-string test drives it
 * through HomeCurrencyChooser; direct rendering pins the per-rail facts).
 */
export function RailGroupDetail({currency, assets, balances, catalog, onBack}: {
  currency: HomeCurrency;
  assets: SelectableAsset[];
  balances?: RailBalances | null;
  catalog: readonly CurrencyDescriptor[];
  onBack: () => void;
}) {
  const rails = currencyRails(currency, assets);
  const choice = chooseRail(currency, assets, balances);
  return (
    <View testID="home-currency-detail" style={S.railDetailPanel}>
      <Pressable
        testID="btn-home-currency-back"
        style={S.linkBtn}
        onPress={onBack}
        accessibilityRole="button"
        accessibilityLabel={M.wallet.railDetail.back}
        accessibilityState={{disabled: false}}
      >
        <Text style={S.linkText}>{M.wallet.railDetail.back}</Text>
      </Pressable>
      {rails.map(rail => {
        // The fee fact — the identical derivation RailDisclosure uses, so the chooser's detail and
        // the Receive disclosure can never disagree about what a rail costs.
        const fees = railFees(rail, catalog);
        const network = prettyNetwork(linkNetworkOf(rail));
        const fee = fees.perTransfer == null
          ? M.receive.rail.feeUnknown(network)
          : fees.oneTime != null
            ? M.receive.rail.feeWithOneTime(network, fees.perTransfer.formatted, fees.oneTime.formatted)
            : M.receive.rail.feeLine(network, fees.perTransfer.formatted);
        const ramp = railRampLine(rail);
        const tier = railLiquidity(rail);
        return (
          <View key={rail.id} testID={`rail-detail-${rail.testKey}`} style={S.railDetailRow}>
            <AssetGlyph asset={rail} />
            <View style={S.railDetailCol}>
              <View style={S.assetTitleRow}>
                <Text style={[S.railDetailLine, detailHead]}>{railLineLabel(rail)}</Text>
                <Text testID="rail-chain-tag" style={S.railChainTag}>{rail.protocol === 'solana' ? 'SOLANA' : 'IC'}</Text>
              </View>
              {choice != null && choice.rail.id === rail.id ? (
                <Text style={S.railDetailLine}>
                  {M.wallet.homeCurrency.railWithReason(railLineLabel(rail), M.wallet.homeCurrency.railReason[choice.reason])}
                </Text>
              ) : null}
              <Text testID={`rail-detail-fee-${rail.testKey}`} style={S.railDetailLine}>{fee}</Text>
              {tier != null ? (
                <View testID={`rail-detail-liquidity-${rail.testKey}`}>
                  <RailLiquidityNote asset={rail} tone={tier === 'deep' ? 'pro' : 'warn'} />
                </View>
              ) : null}
              {ramp != null ? (
                <Text testID={`rail-detail-ramp-${rail.testKey}`} style={S.railDetailLine}>{ramp}</Text>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}
