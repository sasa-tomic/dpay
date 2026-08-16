import {useEffect, useMemo, useState} from 'react';
import {View, Text, Pressable, TextInput, type TextStyle} from 'react-native';
import {QrCode} from './QrCode';
import {C} from '../config/palette';
import {S} from '../styles';
import {EXPIRY_WINDOW, NFC_PAY_TIMEOUT_MS, POLL, BALANCE_TIMEOUT_MS, QR_SIZE} from '../config/constants';
import {short, base, toUnits, randNonceHex, nowSecs} from '../lib/format';
import {shareHandoff, decodeReceiptDeeplink} from '../lib/deepLink';
import {type CurrencyDescriptor, type FamilyDisplay, fmtCurrencyAmount, currencySymbol} from '../config/catalog';
import {type SelectableAsset} from '../config/assets';
import {type BalanceView} from '../lib/assetBalances';
import type {Identity, AssetId} from '../lib/types';
import {rejectionMessage, isNonceReused, isReceiptForRequest} from '../payments';
import {fetchWithTimeout, payAndClassify} from '../services/relay';
import {verifyOutcomeReceipt} from '../services/receipt';
import {DpayCore, DpayNfc} from '../services/native';
import {NfcTap} from './NfcTap';
import {QrScanner} from './QrScanner';
import {NfcIcon} from './NfcIcon';
import {ModeToggle} from './ModeToggle';
import {DepositSheet} from './DepositSheet';
import {CkErc20DepositSheet} from './CkErc20DepositSheet';
import {AssetPicker} from './AssetPicker';
import {useReportLock} from '../hooks/useReportLock';
import {useShareFeedback} from '../hooks/useShareFeedback';
import {withTimeout} from '../lib/timeout';

