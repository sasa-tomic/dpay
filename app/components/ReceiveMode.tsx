import {useEffect, useMemo, useRef, useState} from 'react';
import {View, Text, Pressable, TextInput, Platform, type TextStyle} from 'react-native';
import {QrCode} from './QrCode';
import {C, FONT} from '../config/palette';
import {S} from '../styles';
import {EXPIRY_WINDOW, NFC_UPDATE_AHEAD_S, POLL, PROOF_POLL_BUDGET, QR_SIZE} from '../config/constants';
import {toUnits, randNonceHex, nowSecs, rawToDecimal} from '../lib/format';
import {nettedWireRaw} from '../lib/amount';
import {encodePayLink, shareOrigin, decodeReceiptDeeplink, parseRailProof} from '../lib/deepLink';
import {type CurrencyDescriptor, type FamilyDisplay, fmtCurrencyAmountCompact, currencySymbol, depositMechanism, isTestnetCurrency} from '../config/catalog';
import {linkNetworkOf, type SelectableAsset} from '../config/assets';
import {type HomeCurrency, currencyRails} from '../config/currency';
import {type BalanceView} from '../lib/assetBalances';
import type {Identity, AssetId, NfcStatus} from '../lib/types';
import {qrPayloadToEnvelopeHex, submitAndConfirmIncomingTransfer, confirmIncomingTransfer, fetchLedgerFee} from '../services/rail';
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

// The optional merchant memo input — the ONE message box for BOTH code forms (dpay link memo in
// one, the till's signed note in the other; founder 2026-09-14: same box, same place, same text
// across the till-checkbox toggle) — a real secondary field (not a bare text link), mirroring the
// paste-button affordance pattern (44pt-min touch target + a visible border). Inline (Group E owns
// styles.ts as ONE block): Traveler Paper input idiom — white field + hairline line2 border +
// Space Grotesk, matching usernameInput/withdrawAddrInput (the old dark-theme transparent-bg +
// heavy sub2 outline read as a stray box on porcelain). Full-width (alignSelf stretch so it lines
// up with the amount row above and the Request button below — was a narrower maxWidth:320 that
// left the field floating shorter than its neighbors), 44pt-min.
// A FUNCTION, not a const: `C` is mutated in place on a theme flip, so a module-level style
// object froze the light theme's white field + near-black ink into the dark theme's memo input.
const memoInputStyle = (): TextStyle => ({alignSelf: 'stretch', marginTop: 14, minHeight: 44, backgroundColor: C.card, borderWidth: 1, borderColor: C.line2, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16, color: C.ink, fontFamily: FONT.sans});

