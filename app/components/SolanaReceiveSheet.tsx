import {useCallback, useState} from 'react';
import {View, Text, Pressable, Platform, ActivityIndicator} from 'react-native';
import {QrCode} from './QrCode';
import {IconAlert} from './icons';
import {S} from '../styles';
import {C} from '../config/palette';
import {QR_SIZE_SMALL, IS_SOLANA_DEVNET} from '../config/constants';
import {SOL_ATA_SETUP_MIN_LAMPORTS, USDC_MINT_ADDRESS} from '../solana/spl';
import {buildSolanaPayUri, createSolanaPayReference} from '../solana/payUri';
import {useEscapeToClose} from '../hooks/useHotkeys';
import {useCopyFeedback} from '../hooks/useCopyFeedback';
import {SolanaAtaSetupCard} from './SolanaAtaSetupCard';
import {TrustWalletFundButton} from './TrustWalletFundButton';
import {IconCopy, IconRefresh} from './icons';
import {InstrLine} from './InstrLine';
import {M} from '../i18n';

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
 *   - 'checking'   → an honest in-progress state (M.deposit.sol.checkingAta) on the first poll;
 *                    never claims absence.
 *   - 'unverified' → M.deposit.sol.ataUnverified + Retry (RPC down/error) — fail-closed, no QR, but
 *                    NO false "you don't have one" claim either.
 *
 * Native SOL (`token === 'SOL'`, the default) never gates — the device key IS the account; it
 * always renders 'ready'. There is no relay/minter round-trip for either token: the address is
 * local + instant, the balance poll reflects a send on confirmation. `onClose` is wired via the
 * tab's toggle (no overlay ✕).
 */
