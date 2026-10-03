import {View, Text, Pressable, ActivityIndicator} from 'react-native';
import {S} from '../styles';
import {C} from '../config/palette';
import {M} from '../i18n';
import {isSolanaDevnet} from '../config/constants';
import {fmtAssetCompact} from '../lib/format';
import {SOL_DECIMALS, SOL_UNIT} from '../solana/identity';
import {SOL_ATA_SETUP_MIN_LAMPORTS} from '../solana/spl';
import {IconAlert} from './icons';

/**
 * THE one-tap ATA setup card - ONE implementation for both surfaces (2026-10-01 audit: the
 * per-asset SolanaAtaSetupCard was a second, drifting copy; merged here, prop-driven, each
 * surface selected by `surface`):
 *
 *   surface='plan'    the wallet-level planner card (2026-09-30; per-currency since
 *                     2026-10-01) - hosted by the tapped currency's own view (HomeTab), the
 *                     single setup affordance. One compact card, ONE primary button.
 *   surface='create'  the per-asset create card - the shared surface for every place the
 *                     device's token account for a registered SPL token is KNOWN absent
 *                     (2026-08-14; generalized per-token 2026-09-06). The four sheet callers
 *                     (SolPayMode, SolReceiveMode, SolanaReceiveSheet, SolanaWithdrawSheet)
 *                     keep their EXACT testIDs and behavior.
 *
 * All money figures arrive PRE-FORMATTED (the caller owns `fmtAssetCompact` - the i18n rule).
 */

// ── surface='plan' — the wallet-level planner card ─────────────────────────────────────────────

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
  confirming: boolean;
  confirmLine: string | null;
  busy: boolean;
  /** The device's SOL receive address for the refuse panel's copy affordance (null when the
   *  rail is unavailable - the panel then falls back to the deposit-sheet escape). */
  solAddress: string | null;
  err: string | null;
  /** The failure NEXT STEPS (founder spec 2026-10-02): set ONLY when the error is a run's
   *  terminal ending (expiry/failure of the setup's own record). The card then renders the
   *  failed panel: the error first, then this line. Null = the error is a transient pre-run
   *  failure and the idle card carries it. */
  errNext: string | null;
  /** False ONLY while the failed run's funds are not verifiably accounted for: the card
   *  then stands the repeat button DOWN (no repeat affordance while funds are unaccounted). */
  errCanRetry: boolean;
};

export type AtaSetupPlanProps = {
  surface: 'plan';
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
  /** True once the parent has sized the swap and is waiting for the confirm press. */
  confirming?: boolean;
  /** The sized confirm sentence (shown while `confirming`). */
  confirmLine?: string | null;
  busy?: boolean;
  err?: string | null;
  /** The failure next-steps line (founder spec 2026-10-02): present ONLY for a run's
   *  terminal ending - the card then renders the failed panel (error first, then this). */
  errNext?: string | null;
  /** False while the failed run's funds are unaccounted: no repeat affordance re-arms. */
  errCanRetry?: boolean;
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
};

// ── surface='create' — the per-asset create card (the four sheet callers) ──────────────────────

export type AtaSetupCreateProps = {
  surface: 'create';
  /** The token's display symbol — names the account in every sentence ('USDC', 'EURC', …). */
  asset: string;
  instrTestID: string;
  btnTestID: string;
  buttonLabel: string;
  hasSol: boolean;
  /** SOL balance not confirmed yet (loading/unavailable) — say "checking", never claim insufficiency. */
  checkingSol?: boolean;
  busy?: boolean;
  err?: string | null;
  onCreateAta?: () => void;
  onShowSolAddress?: () => void;
};

export type AtaSetupCardProps = AtaSetupPlanProps | AtaSetupCreateProps;

