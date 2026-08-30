import {useEffect, useRef, useState} from 'react';
import {View, Text, Pressable} from 'react-native';
import {QrCode} from './QrCode';
import {S} from '../styles';
import {C} from '../config/palette';
import {POLL, QR_SIZE} from '../config/constants';
import {parseRequestQR} from '../lib/format';
import {classifyScan} from '../lib/scan';
import {cmpRaw} from '../lib/amount';
import {type CurrencyDescriptor, type FamilyDisplay, type MinterFamily, fmtCurrencyAmount, isPayableAsset, isDirectIcrcAsset, displayName, isTestnetCurrency, testnetDisplayName} from '../config/catalog';
import type {Identity, PayIntent, NfcStatus} from '../lib/types';
import {prepareTransfer, submitTransfer, pollTransfer, wireRequestToIntent, envelopeToQrPayload, type RailPrepared} from '../services/rail';
import {shareReceipt} from '../lib/deepLink';
import {DpayCore, DpayNfc} from '../services/native';
import {NfcTap} from './NfcTap';
import {NfcStatusRow} from './NfcStatusRow';
import {QrScanner} from './QrScanner';
import {InstructionPanel} from './InstructionPanel';
import {ModeToggle} from './ModeToggle';
import {SendSheet} from './SendSheet';
import {useReportLock} from '../hooks/useReportLock';
import {useShareFeedback, shareConfirmLabel} from '../hooks/useShareFeedback';
import {useJourney, JOURNEY_STAMPS} from '../lib/journey';
import {awardPaymentTested} from '../lib/readiness';
import {shouldShowOfflinePeak} from '../lib/peak';
import {CoachTip} from './CoachTip';
import {OfflinePeak} from './OfflinePeak';
import {PaidStamp} from './tapMotion';
import {IconCheck, IconClock, IconShare} from './icons';
import {M} from '../i18n';

