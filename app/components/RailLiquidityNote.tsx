import {View, Text} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';
import {type SelectableAsset} from '../config/assets';
import {railLiquidity, railLiquidityLine} from '../config/currency';
import {IconAlert} from './icons';

/**
 * The rail-health note — the ONE renderer of the catalog's liquidity statement (EUR dual-rail,
 * Stage 4). Two tones, one per tier, and the tone GATES the tier:
 *
 *   warn — the THIN statement, in the established warnRow idiom (IconAlert + warn-coloured text):
 *          the surface it sits on is a caution, so it may only ever carry the caution line.
 *   pro  — the DEEP statement, a plain sub-line: positive context, no icon, no warning colour.
 *
 * A tone never renders the other tier's line — a warn-coloured "circulates widely" (or an
 * icon-less thin caution) would be a contradiction, so callers pick the intent and the component
 * keeps the pairing honest. Renders null when the catalog makes no statement for the asset at
 * all (`railLiquidity(asset) === null`), which is the common case: SOL, ckBTC, every row the
 * catalog does not tier.
 *
 * ONE testID everywhere (`rail-liquidity-note`) — assertions scope it by its ancestor container
 * (the Balances row, the disclosure side, the chooser's per-rail detail block).
 */
export function RailLiquidityNote({asset, tone}: {asset: SelectableAsset; tone: 'warn' | 'pro'}) {
  const tier = railLiquidity(asset);
  const line = railLiquidityLine(asset);
  if (line === null) return null;
  if (tone === 'pro') {
    if (tier !== 'deep') return null;
    return <Text testID="rail-liquidity-note" style={S.assetSub}>{line}</Text>;
  }
  if (tier !== 'thin') return null;
  return (
    <View testID="rail-liquidity-note" style={S.railHealthRow}>
      <IconAlert size={14} color={C.warn} />
      <Text style={S.railHealthText}>{line}</Text>
    </View>
  );
}
