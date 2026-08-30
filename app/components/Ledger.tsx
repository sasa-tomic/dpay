import {useState} from 'react';
import {View, Text, Pressable} from 'react-native';
import {S} from '../styles';
import {M} from '../i18n';
import {C} from '../config/palette';
import {assetTestKey, fmtCurrencyAmount, type CurrencyDescriptor} from '../config/catalog';
import {chipLabel, type SelectableAsset} from '../config/assets';
import {fmtAsset} from '../lib/format';
import {IconArrowDownLeft, IconArrowUpRight} from './icons';
import type {AssetId, Txn} from '../lib/types';

// The chip's stable testID key, dispatched on rail. An IC row keeps the CATALOG's `assetTestKey`
// (the id the existing selectors are written against); a Solana row uses the SelectableAsset's own
// literal key ('sol' / 'sol-usdc'), which is the only key that rail has. `null` when an IC row's
// descriptor is absent — the same fail-closed "then render no chip" the currency-keyed version had.
function filterTestKey(asset: SelectableAsset, catalog: CurrencyDescriptor[]): string | null {
  if (asset.protocol === 'solana') return asset.testKey;
  const desc = catalog.find(c => c.currency === asset.currency);
  return desc ? assetTestKey(desc) : null;
}

// One row's amount in the row's OWN units, dispatched on rail. An IC row goes through
// `fmtCurrencyAmount` (DEMO's `∂` early-return lives inside it, and it fail-closes to the explicit
// "Unsupported" sentinel for an unknown family — never a wrong "… BTC"); a Solana row formats at its
// SelectableAsset's `decimals` + `symbol`, the only place those facts exist for that rail. A row
// whose asset is not in the visible list (a testnet asset hidden mid-poll, a disabled rail) fails
// closed to the SAME sentinel rather than guessing a unit.
function fmtRowAmount(t: Txn, catalog: CurrencyDescriptor[], assets: SelectableAsset[]): string {
  const asset = assets.find(a => a.id === t.assetId);
  if (!asset) return M.wallet.asset.unsupported;
  return asset.protocol === 'ic'
    ? fmtCurrencyAmount(catalog, asset.currency, t.amount)
    : fmtAsset(t.amount, asset.decimals, asset.symbol);
}

// The transaction list, promoted from an inline card under Pay/Receive into its own tab. Renders the
// SAME row structure the old histCard used (so the e2e `RECENT`/`hist-memo` anchors carry over), but
// formats each amount in its OWN asset's units and exposes a per-asset filter chip row when >1 asset
// is present.
//
// Rows are keyed on `AssetId`, not on an IC currency id: the list carries BOTH rails (the IC ledger
// and the native Solana device-key rail), and a currency u32 cannot name `solana:SOL`. `assets` is
// the wallet's visible SelectableAsset list — the single source of the labels, decimals and symbols
// both rails are rendered with.
export function Ledger({history, catalog, assets}: {history: Txn[]; catalog: CurrencyDescriptor[]; assets: SelectableAsset[]}) {
  const [filter, setFilter] = useState<AssetId | null>(null);
  if (history.length === 0) {
    return (
      <View testID="ledger-view">
        <Text style={S.ledgerEmpty}>{M.wallet.ledger.empty}</Text>
        <Text style={S.dim2}>{M.wallet.ledger.emptyHint}</Text>
      </View>
    );
  }
  // Unique asset ids actually present in history — drives whether the filter row renders (hidden
  // for a single-asset wallet, where a filter would be noise).
  const presentAssets = Array.from(new Set(history.map(t => t.assetId)));
  const showFilter = presentAssets.length > 1;
  const rows = filter == null ? history : history.filter(t => t.assetId === filter);
  return (
    <View style={S.ledgerWrap} testID="ledger-view">
      <Text style={S.histTitle}>{M.wallet.ledger.recent}</Text>
      {showFilter ? (
        <View style={S.filterRow}>
          <Pressable
            testID="ledger-filter-all"
            style={[S.filterChip, filter == null && S.filterChipActive]}
            onPress={() => setFilter(null)}
            accessibilityRole="button"
            accessibilityLabel={M.wallet.ledger.allAssets}
          >
            <Text style={[S.filterChipText, filter == null && S.filterChipTextActive]}>{M.wallet.ledger.all}</Text>
          </Pressable>
          {presentAssets.map(id => {
            // An asset the wallet is not currently showing (a hidden testnet row, a disabled rail)
            // gets no chip — the fail-closed shape the missing-descriptor check had.
            const asset = assets.find(a => a.id === id);
            if (!asset) return null;
            const testKey = filterTestKey(asset, catalog);
            if (testKey === null) return null;
            const active = filter === id;
            // The SAME label the header/active-rail chip uses, so the two never disagree — and it
            // qualifies a symbol that appears on two rails (USDC·Eth / USDC·Sol) instead of
            // rendering two identical chips.
            const label = chipLabel(asset, assets);
            return (
              <Pressable
                key={id}
                testID={`ledger-filter-${testKey}`}
                style={[S.filterChip, active && S.filterChipActive]}
                onPress={() => setFilter(id)}
                accessibilityRole="button"
                accessibilityLabel={M.wallet.ledger.filter(label)}
              >
                <Text style={[S.filterChipText, active && S.filterChipTextActive]}>{label}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {rows.map((t, i) => {
        const amtTxt = fmtRowAmount(t, catalog, assets);
        return (
          // IC-rail rows carry an EMPTY nonce (memo is the reconciliation key), so the raw nonce
          // alone is no longer unique (mint + transfer rows collide). Composite key: index pins
          // positional identity; the nonce keeps facade-era rows (which had unique nonces) stable
          // across refreshes when the list head shifts.
          <View key={`${i}-${t.nonce}`} style={S.histRow}>
            {/* P4 — direction glyph leading each row (t.dir is Txn's reliable 'out' | 'in' field):
                incoming = arrow-down-left in ok green (matching the credited amount; tangerine stays
                reserved for CTA/active), outgoing = arrow-up-right neutral. The icon renders no
                textContent, so the asserted amounts/memos are untouched. */}
            <View style={S.histDirIcon}>
              {t.dir === 'out' ? <IconArrowUpRight size={16} color={C.sub} /> : <IconArrowDownLeft size={16} color={C.ok} />}
            </View>
            <View style={S.histWhoCol}>
              <Text style={S.histWho}>{t.dir === 'out' ? M.wallet.ledger.to(t.who || '—') : M.wallet.ledger.from(t.who || '—')}</Text>
              {t.memo ? <Text style={S.histMemo} testID={`hist-memo-${i}`}>{t.memo}</Text> : null}
            </View>
            <Text style={[S.histAmt, {color: t.dir === 'out' ? C.ink : C.ok}]}>{`${t.dir === 'out' ? '−' : '+'}${amtTxt}`}</Text>
            {/* testID: the visual flows (40/84) MASK this element — the rendered time is
                inherently time-varying (minute digits + 1↔2-digit hour width), so an unmasked
                diff is a standing flake riding just under the 0.5% tolerance. */}
            <Text style={S.histTime} testID={`hist-time-${i}`}>{t.time}</Text>
          </View>
        );
      })}
    </View>
  );
}
