import {Text, View} from 'react-native';
import {S} from '../styles';
import {C} from '../config/palette';
import {M} from '../i18n';
import {linkNetworkOf, prettyNetwork, type SelectableAsset} from '../config/assets';
import {IconAlert} from './icons';
import type {BalanceView} from '../lib/assetBalances';

/**
 * "This rail's endpoint is not answering" — ONE renderer, for a fact stated ONCE PER NETWORK.
 *
 * The state it names is `BalanceView.status === 'error'`: the chain's endpoint refused or served
 * bytes that could not be read (the measured 2026-09-08 case is an exhausted RPC key answering
 * HTTP 429). Before this existed the surface rendered the same bare "—" a first poll in flight
 * shows, so the user could not tell "still loading" from "this rail is unreadable right now" —
 * and got no instruction at all on the error path (founder rule 2026-08-29).
 *
 * It promises NO button on purpose: the balance poll already re-reads on its own, and against a
 * rate limit an extra manual read is the cause rather than the cure. The copy owns that argument
 * (`M.errors.rail.unreadable`); this file owns only the placement.
 *
 * WHY IT IS A COMPONENT AND NOT TWO COPIES: it renders on the accounts route (once for the
 * network, above the first affected row) AND on the Home headline (for the home rail alone) — the
 * landing screen showed the bare dash with no status branch at all until 2026-09-08. Two hand-made
 * copies of one sentence is precisely the drift this codebase keeps paying for.
 *
 * The network is the SETTLEMENT chain (`linkNetworkOf`), never the catalog's `network` column —
 * the same rule the deposit instructions follow, because an outage belongs to the chain the read
 * actually goes to.
 */
export function RailUnreadableNote({asset}: {asset: SelectableAsset}) {
  const slug = linkNetworkOf(asset);
  return (
    <View testID={`rail-unreadable-${slug}`} style={S.railOutageRow}>
      <IconAlert size={14} color={C.warn} />
      <Text style={S.railHealthText}>{M.errors.rail.unreadable(prettyNetwork(slug))}</Text>
    </View>
  );
}

/** Whether a balance is UNREADABLE (as opposed to zero, or not read yet). The single predicate
 *  both callers branch on, so a status rename can never leave one surface behind. */
export function railUnreadable(view: BalanceView | undefined): boolean {
  return view?.status === 'error';
}
