import {useEffect, useRef, useState} from 'react';
import {View, Text, Pressable} from 'react-native';
import {QrCode} from './QrCode';
import {InstructionPanel} from './InstructionPanel';
import {SolanaAtaSetupCard} from './SolanaAtaSetupCard';
import {S} from '../styles';
import {C} from '../config/palette';
import {IconCheck, IconClock, IconScan, IconShare} from './icons';
import {POLL, QR_SIZE} from '../config/constants';
import type {SolPayGate} from '../config/assets';
import type {Identity, NfcStatus} from '../lib/types';
import {fmtAsset, short} from '../lib/format';
import {SOL_DECIMALS, SOL_UNIT} from '../solana/identity';
import {USDC_DECIMALS, SOL_ATA_SETUP_MIN_LAMPORTS, SOL_FEE_LAMPORTS} from '../solana/spl';
import {classifyScan, coinDisplayOfScheme} from '../lib/scan';
import {sanitiseDisplayText} from '../lib/deepLink';
import type {OcpDetails, OcpOffer, OcpScan} from '../lib/opencryptopay';
import {ocpTimeRefusal, payAndReport, resolveOcpOffer, resolveOcpScan, type OcpResolveResult, type OcpSendResult, type OcpTarget} from '../services/opencryptopay';
import type {SelectableAsset} from '../config/assets';
import type {CurrencyDescriptor} from '../config/catalog';
import {withTimeout} from '../lib/timeout';
import {SOL_SEND_TIMEOUT_MS} from '../config/constants';
import {decodeSolReq, encodeSolPay} from '../solana/qr';
import type {SolReqV2} from '../solana/qr';
import {isSolReqV2Expired} from '../solana/payments';
import {getSolSignatureStatus, sendSol, signSolPayment, signSplPayment, type SolanaSignatureStatus} from '../solana';
import {DpaySolNfc} from '../services/native';
import {QrScanner} from './QrScanner';
import {NfcStatusRow} from './NfcStatusRow';
import {SolNfcTap} from './SolNfcTap';
import {ModeToggle} from './ModeToggle';
import {OcpAssetChoice} from './OcpAssetChoice';
import {OcpQuoteLines} from './OcpQuoteLines';
import {SolanaWithdrawSheet} from './SolanaWithdrawSheet';
import {friendlySolError, isSolTransactionFailed} from '../solana/errors';
import {useReportLock} from '../hooks/useReportLock';
import {useShareFeedback, shareConfirmLabel} from '../hooks/useShareFeedback';
import {CoachTip} from './CoachTip';
import {M} from '../i18n';

/**
 * SolPayMode — the payer-side offline-pay component for the v2 recent-blockhash SOL rail.
 *
 * Rendered INLINE in the Pay tab body when SOL is the active asset (selected in Balances).
 * The payer scans a merchant's `solreq:v2:` QR, reviews, and signs FULLY OFFLINE (no RPC needed —
 * the signature uses the recent blockhash embedded in the request). The signed `solpay:v2:` QR is
 * shown for the merchant to scan + broadcast.
 *
 * No setup phase — v2 needs no durable-nonce account. The payer signs immediately on scan+approve.
 *
 * The honest-pending UX mirrors the IC offline hand-off (PayMode.tsx phase='qr'): the payer can
 * NEVER claim "Paid ✓" from an offline sign — they mark "Handed to merchant" (pending) and the
 * outcome is learned via NFC receipt or when the merchant settles on-chain.
 *
 * NFC arming: this component mounts only while the SOL rail is selected. Switching the rail unmounts
 * it, whose `useNfcTapState` cleanup disarms the HCE card — no arm-leak.
 */
