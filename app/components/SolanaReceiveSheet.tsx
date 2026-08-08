import {useCallback, useState} from 'react';
import {View, Text, Pressable, ScrollView, SafeAreaView, StatusBar, Platform} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import {C} from '../config/palette';
import {S} from '../styles';
import {QR_SIZE_SMALL} from '../config/constants';
import {copyToClipboard} from '../lib/clipboard';
import {useEscapeToClose} from '../hooks/useHotkeys';
import {SheetOverlay} from './SheetOverlay';

/**
 * Receive SOL — the device's native Solana deposit address (derived from the IC identity seed via
 * SLIP-10 m/44'/501'/0'/0'). Unlike ckBTC (DepositSheet), there is no relay/minter round-trip: the
 * address is local + instant, so this sheet shows the address QR + copy immediately, with a plain-
 * language note that a send credits on confirmation (the balance poll reflects it automatically).
 *
 * Offline-receive re-home (2026-08-08): the durable-nonce offline-merchant flow (SolReceiveMode —
 * build a `solreq:` code + scan/broadcast the payer's signed `solpay:`) lives here as a SECONDARY
 * action, NOT on the Balances row. A "Request offline payment" link (testID `btn-sol-req-offline`)
 * opens SolReceiveMode — the heavier request→scan-payer→broadcast flow that's contextually a sibling
 * of showing your address (both are "receive SOL"). Keeps the Balances SOL row uncluttered, with no
 * functionality lost and no dead code.
 */
export function SolanaReceiveSheet({address, onSolReqOffline, onClose}: {address: string; onSolReqOffline?: () => void; onClose: () => void}) {
  const [copied, setCopied] = useState<'clipboard' | 'shared' | null>(null);
  useEscapeToClose(onClose);

  const copy = useCallback(async () => {
    const how = await copyToClipboard(address);
    setCopied(how);
    setTimeout(() => setCopied(null), 1500);
  }, [address]);

  return (
    <SheetOverlay>
      <SafeAreaView style={S.sheet}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <View style={S.sheetHead}>
          <Text style={S.sheetTitle}>Receive SOL</Text>
          <Pressable
            testID="btn-sol-receive-close"
            accessibilityRole="button"
            accessibilityLabel="Close receive SOL sheet"
            style={S.sheetClose}
            onPress={onClose}>
            <Text style={S.sheetCloseX}>✕</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={S.sheetBody} keyboardShouldPersistTaps="handled">
          <View testID="sol-receive-instructions" style={S.instrCard}>
            <Text style={S.instrLine}>
              Send <Text style={S.instrAsset}>SOL</Text> to your Solana address below.
            </Text>
            <Text style={S.instrCustody}>
              dpay never holds your keys — SOL lands directly in your wallet on confirmation.
            </Text>
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

          {/* Offline-receive re-home: SolReceiveMode (offline merchant request + scan/broadcast) is
              reached as a sibling secondary action, not from the Balances row. Sits below the address
              copy so it reads as an alternative receive path, not a competing primary. */}
          {onSolReqOffline ? (
            <Pressable
              testID="btn-sol-req-offline"
              style={S.linkBtn}
              onPress={onSolReqOffline}
              accessibilityRole="button"
              accessibilityLabel="Request offline payment"
              accessibilityHint="Build a payment code and scan the payer's signed offline payment"
              accessibilityState={{disabled: false}}>
              <Text style={S.linkText}>Request offline payment</Text>
            </Pressable>
          ) : null}

          {Platform.OS === 'web' ? <Text style={S.dim2}>Press Esc to close</Text> : null}
        </ScrollView>
      </SafeAreaView>
    </SheetOverlay>
  );
}