/**
 * The planner card's states, driven entirely by props (the parent owns the plan + the run):
 *   live    - a non-terminal convert record is still working toward THIS setup (2026-10-02
 *             P0): the ONE founder-specified busy line, NO button, NO idle minimum line.
 *             It outranks EVERY other state - a live record must never be pasted over by
 *             idle (a re-armed button is a second-spend invitation), confirm, busy or refuse.
 *   busy    - the run works (confirm pressed, on-chain, or a venue swap in flight): spinner
 *             + the SAME single founder line (2026-10-02). Nothing else competes with it.
 *   confirm - a swap run's ONE confirmation, stating the total: the sized swap, its source,
 *             what it creates, what it costs. Confirm executes; cancel returns.
 *   refuse  - the honest dead end: what is missing, what it costs, the needSol copy and the
 *             device's SOL receive address with a copy affordance (the deposit-sheet escape
 *             when the parent cannot show one). NO button - never a fake one.
 *   failed  - a terminal run ending with next steps (founder spec 2026-10-02): the error
 *             FIRST, then what happens to the money and what to do now. `errCanRetry` false
 *             (funds unaccounted) stands the repeat button DOWN; the wallet only sets
 *             `errNext` for these terminal endings, so transient pre-run errors stay idle.
 *   idle    - create (SOL covers), fund (a SPL swap pays) or fund-ic (a cross-rail venue swap
 *             pays): the ONE "Complete setup" button. A fund/fund-ic run presses through to
 *             the confirm; create runs straight away (the button itself is the consent, cost
 *             disclosed above - the same contract the per-asset create card established).
 *
 * HARD RULE (2026-09-30 defect, never again): every rendered state carries an ACTIONABLE next
 * step. The v1 card shipped a refuse state that ONLY explained steps with no affordance at all
 * (and the idle button above it stayed a doomed retry). Refuse must always render one of its
 * two escapes below; idle/confirm/busy own the ONE button. Pinned by AtaSetupCard.test.tsx
 * and HomeTab.test.tsx. (The live state's actionable next step is the run itself: it keeps
 * going without a press - the honesty line says so, and the record's own panel can stop it.)
 *
 * Visual grammar (plan): the instruction card (S.instrCard's radius/padding) + the wide
 * primary button; the idle state states the required minimum UP FRONT (the measured min line,
 * else the exact SOL rent) - no number the user has to fail a swap to learn.
 * `testIDPrefix` keeps parallel cards tellable (`ata-setup-EUR-complete`, `ata-setup-USD-…`).
 *
 * Visual grammar (create): the instruction card (one-time cost + what it buys), the
 * insufficient-SOL warning (+ the fund-SOL escape hatch), the devnet warning, the busy state,
 * the create button, and the error line. The create action (`onCreateAta`, owned by Wallet →
 * `createTokenAta`) broadcasts a REAL AssociatedTokenProgram.createIdempotent transaction
 * signed by the device key; the one-time rent + fee are paid from the device's SOL balance and
 * DISCLOSED in the copy (honest cost, no silent fee - founder rule 2026-08-14: "I don't want
 * faking"). Callers render this card ONLY when the ATA status is KNOWN 'absent' - never for
 * loading/unavailable/error (those states must not claim the account is missing; that was the
 * 2026-08-14 audit fix).
 */
export function AtaSetupCard(props: AtaSetupCardProps) {
  if (props.surface === 'create') return <CreateSurface {...props} />;
  return <PlanSurface {...props} />;
}

