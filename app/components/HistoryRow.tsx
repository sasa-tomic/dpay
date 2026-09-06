import {View, Text} from 'react-native';
import {S} from '../styles';
import {M} from '../i18n';
import {C} from '../config/palette';
import {fmtCurrencyAmountCompact, type CurrencyDescriptor} from '../config/catalog';
import {type SelectableAsset} from '../config/assets';
import {fmtAssetCompact} from '../lib/format';
import {IconArrowDownLeft, IconArrowUpRight} from './icons';
import type {Txn} from '../lib/types';

// One row's amount in the row's OWN units, dispatched on rail. History is a glanceable surface, so
// both rails use the COMPACT formatter (trailing zeros trimmed to the asset's floor; "≈"/"<" when a
// display cap hides value) — the exact string stays on the surfaces where money is committed. An IC
// row goes through `fmtCurrencyAmountCompact` (DEMO's `∂` early-return lives inside it, and it
// fail-closes to the explicit "Unsupported" sentinel for an unknown family — never a wrong
// "… BTC"); a Solana row formats at its SelectableAsset's `decimals` + `symbol` + compact floor,
// the only place those facts exist for that rail. A row
// whose asset is not in the visible list (a testnet asset hidden mid-poll, a disabled rail) fails
// closed to the SAME sentinel rather than guessing a unit.
export function fmtRowAmount(t: Txn, catalog: CurrencyDescriptor[], assets: SelectableAsset[]): string {
  const asset = assets.find(a => a.id === t.assetId);
  if (!asset) return M.wallet.asset.unsupported;
  // The direction sign goes THROUGH the formatter (never concatenated here) so it lands inside a
  // truncation marker — "≈ −0.039922 ETH", not "−≈ 0.039922 ETH". See fmtAssetCompact.
  const sign = t.dir === 'out' ? '−' : '+';
  return asset.protocol === 'ic'
    ? fmtCurrencyAmountCompact(catalog, asset.currency, t.amount, sign)
    : fmtAssetCompact(t.amount, asset.decimals, asset.symbol, undefined, asset.minFractionDigits, sign);
}

// One transaction row — the shared renderer extracted verbatim from Ledger's list map so the Home
// tab's inline activity feed renders the IDENTICAL row grammar (direction glyph, counterparty,
// own-unit amount, time). The rendered output for the Ledger is byte-stable: `testPrefix` defaults
// to the Ledger's historical 'hist' testID namespace, and a second surface (the Home activity feed)
// passes its own ('home-hist') instead of the two sharing selectors — e2e anchors stay per-surface.
export function HistoryRow({t, i, catalog, assets, testPrefix = 'hist'}: {t: Txn; i: number; catalog: CurrencyDescriptor[]; assets: SelectableAsset[]; testPrefix?: string}) {
  const amtTxt = fmtRowAmount(t, catalog, assets);
  return (
    <View style={S.histRow}>
      {/* P4 — direction glyph leading each row (t.dir is Txn's reliable 'out' | 'in' field):
          incoming = arrow-down-left in ok green (matching the credited amount; tangerine stays
          reserved for CTA/active), outgoing = arrow-up-right neutral. The icon renders no
          textContent, so the asserted amounts/memos are untouched. */}
      <View style={S.histDirIcon}>
        {t.dir === 'out' ? <IconArrowUpRight size={16} color={C.sub} /> : <IconArrowDownLeft size={16} color={C.ok} />}
      </View>
      <View style={S.histWhoCol}>
        <Text style={S.histWho}>{t.dir === 'out' ? M.wallet.ledger.to(t.who || '—') : M.wallet.ledger.from(t.who || '—')}</Text>
        {t.memo ? <Text style={S.histMemo} testID={`${testPrefix}-memo-${i}`}>{t.memo}</Text> : null}
      </View>
      <Text style={[S.histAmt, {color: t.dir === 'out' ? C.ink : C.ok}]}>{amtTxt}</Text>
      {/* testID: the visual flows (40/84) MASK this element on the Ledger — the rendered time is
          inherently time-varying (minute digits + 1↔2-digit hour width), so an unmasked
          diff is a standing flake riding just under the 0.5% tolerance. */}
      <Text style={S.histTime} testID={`${testPrefix}-time-${i}`}>{t.time}</Text>
    </View>
  );
}
