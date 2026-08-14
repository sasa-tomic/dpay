import {useCallback} from 'react';
import {View, Text, Pressable, Platform, ActivityIndicator} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import {S} from '../styles';
import {C} from '../config/palette';
import {QR_SIZE_SMALL, IS_SOLANA_DEVNET} from '../config/constants';
import {useEscapeToClose} from '../hooks/useHotkeys';
import {useCopyFeedback} from '../hooks/useCopyFeedback';
import {SolanaAtaSetupCard} from './SolanaAtaSetupCard';

/**
 * Receive SOL or Solana-USDC — the device's native deposit address, rendered inline in the Receive
 * tab's "My address" sub-mode. Asset-aware: when `token === 'USDC'`, the displayed address is the
 * device's derived USDC ATA (passed in by SolReceiveMode via `deriveAta(solAddress,
 * USDC_MINT_ADDRESS)`), the instructions describe USDC (not SOL), and `ataStatus` gates what the
 * user sees (2026-08-14 audit: tri-state, fail-closed, never a false claim):
 *
 *   - 'ready'      → the address + QR (the ATA exists on-chain; USDC sent here can land).
 *   - 'absent'     → the one-tap setup card (SolanaAtaSetupCard) INSTEAD of the QR — the user is
 *                    not misled into sharing an address the Token program would reject.
 *   - 'checking'   → an honest "Checking your USDC account…" state (first poll; never claims
 *                    absence).
 *   - 'unverified' → "Couldn't check" + Retry (RPC down/error) — fail-closed, no QR, but NO
 *                    false "you don't have one" claim either.
 *
 * Native SOL (`token === 'SOL'`, the default) never gates — the device key IS the account; it
 * always renders 'ready'. There is no relay/minter round-trip for either token: the address is
 * local + instant, the balance poll reflects a send on confirmation. `onClose` is wired via the
 * tab's toggle (no overlay ✕).
 */
export function SolanaReceiveSheet({
  address,
  token = 'SOL',
  ataStatus = 'ready',
  ataSetupBusy = false,
  ataSetupErr = null,
  solBalance = null,
  onCreateAta,
  onRetryAta,
  onClose,
}: {
  address: string;
  token?: 'SOL' | 'USDC';
  ataStatus?: 'ready' | 'absent' | 'checking' | 'unverified';
  ataSetupBusy?: boolean;
  ataSetupErr?: string | null;
  solBalance?: string | null;
  onCreateAta?: () => void;
  onRetryAta?: () => void;
  onClose: () => void;
}) {
  const {copied, copy: doCopy} = useCopyFeedback();
  useEscapeToClose(onClose);

  const copy = useCallback(async () => { await doCopy(address); }, [address, doCopy]);
  const isUsdc = token === 'USDC';
  const status = isUsdc ? ataStatus : 'ready';
  const hasSol = solBalance != null && BigInt(solBalance) >= 2_039_280n + 5_000n; // SOL_ATA_SETUP_MIN_LAMPORTS

  // USDC readiness gate — see the doc comment. SOL always renders the address.
  if (status !== 'ready') {
    return (
      <View style={S.sheetBody}>
        {status === 'absent' ? (
          <SolanaAtaSetupCard
            instrTestID="sol-receive-instructions"
            btnTestID="btn-sol-ata-create"
            buttonLabel="Create USDC account"
            hasSol={hasSol}
            busy={ataSetupBusy}
            err={ataSetupErr}
            onCreateAta={onCreateAta}
          />
        ) : status === 'checking' ? (
          <>
            <ActivityIndicator style={{marginTop: 24}} color={C.brand} />
            <Text testID="sol-ata-checking" style={S.dim2}>Checking your USDC account…</Text>
          </>
        ) : (
          <View testID="sol-ata-unverified" style={S.instrCard}>
            <Text style={S.instrLine}>Couldn't check your USDC account.</Text>
            <Text style={S.instrCustody}>
              Your address is fine — we just can't reach Solana right now to confirm your USDC account on-chain. Check your connection and try again.
            </Text>
          </View>
        )}
        {status === 'unverified' && onRetryAta ? (
          <Pressable
            testID="btn-sol-ata-retry"
            style={S.primaryWide}
            onPress={onRetryAta}
            accessibilityRole="button"
            accessibilityLabel="Retry checking USDC account"
            accessibilityHint="Re-check whether your USDC account exists on-chain">
            <Text style={S.primaryText}>Check again</Text>
          </Pressable>
        ) : null}
        <Pressable
          testID="btn-sol-receive-copy"
          accessibilityRole="button"
          accessibilityLabel="Back to request"
          style={[S.primaryWide, S.depositCopy]}
          onPress={onClose}>
          <Text style={S.primaryText}>Back to request</Text>
        </Pressable>
        {Platform.OS === 'web' ? <Text style={S.dim2}>Press Esc to close</Text> : null}
      </View>
    );
  }

  return (
    <View style={S.sheetBody}>
      <View testID="sol-receive-instructions" style={S.instrCard}>
        <Text style={S.instrLine}>
          Send <Text style={S.instrAsset}>{isUsdc ? 'USDC' : 'SOL'}</Text> to your {isUsdc ? 'Solana USDC' : 'Solana'} address below.
        </Text>
        <Text style={S.instrCustody}>
          dpay never holds your keys — {isUsdc ? 'USDC' : 'SOL'} lands directly in your wallet on confirmation.
        </Text>
        {IS_SOLANA_DEVNET ? (
          <Text testID="sol-devnet-warning" style={S.warnNote}>
            ⚠ Connected to Solana devnet. Do NOT send mainnet {isUsdc ? 'USDC' : 'SOL'} here — it will not appear. Use devnet {isUsdc ? 'USDC' : 'SOL'} only.
          </Text>
        ) : null}
      </View>

      <View style={S.qrCard}><QRCode value={address} size={QR_SIZE_SMALL} ecl="L" /></View>

      <Text testID="sol-receive-address" style={S.sheetAddr} selectable={true}>{address}</Text>

      <Pressable
        testID="btn-sol-receive-copy"
        accessibilityRole="button"
        accessibilityLabel={copied === 'clipboard' ? 'Address copied' : copied === 'shared' ? 'Address shared' : `Copy ${isUsdc ? 'USDC' : 'SOL'} address`}
        style={[S.primaryWide, S.depositCopy]}
        onPress={copy}>
        <Text style={S.primaryText}>{copied === 'clipboard' ? 'Copied ✓' : copied === 'shared' ? 'Shared ✓' : 'Copy address'}</Text>
      </Pressable>

      <Text style={S.dim2}>Your balance updates automatically once the send confirms.</Text>

      {Platform.OS === 'web' ? <Text style={S.dim2}>Press Esc to close</Text> : null}
    </View>
  );
}
