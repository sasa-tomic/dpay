import {useState} from 'react';
import {Pressable, Text, TextInput, View} from 'react-native';
import {S} from '../styles';
import {C} from '../config/palette';
import {M} from '../i18n';
import {
  isStableCurrency, currencyName, offerableCurrencies, preferredRail,
  type HomeCurrency,
} from '../config/currency';
import type {SelectableAsset} from '../config/assets';
import {AssetGlyph} from './AssetGlyph';
import {IconChevronLeft, IconCheck, IconPlus} from './icons';

// The ADD-CURRENCY route (2026-09-24 redesign) — the full supported-currency list, and the way
// back for every removed currency. The founder's sketch, verbatim in shape: a search field at the
// top, then the list split into "Stable currencies" and "Other".
//
// Only currencies the CURRENT catalog can realise are listed (`offerableCurrencies` over the
// wallet's own visible-asset list) — a currency the user could add and then not hold would be the
// dead end the founder's 2026-08-29 rule forbids. Two row states:
//   • IN WALLET — marked, not re-addable (a check plus a label; the row is inert);
//   • hidden — an Add button, which reverses the remove (a list operation, never a recovery:
//     the rails still polled the whole time the currency was hidden).

export function AddCurrencyTab({assets, hiddenCurrencies, onBack, onAdd}: {
  assets: SelectableAsset[];
  /** The currently hidden currencies — the rows that carry an Add button. */
  hiddenCurrencies: readonly HomeCurrency[];
  onBack: () => void;
  /** Add a hidden currency back to the wallet's list. */
  onAdd: (c: HomeCurrency) => void;
}) {
  // The search is a filter, not a gate: an empty result is a real state and says so. Matching is
  // a plain case-insensitive substring on the currency's name or its code ("swiss" and "chf"
  // both find francs); no fuzzy matching, no ranking — the list is short and alphabetical.
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const matches = (c: HomeCurrency): boolean =>
    q.length === 0 || currencyName(c).toLowerCase().includes(q) || c.toLowerCase().includes(q);
  const offered = offerableCurrencies(assets);
  const stables = offered.filter(c => isStableCurrency(c) && matches(c));
  const others = offered.filter(c => !isStableCurrency(c) && matches(c));
  const hidden = new Set(hiddenCurrencies);
  return (
    <View style={S.accountsWrap}>
      <View style={S.accountsHeader}>
        <Pressable
          testID="btn-addcur-back"
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel={M.wallet.accounts.back}
          accessibilityState={{disabled: false}}>
          <IconChevronLeft size={26} color={C.ink} />
        </Pressable>
        <Text style={S.routeHeaderTitle}>{M.wallet.addCurrency.title}</Text>
        <View style={S.routeHeaderSpacer} />
      </View>
      <TextInput
        testID="input-addcur-search"
        style={S.usernameInput}
        value={query}
        onChangeText={setQuery}
        placeholder={M.wallet.addCurrency.search}
        placeholderTextColor={C.sub2}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <View testID="accounts-list" style={S.accountsList}>
        <Section testID="addcur-stable" label={M.wallet.addCurrency.stable} currencies={stables} assets={assets} hidden={hidden} onAdd={onAdd} />
        <Section testID="addcur-other" label={M.wallet.addCurrency.other} currencies={others} assets={assets} hidden={hidden} onAdd={onAdd} />
        {stables.length === 0 && others.length === 0 ? (
          <Text testID="addcur-none" style={S.dim2}>{M.wallet.addCurrency.none}</Text>
        ) : null}
      </View>
    </View>
  );
}

function Section({testID, label, currencies, assets, hidden, onAdd}: {
  testID: string;
  label: string;
  currencies: HomeCurrency[];
  assets: SelectableAsset[];
  hidden: Set<HomeCurrency>;
  onAdd: (c: HomeCurrency) => void;
}) {
  if (currencies.length === 0) return null;
  return (
    <View testID={testID}>
      <Text style={S.inputLabel}>{label}</Text>
      {currencies.map(currency => {
        const inWallet = !hidden.has(currency);
        const rail = preferredRail(currency, assets);
        return (
          <View key={currency} testID={`btn-addcur-${currency}`} style={S.assetCard}>
            <View style={S.assetRow}>
              <View style={S.assetSelectBlock}>
                <View style={S.assetSelect}>
                  {rail != null ? <AssetGlyph asset={rail} /> : null}
                  <View style={S.pickTextCol}>
                    <View style={S.assetTitleRow}>
                      <Text style={S.assetLabel}>{currencyName(currency)}</Text>
                      {inWallet ? (
                        <>
                          <IconCheck size={18} color={C.ok} />
                          <Text style={S.assetSub}>{M.wallet.addCurrency.inWallet}</Text>
                        </>
                      ) : null}
                    </View>
                  </View>
                </View>
              </View>
              {!inWallet ? (
                <Pressable
                  testID={`btn-addcur-add-${currency}`}
                  style={S.assetActionBtn}
                  onPress={() => onAdd(currency)}
                  accessibilityRole="button"
                  accessibilityLabel={M.wallet.addCurrency.add}
                  accessibilityState={{disabled: false}}
                >
                  <IconPlus size={16} color={C.brandText} />
                  <Text style={S.assetActionText}>{M.wallet.addCurrency.add}</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}
