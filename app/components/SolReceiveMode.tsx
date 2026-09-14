import {useState, useEffect, useMemo, useRef} from 'react';
import {View, Text, Pressable, TextInput, ActivityIndicator, Platform, type TextStyle} from 'react-native';
import {QrCode} from './QrCode';
import bs58 from 'bs58';
import {C, FONT} from '../config/palette';
import {S} from '../styles';
import {isSolanaDevnet, QR_SIZE_SMALL, SOL_ACTIVE_POLL_WINDOW_MS, SOL_BROADCAST_TIMEOUT_MS} from '../config/constants';
import {fmtAssetCompact, rawToDecimal, toUnits} from '../lib/format';
import {bytesToBase64Url, base64UrlToBytes} from '../lib/base64';
import {type SelectableAsset} from '../config/assets';
import type {CurrencyDescriptor} from '../config/catalog';
import {type HomeCurrency} from '../config/currency';
import {type BalanceView} from '../lib/assetBalances';
import type {Identity, AssetId, NfcStatus} from '../lib/types';
import {SOL_DECIMALS, SOL_UNIT} from '../solana/identity';
import {deriveAta, netSolWireLamports, SOL_ATA_SETUP_MIN_LAMPORTS, SOL_FEE_LAMPORTS} from '../solana/spl';
import {solanaTokenInfo} from '../solana/tokens';
import {decodeSolPay} from '../solana/qr';
import type {SolReqV2, SolPayV2} from '../solana/qr';
import {isSolReqV2Expired, RECEIPT_SETTLED, RECEIPT_REJECTED, RECEIPT_MISMATCH} from '../solana/payments';
import {extractSignedTxParts} from '../solana/tx';
import {createSolPaymentRequest, broadcastSolPayment, isSolanaRpcAvailable, type SolanaReadFailure} from '../solana';
import {friendlySolError} from '../solana/errors';
import {loadSolMerchantState, saveSolMerchantState, clearSolMerchantState} from '../services/solMerchantPersist';
import {saveTxNote} from '../services/txNotes';
import {type SolTokenStatus} from '../hooks/useSolanaBalances';
import {DpaySolNfc} from '../services/native';
import {withTimeout} from '../lib/timeout';
import {QrScanner} from './QrScanner';
import {SolNfcTap} from './SolNfcTap';
import {NfcStatusRow} from './NfcStatusRow';
import {ModeToggle} from './ModeToggle';
import {TillCharge} from './TillCharge';
import {SolanaReceiveSheet} from './SolanaReceiveSheet';
import {FundingRoutes} from './FundingRoutes';
import {RailDisclosure} from './RailDisclosure';
import {SolanaAtaSetupCard} from './SolanaAtaSetupCard';
import {AssetPicker} from './AssetPicker';
import {AssetSwitchRow} from './AssetSwitchRow';
import {useJourney} from '../lib/journey';
import {awardPaymentTested} from '../lib/readiness';
import {encodePayLink, shareOrigin} from '../lib/deepLink';
import {useCopyFeedback} from '../hooks/useCopyFeedback';
import {useShareFeedback, shareConfirmLabel} from '../hooks/useShareFeedback';
import {useReportLock} from '../hooks/useReportLock';
import {IconCheck, IconChevronDown, IconClock, IconCopy, IconQr, IconShare} from './icons';
import {CoachTip} from './CoachTip';
import {M} from '../i18n';

// Twin of ReceiveMode's memoInputStyle — Traveler Paper input idiom (white field, hairline border,
// Space Grotesk), kept inline + identical so the IC and SOL Receive forms stay pixel-twins.
// A FUNCTION, not a const: `C` is mutated in place on a theme flip, so a module-level style
// object froze the light theme's white field + near-black ink into the dark theme's memo input.
const memoInputStyle = (): TextStyle => ({alignSelf: 'stretch', marginTop: 14, minHeight: 44, backgroundColor: C.card, borderWidth: 1, borderColor: C.line2, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16, color: C.ink, fontFamily: FONT.sans});

// Founder rule 2026-09-14: the payee's settled readout headlines the GROSS — for a netted
// native-SOL request that is wire + fee (the typed price; the same sum the reqQr headline and the
// payer's total display make). SPL wires ride verbatim (no netting), so their gross IS the wire.
// Display-only: the wire stays the settlement/reconciliation truth everywhere money moves.
function solGrossOf(cur: string, amt: string): string {
  return cur === 'SOL' ? (BigInt(amt) + SOL_FEE_LAMPORTS).toString() : amt;
}

/**
 * SolReceiveMode — the merchant-side payment component for the v2 recent-blockhash SOL rail.
 *
 * Rendered INLINE in the Receive tab body when SOL is the active asset (selected in Balances).
 * The QR the merchant shows is the payment LINK (founder decision 2026-09-12 — any phone camera
 * opens it); the `solreq:v2:` machine code is built alongside (ONLINE — genesis hash + fresh
 * blockhash) but leaves this screen only where a radio or the confirm path needs it: the NFC tap,
 * and the payer's signed-QR scan-back + solMerchantPersist reconciliation. The payer signs
 * offline, then the merchant scans the payer's `solpay:v2:` QR and broadcasts it online
 * (broadcastSolPayment — strict verify + freshness + confirm); on success the merchant sees the
 * received amount + the tx signature. A LINK payment does NOT auto-confirm this screen (the SOL
 * rail attaches no reconciliation memo) — it lands on balances/transactions, and the request
 * screen still confirms via NFC / signed-QR scan-back.
 *
 * Durable state: the open request + any atomically-reserved accepted tx are persisted to AsyncStorage
 * (solMerchantPersist) so a kill/restart mid-flow can reconcile (invariants #10/#11/#12). On mount,
 * the component loads any saved state and restores/repairs accordingly.
 *
 * Mirrors ReceiveMode.tsx's form → reqQr → result phase machine, but settles directly on Solana
 * (no relay, no /receipt poll — `confirmTransaction` is the source of truth).
 *
 * Token-generic (2026-09-06): every token fact (decimals, mint, symbol, cur literal) comes from
 * the SELECTED asset row (`assets` + `selectedAssetId`) — the registry is the only truth, so a
 * new token (EURC, …) renders here with no component change. `selectedToken` stays as the
 * native-vs-SPL discriminator ('SOL' ⇔ mint null).
 */
