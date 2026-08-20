import {useEffect, useState} from 'react';
import {View, Text, Pressable, Modal, Platform} from 'react-native';
import {QrCode} from './QrCode';
import {S} from '../styles';
import {C} from '../config/palette';
import {POLL, QR_SIZE} from '../config/constants';
import {short, parseRequestQR} from '../lib/format';
import {cmpRaw} from '../lib/amount';
import {type CurrencyDescriptor, type FamilyDisplay, type MinterFamily, fmtCurrencyAmount, isPayableAsset, displayName, isTestnetCurrency, testnetDisplayName} from '../config/catalog';
import type {Identity, Req, NfcStatus} from '../lib/types';
import {prepareTransfer, submitTransfer, pollTransfer, envelopeToQrPayload, type RailPrepared} from '../services/rail';
import {shareHandoff, receiptShareBlob} from '../lib/deepLink';
import {DpayCore, DpayNfc} from '../services/native';
import {NfcTap} from './NfcTap';
import {NfcIcon} from './NfcIcon';
import {QrScanner} from './QrScanner';
import {FundFirstPanel} from './FundFirstPanel';
import {ModeToggle} from './ModeToggle';
import {WithdrawSheet} from './WithdrawSheet';
import {useEscapeToClose} from '../hooks/useHotkeys';
import {useReportLock} from '../hooks/useReportLock';
import {useShareFeedback, shareConfirmLabel} from '../hooks/useShareFeedback';
import {IconCheck, IconClock, IconInfo, IconShare} from './icons';

// Plain-language per-reason text for the NFC-unavailable info popup. Each ends with the honest
// fallback that QR always works, so the payer is never stuck.
const NFC_REASON: Record<Exclude<NfcStatus, 'ready'>, string> = {
  off: 'NFC is turned off in your device settings. Turn NFC on to pay by tap — or scan the QR code to pay now.',
  unsupported: "This device doesn't have NFC hardware. Scan the QR code to pay.",
  unknown: "Couldn't check NFC status. Scan the QR code to pay.",
};

