import {useEffect, useMemo, useRef, useState} from 'react';
import {View, Text, Pressable, TextInput, Platform, type TextStyle} from 'react-native';
import {QrCode} from './QrCode';
import {C, FONT} from '../config/palette';
import {S} from '../styles';
import {EXPIRY_WINDOW, NFC_UPDATE_AHEAD_S, POLL, PROOF_POLL_BUDGET, QR_SIZE} from '../config/constants';
import {toUnits, randNonceHex, nowSecs} from '../lib/format';
import {encodePayLink, shareOrigin, decodeReceiptDeeplink, parseRailProof} from '../lib/deepLink';
import {type CurrencyDescriptor, type FamilyDisplay, fmtCurrencyAmount, currencySymbol, depositMechanism, isTestnetCurrency} from '../config/catalog';
import {linkNetworkOf, type SelectableAsset} from '../config/assets';
import {type HomeCurrency, currencyRails} from '../config/currency';
import {type BalanceView} from '../lib/assetBalances';
import type {Identity, AssetId, NfcStatus} from '../lib/types';
import {qrPayloadToEnvelopeHex, submitAndConfirmIncomingTransfer, confirmIncomingTransfer} from '../services/rail';
import {saveTxNote} from '../services/txNotes';
import {DpayCore, DpayNfc} from '../services/native';
import {icStampExpiry} from '../services/icp';
import {NfcTap} from './NfcTap';
import {NfcStatusRow} from './NfcStatusRow';
import {QrScanner} from './QrScanner';
import {NfcIcon} from './NfcIcon';
import {ModeToggle} from './ModeToggle';
import {TillCharge} from './TillCharge';
import {DepositSheet} from './DepositSheet';
import {CkErc20DepositSheet} from './CkErc20DepositSheet';
import {IcrcDepositSheet} from './IcrcDepositSheet';
import {FundingRoutes} from './FundingRoutes';
import {RailDisclosure} from './RailDisclosure';
import {AssetPicker} from './AssetPicker';
import {AssetSwitchRow} from './AssetSwitchRow';
import {useReportLock} from '../hooks/useReportLock';
import {useShareFeedback, shareConfirmLabel} from '../hooks/useShareFeedback';
import {useJourney} from '../lib/journey';
import {awardPaymentTested} from '../lib/readiness';
import {CoachTip} from './CoachTip';
import {IconCheck, IconChevronDown, IconClock, IconQr, IconShare, IconWifiOff} from './icons';
import {M} from '../i18n';

// The optional merchant memo input — a real secondary field (not a bare text link), mirroring the
// paste-button affordance pattern (44pt-min touch target + a visible border). Inline (Group E owns
// styles.ts as ONE block): Traveler Paper input idiom — white field + hairline line2 border +
// Space Grotesk, matching usernameInput/withdrawAddrInput (the old dark-theme transparent-bg +
// heavy sub2 outline read as a stray box on porcelain). Full-width (alignSelf stretch so it lines
// up with the amount row above and the Request button below — was a narrower maxWidth:320 that
// left the field floating shorter than its neighbors), 44pt-min.
// A FUNCTION, not a const: `C` is mutated in place on a theme flip, so a module-level style
// object froze the light theme's white field + near-black ink into the dark theme's memo input.
const memoInputStyle = (): TextStyle => ({alignSelf: 'stretch', marginTop: 14, minHeight: 44, backgroundColor: C.card, borderWidth: 1, borderColor: C.line2, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16, color: C.ink, fontFamily: FONT.sans});

