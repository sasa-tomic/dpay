import {useState} from 'react';
import {View, Text, Pressable} from 'react-native';
import {S} from '../styles';
import {M} from '../i18n';
import {assetTestKey, type CurrencyDescriptor} from '../config/catalog';
import {chipLabel, prettyNetwork, type SelectableAsset} from '../config/assets';
import {HistoryRow} from './HistoryRow';
import type {TxAnnotation} from '../services/txNotes';
import type {AssetId, Txn} from '../lib/types';
import type {SolanaReadFailure} from '../solana';

// The chip's stable testID key, dispatched on rail. An IC row keeps the CATALOG's `assetTestKey`
// (the id the existing selectors are written against); a Solana row uses the SelectableAsset's own
// literal key ('sol' / 'sol-usdc'), which is the only key that rail has. `null` when an IC row's
// descriptor is absent — the same fail-closed "then render no chip" the currency-keyed version had.
function filterTestKey(asset: SelectableAsset, catalog: CurrencyDescriptor[]): string | null {
  if (asset.protocol === 'solana') return asset.testKey;
  if (asset.protocol === 'evm') return asset.testKey;
  const desc = catalog.find(c => c.currency === asset.currency);
  return desc ? assetTestKey(desc) : null;
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
//
// `dropped` (optional, default 0): how many Solana transactions the reader could not parse. When
// non-zero, the honesty note `M.wallet.ledger.dropped` renders in BOTH branches (empty list and
// populated) — the unreadable transactions still exist on-chain, and a short (or empty) list must
// never read as the whole truth. Nothing renders when it is 0.
//
// `staleFailure` (optional, default null): why the LAST Solana history poll produced no fact
// (`SolanaReadFailure`, classified at the seam — `useSolanaHistory.failure`). When set, the rows
// shown are the last known truth and the `sol-history-stale` line says so (R3, spec 2026-09-09
// §"What the app says…": no cached value presented as current). Null (and the rail-off 'offline'
// case, which never sets it) renders nothing — the note is purely conditional, like `dropped`.
export function Ledger({history, catalog, assets, dropped = 0, staleFailure = null, noteFor, onOpenReceipt}: {history: Txn[]; catalog: CurrencyDescriptor[]; assets: SelectableAsset[]; dropped?: number; staleFailure?: SolanaReadFailure | null; /** Resolve a row's device-saved annotation (txNotes name/message + saved-address label). Optional and purely additive — without it rows render exactly as the ledger said them. */ noteFor?: (t: Txn) => TxAnnotation | undefined; onOpenReceipt: (t: Txn) => void}) {
  const [filter, setFilter] = useState<AssetId | null>(null);
  if (history.length === 0) {
    return (
      <View testID="ledger-view">
        <Text style={S.ledgerEmpty}>{M.wallet.ledger.empty}</Text>
        <Text style={S.dim2}>{M.wallet.ledger.emptyHint}</Text>
        {dropped > 0 ? (
          <Text style={S.dim2} testID="ledger-dropped-note">{M.wallet.ledger.dropped(dropped)}</Text>
        ) : null}
        {staleFailure != null ? (
          <Text style={S.dim2} testID="sol-history-stale">{M.errors.rail.historyStale(prettyNetwork('solana'))}</Text>
        ) : null}
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
      {dropped > 0 ? (
        <Text style={S.dim2} testID="ledger-dropped-note">{M.wallet.ledger.dropped(dropped)}</Text>
      ) : null}
      {staleFailure != null ? (
        <Text style={S.dim2} testID="sol-history-stale">{M.errors.rail.historyStale(prettyNetwork('solana'))}</Text>
      ) : null}
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
      {rows.map((t, i) => (
        // IC-rail rows carry an EMPTY nonce (memo is the reconciliation key), so the raw nonce
        // alone is no longer unique (mint + transfer rows collide). Composite key: index pins
        // positional identity; the nonce keeps facade-era rows (which had unique nonces) stable
        // across refreshes when the list head shifts.
        <HistoryRow key={`${i}-${t.nonce}`} t={t} i={i} catalog={catalog} assets={assets} note={noteFor?.(t)} onPress={onOpenReceipt} />
      ))}
    </View>
  );
}
