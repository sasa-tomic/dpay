import {View, Text, Pressable, ActivityIndicator} from 'react-native';
import {S} from '../styles';
import {C} from '../config/palette';
import {M} from '../i18n';

/**
 * The per-currency setup view model (2026-10-01): computed by Wallet (the planner + the run
 * state + the measured minimum) for ONE currency's own view. The old wallet-level banner on
 * the accounts route is gone - the currency the user taps hosts the ONE card.
 */
export type AtaSetupViewModel = {
  /** Every absent account's display symbol, wallet-wide. */
  targets: string[];
  kind: 'create' | 'fund' | 'fund-ic' | 'refuse';
  costLine: string;
  /** The measured up-front minimum ("Needs at least 0.09 VCHF."), when the plan's sizing
   *  probe has landed. Null until then - the exact SOL rent line speaks instead. */
  minLine: string | null;
  fundFromLine: string | null;
  /** A non-terminal convert record is still working toward THIS setup (2026-10-02 P0): the
   *  card renders the LIVE state - progress + honesty copy, NO button - and the money
   *  actions stand down, whatever the run's own busy flag says. */
  live: boolean;
  /** The live progress sentence (the movement with its currency + the creation promise). */
  liveLine: string | null;
  /** The honesty line: the run keeps going, also off this screen. */
  liveNote: string | null;
  confirming: boolean;
  confirmLine: string | null;
  busy: boolean;
  /** Overrides the creating-all busy line while a fund-ic venue swap is still in flight (the
   *  card says so honestly). Null = the default line. */
  busyLine: string | null;
  /** The device's SOL receive address for the refuse panel's copy affordance (null when the
   *  rail is unavailable - the panel then falls back to the deposit-sheet escape). */
  solAddress: string | null;
  err: string | null;
};

/**
 * The ONE-TAP setup card (2026-09-30; per-currency since 2026-10-01) - hosted by the tapped
 * currency's own view (HomeTab), the single setup affordance. One compact card, ONE primary
 * button. Visual grammar: the instruction card (S.instrCard's radius/padding) + the wide
 * primary button; the idle state states the required minimum UP FRONT (the measured min line,
 * else the exact SOL rent) - no number the user has to fail a swap to learn.
 *
 * Five states, driven entirely by props (the parent owns the plan + the run):
 *   live    - a non-terminal convert record is still working toward THIS setup (2026-10-02
 *             P0): the progress line + the honesty copy, NO button, NO idle minimum line.
 *             It outranks EVERY other state - a live record must never be pasted over by
 *             idle (a re-armed button is a second-spend invitation), confirm, busy or refuse.
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
 * and HomeTab.test.tsx. (The live state's actionable next step is the run itself: it keeps
 * going without a press - the honesty line says so, and the record's own panel can stop it.)
 *   idle    - create (SOL covers), fund (a SPL swap pays) or fund-ic (a cross-rail venue swap
 *             pays): the ONE "Complete setup" button. A fund/fund-ic run presses through to
 *             the confirm; create runs straight away (the button itself is the consent, cost
 *             disclosed above - the same contract the per-asset setup card established).
 *
 * All money figures arrive PRE-FORMATTED (the caller owns `fmtAssetCompact` — the i18n rule);
 * `testIDPrefix` keeps parallel cards tellable (`ata-setup-EUR-complete`, `ata-setup-USD-…`).
 */
export function AtaSetupCard({
  targets,
  kind,
  costLine,
  minLine = null,
  fundFromLine = null,
  live = false,
  liveLine = null,
  liveNote = null,
  confirming = false,
  confirmLine = null,
  busy = false,
  busyLine = null,
  err = null,
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
  /** The measured up-front minimum line, when the sizing probe has landed - replaces the
   *  rent line as THE cost line (one line, never two). */
  minLine?: string | null;
  /** The swap card's source line - set only when the funding token is unambiguous. */
  fundFromLine?: string | null;
  /** True while ANY non-terminal convert record intersects the plan's targets: the run
   *  stands, the card must never render idle-with-button (2026-10-02 P0). */
  live?: boolean;
  /** The live progress sentence (the movement + the account-creation promise). */
  liveLine?: string | null;
  /** The honesty line: the run keeps going, also if the user leaves this view. */
  liveNote?: string | null;
  /** True once the parent has sized the swap and is waiting for the confirm press. */
  confirming?: boolean;
  /** The sized confirm sentence (shown while `confirming`). */
  confirmLine?: string | null;
  busy?: boolean;
  /** Overrides the default creating-all line while a fund-ic venue swap is in flight. */
  busyLine?: string | null;
  err?: string | null;
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
  if (live) {
    return (
      <View testID={`${testIDPrefix}-live`} style={S.ataBanner}>
        <ActivityIndicator color={C.brandText} />
        <Text testID={`${testIDPrefix}-live-line`} style={S.dim2}>{liveLine ?? M.deposit.ata.swapPending(targetsPhrase)}</Text>
        <Text testID={`${testIDPrefix}-live-note`} style={S.dim2}>{liveNote ?? M.deposit.ata.liveKeepsRunning}</Text>
        {err ? <Text testID={`${testIDPrefix}-err`} style={S.err}>{err}</Text> : null}
      </View>
    );
  }
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
        <Text testID={`${testIDPrefix}-need-sol`} style={S.warnNote}>{M.deposit.ata.needSol(costLine)}</Text>
        {/* The run's REAL cause (2026-10-02): a refusal reached from a confirm-time failure
            carries its actual message - never a cause-less dead end. */}
        {err ? <Text testID={`${testIDPrefix}-err`} style={S.err}>{err}</Text> : null}
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
  // Idle: the compact banner - one-line summary row (title + cost), the payer line and the
  // ONE button. 2026-10-02 audit: the per-asset 'No X account yet.' prose restated the title
  // line for line - deleted, and with it the never-wired expander machinery.
  return (
    <View testID={`${testIDPrefix}-banner`} style={S.ataBanner}>
      <View style={S.ataBannerRow}>
        <Text style={S.ataBannerTitle}>{M.deposit.ata.finishSetup(targetsPhrase)}</Text>
      </View>
      {/* THE cost line, stated up front: the measured minimum for a swap plan, else the exact
          SOL rent. One line - the founder rule is no number the user must fail a swap to learn. */}
      <Text style={S.ataBannerCost}>{minLine ?? M.deposit.ata.costShort(costLine)}</Text>
      {fundFromLine != null
        ? <Text style={S.ataBannerNote}>{fundFromLine}</Text>
        : kind === 'create' ? <Text style={S.ataBannerNote}>{M.deposit.ata.createSource}</Text> : null}
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
