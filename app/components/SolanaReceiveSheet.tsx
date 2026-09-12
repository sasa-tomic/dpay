import {useCallback, useState, type ReactNode} from 'react';
import {View, Text, Pressable, Platform, ActivityIndicator} from 'react-native';
import {QrCode} from './QrCode';
import {IconAlert} from './icons';
import {S} from '../styles';
import {C} from '../config/palette';
import {QR_SIZE_SMALL, isSolanaDevnet} from '../config/constants';
import {SOL_ATA_SETUP_MIN_LAMPORTS} from '../solana/spl';
import {buildSolanaPayUri, createSolanaPayReference} from '../solana/payUri';
import type {SolanaReadFailure} from '../solana';
import {useEscapeToClose} from '../hooks/useHotkeys';
import {useCopyFeedback} from '../hooks/useCopyFeedback';
import {SolanaAtaSetupCard} from './SolanaAtaSetupCard';
import {TrustWalletFundButton} from './TrustWalletFundButton';
import {IconCopy, IconRefresh} from './icons';
import {InstrLine} from './InstrLine';
import {M} from '../i18n';

/**
 * Receive any registered Solana asset (native SOL or an SPL token: USDC, EURC, …) — the device's
 * deposit address, rendered inline in the Receive tab's "My address" sub-mode. Asset-aware: for a
 * token (`token !== 'SOL'`), the displayed address is the device's derived token account (passed
 * in by SolReceiveMode via `deriveAta(solAddress, mint)`), the instructions describe THAT token
 * (`symbol`), and `ataStatus` gates what the user sees (2026-08-14 audit: tri-state, fail-closed,
 * never a false claim):
 *
 *   - 'ready'      → the address + QR (the token account exists on-chain; tokens sent here land).
 *   - 'absent'     → the one-tap setup card (SolanaAtaSetupCard) INSTEAD of the QR — the user is
 *                    not misled into sharing an address the Token program would reject.
 *   - 'checking'   → an honest in-progress state (M.deposit.sol.checkingAta) on the first poll;
 *                    never claims absence.
 *   - 'unverified' → M.deposit.sol.ataUnverified + Retry (RPC down/error) — fail-closed, no QR, but
 *                    NO false "you don't have one" claim either. The detail sentence is picked from
 *                    `ataFailure` (the transport seam's SolanaReadFailure classification, threaded
 *                    from useSolanaBalances via Wallet/SolReceiveMode — never classified here); a
 *                    relay-path outage says so instead of blaming the user's connection (R4).
 *
 * Every token fact arrives as a prop (`token`/`mint`/`decimals`/`symbol` — the selected asset row);
 * the sheet itself holds NO token literals. Native SOL (`token === 'SOL'`, the default) never
 * gates — the device key IS the account; it always renders 'ready'. There is no relay/minter
 * round-trip for any of them: the address is local + instant, the balance poll reflects a send on
 * confirmation. `onClose` is wired via the tab's toggle (no overlay ✕).
 */
