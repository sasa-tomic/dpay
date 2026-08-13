import {useEffect, useRef, useState} from 'react';
import {View, Text, Pressable} from 'react-native';
import {S} from '../styles';
import {fmtAsset} from '../lib/format';
import {isSolanaRpcAvailable} from '../solana';
import {inspectReclaim, reclaimNonceAccount} from '../solana/reclaim';
import type {ReclaimCheck, ReclaimResult} from '../solana/reclaim';

/**
 * Legacy durable-nonce reclaim — a ONE-TIME recovery action isolated in Settings. Early dpay shipped a
 * v1 offline-payment protocol that locked a small SOL reserve in a deterministic durable-nonce account
 * (m/44'/501'/0'/1'). That protocol is gone; this drains the leftover account back to the main wallet
 * (m/44'/501'/0'/0') and removes it permanently. It is NOT a payment fallback (invariant #15) — it is
 * an online, user-initiated recovery with no dependency on the payment code path.
 *
 * Two-step flow (mirrors the Backup/Restore/Reset confirm idiom): Check → inspect the account read-
 * only (absent / reclaimable / wrong-authority / malformed); if reclaimable, show the amount + a
 * warning that outstanding v1 offline payments become invalid, then Reclaim → broadcast the withdraw +
 * confirm. Every outcome is surfaced honestly (reclaimed / insufficient-fee / unknown / error).
 */
type State =
  | {kind: 'idle'}
  | {kind: 'checking'}
  | {kind: 'checked'; check: ReclaimCheck}
  | {kind: 'draining'; check: ReclaimCheck}
  | {kind: 'done'; result: ReclaimResult};

export function SolNonceReclaim({secretHex}: {secretHex: string}) {
  const [state, setState] = useState<State>({kind: 'idle'});
  // One AbortController per in-flight op; aborted on unmount or when a new op starts (so navigating
  // away or re-checking cancels the pending RPC). The ref holds the current controller.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const online = isSolanaRpcAvailable();

  async function doCheck() {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setState({kind: 'checking'});
    try {
      const check = await inspectReclaim(secretHex, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setState({kind: 'checked', check});
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setState({kind: 'checked', check: {kind: 'error', message: e instanceof Error ? e.message : String(e)}});
    }
  }

  async function doReclaim() {
    if (state.kind !== 'checked' || state.check.kind !== 'reclaimable') return;
    const check = state.check;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setState({kind: 'draining', check});
    try {
      const result = await reclaimNonceAccount(secretHex, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setState({kind: 'done', result});
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setState({kind: 'done', result: {kind: 'error', message: e instanceof Error ? e.message : String(e)}});
    }
  }

  // --- status line for the current inspect outcome (rendered under the check button) ---
  function checkStatusText(check: ReclaimCheck): string {
    switch (check.kind) {
      case 'absent': return 'No legacy nonce account found at this wallet — nothing to reclaim.';
      case 'reclaimable': return `Reclaimable: ${fmtAsset(check.lamports.toString(), 9, 'SOL')}`;
      case 'uninitialized': return 'The legacy nonce account exists but is uninitialized — nothing to reclaim.';
      case 'wrong-authority': return 'The legacy nonce account exists but is not authorized to this wallet.';
      case 'malformed': return 'The legacy nonce account has unexpected data — contact support.';
      case 'offline': return 'Solana is not configured — connect to a network and try again.';
      case 'error': return `Check failed: ${check.message}`;
    }
  }

  function resultText(result: ReclaimResult): string {
    switch (result.kind) {
      case 'reclaimed': return `Reclaimed ${fmtAsset(result.lamports.toString(), 9, 'SOL')} (sig ${result.sig.slice(0, 8)}…)`;
      case 'insufficient-fee': return `Main wallet balance (${fmtAsset(result.balance.toString(), 9, 'SOL')}) is below the reclaim fee (${fmtAsset(result.fee.toString(), 9, 'SOL')}). Top up and try again.`;
      case 'unknown': return `Broadcast succeeded but confirmation timed out (sig ${result.sig.slice(0, 8)}…). The funds may have moved — check your balance in a moment.`;
      case 'absent': return 'No legacy nonce account found — already reclaimed or never created.';
      case 'offline': return 'Solana is not configured — connect to a network and try again.';
      case 'error': return `Reclaim failed: ${result.message}`;
    }
  }

  const showCheckResult = state.kind === 'checked' || state.kind === 'draining';
  const showReclaimable = showCheckResult && state.check.kind === 'reclaimable';
  const showDrainResult = state.kind === 'done';

  return (
    <View style={S.settingsSection}>
      <Text style={S.inputLabel}>Legacy funds</Text>
      <Text style={S.dim2}>Recover SOL locked in a legacy durable-nonce account from a previous app version.</Text>

      {!online ? (
        <Text testID="sol-reclaim-status" style={[S.warnNote, {marginTop: 8}]}>Solana is not configured.</Text>
      ) : (
        <>
          <Pressable
            testID="btn-sol-reclaim-check"
            style={[S.secondaryBtn, {marginTop: 12}]}
            onPress={doCheck}
            disabled={state.kind === 'checking' || state.kind === 'draining'}
            accessibilityRole="button"
            accessibilityLabel="Check for legacy nonce funds"
            accessibilityHint="Looks up any SOL locked in your legacy durable-nonce account"
            accessibilityState={{disabled: state.kind === 'checking' || state.kind === 'draining'}}>
            <Text style={S.secondaryBtnText}>{state.kind === 'checking' ? 'Checking…' : 'Check for legacy funds'}</Text>
          </Pressable>

          {showCheckResult ? (
            <Text testID="sol-reclaim-status" style={[S.warnNote, {marginTop: 12}]}>
              {checkStatusText(state.check)}
            </Text>
          ) : null}

          {showReclaimable ? (
            <View style={[S.backupConfirmBox, {marginTop: 12}]}>
              <Text style={S.warnNote}>This withdraws funds from your legacy durable-nonce account. Any outstanding v1 offline payments signed against this account become invalid.</Text>
              <Pressable
                testID="btn-sol-reclaim-confirm"
                style={[S.primaryWide, {marginTop: 16}]}
                onPress={doReclaim}
                disabled={state.kind === 'draining'}
                accessibilityRole="button"
                accessibilityLabel="Reclaim legacy funds"
                accessibilityHint="Withdraws the locked SOL from your legacy nonce account to your main wallet"
                accessibilityState={{disabled: state.kind === 'draining'}}>
                <Text style={S.primaryText}>{state.kind === 'draining' ? 'Reclaiming…' : 'Reclaim'}</Text>
              </Pressable>
            </View>
          ) : null}

          {showDrainResult ? (
            <Text testID="sol-reclaim-result" style={[S.warnNote, {marginTop: 12}]}>
              {resultText(state.result)}
            </Text>
          ) : null}
        </>
      )}
    </View>
  );
}
