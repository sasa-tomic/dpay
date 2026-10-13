import {useCallback, useEffect, useMemo, useState} from 'react';
import {ActivityIndicator, Linking, Pressable, ScrollView, Text, View} from 'react-native';
import {AppModal} from './AppModal';
import {ModeToggle} from './ModeToggle';
import {S} from '../styles';
import {C} from '../config/palette';
import {M} from '../i18n';
import {formatMonthDayYear} from '../i18n/intl';
import {useEscapeToClose} from '../hooks/useHotkeys';
import type {Identity} from '../lib/types';
import {deriveEvmKeypair, toChecksumAddress} from '../evm/identity';
import {EVM_CHAINS, type EvmChainId} from '../evm/chains';
import {signPersonalBase64} from '../evm/personalSign';
import {
  buildMtpWidgetLink, deriveValidationCode, mtpDeliveryChains,
  validationMessage, type MtpBuyAsset, type MtpDeliveryChainId,
} from '../ramp/mtpelerin';
import {MTP_FACTS_READ_ON} from '../config/funding';
import {loadValidationSalt} from '../ramp/codeSalts';

// MtpBuySheet — the Mt Pelerin on-ramp's ONE surface (plan R1 step 3). Reviews the validation
// signature (message `MtPelerin-{code}`, the receiving address, the delivery chain), signs it with
// the DEVICE key on approve (the only signature a plain buy needs, plan §2.2), and opens the
// prefilled widget externally. Facts about the provider are disclosed verbatim + dated; the
// provider is named as the counterparty; no "best" label, no referral parameter (§4).
//
// MOUNT POINT: the Wallet ROOT (the TxnReceipt discipline) — AppModal's web host is absolutely
// positioned against the nearest positioned ancestor, so a sheet mounted inside a list or a tab
// body clips to that box. Wallet owns the open state; every entry surface (HomeTab's Add-funds
// choice, FundingRoutes' provider row, DepositSheet's entry) routes into the same instance.
//
// CANCEL vs CLOSE: only the Cancel button rejects. Backdrop, Escape and Android Back close the
// sheet without a rejection — they dismiss, they do not answer the signature question. The typed
// error exists so the mounting Wallet (and tests) can tell a refusal from a dismissal.

/** The typed user-rejected outcome (the walletkit SDK's USER_REJECTED 5000 semantics, localized
 *  to this sheet): Cancel refused the validation signature — nothing was signed, nothing opened. */
export class MtpBuyUserRejected extends Error {
  constructor() {
    super('user rejected the Mt Pelerin validation signature');
    this.name = 'MtpBuyUserRejected';
  }
}

type OpenLink = (url: string) => Promise<void>;

/** The one place the widget URL leaves the app. The `__DPAY_TEST_MTP_OPEN` seam (the
 *  `__DPAY_TEST_DEEPLINK` pattern) lets the flow harness answer success AND failure
 *  deterministically; production never sets it and rides Linking. The cash-out sheet's
 *  handoff opens through the same helper (ONE seam, ONE open path per venue). */
export function openWidgetUrl(url: string): Promise<void> {
  const seam = (globalThis as {__DPAY_TEST_MTP_OPEN?: OpenLink}).__DPAY_TEST_MTP_OPEN;
  return seam ? seam(url) : Linking.openURL(url);
}