export function ReceiveMode({identity, relayUrl, online, nfcStatus, onReceived, catalog, depositCurrency, depositDisplay, depositChainId, depositNativeEth, subMode, onSubModeChange, codeForm, onCodeFormChange, tillAvailable, depositReturnLabel = null, onReturnFromDeposit, prefillReceipt, onReceiptConsumed, selectedCurrency, assets, selectedAssetId, balances, onSelectAsset, onLockChange, homeCurrency = null, onReceiveRailChange}: {identity: Identity; relayUrl: string; online: boolean; nfcStatus: NfcStatus; onReceived: () => void; catalog: CurrencyDescriptor[]; depositCurrency: number; depositDisplay: FamilyDisplay | null; depositChainId: number | null; depositNativeEth: boolean; subMode: 'request' | 'address'; onSubModeChange: (m: 'request' | 'address') => void; codeForm: 'dpay' | 'till'; onCodeFormChange: (f: 'dpay' | 'till') => void; tillAvailable: boolean; depositReturnLabel?: string | null; onReturnFromDeposit?: () => void; prefillReceipt?: string | null; onReceiptConsumed?: () => void; selectedCurrency: number; assets: SelectableAsset[]; selectedAssetId: AssetId | null; balances: Record<AssetId, BalanceView>; onSelectAsset: (id: AssetId) => void; onLockChange?: (locked: boolean) => void; homeCurrency?: HomeCurrency | null; onReceiveRailChange?: (id: AssetId) => void}) {
  // The within-tab sub-mode is OWNED by Wallet so deeplinks (?screen=deposit, auto-open-ckERC20) can
  // land the user directly on "My address". "request" = the dpay-to-dpay payment-request QR;
  // "address" = the on-chain deposit flow. The toggle renders whenever this asset HAS a deposit —
  // `depositMechanism(...) !== 'none'`, the same switch that picks the sheet behind it (founder hard
  // rule 2026-08-29: every asset gives real top-up instructions, never a hidden surface or a "check
  // back soon" dead end).
  //
  // Phase 4 (2026-08-12 unified asset selection rewrite): the merchant's chosen settlement asset
  // arrives as the `selectedCurrency` PROP from Wallet's single owned `selectedAssetId` — there is
  // NO local `reqCurrency` state anymore. The amount-prefix picker opens the unified `AssetPicker`,
  // whose `onSelect(id)` is Wallet's `handleSelect` (the same dispatch Balances uses). Selecting a
  // SOL/USDC asset flips the rail via Wallet's reconcileSelectedAsset + re-mounts SolReceiveMode.

  // WHY THE 4-STATE STATUS AND NOT A BOOLEAN. The radio is either usable or it is not, but the
  // three ways it can be unusable send the merchant to three different places — turn NFC on in
  // settings, accept that this phone has no NFC hardware, or find out why the probe failed. This
  // screen takes the whole state and hands it to `NfcStatusRow`, which owns those instructions for
  // every surface in the app; the boolean below is only the local "is a tap possible" gate.
  const nfcReady = nfcStatus === 'ready';
  const [amount, setAmount] = useState('');
  // Trip Ready J5b — paymentTested: awarded once at the FIRST confirmed Received (either
  // confirmed setResult branch). journeyRef keeps the award reading the FRESH journey without
  // re-subscribing the effects below (same pattern as PayMode).
  const {journey} = useJourney();
  const journeyRef = useRef(journey);
  journeyRef.current = journey;
  const [memo, setMemo] = useState('');
  // `rawAmount` (was `cents`) is the integer smallest-units the encoded request carries (2-decimal
  // for DEMO, 8 for BTC, 6 for USDC) — now a raw-u64 decimal STRING (MC1 units 2-4). Renamed because
  // the field was never truly cents for a non-USD currency; this is more honest.
  const [reqQr, setReqQr] = useState<{value: string; rawAmount: string; currency: number; nonce: string; nfcHex: string | null; nfcExpiry: number | null; expiry: number} | null>(null);
  // A 1s display clock so the request-QR screen can show a live expiry countdown (the signed request
  // is only valid for EXPIRY_WINDOW secs; a stale QR scans to a confusing rejection). Declared here;
  // the ticking effect is wired after `result` (the gate it reads) is declared below.
  const [now, setNow] = useState(() => nowSecs());
  const [result, setResult] = useState<{amount: string; currency: number; from: string} | null>(null);
  const [scanning, setScanning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [nfcActive, setNfcActive] = useState(false);
  const [nfcKey, setNfcKey] = useState(0);
  // The unified asset picker (opened by tapping the amount prefix). Phase 4: replaced the old
  // local CurrencyPicker + the SOL-onSelectSol bridge — AssetPicker is the ONE picker both Receive
  // forms + Balances consume, with Wallet's handleSelect as its onSelect. Esc/backdrop close it
  // (AssetPicker owns useEscapeToClose internally).
  const [pickOpen, setPickOpen] = useState(false);

  // U-F1 — visible confirmation after the share resolves (the DepositSheet copy pattern, via the
  // share sibling of useCopyFeedback). Dismissed sheets leave the label honest.
  const {shared, share} = useShareFeedback();

  // This wallet's own ICRC-1 account — the destination a shared payment link names. Derived LOCALLY
  // by the core (no gateway round trip), once per identity; the same principal the Receive ▸ My
  // address surface shows, so a user has ONE address, not one per surface.
  const [selfPrincipal, setSelfPrincipal] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    DpayCore.icpSelfPrincipal(identity.secretHex)
      .then(p => { if (alive) setSelfPrincipal(p); })
      .catch((e: unknown) => { console.warn('icpSelfPrincipal failed (no share link):', e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [identity.secretHex]);

  // A till charge is LIVE on the relay: a code is out there that a customer can pay. Reported by
  // TillCharge (which owns the charge) and folded into the lock below, because everything that is
  // true of an open request QR is true of it — plus one thing that is not: the charge outlives this
  // screen, so navigating away leaves money payable with nobody watching. That is why the toggles
  // above it are hidden while it is live, exactly as they are while a request QR is up.
  const [tillLive, setTillLive] = useState(false);

  // A capability can drop under the merchant (a relay retarget, or a relay that stops serving the
  // till), and `codeForm` outlives it — it is owned by the wallet so a rail switch cannot lose it.
  // Left stale, the toggle comes back reading "Till code" over a dpay request form: a mode the
  // merchant is in without having chosen it. The reset belongs HERE and not beside the capability
  // probe because `tillLive` is only known here — and it cannot un-mount a charge, live or ended:
  // in the very state it runs in (`!tillAvailable && !tillLive`) the render below has already
  // replaced the till form with the dpay one, so this only makes the state agree with the screen.
  useEffect(() => {
    if (tillAvailable || tillLive || codeForm !== 'till') return;
    onCodeFormChange('dpay');
  }, [tillAvailable, tillLive, codeForm, onCodeFormChange]);

  // Phase 5 — lock the idle asset selection while a request QR is showing or a settlement result is
  // displayed. Both hold an in-flight request the user must not lose to an asset switch (the QR is the
  // encoded request a payer is scanning; the result is the settled outcome). The idle form is free.
  const locked = !!reqQr || !!result || tillLive;
  useReportLock(onLockChange, locked);

  // Tick the display clock only while a request QR is shown (not after settlement) — display-only,
  // so a plain setInterval (not the network POLL seam) is the right cadence for a countdown.
  useEffect(() => {
    if (!reqQr || result) return;
    const id = setInterval(() => setNow(nowSecs()), 1000);
    return () => clearInterval(id);
  }, [reqQr, result]);
  // Stable across renders (NfcTap's effect depends on it) — only changes when the request does.
  const readerReqInfo = useMemo(
    () => (reqQr ? {amount: reqQr.rawAmount, nonce: reqQr.nonce, who: M.receive.payer, currency: reqQr.currency} : undefined),
    [reqQr],
  );

  // Resolve the selected asset's display config ONCE per render. Decimals come from the catalog
  // descriptor directly (NOT familyDisplay, which falls back to BTC's 8 + would mis-render DEMO's
  // 2). The amount-input prefix is the currency's display glyph (∂/₿/$) via currencySymbol.
  const reqDesc = catalog.find(c => c.currency === selectedCurrency);
  const reqDecimals = reqDesc?.decimals ?? 2;
  const reqPrefix = currencySymbol(catalog, selectedCurrency);

  // The shareable payment link for the OPEN request — the same payment the QR encodes, in the URL
  // form a chat app can carry. `amount` is the merchant's own typed decimal (what they see is what
  // they share); `ref` is this request's nonce, which is also the on-chain memo the settlement poll
  // below matches, so a link payment reconciles exactly like a scanned one. Null (and the button
  // hidden) when the asset cannot be named in a link or the principal has not derived yet — a link
  // that cannot name its destination or its asset must never be produced.
  // The asset this whole tab is about — the merchant's chosen settlement asset. Read once and used
  // by both code forms: the dpay link names it, and the till answers whether a charge can be rung
  // up in it at all.
  const activeAsset = assets.find(a => a.id === selectedAssetId) ?? null;
  const payLink = useMemo(() => {
    if (!reqQr || selfPrincipal == null || activeAsset == null || activeAsset.linkToken == null) return null;
    return encodePayLink(shareOrigin(), {
      recipient: selfPrincipal,
      asset: activeAsset.linkToken,
      network: linkNetworkOf(activeAsset),
      amount: amount.trim(),
      label: identity.username,
      memo: memo.trim(),
      ref: reqQr.nonce,
    });
  }, [reqQr, selfPrincipal, activeAsset, amount, identity.username, memo]);

  async function makeRequest() {
    const rawAmount = toUnits(amount, reqDecimals);
    if (!rawAmount || rawAmount === '0') return;
    try {
      const nonce = randNonceHex();
      const expiry = nowSecs() + EXPIRY_WINDOW;
      // The merchant's own username rides as `to_name`; the optional memo is attached verbatim. Both
      // now live INSIDE the 132-byte request (wire-format v2) — the QR is plain base64url (no `|name`).
      const memoVal = memo.trim();
      const reqB64 = await DpayCore.encodeRequest(identity.publicHex, rawAmount, nonce, expiry, selectedCurrency, identity.username, memoVal);
      // Build the NFC request too so reader mode can start alongside the QR (best-effort). The
      // merchant's username + memo ride as to_name/memo in the request bytes, same as the QR path.
      let nfcHex: string | null = null;
      let nfcExpiry: number | null = null;
      if (nfcReady && DpayNfc) {
        try {
          const nfcExpiryNs = await icStampExpiry(identity.secretHex, NFC_UPDATE_AHEAD_S);
          nfcExpiry = Number(BigInt(nfcExpiryNs) / 1_000_000_000n);
          nfcHex = await DpayNfc.buildRequest(identity.publicHex, rawAmount, nonce, nfcExpiry, selectedCurrency, identity.username, memoVal);
        } catch (e) {
          console.warn('NFC certified expiry unavailable (QR still works):', e instanceof Error ? e.message : String(e));
        }
      }
      setReqQr({value: reqB64, rawAmount, currency: selectedCurrency, nonce, nfcHex, nfcExpiry, expiry});
      // Payee-side annotation (services/txNotes): when the payee typed a memo for this request,
      // save it keyed by the request nonce (= the on-chain memo) so the INCOMING row can show the
      // message the moment it settles. Deliberately NO `who` — the counterparty is the payer, and
      // the IC rail carries no payer name; the row keeps the payer's principal prefix (honest).
      if (memoVal) void saveTxNote(identity.publicHex, {k: nonce, msg: memoVal}, Date.now());
      setResult(null); setErr(null);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  // Receipt hand-back (dpay:pay/): a payer who settled ONLINE (NFC unavailable) shares the rail
  // proof {ledger, block_index, request_id} back as a `dpay:pay/<blob>` link. The blob codec
  // (receiptShareBlob) is opaque JSON. DEEPLINK TRUST MODEL (F2/F6, 2026-08-20 — was: the blob was
  // trusted after format validation, rendering instant "Received"): the proof is an UNTRUSTED,
  // FORGEABLE string. Format-check it, then confirm the exact open request by recipient + currency +
  // amount + nonce in durable ledger history. The proof itself can never fabricate settlement.
  useEffect(() => {
    if (prefillReceipt == null) return;
    const blob = prefillReceipt;
    onReceiptConsumed?.();
    let alive = true;
    (async () => {
      try {
        const text = blob.trim();
        // The payer's share is base64url(JSON) (receiptShareBlob — what Share actually hands
        // over); a raw-JSON blob is still accepted for hand-typed/legacy links. The codec never
        // throws; null on both paths = malformed.
        const proof = decodeReceiptDeeplink(text) ?? (text.includes('{')
          ? (JSON.parse(text.slice(text.indexOf('{'))) as {request_id?: unknown; block_index?: unknown})
          : null);
        if (!proof) { if (alive) setErr(M.receive.receiptMalformed); return; }
        if (!reqQr) {
          // No open request to bind against (cold launch): the proof is unverifiable HERE — there
          // is no request whose settlement this screen could confirm, and no honest amount to
          // show. Never fabricate a "Received", never fire onReceived (nothing was verified).
          // Log it; if a request screen is open elsewhere it stays untouched.
          console.warn('rail-proof deeplink ignored: no open request to verify it against');
          return;
        }
        const parsed = parseRailProof(proof);
        if (!parsed) { if (alive) setErr(M.receive.receiptMismatch); return; }
        const settled = await confirmIncomingTransfer({
          relayUrl,
          receiverPublicHex: identity.publicHex,
          currency: reqQr.currency,
          amount: reqQr.rawAmount,
          memoHex: reqQr.nonce,
        }, {attempts: PROOF_POLL_BUDGET, intervalMs: POLL.receiptRcv});
        if (!alive) return;
        if (settled) {
          setResult({amount: reqQr.rawAmount, currency: reqQr.currency, from: M.receive.payer});
          onReceived();
          awardPaymentTested(journeyRef.current);
        } else {
          setErr(M.receive.couldNotConfirmYet);
        }
      } catch (e) {
        if (alive) setErr(M.receive.receiptUnreadable);
        console.warn('receipt deeplink hand-back failed:', e instanceof Error ? e.message : String(e));
      }
    })();
    // See the settlement-poll effect for the capture-at-fire-time rationale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillReceipt]);

  async function onSignedQr(raw: string) {
    setScanning(false);
    setErr(null);
    try {
      // The payer's signed QR IS the /call envelope (base64url). Submit the immutable bytes, then
      // prove this exact request from the receiver's durable ledger history.
      const envelopeHex = qrPayloadToEnvelopeHex(raw);
      if (!envelopeHex) { setErr(M.pay.notAPaymentCode); return; }
      const ledger = catalog.find(c => c.currency === reqQr?.currency)?.ledger ?? '';
      if (!ledger || !reqQr) { setErr(M.receive.unknownLedger); return; }
      const settled = await submitAndConfirmIncomingTransfer(ledger, envelopeHex, {
        relayUrl,
        receiverPublicHex: identity.publicHex,
        currency: reqQr.currency,
        amount: reqQr.rawAmount,
        memoHex: reqQr.nonce,
      }, {attempts: PROOF_POLL_BUDGET, intervalMs: POLL.receiptRcv});
      if (settled) {
        setResult({amount: reqQr.rawAmount, currency: reqQr.currency, from: M.receive.payer});
        onReceived();
        awardPaymentTested(journeyRef.current);
      } else {
        setErr(M.receive.couldNotConfirmYet);
      }
    } catch (e) { console.warn('envelope submit failed:', e instanceof Error ? e.message : String(e)); setErr(M.receive.couldNotSubmit); }
  }

  function reset() { setReqQr(null); setResult(null); setScanning(false); setErr(null); setMemo(''); setNfcActive(false); setNfcKey(k => k + 1); }

  // While an NFC tap is mid-flow, let its exact history check own the screen rather than swapping
  // in the generic result view underneath it.
  if (result && !nfcActive) {
    return (
      <View style={S.center}>
        <View style={S.check}><IconCheck size={44} color={C.brandInk}/></View>
        <Text style={S.paidText}>{M.receive.receivedAmount(fmtCurrencyAmount(catalog, result.currency, result.amount))}</Text>
        <Text style={S.paidSub}>{M.receive.fromWho(result.from)}</Text>
        <Pressable style={[S.ghostBtn, S.ghostBtnMuted]} onPress={reset} accessibilityRole="button" accessibilityLabel={M.receive.newRequest} accessibilityState={{disabled: false}}><Text style={S.ghostBtnText}>{M.receive.newRequest}</Text></Pressable>
      </View>
    );
  }

  if (reqQr) {
    const nfcUsable = !!reqQr.nfcHex && reqQr.nfcExpiry !== null && now < reqQr.nfcExpiry;
    // Expiry prevents NEW taps, but an exchange that already delivered its bundle must stay mounted
    // until the merchant returns the authenticated result (including a result-only re-tap).
    const nfcSessionOpen = nfcUsable || nfcActive;
    return (
      <View style={S.center}>
        {/* Reader mode runs in the background while the QR is shown: the payer taps OR scans. */}
        {nfcSessionOpen && reqQr.nfcHex && nfcReady && DpayNfc ? (
          <NfcTap
            key={nfcKey} role="reader" identity={identity} relayUrl={relayUrl} requestHex={reqQr.nfcHex!}
            reqInfo={readerReqInfo}
            catalog={catalog}
            onSettled={onReceived} onActive={() => setNfcActive(true)}
            onClose={() => { setNfcActive(false); reset(); }}
          />
        ) : null}
        {!nfcActive ? (
          <>
            {/* TWO DIFFERENT QUESTIONS, one line. With a working radio the only thing left to say
                is whether THIS code can be tapped — live, lapsed, or never built (the certified
                expiry stamp needs the network, so an offline request is a QR-only code). With a
                radio that is off, absent or unreadable the question is about the PHONE, and each of
                those three has a different instruction attached, which is the whole reason
                `NfcStatusRow` takes the 4-state status instead of the boolean this screen used to
                be handed. WEB IS NEITHER: there is no radio to report on and nothing the operator
                could switch on, and the row's own web branch is a PAY-screen label ("Scan to pay")
                that would replace the merchant's instruction with the customer's on the merchant's
                own screen. So the desktop wallet keeps the per-request line. */}
            {nfcReady || Platform.OS === 'web' ? (
              <View style={S.nfcHintRow}>
                {nfcUsable ? <NfcIcon color={C.brandText} size={18} /> : null}
                <Text style={S.nfcHintLabel}>{M.receive.showToPayer(nfcUsable ? 'tap' : reqQr.nfcHex ? 'expired' : 'none')}</Text>
              </View>
            ) : (
              <NfcStatusRow nfcStatus={nfcStatus} testID="receive-nfc" />
            )}
            <View testID="request-qr" style={S.qrCard}><QrCode value={reqQr.value} size={QR_SIZE} ecl="M" /></View>
        <Text style={S.amountBig}>{fmtCurrencyAmount(catalog, reqQr.currency, reqQr.rawAmount)}</Text>
        {(() => {
          const remaining = reqQr.expiry - now;
          if (remaining <= 0) return <Text style={S.qrExpired}>{M.receive.expiredMakeNew}</Text>;
          const m = Math.floor(remaining / 60);
          const s = remaining % 60;
          // While there's a minute+ of headroom, show the calm "~N min" form; under a minute, count
          // down seconds (and tint red) so the merchant knows to refresh before a payer scans a stale QR.
          // P3 — a small clock icon leads the validity line (QR-card polish; no layout change near
          // the QrCode itself — this sits below the amount, outside the white card).
          if (m >= 1) return (
            <View style={{flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6}}>
              <IconClock size={14} color={C.sub}/>
              <Text style={[S.qrExpiry, {marginTop: 0}]}>{M.receive.validForMin(m)}</Text>
            </View>
          );
          return <Text style={S.qrExpiryWarn}>{M.receive.expiresIn(s.toString().padStart(2, '0'))}</Text>;
        })()}
        <Text style={S.qrHint}>{M.receive.waitingForPayment(online)}</Text>
        {/* Offline honesty (IC rail): the merchant cannot submit a handed envelope or check ledger
            history while offline. Payer-online payments still land directly and reconcile on the
            next balance refresh — but envelope handoffs need connectivity. */}
        {!online ? (
          <View style={S.qrOfflinePill}>
            <IconWifiOff size={14} color={C.bad}/>
            <Text style={S.qrOfflinePillText}>{M.receive.offlineCantSubmit}</Text>
          </View>
        ) : null}
            {/* Trip Ready J4 — the request-QR first-use tip: what this code is and who settles it.
                Mounted in the reading zone (right after the status lines, before the action
                cluster) so it is seen without scrolling on a phone viewport; inline, never blocks
                the QR or the scan path. */}
            <CoachTip tipKey="receiveRequest" />
            {/* Share this request as a PAYMENT LINK so a payer far away (no camera, over a messaging
                app) can open it and land on a pre-filled review — the payer still taps Approve. The
                link names this wallet's own ICRC-1 account, the exact asset + settlement chain, and
                carries the request nonce as `ref`, so a payment of it reconciles on THIS request
                screen. Paying it twice pays twice — the ledger has no duplicate check here
                (`icp_transfer_arg` in dpay-ffi). */}
            {payLink ? (
            <Pressable
              testID="btn-share-request"
              style={S.ghostBtn}
              onPress={() => {
                share(payLink);
              }}
              accessibilityRole="button"
              accessibilityLabel={M.receive.shareRequestLink}
              accessibilityHint={M.receive.shareRequestHint}
              accessibilityState={{disabled: false}}>
              <IconShare size={16} color={C.sub}/>
              <Text style={S.ghostBtnText}>{shared ? shareConfirmLabel(M.pay.linkCopied) : M.receive.shareRequestLink}</Text>
            </Pressable>
            ) : null}
            {scanning ? (
              <><QrScanner onScan={onSignedQr} /><Text style={S.dim2}>{M.receive.scanPayerSignedQrPrompt}</Text></>
            ) : (
              <>
                <Pressable style={S.ghostBtn} onPress={() => setScanning(true)} accessibilityRole="button" accessibilityLabel={M.receive.scanPayerSignedQr} accessibilityHint={M.receive.scanPayerSignedQrHint} accessibilityState={{disabled: false}}><IconQr size={16} color={C.sub}/><Text style={S.ghostBtnText}>{M.receive.scanPayerSignedQr}</Text></Pressable>
                <Text style={S.dim2}>{M.receive.confirmWithTheirPhone}</Text>
              </>
            )}
            {err ? <Text style={S.err}>{err}</Text> : null}
            <Pressable style={[S.ghostBtn, S.ghostBtnMuted]} onPress={reset} accessibilityRole="button" accessibilityLabel={M.receive.newRequest} accessibilityState={{disabled: false}}><Text style={S.ghostBtnText}>{M.receive.newRequest}</Text></Pressable>
          </>
        ) : null}
      </View>
    );
  }

  // "My address" sub-mode: render the on-chain deposit flow INLINE for the active IC asset.
  //
  // ONE switch decides everything here — `depositMechanism`, the catalog's own answer to "how does
  // money get in for this row" (config/catalog.ts owns the four answers and why they are not
  // interchangeable). It picks the sheet AND is handed to the sheet's funding card, so the
  // instruction is written from the mechanism that is actually running. This used to be three
  // separate conditions and they disagreed: a two-rail HOME-currency group resolved FIRST, so on a
  // USD wallet ckUSDC — the DEFAULT rail — took the direct-ICRC sheet, which meant the Ethereum
  // minter route was unreachable from Receive at all, and the funding card underneath it offered to
  // buy USDC and send it to the Internet Computer principal on screen. Nothing is lost by letting
  // the family win: `CkErc20DepositSheet` carries the ICRC-transfer route itself
  // (`IcrcAccountSection`), so it is the strictly richer of the two, and the rail disclosure below
  // is keyed on the GROUP rather than on the sheet, so it still renders.
  //
  // A complete no-minter direct-ICRC row (VCHF/ICP/VEUR) → IcrcDepositSheet: the user's own ICRC-1
  // principal with real top-up instructions (founder hard rule 2026-08-29 — no "check back soon"
  // dead ends). The toggle above lets the user flip back to "Request payment". The sheets are
  // inline-only (no overlay chrome — the tab body provides the surface).
  const homeRails = homeCurrency != null ? currencyRails(homeCurrency, assets) : [];
  const homeRailShown = homeRails.length === 2 ? homeRails.find(r => r.id === selectedAssetId) ?? null : null;
  const depositDesc = catalog.find(c => c.currency === depositCurrency) ?? null;
  const mechanism = depositMechanism(depositDesc);
  // The funding card, built ONCE from the mechanism that chose the sheet below. Each sheet decides
  // WHERE to place it and in which phase — a completed deposit must not be asked "don't have any
  // yet?" — but none of them assembles one, so none can describe a deposit it does not implement.
  const fundingCard = activeAsset != null ? (
    <FundingRoutes
      asset={activeAsset}
      isTestnet={depositDesc !== null && isTestnetCurrency(depositDesc)}
      mechanism={mechanism}
      homeCurrency={homeCurrency}
    />
  ) : null;
  const addressSheet =
    mechanism === 'evm-wallet' || mechanism === 'evm-wallet-native' ? (
      depositDisplay ? (
        <CkErc20DepositSheet
          identity={identity}
          relayUrl={relayUrl}
          currency={depositCurrency}
          decimals={depositDesc?.decimals ?? depositDisplay.amountDecimals}
          display={depositDisplay}
          chainId={depositChainId}
          nativeEth={depositNativeEth}
          ledger={depositDesc?.ledger ?? ''}
          icSymbol={depositDesc?.wrapper_name ?? depositDesc?.symbol ?? ''}
          funding={fundingCard}
          onClose={() => onSubModeChange('request')}
        />
      ) : null
    ) : mechanism === 'send-to-address' ? (
      depositDisplay ? (
        <DepositSheet
          identity={identity}
          relayUrl={relayUrl}
          catalog={catalog}
          currency={depositCurrency}
          display={depositDisplay}
          funding={fundingCard}
          onClose={() => onSubModeChange('request')}
        />
      ) : null
    ) : mechanism === 'icrc-transfer' && activeAsset ? (
      <IcrcDepositSheet
        identity={identity}
        catalog={catalog}
        asset={activeAsset}
        funding={fundingCard}
        onClose={() => onSubModeChange('request')}
      />
    ) : null;
  if (subMode === 'address' && addressSheet) {
    return (
      <View style={S.centerTop}>
        <ModeToggle
          testID="receive-mode-toggle"
          value={subMode}
          onChange={(v) => onSubModeChange(v as 'request' | 'address')}
          left={{label: M.receive.requestPayment, value: 'request', testID: 'btn-receive-request'}}
          right={{label: M.receive.myAddress, value: 'address', testID: 'btn-receive-address'}}
        />
        {/* One tap to any other asset's address, instead of four taps and a tab switch through the
            accounts route. `onReceiveRailChange` is the sub-mode-preserving selector — Wallet's
            ordinary handleSelect resets the sub-mode and would bounce the user to the request form. */}
        {activeAsset != null && onReceiveRailChange != null ? (
          <AssetSwitchRow
            asset={activeAsset}
            assets={assets}
            balances={balances}
            selectedId={selectedAssetId}
            homeCurrency={homeCurrency}
            onSelect={onReceiveRailChange}
          />
        ) : null}
        {homeRailShown != null && onReceiveRailChange != null ? (
          <RailDisclosure
            currency={homeCurrency!}
            assets={assets}
            balances={balances}
            catalog={catalog}
            selectedAssetId={selectedAssetId}
            onSwitch={onReceiveRailChange}
          />
        ) : null}
        {addressSheet}
        {/* Fund-funnel resume — rendered ONCE here rather than threaded into all three deposit
            sheets, because it is a property of the NAVIGATION (the user came from Pay and the
            money has since landed), not of any particular deposit rail. The SOL sheet owns its own
            copy for historical reasons; every IC sheet shares this one. Wallet decides WHEN it
            appears — only on a known-positive balance. */}
        {depositReturnLabel && onReturnFromDeposit ? (
          <Pressable
            testID="btn-ic-receive-return"
            style={[S.ghostBtn, S.ghostBtnMuted]}
            onPress={onReturnFromDeposit}
            accessibilityRole="button"
            accessibilityLabel={depositReturnLabel}
            accessibilityHint={M.deposit.sol.returnHint}
            accessibilityState={{disabled: false}}>
            <Text style={S.ghostBtnText}>{depositReturnLabel}</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  return (
    <View style={S.centerTop}>
      {/* The toggle offers "My address" exactly when a deposit exists to show — the SAME switch
          that picks the sheet, so the control and its destination cannot disagree. It was two other
          conditions (a family check OR a direct-ICRC check), which is how a third answer gets to differ from
          the first two. */}
      {mechanism !== 'none' && !tillLive ? (
        <ModeToggle
          testID="receive-mode-toggle"
          value={subMode}
          onChange={(v) => onSubModeChange(v as 'request' | 'address')}
          left={{label: M.receive.requestPayment, value: 'request', testID: 'btn-receive-request'}}
          right={{label: M.receive.myAddress, value: 'address', testID: 'btn-receive-address'}}
        />
      ) : null}
      {/* WHICH CODE, i.e. who can pay it — the same request, two audiences. A dpay code is the
          132-byte signed request another dpay wallet scans; a till code is this merchant's own
          OpenCryptoPay charge, which any wallet that speaks the standard could in principle scan.
          It is a code FORM and not a third tab because a till charge is not a third kind of
          receiving; the only reason it is a control at all is that two QR payloads cannot share one
          frame. Hidden while a charge is LIVE, exactly as the toggle above is while a request QR is
          up: flipping away would abandon a code a customer can still pay. */}
      {tillAvailable && !tillLive ? (
        <>
          <Text style={S.dim2}>{M.receive.till.codeForm}</Text>
          <ModeToggle
            testID="receive-code-form"
            value={codeForm}
            onChange={(v) => onCodeFormChange(v as 'dpay' | 'till')}
            left={{label: M.receive.till.dpayCode, value: 'dpay', testID: 'btn-code-dpay'}}
            right={{label: M.receive.till.tillCode, value: 'till', testID: 'btn-code-till'}}
          />
        </>
      ) : null}
      {/* The capability flag gates ENTRY to this form; it never un-mounts a LIVE charge. If the
          relay is retargeted or drops mid-charge, `tillAvailable` flips false but `tillLive` keeps
          TillCharge mounted — its own poll then says "Can't check this charge right now", which is
          the honest rendering of silence. Un-mounting here would render the outage as the ABSENCE
          of a sale (flow 116's whole contract). */}
      {(tillAvailable || tillLive) && codeForm === 'till' ? (
        <TillCharge
          identity={identity}
          relayUrl={relayUrl}
          asset={activeAsset}
          assets={assets}
          catalog={catalog}
          nfcStatus={nfcStatus}
          onSelectAsset={onSelectAsset}
          onLiveChange={setTillLive}
        />
      ) : (
        <>
      {/* Trip Ready J4 (UX hardening 2026-08-23) — the coach card ALSO mounts at the ENTRY form
          (was: only after pressing Request, so first-time receivers never saw it). Same one-time
          seen marker — whichever surface shows it first wins; the card never returns after. */}
      <CoachTip tipKey="receiveRequest" />
      <Text style={S.label}>{M.receive.amountToReceive}</Text>
      <View style={S.amountRow}>
        {/* MC5: the merchant selects the EXACT settlement asset by tapping the amount prefix (glyph +
            ▾), which opens the compact currency picker below. The amount is cleared on switch so a
            stale '25.00' is never reinterpreted as 25 BTC (8-decimal) on the new asset. */}
        <Pressable testID="req-prefix" style={S.prefixBtn} onPress={() => setPickOpen(true)} accessibilityRole="button" accessibilityLabel={M.receive.chooseCurrency} accessibilityHint={M.receive.chooseCurrencyHint} accessibilityState={{disabled: false}}>
          <Text style={S.currency}>{reqPrefix}</Text>
          <IconChevronDown size={20} color={C.sub}/>
        </Pressable>
        {/* X21 — Enter submits. Every other form on the web has taught the user that pressing
            Enter in the last field of a short form does the thing the form is for; this one made
            them reach for the mouse, and the keyboard shortcuts that DO exist stop at the tab
            level. `onSubmitEditing` is the RN-native spelling of it, so the same key works on a
            hardware keyboard attached to a phone. Both fields submit: the memo is optional, so
            either one can legitimately be the last field the user touches. */}
        <TextInput testID="amount-input" style={S.amountInput} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder={M.receive.amountPlaceholder} placeholderTextColor={C.sub} accessibilityLabel={M.receive.amountToReceive} accessibilityHint={M.receive.amountHint} onSubmitEditing={makeRequest} returnKeyType="done" />
      </View>
      <TextInput
        testID="memo-input"
        style={memoInputStyle()}
        value={memo}
        onChangeText={setMemo}
        placeholder={M.receive.memoPlaceholder}
        placeholderTextColor={C.sub}
        accessibilityLabel={M.receive.memo}
        accessibilityHint={M.receive.memoHint}
        maxLength={32}
        onSubmitEditing={makeRequest}
        returnKeyType="done"
      />
      <Pressable testID="btn-request" style={S.primaryWide} onPress={makeRequest} accessibilityRole="button" accessibilityLabel={M.receive.request} accessibilityHint={M.receive.requestHint} accessibilityState={{disabled: false}}><Text style={S.primaryText}>{M.receive.request}</Text></Pressable>
      {err ? <Text style={S.err}>{err}</Text> : null}
      <AssetPicker
        open={pickOpen}
        assets={assets}
        selectedId={selectedAssetId}
        balances={balances}
        homeCurrency={homeCurrency}
        onSelect={(id) => { setAmount(''); onSelectAsset(id); }}
        onClose={() => setPickOpen(false)}
      />
        </>
      )}
    </View>
  );
}
