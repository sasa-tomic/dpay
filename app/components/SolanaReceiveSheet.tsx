import {useCallback} from 'react';
import {View, Text, Pressable, Platform} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import {S} from '../styles';
import {QR_SIZE_SMALL, IS_SOLANA_DEVNET} from '../config/constants';
import {useEscapeToClose} from '../hooks/useHotkeys';
import {useCopyFeedback} from '../hooks/useCopyFeedback';

/**
 * Receive SOL — the device's native Solana deposit address (derived from the IC identity seed via
 * SLIP-10 m/44'/501'/0'/0'). Unlike ckBTC (DepositSheet), there is no relay/minter round-trip: the
 * address is local + instant, so this sheet shows the address QR + copy immediately, with a plain-
 * language note that a send credits on confirmation (the balance poll reflects it automatically).
 *
 * Rendered inline in the Receive tab's "My address" sub-mode (selected via the SOL receive-mode-
 * toggle), mirroring the IC DepositSheet. The tab body provides the scroll surface + chrome;
 * `onClose` is wired via the tab's toggle (no overlay ✕).
 */
export function SolanaReceiveSheet({address, onClose}: {address: string; onClose: () => void}) {
  const {copied, copy: doCopy} = useCopyFeedback();
  useEscapeToClose(onClose);

  const copy = useCallback(async () => { await doCopy(address); }, [address, doCopy]);

  return (
    <View style={S.sheetBody}>
      <View testID="sol-receive-instructions" style={S.instrCard}>
        <Text style={S.instrLine}>
          Send <Text style={S.instrAsset}>SOL</Text> to your Solana address below.
        </Text>
        <Text style={S.instrCustody}>
          dpay never holds your keys — SOL lands directly in your wallet on confirmation.
        </Text>
        {IS_SOLANA_DEVNET ? (
          <Text testID="sol-devnet-warning" style={S.warnNote}>
            ⚠ Connected to Solana devnet. Do NOT send mainnet SOL here — it will not appear. Use devnet SOL only.
          </Text>
        ) : null}
      </View>

      <View style={S.qrCard}><QRCode value={address} size={QR_SIZE_SMALL} ecl="L" /></View>

      <Text testID="sol-receive-address" style={S.sheetAddr} selectable={true}>{address}</Text>

      <Pressable
        testID="btn-sol-receive-copy"
        accessibilityRole="button"
        accessibilityLabel={copied === 'clipboard' ? 'Address copied' : copied === 'shared' ? 'Address shared' : 'Copy Solana address'}
        style={[S.primaryWide, S.depositCopy]}
        onPress={copy}>
        <Text style={S.primaryText}>{copied === 'clipboard' ? 'Copied ✓' : copied === 'shared' ? 'Shared ✓' : 'Copy address'}</Text>
      </Pressable>

      <Text style={S.dim2}>Your balance updates automatically once the send confirms.</Text>

      {Platform.OS === 'web' ? <Text style={S.dim2}>Press Esc to close</Text> : null}
    </View>
  );
}
