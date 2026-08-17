import {useState} from 'react';
import {View, Text, Pressable} from 'react-native';
import {S} from '../styles';
import {C} from '../config/palette';
import {assetTestKey, displayName, fmtCurrencyAmount, type CurrencyDescriptor} from '../config/catalog';
import {IconArrowDownLeft, IconArrowUpRight} from './icons';
import type {Txn} from '../lib/types';

// Filter-chip label for a currency. Currency 0 (DEMO_USD) has symbol '$' (length 1) so displayName
// would fall through to a family default ("BTC"); label it "DEMO" to match the header pill instead.
const chipLabel = (currency: number, catalog: CurrencyDescriptor[]): string => {
  if (currency === 0) return 'DEMO';
  const desc = catalog.find(c => c.currency === currency);
  return desc ? displayName(desc) : 'asset';
};

// The transaction list, promoted from an inline card under Pay/Receive into its own tab. Renders the
// SAME row structure the old histCard used (so the e2e `RECENT`/`hist-memo` anchors carry over), but
// formats each amount in its OWN currency's units (currency 0 → `$`, else the family's native asset)
// and exposes a per-currency filter chip row when >1 currency is present.
export function Ledger({history, catalog}: {history: Txn[]; catalog: CurrencyDescriptor[]}) {
  const [filter, setFilter] = useState<number | null>(null);
  if (history.length === 0) {
    return (
      <View testID="ledger-view">
        <Text style={S.ledgerEmpty}>No payments yet.</Text>
        <Text style={S.dim2}>Tap Receive to create a payment request, or Pay to scan one.</Text>
      </View>
    );
  }
  // Unique currency ids actually present in history — drives whether the filter row renders (hidden
  // for a single-currency wallet, where a filter would be noise).
  const presentCurrencies = Array.from(new Set(history.map(t => t.currency)));
  const showFilter = presentCurrencies.length > 1;
  const rows = filter == null ? history : history.filter(t => t.currency === filter);
  return (
    <View style={S.ledgerWrap} testID="ledger-view">
      <Text style={S.histTitle}>Recent</Text>
      {showFilter ? (
        <View style={S.filterRow}>
          <Pressable
            testID="ledger-filter-all"
            style={[S.filterChip, filter == null && S.filterChipActive]}
            onPress={() => setFilter(null)}
            accessibilityRole="button"
            accessibilityLabel="All assets"
          >
            <Text style={[S.filterChipText, filter == null && S.filterChipTextActive]}>All</Text>
          </Pressable>
          {presentCurrencies.map(currency => {
            const desc = catalog.find(c => c.currency === currency);
            if (!desc) return null;
            const active = filter === currency;
            const label = chipLabel(currency, catalog);
            return (
              <Pressable
                key={currency}
                testID={`ledger-filter-${assetTestKey(desc)}`}
                style={[S.filterChip, active && S.filterChipActive]}
                onPress={() => setFilter(currency)}
                accessibilityRole="button"
                accessibilityLabel={`Filter ${label}`}
              >
                <Text style={[S.filterChipText, active && S.filterChipTextActive]}>{label}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {rows.map((t, i) => {
        // MC1 unit 6: fmtCurrencyAmount is fail-closed — it returns the explicit "Unsupported"
        // sentinel for an unknown family (never a wrong "… BTC" amount). Currency 0 still renders
        // as ∂ via the helper's early-return. This replaces a direct familyDisplay() call that
        // would have NPE'd on a null family display.
        const amtTxt = fmtCurrencyAmount(catalog, t.currency, t.amount);
        return (
          <View key={t.nonce} style={S.histRow}>
            {/* P4 — direction glyph leading each row (t.dir is Txn's reliable 'out' | 'in' field):
                incoming = arrow-down-left in ok green (matching the credited amount; tangerine stays
                reserved for CTA/active), outgoing = arrow-up-right neutral. The icon renders no
                textContent, so the asserted amounts/memos are untouched. */}
            <View style={S.histDirIcon}>
              {t.dir === 'out' ? <IconArrowUpRight size={16} color={C.sub} /> : <IconArrowDownLeft size={16} color={C.ok} />}
            </View>
            <View style={S.histWhoCol}>
              <Text style={S.histWho}>{t.dir === 'out' ? `to ${t.who || '—'}` : `from ${t.who || '—'}`}</Text>
              {t.memo ? <Text style={S.histMemo} testID={`hist-memo-${i}`}>{t.memo}</Text> : null}
            </View>
            <Text style={[S.histAmt, {color: t.dir === 'out' ? C.ink : C.ok}]}>{`${t.dir === 'out' ? '−' : '+'}${amtTxt}`}</Text>
            <Text style={S.histTime}>{t.time}</Text>
          </View>
        );
      })}
    </View>
  );
}