export function ReceiveMode({identity, relayUrl, online, nfcStatus, onReceived, catalog, depositCurrency, depositDisplay, depositChainId, depositNativeEth, subMode, onSubModeChange, codeForm, onCodeFormChange, tillAvailable, depositReturnLabel = null, onReturnFromDeposit, prefillReceipt, onReceiptConsumed, selectedCurrency, assets, selectedAssetId, balances, onSelectAsset, onSelectAssetProgrammatic, onLockChange, homeCurrency = null, onReceiveRailChange}: {identity: Identity; relayUrl: string; online: boolean; nfcStatus: NfcStatus; onReceived: () => void; catalog: CurrencyDescriptor[]; depositCurrency: number; depositDisplay: FamilyDisplay | null; depositChainId: number | null; depositNativeEth: boolean; subMode: 'request' | 'address'; onSubModeChange: (m: 'request' | 'address') => void; codeForm: 'dpay' | 'till'; onCodeFormChange: (f: 'dpay' | 'till') => void; tillAvailable: boolean; depositReturnLabel?: string | null; onReturnFromDeposit?: () => void; prefillReceipt?: string | null; onReceiptConsumed?: () => void; selectedCurrency: number; assets: SelectableAsset[]; selectedAssetId: AssetId | null; balances: Record<AssetId, BalanceView>; onSelectAsset: (id: AssetId) => void; onSelectAssetProgrammatic: (id: AssetId) => void; onLockChange?: (locked: boolean) => void; homeCurrency?: HomeCurrency | null; onReceiveRailChange?: (id: AssetId) => void}) {
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
  // A request carries TWO raw amounts and they are NOT interchangeable (founder rule 2026-09-12:
  // if something costs $1, the customer pays exactly $1 — the merchant pays the fees):
  // `priceRaw` is what the payee TYPED — integer smallest-units (2-decimal for DEMO, 8 for BTC,
  // 6 for USDC), a raw-u64 decimal STRING (MC1 units 2-4) — and stays the payee-facing headline;
  // `wireRaw` is the NETTED transfer amount (price − ledger fee, `nettedWireRaw`) that the link
  // `amount=`, the NFC 132-byte wire and EVERY confirm consumer carry — the payer pays it
  // verbatim, so the payer's account moves by exactly the price. `feeRaw` is the fee the wire was
  // netted with, null = not netted (DEMO, or the fee was unknowable — then `wireRaw === priceRaw`
  // and the payer pays price+fee, honestly displayed on their review). `link` is THE QR: the
  // payment link, built once at request time so the code a payer scans can never drift from the
  // request state it reconciles against. The 132-byte wire request is gone from this screen
  // (founder decision 2026-09-12) — a machine code survives only where a radio needs it (`nfcHex`).
  const [reqQr, setReqQr] = useState<{link: string; priceRaw: string; wireRaw: string; feeRaw: string | null; currency: number; nonce: string; nfcHex: string | null; nfcExpiry: number | null; expiry: number} | null>(null);
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

  // TillCharge HOLDS THE FORM: from the first ring-up attempt until the cashier presses "next
  // customer" — a live code, a paid screen, an ended one, a failed one. Reported by TillCharge
  // (which owns the charge) and folded into the lock below, because everything that is true of an
  // open request QR is true of it — plus one thing that is not: the charge outlives this screen,
  // so navigating away leaves money payable with nobody watching. That is why the toggle, the
  // shared rows and the checkbox are hidden while it holds, exactly as the toggle is while a
  // request QR is up.
  const [tillHeld, setTillHeld] = useState(false);

  // A capability can drop under the merchant (a relay retarget, or a relay that stops serving the
  // till), and `codeForm` outlives it — it is owned by the wallet so a rail switch cannot lose it.
  // Left stale, the checkbox comes back checked over a dpay request form: a mode the merchant is
  // in without having chosen it. The reset belongs HERE and not beside the capability probe
  // because `tillHeld` is only known here — and it cannot un-mount a charge: in the very state it
  // runs in (`!tillAvailable && !tillHeld`) the render below has already replaced the till form
  // with the dpay one, so this only makes the state agree with the screen.
  useEffect(() => {
    if (tillAvailable || tillHeld || codeForm !== 'till') return;
    onCodeFormChange('dpay');
  }, [tillAvailable, tillHeld, codeForm, onCodeFormChange]);

  // Phase 5 — lock the idle asset selection while a request QR is showing, a settlement result is
  // displayed, or the till form is held. All three hold an in-flight money op the user must not
  // lose to an asset switch (the QR is the payment link a payer may be opening; the result is the
  // settled outcome; the till charge is payable on the relay). The idle form is free.
  const locked = !!reqQr || !!result || tillHeld;
  useReportLock(onLockChange, locked);

  // Tick the display clock only while a request QR is shown (not after settlement) — display-only,
  // so a plain setInterval (not the network POLL seam) is the right cadence for a countdown.
  useEffect(() => {
    if (!reqQr || result) return;
    const id = setInterval(() => setNow(nowSecs()), 1000);
    return () => clearInterval(id);
  }, [reqQr, result]);
  // Stable across renders (NfcTap's effect depends on it) — only changes when the request does.
  // `amount` is the WIRE raw (what lands on the ledger), the same netted number the till's
  // reader advertises — the payer's tap-confirm matches ledger history against it. Founder rule
  // 2026-09-14 adds `displayAmount`: the payee's tap readout headlines the TYPED PRICE (the
  // gross), with the wire untouched as the ledger/reconciliation truth below it.
  const readerReqInfo = useMemo(
    () => (reqQr ? {amount: reqQr.wireRaw, displayAmount: reqQr.priceRaw, nonce: reqQr.nonce, who: M.receive.payer, currency: reqQr.currency} : undefined),
    [reqQr],
  );

  // Resolve the selected asset's display config ONCE per render. Decimals come from the catalog
  // descriptor directly (NOT familyDisplay, which falls back to BTC's 8 + would mis-render DEMO's
  // 2). The amount-input prefix is the currency's display glyph (∂/₿/$) via currencySymbol.
  const reqDesc = catalog.find(c => c.currency === selectedCurrency);
  const reqDecimals = reqDesc?.decimals ?? 2;
  const reqPrefix = currencySymbol(catalog, selectedCurrency);

  // The asset this whole tab is about — the merchant's chosen settlement asset. Read once and used
  // by both code forms: the dpay link names it, and the till answers whether a charge can be rung
  // up in it at all.
  const activeAsset = assets.find(a => a.id === selectedAssetId) ?? null;

  // The LEDGER FEE for the asset a request will be quoted in, live from the paying ledger (the
  // same `fetchLedgerFee` PayMode/SendSheet use — the ledger is authoritative, the catalog's
  // `fee` is stale-tolerant display metadata). This is the payee-side half of the exact-price
  // rule (founder 2026-09-12): the fee is netted OUT of the wire at quote time, so the customer
  // pays the price and this wallet pays the fee. Unknown (offline, query failed) stays null and
  // `makeRequest` falls back to the catalog fee, then to no netting at all — never a guessed 0
  // (the PayMode fee-house rule). DEMO (currency 0) is play money: no fee to net, no query —
  // the request path stays bit-for-bit what it was.
  const [feeRaw, setFeeRaw] = useState<string | null>(null);
  useEffect(() => { setFeeRaw(null); }, [selectedCurrency]);
  useEffect(() => {
    if (selectedCurrency === 0) return; // DEMO is play money — no honest fee to net
    const ledger = catalog.find(c => c.currency === selectedCurrency)?.ledger;
    if (!ledger) return;
    let alive = true;
    void (async () => {
      try {
        const fee = await fetchLedgerFee(identity.secretHex, ledger);
        if (alive) setFeeRaw(fee);
      } catch (e: unknown) {
        console.warn('request fee fetch failed (wire falls back to the catalog fee):', e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { alive = false; };
  }, [selectedCurrency, catalog, identity.secretHex]);

  async function makeRequest() {
    const priceRaw = toUnits(amount, reqDecimals);
    if (!priceRaw || priceRaw === '0') return;
    // A press can outrun the mount-time principal derivation's first state flush — derive it
    // directly then (a local core call, no network; the state catches up on its own). The QR is
    // the payment link, so a request that cannot name its destination or its asset must never
    // open — there would be nothing honest to render. Every request-capable catalog row carries a
    // link token today (`assetLinkToken`'s null is a bare-glyph row); this gate is the fail-closed
    // backstop, same idiom as the SOL rail's unknown-mint refusal.
    const principal = selfPrincipal ?? await DpayCore.icpSelfPrincipal(identity.secretHex).catch(() => null);
    if (principal == null || activeAsset == null || activeAsset.linkToken == null) { setErr(M.receive.linkUnavailable); return; }
    try {
      const nonce = randNonceHex();
      const expiry = nowSecs() + EXPIRY_WINDOW;
      const memoVal = memo.trim();
      // Exact-price rule (founder 2026-09-12: if something costs $1, the customer pays exactly
      // $1 — the merchant pays the fees): net the ledger fee out of the wire HERE, at quote
      // time, the same way the dpay till does (`till_raw_units`). Live ledger fee when the
      // effect has one, else the catalog's row, else nothing — an unknown fee never blocks or
      // fakes a number (the payer then pays price+fee, honestly displayed on their review). A
      // price that does not clear the fee is refused BEFORE any wire exists — a zero-unit wire
      // is money nonsense.
      const feeKnown = feeRaw ?? reqDesc?.fee ?? null;
      const priced = nettedWireRaw(priceRaw, feeKnown);
      if (!priced.ok) {
        setErr(M.receive.feeTooBig(fmtCurrencyAmountCompact(catalog, selectedCurrency, feeKnown!)));
        return;
      }
      const wireRaw = priced.wireRaw;
      // Founder decision 2026-09-12: the QR renders the payment LINK on every rail — a regular
      // phone camera opens dpay (verified App Link) or the web wallet. The link's `ref` is the
      // request nonce, which is also the on-chain memo the settlement poll matches, so a
      // camera-scanned link payment reconciles on this screen exactly like the old machine code.
      // `amount` is the NETTED wire decimal — the payer pays the wire verbatim, which with a
      // known fee re-parses to exactly `wireRaw` (their review adds the fee back on top, so
      // their account still moves by the price); with NO fee known the typed decimal rides
      // verbatim, exactly as before the rule. Username + memo ride as label/memo.
      const link = encodePayLink(shareOrigin(), {
        recipient: principal,
        asset: activeAsset.linkToken,
        network: linkNetworkOf(activeAsset),
        amount: feeKnown != null ? rawToDecimal(wireRaw, reqDecimals) : amount.trim(),
        label: identity.username,
        memo: memoVal,
        ref: nonce,
      });
      // Build the NFC machine code too so reader mode can start alongside the QR (best-effort).
      // It carries the SAME netted wire raw as the link (one request, one number everywhere);
      // the merchant's username + memo ride as to_name/memo in the request bytes.
      let nfcHex: string | null = null;
      let nfcExpiry: number | null = null;
      if (nfcReady && DpayNfc) {
        try {
          const nfcExpiryNs = await icStampExpiry(identity.secretHex, NFC_UPDATE_AHEAD_S);
          nfcExpiry = Number(BigInt(nfcExpiryNs) / 1_000_000_000n);
          nfcHex = await DpayNfc.buildRequest(identity.publicHex, wireRaw, nonce, nfcExpiry, selectedCurrency, identity.username, memoVal);
        } catch (e) {
          console.warn('NFC certified expiry unavailable (QR still works):', e instanceof Error ? e.message : String(e));
        }
      }
      setReqQr({link, priceRaw, wireRaw, feeRaw: feeKnown, currency: selectedCurrency, nonce, nfcHex, nfcExpiry, expiry});
      // Payee-side annotation (services/txNotes): the note for the INCOMING row this request will
      // land, keyed by the request nonce (= the on-chain memo). The memo rides when the payee
      // typed one; the gross/fee ride ALWAYS (founder rule 2026-09-14): the row headlines the
      // TYPED PRICE with the fee as its annotation line, while the wire stays the ledger/
      // reconciliation truth everywhere else. Deliberately NO `who` — the counterparty is the
      // payer, and the IC rail carries no payer name; the row keeps the payer's principal prefix
      // (honest). A note with neither memo nor fee (fee unknown, wire = price) is the no-op the
      // store makes it — nothing to annotate, the ledger row is already the whole truth.
      void saveTxNote(identity.publicHex, {k: nonce, msg: memoVal || undefined, gross: priceRaw, ...(feeKnown != null ? {fee: feeKnown} : {})}, Date.now());
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
          amount: reqQr.wireRaw,
          memoHex: reqQr.nonce,
        }, {attempts: PROOF_POLL_BUDGET, intervalMs: POLL.receiptRcv});
        if (!alive) return;
        if (settled) {
          setResult({amount: reqQr.priceRaw, currency: reqQr.currency, from: M.receive.payer});
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

  // The settlement poll (founder decision 2026-09-12): while a request is open and the relay is
  // reachable, watch the ledger for the transfer that pays it. The QR is the payment LINK and its
  // `ref` = the request nonce = the on-chain memo, so a payer who camera-scans the QR (or pays it
  // from the web wallet) needs no signed-QR scan-back — this poll is what flips the screen to
  // Received. Runs only while the request screen is live; the scan-back/NFC confirm paths set the
  // same result when they fire, and `result` in the deps tears this poll down after the first.
  useEffect(() => {
    if (!reqQr || result || !online) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (!alive) return;
      let settled = false;
      try {
        settled = await confirmIncomingTransfer({
          relayUrl,
          receiverPublicHex: identity.publicHex,
          currency: reqQr.currency,
          amount: reqQr.wireRaw,
          memoHex: reqQr.nonce,
        }, {attempts: 1, intervalMs: POLL.request});
      } catch {
        // A transient relay error is not a verdict: the next tick retries.
      }
      if (!alive) return;
      if (settled) {
        setResult({amount: reqQr.priceRaw, currency: reqQr.currency, from: M.receive.payer});
        onReceived();
        awardPaymentTested(journeyRef.current);
        return;
      }
      timer = setTimeout(tick, POLL.request);
    };
    timer = setTimeout(tick, POLL.request);
    return () => { alive = false; if (timer) clearTimeout(timer); };
    // Capture-at-fire-time: identity/relayUrl are stable for the screen's life, and reqQr is the
    // request this poll is bound to (a new request remounts the poll with fresh facts).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqQr, result, online]);

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
        amount: reqQr.wireRaw,
        memoHex: reqQr.nonce,
      }, {attempts: PROOF_POLL_BUDGET, intervalMs: POLL.receiptRcv});
      if (settled) {
        setResult({amount: reqQr.priceRaw, currency: reqQr.currency, from: M.receive.payer});
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
        <Text style={S.paidText}>{M.receive.receivedAmount(fmtCurrencyAmountCompact(catalog, result.currency, result.amount))}</Text>
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
            {/* The QR IS the payment link (founder decision 2026-09-12) — any phone camera opens
                it: dpay on a dpay phone, the web wallet otherwise. ecl M holds the brand mark's
                occlusion budget at this URL length (the pixel-decode gate, flow qr-scannable,
                is the proof). */}
            <View testID="request-qr" style={S.qrCard}><QrCode value={reqQr.link} size={QR_SIZE} ecl="M" /></View>
        <Text style={S.amountBig}>{fmtCurrencyAmountCompact(catalog, reqQr.currency, reqQr.priceRaw)}</Text>
        {/* The exact-price fee disclosure (founder rule 2026-09-12): ONE dim line under the
            price headline — the ledger fee this payee absorbs, and what actually arrives once it
            is netted out of the wire. Only a wire that WAS netted (a known fee) earns the line;
            an unknown fee invents no numbers. Same visual family as the expiry line below. */}
        {reqQr.feeRaw != null && reqQr.wireRaw !== reqQr.priceRaw ? (
          <Text testID="request-fee-line" style={S.qrExpiry}>
            {M.receive.feeNetLine(
              fmtCurrencyAmountCompact(catalog, reqQr.currency, reqQr.feeRaw),
              fmtCurrencyAmountCompact(catalog, reqQr.currency, reqQr.wireRaw),
            )}
          </Text>
        ) : null}
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
            {/* Share carries the SAME link the QR renders — the code and the shared message are
                one payment, so a payer over a chat app and a payer with a camera land on the same
                review. Paying it twice pays twice — the ledger has no duplicate check here
                (`icp_transfer_arg` in dpay-ffi). */}
            <Pressable
              testID="btn-share-request"
              style={S.ghostBtn}
              onPress={() => {
                share(reqQr.link);
              }}
              accessibilityRole="button"
              accessibilityLabel={M.receive.shareRequestLink}
              accessibilityState={{disabled: false}}>
              <IconShare size={16} color={C.sub}/>
              <Text style={S.ghostBtnText}>{shared ? shareConfirmLabel(M.pay.linkCopied) : M.receive.shareRequestLink}</Text>
            </Pressable>
            {scanning ? (
              <><QrScanner onScan={onSignedQr} /><Text style={S.dim2}>{M.receive.scanPayerSignedCode}</Text></>
            ) : (
              <>
                <Pressable style={S.ghostBtn} onPress={() => setScanning(true)} accessibilityRole="button" accessibilityLabel={M.receive.scanPayerSignedCode} accessibilityState={{disabled: false}}><IconQr size={16} color={C.sub}/><Text style={S.ghostBtnText}>{M.receive.scanPayerSignedCode}</Text></Pressable>
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
  // A complete no-minter direct-ICRC row (VCHF/ICP) → IcrcDepositSheet: the user's own ICRC-1
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
      {mechanism !== 'none' && !tillHeld ? (
        <ModeToggle
          testID="receive-mode-toggle"
          value={subMode}
          onChange={(v) => onSubModeChange(v as 'request' | 'address')}
          left={{label: M.receive.requestPayment, value: 'request', testID: 'btn-receive-request'}}
          right={{label: M.receive.myAddress, value: 'address', testID: 'btn-receive-address'}}
        />
      ) : null}
      {/* WHICH CODE, i.e. who can pay it — the same request, two audiences. A dpay code is this
            wallet's payment link: any phone camera opens it — dpay on a dpay phone, the web wallet
            otherwise (founder decision 2026-09-12); a till code is this merchant's own
            OpenCryptoPay charge, which any wallet that speaks the standard could in principle scan.
            It is a CHECKBOX and not a second form because the request is one request: the amount
            row above is shared, and so is the MESSAGE row — one box, the same component in the same
            place whether or not the box is checked, and its text survives the toggle in both
            directions (founder 2026-09-14: the box must not move, restyle or reset). The text is
            the dpay link's memo in one mode and the till's signed note in the other — the same
            "what is this for" either way — and the box flips the single button below between the
            two payloads. Unchecked — the dpay code — is the default. Hidden while TillCharge
            holds the form, exactly as the toggle above is while a request QR is up: flipping away
            would abandon a code a customer can still pay. */}
      {/* The capability flag gates ENTRY to this form; it never un-mounts a HELD one. If the
          relay is retargeted or drops mid-charge, `tillAvailable` flips false but `tillHeld` keeps
          TillCharge mounted — its own poll then says "Can't check this charge right now", which is
          the honest rendering of silence. Un-mounting here would render the outage as the ABSENCE
          of a sale (flow 116's whole contract). */}
      {!tillHeld ? (
        <>
          {/* Trip Ready J4 (UX hardening 2026-08-23) — the coach card ALSO mounts at the ENTRY form
              (was: only after pressing Request, so first-time receivers never saw it). Same one-time
              seen marker — whichever surface shows it first wins; the card never returns after.
              The dpay form only: a till entry is about the charge, not about requesting. */}
          {((tillAvailable || tillHeld) && codeForm === 'till') ? null : <CoachTip tipKey="receiveRequest" />}
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
                hardware keyboard attached to a phone. The DPAY form only: a ring-up is signed and
                supersedes the live charge, so the shared field does not submit while the till
                checkbox is checked — the till's own button is the one that rings up. */}
            <TextInput testID="amount-input" style={S.amountInput} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder={M.receive.amountPlaceholder} placeholderTextColor={C.sub} accessibilityLabel={M.receive.amountToReceive} onSubmitEditing={(tillAvailable || tillHeld) && codeForm === 'till' ? undefined : makeRequest} returnKeyType="done" />
          </View>
          {/* The ONE message box — mounted in BOTH code forms (founder 2026-09-14): same component,
              same place under the shared amount row, same text across the till-checkbox toggle. In
              the dpay form its text rides the payment link as the memo; in the till form it is the
              charge's signed note (passed to TillCharge below). Submit-on-Enter is the DPAY form's
              only — the shared amount row above says why (a ring-up is signed; the till's own
              button is the one that rings up). */}
          <TextInput
            testID="memo-input"
            style={memoInputStyle()}
            value={memo}
            onChangeText={setMemo}
            placeholder={M.receive.memoPlaceholder}
            placeholderTextColor={C.sub}
            accessibilityLabel={M.receive.memo}
            maxLength={32}
            onSubmitEditing={((tillAvailable || tillHeld) && codeForm === 'till') ? undefined : makeRequest}
            returnKeyType="done"
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
        </>
      ) : null}
      {((tillAvailable || tillHeld) && codeForm === 'till') ? (
        <TillCharge
          identity={identity}
          relayUrl={relayUrl}
          asset={activeAsset}
          assets={assets}
          catalog={catalog}
          nfcStatus={nfcStatus}
          onRepickAsset={onSelectAssetProgrammatic}
          amount={amount}
          note={memo}
          onHoldsForm={setTillHeld}
        />
      ) : (
        <>
          <Pressable testID="btn-request" style={S.primaryWide} onPress={makeRequest} accessibilityRole="button" accessibilityLabel={M.receive.request} accessibilityState={{disabled: false}}><Text style={S.primaryText}>{M.receive.request}</Text></Pressable>
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