export function SolanaReceiveSheet({
  address,
  uriRecipient,
  token = 'SOL',
  mint = null,
  symbol,
  ataStatus = 'ready',
  ataFailure = null,
  ataSetupBusy = false,
  ataSetupErr = null,
  solBalance = null,
  tokenZero = false,
  onCreateAta,
  onShowSolAddress,
  onRetryAta,
  returnLabel,
  onReturn,
  funding,
  onClose,
}: {
  address: string;
  uriRecipient?: string;
  /** The registry token literal ('SOL', 'USDC', 'EURC', …) — selects the native-vs-SPL branch. */
  token?: string;
  /** The token's mint pubkey (null for SOL). Drives the Solana-Pay `spl-token` param + ATA gating. */
  mint?: string | null;
  /** The token's registry decimals (9 for SOL). Interface parity with the selected asset row —
   *  this surface renders no amounts, so it is not bound in the body. */
  decimals?: number;
  /** The token's display symbol ('SOL', 'USDC', 'EURC', …). Defaults to `token`. */
  symbol?: string;
  ataStatus?: 'ready' | 'absent' | 'checking' | 'unverified';
  /** The transport seam's classification of WHY the check failed (useSolanaBalances → Wallet →
   *  SolReceiveMode) — picks the 'unverified' detail sentence. Null = no classified cause (rail
   *  off / 'unavailable') → the class-agnostic fallback. */
  ataFailure?: SolanaReadFailure | null;
  ataSetupBusy?: boolean;
  ataSetupErr?: string | null;
  solBalance?: string | null;
  tokenZero?: boolean;
  onCreateAta?: () => void;
  onShowSolAddress?: () => void;
  onRetryAta?: () => void;
  returnLabel?: string | null;
  onReturn?: () => void;
  /** "Don't have any yet?" — built by the caller from the mechanism that chose this surface. */
  funding?: ReactNode;
  onClose: () => void;
}) {
  const {copied, copy: doCopy} = useCopyFeedback();
  useEscapeToClose(onClose);
  const [reference] = useState(createSolanaPayReference);

  const copy = useCallback(async () => { await doCopy(address); }, [address, doCopy]);
  const isSpl = token !== 'SOL' && mint != null;
  const payUri = buildSolanaPayUri(uriRecipient ?? address, {
    splToken: isSpl ? mint : null,
    reference,
  });
  // The asset NAME, not copy — it names the token the sentences are about (never a ledger id).
  const assetLabel = symbol ?? token;
  // R4: the 'unverified' detail is picked FROM the seam's classification (same pattern as
  // RailUnreadableNote) — never guessed here. Post-R2 the RPC path IS the relay's proxy, so
  // 'unreachable' must name dpay's side rather than the user's connection.
  const ataDetail =
    ataFailure === 'refused' ? M.deposit.sol.ataUnverifiedRefused(assetLabel)
    : ataFailure === 'offline' ? M.deposit.sol.ataUnverifiedOffline(assetLabel)
    : ataFailure === 'unreachable' ? M.deposit.sol.ataUnverifiedUnreachable(assetLabel)
    : ataFailure === 'unreadable' ? M.deposit.sol.ataUnverifiedUnreadable(assetLabel)
    : M.deposit.sol.ataUnverifiedDetail(assetLabel);
  const status = isSpl ? ataStatus : 'ready';
  const hasSol = solBalance != null && BigInt(solBalance) >= SOL_ATA_SETUP_MIN_LAMPORTS;
  // SOL balance unconfirmed (loading/unavailable): the setup card says "checking", never claims
  // insufficiency on an unknown state (2026-08-16 UX review finding 9).
  const checkingSol = solBalance == null;

  // Token-readiness gate — see the doc comment. SOL always renders the address.
  if (status !== 'ready') {
    return (
      <View style={S.sheetBody}>
        {status === 'absent' ? (
          <SolanaAtaSetupCard
            asset={assetLabel}
            instrTestID="sol-receive-instructions"
            btnTestID="btn-sol-ata-create"
            buttonLabel={M.deposit.sol.createAtaLabel(assetLabel)}
            hasSol={hasSol}
            checkingSol={checkingSol}
            busy={ataSetupBusy}
            err={ataSetupErr}
            onCreateAta={onCreateAta}
            onShowSolAddress={onShowSolAddress}
          />
        ) : status === 'checking' ? (
          <>
            <ActivityIndicator style={{marginTop: 24}} color={C.brandText} />
            <Text testID="sol-ata-checking" style={S.dim2}>{M.deposit.sol.checkingAta(assetLabel)}</Text>
          </>
        ) : (
          <View testID="sol-ata-unverified" style={S.instrCard}>
            <Text style={S.instrLine}>{M.deposit.sol.ataUnverified(assetLabel)}</Text>
            <Text style={S.instrCustody}>{ataDetail}</Text>
          </View>
        )}
        {status === 'unverified' && onRetryAta ? (
          <Pressable
            testID="btn-sol-ata-retry"
            style={S.primaryWide}
            onPress={onRetryAta}
            accessibilityRole="button"
            accessibilityLabel={M.deposit.sol.retryAtaLabel(assetLabel)}
            accessibilityHint={M.deposit.sol.retryAtaHint(assetLabel)}>
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
        <InstrLine runs={M.deposit.sol.sendToAddress(assetLabel, isSpl ? `Solana ${assetLabel}` : 'Solana')} />
        <Text style={S.instrCustody}>{M.deposit.sol.custody(assetLabel)}</Text>
        {isSolanaDevnet() ? (
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
          asset id (copy/QR status quo). A token links its SPL asset id c501_t<mint> (send to
          this token account); the sheet only renders the address branch when the account exists
          ('ready'), so the button inherits the same can-receive gate. */}
      {!isSolanaDevnet() ? (
        <TrustWalletFundButton asset={isSpl && mint != null ? (`SPL:${mint}` as const) : 'SOL'} address={address} assetName={assetLabel} />
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

      {/* The step BEFORE the address (founder direction 2026-09-09). Built by the caller — see
          IcrcDepositSheet's note on why — and rendered only on the address branch, which is the one
          state where "I don't have any yet" is the user's actual question. */}
      {funding}

      {Platform.OS === 'web' ? <Text style={S.dim2}>{M.deposit.pressEsc}</Text> : null}
    </View>
  );
}