export function PayMode({identity, online, nfcStatus, onSettled, onOfflinePaid, shownBalance, catalog, assetBalances, withdrawCurrency, withdrawDisplay, withdrawFamily, withdrawTokenContract, withdrawBalance, subMode, onSubModeChange, prefillRequest, onPrefillConsumed, onShowDepositAddress, onRefreshBalances, refreshBusy = false, onLockChange}: {identity: Identity; online: boolean; nfcStatus: NfcStatus; onSettled: () => void; onOfflinePaid: (amount: string, currency: number) => void; shownBalance: string | null; catalog: CurrencyDescriptor[]; assetBalances: Record<number, string>; withdrawCurrency: number; withdrawDisplay: FamilyDisplay | null; withdrawFamily: MinterFamily | null; withdrawTokenContract: string | null; withdrawBalance: string; subMode: 'scan' | 'send'; onSubModeChange: (m: 'scan' | 'send') => void; prefillRequest?: string | null; onPrefillConsumed?: () => void; onShowDepositAddress: () => void; onRefreshBalances?: () => void; refreshBusy?: boolean; onLockChange?: (locked: boolean) => void}) {
  const [phase, setPhase] = useState<'scan' | 'review' | 'qr' | 'paid'>('scan');
  // The within-tab sub-mode is OWNED by Wallet. "scan" = the existing scan-to-pay flow; "send" = the
  // on-chain send-to-address flow (the WithdrawSheet body, lifted inline). The toggle renders only
  // when withdrawFamily is non-null (an on-chain offramp family); DEMO hides it.
  const [req, setReq] = useState<Req | null>(null);
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
  // NFC is usable only when the adapter probe reports 'ready' (on + present). Everything else falls
  // through to the QR-only scan surface, with a per-reason explanation in the info popup below.
  const nfcReady = nfcStatus === 'ready';
  const [nfcInfoOpen, setNfcInfoOpen] = useState(false);
  useEscapeToClose(() => setNfcInfoOpen(false));

  // U-F1 — visible confirmation after a share resolves, for this component's two Share affordances
  // (the paid-screen receipt link + the offline-QR auth code — mutually exclusive phases, so one
  // state serves both). Mirrors the DepositSheet copy pattern.
  const {shared, share} = useShareFeedback();

  // Phase 5 — lock the idle asset selection while a payment is in flight. review/qr/paid each hold a
  // captured, immutable request snapshot the user must not lose to an asset switch (which would
  // unmount this component). 'scan' (incl. the 'send' sub-mode) leaves the selection free.
  const locked = phase !== 'scan';
  useReportLock(onLockChange, locked);

  async function onRequestString(raw: string) {
    try {
      // The request QR is plain base64url now (the payee's `to_name` + `memo` live inside the 132-byte
      // request — wire-format v2; the `|name` suffix is gone). parseRequestQR trims + strips a stray
      // suffix defensively; decodeRequest extracts to_name + memo from the bytes.
      const reqB64 = parseRequestQR(raw);
      const r = await DpayCore.decodeRequest(reqB64);
      setReq(r); setErr(null); setPhase('review');
    } catch (e: unknown) { console.warn('decode request QR failed:', e instanceof Error ? e.message : String(e)); setErr('This isn\'t a dpay payment code'); }
  }

  // Deeplink prefill (item 6): a `dpay:req/<blob>` (or the web `?req=<blob>` mirror) hands the EXACT
  // base64url blob the merchant's QR carries straight to this effect, which reuses the camera-scan
  // decode path (onRequestString → parseRequestQR → decodeRequest → review). NO duplicate decode —
  // the deeplink blob goes through the same single source of truth. SECURITY INVARIANT: this ONLY
  // pre-fills the review screen; it NEVER calls approve() or signs anything — the payer taps Approve.
  // Guarded on phase==='scan' so it can't clobber an in-flight review/qr/paid. The prefill is cleared
  // (onPrefillConsumed) BEFORE the async decode resolves so the effect can't re-fire mid-flight.
  useEffect(() => {
    if (prefillRequest == null) return;
    if (phase !== 'scan') return;
    const blob = prefillRequest;
    onPrefillConsumed?.();
    onRequestString(blob);
    // onRequestString/onPrefillConsumed are inline closures; the [prefillRequest, phase] guard +
    // immediate clear make their identity irrelevant (exhaustive-deps would force a re-run on every
    // render's new closure for no behavioral change).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillRequest, phase]);

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

  async function approve() {
    if (!req) return;
    // The IC rail has no server-side dpay-request expiry — the payer's app IS the gate. A stale
    // request QR must die here, before any envelope is built (memo/nonce reconciliation only ever
    // sees fresh transfers), with copy that explains the expiry and disables Approve (C1).
    if (req.expiry * 1000 <= Date.now()) {
      setErr('This request expired — ask the merchant for a fresh QR');
      return;
    }
    // Item 4: this request's envelope was already submitted and its outcome stayed unknown —
    // re-display THAT QR (the req.expiry gate above already ran, so it's unexpired). NEVER
    // re-sign a submitted envelope: a fresh signature = fresh request_id = a second payment.
    if (submittedEnv && submittedEnv.nonce === req.nonceHex) {
      setPrepared(submittedEnv.prepared);
      setQr({code: envelopeToQrPayload(submittedEnv.prepared.envelopeHex), amount: req.amount, currency: req.currency, who: submittedEnv.who});
      setPhase('qr');
      return;
    }
    setBusy(true);
    try {
      // IC user-principal rail: build + sign the icrc1_transfer envelope LOCALLY (payee principal
      // derived from the request's `to` pubkey; memo = the request nonce = reconciliation key).
      // prepareTransfer refuses to sign on unreachable/skewed IC clock — surfaced as the error.
      const p = await prepareTransfer(identity.secretHex, {currencies: catalog}, req);
      const who = req.toName || short(req.toHex);
      setPrepared(p);
      if (online) {
        const out = await submitTransfer(p, identity.secretHex, {attempts: 12, intervalMs: 500});
        if (out.kind === 'settled') {
          onSettled();
          // Interim settlement proof (honest W3 receipt): ledger + block index + request id —
          // certified read_state, not BLS-verified on-device (W6 upgrades).
          setPaid({amount: req.amount, currency: req.currency, who, already: false, receipt: {ledger: p.ledger, block_index: out.blockIndex, request_id: p.requestIdHex}}); setPhase('paid'); return;
        }
        if (out.kind === 'rejected') {
          // Structured-tag branch (not human-message matching): Duplicate = this payee already
          // landed this exact memo'd transfer — the request is PAID, show the already-paid state.
          if (out.variant === 'Duplicate') { setPaid({amount: req.amount, currency: req.currency, who, already: true}); setPhase('paid'); return; }
          setErr(out.reason); return;
        }
        // unknown: not terminal within budget — fall through to the offline QR hand-off. The
        // merchant can submit the SAME envelope within the ingress window; the reconcile poll
        // (above) turns it into Paid when the rail reports it executed.
      }
      // Item 4: this envelope is now SUBMITTED-or-handed-off (online unknown, or the offline QR
      // the merchant may settle themselves). RETAIN it: a later re-approve of this request must
      // re-display these exact bytes — a fresh signature = fresh request_id = a second payment.
      setSubmittedEnv({prepared: p, nonce: req.nonceHex, who});
      setQr({code: envelopeToQrPayload(p.envelopeHex), amount: req.amount, currency: req.currency, who});
      setPhase('qr');
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  function reset() { setReq(null); setPrepared(null); setQr(null); setPaid(null); setErr(null); setPhase('scan'); }

  if (phase === 'paid' && paid) {
    const warn = paid.already || paid.pending;
    // P3 — the outcome mark is an SVG icon inside the S.check circle (was a text glyph): a fresh
    // settle + an idempotent replay both show the checkmark; the honest pending hand-off shows a
    // clock (awaiting the merchant's confirmation). Headline/sub labels are unchanged text.
    const mark = paid.pending ? <IconClock size={44} color={C.brandInk}/> : <IconCheck size={44} color={C.brandInk}/>;
    const amt = fmtCurrencyAmount(catalog, paid.currency, paid.amount);
    const headline = paid.pending ? `Sent ${amt}` : paid.already ? 'Already paid' : `Paid ✓ ${amt}`;
    const sub = paid.pending ? `to ${paid.who} · awaiting the merchant’s confirmation`
      : paid.already ? `${amt} to ${paid.who} · not charged again`
      : `to ${paid.who}`;
    return (
      <View style={S.center}>
        <View style={[S.check, warn && S.checkAlready]}>{mark}</View>
        <Text style={[S.paidText, warn && S.alreadyText]}>{headline}</Text>
        <Text style={S.paidSub}>{sub}</Text>
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
              share(shareHandoff('pay', receiptShareBlob(paid.receipt!)));
            }}
            accessibilityRole="button"
            accessibilityLabel="Share receipt"
            accessibilityHint="Share the payment proof as a link the merchant can open to confirm"
            accessibilityState={{disabled: false}}>
            <IconShare size={16} color={C.sub}/>
            <Text style={S.ghostBtnText}>{shared ? shareConfirmLabel('Link copied ✓') : 'Share receipt'}</Text>
          </Pressable>
        ) : null}
        <Pressable testID="btn-new" style={[S.ghostBtn, S.ghostBtnMuted]} onPress={reset} accessibilityRole="button" accessibilityLabel="New payment" accessibilityState={{disabled: false}}><Text style={S.ghostBtnText}>New payment</Text></Pressable>
      </View>
    );
  }

  if (phase === 'qr' && qr) {
    return (
      <View style={S.center}>
        <Text style={S.label}>Show this to {qr.who}</Text>
        <View style={S.qrCard}><QrCode value={qr.code} size={QR_SIZE} ecl="L" /></View>
        <Text style={S.amountBig}>{`${fmtCurrencyAmount(catalog, qr.currency, qr.amount)} to ${qr.who}`}</Text>
        <Text style={S.badgeOk}>signed on this device ✓</Text>
        {/* The reconcile poll surfaced a TERMINAL ledger rejection of this envelope (item 3): the
            QR is dead — the merchant's submission was refused. Show why + stop polling; the payer
            can Cancel and start over. Not shown for still-pending (unknown) — that stays honest. */}
        {err ? <Text testID="qr-err" style={S.err}>{err}</Text> : null}
        {online ? <Text style={S.qrHint}>Waiting for {qr.who} to scan…</Text> : (
          <>
            <Text style={S.qrHint}>Offline — {qr.who} settles this when they submit it. You’ll see it on your balance once you’re back online.</Text>
            <View style={S.confirmRow}>
              {/* Offline we CANNOT know the ledger settled it, so this is an honest "handed off",
                  not "Paid ✓". It optimistically reduces the local balance; the real balance
                  reconciles on the next online poll. It does NOT fabricate a settled history entry.
                  MC5: pass the request's currency so the deduction lands on THIS asset's entry, not
                  the DEMO counter (currency-keyed offline deduction). */}
              <Pressable testID="btn-paid" style={S.paidBtn} onPress={() => { onOfflinePaid(qr.amount, qr.currency); setPaid({amount: qr.amount, currency: qr.currency, who: qr.who, already: false, pending: true}); setPhase('paid'); }} accessibilityRole="button" accessibilityLabel={`Handed to ${qr.who}`} accessibilityHint="Mark the signed payment as handed off; your balance updates when the merchant settles" accessibilityState={{disabled: false}}><Text style={S.paidBtnText}>Handed to {qr.who}</Text></Pressable>
              <Pressable testID="btn-notpaid" style={S.notPaidBtn} onPress={reset} accessibilityRole="button" accessibilityLabel="Cancel" accessibilityState={{disabled: false}}><Text style={S.notPaidText}>Cancel</Text></Pressable>
            </View>
          </>
        )}
        <Pressable style={S.ghostBtn} onPress={() => share(qr.code)} accessibilityRole="button" accessibilityLabel="Share auth code" accessibilityState={{disabled: false}}><IconShare size={16} color={C.sub}/><Text style={S.ghostBtnText}>{shared ? shareConfirmLabel('Copied ✓') : 'Share auth code'}</Text></Pressable>
      </View>
    );
  }

  if (phase === 'review' && req) {
    // MC5 — fail closed BEFORE signing: a request carrying an unknown/unsupported currency (a
    // garbage/retired id, or a CkSol-family currency with no ramp config) must NEVER reach the
    // envelope signer (prepareTransfer). The ledger also rejects these, but the app should never
    // let the user Approve a sign for an unsupported asset. Mirror the BalancesSheet "Unsupported asset" pattern:
    // honest copy + NO sign button + a back-to-scan affordance. dpay never swaps, so we do NOT
    // offer to substitute another asset — the request is for this asset or none.
    if (!isPayableAsset(catalog, req.currency)) {
      return (
        <View style={S.center}>
          <Text style={S.label}>Unsupported asset</Text>
          <Text testID="review-unsupported" style={S.warnNote}>This payment requests an asset this wallet can’t pay (currency {req.currency}). dpay never swaps, so there’s no fallback. Ask the merchant to request a supported asset.</Text>
          <Pressable style={[S.ghostBtn, S.ghostBtnMuted]} onPress={reset} accessibilityRole="button" accessibilityLabel="Cancel" accessibilityState={{disabled: false}}><Text style={S.ghostBtnText}>Cancel</Text></Pressable>
        </View>
      );
    }
    // MC5: locked-asset review — the payer sees + pays the EXACT asset the merchant requested (dpay
    // never swaps). The balance check uses ONLY that asset's balance: currency 0 → shownBalance
    // (DEMO_USD, tracked in the header), else assetBalances[req.currency] (the polled per-asset
    // balance). An unknown balance (null) is treated as "don't block" (same as the old DEMO path).
    const reqBalance = req.currency === 0 ? shownBalance : (assetBalances[req.currency] ?? null);
    // C2: when ONLINE and the known balance can't cover the amount, gate PRE-SUBMIT (no doomed
    // /pay). Offline we can't be sure (the local balance may be stale), so we only WARN there and
    // let the merchant's online verify be the real gate. MC1 units 2-4: `cmpRaw` (BigInt) — never a
    // lexicographic string compare (which would wrongly rank "9" > "10").
    const insufficient = reqBalance != null && cmpRaw(req.amount, reqBalance) > 0;
    const blockApprove = online && insufficient;
    // C1: any shown error (expired / insufficient relay-reject / verify-fail) also disables the
    // button so a doomed payment can't be re-tapped.
    const approveDisabled = busy || !!err || blockApprove;
    return (
      <View style={S.center}>
        <Text style={S.label}>Review payment</Text>
        <Text testID="pay-amount" style={S.reviewAmount}>{`Pay ${fmtCurrencyAmount(catalog, req.currency, req.amount)}`}</Text>
        <Text style={S.reviewTo}>{`to ${req.toName || short(req.toHex)}`}</Text>
        {/* U-F5 — the payee's short pubkey as a subdued second line when a display name is shown,
            so the payer can verify the destination beyond a claimed name (phishing surface). The
            no-name fallback already renders the short key as the primary "to" line. */}
        {req.toName ? <Text testID="review-payee" style={S.dim2}>{short(req.toHex)}</Text> : null}
        {/* The merchant-set memo (if any) — shown as a small subtitle so the payer sees the note
            attached to this request before approving. Empty memo renders nothing. */}
        {req.memo ? <Text testID="review-memo" style={S.dim2}>{req.memo}</Text> : null}
        {/* C1/C2 + L5: the warning + any error render ABOVE the button (not below) so they're seen
            first; the raw request nonce is no longer surfaced (internal protocol data). */}
        {insufficient ? (
          <Text testID="review-lowbal" style={S.warnNote}>{blockApprove
            ? 'Not enough balance to cover this payment.'
            : 'Your local balance may not cover this — the merchant will verify.'}</Text>
        ) : null}
        {err ? <Text testID="review-err" style={S.err}>{err}</Text> : null}
        <Pressable
          testID="btn-approve"
          style={[S.primary, approveDisabled && S.disabledFlat]}
          disabled={approveDisabled}
          accessibilityRole="button"
          accessibilityLabel="Approve payment"
          accessibilityHint="Sign the displayed amount with your key and send it"
          accessibilityState={{disabled: approveDisabled}}
          onPress={approve}>
          <Text style={S.primaryText}>{busy ? 'Signing…' : 'Approve'}</Text>
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
          accessibilityLabel="Cancel"
          accessibilityState={{disabled: false}}>
          <Text style={S.secondaryBtnText}>Cancel</Text>
        </Pressable>
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
  //   - A no-onramp asset keeps the panel but omits the primary and says so honestly.
  const gateDesc = catalog.find(c => c.currency === withdrawCurrency) ?? null;
  const gateSymbol = gateDesc ? (isTestnetCurrency(gateDesc) ? testnetDisplayName(gateDesc) : displayName(gateDesc)) : 'funds';
  const gateDepositable = !!gateDesc && !gateDesc.mintable && gateDesc.onramp !== 'Unavailable' && gateDesc.minter != null;
  const gateBalance = withdrawCurrency === 0 ? shownBalance : (assetBalances[withdrawCurrency] ?? null);
  const fundGate = online && gateBalance != null && cmpRaw(gateBalance, '0') === 0 && gateDesc != null && !gateDesc.mintable;
  const fundPanel = fundGate ? (
    <FundFirstPanel
      testID="pay-fund"
      title={`Add ${gateSymbol} to ${subMode === 'send' ? 'send' : 'pay'}`}
      body={gateDepositable
        ? `This wallet has no ${gateSymbol} yet. Send ${gateSymbol} to your address and you can ${subMode === 'send' ? 'send' : 'pay'} right away.`
        : `This wallet has no ${gateSymbol} yet — and ${gateSymbol} isn't available for deposits yet. Fund another asset, or check back soon.`}
      primaryLabel={gateDepositable ? `Show my ${gateSymbol} address` : undefined}
      onPrimary={gateDepositable ? onShowDepositAddress : undefined}
      onRecheck={onRefreshBalances}
        recheckBusy={refreshBusy}
    />
  ) : null;

  // "Send to address" sub-mode: render the on-chain withdraw flow INLINE (the WithdrawSheet body) for
  // the active asset's family. The toggle above lets the user flip back to "Scan to pay". The sheet is
  // inline-only (no overlay chrome — the tab body provides the surface). Only reached when
  // withdrawFamily is non-null (the toggle is gated). The fund-first gate applies HERE too (same
  // surface as SOL's send branch — no amount entry against a known-zero balance).
  if (subMode === 'send' && withdrawFamily && withdrawDisplay) {
    return (
      <View style={S.center}>
        <ModeToggle
          testID="pay-mode-toggle"
          value={subMode}
          onChange={(v) => onSubModeChange(v as 'scan' | 'send')}
          left={{label: 'Scan to pay', value: 'scan', testID: 'btn-pay-scan'}}
          right={{label: 'Send to address', value: 'send', testID: 'btn-pay-send'}}
        />
        {fundPanel ?? (
          <WithdrawSheet
            identity={identity}
            catalog={catalog}
            currency={withdrawCurrency}
            decimals={catalog.find(c => c.currency === withdrawCurrency)?.decimals ?? withdrawDisplay.amountDecimals}
            display={withdrawDisplay}
            family={withdrawFamily}
            tokenContract={withdrawTokenContract}
            balance={withdrawBalance}
            onClose={() => onSubModeChange('scan')}
            onWithdrawn={onSettled}
          />
        )}
      </View>
    );
  }

  // Scan screen: the card is armed in the background (if NFC is ready) AND the QR scanner is live at
  // the same time — the payer taps the merchant's phone OR scans its QR, with no button in between.
  // A leading NFC status row tells the payer whether tap-to-pay is available; QR always works.
  const nfcInfo: Exclude<NfcStatus, 'ready'> = (nfcStatus === 'ready' ? 'unknown' : nfcStatus);
  return (
    <View style={S.center}>
      {withdrawFamily ? (
        <ModeToggle
          testID="pay-mode-toggle"
          value={subMode}
          onChange={(v) => onSubModeChange(v as 'scan' | 'send')}
          left={{label: 'Scan to pay', value: 'scan', testID: 'btn-pay-scan'}}
          right={{label: 'Send to address', value: 'send', testID: 'btn-pay-send'}}
        />
      ) : null}
      {fundPanel ?? (
        <>
      {nfcReady && DpayNfc ? (
        <NfcTap
          key={nfcKey} role="card" identity={identity}
          catalog={catalog}
          onSettled={onSettled} onOfflinePaid={onOfflinePaid}
          onActive={() => setNfcActive(true)}
          onClose={() => { setNfcActive(false); setNfcKey(k => k + 1); }}
        />
      ) : null}
      {!nfcActive ? (
        <>
          {Platform.OS !== 'web' && nfcReady ? (
            <View style={S.nfcStatusRow} testID="pay-scan">
              <NfcIcon color={C.brand} size={34} />
              <Text style={S.nfcStatusLabel}>Tap or scan to pay</Text>
            </View>
          ) : Platform.OS !== 'web' ? (
            <View style={S.nfcStatusRow} testID="pay-scan">
              <NfcIcon color={C.bad} size={34} off />
              <Pressable style={S.nfcInfoLink} onPress={() => setNfcInfoOpen(true)} accessibilityRole="button" accessibilityLabel="Why NFC is unavailable" accessibilityState={{disabled: false}}>
                <Text style={S.nfcInfoLinkText}>NFC not available</Text>
                <IconInfo size={15} color={C.sub2}/>
              </Pressable>
            </View>
          ) : (
            <Text style={[S.nfcStatusLabel, {paddingTop: 16}]} testID="pay-scan">Scan to pay</Text>
          )}
          {Platform.OS !== 'web' && !nfcReady ? <Text style={S.dim2}>Scan the QR code to pay.</Text> : null}
          <QrScanner onScan={onRequestString} />
          {err ? <Text style={S.err}>{err}</Text> : null}
        </>
      ) : null}
        </>
      )}
      <Modal visible={nfcInfoOpen} transparent animationType="fade" onRequestClose={() => setNfcInfoOpen(false)}>
        <Pressable style={S.pickBackdrop} onPress={() => setNfcInfoOpen(false)}>
          <View style={S.pickCard} onStartShouldSetResponder={() => true}>
            <Text style={S.pickTitle}>NFC unavailable</Text>
            <Text style={S.nfcInfoBody}>{NFC_REASON[nfcInfo]}</Text>
            <Pressable style={S.nfcInfoClose} onPress={() => setNfcInfoOpen(false)} accessibilityRole="button" accessibilityLabel="Close" accessibilityState={{disabled: false}}>
              <Text style={S.nfcInfoCloseText}>Close</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}
