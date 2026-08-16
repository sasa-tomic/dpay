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
// `showAmount` defaults false (the picker is a selector, not a balance list); Balances passes true.
// `title` defaults "Receive in" (the picker copy the e2e net reads on the Receive prefix path).
import {Modal, Pressable, View, Text} from 'react-native';
import {S} from '../styles';
import {CurrencyRow} from './CurrencyRow';
import {useEscapeToClose} from '../hooks/useHotkeys';
import {type SelectableAsset} from '../config/assets';
import {type BalanceView} from '../lib/assetBalances';
import type {AssetId} from '../lib/types';

export type AssetPickerProps = {
  open: boolean;
  assets: SelectableAsset[];
  selectedId: AssetId | null;
  balances?: Record<AssetId, BalanceView>;
  onSelect: (id: AssetId) => void;
  onClose: () => void;
  title?: string;            // default "Receive in" (the picker copy)
  showAmount?: boolean;      // default false (omit amounts; picker is a selector)
  variant?: 'plain' | 'card'; // default 'plain' (the Modal picker); 'card' for Balances-style rows
};

/**
 * AssetPicker — the unified selection Modal. Renders every `SelectableAsset` as a `CurrencyRow`.
 * Selecting any row calls `onSelect(asset.id)` THEN `onClose()` — the caller (Wallet) dispatches
 * the selection (re-derives + re-mounts the right Receive form), and the Modal closes. NO local
 * selection state; NO SOL special-case branch.
 */
export function AssetPicker({open, assets, selectedId, balances, onSelect, onClose, title = 'Receive in', showAmount = false, variant = 'plain'}: AssetPickerProps) {
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
          {assets.map(asset => {
            const view = balances?.[asset.id];
            const testId = variant === 'card' ? `asset-${asset.testKey}` : `req-pick-${asset.testKey}`;
            return (
              <CurrencyRow
                key={asset.testKey}
                testId={testId}
                asset={asset}
                amount={showAmount ? view?.displayText : undefined}
                active={asset.id === selectedId}
                zero={view ? view.status !== 'ok' : undefined}
                onPress={() => { onSelect(asset.id); onClose(); }}
                accessibilityLabel={`Receive in ${asset.symbol}`}
                accessibilityHint={asset.protocol === 'solana' ? `Switch to the ${asset.symbol} rail` : `Receive in ${asset.networkLabel}`}
                variant={variant}
              />
            );
          })}
        </View>
      </Pressable>
    </Modal>
  );
}
