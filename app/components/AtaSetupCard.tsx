import {View, Text, Pressable, ActivityIndicator} from 'react-native';
import {S} from '../styles';
import {C} from '../config/palette';
import {M} from '../i18n';

/**
 * The wallet-level ONE-TAP setup card (2026-09-30, banner redesign) - the AccountsTab's SINGLE
 * setup affordance, rendered above the currency list. One compact card, ONE primary button:
 * the per-row setup buttons are gone, so the "Needs setup" badge and this card can never state
 * the setup twice. Visual grammar: the instruction card (S.instrCard's radius/padding) + the
 * wide primary button; a one-line summary row by default, the per-asset detail lines when
 * expanded.
 *
 * Four states, driven entirely by props (the parent owns the plan + the run):
 *   busy    - the run is on chain: spinner + one honest line (what is being created, or the
 *             still-in-flight venue swap when the parent says so via `busyLine`).
 *   confirm - a swap run's ONE confirmation, stating the total: the sized swap, its source,
 *             what it creates, what it costs. Confirm executes; cancel returns.
 *   refuse  - the honest dead end: what is missing, what it costs, the needSol copy and the
 *             device's SOL receive address with a copy affordance (the deposit-sheet escape
 *             when the parent cannot show one). NO button - never a fake one.
 *
 * HARD RULE (2026-09-30 defect, never again): every rendered state carries an ACTIONABLE next
 * step. The v1 card shipped a refuse state that ONLY explained steps with no affordance at all
 * (and the idle button above it stayed a doomed retry). Refuse must always render one of its
 * two escapes below; idle/confirm/busy own the ONE button. Pinned by AtaSetupCard.test.tsx
 * (the refuse describes) and HomeAccounts.test.tsx (banner-is-the-ONE-affordance describes).
 *   idle    - create (SOL covers), fund (a SPL swap pays) or fund-ic (a cross-rail venue swap
 *             pays): the ONE "Complete setup" button. A fund/fund-ic run presses through to
 *             the confirm; create runs straight away (the button itself is the consent, cost
 *             disclosed above - the same contract the per-asset setup card established).
 *
 * All money figures arrive PRE-FORMATTED (the caller owns `fmtAssetCompact` — the i18n rule);
 * `testIDPrefix` keeps parallel cards tellable (`ata-setup-EUR-complete`, …).
 */
