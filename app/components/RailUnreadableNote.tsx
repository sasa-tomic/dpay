import {Pressable, Text, View} from 'react-native';
import {S} from '../styles';
import {C} from '../config/palette';
import {M} from '../i18n';
import {linkNetworkOf, prettyNetwork, type SelectableAsset} from '../config/assets';
import {IconAlert, IconChevronDown} from './icons';
import type {BalanceView} from '../lib/assetBalances';
import type {SolanaReadFailure} from '../solana';

/**
 * "This rail could not be read" — ONE renderer, for a fact stated ONCE PER NETWORK.
 *
 * The state it names is `BalanceView.status === 'error'`, and since R3 (spec
 * 2026-09-09-relay-ha-and-solana-proxy §"What the app says…") the CAUSE picks the sentence —
 * classified at the transport seam (`SolanaReadFailure`), never guessed here:
 *   - `refused`     the endpoint ANSWERED and did not serve us (HTTP 429, RPC error) — the rail
 *                   is down, this phone is online;
 *   - `offline`     nothing answered anywhere, the IC boundary probe included — this phone has
 *                   no connectivity, and no one is named as the cause, because the wallet cannot
 *                   see that far. NO-ONE'S-FAULT CHROME: this one renders in the NEUTRAL register
 *                   (`C.sub` text + icon), not the alarm register — an airplane-mode phone is the
 *                   payer's designed state, not a warning;
 *   - `unreachable` the rail's path is down while the phone IS online (the IC boundary answered)
 *                   — the service side; the copy says what still works (IC payments go straight to
 *                   icp-api.io; payments can still be SIGNED offline) and names the Settings ▸
 *                   Advanced escape, which points the wallet at any Solana endpoint and removes
 *                   dpay's choice from the path. When `onOpenSettings` is provided (founder UX
 *                   directive), that escape is ACTIONABLE: the row becomes a Pressable that opens
 *                   Settings — the ONE exception to the no-button rule below, and only for this
 *                   cause (Settings fixes an endpoint choice; it fixes neither a rate limit nor
 *                   a phone with no connectivity);
 *   - `unreadable`  the endpoint answered with bytes that could not be trusted.
 * Before this existed the surface rendered the same bare "—" a first poll in flight shows, so the
 * user could not tell "still loading" from "this rail is unreadable right now" — and got no
 * instruction at all on the error path (founder rule 2026-08-29).
 *
 * It promises NO RETRY on purpose: the balance poll already re-reads on its own, and against a
 * rate limit an extra manual read is the cause rather than the cure. The copy owns that argument;
 * this file owns only the placement. (The unreachable Pressable is navigation, not a retry.)
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
export function RailUnreadableNote({asset, failure, onOpenSettings}: {
  asset: SelectableAsset;
  failure?: SolanaReadFailure | null;
  /** Opens Settings — wired ONLY to the unreachable cause's Settings ▸ Advanced escape. Optional
   *  so every existing caller (and the note's own tests) mount unchanged; the row stays a plain
   *  fact without it. */
  onOpenSettings?: () => void;
}) {
  const slug = linkNetworkOf(asset);
  const net = prettyNetwork(slug);
  const text =
    failure === 'refused' ? M.errors.rail.refused(net)
    : failure === 'offline' ? M.errors.rail.offline(net)
    : failure === 'unreachable' ? M.errors.rail.unreachable(net)
    : M.errors.rail.unreadable(net);
  // 'offline' is no one's fault — neutral register, not the alarm register.
  const neutral = failure === 'offline';
  const content = (
    <>
      <IconAlert size={14} color={neutral ? C.sub : C.warn} />
      <Text accessibilityLiveRegion="polite" style={neutral ? [S.railHealthText, {color: C.sub}] : S.railHealthText}>{text}</Text>
    </>
  );
  // The tappable escape: ONLY unreachable, ONLY when the caller wired it. The testID stays on the
  // OUTERMOST element either way — the e2e/first-level selectors must not care which.
  if (onOpenSettings != null && failure === 'unreachable') {
    return (
      <Pressable
        testID={`rail-unreadable-${slug}`}
        onPress={onOpenSettings}
        accessibilityRole="button"
        accessibilityLabel={text}
        accessibilityHint={M.errors.rail.unreachableHint(net)}
      >
        <View style={S.railOutageRow}>
          {content}
          <View style={{transform: [{rotate: '-90deg'}]}}>
            <IconChevronDown size={12} color={C.warn} />
          </View>
        </View>
      </Pressable>
    );
  }
  return (
    <View testID={`rail-unreadable-${slug}`} style={S.railOutageRow}>
      {content}
    </View>
  );
}

/** Whether a balance is UNREADABLE (as opposed to zero, or not read yet). The single predicate
 *  both callers branch on, so a status rename can never leave one surface behind. */
export function railUnreadable(view: BalanceView | undefined): boolean {
  return view?.status === 'error';
}