export function SolPayMode({identity, online, nfcStatus, assets, catalog, solBalance, usdcBalance, usdcAtaAbsent, payGate = 'none', solZero = false, solChecking = false, selectedToken, onSent, onSentUsdc, onShowSolAddress, onShowUsdcAddress, onRecheckBalances, recheckBusy = false, ataSetupBusy = false, ataSetupErr = null, onCreateAta, subMode, onSubModeChange, sendPrefill = null, onSendPrefillConsumed, onScannedLink, onLockChange}: {identity: Identity; online: boolean; nfcStatus: NfcStatus; assets: SelectableAsset[]; catalog: CurrencyDescriptor[]; solBalance: string; usdcBalance: string; usdcAtaAbsent: boolean; payGate?: SolPayGate; solZero?: boolean; solChecking?: boolean; selectedToken: 'SOL' | 'USDC'; onSent: () => void; onSentUsdc: () => void; onShowSolAddress: () => void; onShowUsdcAddress: () => void; onRecheckBalances: () => void; recheckBusy?: boolean; ataSetupBusy?: boolean; ataSetupErr?: string | null; onCreateAta?: () => void; subMode: 'scan' | 'send'; onSubModeChange: (m: 'scan' | 'send') => void; sendPrefill?: {address: string; amount: string} | null; onSendPrefillConsumed?: () => void; onScannedLink: (url: string) => void; onLockChange?: (locked: boolean) => void}) {
  const [phase, setPhase] = useState<'scan' | 'review' | 'qr' | 'paid' | 'ocp' | 'ocp-choose' | 'ocp-done'>('scan');
  const [req, setReq] = useState<SolReqV2 | null>(null);
  // An OpenCryptoPay merchant till the camera read, and its outcome. Same two states the IC rail
  // holds (PayMode) — the quote context, and the honest sentence for an outcome that is neither
  // paid nor failed — because both rails run the identical provider sequence.
  const [ocp, setOcp] = useState<OcpTarget | null>(null);
  const [ocpBusy, setOcpBusy] = useState(false);
  // IC twin: PayMode's `ocpChoice`. The till's menu, when the selected asset was not on it.
  const [ocpChoice, setOcpChoice] = useState<{details: OcpDetails; host: string; options: OcpOffer[]; declined: string} | null>(null);
  const [ocpDone, setOcpDone] = useState<{amount: string; who: string; note: string | null} | null>(null);
  // A till transfer whose outcome this rail could NOT resolve, plus the quote it was made against.
  // IC twin: PayMode's `ocpClaim`, same reason and same lifecycle. The broadcast signature is the
  // payer's only claim on that money: the network already accepted the transaction, so its status
  // stays readable and the confirmation may be one more poll away — the likeliest failure of all is
  // a flaky connection while the transfer is already landing. Set ONLY when the transfer itself
  // stayed indefinite (so the one submission has NOT been spent), and cleared the moment it is
  // used, which is what keeps `/tx` to at most one call in total.
  const [ocpClaim, setOcpClaim] = useState<{signature: string; target: OcpTarget} | null>(null);
  // One re-poll at a time. The claim's effect below runs on an interval and each tick can outlive
  // the next, so without this two ticks could both reach a confirmed transfer and both report it.
  const ocpChecking = useRef(false);
  const [solpayUri, setSolpayUri] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A tap arriving on the always-armed card takes over the scan screen; nfcKey re-arms after each.
  // The radio is usable only in the 'ready' state; every other state falls through to QR-only,
  // with the row below explaining which one and what to do about it.
  const nfcReady = nfcStatus === 'ready';
  const [nfcActive, setNfcActive] = useState(false);
  const [nfcKey, setNfcKey] = useState(0);
  // Pay-intent gate (founder rule 2026-08-23, same as IC PayMode): the camera and the HCE card
  // start ONLY after the payer's explicit "Pay Now" tap. Disarmed by reset() and by
  // leaving the scan sub-mode; rail/tab switches unmount this component.
  const [scanArmed, setScanArmed] = useState(false);
  useEffect(() => { if (subMode !== 'scan') setScanArmed(false); }, [subMode]);
  // Camera remount key — IC twin: PayMode's `scanKey`, same reason. One code per mount means a
  // refusal that stays on this screen would otherwise leave a dead camera under copy that says
  // "scan again".
  const [scanKey, setScanKey] = useState(0);
  const refuseScan = (message: string) => { setErr(message); setScanKey(k => k + 1); };
  // A wallet address the camera read instead of a payment code — handed to the send form, which is
  // the one place that knows whether an address is usable on this rail and what it is when it is
  // not. Takes precedence over a link prefill: both fill the same form and the scan is the newer
  // intent. IC twin: PayMode's `scannedAddress`.
  const [scannedAddress, setScannedAddress] = useState<string | null>(null);

  // U-F1 — visible confirmation after the share resolves (the DepositSheet copy pattern). Dismissed
  // sheets leave the label honest.
  const {shared, share} = useShareFeedback();

  // Lock the idle asset selection while a SOL payment is in flight. Every non-scan phase holds a
  // captured, immutable snapshot the user must not lose to an asset switch (which unmounts this
  // component): the SolReqV2 of an offline pay, or the live quote of a merchant till.
  const locked = phase !== 'scan';
  useReportLock(onLockChange, locked);

  // Resolve a till transfer this rail left indefinite. IC twin: PayMode's claim effect — same
  // shape, same interval, same one-shot discipline; only the question asked of the network differs
  // (a signature status instead of a read_state poll). The provider has NOT been told yet, so a
  // transaction that turns out to have confirmed can still be reported and the sale still credited;
  // one the chain has failed means nothing moved at all. Either way the claim is spent once and
  // `/tx` is called at most once in total (findings doc, "The loss path").
  //
  // Declared up here with the other hooks, ABOVE the sub-mode early return, so the Rules of Hooks
  // hold across a Send detour — the same reason the `useState` block sits where it does. The
  // handlers it calls are hoisted function declarations further down.
  useEffect(() => {
    if (phase !== 'ocp-done' || ocpClaim === null) return;
    let alive = true;
    const check = async () => {
      if (ocpChecking.current) return;
      ocpChecking.current = true;
      try {
        let status: SolanaSignatureStatus | null;
        try {
          status = await getSolSignatureStatus(ocpClaim.signature);
        } catch (e) {
          console.warn('ocp claim re-poll failed:', e instanceof Error ? e.message : String(e));
          return; // best-effort: the next tick tries again
        }
        if (!alive) return;
        const sent = solStatusToSend(status, ocpClaim.signature);
        if (sent.kind === 'unknown') return; // still indefinite — keep looking
        if (sent.kind === 'refused') {
          // Definitive: nothing reached the merchant. The pending screen was the honest state a
          // moment ago and is a lie now, so it goes — back to the scanner, with the reason and the
          // one action that can still pay this till.
          reset();
          refuseScan(sent.message);
          return;
        }
        // The transaction DID confirm, and the provider still has not heard about it. Report it
        // ONCE — but only while the price it was quoted against is alive: a submission against a
        // dead quote is refused AND binds the transaction id to it, which is precisely what would
        // take away the payer's ability to claim this payment with the merchant.
        if (Date.now() >= ocpClaim.target.expiresAt) {
          setOcpDone(d => (d === null ? d : {...d, note: M.pay.ocp.submitTooLate(sent.reference)}));
          setOcpClaim(null);
          return;
        }
        const done = await payAndReport(
          ocpClaim.target.details,
          ocpClaim.target.method,
          ocpClaim.target.asset,
          () => Promise.resolve(sent),
        );
        if (!alive) return;
        // `done` is the reported outcome's own sentence — 'not-paid' cannot arise from a settled
        // send, and both remaining shapes carry what the payer needs (a null note = paid).
        setOcpDone(d => (d === null ? d : {...d, note: done.kind === 'paid' ? null : done.message}));
        setOcpClaim(null);
      } finally {
        ocpChecking.current = false;
      }
    };
    void check();
    // `reset`/`refuseScan` are deliberately NOT dependencies: they are stable closures over
    // setState, and re-running on their identity would restart the interval on every render.
    const id = setInterval(() => { void check(); }, POLL.receiptPay);
    return () => { alive = false; clearInterval(id); };
  }, [phase, ocpClaim]);

  const toggle = (
    <ModeToggle
      testID="pay-mode-toggle"
      value={subMode}
      onChange={(v) => onSubModeChange(v as 'scan' | 'send')}
      left={{label: M.pay.scanToPay, value: 'scan', testID: 'btn-pay-scan'}}
      right={{label: M.pay.sendToAddress, value: 'send', testID: 'btn-pay-send'}}
    />
  );

  // "Send to address" sub-mode: render the on-chain send flow INLINE (the SolanaWithdrawSheet body).
  // The toggle above lets the user flip back to "Scan to pay". The sheet is inline-only (no overlay
  // chrome — the tab body provides the surface). Mirrors the IC PayMode "Send to address" sub-mode.
  // Sits BELOW the useState so React's Rules of Hooks hold across sub-mode flips (the payer's
  // phase state survives a Send detour without re-mounting).
  if (subMode === 'send') {
    const sendBalance = selectedToken === 'SOL' ? solBalance : usdcBalance;
    const sendOnSent = selectedToken === 'SOL' ? onSent : onSentUsdc;
    // Offline gate — IC twin: PayMode's `offlinePanel`, same reason. This rail broadcasts straight
    // to a Solana RPC from THIS phone, so airplane mode blocks an address send outright while
    // scan-to-pay keeps working (the payer signs offline against the merchant's blockhash and the
    // merchant broadcasts). Checked BEFORE the funds gate: a balance read while offline is stale.
    if (!online) {
      return (
        <View style={S.center}>
          {toggle}
          <InstructionPanel
            testID="sol-send-offline"
            title={M.pay.offlineSendTitle}
            body={M.pay.offlineSendBody(selectedToken)}
            primaryLabel={M.pay.scanToPay}
            onPrimary={() => onSubModeChange('scan')}
            onRecheck={onRecheckBalances}
            recheckBusy={recheckBusy}
          />
        </View>
      );
    }
    // Zero-funds gate (2026-08-16): the send form is replaced by the fund-first panel while the
    // active token is KNOWN unfunded — no amount entry against a zero balance. Same panel, same
    // copy family as the scan branch (only "…to send" instead of "…to pay"), per the spec.
    if (payGate !== 'none' && payGate !== 'usdc-absent') {
      const isSol = payGate === 'sol-zero';
      return (
        <View style={S.center}>
          {toggle}
          <InstructionPanel
            testID="sol-send-fund"
            title={M.pay.fundTitle(isSol ? 'SOL' : 'USDC', 'send')}
            body={isSol
              ? M.pay.fundBody('SOL', 'send')
              : M.pay.fundBodyUsdc}
            primaryLabel={M.pay.showMyAddress(isSol ? 'SOL' : 'USDC')}
            onPrimary={isSol ? onShowSolAddress : onShowUsdcAddress}
            secondaryLabel={!isSol && solZero ? M.pay.showMyAddress('SOL') : undefined}
            onSecondary={!isSol && solZero ? onShowSolAddress : undefined}
            onRecheck={onRecheckBalances}
            recheckBusy={recheckBusy}
          />
          {err ? <Text testID="sol-pay-err" style={S.err}>{err}</Text> : null}
        </View>
      );
    }
    return (
      <View style={S.center}>
        {toggle}
        <SolanaWithdrawSheet
          identity={identity}
          token={selectedToken}
          balance={sendBalance}
          prefill={scannedAddress != null ? {address: scannedAddress, amount: ''} : sendPrefill}
          onPrefillConsumed={() => { if (scannedAddress != null) setScannedAddress(null); else onSendPrefillConsumed?.(); }}
          usdcAtaAbsent={usdcAtaAbsent}
          solBalance={solBalance}
          solChecking={solChecking}
          ataSetupBusy={ataSetupBusy}
          ataSetupErr={ataSetupErr}
          onCreateAta={onCreateAta}
          onShowSolAddress={onShowSolAddress}
          onSent={sendOnSent}
          onClose={() => onSubModeChange('scan')}
        />
      </View>
    );
  }

  // Scan the merchant's solreq:v2: QR → decode → auto-sign (one-press rule: the "Pay Now" gate
  // was the deliberate press — the SOL rail has no deeplink entry, so no review screen exists on
  // this path). Enforce `exp` CLIENT-SIDE (the SOL rail has no server to reject a stale request —
  // unlike the IC canister — so a stale/replayed solreq is fully signable unless we refuse it
  // here, before signing).
  function onScan(raw: string) {
    try {
      const r = decodeSolReq(raw);
      if (isSolReqV2Expired(r)) {
        setReq(null);
        refuseScan(M.pay.solRequestExpired);
        return;
      }
      setReq(r);
      setErr(null);
      setPhase('review');
      approve(r);
    } catch (e: unknown) {
      // Same honest-contract split as PayMode's decode failure: the user gets friendly copy (never
      // the raw codec error), the dev cause goes to the console.
      console.warn('solpay decode failed:', e);
      onNotARequest(raw);
    }
  }

  // The solreq codec refused the scan. IC twin: PayMode.onNotARequest — same three verdicts, same
  // order, because the same-surfaces rule means a scanned link and a scanned address behave
  // identically whichever rail is active. A link goes to the Wallet's ONE link pipeline (which can
  // route it back to the IC rail if that is where the asset lives); an address — of ANY namespace,
  // not just base58 — goes to the send form, whose status line names the chain it belongs to and
  // refuses a wrong-chain paste by name. Every SOL asset is sendable, so there is no
  // not-sendable branch here.
  function onNotARequest(raw: string) {
    const what = classifyScan(raw);
    if (what.kind === 'link') { setErr(null); onScannedLink(raw.trim()); return; }
    if (what.kind === 'opencryptopay') { void startOcp(what.ocp); return; }
    if (what.kind === 'coin-request') {
      const named = coinDisplayOfScheme(what.scheme);
      refuseScan(M.pay.scannedCoinRequest(named.coin, named.uri));
      return;
    }
    if (what.kind === 'address') {
      setErr(null);
      setScannedAddress(raw.trim());
      onSubModeChange('send');
      return;
    }
    refuseScan(M.pay.notAPaymentCode);
  }

  // The OPENCRYPTOPAY entry — the IC rail's twin (PayMode.startOcp), running the SAME resolution so
  // a till code behaves identically whichever asset is selected (CLAUDE.md same-surfaces rule).
  // Two provider reads, no signature, no funds; the payer then approves an explicit review.
  //
  // `catalog` is threaded in only because the resolver checks an IC destination against the ledger
  // its asset settles on. It is never consulted for a Solana target — SOL is a device-key rail and
  // never enters the ICRC catalog (CLAUDE.md non-negotiable).
  async function startOcp(scan: OcpScan) {
    if (!scan.ok) {
      refuseScan(scan.reason === 'not-https' ? M.pay.ocp.notHttps : M.pay.ocp.badCode);
      return;
    }
    const id = selectedToken === 'USDC' ? 'solana:USDC' : 'solana:SOL';
    const selected = assets.find(a => a.id === id) ?? null;
    if (selected === null) {
      // Unreachable in a mounted wallet — this component only renders while a Solana row IS the
      // selection — so it is logged as the inconsistency it would be. The user still gets an action
      // ("show the code again"), which is what a re-scan needs once the asset list is there.
      console.warn(`ocp: ${id} missing from the asset list while the Solana rail is mounted`);
      refuseScan(M.pay.ocp.badCode);
      return;
    }
    setErr(null);
    setOcpBusy(true);
    try {
      // The rail's whole worst case from Approve to a confirmed signature is ONE bound here —
      // `withTimeout(SOL_SEND_TIMEOUT_MS)` in `sendSolForOcp` covers the blockhash fetch, the
      // broadcast and the confirmation poll together — so the resolver's deadline is derived from
      // that same constant rather than from a number that could drift away from it.
      const out = await resolveOcpScan(scan, {selected, assets, catalog, nowMs: Date.now(), sequenceBudgetMs: SOL_SEND_TIMEOUT_MS});
      landOcp(out, selected.symbol);
    } finally {
      setOcpBusy(false);
    }
  }

  /** Where BOTH till paths end — the direct one and the one the payer picked off the menu. IC twin:
   *  PayMode's `landOcp`, same shape so a till behaves identically on either rail. */
  function landOcp(out: OcpResolveResult, declined: string) {
    // Back to the scanner on any refusal, including one reached FROM the menu: leaving the phase on
    // 'ocp-choose' would strand the payer on a list they can no longer act on.
    if (out.kind === 'refused') { setOcpChoice(null); setPhase('scan'); refuseScan(out.message); return; }
    if (out.kind === 'choose') { setOcpChoice({...out, declined}); setPhase('ocp-choose'); return; }
    // Fail closed on anything but native SOL: the send below is a System Program transfer, so a
    // token target would move SOL against a token price. The resolver already refuses Solana USDC
    // by name (its URI does not say which token account to pay); this is the second lock on it.
    if (out.target.assetId !== 'solana:SOL') { setOcpChoice(null); setPhase('scan'); refuseScan(M.pay.ocp.solanaUsdcUnsupported); return; }
    setOcp(out.target);
    setPhase('ocp');
  }

  /** The payer picked an asset off the till's menu. IC twin: PayMode's `chooseOcpOffer`. `Date.now()`
   *  is read again on purpose — the quote ticked while the menu was on screen. */
  async function chooseOcpOffer(offer: OcpOffer) {
    const choice = ocpChoice;
    if (choice === null) return;
    setErr(null);
    setOcpBusy(true);
    try {
      const out = await resolveOcpOffer(choice.host, choice.details, offer, {
        assets, catalog, nowMs: Date.now(), sequenceBudgetMs: SOL_SEND_TIMEOUT_MS,
      });
      setOcpChoice(null);
      landOcp(out, choice.declined);
    } finally {
      setOcpBusy(false);
    }
  }

  // The Solana rail's half of an OpenCryptoPay payment: broadcast, confirm, and answer with the
  // signature — or with a verdict that keeps the provider from ever being called. The order around
  // it is `payAndReport`'s (services/opencryptopay.ts).
  //
  // The `onBroadcast` capture is what makes the answer honest. `sendSol` throws for a dead RPC, a
  // rejected transaction AND a confirmation timeout alike, but only the last of those can leave
  // real money in flight: once the network has accepted the transaction, a later failure means
  // UNKNOWN, and reporting a signature we cannot vouch for would spend the one submission the
  // provider grants (findings doc, "The loss path"). A holder object rather than a bare `let` so
  // the value survives control-flow narrowing into the catch.
  //
  // The asymmetry runs ONE way only. Preferring unknown over a false "paid" is right for an outcome
  // nobody knows; it is wrong for one the chain has already decided. A transaction the network
  // INCLUDED and then failed moved no lamports and never will, so calling it unknown would tell the
  // payer "don't pay again" about a purchase they still have to pay for — which is why that case is
  // classified out of the catch first, by the same module that owns every other Solana error class.
  //
  // An indefinite outcome hands the signature back through `hold` instead of dropping it. It is the
  // claim on the money: the network accepted this transaction, so the chain can still be asked what
  // became of it, and discarding it would turn the recoverable case into the unrecoverable one.
  async function sendSolForOcp(target: OcpTarget, hold: {claim: string | null}): Promise<OcpSendResult> {
    const broadcast: {sig: string | null} = {sig: null};
    const {signal, cancel} = withTimeout(SOL_SEND_TIMEOUT_MS);
    try {
      const sig = await sendSol(identity.secretHex, target.to, BigInt(target.rawAmount), signal, s => { broadcast.sig = s; });
      return {kind: 'settled', txId: sig, reference: M.pay.ocp.ref.solTransaction(sig)};
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('ocp: SOL send failed:', msg);
      if (isSolTransactionFailed(msg)) return {kind: 'refused', message: M.pay.ocp.transferFailed};
      if (broadcast.sig === null) return {kind: 'refused', message: friendlySolError(msg)};
      hold.claim = broadcast.sig;
      return {kind: 'unknown'};
    } finally {
      cancel();
    }
  }

  // Approve on an OpenCryptoPay till: the funds move first and the provider is told exactly once,
  // afterwards. IC twin: PayMode.approveOcp — same states, same copy, same refusal to retry.
  async function approveOcp(target: OcpTarget) {
    // Re-checked at the press, not just by the countdown (which ticks once a second): paying with
    // too little of the price left moves irreversible money the provider will refuse to credit.
    const late = ocpTimeRefusal(target, Date.now());
    if (late !== null) { setErr(late); return; }
    // The same fee-inclusive gate the review renders, re-asserted at the press: the balance prop
    // can refresh between render and tap, and this is the last point before irreversible money.
    if (BigInt(solBalance) < BigInt(target.rawAmount) + SOL_FEE_LAMPORTS) {
      setErr(M.pay.notEnoughBalance);
      return;
    }
    const who = target.details.claimedMerchantName ?? target.host;
    const amount = fmtAsset(target.rawAmount, SOL_DECIMALS, SOL_UNIT);
    // Filled by the send below when — and only when — the transfer's own outcome stayed indefinite.
    // That is exactly the case in which the provider has NOT been told, so the one submission is
    // still unspent and the claim is worth keeping.
    const hold: {claim: string | null} = {claim: null};
    setBusy(true);
    setErr(null);
    try {
      const out = await payAndReport(target.details, target.method, target.asset, () => sendSolForOcp(target, hold));
      if (out.kind === 'not-paid') { setErr(out.message); return; }
      // 'paid' and 'unresolved' both leave the review: the money is gone either way, so there is no
      // Approve to press again. The note is what separates them on the outcome screen.
      onSent();
      if (out.kind !== 'paid' && hold.claim !== null) setOcpClaim({signature: hold.claim, target});
      setOcpDone({amount, who, note: out.kind === 'paid' ? null : out.message});
      setPhase('ocp-done');
    } finally {
      setBusy(false);
    }
  }

  // Offline sign (PURE, no RPC) → show the signed solpay:v2: QR. Auto-fired by onScan; a sign
  // throw stays on the 'review' surface with the error + Cancel (the honest terminal).
  function approve(r: SolReqV2) {
    setBusy(true);
    try {
      const solpay = r.cur === 'SOL'
        ? signSolPayment(identity.secretHex, r)
        : signSplPayment(identity.secretHex, r);
      setSolpayUri(encodeSolPay(solpay));
      setPhase('qr');
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function reset() { setReq(null); setSolpayUri(null); setOcp(null); setOcpChoice(null); setOcpDone(null); setOcpClaim(null); setErr(null); setScanArmed(false); setPhase('scan'); }

  // NFC card outcome: success/pending → paid (awaiting merchant confirmation); declined → back to scan.
  function onNfcOutcome(outcome: 'success' | 'pending' | 'declined') {
    if (outcome === 'declined') { reset(); return; }
    setPhase('paid');
  }

  const decimals = req?.cur === 'USDC' ? USDC_DECIMALS : SOL_DECIMALS;
  const unit = req?.cur === 'USDC' ? 'USDC' : SOL_UNIT;
  // The merchant's CLAIMED name and note, from a code a stranger printed or a phone that tapped
  // this one. Same threat and same helper as the IC wire request (`wireRequestToIntent`), a payment
  // link's `label`/`memo` (`clampLinkText`) and a till's merchant name (`claimedMerchantNameOf`):
  // the 32-character cap bounds the length, but React Native `Text` renders newlines, so a name of
  // blank lines pushes the destination address — the only checkable thing on this screen — out of
  // view.
  //
  // Derived for DISPLAY and never written back into `req`, which is the difference from the IC
  // rail's seam: the payer's signature commits to `sha256(encodeSolReq(req))`
  // (`buildCanonicalSolMessage`), and the merchant re-derives that same URI to verify the payment
  // (`verifySolPayment`). A sanitised `name` in the signed request is a request the merchant's own
  // verifier rejects — so the codec's canonical bytes stay untouched and only these two locals are
  // rendered.
  const claimedName = req ? sanitiseDisplayText(req.name) : '';
  const claimedMemo = req ? sanitiseDisplayText(req.memo) : '';

  if (phase === 'scan') {
    // Zero-funds gate (2026-08-16 UX): when the active asset is KNOWN unfunded the scanner is
    // replaced by the fund-first panel. NFC does NOT arm while gated — a tap is auto-sign consent,
    // and a zero balance would sign a payment the merchant can never settle (doomed signature).
    // loading/error/unavailable NEVER reach here (the Wallet's gate fails OPEN to the scanner —
    // offline-first rule; the honest backstop is the same review/RPC failure as before).
    if (payGate === 'sol-zero' || payGate === 'usdc-zero') {
      const isSol = payGate === 'sol-zero';
      return (
        <View style={S.center}>
          {toggle}
          <InstructionPanel
            testID="sol-pay-fund"
            title={M.pay.fundTitle(isSol ? 'SOL' : 'USDC', 'pay')}
            body={isSol
              ? M.pay.fundBody('SOL', 'pay')
              : M.pay.fundBodyUsdc}
            primaryLabel={M.pay.showMyAddress(isSol ? 'SOL' : 'USDC')}
            onPrimary={isSol ? onShowSolAddress : onShowUsdcAddress}
            secondaryLabel={!isSol && solZero ? M.pay.showMyAddress('SOL') : undefined}
            onSecondary={!isSol && solZero ? onShowSolAddress : undefined}
            onRecheck={onRecheckBalances}
            recheckBusy={recheckBusy}
          />
          {err ? <Text testID="sol-pay-err" style={S.err}>{err}</Text> : null}
        </View>
      );
    }
    if (payGate === 'usdc-absent') {
      // USDC-selected + ATA KNOWN absent: the one-tap setup card (with the fund-SOL secondary when
      // SOL is also zero) replaces the scanner. Setup first, then pay — never a doomed SPL sign.
      const hasSol = BigInt(solBalance) >= SOL_ATA_SETUP_MIN_LAMPORTS;
      return (
        <View style={S.center}>
          {toggle}
          <SolanaAtaSetupCard
            instrTestID="sol-pay-ata-instructions"
            btnTestID="btn-sol-pay-ata-create"
            buttonLabel={M.pay.createUsdcAccount}
            hasSol={hasSol}
            checkingSol={solChecking}
            busy={ataSetupBusy}
            err={ataSetupErr}
            onCreateAta={onCreateAta}
            onShowSolAddress={onShowSolAddress}
          />
          {err ? <Text testID="sol-pay-err" style={S.err}>{err}</Text> : null}
        </View>
      );
    }
    return (
      <View style={S.center}>
        {toggle}
        {/* Pay-intent gate (same rule as IC PayMode): IDLE keeps the sol-pay-scan container + hint
            and a single primary CTA; the camera and the NFC card start ONLY on that tap. ARMED is
            exactly the pre-gate scan surface — card in the background (if ready), QR live at the
            same time; the payer taps the merchant's phone OR scans its QR. No setup needed in v2. */}
        {scanArmed && nfcReady && DpaySolNfc ? (
          <SolNfcTap
            key={nfcKey} role="card" identity={identity}
            onOutcome={onNfcOutcome}
            onClose={() => { setNfcActive(false); setNfcKey(k => k + 1); }}
          />
        ) : null}
        {!nfcActive ? (
          <>
            {/* testID is `sol-nfc-row`, NOT `sol-nfc-status`: that one is already owned by the SOL
                tap OVERLAY (SolNfcTap → NfcTapView), and flows 47/51/66/74/93 wait for the overlay
                to appear and then disappear. An always-present row sharing its id makes `waitGone`
                unsatisfiable. The IC twin has no such clash — its overlay is `nfc-status` while the
                row is `pay-scan`. */}
            <NfcStatusRow nfcStatus={nfcStatus} testID="sol-nfc-row" />
            <View testID="sol-pay-scan" style={S.scanWrap}>
              {/* P3 — a leading IconScan on the hint only; the camBox/scanWrap/center nesting is
                  UNTOUCHED (the 0×0 camBox collapse class is gated by `just campreview`). */}
              <View style={{flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, marginTop: 8}}>
                <IconScan size={18} color={C.sub}/>
                <Text style={[S.dim2, {marginTop: 0}]}>{M.pay.solScanHint}</Text>
              </View>
              {scanArmed ? (
                <QrScanner key={scanKey} onScan={onScan} />
              ) : (
            <>
              <Pressable
                    style={S.primary}
                    onPress={() => setScanArmed(true)}
                    accessibilityRole="button"
                    accessibilityLabel={M.pay.payNowA11y}
                    accessibilityHint={M.pay.payNowHint}
                    testID="btn-sol-start-scan"
                  >
                    <Text style={S.primaryText}>{M.pay.payNow}</Text>
                  </Pressable>
                </>
              )}
            </View>
            {/* The till lookup is two network reads and can take tens of seconds. IC twin:
                PayMode's `ocp-checking`. */}
            {ocpBusy ? <Text testID="ocp-checking" style={S.dim2}>{M.pay.ocp.checkingTill}</Text> : null}
            {err ? <Text testID="sol-pay-err" style={S.err}>{err}</Text> : null}
          </>
        ) : null}
      </View>
    );
  }

  if (phase === 'ocp-choose' && ocpChoice) {
    return (
      <OcpAssetChoice
        declined={ocpChoice.declined}
        options={ocpChoice.options}
        busy={ocpBusy}
        // This rail spends lamports, so every option it can take is denominated in SOL.
        labelOf={o => fmtAsset(o.rawAmount, SOL_DECIMALS, SOL_UNIT)}
        onPick={o => void chooseOcpOffer(o)}
        onCancel={reset}
      />
    );
  }

  if (phase === 'ocp' && ocp) {
    // A merchant till: reviewed and approved explicitly, NEVER auto-signed. The one-press rule does
    // not reach here — it covers a dpay request whose amount and payee came off a dpay QR, while
    // every value on this screen came from a provider the wallet has no relationship with. Mirrors
    // the IC rail's till review (PayMode), down to the testIDs.
    // The wallet must cover the price AND the network fee — a transfer of exactly the balance
    // cannot pay for itself. Gated on the IC rail since it shipped; the divergence here was review
    // row 12, and CLAUDE.md's same-surfaces rule makes a money-surface divergence a bug. This
    // BLOCKS rather than warns: an OCP payer is online by construction (two provider reads got them
    // to this screen), so the balance behind it is fresh — unlike the offline dpay-request path,
    // where a stale local balance earns only a warning and the merchant's verify is the real gate.
    const ocpInsufficient = BigInt(solBalance) < BigInt(ocp.rawAmount) + SOL_FEE_LAMPORTS;
    const approveDisabled = busy || !!err || ocpInsufficient;
    return (
      <View style={S.center}>
        <Text style={S.label}>{M.pay.reviewPayment}</Text>
        <Text testID="sol-pay-amount" style={S.reviewAmount}>{M.pay.payAmount(fmtAsset(ocp.rawAmount, SOL_DECIMALS, SOL_UNIT))}</Text>
        <Text style={S.reviewTo}>{M.pay.toWho(ocp.details.claimedMerchantName ?? ocp.host)}</Text>
        {/* The FULL destination address, never shortened: the provider chose it, so it is the one
            thing on this screen the payer can actually check. */}
        <Text testID="sol-pay-payee" style={S.dim2}>{ocp.to}</Text>
        <OcpQuoteLines
          host={ocp.host}
          claimedName={ocp.details.claimedMerchantName}
          requested={ocp.details.requestedAmount}
          payableUntil={ocp.payableUntil}
          onTooLate={() => setErr(ocpTimeRefusal(ocp, Date.now()))}
        />
        {/* Above the button, like the IC rail's own low-balance line, so it is read before the
            press rather than after it. */}
        {ocpInsufficient ? <Text testID="sol-pay-lowbal" style={S.warnNote}>{M.pay.notEnoughBalance}</Text> : null}
        {err ? <Text testID="sol-pay-err" style={S.err}>{err}</Text> : null}
        <Pressable
          testID="btn-approve"
          style={[S.primary, approveDisabled && S.disabledFlat]}
          disabled={approveDisabled}
          accessibilityRole="button"
          accessibilityLabel={M.pay.approveA11y}
          accessibilityHint={M.pay.approveHint}
          accessibilityState={{disabled: approveDisabled}}
          onPress={() => void approveOcp(ocp)}>
          <Text style={S.primaryText}>{busy ? M.pay.signing : M.pay.approve}</Text>
        </Pressable>
        <Pressable testID="btn-sol-pay-cancel" style={S.secondaryBtn} onPress={reset} accessibilityRole="button" accessibilityLabel={M.common.cancel} accessibilityState={{disabled: false}}>
          <Text style={S.secondaryBtnText}>{M.common.cancel}</Text>
        </Pressable>
      </View>
    );
  }

  if (phase === 'ocp-done' && ocpDone) {
    // Two outcomes, one surface. A `note` means the money moved and the sale was NOT credited —
    // shown on the warn-tinted clock, never as a failure and never as paid, with the sentence that
    // names the transaction and says not to pay again. No retry affordance exists: the quote and
    // the transaction id are both spent (findings doc, "The loss path").
    return (
      <View style={S.center}>
        <View style={[S.check, ocpDone.note ? S.checkAlready : null]}>
          {ocpDone.note ? <IconClock size={44} color={C.brandInk}/> : <IconCheck size={44} color={C.brandInk}/>}
        </View>
        <Text testID="sol-pay-status" style={[S.paidText, ocpDone.note ? S.alreadyText : null]}>
          {ocpDone.note ? M.pay.sent(ocpDone.amount) : M.nfc.paidAmount(ocpDone.amount)}
        </Text>
        <Text style={S.paidSub}>{M.pay.toWho(ocpDone.who)}</Text>
        {ocpDone.note ? <Text testID="ocp-outcome" style={S.warnNote}>{ocpDone.note}</Text> : null}
        <Pressable testID="btn-sol-pay-done" style={[S.ghostBtn, S.ghostBtnMuted]} onPress={reset} accessibilityRole="button" accessibilityLabel={M.pay.newPayment} accessibilityState={{disabled: false}}>
          <Text style={S.ghostBtnText}>{M.pay.newPayment}</Text>
        </Pressable>
      </View>
    );
  }

  if (phase === 'review' && req) {
    // One-press rule (founder directive 2026-08-24): the camera path already signed — the "Pay
    // Now" gate was the press. This surface is the read-only sign status + the honest terminal
    // for a sign error (reason + Cancel back to the gated scan). NO sign button ever renders.
    return (
      <View style={S.center}>
        <Text style={S.label}>{M.pay.paying}</Text>
        <Text testID="sol-pay-amount" style={S.reviewAmount}>{M.pay.payAmount(fmtAsset(req.amt, decimals, unit))}</Text>
        <Text style={S.reviewTo}>{M.pay.toWho(claimedName || req.to)}</Text>
        {/* U-F5 twin of PayMode's review-payee: a merchant name alone is not verifiable — show the
            short destination under it. Without a name the primary line already carries the full
            base58 address (more precise than a short form), so no duplicate line. */}
        {claimedName ? <Text testID="sol-pay-payee" style={S.dim2}>{short(req.to)}</Text> : null}
        {claimedMemo ? <Text testID="sol-pay-memo" style={S.dim2}>{claimedMemo}</Text> : null}
        <Text style={S.dim2}>{M.pay.signsOffline}</Text>
        {err ? <Text testID="sol-pay-err" style={S.err}>{err}</Text> : null}
        {busy ? (
          <Text style={S.dim2}>{M.pay.signing}</Text>
        ) : (
          <Pressable testID="btn-sol-pay-cancel" style={S.secondaryBtn} onPress={reset} accessibilityRole="button" accessibilityLabel={M.common.cancel} accessibilityState={{disabled: false}}>
            <Text style={S.secondaryBtnText}>{M.common.cancel}</Text>
          </Pressable>
        )}
      </View>
    );
  }

  if (phase === 'qr' && solpayUri) {
    return (
      <View style={S.center}>
        <Text style={S.label}>{M.pay.showThisToMerchant}</Text>
        <View testID="sol-pay-qr" style={S.qrCard}><QrCode value={solpayUri} size={QR_SIZE} ecl="L" /></View>
        <Text style={S.amountBig}>{M.pay.amountToWho(fmtAsset(req!.amt, decimals, unit), claimedName || req!.to)}</Text>
        {/* U-F5: the sync auto-sign batch-skips the sign-status surface (straight to qr), so the
            short destination must live HERE — a merchant name alone is not verifiable. */}
        {claimedName ? <Text testID="sol-pay-payee" style={S.dim2}>{short(req!.to)}</Text> : null}
        <Text style={S.badgeOk}>{M.pay.signedOffline}</Text>
        <Text style={S.qrHint}>{M.pay.solOfflineSettles}</Text>
        {/* Trip Ready J4 — the SOL QR hand-off is ALWAYS offline-pending (no online branch), and
            the offlineQr truth ("the receiver's connection settles it") is exactly what this
            phase already says. Reading-zone mount (under the status line, above the confirm row).
            Same seen-key as the IC offline branch. */}
        <CoachTip tipKey="offlineQr" />
        <View style={S.confirmRow}>
          <Pressable
            testID="btn-sol-pay-handed"
            style={S.paidBtn}
            onPress={() => { setPhase('paid'); }}
            accessibilityRole="button"
            accessibilityLabel={M.pay.handedToMerchant}
            accessibilityHint={M.pay.handedOffHint}
            accessibilityState={{disabled: false}}>
            <Text style={S.paidBtnText}>{M.pay.handedToMerchant}</Text>
          </Pressable>
          <Pressable testID="btn-sol-pay-discard" style={S.notPaidBtn} onPress={reset} accessibilityRole="button" accessibilityLabel={M.common.cancel} accessibilityState={{disabled: false}}>
            <Text style={S.notPaidText}>{M.common.cancel}</Text>
          </Pressable>
        </View>
        <Pressable style={S.ghostBtn} onPress={() => share(solpayUri)} accessibilityRole="button" accessibilityLabel={M.pay.shareSignedPayment} accessibilityState={{disabled: false}}>
          <IconShare size={16} color={C.sub}/>
          <Text style={S.ghostBtnText}>{shared ? shareConfirmLabel(M.pay.copied) : M.pay.shareSignedCode}</Text>
        </Pressable>
      </View>
    );
  }

  // phase === 'paid'. `req` may be null if the payment was via NFC (the autoSign decoded the
  // request internally; SolPayMode's `req` state is only set on QR scan).
  const paidAmt = req ? fmtAsset(req.amt, decimals, unit) : null;
  const paidTo = req ? claimedName || req.to : null;
  return (
    <View style={S.center}>
      {/* P3 — SVG mark (was a '⋯' text glyph): the SOL pay outcome is ALWAYS the honest pending
          hand-off, so the clock reads on the warn-tinted checkAlready circle. */}
      <View style={[S.check, S.checkAlready]}><IconClock size={44} color={C.brandInk}/></View>
      <Text testID="sol-pay-status" style={[S.paidText, S.alreadyText]}>{M.pay.sent(paidAmt)}</Text>
      <Text style={S.paidSub}>{M.pay.solAwaiting(paidTo)}</Text>
      {/* Trip Ready J4 — the SOL paid phase is ALWAYS the honest pending hand-off, so the
          pendingOutcome truth applies on every visit until dismissed. Reading-zone mount (under
          the headline it explains). Same seen-key as IC. */}
      <CoachTip tipKey="pendingOutcome" />
      <Text style={S.dim2}>{M.pay.balanceUpdatesOnSettle}</Text>
      <Pressable testID="btn-sol-pay-done" style={[S.ghostBtn, S.ghostBtnMuted]} onPress={reset} accessibilityRole="button" accessibilityLabel={M.pay.newPayment} accessibilityState={{disabled: false}}>
        <Text style={S.ghostBtnText}>{M.pay.newPayment}</Text>
      </Pressable>
    </View>
  );
}

/** What the chain's own verdict on a broadcast signature means for a till payment. IC twin:
 *  PayMode's `icOutcomeToSend`, and it decides the same money-critical question: only a CONFIRMED
 *  transaction may be reported, because the provider verifies that identifier against the chain and
 *  spends the one attempt we get on it.
 *
 *  Its three verdicts must agree with what `sendSolForOcp` concludes from `sendSol`'s throw — the
 *  same facts, read off a status instead of an error string — which is why the definite on-chain
 *  failure shares that path's copy (`M.pay.ocp.transferFailed`) rather than getting its own. */
function solStatusToSend(status: SolanaSignatureStatus | null, signature: string): OcpSendResult {
  // The cluster has never heard of it. NOT proof of anything: a transaction the network accepted
  // can take slots to become visible, and a dropped one is indistinguishable from a slow one here.
  if (status === null) return {kind: 'unknown'};
  // Included and FAILED: the chain has decided, no lamports reached the merchant and none ever
  // will. Definitive, so the payer is told to pay again rather than warned not to.
  if (status.err != null) return {kind: 'refused', message: M.pay.ocp.transferFailed};
  if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
    return {kind: 'settled', txId: signature, reference: M.pay.ocp.ref.solTransaction(signature)};
  }
  // 'processed' only — one node, one fork deep. Not a verdict yet, and reporting it would spend the
  // one attempt on a transaction that can still be rolled back.
  return {kind: 'unknown'};
}
