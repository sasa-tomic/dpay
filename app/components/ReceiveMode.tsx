import {useEffect, useMemo, useState} from 'react';
import {View, Text, Pressable, TextInput, type TextStyle} from 'react-native';
import {QrCode} from './QrCode';
import {C, FONT} from '../config/palette';
import {S} from '../styles';
import {EXPIRY_WINDOW, NFC_UPDATE_AHEAD_S, POLL, PROOF_POLL_BUDGET, QR_SIZE} from '../config/constants';
import {toUnits, randNonceHex, nowSecs} from '../lib/format';
import {shareHandoff, decodeReceiptDeeplink, parseRailProof} from '../lib/deepLink';
import {type CurrencyDescriptor, type FamilyDisplay, fmtCurrencyAmount, currencySymbol} from '../config/catalog';
import {type SelectableAsset} from '../config/assets';
import {type BalanceView} from '../lib/assetBalances';
import type {Identity, AssetId} from '../lib/types';
import {qrPayloadToEnvelopeHex, submitAndConfirmIncomingTransfer, confirmIncomingTransfer} from '../services/rail';
import {DpayCore, DpayNfc} from '../services/native';
import {icStampExpiry} from '../services/icp';
import {NfcTap} from './NfcTap';
import {QrScanner} from './QrScanner';
import {NfcIcon} from './NfcIcon';
import {ModeToggle} from './ModeToggle';
import {DepositSheet} from './DepositSheet';
import {CkErc20DepositSheet} from './CkErc20DepositSheet';
import {AssetPicker} from './AssetPicker';
import {useReportLock} from '../hooks/useReportLock';
import {useShareFeedback, shareConfirmLabel} from '../hooks/useShareFeedback';
import {CoachTip} from './CoachTip';
import {IconCheck, IconChevronDown, IconClock, IconQr, IconShare, IconWifiOff} from './icons';

// The optional merchant memo input — a real secondary field (not a bare text link), mirroring the
// paste-button affordance pattern (44pt-min touch target + a visible border). Inline (Group E owns
// styles.ts as ONE block): Traveler Paper input idiom — white field + hairline line2 border +
// Space Grotesk, matching usernameInput/withdrawAddrInput (the old dark-theme transparent-bg +
// heavy sub2 outline read as a stray box on porcelain). Full-width (alignSelf stretch so it lines
// up with the amount row above and the Request button below — was a narrower maxWidth:320 that
// left the field floating shorter than its neighbors), 44pt-min.
const memoInputStyle: TextStyle = {alignSelf: 'stretch', marginTop: 14, minHeight: 44, backgroundColor: C.card, borderWidth: 1, borderColor: C.line2, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16, color: C.ink, fontFamily: FONT.sans};