function PlanSurface({
  targets,
  kind,
  costLine,
  minLine = null,
  fundFromLine = null,
  live = false,
  confirming = false,
  confirmLine = null,
  busy = false,
  err = null,
  errNext = null,
  errCanRetry = true,
  solAddress = null,
  solCopied = false,
  onStart,
  onConfirm,
  onCancel,
  onCopySolAddress,
  onShowSolAddress,
  testIDPrefix,
}: AtaSetupPlanProps) {
  const targetsPhrase = M.deposit.ata.targetsLabel(targets);
  if (live) {
    // The founder's busy contract (2026-10-02): ONE line next to the spinner, nothing else
    // competing, no button - from the confirm press until the record resolves. A carried
    // error (money-critical) still renders, with its next steps under it.
    return (
      <View testID={`${testIDPrefix}-live`} style={S.ataBanner}>
        <ActivityIndicator color={C.brandText} />
        <Text testID={`${testIDPrefix}-live-line`} style={S.dim2}>{M.deposit.ata.settingUp}</Text>
        {err ? <Text testID={`${testIDPrefix}-err`} style={S.err}>{err}</Text> : null}
        {err && errNext != null ? <Text testID={`${testIDPrefix}-err-next`} style={S.dim2}>{errNext}</Text> : null}
      </View>
    );
  }
  if (busy) {
    return (
      <View testID={`${testIDPrefix}-busy`} style={S.ataBanner}>
        <ActivityIndicator color={C.brandText} />
        <Text testID={`${testIDPrefix}-busy-line`} style={S.dim2}>{M.deposit.ata.settingUp}</Text>
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
        {err && errNext != null ? <Text testID={`${testIDPrefix}-err-next`} style={S.dim2}>{errNext}</Text> : null}
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
  // The terminal FAILURE (founder spec 2026-10-02): the error FIRST, then the next steps -
  // what happens to the money and what to do now. The wallet sets `errNext` ONLY for a run's
  // terminal ending, so a transient pre-run error stays on the idle card below. When the
  // funds are NOT verifiably accounted for (`errCanRetry: false`) the repeat button STANDS
  // DOWN - never a second spend while money is unaccounted.
  if (err != null && errNext != null) {
    return (
      <View testID={`${testIDPrefix}-failed`} style={S.ataBanner}>
        <Text testID={`${testIDPrefix}-err`} style={S.err}>{err}</Text>
        <Text testID={`${testIDPrefix}-err-next`} style={S.dim2}>{errNext}</Text>
        {errCanRetry ? (
          <Pressable
            testID={`${testIDPrefix}-complete`}
            style={S.primaryWide}
            onPress={onStart}
            accessibilityRole="button"
            accessibilityLabel={M.deposit.ata.completeSetup}
            accessibilityState={{disabled: false}}>
            <Text style={S.primaryText}>{M.deposit.ata.completeSetup}</Text>
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

/** The per-asset create surface - byte-identical rendering to the former SolanaAtaSetupCard
 *  (the four sheet callers' testIDs and copy are pinned and unchanged). */
function CreateSurface({
  asset,
  instrTestID,
  btnTestID,
  buttonLabel,
  hasSol,
  checkingSol = false,
  busy = false,
  err = null,
  onCreateAta,
  onShowSolAddress,
}: AtaSetupCreateProps) {
  const setupCost = fmtAssetCompact(String(SOL_ATA_SETUP_MIN_LAMPORTS), SOL_DECIMALS, SOL_UNIT);
  const canCreate = !!onCreateAta && !busy && hasSol;
  return (
    <>
      <View testID={instrTestID} style={S.instrCard}>
        <Text style={S.instrLine}>{M.deposit.ata.absent(asset)}</Text>
        <Text style={S.instrCustody}>{M.deposit.ata.cost(setupCost, asset)}</Text>
        {!hasSol ? (
          <>
            {checkingSol ? (
              <Text testID="sol-ata-checking-sol" style={S.dim2}>{M.deposit.ata.checkingSol}</Text>
            ) : (
              <Text testID="sol-ata-insufficient" style={S.warnNote}>{M.deposit.ata.needSol(setupCost)}</Text>
            )}
            {onShowSolAddress ? (
              <Pressable
                testID="btn-sol-ata-fund"
                style={S.linkBtn}
                onPress={onShowSolAddress}
                accessibilityRole="button"
                accessibilityLabel={M.deposit.ata.showSolAddress}>
                <Text style={S.linkText}>{M.deposit.ata.showSolAddress}</Text>
              </Pressable>
            ) : null}
          </>
        ) : null}
        {isSolanaDevnet() ? (
          // P4 — the '⚠' text glyph became a leading IconAlert (warnRow mirrors warnNote's
          // sizing in row form). No e2e/jest asserts this text; the testID moves to the wrapper.
          <View testID="sol-devnet-warning" style={S.warnRow}>
            <IconAlert size={14} color={C.warn} />
            <Text style={S.warnRowText}>{M.deposit.sol.devnetWarn(asset)}</Text>
          </View>
        ) : null}
      </View>
      {busy ? (
        <>
          <ActivityIndicator color={C.brandText} />
          <Text testID="sol-ata-busy" style={S.dim2}>{M.deposit.ata.creating(asset)}</Text>
        </>
      ) : (
        <Pressable
          testID={btnTestID}
          style={[S.primaryWide, !canCreate && S.disabledFlat]}
          disabled={!canCreate}
          onPress={onCreateAta}
          accessibilityRole="button"
          accessibilityLabel={buttonLabel}
          accessibilityHint={M.deposit.ata.createHint(setupCost, asset)}
          accessibilityState={{disabled: !canCreate}}>
          <Text style={[S.primaryText, !canCreate && S.disabledText]}>{buttonLabel}</Text>
        </Pressable>
      )}
      {err ? <Text testID="sol-ata-err" style={S.err}>{err}</Text> : null}
    </>
  );
}
