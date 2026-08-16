import {View, Text, Pressable, ActivityIndicator} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';

/**
 * FundFirstPanel — the shared "add funds before you pay/send" surface (2026-08-16 zero-funds UX).
 *
 * Rendered IN PLACE OF the Pay-tab scanner (and in place of the Send-to-address body) when the
 * active asset is KNOWN unfunded — the user's fastest path to a working payment is their own
 * deposit address, not a scanner that can only produce a doomed signature. Presentational ONLY:
 * the Wallet owns the gate decision (`solPayGate`) and the navigation (`goToDeposit`); this panel
 * just renders title + body + one primary action (+ optional secondary + recheck link).
 *
 * Used by BOTH rails (SOL/USDC via SolPayMode, IC via PayMode) — the same-surfaces hard rule: no
 * per-rail special IA. Copy is passed in by the caller so each rail states its truth (USDC adds
 * the keep-a-little-SOL note; a no-minter IC asset omits the primary).
 */
export function FundFirstPanel({
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
          accessibilityLabel={recheckBusy ? 'Checking…' : 'Check again'}
          accessibilityState={{disabled: recheckBusy}}>
          <Text style={S.linkText}>{recheckBusy ? 'Checking…' : 'Check again'}</Text>
        </Pressable>
      ) : null}
      {recheckBusy ? <ActivityIndicator color={C.brand} /> : null}
    </View>
  );
}
