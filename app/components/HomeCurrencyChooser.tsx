import {useState} from 'react';
import {Pressable, SafeAreaView, ScrollView, StatusBar, Text, View} from 'react-native';
import {C} from '../config/palette';
import {S, isDark} from '../styles';
import {M} from '../i18n';
import {Logo} from './Logo';
import {IconCheck} from './icons';
import {AssetGlyph} from './AssetGlyph';
import {type SelectableAsset} from '../config/assets';
import {
  type HomeCurrency,
  type RailBalances,
  chooseRail,
  currencyName,
  currencyRails,
  offerableCurrencies,
  railLineLabel,
} from '../config/currency';

// The first-run home-currency chooser — "which currency do you think in?".
//
// Renders INSTEAD of the wallet while no currency has been chosen, for a brand-new wallet and for
// an existing one upgrading into this build alike. One mount point, one code path: the question is
// "is a currency stored?", never "is this a new user?".
//
// Two things it deliberately does NOT do:
//
//   • It never offers a currency the catalog cannot realise. The list comes from
//     `offerableCurrencies` over the SAME visible-asset list the wallet itself uses, so EUR appears
//     the day an EURC row ships and not one build earlier. Offering a currency that resolves to
//     nothing would be the dead end the founder's 2026-08-29 rule forbids.
//   • It never prints the currency as a unit next to an amount. Each row names the currency as a
//     heading and then lists EVERY rail the wallet could hold it on — "VCHF · Internet Computer" —
//     because VCHF is a third party's token, not francs. A two-rail currency shows both lines; the
//     rail dpay would pick (`chooseRail`) is listed first with its reason, so the choice the wallet
//     will make is stated before the user commits, not discovered after.
//
// The empty case is a REAL failure, not a state to paper over: if the catalog carries no rail for
// any currency, the wallet's own asset list is broken, so the screen says so and names the relay
// setting rather than showing an empty list with a dead Continue button.
export function HomeCurrencyChooser({assets, balances, onChoose}: {
  assets: SelectableAsset[];
  balances?: RailBalances | null;
  onChoose: (c: HomeCurrency) => void;
}) {
  const offerable = offerableCurrencies(assets);
  // Pre-select the first offerable currency so Continue is never a dead button, and so a user who
  // just wants to get on with it taps once. The selection is still explicit — the row shows a check
  // and Continue commits it.
  const [picked, setPicked] = useState<HomeCurrency | null>(offerable.length > 0 ? offerable[0] : null);

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
              onPress={() => setPicked(currency)}
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
