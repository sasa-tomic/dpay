// Phase 4 — the ONE reusable asset picker (2026-08-12 unified asset selection rewrite).
//
// Replaces BOTH ReceiveMode's local `CurrencyPicker` and SolReceiveMode's binary SOL/USDC toggle.
// Every Receive amount-prefix opens THIS Modal; selecting any row fires the SAME Wallet-owned
// `onSelect(id)` callback. There is no `onSelectSol`, no rail prop, no binary toggle — SOL is just
// another row, and selecting it unmounts the current Receive form via Wallet's `selectedAssetId`
// dispatch (same mechanism as today's rail switch, but through ONE callback).
//
// The picker is a PURE renderer over the `SelectableAsset[]` + `BalanceView` map Wallet already
// builds. It owns NO state: `open`/`onClose` are caller-owned (the prefix button + Esc/backdrop),
// `selectedId` is Wallet's `effectiveSelectedId`, `onSelect` is Wallet's `handleSelect`. The testID
// contract preserves the e2e net byte-for-byte:
//   • variant='plain' (the default Modal picker): `<Pressable testID="req-pick-<testKey>">` per row.
//   • variant='card' (Balances-style): `<View testID="asset-<testKey>">` per row.
// `req-pick-sol` / `req-pick-sol-usdc` / `req-pick-ckbtc` etc. continue to resolve every Receive
// flow that filters by those IDs (63 picker-sol-rail, 69 sol-usdc-selection).
//
// `title` defaults "Receive in" (the picker copy the e2e net reads on the Receive prefix path).
//
// ── It is the accounts list, so it looks like the accounts list (UX swarm 2026-09-08) ───────────
// This picker and the accounts route render the same set of accounts, and they used to disagree
// about both of the things a list of accounts is for. The picker showed NO balances — so a
// merchant chose which asset to be paid in without being able to see what they held — and it
// listed them in raw catalog order while the route applied a stated policy. Two lists of one set,
// disagreeing, is the UI form of the DRY violation.
//
// Both are now fixed at the source: amounts always render, and the order comes from
// `orderAccounts` — the SAME exported policy function the per-rail lists use, so the two cannot
// drift. The `showAmount` and `variant` props that used to make this configurable are gone: no
// caller passed either, and a configurable answer to "should a list of money show the money" is
// how the two lists diverged in the first place.
import {Modal, Pressable, ScrollView, View, Text} from 'react-native';
import {S} from '../styles';
import {CurrencyRow} from './CurrencyRow';
import {useEscapeToClose} from '../hooks/useHotkeys';
import {DEMO_ASSET_ID, type SelectableAsset} from '../config/assets';
import {type BalanceView} from '../lib/assetBalances';
import {currencyOfAsset, preferredRail, type HomeCurrency} from '../config/currency';
import type {AssetId} from '../lib/types';
import {M} from '../i18n';

/**
 * X22 — the ASSET PICKER's order policy (moved here 2026-09-24: the accounts route became the
 * currency list and its per-rail order policy now lives with its only consumer — the per-rail
 * picker inside Pay/Receive). PURE and exported so it is testable without a renderer: the point
 * of the function is that it is a stated policy rather than whatever order the catalog happened
 * to have. Four buckets: the main currency's rails (preferred first), then funded accounts, then
 * unfunded, then the practice rail. Every input asset appears exactly once.
 */
export function orderAccounts(
  assets: SelectableAsset[],
  balances: Readonly<Partial<Record<AssetId, BalanceView>>>,
  homeCurrency: HomeCurrency,
): SelectableAsset[] {
  const homeRails = preferredRail(homeCurrency, assets) === null
    ? []
    : assets.filter(a => currencyOfAsset(a) === homeCurrency);
  // Preferred rail first inside the home group; the rest keep catalog order.
  const mainId = preferredRail(homeCurrency, assets)?.id ?? null;
  const home = [...homeRails].sort((a, b) => (a.id === mainId ? -1 : 0) - (b.id === mainId ? -1 : 0));
  const rest = assets.filter(a => !homeRails.includes(a) && a.id !== DEMO_ASSET_ID);
  const holds = (a: SelectableAsset) => balances[a.id]?.status === 'ok';
  const practice = assets.filter(a => a.id === DEMO_ASSET_ID);
  return [...home, ...rest.filter(holds), ...rest.filter(a => !holds(a)), ...practice];
}

export type AssetPickerProps = {
  open: boolean;
  assets: SelectableAsset[];
  selectedId: AssetId | null;
  balances?: Record<AssetId, BalanceView>;
  /** Orders the rows the way the accounts route does (home currency's rails first, then accounts
   *  that hold something, then the rest, practice money last). Null only where the wallet has no
   *  home currency yet, in which case catalog order is the honest answer — there is no "your"
   *  currency to put first. */
  homeCurrency?: HomeCurrency | null;
  onSelect: (id: AssetId) => void;
  onClose: () => void;
  title?: string;            // default "Receive in" (the picker copy)
};

/**
 * AssetPicker — the unified selection Modal. Renders every `SelectableAsset` as a `CurrencyRow`.
 * Selecting any row calls `onSelect(asset.id)` THEN `onClose()` — the caller (Wallet) dispatches
 * the selection (re-derives + re-mounts the right Receive form), and the Modal closes. NO local
 * selection state; NO SOL special-case branch.
 */
export function AssetPicker({open, assets, selectedId, balances, homeCurrency = null, onSelect, onClose, title = M.receive.receiveInTitle}: AssetPickerProps) {
  const ordered = homeCurrency === null ? assets : orderAccounts(assets, balances ?? {}, homeCurrency);
  // Esc closes the Modal (the same affordance every sheet uses). The backdrop Pressable below
  // handles a tap-outside-to-close; Esc covers the web keyboard path.
  useEscapeToClose(onClose);
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={S.pickBackdrop} onPress={onClose}>
        {/* The backdrop Pressable closes on a tap outside the card; a tap inside any row fires that
            row's own onPress (onSelect + onClose). RN's touch responder system routes a touch to the
            INNERMOST Pressable, so a row tap does NOT also trigger the backdrop's onClose. */}
        <View style={S.pickCard}>
          <Text style={S.pickTitle}>{title}</Text>
          {/* Bounded scroller (S.pickScroll) — a Modal has no scroll surface, so a long catalog
              would push the bottom rows off a small screen with no way to reach them. */}
          <ScrollView style={S.pickScroll}>
            {ordered.map(asset => {
              const view = balances?.[asset.id];
              return (
                <CurrencyRow
                  key={asset.testKey}
                  testId={`req-pick-${asset.testKey}`}
                  asset={asset}
                  amount={view?.displayText}
                  active={asset.id === selectedId}
                  zero={view ? view.status !== 'ok' : undefined}
                  onPress={() => { onSelect(asset.id); onClose(); }}
                  accessibilityLabel={M.receive.receiveIn(asset.symbol)}
                  accessibilityHint={asset.protocol === 'solana' ? M.receive.switchToRail(asset.symbol) : M.receive.receiveIn(asset.networkLabel)}
                  variant="plain"
                />
              );
            })}
          </ScrollView>
        </View>
      </Pressable>
    </Modal>
  );
}