export function SolanaReceiveSheet({
  address,
  uriRecipient,
  token = 'SOL',
  ataStatus = 'ready',
  ataSetupBusy = false,
  ataSetupErr = null,
  solBalance = null,
  tokenZero = false,
  onCreateAta,
  onShowSolAddress,
  onRetryAta,
  returnLabel,
  onReturn,
  onClose,
}: {
  address: string;
  uriRecipient?: string;
  token?: 'SOL' | 'USDC';
  ataStatus?: 'ready' | 'absent' | 'checking' | 'unverified';
  ataSetupBusy?: boolean;
  ataSetupErr?: string | null;
  solBalance?: string | null;
  tokenZero?: boolean;
  onCreateAta?: () => void;
  onShowSolAddress?: () => void;
  onRetryAta?: () => void;
  returnLabel?: string | null;
  onReturn?: () => void;
  onClose: () => void;
}) {
  const {copied, copy: doCopy} = useCopyFeedback();
  useEscapeToClose(onClose);
  const [reference] = useState(createSolanaPayReference);

  const copy = useCallback(async () => { await doCopy(address); }, [address, doCopy]);
  const isUsdc = token === 'USDC';
  const payUri = buildSolanaPayUri(uriRecipient ?? address, {
    splToken: isUsdc ? USDC_MINT_ADDRESS : null,
    reference,
  });
  // The asset NAME, not copy — it names the token the sentences are about (never a ledger id).
  const assetLabel = isUsdc ? 'USDC' : 'SOL';
  const status = isUsdc ? ataStatus : 'ready';
  const hasSol = solBalance != null && BigInt(solBalance) >= SOL_ATA_SETUP_MIN_LAMPORTS;
  // SOL balance unconfirmed (loading/unavailable): the setup card says "checking", never claims
  // insufficiency on an unknown state (2026-08-16 UX review finding 9).
  const checkingSol = solBalance == null;

  // USDC readiness gate — see the doc comment. SOL always renders the address.
  if (status !== 'ready') {
    return (
      <View style={S.sheetBody}>
        {status === 'absent' ? (
          <SolanaAtaSetupCard
            instrTestID="sol-receive-instructions"
            btnTestID="btn-sol-ata-create"
            buttonLabel={M.deposit.sol.createAtaLabel}
            hasSol={hasSol}
            checkingSol={checkingSol}
            busy={ataSetupBusy}
            err={ataSetupErr}
            onCreateAta={onCreateAta}
            onShowSolAddress={onShowSolAddress}
          />
        ) : status === 'checking' ? (
          <>
            <ActivityIndicator style={{marginTop: 24}} color={C.brand} />
            <Text testID="sol-ata-checking" style={S.dim2}>{M.deposit.sol.checkingAta}</Text>
          </>
        ) : (
          <View testID="sol-ata-unverified" style={S.instrCard}>
            <Text style={S.instrLine}>{M.deposit.sol.ataUnverified}</Text>
            <Text style={S.instrCustody}>{M.deposit.sol.ataUnverifiedDetail}</Text>
          </View>
        )}
        {status === 'unverified' && onRetryAta ? (
          <Pressable
            testID="btn-sol-ata-retry"
            style={S.primaryWide}
            onPress={onRetryAta}
            accessibilityRole="button"
            accessibilityLabel={M.deposit.sol.retryAtaLabel}
            accessibilityHint={M.deposit.sol.retryAtaHint}>
            <Text style={S.primaryText}>{M.deposit.sol.checkAgain}</Text>
          </Pressable>
        ) : null}
        <Pressable
          testID="btn-sol-receive-copy"
          accessibilityRole="button"
          accessibilityLabel={M.deposit.sol.backToRequest}
          style={[S.primaryWide, S.depositCopy]}
          onPress={onClose}>
          <Text style={S.primaryText}>{M.deposit.sol.backToRequest}</Text>
        </Pressable>
        {Platform.OS === 'web' ? <Text style={S.dim2}>{M.deposit.pressEsc}</Text> : null}
      </View>
    );
  }

  return (
    <View style={S.sheetBody}>
      <View testID="sol-receive-instructions" style={S.instrCard}>
        <InstrLine runs={M.deposit.sol.sendToAddress(assetLabel, isUsdc ? 'Solana USDC' : 'Solana')} />
        <Text style={S.instrCustody}>{M.deposit.sol.custody(assetLabel)}</Text>
        {IS_SOLANA_DEVNET ? (
          // P4 pattern — '⚠' text glyph is a leading IconAlert (mirrors SolanaAtaSetupCard's
          // converted twin; testID on the wrapper).
          <View testID="sol-devnet-warning" style={S.warnRow}>
            <IconAlert size={14} color={C.warn} />
            <Text style={S.warnRowText}>{M.deposit.sol.devnetWarn(assetLabel)}</Text>
          </View>
        ) : null}
      </View>

      <View testID="sol-receive-qr" style={S.qrCard}><QrCode value={payUri} size={QR_SIZE_SMALL} ecl="L" /></View>

      <Text testID="sol-receive-address" style={S.sheetAddr} selectable={true}>{address}</Text>

      {/* Zero-funds waiting cue (2026-08-16 UX): when the balance is a KNOWN zero, the user is
          actively funding — say so honestly (the 2.5s poll IS the watcher) instead of the generic
          "updates automatically" line. Flips to the deposit-received confirmation as soon as the
          poll sees a positive balance. Known-zero only: loading/error/unavailable keep the generic
          line (never claim "waiting" on an unconfirmed state). */}
      {tokenZero ? (
        <>
          <Text testID="sol-receive-waiting" style={S.dim2}>{M.deposit.sol.waitingDeposit}</Text>
          {onRetryAta ? (
            <Pressable
              testID="btn-sol-receive-check"
              style={S.ghostBtn}
              onPress={onRetryAta}
              accessibilityRole="button"
              accessibilityLabel={M.deposit.checkNow}
              accessibilityHint={M.deposit.sol.checkNowHint}>
              <IconRefresh size={16} color={C.sub}/>
              <Text style={S.ghostBtnText}>{M.deposit.checkNow}</Text>
            </Pressable>
          ) : null}
        </>
      ) : (
        <Text style={S.dim2}>{M.deposit.sol.balanceAutoOnConfirm}</Text>
      )}

      <Pressable
        testID="btn-sol-receive-copy"
        accessibilityRole="button"
        accessibilityLabel={copied === 'clipboard' ? M.deposit.addressCopied : copied === 'shared' ? M.deposit.addressShared : M.deposit.sol.copyAssetAddress(assetLabel)}
        style={[S.primaryWide, S.depositCopy]}
        onPress={copy}>
        <IconCopy size={18} color={C.brandInk}/>
        <Text style={S.primaryText}>{copied === 'clipboard' ? M.deposit.copied : copied === 'shared' ? M.deposit.shared : M.deposit.copyAddress}</Text>
      </Pressable>

      {/* Trust Wallet send deep link (2026-08-17 plan): mainnet only — devnet has no Trust
          asset id (copy/QR status quo). USDC links the SPL asset id (send to this ATA); the
          sheet only renders the address branch when the account exists ('ready'), so the
          button inherits the same can-receive gate. */}
      {!IS_SOLANA_DEVNET ? (
        <TrustWalletFundButton asset={isUsdc ? 'SOL-USDC' : 'SOL'} address={address} />
      ) : null}

      {/* Return-to-pay link (2026-08-16 UX review): when the user landed here from a fund-first
          prompt for ANOTHER asset (e.g. "Show my SOL address" while paying USDC) and that asset's
          watched balance has since flipped positive, offer the one-tap way back to the Pay tab —
          the guided resume of the interrupted funnel (in-place, never a modal). */}
      {returnLabel && onReturn ? (
        <Pressable
          testID="btn-sol-receive-return"
          style={[S.ghostBtn, S.ghostBtnMuted]}
          onPress={onReturn}
          accessibilityRole="button"
          accessibilityLabel={returnLabel}
          accessibilityHint={M.deposit.sol.returnHint}>
          <Text style={S.ghostBtnText}>{returnLabel}</Text>
        </Pressable>
      ) : null}

      {Platform.OS === 'web' ? <Text style={S.dim2}>{M.deposit.pressEsc}</Text> : null}
    </View>
  );
}