export function MtpBuySheet({identity, token, onClose, onReject, onWidgetOpened}: {
  identity: Identity;
  /** The asset to buy (their `bdc` crypto code) — the opener resolved it through
   *  `mtpBuyEligible`, so a delivery chain always exists. */
  token: MtpBuyAsset;
  onClose: () => void;
  /** Cancel observes the typed user-rejected error. Absent = Cancel simply closes. */
  onReject?: (e: MtpBuyUserRejected) => void;
  /** Fired once the widget link OPENED — the mounting Wallet arms the on-return refresh with it. */
  onWidgetOpened?: () => void;
}) {
  // The device EVM keypair: the address IS the validation subject, the private key signs. Derived
  // once; the approval re-derives for the sign so the raw key never sits in state.
  const kp = useMemo(() => {
    try { return deriveEvmKeypair(identity.secretHex); }
    catch (e) { console.warn('deriveEvmKeypair failed (buy sheet):', e instanceof Error ? e.message : String(e)); return null; }
  }, [identity.secretHex]);
  const shown = kp != null ? toChecksumAddress(kp.address) : null;

  // The per-address validation code. The persisted salt is the collision fallback (codeSalts.ts):
  // this sheet only READS it — with one device address there is no second address to collide
  // against, and a future multi-address wallet (or the R2 cash-out flow) owns the write.
  const [code, setCode] = useState<number | null>(null);
  useEffect(() => {
    if (kp == null) return;
    let alive = true;
    loadValidationSalt(kp.address)
      .then(salt => { if (alive) setCode(deriveValidationCode(kp.address, salt ?? undefined)); })
      .catch(() => { if (alive) setCode(deriveValidationCode(kp.address)); });
    return () => { alive = false; };
  }, [kp]);

  // Delivery chains for this asset, first entry the default (ZCHF: Ethereum; USDC: Arbitrum One
  // then Ethereum, the MTP_ASSET_DELIVERY order). One chain renders no picker at all.
  const chains = useMemo(() => [...mtpDeliveryChains(token)], [token]);
  const [chain, setChain] = useState<MtpDeliveryChainId>(chains[0]);
  const chainName = EVM_CHAINS[chain as EvmChainId]?.name ?? String(chain);

  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [opened, setOpened] = useState(false);

  useEscapeToClose(onClose);

  const approve = useCallback(async () => {
    if (kp == null || code == null || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const hash = signPersonalBase64(kp.privateKey, validationMessage(code));
      const url = buildMtpWidgetLink({asset: token, deliveryChain: chain, address: shown ?? kp.address, code, hash});
      await openWidgetUrl(url);
      setOpened(true);
      onWidgetOpened?.();
    } catch {
      // Open failure keeps the sheet with the failed-link note (the TrustWalletFundButton
      // pattern) — the signature already happened, only the hand-off failed, and a retry is one
      // tap away. A fresh sign per attempt: same inputs, same bytes (RFC 6979).
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, [kp, code, busy, token, chain, shown, onWidgetOpened]);

  const cancel = useCallback(() => {
    onReject?.(new MtpBuyUserRejected());
    onClose();
  }, [onReject, onClose]);

  return (
    <AppModal onRequestClose={onClose}>
      <Pressable style={S.pickBackdrop} onPress={onClose}>
        <View testID="mtp-buy-sheet" style={S.pickCard} onStartShouldSetResponder={() => true}>
          <ScrollView style={S.pickScroll}>
            <Text style={S.pickTitle}>{M.deposit.mtp.sheetTitle}</Text>
            <Text style={S.receiptNote}>{M.deposit.mtp.buyLine('CHF', token, chainName)}</Text>

            {opened ? (
              <>
                <Text testID="mtp-opened" style={S.receiptNote}>{M.deposit.mtp.openDone}</Text>
                <Pressable
                  testID="btn-mtp-close"
                  style={S.primaryWide}
                  onPress={onClose}
                  accessibilityRole="button"
                  accessibilityLabel={M.common.done}
                  accessibilityState={{disabled: false}}>
                  <Text style={S.primaryText}>{M.common.done}</Text>
                </Pressable>
              </>
            ) : (
              <>
                {/* The review line: the exact message the device key signs, the address it
                    proves, the chain the buy delivers to (plan R1 step 3). */}
                <Text style={S.depositStatusTitle}>{M.deposit.mtp.signHeadline}</Text>
                <View style={S.receiptField}>
                  <Text style={S.receiptLabel}>{M.deposit.mtp.messageLabel}</Text>
                  <Text testID="mtp-review-message" style={S.receiptValue} selectable>{code != null ? validationMessage(code) : '…'}</Text>
                </View>
                <View style={S.receiptField}>
                  <Text style={S.receiptLabel}>{M.deposit.mtp.addressLabel}</Text>
                  <Text testID="mtp-review-address" style={S.receiptValue} selectable>{shown ?? '…'}</Text>
                </View>
                <View style={S.receiptField}>
                  <Text style={S.receiptLabel}>{M.deposit.mtp.chainLabel}</Text>
                  <Text testID="mtp-review-chain" style={S.receiptValueSans}>{chainName}</Text>
                </View>

                {/* USDC delivers on two chains — the one choice the sheet asks for. ZCHF has
                    exactly one and renders no picker. */}
                {chains.length > 1 ? (
                  <ModeToggle
                    testID="mtp-chain-toggle"
                    value={String(chain)}
                    onChange={v => setChain(Number(v) as MtpDeliveryChainId)}
                    left={{label: EVM_CHAINS[chains[0] as EvmChainId]?.name ?? String(chains[0]), value: String(chains[0]), testID: `mtp-chain-${chains[0]}`}}
                    right={{label: EVM_CHAINS[chains[1] as EvmChainId]?.name ?? String(chains[1]), value: String(chains[1]), testID: `mtp-chain-${chains[1]}`}}
                  />
                ) : null}

                <Pressable
                  testID="btn-mtp-sign"
                  style={[S.primaryWide, (busy || code == null || kp == null) && S.dim]}
                  onPress={() => { void approve(); }}
                  disabled={busy || code == null || kp == null}
                  accessibilityRole="button"
                  accessibilityLabel={M.deposit.mtp.approve}
                  accessibilityState={{disabled: busy || code == null || kp == null}}>
                  {busy
                    ? <ActivityIndicator size="small" color={C.brandInk} />
                    : <Text style={S.primaryText}>{M.deposit.mtp.approve}</Text>}
                </Pressable>
                {failed ? <Text testID="mtp-err" style={S.err}>{M.deposit.mtp.openFailed}</Text> : null}
                <Pressable
                  testID="btn-mtp-cancel"
                  style={S.ghostBtn}
                  onPress={cancel}
                  accessibilityRole="button"
                  accessibilityLabel={M.deposit.mtp.cancel}
                  accessibilityState={{disabled: false}}>
                  <Text style={S.ghostBtnText}>{M.deposit.mtp.cancel}</Text>
                </Pressable>
              </>
            )}

            {/* The provider's own published figures, verbatim + dated (plan §2.2), the counterparty
                disclosure, and the bought-ETH fact. No rate is computed, no figure blended. */}
            <View testID="mtp-fees" style={S.instrCard}>
              <Text style={S.depositStatusTitle}>{M.deposit.mtp.feesTitle}</Text>
              <Text style={S.instrMeta}>{M.deposit.mtp.feeBank}</Text>
              <Text style={S.instrMeta}>{M.deposit.mtp.feeCard}</Text>
              <Text style={S.instrMeta}>{M.deposit.mtp.feeDelivery}</Text>
              <Text style={S.instrMeta}>{M.deposit.mtp.holdUnverified}</Text>
              <Text style={S.instrMeta}>{M.deposit.mtp.ethGasNote}</Text>
              <Text style={S.dim2}>{M.deposit.mtp.feesAsOf(formatMonthDayYear(new Date(MTP_FACTS_READ_ON)))}</Text>
            </View>
            <Text testID="mtp-counterparty" style={S.dim2}>{M.deposit.mtp.counterparty}</Text>
          </ScrollView>
        </View>
      </Pressable>
    </AppModal>
  );
}
