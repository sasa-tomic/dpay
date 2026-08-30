import {View, Text, Pressable, ActivityIndicator} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';
import {M} from '../i18n';

/**
 * InstructionPanel — the shared "you can't do that yet, here is what to do" surface.
 *
 * The founder's hard rule (2026-08-29) is that every gate names the user's next action, so every
 * gate needs the same shape: title, one sentence of truth, one primary action, and an optional way
 * to re-check. This panel is that shape, and nothing else — presentational ONLY. The caller owns
 * both the decision to show it and the copy, so each situation states its own truth:
 *
 *   • zero balance (2026-08-16) — the fastest path to a working payment is the user's own deposit
 *     address, not a scanner that can only produce a doomed signature.
 *   • offline send — an address send is submitted by the payer's own phone, so airplane mode
 *     genuinely blocks it; the way out is the scan-to-pay rail, which was built for exactly this.
 *
 * Used by BOTH rails (SOL/USDC via SolPayMode, IC via PayMode) — the same-surfaces hard rule: no
 * per-rail special IA.
 */
export function InstructionPanel({
  testID,
  title,
  body,
  primaryLabel,
  onPrimary,
  secondaryLabel,
  onSecondary,
  onRecheck,
  recheckBusy = false,
}: {
  testID: string;
  title: string;
  body: string;
  primaryLabel?: string;
  onPrimary?: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
  onRecheck?: () => void;
  recheckBusy?: boolean;
}) {
  const canPrimary = !!onPrimary && !!primaryLabel;
  return (
    <View testID={testID} style={S.instrCard}>
      <Text style={S.instrLine}>{title}</Text>
      <Text style={S.instrCustody}>{body}</Text>
      {canPrimary ? (
        <Pressable
          testID={`${testID}-go`}
          style={[S.primaryWide, {marginBottom: 4}]}
          onPress={onPrimary}
          accessibilityRole="button"
          accessibilityLabel={primaryLabel}>
          <Text style={S.primaryText}>{primaryLabel}</Text>
        </Pressable>
      ) : null}
      {secondaryLabel && onSecondary ? (
        <Pressable
          testID={`${testID}-sol`}
          style={S.linkBtn}
          onPress={onSecondary}
          accessibilityRole="button"
          accessibilityLabel={secondaryLabel}>
          <Text style={S.linkText}>{secondaryLabel}</Text>
        </Pressable>
      ) : null}
      {onRecheck ? (
        <Pressable
          testID={`${testID}-check`}
          style={S.linkBtn}
          onPress={onRecheck}
          disabled={recheckBusy}
          accessibilityRole="button"
          accessibilityLabel={recheckBusy ? M.wallet.fund.checking : M.wallet.fund.checkAgain}
          accessibilityState={{disabled: recheckBusy}}>
          <Text style={S.linkText}>{recheckBusy ? M.wallet.fund.checking : M.wallet.fund.checkAgain}</Text>
        </Pressable>
      ) : null}
      {recheckBusy ? <ActivityIndicator color={C.brand} /> : null}
    </View>
  );
}
