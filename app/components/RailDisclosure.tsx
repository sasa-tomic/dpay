import {View, Text, type TextStyle} from 'react-native';
import {S} from '../styles';
import {M} from '../i18n';
import {ModeToggle} from './ModeToggle';
import {RailLiquidityNote} from './RailLiquidityNote';
import {type SelectableAsset, linkNetworkOf, prettyNetwork} from '../config/assets';
import {type CurrencyDescriptor} from '../config/catalog';
import {type HomeCurrency, chooseRail, currencyRails, railFees, railLineLabel, type RailBalances} from '../config/currency';
import type {AssetId} from '../lib/types';

const disclosureLine: TextStyle = {marginTop: 2, textAlign: 'center'};

/**
 * The home-currency rail disclosure for Receive ▸ "My address" (Objective 2,
 * docs/specs/2026-09-04-currency-first-wallet-plan.md). A multi-rail home currency shows the
 * wallet's rail PICK and WHY (the chooser's `railWithReason` vocabulary when the shown rail is the
 * pick, the bare rail line otherwise), the rail's FEE FACT in that rail's own unit — never
 * converted, never merged with the sibling's — and a two-sided toggle that flips to the sibling
 * rail's own address surface. THE SAME COMPONENT serves both engines (ReceiveMode for IC rails,
 * SolReceiveMode for Solana rails), which is what guarantees the same toggle shape on both rails.
 *
 * Renders NOTHING (null) unless the group has exactly two rails AND the current selection is one
 * of them — so single-rail currencies (CHF today) and foreign-currency selections render exactly
 * as before. The flip itself is the owner's `onSwitch` (Wallet's receiveRailSelect), which keeps
 * the "My address" sub-mode mounted; it is NOT the Balances row selection, which resets sub-modes.
 */
export function RailDisclosure({currency, assets, balances, catalog, selectedAssetId, onSwitch}: {
  currency: HomeCurrency;
  assets: SelectableAsset[];
  balances: RailBalances;
  catalog: CurrencyDescriptor[];
  selectedAssetId: AssetId | null;
  onSwitch: (id: AssetId) => void;
}) {
  const rails = currencyRails(currency, assets);
  if (rails.length !== 2) return null;
  const shown = rails.find(r => r.id === selectedAssetId) ?? null;
  if (shown == null) return null;
  // The WHY: the chooser's own line — reason attached when the shown rail IS the wallet's pick AND
  // that reason is an actionable one (docs/specs/2026-09-07-ux-decisions.md); bare rail line
  // otherwise (the same vocabulary HomeCurrencyChooser uses).
  const choice = chooseRail(currency, assets, balances);
  const why = choice != null && choice.rail.id === shown.id && choice.reason !== 'preference'
    ? M.wallet.homeCurrency.railWithReason(railLineLabel(shown), M.wallet.homeCurrency.railReason[choice.reason])
    : railLineLabel(shown);
  // The FEE FACT: the shown rail's own per-transfer fee, plus its one-time cost when it has one
  // (Solana USDC's token-account rent). A fee the catalog cannot state is "unknown", never "free".
  const fees = railFees(shown, catalog);
  const network = prettyNetwork(linkNetworkOf(shown));
  const fee = fees.perTransfer == null
    ? M.receive.rail.feeUnknown(network)
    : fees.oneTime != null
      ? M.receive.rail.feeWithOneTime(network, fees.perTransfer.formatted, fees.oneTime.formatted)
      : M.receive.rail.feeLine(network, fees.perTransfer.formatted);
  return (
    <View testID="receive-rail-disclosure">
      <Text testID="receive-rail-why" style={[S.assetSub, disclosureLine]}>{why}</Text>
      <Text testID="receive-rail-fee" style={[S.assetSub, disclosureLine]}>{fee}</Text>
      {/* Third line: the SHOWN rail's liquidity statement — warn tone, so it renders exactly on
          a thin rail and says nothing on the deep side (a caution icon on "circulates
          widely" would contradict itself). Same component as Balances/chooser detail → one voice. */}
      <RailLiquidityNote asset={shown} tone="warn" />
      <ModeToggle
        testID="receive-rail-toggle"
        value={shown.id}
        onChange={id => onSwitch(id as AssetId)}
        left={{label: prettyNetwork(linkNetworkOf(rails[0])), value: rails[0].id, testID: 'btn-receive-rail-left'}}
        right={{label: prettyNetwork(linkNetworkOf(rails[1])), value: rails[1].id, testID: 'btn-receive-rail-right'}}
      />
    </View>
  );
}