// The optional merchant memo input — a real secondary field (not a bare text link), mirroring the
// paste-button affordance pattern (44pt-min touch target + a visible border). Inline (Group E owns
// styles.ts as ONE block): outline sub color on a subtle wash, full-width (alignSelf stretch so it
// lines up with the amount row above and the Request button below — was a narrower maxWidth:320 that
// left the field floating shorter than its neighbors), 44pt-min.
const memoInputStyle: TextStyle = {alignSelf: 'stretch', marginTop: 14, minHeight: 44, borderWidth: 1, borderColor: C.sub2, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16, color: C.ink};

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
  const [reqQr, setReqQr] = useState<{value: string; rawAmount: string; currency: number; nonce: string; nfcHex: string | null; expiry: number} | null>(null);
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
      if (nfcReady && DpayNfc) { try { nfcHex = await DpayNfc.buildRequest(identity.publicHex, rawAmount, nonce, expiry, selectedCurrency, identity.username, memoVal); } catch (e) { console.warn('NFC buildRequest failed (best-effort, QR still works):', e instanceof Error ? e.message : String(e)); } }
      setReqQr({value: reqB64, rawAmount, currency: selectedCurrency, nonce, nfcHex, expiry});
      setResult(null); setErr(null);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  // Poll the ledger for this request's settlement (payer paid directly, or we submitted their QR).
  useEffect(() => {
    if (!reqQr || result) return;
    let alive = true;
    const check = async () => {
      try {
        const r = await fetchWithTimeout(`${base(relayUrl)}/api/v1/receipt/${reqQr.nonce}`, undefined, BALANCE_TIMEOUT_MS);
        if (alive && r.ok) {
          const j = await r.json();
          // The relay attaches UNSIGNED display fields (from_name/to_name/memo) to the /receipt
          // response so the merchant can show "Received X from <name>" instead of the raw hex
          // pubkey prefix. The signed receipt body (verified independently by the payer path) still
          // binds only pubkeys + amount + nonce; these fields are display-only. An empty from_name
          // (cold-start recovery, or the payer chose no name) falls back to short(pubkey).
          const fromName = typeof j.from_name === 'string' && j.from_name.length > 0 ? j.from_name : null;
          const from = fromName ?? (j.receipt?.from ? short(j.receipt.from) : 'payer');
          setResult({amount: reqQr.rawAmount, currency: reqQr.currency, from}); onReceived();
        }
      } catch (e) { console.warn('settlement receipt poll failed:', e instanceof Error ? e.message : String(e)); /* best-effort: keep polling — the next tick surfaces the settlement */ }
    };
    check(); const id = setInterval(check, POLL.receiptRcv);
    return () => { alive = false; clearInterval(id); };
  }, [reqQr, result, relayUrl, onReceived]);

  // Receipt hand-back (dpay:pay/): a payer who settled ONLINE (NFC unavailable) shares the
  // canister-signed receipt back as a `dpay:pay/<blob>` link. This effect consumes the blob, verifies
  // the receipt INDEPENDENTLY, and reconciles the open request as Paid — mirroring the NFC merchant
  // path's security posture (NfcTap.tsx): PR1 nonce binding (if there's an open request) BEFORE the
  // signature check, then verifyOutcomeReceipt (key-pin + Ed25519 sig). SECURITY INVARIANT: the
  // merchant sees "Received" ONLY after verify passes — an unverified receipt NEVER reconciles.
  //
  // Two arrival shapes:
  //   • Open request present (foreground link, request screen open): bind the receipt's nonce to the
  //     request's nonce (isReceiptForRequest) + verify sig → reconcile THIS request as Paid.
  //   • No open request (cold launch via the link, or a different screen): the receipt still verifies
  //     on its own (key-pin + sig authenticates the full claim incl. from/amount) → show "Received X
  //     from Y" from the receipt's own fields. Honest: a verified receipt IS a real settlement.
  // A malformed blob or a failed verify surfaces a clear error (never a silent failure, never a fake
  // Paid). The prefill is cleared (onReceiptConsumed) BEFORE the async verify so the effect can't
  // re-fire mid-flight.
  useEffect(() => {
    if (prefillReceipt == null) return;
    const blob = prefillReceipt;
    onReceiptConsumed?.();
    let alive = true;
    (async () => {
      const receipt = decodeReceiptDeeplink(blob);
      if (!receipt) { if (alive) setErr('This receipt link is malformed.'); return; }
      // PR1 goods-fraud guard: if there's an open request, the receipt's nonce MUST match it before
      // the signature check (a malicious payer/relay can replay any past valid receipt for a different
      // payment). Without an open request the signature alone authenticates the claim.
      const openReq = reqQr;
      const nonceMatches = openReq ? isReceiptForRequest(receipt, openReq.nonce) : true;
      if (openReq && !nonceMatches) {
        if (alive) setErr('This receipt doesn’t match your open request.');
        return;
      }
      const verified = await verifyOutcomeReceipt(receipt);
      if (!alive) return;
      if (!verified) { setErr('Couldn’t verify this receipt — the signature is invalid.'); return; }
      const from = typeof receipt.from === 'string' && receipt.from.length > 0 ? short(receipt.from) : 'payer';
      // Reconcile against the open request if the nonce matched; else show the receipt's own amount.
      const amount = openReq ? openReq.rawAmount : (typeof receipt.amount === 'string' ? receipt.amount : '0');
      const currency = openReq ? openReq.currency : (typeof receipt.currency === 'number' ? receipt.currency : 0);
      setResult({amount, currency, from});
      onReceived();
    })();
    // onReceiptConsumed/onReceived are inline closures; the [prefillReceipt] guard + immediate clear
    // make their identity irrelevant (exhaustive-deps would force a re-run on every render's new
    // closure for no behavioral change). reqQr is captured at fire time (the open request when the
    // link arrived) — re-running on a later reqQr change would re-verify a consumed prefill.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillReceipt]);

  async function onSignedQr(raw: string) {
    setScanning(false);
    setErr(null);
    try {
      const {signal, cancel} = withTimeout(NFC_PAY_TIMEOUT_MS);
      // PR25 — payAndClassify does fetch + JSON-or-empty parse + classifyPayHttp. The merchant only
      // acts on a definitive 'rejected' (a 422 policy refusal); a settled or unknown outcome is
      // surfaced by the /receipt poll (which sets `result`), so we never flash a false failure on a
      // payment that actually went through.
      const {outcome, body: j} = await payAndClassify(relayUrl, raw.trim(), signal).finally(() => cancel());
      if (outcome === 'rejected' && !isNonceReused(j?.error)) {
        setErr(rejectionMessage(typeof j?.error === 'string' ? j.error : null));
      }
    } catch (e) { console.warn('pay and classify failed:', e instanceof Error ? e.message : String(e)); /* network/timeout — the /receipt poll reconciles; don't show a false error */ }
  }

  function reset() { setReqQr(null); setResult(null); setScanning(false); setErr(null); setMemo(''); setNfcActive(false); setNfcKey(k => k + 1); }

  // While an NFC tap is mid-flow, let it own the screen (so the receipt gets back to the payer)
  // rather than the settlement poll swapping in the "Received" view underneath it.
  if (result && !nfcActive) {
    return (
      <View style={S.center}>
        <View style={S.check}><Text style={S.checkMark}>✓</Text></View>
        <Text style={S.paidText}>{`Received ${fmtCurrencyAmount(catalog, result.currency, result.amount)}`}</Text>
        <Text style={S.paidSub}>{`from ${result.from}`}</Text>
        <Pressable style={S.linkBtn} onPress={reset} accessibilityRole="button" accessibilityLabel="New request" accessibilityState={{disabled: false}}><Text style={S.linkText}>New request</Text></Pressable>
      </View>
    );
  }

  if (reqQr) {
    return (
      <View style={S.center}>
        {/* Reader mode runs in the background while the QR is shown: the payer taps OR scans. */}
        {reqQr.nfcHex && nfcReady && DpayNfc ? (
          <NfcTap
            key={nfcKey} role="reader" identity={identity} relayUrl={relayUrl} requestHex={reqQr.nfcHex}
            reqInfo={readerReqInfo}
            catalog={catalog}
            onSettled={onReceived} onActive={() => setNfcActive(true)}
            onClose={() => { setNfcActive(false); reset(); }}
          />
        ) : null}
        {!nfcActive ? (
          <>
            <View style={S.nfcHintRow}>
              {reqQr.nfcHex ? <NfcIcon color={C.brand} size={18} /> : null}
              <Text style={S.nfcHintLabel}>Show this to the payer{reqQr.nfcHex ? ' · or let them tap' : ''}</Text>
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
          if (m >= 1) return <Text style={S.qrExpiry}>Valid for ~{m} min</Text>;
          return <Text style={S.qrExpiryWarn}>Expires in 0:{s.toString().padStart(2, '0')}</Text>;
        })()}
        <Text style={S.qrHint}>Waiting for payment{online ? '…' : ' — reconnecting…'}</Text>
        {/* Audit P2: an offline wait state looks identical to the online wait state from the header
            alone (the small `~ approx.` is easy to miss). Mirror it inline as a contextual pill so the
            merchant knows incoming payments won't appear until reconnected (no false "still waiting"). */}
        {!online ? (
          <View style={S.qrOfflinePill}>
            <View style={[S.dot, {backgroundColor: C.bad}]} />
            <Text style={S.qrOfflinePillText}>Offline — won't see payments until reconnected</Text>
          </View>
        ) : null}
            {/* Item 6 — share this request as a dpay:req/ link so a payer far away (no camera, over a
                messaging app) can open it and have the pay review screen pre-filled. The blob is the
                EXACT base64url the QR carries (no new codec); the payer still taps Approve. */}
            <Pressable
              testID="btn-share-request"
              style={S.linkBtn}
              onPress={() => {
                share(shareHandoff('req', reqQr.value));
              }}
              accessibilityRole="button"
              accessibilityLabel="Share request link"
              accessibilityHint="Share this request as a link the payer can open to pay"
              accessibilityState={{disabled: false}}>
              <Text style={S.linkText}>{shared ? 'Link copied ✓' : 'Share request link'}</Text>
            </Pressable>
            {scanning ? (
              <><QrScanner onScan={onSignedQr} /><Text style={S.dim2}>Scan the payer's signed QR</Text></>
            ) : (
              <>
                <Pressable style={S.linkBtn} onPress={() => setScanning(true)} accessibilityRole="button" accessibilityLabel="Scan payer's signed QR" accessibilityHint="Scan the payer's signed QR to submit their offline payment" accessibilityState={{disabled: false}}><Text style={S.linkText}>Scan payer's signed QR</Text></Pressable>
                <Text style={S.dim2}>If the payer paid without scanning your code, tap here to confirm with their phone.</Text>
              </>
            )}
            {err ? <Text style={S.err}>{err}</Text> : null}
            <Pressable style={S.linkBtn} onPress={reset} accessibilityRole="button" accessibilityLabel="New request" accessibilityState={{disabled: false}}><Text style={S.linkTextMuted}>New request</Text></Pressable>
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
            onClose={() => onSubModeChange('request')}
          />
        ) : (
          <DepositSheet
            identity={identity}
            relayUrl={relayUrl}
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
          <Text style={S.caret}>▾</Text>
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