export function PayMode({identity, online, nfcStatus, onSettled, onOfflinePaid, shownBalance, catalog, assetBalances, withdrawCurrency, withdrawDisplay, withdrawFamily, withdrawTokenContract, withdrawBalance, subMode, onSubModeChange, prefillIntent, onPrefillConsumed, onScannedLink, onShowDepositAddress, onRefreshBalances, refreshBusy = false, onLockChange}: {identity: Identity; online: boolean; nfcStatus: NfcStatus; onSettled: () => void; onOfflinePaid: (amount: string, currency: number) => void; shownBalance: string | null; catalog: CurrencyDescriptor[]; assetBalances: Record<number, string>; withdrawCurrency: number; withdrawDisplay: FamilyDisplay | null; withdrawFamily: MinterFamily | null; withdrawTokenContract: string | null; withdrawBalance: string; subMode: 'scan' | 'send'; onSubModeChange: (m: 'scan' | 'send') => void; prefillIntent?: PayIntent | null; onPrefillConsumed?: () => void; onScannedLink: (url: string) => void; onShowDepositAddress: () => void; onRefreshBalances?: () => void; refreshBusy?: boolean; onLockChange?: (locked: boolean) => void}) {
  const [phase, setPhase] = useState<'scan' | 'review' | 'qr' | 'paid'>('scan');
  // The within-tab sub-mode is OWNED by Wallet. "scan" = the existing scan-to-pay flow; "send" = the
  // on-chain send-to-address flow, lifted inline. The toggle renders whenever the asset can leave
  // the wallet at all — see `sendCapable` below; DEMO alone hides it.
  // The payment under review — the ONE shape for both entries (a scanned wire request and a shared
  // payment link; see PayIntent). `source` decides whether the camera's already-given consent
  // auto-signs, and how the destination renders.
  const [intent, setIntent] = useState<PayIntent | null>(null);
  // The signed IC envelope handoff (offline QR / pending reconcile). `prepared` holds the
  // VERBATIM envelope bytes — resubmission must reuse them (identical-byte retry only;
  // re-signing = new request_id = double-pay).
  const [prepared, setPrepared] = useState<RailPrepared | null>(null);
  const [qr, setQr] = useState<{code: string; amount: string; currency: number; who: string} | null>(null);
  // Item 4 (double-pay guard): an envelope we SUBMITTED online whose outcome stayed UNKNOWN. The
  // in-flight ambiguity never resolves app-side, so a re-approve of the SAME request (match: the
  // request nonce — the reconciliation key) must re-display THAT envelope's QR — re-signing would
  // mint a fresh request_id and, if the merchant scanned the first QR, BOTH envelopes can settle.
  // Survives reset()/Cancel deliberately; replaced by the next fresh prepare, dropped with the
  // component, and cleared by a terminal rejection of that envelope.
  const [submittedEnv, setSubmittedEnv] = useState<{prepared: RailPrepared; nonce: string; who: string} | null>(null);
  // `pending` = handed to the merchant offline but NOT confirmed by the ledger (we can't claim it
  // settled). `already` = the rail reported this transfer already executed (idempotent replay).
  // `receipt` = the settlement proof captured on an ONLINE settle: block index + request id (the
  // read_state outcome — honest interim receipt per W3; W6 upgrades to BLS-verified certs).
  const [paid, setPaid] = useState<{amount: string; currency: number; who: string; already: boolean; pending?: boolean; receipt?: Record<string, unknown> | null} | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A tap arriving on the always-armed card takes over the scan screen; nfcKey re-arms after each.
  const [nfcActive, setNfcActive] = useState(false);
  const [nfcKey, setNfcKey] = useState(0);
  // Pay-intent gate (founder rule 2026-08-23): the camera and the HCE card start ONLY after the
  // payer's explicit "Pay Now" tap — nothing scans before the user asks. Disarmed by
  // reset() (a concluded attempt needs a fresh intent) and by leaving the scan sub-mode; tab
  // switches unmount this component (no disarm needed there). A payment link bypasses it —
  // a prefilled payment never needs the camera.
  const [scanArmed, setScanArmed] = useState(false);
  useEffect(() => { if (subMode !== 'scan') setScanArmed(false); }, [subMode]);
  // NFC is usable only when the adapter probe reports 'ready' (on + present). Everything else falls
  // through to the QR-only scan surface, with a per-reason explanation in the info popup below.
  const nfcReady = nfcStatus === 'ready';

  // The SELECTED asset's facts, derived once: both the scan handler (which must know whether a
  // scanned address has anywhere to go) and the send/fund surfaces below read them.
  const gateDesc = catalog.find(c => c.currency === withdrawCurrency) ?? null;
  // Can this asset leave the wallet to an external address at all? Either it has a chain-key minter
  // family (burn → native chain) or it is a complete no-minter direct-ICRC row (a plain
  // icrc1_transfer to any account). This is the SEND capability, deliberately distinct from
  // `withdrawFamily` alone — gating on the family excluded VCHF/ICP entirely, which is exactly the
  // asymmetry the Receive tab already fixed with `depositFamily || directIcrc`
  // (ReceiveMode.tsx), and which CLAUDE.md's same-surfaces rule calls a bug rather than an
  // exception. Ramp capability is NOT consulted: onramp/offramp describe FIAT ramps, and VCHF/ICP
  // are `Unavailable` on both while being perfectly sendable on-chain.
  const sendCapable = withdrawFamily != null || isDirectIcrcAsset(gateDesc);
  const gateSymbol = gateDesc ? (isTestnetCurrency(gateDesc) ? testnetDisplayName(gateDesc) : displayName(gateDesc)) : M.pay.fundsSymbol;

  // A wallet address the camera read instead of a payment code. Handed to the send form as a
  // prefill (mirrors the SOL rail's link prefill), so the ONE place that knows whether an address
  // is usable for this asset — and what it is when it is not — is the place that says so.
  const [scannedAddress, setScannedAddress] = useState<string | null>(null);

  // U-F1 — visible confirmation after a share resolves, for this component's two Share affordances
  // (the paid-screen receipt link + the offline-QR auth code — mutually exclusive phases, so one
  // state serves both). Mirrors the DepositSheet copy pattern.
  const {shared, share} = useShareFeedback();

  // Trip Ready J5 — the one-shot offline peak. `peakShown` latches for THIS mount so the
  // OfflinePeak moment renders once and its settled remnant survives every later re-render of
  // the paid card (balance polls re-render; the remnant must persist). The journey stamp is
  // the cross-mount one-shot; award happens at the CONFIRMED moment only (never at handoff).
  // `handedOffline` captures at handoff time whether the gateway was truly unreachable (an
  // online submit with unknown outcome falls to the same QR screen but is NOT the offline
  // story); journeyRef lets the settle path read the FRESH journey without re-arming the poll.
  const {award, journey} = useJourney();
  const [peakShown, setPeakShown] = useState(false);
  const [handedOffline, setHandedOffline] = useState(false);
  const journeyRef = useRef(journey);
  journeyRef.current = journey;

  // Phase 5 — lock the idle asset selection while a payment is in flight. review/qr/paid each hold a
  // captured, immutable request snapshot the user must not lose to an asset switch (which would
  // unmount this component). 'scan' (incl. the 'send' sub-mode) leaves the selection free.
  const locked = phase !== 'scan';
  useReportLock(onLockChange, locked);

  // The CAMERA entry: decode the scanned 132-byte request into the shared payment intent.
  async function onRequestString(raw: string) {
    try {
      // The request QR is plain base64url now (the payee's `to_name` + `memo` live inside the 132-byte
      // request — wire-format v2; the `|name` suffix is gone). parseRequestQR trims + strips a stray
      // suffix defensively; decodeRequest extracts to_name + memo from the bytes.
      const reqB64 = parseRequestQR(raw);
      const r = await DpayCore.decodeRequest(reqB64);
      const i = await wireRequestToIntent(r);
      setIntent(i); setErr(null); setPhase('review');
      // One-press rule (founder directive 2026-08-24): on the CAMERA path the "Pay Now" gate was
      // the single deliberate press — a decoded, payable request signs immediately, no confirm
      // screen. Blocked legs (unsupported asset / online+insufficient) never sign: they render
      // their honest screens below. A payment LINK never auto-signs (see the prefill effect).
      const payable = isPayableAsset(catalog, i.currency);
      const reqBalance = i.currency === 0 ? shownBalance : (assetBalances[i.currency] ?? null);
      const insufficient = reqBalance != null && cmpRaw(i.amount, reqBalance) > 0;
      if (payable && !(online && insufficient)) void approve(i);
    } catch (e: unknown) {
      console.warn('decode request QR failed:', e instanceof Error ? e.message : String(e));
      onNotARequest(raw);
    }
  }

  // The wire codec refused the scan — but "not a 132-byte request" is not the same as "meaningless",
  // and answering every refusal with one message made two legitimate codes dead ends (founder rule
  // 2026-08-29: every step, especially the error path, gives the user something to do):
  //   • a payment LINK — the shareable format built to be printed as a QR, which until now only
  //     worked when the OS handed it over as an App Link. Routed to the Wallet's existing link
  //     pipeline, so a scanned link and a tapped link land on the identical review.
  //   • a wallet ADDRESS — including the principal dpay's own "My address" screen renders. Routed
  //     to the send form with the address prefilled: its status line then names the route and its
  //     fee, or names what the address IS when it cannot be used for this asset.
  // Anything else keeps the honest "not a payment code" refusal.
  function onNotARequest(raw: string) {
    const what = classifyScan(raw);
    if (what.kind === 'link') { setErr(null); onScannedLink(raw.trim()); return; }
    if (what.kind === 'address') {
      // An asset with no route off the wallet (DEMO) has nothing to prefill, so say that instead of
      // opening a form that could only refuse.
      if (!sendCapable) { setErr(M.pay.scannedAddressNotSendable(gateSymbol)); return; }
      setErr(null);
      setScannedAddress(raw.trim());
      onSubModeChange('send');
      return;
    }
    setErr(M.pay.notAPaymentCode);
  }

  // The LINK entry: a shared `…/wallet/pay/<recipient>?asset=…` URL, already parsed + resolved
  // against the catalog by the Wallet (which owns the asset routing), arrives here as a ready
  // PayIntent. SECURITY INVARIANT: a link is a ZERO-PRESS entry (no Pay Now gate was ever passed on
  // this device), so it NEVER auto-signs — the payer taps Approve on the review screen, having seen
  // the full destination account. Guarded on phase==='scan' so it can't clobber an in-flight
  // review/qr/paid; cleared (onPrefillConsumed) as it is taken so the effect can't re-fire.
  useEffect(() => {
    if (prefillIntent == null) return;
    if (phase !== 'scan') return;
    onPrefillConsumed?.();
    setIntent(prefillIntent);
    setErr(null);
    setPhase('review');
    // onPrefillConsumed is an inline closure; the [prefillIntent, phase] guard + immediate clear
    // make its identity irrelevant (exhaustive-deps would force a re-run on every render's new
    // closure for no behavioral change).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillIntent, phase]);

  // Reconcile an offline (QR-dance) settlement via the IC rail: poll read_state for the prepared
  // envelope's request_id. Terminal replied → Paid (decoded TransferResult); rejected → surfaced
  // honestly and the poll STOPS (a ledger rejection is terminal — the same request_id can never
  // settle later; mirrors the ReceiveMode settlement-poll behavior); still-pending → keep polling
  // (the ~5.5-min ingress window is the deadline, and "not submitted in time" stays honest-pending,
  // never a fake Paid).
  useEffect(() => {
    if (phase !== 'qr' || !prepared || !qr || err) return;
     let alive = true;
     const check = async () => {
       try {
          const out = await pollTransfer(prepared, identity.secretHex, {attempts: 1, intervalMs: 0});
          if (!alive) return;
          if (out.kind === 'settled') {
            onSettled(); setPaid({amount: qr.amount, currency: qr.currency, who: qr.who, already: false}); setPhase('paid');
            awardPaymentTested(journeyRef.current);
            // Trip Ready J5 — CONFIRMED via reconcile after a TRULY offline handoff (the payer
            // approved with no reachable gateway; the merchant's connection settled it): the
            // truthful offlineQr peak path. Award exactly once (idempotent — the stamp IS the
            // one-shot gate, read FRESH via journeyRef); never at handoff time — only at proof.
            // An online submit that fell through with unknown outcome never peaks (handedOffline
            // is false) — the honest distinction between "no signal" and "couldn't hear back".
            if (handedOffline && shouldShowOfflinePeak(journeyRef.current, 'offlineQr')) {
              setPeakShown(true);
              award(JOURNEY_STAMPS.firstOfflinePayment);
            }
          }
         if (out.kind === 'rejected') {
           // Terminal refusal (e.g. the ledger rejected the merchant's submission): surface the
           // reason on the QR screen and stop polling — spinning silently would leave the payer
           // showing a dead QR forever. A rejected envelope can never settle, so its retained
           // submitted-env copy is dead too — drop it (a re-approve may safely prepare fresh).
           setErr(out.reason);
           setSubmittedEnv(s => (s && s.prepared.requestIdHex === prepared.requestIdHex ? null : s));
         }
       } catch (e) { console.warn('rail reconcile poll failed:', e instanceof Error ? e.message : String(e)); /* best-effort: keep polling */ }
     };
     check(); const id = setInterval(check, POLL.receiptPay);
     return () => { alive = false; clearInterval(id); };
  }, [phase, prepared, qr, err, onSettled, identity]);

  // The sign path (parameterized: the camera path auto-signs the FRESHLY decoded intent before the
  // `intent` state has flushed; the link review's Approve passes the parked intent).
  async function approve(r: PayIntent) {
    // The IC rail has no server-side dpay-request expiry — the payer's app IS the gate. A stale
    // request QR must die here, before any envelope is built (memo/nonce reconciliation only ever
    // sees fresh transfers), with copy that explains the expiry (C1). A payment LINK carries no
    // request expiry (`expiry === null`): it is meant to survive a chat thread, and the signed
    // envelope's own IC ingress expiry still bounds the signature.
    if (r.expiry != null && r.expiry * 1000 <= Date.now()) {
      setErr(M.pay.requestExpired);
      return;
    }
    // Item 4: this request's envelope was already submitted and its outcome stayed unknown —
    // re-display THAT QR (the r.expiry gate above already ran, so it's unexpired). NEVER
    // re-sign a submitted envelope: a fresh signature = fresh request_id = a second payment.
    if (submittedEnv && submittedEnv.nonce === r.nonceHex) {
      setPrepared(submittedEnv.prepared);
      setQr({code: envelopeToQrPayload(submittedEnv.prepared.envelopeHex), amount: r.amount, currency: r.currency, who: submittedEnv.who});
      setHandedOffline(online === false);
      setPhase('qr');
      return;
    }
    setBusy(true);
    try {
      // IC user-principal rail: build + sign the icrc1_transfer envelope LOCALLY (the intent
      // already carries the payee's ICRC-1 principal — derived from the request pubkey, or taken
      // verbatim from a payment link; memo = the nonce = reconciliation key). prepareTransfer
      // refuses to sign on unreachable/skewed IC clock — surfaced as the error.
      const p = await prepareTransfer(identity.secretHex, {currencies: catalog}, r);
      const who = r.toName || r.toAccountText;
      setPrepared(p);
      if (online) {
        const out = await submitTransfer(p, identity.secretHex, {attempts: 12, intervalMs: 500});
        if (out.kind === 'settled') {
          onSettled();
          // Interim settlement proof (honest W3 receipt): ledger + block index + request id —
          // certified read_state, not BLS-verified on-device (W6 upgrades).
          setPaid({amount: r.amount, currency: r.currency, who, already: false, receipt: {ledger: p.ledger, block_index: out.blockIndex, request_id: p.requestIdHex}}); setPhase('paid');
          awardPaymentTested(journeyRef.current); return;
        }
        if (out.kind === 'rejected') {
          // Structured-tag branch (not human-message matching): Duplicate = this payee already
          // landed this exact memo'd transfer — the request is PAID, show the already-paid state.
          if (out.variant === 'Duplicate') { setPaid({amount: r.amount, currency: r.currency, who, already: true}); setPhase('paid'); awardPaymentTested(journeyRef.current); return; }
          setErr(out.reason); return;
        }
        // unknown: not terminal within budget — fall through to the offline QR hand-off. The
        // merchant can submit the SAME envelope within the ingress window; the reconcile poll
        // (above) turns it into Paid when the rail reports it executed.
      }
      // Item 4: this envelope is now SUBMITTED-or-handed-off (online unknown, or the offline QR
      // the merchant may settle themselves). RETAIN it: a later re-approve of this request must
      // re-display these exact bytes — a fresh signature = fresh request_id = a second payment.
      setSubmittedEnv({prepared: p, nonce: r.nonceHex, who});
      setQr({code: envelopeToQrPayload(p.envelopeHex), amount: r.amount, currency: r.currency, who});
      setHandedOffline(online === false);
      setPhase('qr');
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  function reset() { setIntent(null); setPrepared(null); setQr(null); setPaid(null); setErr(null); setPeakShown(false); setHandedOffline(false); setScanArmed(false); setPhase('scan'); }

  if (phase === 'paid' && paid) {
    const warn = paid.already || paid.pending;
    // P3 — the outcome mark is an SVG icon inside the S.check circle (was a text glyph): a fresh
    // settle + an idempotent replay both show the checkmark; the honest pending hand-off shows a
    // clock (awaiting the merchant's confirmation). Headline/sub labels are unchanged text.
    const mark = paid.pending ? <IconClock size={44} color={C.brandInk}/> : <IconCheck size={44} color={C.brandInk}/>;
    const amt = fmtCurrencyAmount(catalog, paid.currency, paid.amount);
    const headline = paid.pending ? M.pay.sent(amt) : paid.already ? M.pay.alreadyPaid : M.nfc.paidAmount(amt);
    const sub = paid.pending ? M.pay.toWhoAwaiting(paid.who)
      : paid.already ? M.pay.alreadyNotCharged(amt, paid.who)
      : M.pay.toWho(paid.who);
    return (
      <View style={S.center}>
        {/* Trip Ready J5 — the one-shot offline peak (first OFFLINE confirmed payment only).
            Above the paid card; auto-settles into the quiet remnant; never blocks Done. The
            one-shot gate is the journey stamp (shouldShowOfflinePeak), latched per-mount by
            peakShown so the remnant survives balance-poll re-renders. */}
        {peakShown && !warn ? <OfflinePeak /> : null}
        <View style={[S.check, warn && S.checkAlready]}>{mark}</View>
        <Text style={[S.paidText, warn && S.alreadyText]}>{headline}</Text>
        <Text style={S.paidSub}>{sub}</Text>
        {/* Trip Ready J5 — the compact calm stamp: ONLY on the CONFIRMED fresh settle (never on
            pending/already — the honest-money rule keeps the stamp mark off unresolved states).
            One quiet fade-in, consistent with the tap success stamp; additive to the check. */}
        {!warn ? <PaidStamp /> : null}
        {/* Trip Ready J4 — the honest-pending first-use tip: ONLY on the unresolved outcome view
            (paid.pending — the offline hand-off state), never on a confirmed settle. Mounted in
            the reading zone (right under the headline it explains); pending is quiet and
            unresolved; this teaches exactly that, once. */}
        {paid.pending ? <CoachTip tipKey="pendingOutcome" /> : null}
        {/* NFC-less receipt hand-back: when the payer settled ONLINE (NFC unavailable) they hold the
            rail proof {ledger, block_index, request_id}. Offer to share it back as a dpay:pay/ link
            so the merchant can open it — format-check it against their open request and confirm
            settlement on-chain — without waiting for the request poll (or for the async case where
            the proof travels over a messaging app). Only shown when a fresh proof was captured (a
            fresh online settle) — not on the offline hand-off (the merchant settles that
            themselves) nor on a replay (no fresh proof). Mirrors btn-share-request. */}
        {paid.receipt ? (
          <Pressable
            testID="btn-share-receipt"
            style={S.ghostBtn}
            onPress={() => {
              share(shareReceipt(paid.receipt!));
            }}
            accessibilityRole="button"
            accessibilityLabel={M.pay.shareReceipt}
            accessibilityHint={M.pay.shareReceiptHint}
            accessibilityState={{disabled: false}}>
            <IconShare size={16} color={C.sub}/>
            <Text style={S.ghostBtnText}>{shared ? shareConfirmLabel(M.pay.linkCopied) : M.pay.shareReceipt}</Text>
          </Pressable>
        ) : null}
        <Pressable testID="btn-new" style={[S.ghostBtn, S.ghostBtnMuted]} onPress={reset} accessibilityRole="button" accessibilityLabel={M.pay.newPayment} accessibilityState={{disabled: false}}><Text style={S.ghostBtnText}>{M.pay.newPayment}</Text></Pressable>
      </View>
    );
  }

  if (phase === 'qr' && qr) {
    return (
      <View style={S.center}>
        <Text style={S.label}>{M.pay.showThisTo(qr.who)}</Text>
        <View style={S.qrCard}><QrCode value={qr.code} size={QR_SIZE} ecl="L" /></View>
        <Text style={S.amountBig}>{M.pay.amountToWho(fmtCurrencyAmount(catalog, qr.currency, qr.amount), qr.who)}</Text>
        <Text style={S.badgeOk}>{M.pay.signedOnThisDevice}</Text>
        {/* The reconcile poll surfaced a TERMINAL ledger rejection of this envelope (item 3): the
            QR is dead — the merchant's submission was refused. Show why + stop polling; the payer
            can Cancel and start over. Not shown for still-pending (unknown) — that stays honest. */}
        {err ? <Text testID="qr-err" style={S.err}>{err}</Text> : null}
        {online ? <Text style={S.qrHint}>{M.pay.waitingToScan(qr.who)}</Text> : (
          <>
            <Text style={S.qrHint}>{M.pay.offlineSettles(qr.who)}</Text>
            {/* Trip Ready J4 — the offline hand-off first-use tip (offline branch only: the online
                branch's QR is scanned within seconds, nothing to teach). Mounted right under the
                status line it explains, above the confirm row; inline, never blocks. */}
            <CoachTip tipKey="offlineQr" />
            <View style={S.confirmRow}>
              {/* Offline we CANNOT know the ledger settled it, so this is an honest "handed off",
                  not "Paid ✓". It optimistically reduces the local balance; the real balance
                  reconciles on the next online poll. It does NOT fabricate a settled history entry.
                  MC5: pass the request's currency so the deduction lands on THIS asset's entry, not
                  the DEMO counter (currency-keyed offline deduction). */}
              <Pressable testID="btn-paid" style={S.paidBtn} onPress={() => { onOfflinePaid(qr.amount, qr.currency); setPaid({amount: qr.amount, currency: qr.currency, who: qr.who, already: false, pending: true}); setPhase('paid'); }} accessibilityRole="button" accessibilityLabel={M.pay.handedTo(qr.who)} accessibilityHint={M.pay.handedOffHint} accessibilityState={{disabled: false}}><Text style={S.paidBtnText}>{M.pay.handedTo(qr.who)}</Text></Pressable>
              <Pressable testID="btn-notpaid" style={S.notPaidBtn} onPress={reset} accessibilityRole="button" accessibilityLabel={M.common.cancel} accessibilityState={{disabled: false}}><Text style={S.notPaidText}>{M.common.cancel}</Text></Pressable>
            </View>
          </>
        )}
        <Pressable style={S.ghostBtn} onPress={() => share(qr.code)} accessibilityRole="button" accessibilityLabel={M.pay.shareAuthCode} accessibilityState={{disabled: false}}><IconShare size={16} color={C.sub}/><Text style={S.ghostBtnText}>{shared ? shareConfirmLabel(M.pay.copied) : M.pay.shareAuthCode}</Text></Pressable>
      </View>
    );
  }

  if (phase === 'review' && intent) {
    // MC5 — fail closed BEFORE signing: a payment carrying an unknown/unsupported currency (a
    // garbage/retired id, or a CkSol-family currency with no ramp config) must NEVER reach the
    // envelope signer (prepareTransfer). The ledger also rejects these, but the app should never
    // let the user Approve a sign for an unsupported asset. Mirror the BalancesSheet "Unsupported asset" pattern:
    // honest copy + NO sign button + a back-to-scan affordance. dpay never swaps, so we do NOT
    // offer to substitute another asset — the request is for this asset or none.
    if (!isPayableAsset(catalog, intent.currency)) {
      return (
        <View style={S.center}>
          <Text style={S.label}>{M.pay.unsupportedAsset}</Text>
          <Text testID="review-unsupported" style={S.warnNote}>{M.pay.unsupportedAssetBody(intent.currency)}</Text>
          <Pressable style={[S.ghostBtn, S.ghostBtnMuted]} onPress={reset} accessibilityRole="button" accessibilityLabel={M.common.cancel} accessibilityState={{disabled: false}}><Text style={S.ghostBtnText}>{M.common.cancel}</Text></Pressable>
        </View>
      );
    }
    // MC5: locked-asset review — the payer sees + pays the EXACT asset that was requested (dpay
    // never swaps). The balance check uses ONLY that asset's balance: currency 0 → shownBalance
    // (DEMO_USD, tracked in the header), else assetBalances[currency] (the polled per-asset
    // balance). An unknown balance (null) is treated as "don't block" (same as the old DEMO path).
    const reqBalance = intent.currency === 0 ? shownBalance : (assetBalances[intent.currency] ?? null);
    // C2: when ONLINE and the known balance can't cover the amount, gate PRE-SUBMIT (no doomed
    // submit). Offline we can't be sure (the local balance may be stale), so we only WARN there and
    // let the merchant's online verify be the real gate. MC1 units 2-4: `cmpRaw` (BigInt) — never a
    // lexicographic string compare (which would wrongly rank "9" > "10").
    const insufficient = reqBalance != null && cmpRaw(intent.amount, reqBalance) > 0;
    const blockApprove = online && insufficient;
    // The destination, always rendered: the short pubkey of a scanned request, the FULL ICRC-1
    // principal of a payment link. A link can name any account on the ledger, and the account IS
    // the identity — the label beside it is only what the sender claims to be called.
    const payeeLine = (
      <>
        <Text style={S.reviewTo}>{M.pay.toWho(intent.toName || intent.toAccountText)}</Text>
        {/* U-F5 — the destination account as a subdued second line when a display name is shown,
            so the payer can verify where the money goes beyond a claimed name (phishing surface).
            The no-name fallback already renders the account as the primary "to" line. */}
        {intent.toName ? <Text testID="review-payee" style={S.dim2}>{intent.toAccountText}</Text> : null}
      </>
    );
    if (intent.source === 'link') {
      // Link entry (zero-press): the full review card — the single Approve press IS the consent.
      // C1: any shown error (insufficient / verify-fail) disables the button so a doomed payment
      // can't be re-tapped.
      const approveDisabled = busy || !!err || blockApprove;
      return (
        <View style={S.center}>
          <Text style={S.label}>{M.pay.reviewPayment}</Text>
          <Text testID="pay-amount" style={S.reviewAmount}>{M.pay.payAmount(fmtCurrencyAmount(catalog, intent.currency, intent.amount))}</Text>
          {payeeLine}
          {/* A link's payee name is UNVERIFIED — anyone can write any name into a URL. Say so, once,
              right where the name is read: the account above it is the part that is checkable. */}
          {intent.toName ? <Text testID="review-claimed" style={S.dim2}>{M.pay.linkNameClaimed}</Text> : null}
          {/* The sender-set memo (if any) — shown as a small subtitle so the payer sees the note
              attached to this payment before approving. Empty memo renders nothing. */}
          {intent.memo ? <Text testID="review-memo" style={S.dim2}>{intent.memo}</Text> : null}
          {/* Trip Ready J4 — one-time first-use coaching, mounted in the reading zone (right under
              the amount/payee block it explains) so it is seen without scrolling; inline, never
              covers the buttons. Shows until dismissed; dismissal persists via journey seen-markers. */}
          <CoachTip tipKey="payReview" />
          {/* C1/C2 + L5: the warning + any error render ABOVE the button (not below) so they're seen
              first; the raw request nonce is no longer surfaced (internal protocol data). */}
          {insufficient ? (
            <Text testID="review-lowbal" style={S.warnNote}>{blockApprove
              ? M.pay.notEnoughBalance
              : M.pay.localBalanceMayNotCover}</Text>
          ) : null}
          {err ? <Text testID="review-err" style={S.err}>{err}</Text> : null}
          <Pressable
            testID="btn-approve"
            style={[S.primary, approveDisabled && S.disabledFlat]}
            disabled={approveDisabled}
            accessibilityRole="button"
            accessibilityLabel={M.pay.approveA11y}
            accessibilityHint={M.pay.approveHint}
            accessibilityState={{disabled: approveDisabled}}
            onPress={() => void approve(intent)}>
            <Text style={S.primaryText}>{busy ? M.pay.signing : M.pay.approve}</Text>
          </Pressable>
          {/* Audit P2: Cancel-as-secondary-button parity — a bordered secondary button of the same
              width as Approve so the tap targets are equivalent and the user makes a deliberate choice
              (a reflex Approve tap was the asymmetry risk). Matches the Cancel style used by the
              offline confirm row + the unsupported-asset cancel below. */}
          <Pressable
            testID="btn-review-cancel"
            style={S.secondaryBtn}
            onPress={reset}
            accessibilityRole="button"
            accessibilityLabel={M.common.cancel}
            accessibilityState={{disabled: false}}>
            <Text style={S.secondaryBtnText}>{M.common.cancel}</Text>
          </Pressable>
        </View>
      );
    }
    // Camera entry: the "Pay Now" gate was the one deliberate press, so the payable sign already
    // fired (onRequestString). This surface is read-only while it runs — amount + payee +
    // "Signing…", NO buttons — and the honest terminal for every refused leg: blocked (online +
    // insufficient: no sign action exists at all) and sign-time errors (expired / relay reject)
    // each show their reason + Cancel back to the gated scan state.
    return (
      <View style={S.center}>
        <Text style={S.label}>{M.pay.paying}</Text>
        <Text testID="pay-amount" style={S.reviewAmount}>{M.pay.payAmount(fmtCurrencyAmount(catalog, intent.currency, intent.amount))}</Text>
        {payeeLine}
        {insufficient ? (
          <Text testID="review-lowbal" style={S.warnNote}>{blockApprove
            ? M.pay.notEnoughBalance
            : M.pay.localBalanceMayNotCover}</Text>
        ) : null}
        {err ? <Text testID="review-err" style={S.err}>{err}</Text> : null}
        {busy ? (
          <Text style={S.dim2}>{M.pay.signing}</Text>
        ) : (
          <Pressable
            testID="btn-review-cancel"
            style={S.secondaryBtn}
            onPress={reset}
            accessibilityRole="button"
            accessibilityLabel={M.common.cancel}
            accessibilityState={{disabled: false}}>
            <Text style={S.secondaryBtnText}>{M.common.cancel}</Text>
          </Pressable>
        )}
      </View>
    );
  }

  // IC fund-first gate (2026-08-16 zero-funds UX — same surface as the SOL rail, per the
  // same-surfaces hard rule). Computed BEFORE both the send + scan branches so the WHOLE Pay tab
  // gates uniformly. Balance is keyed to the SELECTED asset: currency 0 (DEMO) reads the primary
  // poll; every other asset reads its own assetBalances entry (a missing entry → null → fail
  // open). DEMO itself never gates (mintable — the faucet tops it up).
  //   - ONLINE + KNOWN zero (non-DEMO) → the fund-first panel replaces the scanner + send form.
  //   - Offline / loading / null FAIL OPEN to the live surfaces (offline-first rule — the
  //     review-level lowbal backstop still catches a doomed payment at Approve).
  //   - A family-depositable asset OR a complete no-minter direct-ICRC row (VCHF/ICP — receivable
  //     by a plain ICRC-1 transfer to the user's own principal) shows the REAL top-up instruction
  //     + the "Show my … address" primary (founder hard rule 2026-08-29: useful practical
  //     instructions on every step — a "check back soon" dead end is a bug). Only a genuinely
  //     undepositable malformed row keeps the honest no-primary copy.
  const gateDepositable = !!gateDesc && !gateDesc.mintable && gateDesc.onramp !== 'Unavailable' && gateDesc.minter != null;
  const gateCanFund = gateDepositable || isDirectIcrcAsset(gateDesc);
  const gateBalance = withdrawCurrency === 0 ? shownBalance : (assetBalances[withdrawCurrency] ?? null);
  const fundGate = online && gateBalance != null && cmpRaw(gateBalance, '0') === 0 && gateDesc != null && !gateDesc.mintable;
  const fundPanel = fundGate ? (
    <InstructionPanel
      testID="pay-fund"
      title={M.pay.fundTitle(gateSymbol, subMode === 'send' ? 'send' : 'pay')}
      body={gateCanFund
        ? M.pay.fundBody(gateSymbol, subMode === 'send' ? 'send' : 'pay')
        : M.pay.fundBodyNoDeposits(gateSymbol)}
      primaryLabel={gateCanFund ? M.pay.showMyAddress(gateSymbol) : undefined}
      onPrimary={gateCanFund ? onShowDepositAddress : undefined}
      onRecheck={onRefreshBalances}
        recheckBusy={refreshBusy}
    />
  ) : null;

  // Offline gate for the send surface. The Pay tab's two halves have OPPOSITE connectivity truths
  // and only one of them was ever stated: scan-to-pay is the offline rail — the payer signs in
  // airplane mode and the merchant's phone submits — while an address send has no counterparty, so
  // the payer's own phone must reach the ledger. Offline it used to render the full form, disable
  // Max with no reason (the fee query silently failed), and fail at Confirm with a raw error. Now
  // it says so up front and points at the rail that does work offline (founder rule 2026-08-29).
  // Ordered BEFORE the fund gate: a zero balance read while offline is stale, so connectivity is
  // the honest thing to report first.
  const offlinePanel = !online ? (
    <InstructionPanel
      testID="pay-send-offline"
      title={M.pay.offlineSendTitle}
      body={M.pay.offlineSendBody(gateSymbol)}
      primaryLabel={M.pay.scanToPay}
      onPrimary={() => onSubModeChange('scan')}
      onRecheck={onRefreshBalances}
      recheckBusy={refreshBusy}
    />
  ) : null;

  // "Send to address" sub-mode, rendered INLINE (the tab body provides the surface — no overlay
  // chrome). The toggle above flips back to "Scan to pay".
  //
  // ONE entry point for every send-capable asset: `SendSheet` owns the destination field and picks
  // the rail from the ADDRESS, delegating a native-chain destination to the chain-key offramp. So
  // ckBTC reaches both a Bitcoin address and an Internet Computer account from the same field,
  // and VCHF/ICP — which have no minter at all — are no longer excluded from the surface.
  // DEMO shows no toggle: it has no on-chain identity, matching the Receive tab, where the "My
  // address" toggle is likewise `depositFamily || directIcrc`.
  if (subMode === 'send' && sendCapable && gateDesc) {
    return (
      <View style={S.center}>
        <ModeToggle
          testID="pay-mode-toggle"
          value={subMode}
          onChange={(v) => onSubModeChange(v as 'scan' | 'send')}
          left={{label: M.pay.scanToPay, value: 'scan', testID: 'btn-pay-scan'}}
          right={{label: M.pay.sendToAddress, value: 'send', testID: 'btn-pay-send'}}
        />
        {offlinePanel ?? fundPanel ?? (
          <SendSheet
            identity={identity}
            catalog={catalog}
            desc={gateDesc}
            balance={withdrawBalance}
            family={withdrawFamily}
            display={withdrawDisplay}
            tokenContract={withdrawTokenContract}
            prefillAddress={scannedAddress}
            onPrefillConsumed={() => setScannedAddress(null)}
            onSent={onSettled}
            onClose={() => onSubModeChange('scan')}
          />
        )}
      </View>
    );
  }

  // Scan screen. IDLE (scanArmed false): the NFC status row stays (it explains what's available)
  // and a single primary CTA arms BOTH rails — until that tap, no camera stream and no HCE card.
  // ARMED: the card arms in the background (if NFC is ready) AND the QR scanner goes live at the
  // same time — the payer taps the merchant's phone OR scans its QR, exactly as before the gate.
  return (
    <View style={S.center}>
      {sendCapable ? (
        <ModeToggle
          testID="pay-mode-toggle"
          value={subMode}
          onChange={(v) => onSubModeChange(v as 'scan' | 'send')}
          left={{label: M.pay.scanToPay, value: 'scan', testID: 'btn-pay-scan'}}
          right={{label: M.pay.sendToAddress, value: 'send', testID: 'btn-pay-send'}}
        />
      ) : null}
      {fundPanel ?? (
        <>
      {scanArmed && nfcReady && DpayNfc ? (
        <NfcTap
          key={nfcKey} role="card" identity={identity}
          catalog={catalog}
          onSettled={onSettled} onOfflinePaid={onOfflinePaid}
          onActive={() => setNfcActive(true)}
          onClose={() => { setNfcActive(false); setNfcKey(k => k + 1); }}
          offlinePeak={!online && shouldShowOfflinePeak(journey, 'nfcMerchantSettled')}
          onConfirmed={() => { if (!online) award(JOURNEY_STAMPS.firstOfflinePayment); }}
        />
      ) : null}
      {!nfcActive ? (
        <>
          <NfcStatusRow nfcStatus={nfcStatus} testID="pay-scan" />
          {scanArmed ? (
            <QrScanner onScan={raw => onRequestString(raw)} />
          ) : (
            <>
              <Pressable
                style={S.primary}
                onPress={() => setScanArmed(true)}
                accessibilityRole="button"
                accessibilityLabel={M.pay.payNowA11y}
                accessibilityHint={M.pay.payNowHint}
                testID="btn-start-scan"
              >
                <Text style={S.primaryText}>{M.pay.payNow}</Text>
              </Pressable>
            </>
          )}
          {err ? <Text style={S.err}>{err}</Text> : null}
        </>
      ) : null}
        </>
      )}
    </View>
  );
}
