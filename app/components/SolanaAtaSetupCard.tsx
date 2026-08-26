import {View, Text, Pressable, ActivityIndicator} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';
import {IS_SOLANA_DEVNET} from '../config/constants';
import {fmtAsset} from '../lib/format';
import {SOL_DECIMALS, SOL_UNIT} from '../solana/identity';
import {SOL_ATA_SETUP_MIN_LAMPORTS} from '../solana/spl';
import {IconAlert} from './icons';
import {M} from '../i18n';

/**
 * The one-tap USDC-account (ATA) setup card — the SHARED surface for every place the device's
 * USDC token account is KNOWN absent (2026-08-14). Renders: the instruction card (cost + custody
 * disclosure), the insufficient-SOL warning (+ the fund-SOL escape hatch, 2026-08-16), the devnet
 * warning, the busy state, the create button, and the error line. The create action (`onCreateAta`,
 * owned by Wallet → `createUsdcAta`) broadcasts a REAL AssociatedTokenProgram.createIdempotent
 * transaction signed by the device key; the one-time rent + fee are paid from the device's SOL
 * balance and DISCLOSED in the copy (honest cost, no silent fee — founder rule 2026-08-14:
 * "I don't want faking").
 *
 * Callers (each with its own testIDs so e2e can tell the surfaces apart):
 *   - SolanaReceiveSheet  (Receive → My address, USDC absent)  — btn-sol-ata-create
 *   - SolanaWithdrawSheet (Pay → Send to address, USDC absent) — btn-sol-send-ata-create
 *   - SolReceiveMode      (Receive → request form, USDC absent — inline, blocks btn-sol-req-make)
 *                        — btn-sol-req-ata-create
 *   - SolPayMode          (Pay → scan, USDC absent — the zero-funds gate) — btn-sol-pay-ata-create
 * Only render this card when the ATA status is KNOWN 'absent' — never for loading/unavailable/
 * error (those states must not claim the account is missing; that was the 2026-08-14 audit fix).
 */
export function SolanaAtaSetupCard({
  instrTestID,
  btnTestID,
  buttonLabel,
  hasSol,
  checkingSol = false,
  busy = false,
  err = null,
  onCreateAta,
  onShowSolAddress,
}: {
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
}) {
  const setupCost = fmtAsset(String(SOL_ATA_SETUP_MIN_LAMPORTS), SOL_DECIMALS, SOL_UNIT);
  const canCreate = !!onCreateAta && !busy && hasSol;
  return (
    <>
      <View testID={instrTestID} style={S.instrCard}>
        <Text style={S.instrLine}>{M.deposit.ata.absent}</Text>
        <Text style={S.instrCustody}>{M.deposit.ata.cost(setupCost)}</Text>
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
        {IS_SOLANA_DEVNET ? (
          // P4 — the '⚠' text glyph became a leading IconAlert (warnRow mirrors warnNote's
          // sizing in row form). No e2e/jest asserts this text; the testID moves to the wrapper.
          <View testID="sol-devnet-warning" style={S.warnRow}>
            <IconAlert size={14} color={C.warn} />
            <Text style={S.warnRowText}>{M.deposit.sol.devnetWarn('USDC')}</Text>
          </View>
        ) : null}
      </View>
      {busy ? (
        <>
          <ActivityIndicator color={C.brand} />
          <Text testID="sol-ata-busy" style={S.dim2}>{M.deposit.ata.creating}</Text>
        </>
      ) : (
        <Pressable
          testID={btnTestID}
          style={[S.primaryWide, !canCreate && S.disabledFlat]}
          disabled={!canCreate}
          onPress={onCreateAta}
          accessibilityRole="button"
          accessibilityLabel={buttonLabel}
          accessibilityHint={M.deposit.ata.createHint(setupCost)}
          accessibilityState={{disabled: !canCreate}}>
          <Text style={S.primaryText}>{buttonLabel}</Text>
        </Pressable>
      )}
      {err ? <Text testID="sol-ata-err" style={S.err}>{err}</Text> : null}
    </>
  );
}
