import {useCallback} from 'react';
import {View, Text, Pressable, Platform} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import {S} from '../styles';
import {QR_SIZE_SMALL, IS_SOLANA_DEVNET} from '../config/constants';
import {useEscapeToClose} from '../hooks/useHotkeys';
import {useCopyFeedback} from '../hooks/useCopyFeedback';

/**
 * Receive SOL or Solana-USDC — the device's native deposit address, rendered inline in the Receive
 * tab's "My address" sub-mode. Phase 4 (2026-08-12 unified asset selection rewrite) made this sheet
 * ASSET-AWARE: when `token === 'USDC'`, the displayed address is the device's derived USDC ATA
 * (Passed in by SolReceiveMode via `deriveAta(solAddress, USDC_MINT_ADDRESS)`), the instructions
 * describe USDC (not SOL), and a `ataReady === false` state replaces the QR with a "set up your
 * USDC account" message (honest — sending USDC to a non-existent ATA is unfulfillable).
 *
 * Native SOL (`token === 'SOL'`, the default) keeps the long-shipped behavior: the device's base58
 * SOL address + QR + "Send SOL to your Solana address below" copy. There is no relay/minter
 * round-trip for either token: the address is local + instant, the balance poll reflects a send on
 * confirmation. `onClose` is wired via the tab's toggle (no overlay ✕).
 *
 * Readiness gating (USDC only): when the device has no on-chain USDC ATA, `ataReady === false`
 * surfaces a clear "set one up" message INSTEAD of the address QR — the user is not misled into
 * sharing an address the Token program would reject. The QR + copy button stay available for SOL
 * (always ready) and for USDC once the ATA exists.
 */
export function SolanaReceiveSheet({address, token = 'SOL', ataReady = true, onClose}: {address: string; token?: 'SOL' | 'USDC'; ataReady?: boolean; onClose: () => void}) {
  const {copied, copy: doCopy} = useCopyFeedback();
  useEscapeToClose(onClose);

  const copy = useCallback(async () => { await doCopy(address); }, [address, doCopy]);
  const isUsdc = token === 'USDC';

  // USDC readiness gate: when the device has no on-chain USDC ATA, do NOT show the address QR —
  // sending USDC to a non-existent ATA fails at the Token program. The user is told honestly to set
  // one up first (a one-time on-chain operation outside this app's scope). SOL always renders the
  // address (the device key IS the account; no ATA prerequisite).
  if (isUsdc && !ataReady) {
    return (
      <View style={S.sheetBody}>
        <View testID="sol-receive-instructions" style={S.instrCard}>
          <Text style={S.instrLine}>
            You don't have a <Text style={S.instrAsset}>USDC</Text> account on this device yet.
          </Text>
          <Text style={S.instrCustody}>
            Solana USDC needs a one-time Associated Token Account setup. Set one up from a wallet that supports it, then come back — your USDC address will appear here.
          </Text>
          {IS_SOLANA_DEVNET ? (
            <Text testID="sol-devnet-warning" style={S.warnNote}>
              ⚠ Connected to Solana devnet. Do NOT send mainnet USDC here — it will not appear. Use devnet USDC only.
            </Text>
          ) : null}
        </View>
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