export function AtaSetupCard({
  targets,
  kind,
  costLine,
  fundFromLine = null,
  confirming = false,
  confirmLine = null,
  busy = false,
  busyLine = null,
  err = null,
  expanded = true,
  onToggleExpanded,
  solAddress = null,
  solCopied = false,
  onStart,
  onConfirm,
  onCancel,
  onCopySolAddress,
  onShowSolAddress,
  testIDPrefix,
}: {
  /** Every absent account's display symbol, wallet-wide ('EURC' / ['EURC', 'USDC']). */
  targets: string[];
  /** The planner's verdict for THIS wallet: create (no swap) | fund (a SPL swap pays) |
   *  fund-ic (a cross-rail venue swap pays) | refuse. */
  kind: 'create' | 'fund' | 'fund-ic' | 'refuse';
  /** The already-formatted SOL total the setup costs ("0.00204428 SOL"). */
  costLine: string;
  /** The swap card's source line - set only when the funding token is unambiguous. */
  fundFromLine?: string | null;
  /** True once the parent has sized the swap and is waiting for the confirm press. */
  confirming?: boolean;
  /** The sized confirm sentence (shown while `confirming`). */
  confirmLine?: string | null;
  busy?: boolean;
  /** Overrides the default creating-all line while a fund-ic venue swap is in flight. */
  busyLine?: string | null;
  err?: string | null;
  /** Expanded shows the per-asset detail lines under the summary row (the auto-surface sets
   *  it once per session; tapping the summary row toggles). */
  expanded?: boolean;
  onToggleExpanded?: () => void;
  /** The refuse panel's receive address (the device's SOL address, when the parent has it). */
  solAddress?: string | null;
  /** True for the beat after the copy tap - the button says so. */
  solCopied?: boolean;
  onStart?: () => void;
  onConfirm?: () => void;
  onCancel?: () => void;
  onCopySolAddress?: () => void;
  /** The refuse escape when no address can be shown inline: open the deposit sheet. */
  onShowSolAddress?: () => void;
  testIDPrefix: string;
}) {
  const targetsPhrase = M.deposit.ata.targetsLabel(targets);
  if (busy) {
    return (
      <View testID={`${testIDPrefix}-busy`} style={S.ataBanner}>
        <ActivityIndicator color={C.brandText} />
        <Text style={S.dim2}>{busyLine ?? M.deposit.ata.creatingAll(targetsPhrase)}</Text>
      </View>
    );
  }
  if (confirming) {
    return (
      <View testID={`${testIDPrefix}-confirm`} style={S.reviewCard}>
        <Text testID={`${testIDPrefix}-confirm-line`} style={S.reviewLabel}>{confirmLine}</Text>
        <Pressable
          testID={`${testIDPrefix}-confirm-btn`}
          style={S.primaryWide}
          onPress={onConfirm}
          accessibilityRole="button"
          accessibilityLabel={M.deposit.ata.confirmAction}
          accessibilityState={{disabled: false}}>
          <Text style={S.primaryText}>{M.deposit.ata.confirmAction}</Text>
        </Pressable>
        <Pressable
          testID={`${testIDPrefix}-cancel-btn`}
          style={S.linkBtn}
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel={M.deposit.ata.cancelAction}>
          <Text style={S.linkText}>{M.deposit.ata.cancelAction}</Text>
        </Pressable>
      </View>
    );
  }
  if (kind === 'refuse') {
    // Regression guard: this branch must NEVER render explains-only. One of the two escapes
    // below (inline address + copy, or the parent's show-sol deposit escape) is load-bearing;
    // the production parent (Wallet) always passes onShowSolAddress, so the trailing null is
    // unreachable there - if both props are ever missing, fix the parent, not this branch.
    return (
      <View testID={`${testIDPrefix}-refuse`} style={S.ataBanner}>
        {targets.map(t => (
          <Text key={t} style={S.ataBannerLine}>{M.deposit.ata.absent(t)}</Text>
        ))}
        <Text testID={`${testIDPrefix}-need-sol`} style={S.warnNote}>{M.deposit.ata.needSol(costLine)}</Text>
        {solAddress != null && onCopySolAddress != null ? (
          <View testID={`${testIDPrefix}-sol-addr`} style={S.ataAddrRow}>
            <Text style={S.ataAddrText}>{solAddress}</Text>
            <Pressable
              testID={`${testIDPrefix}-copy-sol`}
              style={S.linkBtn}
              onPress={onCopySolAddress}
              accessibilityRole="button"
              accessibilityLabel={solCopied ? M.deposit.copied : M.deposit.copyAddress}
              accessibilityState={{disabled: false}}>
              <Text style={S.linkText}>{solCopied ? M.deposit.copied : M.deposit.copyAddress}</Text>
            </Pressable>
          </View>
        ) : onShowSolAddress ? (
          <Pressable
            testID={`${testIDPrefix}-show-sol`}
            style={S.linkBtn}
            onPress={onShowSolAddress}
            accessibilityRole="button"
            accessibilityLabel={M.deposit.ata.showSolAddress}>
            <Text style={S.linkText}>{M.deposit.ata.showSolAddress}</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }
  // Idle: the compact banner - one-line summary row (title + cost) and the ONE button. The
  // summary row expands to the per-asset detail lines (toggled by tap, auto-set once per
  // session by the parent's refuse-to-actionable auto-surface).
  return (
    <View testID={`${testIDPrefix}-banner`} style={S.ataBanner}>
      {onToggleExpanded != null ? (
        <Pressable
          testID={`${testIDPrefix}-summary`}
          style={S.ataBannerRow}
          onPress={onToggleExpanded}
          accessibilityRole="button"
          accessibilityLabel={M.deposit.ata.finishSetup(M.deposit.ata.targetsLabel(targets))}
          accessibilityState={{disabled: false}}>
          <Text style={S.ataBannerTitle}>{M.deposit.ata.finishSetup(targetsPhrase)}</Text>
        </Pressable>
      ) : (
        <View style={S.ataBannerRow}>
          <Text style={S.ataBannerTitle}>{M.deposit.ata.finishSetup(targetsPhrase)}</Text>
        </View>
      )}
      <Text style={S.ataBannerCost}>{M.deposit.ata.costShort(costLine)}</Text>
      {expanded ? targets.map(t => (
        <Text key={t} style={S.ataBannerLine}>{M.deposit.ata.absent(t)}</Text>
      )) : null}
      {fundFromLine != null ? <Text style={S.ataBannerNote}>{fundFromLine}</Text> : null}
      <Pressable
        testID={`${testIDPrefix}-complete`}
        style={S.primaryWide}
        onPress={onStart}
        accessibilityRole="button"
        accessibilityLabel={M.deposit.ata.completeSetup}
        accessibilityHint={M.deposit.ata.completeHint(costLine)}
        accessibilityState={{disabled: false}}>
        <Text style={S.primaryText}>{M.deposit.ata.completeSetup}</Text>
      </Pressable>
      {err ? <Text testID={`${testIDPrefix}-err`} style={S.err}>{err}</Text> : null}
    </View>
  );
}