export function SolReceiveMode({identity, relayUrl, nfcStatus, solAddress, subMode, onSubModeChange, codeForm, onCodeFormChange, tillAvailable, catalog, selectedToken, assets, selectedAssetId, balances, onSelectAsset, tokenAtaStatus = 'balance', tokenAtaFailure = null, tokenAmount = null, solBalance = null, solOk = false, ataSetupBusy = false, ataSetupErr = null, onCreateAta, onShowSolAddress, onRefreshToken, onRefreshSol, depositReturnLabel, onReturnFromDeposit, onLockChange, homeCurrency = null, onReceiveRailChange}: {identity: Identity; relayUrl: string; nfcStatus: NfcStatus; solAddress: string; subMode: 'request' | 'address'; onSubModeChange: (m: 'request' | 'address') => void; codeForm: 'dpay' | 'till'; onCodeFormChange: (f: 'dpay' | 'till') => void; tillAvailable: boolean; catalog: CurrencyDescriptor[]; selectedToken: string; assets: SelectableAsset[]; selectedAssetId: AssetId | null; balances: Record<AssetId, BalanceView>; onSelectAsset: (id: AssetId) => void; tokenAtaStatus?: SolTokenStatus; tokenAtaFailure?: SolanaReadFailure | null; tokenAmount?: string | null; solBalance?: string | null; solOk?: boolean; ataSetupBusy?: boolean; ataSetupErr?: string | null; onCreateAta?: () => void; onShowSolAddress?: () => void; onRefreshToken?: () => void; onRefreshSol?: () => void;   depositReturnLabel?: string | null;
  onReturnFromDeposit?: () => void;
  onLockChange?: (locked: boolean) => void;
  homeCurrency?: HomeCurrency | null;
  onReceiveRailChange?: (id: AssetId) => void}) {
  // The 4-state radio status, and the local "is a tap possible" gate derived from it — see the
  // same pair in ReceiveMode for why the state travels whole rather than as a boolean.
  const nfcReady = nfcStatus === 'ready';
  const solRpc = isSolanaRpcAvailable();
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [phase, setPhase] = useState<'form' | 'reqQr' | 'result'>('form');
  // Trip Ready J5b — paymentTested: awarded once at the FIRST confirmed SOL Received (the three
  // confirmed setResult branches only — never the honest-pending UNREACHABLE paths).
  const {journey} = useJourney();
  const journeyRef = useRef(journey);
  journeyRef.current = journey;
  const [reqUri, setReqUri] = useState<string | null>(null);
  const [reqSnapshot, setReqSnapshot] = useState<SolReqV2 | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{amount: string; cur: string; sig: string | null} | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const {copied, copy: doCopy} = useCopyFeedback();
  const {shared, share} = useShareFeedback();
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [nfcActive, setNfcActive] = useState(false);
  const [nfcKey, setNfcKey] = useState(0);

  const linkAsset = assets.find(a => a.id === selectedAssetId) ?? null;
  // The payment link this screen's QR renders (founder decision 2026-09-12: the QR is the LINK on
  // every rail; the `solreq:v2:` machine code survives only where a radio or the confirm path needs
  // it — NFC, the payer's signed-QR scan-back, and the solMerchantPersist reconciliation). Derived
  // from the REQUEST's own facts, never the form: a kill/restart restores the QR from `reqSnapshot`
  // with `amount` back at '', so the request (to/amt/cur/name/memo) is the only truth that survives
  // — and one code path serves fresh + restored requests alike. `cur` is the registry token
  // literal, the same `linkToken` the solana asset arm carries. No `ref`: the SOL rail attaches no
  // on-chain reconciliation memo, and a reference we cannot put on-chain would be a promise the
  // rail can't keep.
  const payLink = useMemo(() => {
    if (!reqSnapshot) return null;
    const decimals = reqSnapshot.cur === 'SOL' ? SOL_DECIMALS : solanaTokenInfo(reqSnapshot.cur)?.decimals ?? SOL_DECIMALS;
    return encodePayLink(shareOrigin(), {
      recipient: reqSnapshot.to,
      asset: reqSnapshot.cur,
      network: 'solana',
      amount: rawToDecimal(reqSnapshot.amt, decimals),
      label: reqSnapshot.name,
      memo: reqSnapshot.memo,
      ref: null,
    });
  }, [reqSnapshot]);
  // Reconciliation state — when a broadcast was interrupted (outcome 'broadcasting'/'unknown' in
  // persist), the accepted tx is preserved so the merchant can retry. null when not reconciling.
  const [reconcile, setReconcile] = useState<{acceptedSig: string; acceptedTx: string} | null>(null);

  const locked = phase !== 'form';
  useReportLock(onLockChange, locked);
  const [pickOpen, setPickOpen] = useState(false);

  // Token facts come from the selected ASSET ROW (registry truth: decimals, mint, symbol) — never
  // a USDC-shaped ternary. `selectedToken` remains only as the native-vs-SPL discriminator; the
  // asset switcher mid-flow can leave them divergent, which is why each phase re-derives from the
  // row (or the request itself) rather than trusting `selectedToken` alone.
  const isNativeSol = selectedToken === 'SOL';
  const decimals = isNativeSol ? SOL_DECIMALS : (solanaTokenInfo(selectedToken)?.decimals ?? SOL_DECIMALS);
  const unit = isNativeSol ? SOL_UNIT : selectedToken;
  const selectedMint = isNativeSol ? null : solanaTokenInfo(selectedToken)?.mint ?? null;
  const isSpl = !isNativeSol && selectedMint != null;

  // Display clock — ticks 1s while a request QR is showing (for the expiry countdown).
  useEffect(() => {
    if (phase !== 'reqQr' || !reqSnapshot || result) return;
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [phase, reqSnapshot, result]);

  // Mount reconciliation (invariant #12): load any saved merchant state and restore/repair.
  useEffect(() => {
    let alive = true;
    (async () => {
      const state = await loadSolMerchantState(identity.publicHex);
      if (!alive || !state) return;
      if (state.outcome === 'open' && !isSolReqV2Expired(state.req)) {
        setReqSnapshot(state.req);
        setReqUri(state.uri);
        setResult(null);
        setPhase('reqQr');
      } else if ((state.outcome === 'broadcasting' || state.outcome === 'unknown') && state.acceptedTx && state.acceptedSignature) {
        setReqSnapshot(state.req);
        setReqUri(state.uri);
        setReconcile({acceptedSig: state.acceptedSignature, acceptedTx: state.acceptedTx});
        setPhase('reqQr');
      } else {
        // settled / rejected / expired-open — clear + start fresh.
        await clearSolMerchantState(identity.publicHex);
      }
    })();
    return () => { alive = false; };
  }, [identity.publicHex]);

  // ── Watching for money to land is not an idle wallet (M3) ──────────────────────────────────────
  // The SOL rail's poll idles at `POLL.balanceIdle` (30s) and holds the active 2.5s cadence only
  // inside a window a money flow opens — correct for a phone in a pocket, wrong for a user standing
  // on the receive-address screen with the sender's phone in the other hand: a deposit could take
  // half a minute to appear on the one screen whose entire purpose is showing it arrive.
  //
  // Being ON this sub-mode IS the money-flow signal, so it re-opens the window the same way a
  // confirmed send does. The refresh callback is `usePollCadence`'s `bump` — it reads NOW and holds
  // the active cadence for `SOL_ACTIVE_POLL_WINDOW_MS`, so re-arming it exactly one window apart
  // keeps the fast cadence alive for as long as the screen is up and stops the moment it is not.
  // ONE callback, not both: the two are the same poll (`useSolanaBalances` answers for every rail in
  // one request), and the pick is the same `isSpl` split `onRetryAta` below already makes.
  const watchDeposit = subMode === 'address' ? (isSpl ? onRefreshToken : onRefreshSol) : undefined;
  const watchRef = useRef(watchDeposit);
  watchRef.current = watchDeposit;
  useEffect(() => {
    if (watchDeposit === undefined) return;
    watchRef.current?.();
    const id = setInterval(() => watchRef.current?.(), SOL_ACTIVE_POLL_WINDOW_MS);
    return () => clearInterval(id);
    // Keyed on the SUB-MODE and the SPL/native split only: the callbacks ride the ref, so a parent
    // re-render can never restart the timer (which would re-read on every frame — the opposite of
    // what the cadence work was for).
  }, [subMode, isSpl]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (
    <ModeToggle
      testID="receive-mode-toggle"
      value={subMode}
      onChange={(v) => onSubModeChange(v as 'request' | 'address')}
      left={{label: M.receive.requestPayment, value: 'request', testID: 'btn-receive-request'}}
      right={{label: M.receive.myAddress, value: 'address', testID: 'btn-receive-address'}}
    />
  );

  if (subMode === 'address') {
    const tokenAtaAddress = isSpl && selectedMint != null ? bs58.encode(deriveAta(solAddress, selectedMint)) : solAddress;
    // Map the per-mint token poll status onto the sheet's tri-state gate (2026-08-14 audit): only
    // a KNOWN balance shows the QR; only KNOWN absence shows the setup card. checking/unverified
    // never claim absence — fail-closed without a false "you don't have one" message. Native SOL
    // has no token account at all, so it is always 'ready'. The seam's failure classification
    // rides along untouched (R4): it picks the 'unverified' detail sentence in the sheet.
    const ataState = !isSpl
      ? 'ready'
      : tokenAtaStatus === 'balance' ? 'ready'
      : tokenAtaStatus === 'absent' ? 'absent'
      : tokenAtaStatus === 'loading' ? 'checking'
      : 'unverified';
    // "Don't have any yet?" — the Solana rail has ONE deposit mechanism and no catalog descriptor
    // to read it from: a Solana address, on Solana, which every named provider pays out to. It is
    // asserted here rather than derived because this surface IS that mechanism. Devnet is the rail's
    // own testnet declaration — a devnet coin comes from a faucet, never from a card provider.
    const fundingCard = linkAsset != null ? (
      <FundingRoutes asset={linkAsset} isTestnet={isSolanaDevnet()} mechanism="send-to-address" homeCurrency={homeCurrency} />
    ) : null;
    return (
      <View style={S.centerTop}>
        {toggle}
        {/* Same control, same place, same gesture as the IC Receive surface — the uniform-IA hard
            rule. See AssetSwitchRow for why it takes the sub-mode-preserving selector. */}
        {linkAsset != null && onReceiveRailChange != null ? (
          <AssetSwitchRow
            asset={linkAsset}
            assets={assets}
            balances={balances}
            selectedId={selectedAssetId}
            homeCurrency={homeCurrency}
            onSelect={onReceiveRailChange}
          />
        ) : null}
        {homeCurrency != null && onReceiveRailChange != null ? (
          <RailDisclosure
            currency={homeCurrency}
            assets={assets}
            balances={balances}
            catalog={catalog}
            selectedAssetId={selectedAssetId}
            onSwitch={onReceiveRailChange}
          />
        ) : null}
        <SolanaReceiveSheet
          address={tokenAtaAddress}
          uriRecipient={solAddress}
          token={selectedToken}
          mint={selectedMint}
          symbol={unit}
          decimals={decimals}
          ataStatus={ataState}
          ataFailure={tokenAtaFailure}
          solBalance={solBalance}
          tokenZero={(!isSpl && solOk && solBalance === '0') || (isSpl && tokenAtaStatus === 'balance' && (tokenAmount ?? null) === '0')}
          ataSetupBusy={ataSetupBusy}
          ataSetupErr={ataSetupErr}
          onCreateAta={onCreateAta}
          onShowSolAddress={onShowSolAddress}
          onRetryAta={isSpl ? onRefreshToken : onRefreshSol}
          returnLabel={depositReturnLabel}
          onReturn={onReturnFromDeposit}
          funding={fundingCard}
          onClose={() => onSubModeChange('request')}
        />
      </View>
    );
  }

  // Build the solreq:v2: QR. ONLINE — createSolPaymentRequest fetches genesis hash + a fresh
  // blockhash and builds a SolReqV2 with a ~90s validity window. The request is persisted BEFORE the
  // QR is shown (invariant #10: persist before send).
  async function makeRequest() {
    const typedPriceRaw = toUnits(amount, decimals);
    if (!typedPriceRaw || typedPriceRaw === '0') return;
    // An SPL request needs the registry row's mint — a token without one cannot be requested
    // (fail honestly at the button, never build a broken QR).
    if (!isNativeSol && selectedMint == null) { setErr(friendlySolError(`unknown token ${selectedToken}`)); return; }
    // NATIVE-SOL netting (founder rule 2026-09-12: the customer pays exactly the typed price —
    // the merchant pays the fees): the wire `amt` is the typed price minus the one-signature fee,
    // the SOL twin of the till's `amount_raw = price − fee`. It must land HERE, in the request the
    // payee builds — every downstream signer/verifier is byte-exact against the request, so the
    // payer cannot change the amount at sign time, and their displayed total (wire + fee) IS the
    // typed price with no payer-side change. SPL is the ONE documented exception: its fee is
    // separate-asset SOL gas, impossible to subtract from a token amount, so the typed amount
    // rides the wire verbatim (see netSolWireLamports). A price the fee would swallow is refused
    // BEFORE any wire exists — there is no honest amount left to request.
    const wireAmt = isNativeSol ? netSolWireLamports(typedPriceRaw) : typedPriceRaw;
    if (wireAmt == null) { setErr(M.receive.solAmountUnderFee(fmtAssetCompact(SOL_FEE_LAMPORTS.toString(), SOL_DECIMALS, SOL_UNIT))); return; }
    setBusy(true); setErr(null);
    const {signal, cancel} = withTimeout(SOL_BROADCAST_TIMEOUT_MS);
    try {
      // `cur` is the token literal itself; mint/toAta come from the selected token's registry
      // row. The QR codec validates shape only — membership in the registry is enforced here by
      // construction (the row exists or the button never fires).
      const input = !isNativeSol && selectedMint != null
        ? {to: solAddress, amt: wireAmt, cur: selectedToken, mint: selectedMint, toAta: bs58.encode(deriveAta(solAddress, selectedMint)), name: identity.username, memo: memo.trim()}
        : {to: solAddress, amt: wireAmt, cur: 'SOL', mint: null, toAta: null, name: identity.username, memo: memo.trim()};
      const {request, uri} = await createSolPaymentRequest(input, signal);
      setReqSnapshot(request);
      setReqUri(uri);
      setResult(null);
      setReconcile(null);
      setErr(null);
      // Persist BEFORE the QR is visible (invariant #10).
      await saveSolMerchantState(identity.publicHex, {req: request, uri, acceptedSignature: null, acceptedTx: null, outcome: 'open'});
      setPhase('reqQr');
    } catch (e: unknown) {
      setErr(friendlySolError(e instanceof Error ? e.message : String(e)));
    } finally {
      cancel();
      setBusy(false);
    }
  }

  // Scan the payer's signed solpay:v2: QR → reserve atomically → broadcast → confirm. The atomic
  // reservation (invariant #11) persists the accepted tx BEFORE the first network send so a
  // kill/restart can rebroadcast. broadcastSolPayment does strict canonical-verify + freshness +
  // signature-verify internally (no separate pre-check needed).
  async function onSignedQr(raw: string) {
    setScanning(false);
    if (!reqSnapshot || !reqUri) { setErr(M.receive.noOpenRequest); return; }
    setBusy(true);
    setErr(null);
    const {signal, cancel} = withTimeout(SOL_BROADCAST_TIMEOUT_MS);
    try {
      const solpay = decodeSolPay(raw);
      // Atomically reserve BEFORE the first network send (invariant #11).
      const parts = extractSignedTxParts(solpay.tx);
      const acceptedSig = parts ? bs58.encode(parts.signature) : '';
      const acceptedTxStr = bytesToBase64Url(solpay.tx);
      await saveSolMerchantState(identity.publicHex, {req: reqSnapshot, uri: reqUri, acceptedSignature: acceptedSig, acceptedTx: acceptedTxStr, outcome: 'broadcasting'});
      const receipt = await broadcastSolPayment(reqSnapshot, reqUri, solpay, signal);
      if (receipt.status === RECEIPT_SETTLED) {
        setResult({amount: solGrossOf(reqSnapshot.cur, reqSnapshot.amt), cur: reqSnapshot.cur, sig: receipt.sig});
        noteSettledGross(receipt.sig, reqSnapshot.cur, reqSnapshot.amt);
        awardPaymentTested(journeyRef.current);
        await clearSolMerchantState(identity.publicHex);
        setReconcile(null);
        setPhase('result');
      } else if (receipt.status === RECEIPT_REJECTED) {
        await clearSolMerchantState(identity.publicHex);
        setReconcile(null);
        setErr(M.receive.paymentRejectedDetail);
      } else if (receipt.status === RECEIPT_MISMATCH) {
        // Settle-verify MISMATCH — the confirmed tx's body is NOT this request (terminal doubt).
        // The tx may still move money, so keep the SAME durable unknown-state as UNREACHABLE
        // (reconcile/rebroadcast stays available); the copy names the check-before-handover duty.
        await saveSolMerchantState(identity.publicHex, {req: reqSnapshot, uri: reqUri, acceptedSignature: acceptedSig, acceptedTx: acceptedTxStr, outcome: 'unknown'});
        setReconcile({acceptedSig, acceptedTx: acceptedTxStr});
        setErr(M.receive.settlementNotVerified);
      } else {
        // UNREACHABLE — the tx MAY still land. Keep the accepted tx for reconciliation (invariant #12).
        await saveSolMerchantState(identity.publicHex, {req: reqSnapshot, uri: reqUri, acceptedSignature: acceptedSig, acceptedTx: acceptedTxStr, outcome: 'unknown'});
        setReconcile({acceptedSig, acceptedTx: acceptedTxStr});
        setErr(M.receive.couldNotConfirmMaySettle);
      }
    } catch (e: unknown) {
      setErr(friendlySolError(e instanceof Error ? e.message : String(e)));
    } finally {
      cancel();
      setBusy(false);
    }
  }

  // NFC reader success — same handling as onSignedQr SETTLED path.
  function onNfcResult(r: {amount: string; cur: string; sig: string} | null) {
    if (!r) return;
    setResult({amount: solGrossOf(r.cur, r.amount), cur: r.cur, sig: r.sig});
    noteSettledGross(r.sig, r.cur, r.amount);
    awardPaymentTested(journeyRef.current);
    setReconcile(null);
    clearSolMerchantState(identity.publicHex);
    setPhase('result');
  }

  // Founder rule 2026-09-14: the INCOMING log row headlines the gross too — a settled native-SOL
  // request saves {gross, fee} keyed by the tx signature (the SOL join key; the settling row will
  // carry it). SPL settles save nothing: their wire already IS the price (separate-asset gas).
  // Deliberately no `who`/`msg`: the SOL rail carries no payer name, and the payee's own memo rode
  // the request bytes, not the settlement.
  function noteSettledGross(sig: string, cur: string, wireAmt: string) {
    if (cur !== 'SOL' || sig === '') return;
    void saveTxNote(identity.publicHex, {k: sig, gross: solGrossOf(cur, wireAmt), fee: SOL_FEE_LAMPORTS.toString()}, Date.now());
  }

  // Rebroadcast a previously-accepted tx after an interrupted broadcast (reconciliation).
  async function rebroadcast() {
    if (!reconcile || !reqSnapshot || !reqUri || busy) return;
    setBusy(true); setErr(null);
    const {signal, cancel} = withTimeout(SOL_BROADCAST_TIMEOUT_MS);
    try {
      const txBytes = base64UrlToBytes(reconcile.acceptedTx);
      if (!txBytes) { setErr(M.receive.savedDataCorrupt); await clearSolMerchantState(identity.publicHex); setReconcile(null); reset(); return; }
      const solpay: SolPayV2 = {v: 2, rid: reqSnapshot.rid, tx: txBytes};
      const receipt = await broadcastSolPayment(reqSnapshot, reqUri, solpay, signal);
      if (receipt.status === RECEIPT_SETTLED) {
        setResult({amount: solGrossOf(reqSnapshot.cur, reqSnapshot.amt), cur: reqSnapshot.cur, sig: receipt.sig});
        noteSettledGross(receipt.sig, reqSnapshot.cur, reqSnapshot.amt);
        awardPaymentTested(journeyRef.current);
        await clearSolMerchantState(identity.publicHex);
        setReconcile(null);
        setPhase('result');
      } else if (receipt.status === RECEIPT_REJECTED) {
        await clearSolMerchantState(identity.publicHex);
        setReconcile(null);
        setErr(M.receive.paymentRejected);
      } else if (receipt.status === RECEIPT_MISMATCH) {
        // Same durable unknown-state as the first-scan mismatch (reconcile stays armed).
        await saveSolMerchantState(identity.publicHex, {req: reqSnapshot, uri: reqUri, acceptedSignature: reconcile.acceptedSig, acceptedTx: reconcile.acceptedTx, outcome: 'unknown'});
        setErr(M.receive.settlementNotVerified);
      } else {
        setErr(M.receive.stillCannotConfirm);
      }
    } catch (e: unknown) {
      setErr(friendlySolError(e instanceof Error ? e.message : String(e)));
    } finally {
      cancel();
      setBusy(false);
    }
  }

  function reset() { setReqUri(null); setReqSnapshot(null); setResult(null); setScanning(false); setErr(null); setMemo(''); setReconcile(null); setNfcActive(false); setNfcKey(k => k + 1); setPhase('form'); }

  const copySig = async () => {
    if (result?.sig) { await doCopy(result.sig); }
  };

  if (phase === 'result' && result && !nfcActive) {
    return (
      <View style={S.center}>
        {toggle}
        <View style={S.check}><IconCheck size={44} color={C.brandInk}/></View>
        <Text testID="sol-req-status" style={S.paidText}>{M.receive.receivedAmount(fmtAssetCompact(result.amount, result.cur === 'SOL' ? SOL_DECIMALS : solanaTokenInfo(result.cur)?.decimals ?? SOL_DECIMALS, result.cur === 'SOL' ? SOL_UNIT : result.cur))}</Text>
        {result.sig ? (
          <>
            <Text style={S.dim2}>{M.receive.transactionSignature}</Text>
            <Text testID="sol-req-sig" selectable={true} style={S.sheetAddr}>{result.sig}</Text>
            <Pressable testID="btn-sol-req-copy" style={S.primaryWide} onPress={copySig} accessibilityRole="button" accessibilityLabel={M.receive.copySignatureA11y}>
              <IconCopy size={18} color={C.brandInk}/>
              <Text style={S.primaryText}>{copied === 'clipboard' ? M.pay.copied : copied === 'shared' ? M.receive.sharedConfirm : M.receive.copySignature}</Text>
            </Pressable>
          </>
        ) : null}
        <Pressable testID="btn-sol-req-done" style={[S.ghostBtn, S.ghostBtnMuted]} onPress={reset} accessibilityRole="button" accessibilityLabel={M.receive.newRequest} accessibilityState={{disabled: false}}>
          <Text style={S.ghostBtnText}>{M.receive.newRequest}</Text>
        </Pressable>
      </View>
    );
  }

  if (phase === 'reqQr' && reqUri) {
    // The headline is the TYPED price; for native SOL the wire `amt` is netted (price − fee — the
    // netting in makeRequest), so the price is re-derived as wire + fee: the exact inverse, the
    // same sum the payer's total display makes, and the only truth that survives a kill/restart
    // (the request restores from solMerchantPersist with the form empty). SPL wires are verbatim,
    // so their headline stays the wire amount. Misuse-proof by name: `typedPriceRaw` is never the
    // QR's amount — `reqSnapshot.amt` is.
    const typedPriceRaw = reqSnapshot!.cur === 'SOL' ? String(BigInt(reqSnapshot!.amt) + SOL_FEE_LAMPORTS) : reqSnapshot!.amt;
    return (
      <View style={S.center}>
        {toggle}
        {/* Reader runs in the background while the QR is shown: the payer taps OR scans. */}
        {nfcReady && DpaySolNfc ? (
          <SolNfcTap
            key={nfcKey} role="reader" identity={identity} req={reqSnapshot ?? undefined} reqUri={reqUri}
            onResult={onNfcResult}
            onActive={() => setNfcActive(true)}
            onClose={() => { setNfcActive(false); setNfcKey(k => k + 1); }}
          />
        ) : null}
        {!nfcActive ? (
          <>
            {reconcile ? (
              <View testID="sol-req-reconcile" style={S.reviewCard}>
                <Text style={S.reviewLabel}>{M.receive.paymentBeingConfirmed}</Text>
                <Text style={S.warnNote}>{M.receive.broadcastInterrupted}</Text>
                {err ? <Text testID="sol-req-err" style={S.err}>{err}</Text> : null}
                {busy ? (
                  <ActivityIndicator color={C.brandText} />
                ) : (
                  <Pressable testID="btn-sol-req-retry" style={S.primaryWide} onPress={rebroadcast} accessibilityRole="button" accessibilityLabel={M.receive.retryBroadcast}>
                    <Text style={S.primaryText}>{M.receive.retryBroadcast}</Text>
                  </Pressable>
                )}
              </View>
            ) : null}
            {!scanning && !busy ? (
              <>
                {/* Same three-way split as the IC rail, and for the same reasons: a working
                    radio leaves only "this code is tappable" to say, a radio that is off, absent
                    or unreadable leaves an instruction (`NfcStatusRow`), and the web wallet has no
                    radio to report on at all. */}
                {nfcReady || Platform.OS === 'web' ? (
                  <View style={S.nfcHintRow}>
                    <Text style={S.nfcHintLabel}>{M.receive.showToPayer('tap')}</Text>
                  </View>
                ) : (
                  <NfcStatusRow nfcStatus={nfcStatus} testID="sol-receive-nfc" />
                )}
                {/* The QR is the LINK (founder decision 2026-09-12) — any phone camera opens it:
                    dpay on a dpay phone, the web wallet otherwise. `payLink` is non-null exactly
                    when this branch renders (reqSnapshot and reqUri are set together on every
                    path), mirroring the `reqSnapshot!` read below. The URL is SHORTER than the old
                    solreq, so QR_SIZE_SMALL keeps gaining margin. */}
                <View testID="sol-req-qr" style={S.qrCard}><QrCode value={payLink!} size={QR_SIZE_SMALL} ecl="M" /></View>
                <Text testID="sol-req-price" style={S.amountBig}>{fmtAssetCompact(typedPriceRaw, decimals, unit)}</Text>
                {/* The ONE honest fee/receives line, native SOL only — the fee was netted out of
                    the wire, so the payee sees both numbers (same row discipline as the IC till's
                    settlesAs). SPL keeps its existing display only: nothing was subtracted, and a
                    token-fee line would invent a fee nobody pays in that asset. */}
                {reqSnapshot!.cur === 'SOL' ? (
                  <Text testID="sol-req-fee-line" style={S.qrHint}>{M.receive.solFeeLine(fmtAssetCompact(SOL_FEE_LAMPORTS.toString(), SOL_DECIMALS, SOL_UNIT), fmtAssetCompact(reqSnapshot!.amt, decimals, unit))}</Text>
                ) : null}
                {(() => {
                  const remaining = (reqSnapshot?.exp ?? 0) - now;
                  if (remaining <= 0) return <Text style={S.qrExpired}>{M.receive.expiredMakeNew}</Text>;
                  const m = Math.floor(remaining / 60);
                  const s = remaining % 60;
                  // P3 — a small clock icon leads the calm validity line (QR-card polish).
                  if (m >= 1) return (
                    <View style={{flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6}}>
                      <IconClock size={14} color={C.sub}/>
                      <Text style={[S.qrExpiry, {marginTop: 0}]}>{M.receive.validForMin(m)}</Text>
                    </View>
                  );
                  return <Text style={S.qrExpiryWarn}>{M.receive.expiresIn(s.toString().padStart(2, '0'))}</Text>;
                })()}
                <Text style={S.qrHint}>{M.receive.waitingForSign}</Text>
                {/* Trip Ready J4 — the same receiveRequest truth ("your connection confirms"):
                    the merchant's own connection scans + settles the payer's signed payment.
                    Reading-zone mount (after the status line, before the action cluster) — same
                    placement decision as the IC ReceiveMode. */}
                <CoachTip tipKey="receiveRequest" />
                {/* Share carries the SAME link the QR renders — the same affordance, in the same
                    place, as the IC rail's (same-surfaces hard rule): a payer over a chat app and
                    a payer with a camera land on the same send form. */}
                <Pressable
                  testID="btn-share-request"
                  style={S.ghostBtn}
                  onPress={() => { share(payLink!); }}
                  accessibilityRole="button"
                  accessibilityLabel={M.receive.shareRequestLink}
                  accessibilityHint={M.receive.shareRequestHint}
                  accessibilityState={{disabled: false}}>
                  <IconShare size={16} color={C.sub}/>
                  <Text style={S.ghostBtnText}>{shared ? shareConfirmLabel(M.pay.linkCopied) : M.receive.shareRequestLink}</Text>
                </Pressable>
                <Pressable style={S.ghostBtn} onPress={() => setScanning(true)} accessibilityRole="button" accessibilityLabel={M.receive.scanPayerSignedCode} accessibilityHint={M.receive.scanPayerSignedQrHint} accessibilityState={{disabled: false}}>
                  <IconQr size={16} color={C.sub}/>
                  <Text style={S.ghostBtnText}>{M.receive.scanPayerSignedCode}</Text>
                </Pressable>
                {err && !reconcile ? <Text testID="sol-req-err" style={S.err}>{err}</Text> : null}
                <Pressable style={[S.ghostBtn, S.ghostBtnMuted]} onPress={reset} accessibilityRole="button" accessibilityLabel={M.receive.newRequest} accessibilityState={{disabled: false}}>
                  <Text style={S.ghostBtnText}>{M.receive.newRequest}</Text>
                </Pressable>
              </>
            ) : busy ? (
              <>
                <ActivityIndicator color={C.brandText} />
                <Text style={S.dim2}>{M.receive.broadcasting}</Text>
              </>
            ) : (
              <>
                <QrScanner onScan={onSignedQr} />
                <Text style={S.dim2}>{M.receive.scanPayerSignedCode}</Text>
                {err ? <Text testID="sol-req-err" style={S.err}>{err}</Text> : null}
                <Pressable style={[S.ghostBtn, S.ghostBtnMuted]} onPress={() => setScanning(false)} accessibilityRole="button" accessibilityLabel={M.receive.back} accessibilityState={{disabled: false}}>
                  <Text style={S.ghostBtnText}>{M.receive.back}</Text>
                </Pressable>
              </>
            )}
          </>
        ) : null}
      </View>
    );
  }

  // phase === 'form'
  return (
    <View style={S.centerTop}>
      {toggle}
      {/* WHICH CODE — the same checkbox, on the SOL rail exactly as on the IC one — the
          same-surfaces hard rule: a control that appeared only where it can succeed would be a
          per-rail special case, and the merchant would be left guessing whether their phone can do
          it at all. What gates it is the RELAY and not the rail: a relay that serves no till shows
          the checkbox on neither rail. Where it does show, checking it keeps the shared amount row
          AND the shared message row (one box, both modes, text surviving the toggle — founder
          2026-09-14, exactly the IC rail's) and swaps the button for the till's own — which lands
          on the honest closed branch (a till code is paid in VCHF on the Internet Computer, and
          this request is on Solana) with the one tap that fixes it. No
          `onHoldsForm`: a charge can never go live from this rail, so a held-form reporter would be
          dead code. */}
      {!tillAvailable || codeForm !== 'till' ? <CoachTip tipKey="receiveRequest" /> : null}
      <Text style={S.label}>{M.receive.amountToReceive}</Text>
      <View style={S.amountRow}>
        <Pressable
          testID="sol-req-prefix"
          style={S.prefixBtn}
          onPress={() => setPickOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={M.receive.receiveIn(selectedToken)}
          accessibilityHint={M.receive.chooseAssetHint}
          accessibilityState={{disabled: false}}>
          <Text style={S.currency}>{isNativeSol ? '◎' : selectedToken === 'EURC' ? '€' : selectedToken === 'USDC' ? '$' : '¤'}</Text>
          <IconChevronDown size={20} color={C.sub}/>
        </Pressable>
        <TextInput
          testID="sol-req-amount-input"
          style={S.amountInput}
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
          placeholder={M.receive.solAmountPlaceholder}
          placeholderTextColor={C.sub}
          accessibilityLabel={M.receive.amountToReceive}
        />
      </View>
      {/* The ONE message box, both code forms (founder 2026-09-14) — same component, same place
          under the shared amount row, same text across the till-checkbox toggle. dpay form: the
          link's memo. Till form: the charge's signed note (handed to TillCharge below). The IC
          rail's box is identical in role — the same-surfaces rule. */}
      <TextInput
        testID="sol-req-memo-input"
        style={memoInputStyle()}
        value={memo}
        onChangeText={setMemo}
        placeholder={M.receive.memoPlaceholder}
        placeholderTextColor={C.sub}
        accessibilityLabel={M.receive.memo}
        maxLength={32}
      />
      {tillAvailable ? (
        <View testID="receive-code-form" style={{alignSelf: 'stretch'}}>
          <Pressable
            testID="btn-code-till"
            style={{flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch', marginTop: 6, marginBottom: 10, minHeight: 44}}
            onPress={() => onCodeFormChange(codeForm === 'till' ? 'dpay' : 'till')}
            accessibilityRole="checkbox"
            accessibilityLabel={M.receive.till.tillCode}
            accessibilityState={{checked: codeForm === 'till'}}>
            <View style={{width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: codeForm === 'till' ? C.brand : C.sub2, backgroundColor: codeForm === 'till' ? C.brand : 'transparent', alignItems: 'center', justifyContent: 'center', marginRight: 10}}>
              {codeForm === 'till' ? <IconCheck size={14} color={C.brandInk} /> : null}
            </View>
            <Text style={{color: C.sub, fontSize: 15, flex: 1}}>{M.receive.till.tillCode}</Text>
          </Pressable>
        </View>
      ) : null}
      {tillAvailable && codeForm === 'till' ? (
        <TillCharge
          identity={identity}
          relayUrl={relayUrl}
          asset={assets.find(a => a.id === selectedAssetId) ?? null}
          assets={assets}
          catalog={catalog}
          nfcStatus={nfcStatus}
          onSelectAsset={onSelectAsset}
          amount={amount}
          note={memo}
        />
      ) : (
        <>
      {/* 2026-08-14 audit: a token request whose settlement is doomed must not be creatable. If the
          device's token account is KNOWN absent, the payer would sign a transferChecked to a
          non-existent account — broadcast fails AFTER they walked away. Inline the same one-tap
          setup card and block Request (known-absent only; loading/error/unavailable do not block —
          the honest unknown-handling the founder set when the dead-end gate was removed in 19c6e8f). */}
      {isSpl && tokenAtaStatus === 'absent' ? (
        <SolanaAtaSetupCard
          asset={unit}
          instrTestID="sol-req-ata"
          btnTestID="btn-sol-req-ata-create"
          buttonLabel={M.pay.createTokenAccount(unit)}
          hasSol={solBalance != null && BigInt(solBalance) >= SOL_ATA_SETUP_MIN_LAMPORTS}
          checkingSol={solBalance == null}
          busy={ataSetupBusy}
          err={ataSetupErr}
          onCreateAta={onCreateAta}
          onShowSolAddress={onShowSolAddress}
        />
      ) : null}
      {!solRpc ? <Text style={S.warnNote}>{M.receive.solanaOffline}</Text> : null}
      {busy ? (
        <>
          <ActivityIndicator color={C.brandText} />
          <Text style={S.dim2}>{M.receive.creatingRequest}</Text>
        </>
      ) : null}
      {err ? <Text style={S.err}>{err}</Text> : null}
      {(() => {
        const tokenAbsent = isSpl && tokenAtaStatus === 'absent';
        const blocked = !solRpc || busy || tokenAbsent;
        return (
          <Pressable
            testID="btn-sol-req-make"
            style={[S.primaryWide, blocked && S.disabledFlat]}
            disabled={blocked}
            onPress={makeRequest}
            accessibilityRole="button"
            accessibilityLabel={M.receive.request}
            accessibilityHint={M.receive.requestHint}
            accessibilityState={{disabled: blocked}}>
            <Text style={[S.primaryText, blocked && S.disabledText]}>{busy ? M.receive.creating : M.receive.request}</Text>
          </Pressable>
        );
      })()}
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