export function ReceiveMode({identity, relayUrl, online, nfcReady, onReceived, catalog, depositCurrency, depositDisplay, depositChainId, depositNativeEth, depositFamily, subMode, onSubModeChange, prefillReceipt, onReceiptConsumed, selectedCurrency, assets, selectedAssetId, balances, onSelectAsset, onLockChange}: {identity: Identity; relayUrl: string; online: boolean; nfcReady: boolean; onReceived: () => void; catalog: CurrencyDescriptor[]; depositCurrency: number; depositDisplay: FamilyDisplay | null; depositChainId: number | null; depositNativeEth: boolean; depositFamily: 'CkBtcUtxo' | 'CkEthErc20' | null; subMode: 'request' | 'address'; onSubModeChange: (m: 'request' | 'address') => void; prefillReceipt?: string | null; onReceiptConsumed?: () => void; selectedCurrency: number; assets: SelectableAsset[]; selectedAssetId: AssetId | null; balances: Record<AssetId, BalanceView>; onSelectAsset: (id: AssetId) => void; onLockChange?: (locked: boolean) => void}) {
  // The within-tab sub-mode is OWNED by Wallet so deeplinks (?screen=deposit, auto-open-ckERC20) can
  // land the user directly on "My address". "request" = the dpay-to-dpay payment-request QR;
  // "address" = the on-chain deposit flow. The toggle renders only when depositFamily is non-null.
  //
  // Phase 4 (2026-08-12 unified asset selection rewrite): the merchant's chosen settlement asset
  // arrives as the `selectedCurrency` PROP from Wallet's single owned `selectedAssetId` — there is
  // NO local `reqCurrency` state anymore. The amount-prefix picker opens the unified `AssetPicker`,
  // whose `onSelect(id)` is Wallet's `handleSelect` (the same dispatch Balances uses). Selecting a
  // SOL/USDC asset flips the rail via Wallet's reconcileSelectedAsset + re-mounts SolReceiveMode.
  const [amount, setAmount] = useState('');
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

  // Phase 5 — lock the idle asset selection while a request QR is showing or a settlement result is
  // displayed. Both hold an in-flight request the user must not lose to an asset switch (the QR is the
  // encoded request a payer is scanning; the result is the settled outcome). The idle form is free.
  const locked = !!reqQr || !!result;
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
    () => (reqQr ? {amount: reqQr.rawAmount, nonce: reqQr.nonce, who: 'payer', currency: reqQr.currency} : undefined),
    [reqQr],
  );

  // Resolve the selected asset's display config ONCE per render. Decimals come from the catalog
  // descriptor directly (NOT familyDisplay, which falls back to BTC's 8 + would mis-render DEMO's
  // 2). The amount-input prefix is the currency's display glyph (∂/₿/$) via currencySymbol.
  const reqDesc = catalog.find(c => c.currency === selectedCurrency);
  const reqDecimals = reqDesc?.decimals ?? 2;
  const reqPrefix = currencySymbol(catalog, selectedCurrency);

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
        if (!proof) { if (alive) setErr('This receipt link is malformed.'); return; }
        if (!reqQr) {
          // No open request to bind against (cold launch): the proof is unverifiable HERE — there
          // is no request whose settlement this screen could confirm, and no honest amount to
          // show. Never fabricate a "Received", never fire onReceived (nothing was verified).
          // Log it; if a request screen is open elsewhere it stays untouched.
          console.warn('rail-proof deeplink ignored: no open request to verify it against');
          return;
        }
        const parsed = parseRailProof(proof);
        if (!parsed) { if (alive) setErr("This receipt doesn't match your open request."); return; }
        const settled = await confirmIncomingTransfer({
          relayUrl,
          receiverPublicHex: identity.publicHex,
          currency: reqQr.currency,
          amount: reqQr.rawAmount,
          memoHex: reqQr.nonce,
        }, {attempts: PROOF_POLL_BUDGET, intervalMs: POLL.receiptRcv});
        if (!alive) return;
        if (settled) {
          setResult({amount: reqQr.rawAmount, currency: reqQr.currency, from: 'payer'});
          onReceived();
        } else {
          setErr('Couldn’t confirm this payment yet — if the payer paid, it lands with the next balance refresh.');
        }
      } catch (e) {
        if (alive) setErr("Couldn't read this receipt link.");
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
      if (!envelopeHex) { setErr("This isn't a dpay payment code"); return; }
      const ledger = catalog.find(c => c.currency === reqQr?.currency)?.ledger ?? '';
      if (!ledger || !reqQr) { setErr('Unknown ledger for this asset — couldn’t submit'); return; }
      const settled = await submitAndConfirmIncomingTransfer(ledger, envelopeHex, {
        relayUrl,
        receiverPublicHex: identity.publicHex,
        currency: reqQr.currency,
        amount: reqQr.rawAmount,
        memoHex: reqQr.nonce,
      }, {attempts: PROOF_POLL_BUDGET, intervalMs: POLL.receiptRcv});
      if (settled) {
        setResult({amount: reqQr.rawAmount, currency: reqQr.currency, from: 'payer'});
        onReceived();
      } else {
        setErr('Couldn’t confirm this payment yet — if the payer paid, it lands with the next balance refresh.');
      }
    } catch (e) { console.warn('envelope submit failed:', e instanceof Error ? e.message : String(e)); setErr("Couldn't submit the payment — check the connection"); }
  }

  function reset() { setReqQr(null); setResult(null); setScanning(false); setErr(null); setMemo(''); setNfcActive(false); setNfcKey(k => k + 1); }

  // While an NFC tap is mid-flow, let its exact history check own the screen rather than swapping
  // in the generic result view underneath it.
  if (result && !nfcActive) {
    return (
      <View style={S.center}>
        <View style={S.check}><IconCheck size={44} color={C.brandInk}/></View>
        <Text style={S.paidText}>{`Received ${fmtCurrencyAmount(catalog, result.currency, result.amount)}`}</Text>
        <Text style={S.paidSub}>{`from ${result.from}`}</Text>
        <Pressable style={[S.ghostBtn, S.ghostBtnMuted]} onPress={reset} accessibilityRole="button" accessibilityLabel="New request" accessibilityState={{disabled: false}}><Text style={S.ghostBtnText}>New request</Text></Pressable>
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
            <View style={S.nfcHintRow}>
              {nfcUsable ? <NfcIcon color={C.brand} size={18} /> : null}
              <Text style={S.nfcHintLabel}>Show this to the payer{nfcUsable ? ' · or let them tap' : reqQr.nfcHex ? ' · NFC tap expired' : ''}</Text>
            </View>
            <View testID="request-qr" style={S.qrCard}><QrCode value={reqQr.value} size={QR_SIZE} ecl="M" /></View>
        <Text style={S.amountBig}>{fmtCurrencyAmount(catalog, reqQr.currency, reqQr.rawAmount)}</Text>
        {(() => {
          const remaining = reqQr.expiry - now;
          if (remaining <= 0) return <Text style={S.qrExpired}>Expired — make a new request</Text>;
          const m = Math.floor(remaining / 60);
          const s = remaining % 60;
          // While there's a minute+ of headroom, show the calm "~N min" form; under a minute, count
          // down seconds (and tint red) so the merchant knows to refresh before a payer scans a stale QR.
          // P3 — a small clock icon leads the validity line (QR-card polish; no layout change near
          // the QrCode itself — this sits below the amount, outside the white card).
          if (m >= 1) return (
            <View style={{flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6}}>
              <IconClock size={14} color={C.sub}/>
              <Text style={[S.qrExpiry, {marginTop: 0}]}>Valid for ~{m} min</Text>
            </View>
          );
          return <Text style={S.qrExpiryWarn}>Expires in 0:{s.toString().padStart(2, '0')}</Text>;
        })()}
        <Text style={S.qrHint}>Waiting for payment{online ? '…' : ' — reconnect to submit…'}</Text>
        {/* Offline honesty (IC rail): the merchant cannot submit a handed envelope or check ledger
            history while offline. Payer-online payments still land directly and reconcile on the
            next balance refresh — but envelope handoffs need connectivity. */}
        {!online ? (
          <View style={S.qrOfflinePill}>
            <IconWifiOff size={14} color={C.bad}/>
            <Text style={S.qrOfflinePillText}>Offline — can’t submit payments until reconnected</Text>
          </View>
        ) : null}
            {/* Trip Ready J4 — the request-QR first-use tip: what this code is and who settles it.
                Mounted in the reading zone (right after the status lines, before the action
                cluster) so it is seen without scrolling on a phone viewport; inline, never blocks
                the QR or the scan path. */}
            <CoachTip tipKey="receiveRequest" />
            {/* Item 6 — share this request as a dpay:req/ link so a payer far away (no camera, over a
                messaging app) can open it and have the pay review screen pre-filled. The blob is the
                EXACT base64url the QR carries (no new codec); the payer still taps Approve. */}
            <Pressable
              testID="btn-share-request"
              style={S.ghostBtn}
              onPress={() => {
                share(shareHandoff('req', reqQr.value));
              }}
              accessibilityRole="button"
              accessibilityLabel="Share request link"
              accessibilityHint="Share this request as a link the payer can open to pay"
              accessibilityState={{disabled: false}}>
              <IconShare size={16} color={C.sub}/>
              <Text style={S.ghostBtnText}>{shared ? shareConfirmLabel('Link copied ✓') : 'Share request link'}</Text>
            </Pressable>
            {scanning ? (
              <><QrScanner onScan={onSignedQr} /><Text style={S.dim2}>Scan the payer's signed QR</Text></>
            ) : (
              <>
                <Pressable style={S.ghostBtn} onPress={() => setScanning(true)} accessibilityRole="button" accessibilityLabel="Scan payer's signed QR" accessibilityHint="Scan the payer's signed QR to submit their offline payment" accessibilityState={{disabled: false}}><IconQr size={16} color={C.sub}/><Text style={S.ghostBtnText}>Scan payer's signed QR</Text></Pressable>
                <Text style={S.dim2}>If the payer paid without scanning your code, tap here to confirm with their phone.</Text>
              </>
            )}
            {err ? <Text style={S.err}>{err}</Text> : null}
            <Pressable style={[S.ghostBtn, S.ghostBtnMuted]} onPress={reset} accessibilityRole="button" accessibilityLabel="New request" accessibilityState={{disabled: false}}><Text style={S.ghostBtnText}>New request</Text></Pressable>
          </>
        ) : null}
      </View>
    );
  }

  // "My address" sub-mode: render the on-chain deposit-address flow INLINE for the active IC
  // asset's family (mirrors Wallet's old family routing). CkBtcUtxo → DepositSheet body;
  // CkEthErc20 → CkErc20DepositSheet body (native-ETH vs ERC-20 via depositNativeEth). The toggle
  // above lets the user flip back to "Request payment". The sheets are inline-only (no overlay chrome
  // — the tab body provides the surface).
  if (subMode === 'address' && depositFamily && depositDisplay) {
    return (
      <View style={S.center}>
        <ModeToggle
          testID="receive-mode-toggle"
          value={subMode}
          onChange={(v) => onSubModeChange(v as 'request' | 'address')}
          left={{label: 'Request payment', value: 'request', testID: 'btn-receive-request'}}
          right={{label: 'My address', value: 'address', testID: 'btn-receive-address'}}
        />
        {depositFamily === 'CkEthErc20' ? (
          <CkErc20DepositSheet
            identity={identity}
            relayUrl={relayUrl}
            currency={depositCurrency}
            decimals={catalog.find(c => c.currency === depositCurrency)?.decimals ?? depositDisplay.amountDecimals}
            display={depositDisplay}
            chainId={depositChainId}
            nativeEth={depositNativeEth}
            ledger={catalog.find(c => c.currency === depositCurrency)?.ledger ?? ''}
            onClose={() => onSubModeChange('request')}
          />
        ) : (
          <DepositSheet
            identity={identity}
            relayUrl={relayUrl}
            catalog={catalog}
            currency={depositCurrency}
            display={depositDisplay}
            onClose={() => onSubModeChange('request')}
          />
        )}
      </View>
    );
  }

  return (
    <View style={S.center}>
      {depositFamily ? (
        <ModeToggle
          testID="receive-mode-toggle"
          value={subMode}
          onChange={(v) => onSubModeChange(v as 'request' | 'address')}
          left={{label: 'Request payment', value: 'request', testID: 'btn-receive-request'}}
          right={{label: 'My address', value: 'address', testID: 'btn-receive-address'}}
        />
      ) : null}
      <Text style={S.label}>Amount to receive</Text>
      <View style={S.amountRow}>
        {/* MC5: the merchant selects the EXACT settlement asset by tapping the amount prefix (glyph +
            ▾), which opens the compact currency picker below. The amount is cleared on switch so a
            stale '25.00' is never reinterpreted as 25 BTC (8-decimal) on the new asset. */}
        <Pressable testID="req-prefix" style={S.prefixBtn} onPress={() => setPickOpen(true)} accessibilityRole="button" accessibilityLabel="Choose settlement currency" accessibilityHint="Pick which asset the payer will send you" accessibilityState={{disabled: false}}>
          <Text style={S.currency}>{reqPrefix}</Text>
          <IconChevronDown size={20} color={C.sub}/>
        </Pressable>
        <TextInput testID="amount-input" style={S.amountInput} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={C.sub2} accessibilityLabel="Amount to receive" accessibilityHint="The amount the payer will send you" />
      </View>
      <TextInput
        testID="memo-input"
        style={memoInputStyle}
        value={memo}
        onChangeText={setMemo}
        placeholder="Add a note (optional)"
        placeholderTextColor={C.sub2}
        accessibilityLabel="Memo"
        accessibilityHint="An optional note attached to this payment request"
        maxLength={32}
      />
      <Pressable testID="btn-request" style={S.primaryWide} onPress={makeRequest} accessibilityRole="button" accessibilityLabel="Request" accessibilityHint="Show your QR code so the payer can scan it to pay you" accessibilityState={{disabled: false}}><Text style={S.primaryText}>Request</Text></Pressable>
      {err ? <Text style={S.err}>{err}</Text> : null}
      <AssetPicker
        open={pickOpen}
        assets={assets}
        selectedId={selectedAssetId}
        balances={balances}
        onSelect={(id) => { setAmount(''); onSelectAsset(id); }}
        onClose={() => setPickOpen(false)}
      />
    </View>
  );
}
