import {View, Text, Pressable, ActivityIndicator} from 'react-native';
import {S} from '../styles';
import {C} from '../config/palette';
import {M} from '../i18n';

/**
 * The wallet-level ONE-TAP setup card (2026-09-30) — the AccountsTab surface that turns the
 * passive "Needs setup" badge into its action. Visual grammar: SolanaAtaSetupCard (the same
 * instruction card + primary button + error line), generalized from ONE token to the wallet's
 * WHOLE set of absent accounts: one run creates ALL of them, funding itself from a funded SPL
 * token when the SOL balance falls short (the founder's "a SINGLE button that, with a SINGLE
 * click (+ optionally confirmation) sets up everything").
 *
 * Four states, driven entirely by props (the parent owns the plan + the run):
 *   busy    — the run is on chain: spinner + what is being created.
 *   confirm — the fund run's ONE optional confirmation, stating the total: the sized swap,
 *             its source, what it creates, what it costs. Confirm executes; cancel returns.
 *   refuse  — the honest dead end: what is missing, what it costs, and the needSol copy
 *             (+ the SOL-address escape when the parent can show one). No button.
 *   idle    — create (SOL covers) or fund (a swap will pay): the ONE "Complete setup" button.
 *             A fund run presses through to the confirm; create runs straight away (the button
 *             itself is the consent, cost disclosed above — the same contract the per-asset
 *             setup card has always had).
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
  err = null,
  onStart,
  onConfirm,
  onCancel,
  onShowSolAddress,
  testIDPrefix,
}: {
  /** Every absent account's display symbol, wallet-wide ('EURC' / ['EURC', 'USDC']). */
  targets: string[];
  /** The planner's verdict for THIS wallet: create (no swap) | fund (swap pays) | refuse. */
  kind: 'create' | 'fund' | 'refuse';
  /** The already-formatted SOL total the setup costs ("0.00204428 SOL"). */
  costLine: string;
  /** The fund card's source line — set only when the funding token is unambiguous. */
  fundFromLine?: string | null;
  /** True once the parent has sized the fund swap and is waiting for the confirm press. */
  confirming?: boolean;
  /** The sized confirm sentence (shown while `confirming`). */
  confirmLine?: string | null;
  busy?: boolean;
  err?: string | null;
  onStart?: () => void;
  onConfirm?: () => void;
  onCancel?: () => void;
  onShowSolAddress?: () => void;
  testIDPrefix: string;
}) {
  const targetsPhrase = M.deposit.ata.targetsLabel(targets);
  if (busy) {
    return (
      <View testID={`${testIDPrefix}-busy`}>
        <ActivityIndicator color={C.brandText} />
        <Text style={S.dim2}>{M.deposit.ata.creatingAll(targetsPhrase)}</Text>
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
  return (
    <>
      <View testID={`${testIDPrefix}-instr`} style={S.instrCard}>
        {targets.map(t => (
          <Text key={t} style={S.instrLine}>{M.deposit.ata.absent(t)}</Text>
        ))}
        <Text style={S.instrCustody}>{M.deposit.ata.cost(costLine, targetsPhrase)}</Text>
        {kind === 'fund' && fundFromLine != null ? (
          <Text style={S.instrCustody}>{fundFromLine}</Text>
        ) : null}
        {kind === 'refuse' ? (
          <>
            <Text testID={`${testIDPrefix}-need-sol`} style={S.warnNote}>{M.deposit.ata.needSol(costLine)}</Text>
            {onShowSolAddress ? (
              <Pressable
                testID={`${testIDPrefix}-show-sol`}
                style={S.linkBtn}
                onPress={onShowSolAddress}
                accessibilityRole="button"
                accessibilityLabel={M.deposit.ata.showSolAddress}>
                <Text style={S.linkText}>{M.deposit.ata.showSolAddress}</Text>
              </Pressable>
            ) : null}
          </>
        ) : null}
      </View>
      {kind === 'refuse' ? null : (
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
      )}
      {err ? <Text testID={`${testIDPrefix}-err`} style={S.err}>{err}</Text> : null}
    </>
  );
}
