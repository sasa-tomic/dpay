import {useEffect, useRef, useState} from 'react';
import {View, Text, Pressable, TextInput} from 'react-native';
import bs58 from 'bs58';
import {QrCode} from './QrCode';
import {InstructionPanel} from './InstructionPanel';
import {AtaSetupCard} from './AtaSetupCard';
import {S, amountFontFor} from '../styles';
import {C} from '../config/palette';
import {IconAlert, IconCheck, IconClock, IconScan, IconShare} from './icons';
import {POLL, QR_SIZE} from '../config/constants';
import {solSignCaveat, solSplSignGate, type SolMintStates, type SolPayGate} from '../config/assets';
import type {AssetId, Identity, NfcStatus, Txn} from '../lib/types';
import {fmtAssetCompact, short, toUnits} from '../lib/format';
import {parseDecimalToUnits} from '../lib/amount';
import {SOL_DECIMALS, SOL_UNIT} from '../solana/identity';
import {SOL_ATA_SETUP_MIN_LAMPORTS, SOL_FEE_LAMPORTS} from '../solana/spl';
import {solanaTokenInfo, solanaTokenOfMint} from '../solana/tokens';
import {classifyScan, coinDisplayOfScheme} from '../lib/scan';
import {sanitiseDisplayText} from '../lib/deepLink';
import type {OcpDetails, OcpOffer, OcpScan} from '../lib/opencryptopay';
import {ocpTimeRefusal, payAndReport, resolveOcpOffer, resolveOcpScan, type OcpResolveResult, type OcpSendResult, type OcpTarget} from '../services/opencryptopay';
import {saveTxNote} from '../services/txNotes';
import {addPendingPays, removePendingPays} from '../services/pendingPays';
import type {SelectableAsset} from '../config/assets';
import {type HomeCurrency, type RailBalances} from '../config/currency';
import {FundedSiblingRail} from './FundedSiblingRail';
import {RailLiquidityNote} from './RailLiquidityNote';
import type {CurrencyDescriptor} from '../config/catalog';
import {withTimeout} from '../lib/timeout';
import {SOL_SEND_TIMEOUT_MS, solSendTimeoutMs} from '../config/constants';
import {decodeSolReq, encodeSolPay} from '../solana/qr';
import type {SolReqV2} from '../solana/qr';
import {extractSignedTxParts} from '../solana/tx';
import {isSolReqV2Expired} from '../solana/payments';
import {parseSolanaPayUri, type SolanaPayRequest, type SolanaPayRefusal} from '../solana/payUri';
import {getSolSignatureStatus, sendSol, sendSolanaPay, signSolPayment, signSplPayment, type SolanaSignatureStatus} from '../solana';
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
import {beepPaymentComplete} from '../lib/beep';

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
 *
 * The camera also accepts a scanned Solana Pay URI (`solana:<recipient>?…`) — the open standard the
 * receive tab's own QR is built from (`solana/payUri.ts`). Unlike a solreq it is paid ONLINE (the
 * payer's phone broadcasts; there is no merchant phone to submit it), it is reviewed explicitly
 * (stranger-supplied values, never auto-signed), and the transfer carries the merchant's
 * `reference` pubkeys as instruction account keys and the optional `memo` as an SPL Memo
 * instruction — the matching mechanism the standard is built on (`sendSolanaPay`).
 */
export function SolPayMode({identity, online, nfcStatus, assets, catalog, homeCurrency, balances, solBalance, tokenBalance, tokenAtaAbsent, tokenBalances, payGate = 'none', solZero = false, solChecking = false, selectedToken, onSent, onSentToken, onShowSolAddress, onShowTokenAddress, onRecheckBalances, recheckBusy = false, ataSetupBusy = false, ataSetupErr = null, onCreateAta, subMode, onSubModeChange, sendPrefill = null, onSendPrefillConsumed, prefillScan, onPrefillScanConsumed, onScannedLink, onLockChange, onSwitchRail, onOpenAddressBook, onOpenReceipt, onWalletConnectPair}: {identity: Identity; online: boolean; nfcStatus: NfcStatus; assets: SelectableAsset[]; catalog: CurrencyDescriptor[]; homeCurrency: HomeCurrency | null; balances: RailBalances; solBalance: string; /** The SELECTED token's LAST-KNOWN balance — null when no balance was ever known (the send sheet gates an honest unknown; a known figure gates only a real over-spend, stale-ok, 2026-09-21). */ tokenBalance: string | null; tokenAtaAbsent: boolean; /** Per-mint token states for every visible SPL asset (the Wallet's per-mint hook states) — a scanned Solana Pay request names its OWN mint, which need not be the selected asset's. */ tokenBalances: SolMintStates; payGate?: SolPayGate; solZero?: boolean; solChecking?: boolean; selectedToken: string; onSent: () => void; /** Refreshes the token account that moved — names the request's mint when the sender knows it, else repolls every visible mint. */ onSentToken: (mint?: string | null) => void; onShowSolAddress: () => void; onShowTokenAddress: () => void; onRecheckBalances: () => void; recheckBusy?: boolean; ataSetupBusy?: boolean; ataSetupErr?: string | null; onCreateAta?: () => void; subMode: 'scan' | 'send'; onSubModeChange: (m: 'scan' | 'send') => void; sendPrefill?: {address: string; amount: string; label?: string; memo?: string} | null; onSendPrefillConsumed?: () => void; prefillScan?: string | null; onPrefillScanConsumed?: () => void; onScannedLink: (url: string) => void; onLockChange?: (locked: boolean) => void; onSwitchRail?: (id: AssetId) => void; onOpenAddressBook?: () => void; /** Open the shared TxnReceipt (Wallet root) for a finished send. */ onOpenReceipt?: (t: Txn) => void; /** A scanned `wc:` pairing URI routes here (the Wallet's pairing entry, the same one the `wc:` deep link lands in, plan W1 step 4). Absent = dropped (the direct-mount harnesses). */ onWalletConnectPair?: (uri: string) => void}) {
  const [phase, setPhase] = useState<'scan' | 'review' | 'qr' | 'paid' | 'ocp' | 'ocp-choose' | 'ocp-done' | 'spay-review' | 'spay-done'>('scan');
  const [req, setReq] = useState<SolReqV2 | null>(null);
  // An OpenCryptoPay merchant checkout the camera read, and its outcome. Same two states the IC rail
  // holds (PayMode) — the quote context, and the honest sentence for an outcome that is neither
  // paid nor failed — because both rails run the identical provider sequence.
  const [ocp, setOcp] = useState<OcpTarget | null>(null);
  const [ocpBusy, setOcpBusy] = useState(false);
  // IC twin: PayMode's `ocpChoice`. The checkout's menu, when the selected asset was not on it.
  const [ocpChoice, setOcpChoice] = useState<{details: OcpDetails; host: string; options: OcpOffer[]; declined: string} | null>(null);
  const [ocpDone, setOcpDone] = useState<{amount: string; who: string; note: string | null} | null>(null);
  // A checkout transfer whose outcome this rail could NOT resolve, plus the quote it was made against.
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
  // The last offline-QR hand-off's signature (its pending-outbox join key) — the discard button's
  // retraction path. Cleared by reset(); read only while the 'qr' phase still shows that code.
  const solpaySigRef = useRef('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // The disclosure a payment signed on NO fact owes its payer (`solSignCaveat`). It is a CAVEAT,
  // never a block: the sign gate refuses only a KNOWN-absent account, and a payer with no signal
  // must keep the ability to sign a payment that would settle. Null whenever the gate decided on a
  // fact — which is the common case, so the hand-off surface is unchanged for almost everyone.
  const [signCaveat, setSignCaveat] = useState<string | null>(null);
  // A tap arriving on the always-armed card takes over the scan screen; nfcKey re-arms after each.
  // The radio is usable only in the 'ready' state; every other state falls through to QR-only,
  // with the row below explaining which one and what to do about it.
  const nfcReady = nfcStatus === 'ready';
  const [nfcActive, setNfcActive] = useState(false);
  const [nfcKey, setNfcKey] = useState(0);
  // Pay tab = scan intent (founder 2026-10-09, same as IC PayMode): the camera and the HCE card
  // go live the moment the tab opens. reset() re-arms by returning to the scan phase; leaving
  // the scan sub-mode unmounts this component; rail/tab switches unmount it too.

  // Whether the send sheet holds an in-flight (or unresolved-terminal) transfer — reported up by
  // SolanaWithdrawSheet itself (onSendActiveChange). While true, the send sub-mode's offline and
  // fund gates DEFER: the 2026-09-21 live EURC attempt had the balance poll's 3-strike offline
  // flip REPLACE the sheet mid-send, so no terminal surface ever rendered and the send became
  // undiagnosable. An in-flight send owns its surface (CLAUDE.md founder requirement) — the gates
  // return the moment the sheet reports the send over. Reset when the sub-mode is left, so a
  // mid-send detour cannot pin a stale flag onto a fresh sheet.
  const [sendActive, setSendActive] = useState(false);
  // …and whether the sheet has RENDERED ITS REVIEW (sticky per send entry, reported up by
  // SolanaWithdrawSheet's onReviewShown). Once true, the OFFLINE strike gate below defers: the
  // 2026-09-21 attempt-#7 teardown had the 3-strike flip REPLACE a rendered review with "Sending
  // to an address needs a connection", destroying the surface the user was mid-flow on. Offline
  // may then only speak INSIDE the sheet (its own note); a genuinely-offline send fails honestly
  // at broadcast. The zero-funds gate keeps its own deferral rule (sendActive) — a KNOWN-zero
  // fact is a real fact about the money, not poll health.
  const [reviewShown, setReviewShown] = useState(false);
  useEffect(() => { if (subMode !== 'send') { setSendActive(false); setReviewShown(false); } }, [subMode]);

  // The CHECKOUT entry's SOL twin (same-surfaces rule): an OS-delivered checkout code
  // (`…/pl/?lightning=<LNURL…>`, the OpenCryptoPay QR a checkout prints) arrives as a prefilled SCAN —
  // it enters onNotARequest, the SAME classification a camera scan takes, so the SOL rail offers
  // the same explicit review a scanned checkout code gets here (never an auto-sign; a broken code the
  // same honest refusal). Guarded on phase==='scan' + cleared on take, like the IC rail's prefill.
  useEffect(() => {
    if (prefillScan == null) return;
    if (phase !== 'scan') return;
    onPrefillScanConsumed?.();
    onNotARequest(prefillScan);
    // Inline-closure identity is irrelevant under the guard + immediate clear.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillScan, phase]);
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
  // A scanned Solana Pay request (`solana:<recipient>?…` — the open standard the receive QR this
  // wallet shows is built from, `solana/payUri.ts`). Kept as the parser's verbatim request: the
  // review renders sanitised views of its text params, but the transfer itself must carry the
  // merchant's exact reference keys and memo bytes, so nothing display-side is written back.
  const [spay, setSpay] = useState<SolanaPayRequest | null>(null);
  // The amount the review acts on. Seeded from the URI when it carried one; otherwise it is the
  // payer's own entry (the spec makes `amount` optional — this wallet's own amount-less receive
  // QR read back must reach review, not die at a missing number).
  const [spayAmount, setSpayAmount] = useState('');
  // The outcome of a Solana Pay transfer: `null` note = confirmed, a note = accepted-but-unconfirmed
  // (the broadcast succeeded, the confirmation poll did not — the signature is the record).
  const [spayDone, setSpayDone] = useState<{amount: string; who: string; signature: string; note: string | null} | null>(null);

  // U-F1 — visible confirmation after the share resolves (the DepositSheet copy pattern). Dismissed
  // sheets leave the label honest.
  const {shared, share} = useShareFeedback();

  // Lock the idle asset selection while a SOL payment is in flight. Every non-scan phase holds a
  // captured, immutable snapshot the user must not lose to an asset switch (which unmounts this
  // component): the SolReqV2 of an offline pay, or the live quote of a merchant checkout — and, the
  // same rule, an in-flight send sheet's terminal surface (`sendActive`, 2026-09-21): an asset
  // switch would tear the sheet down exactly like the offline gate did.
  const locked = phase !== 'scan' || sendActive;
  useReportLock(onLockChange, locked);

  // Resolve a checkout transfer this rail left indefinite. IC twin: PayMode's claim effect — same
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
          // one action that can still pay this checkout.
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

  // Token facts of the SELECTED asset, from the registry (never a USDC-shaped ternary): the send
  // form, the fund gates and the ATA gate all speak the selected token's own symbol/mint.
  // `selectedToken` remains as the native-vs-SPL discriminator ('SOL' ⇔ mint null).
  const isNativeSelected = selectedToken === 'SOL';
  const selectedMint = isNativeSelected ? null : solanaTokenInfo(selectedToken)?.mint ?? null;
  const selectedSymbol = isNativeSelected ? SOL_UNIT : selectedToken;

  // The two lines every fund-blocked surface below pairs, in this order, because together they
  // answer "what does this rail cost to use, and what could I use instead?":
  //   • `railNote` — the BLOCKED rail's own catalogued liquidity statement (warn tone ⇒ renders
  //     exactly for a thin rail; untiered SOL/USDC show nothing).
  //   • `fundedElsewhere` — the funded-account pointer (X1). Null on its own unless some OTHER
  //     account of the user's holds money; widened on 2026-09-08 past the home-currency group, so
  //     a SOL gate that used to point nowhere can now name a funded ckUSDC — or the ∂100 practice
  //     balance a brand-new wallet holds and no screen ever mentioned. `purpose` is what keeps
  //     practice money off the SEND surface, where it has no route out of the wallet.
  // The switch is a USER gesture — `onSwitchRail` is Wallet's `payRailSelect` under
  // `shouldAllowUserSelect`; Wallet passes no switch while the selection is locked, and the
  // pointer then names the account without the button.
  const siblingAssetId: AssetId = isNativeSelected ? 'solana:SOL' : `solana:${selectedToken}`;
  const gatedAsset = assets.find(a => a.id === siblingAssetId) ?? null;
  const railNote = gatedAsset != null ? <RailLiquidityNote asset={gatedAsset} tone="warn" /> : null;
  const fundedElsewhere = (purpose: 'pay' | 'send') => (
    <FundedSiblingRail
      homeCurrency={homeCurrency}
      assets={assets}
      balances={balances}
      selectedAssetId={siblingAssetId}
      purpose={purpose}
      onSwitch={onSwitchRail}
    />
  );

  // "Send to address" sub-mode: render the on-chain send flow INLINE (the SolanaWithdrawSheet body).
  // The toggle above lets the user flip back to "Scan to pay". The sheet is inline-only (no overlay
  // chrome — the tab body provides the surface). Mirrors the IC PayMode "Send to address" sub-mode.
  // Sits BELOW the useState so React's Rules of Hooks hold across sub-mode flips (the payer's
  // phase state survives a Send detour without re-mounting).
  if (subMode === 'send') {
    // The send form spends the SELECTED token — its refresh names the selected mint.
    const sendBalance = isNativeSelected ? solBalance : tokenBalance;
    const sendOnSent = isNativeSelected ? onSent : () => onSentToken(selectedMint);
    // Offline gate — IC twin: PayMode's `offlinePanel`, same reason. This rail broadcasts straight
    // to a Solana RPC from THIS phone, so airplane mode blocks an address send outright while
    // scan-to-pay keeps working (the payer signs offline against the merchant's blockhash and the
    // merchant broadcasts). Checked BEFORE the funds gate: a balance read while offline is stale.
    // `sendActive` defers BOTH gates while a transfer is in flight or its terminal surface is up
    // (2026-09-21): a mid-send offline flip used to REPLACE this sheet — no terminal surface, an
    // undiagnosable send. The gates apply again the moment the sheet reports the send over.
    // `reviewShown` extends the deferral to the OFFLINE gate only, from the first rendered
    // review: a rendered review must be able to complete (attempt #7 — the strike gate tore the
    // sheet down across 4 blind presses). The offline state shows as the sheet's own note.
    if (!online && !sendActive && !reviewShown) {
      return (
        <View style={S.centerTop}>
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
    // Deferred while `sendActive`, like the offline gate above — a poll that lands a known-zero
    // fact (or flips `online`) mid-send must not replace the sheet's terminal surface.
    if (!sendActive && payGate !== 'none' && payGate !== 'token-absent') {
      const isSol = payGate === 'sol-zero';
      return (
        <View style={S.centerTop}>
          {toggle}
          <InstructionPanel
            testID="sol-send-fund"
            title={M.pay.fundTitle(isSol ? 'SOL' : selectedSymbol)}
            body={isSol
              ? M.pay.fundBody('SOL', 'send')
              : M.pay.fundBodyToken(selectedSymbol)}
            primaryLabel={M.pay.showMyAddress(isSol ? 'SOL' : selectedSymbol)}
            onPrimary={isSol ? onShowSolAddress : onShowTokenAddress}
            secondaryLabel={!isSol && solZero ? M.pay.showMyAddress('SOL') : undefined}
            onSecondary={!isSol && solZero ? onShowSolAddress : undefined}
            onRecheck={onRecheckBalances}
            recheckBusy={recheckBusy}
          />
          {railNote}
          {fundedElsewhere('send')}
          {err ? <Text testID="sol-pay-err" style={S.err}>{err}</Text> : null}
        </View>
      );
    }
    return (
      <View style={S.centerTop}>
        {toggle}
        <SolanaWithdrawSheet
          identity={identity}
          token={selectedToken}
          mint={selectedMint}
          balance={sendBalance}
          online={online}
          onReviewShown={setReviewShown}
          prefill={scannedAddress != null ? {address: scannedAddress, amount: ''} : sendPrefill}
          onPrefillConsumed={() => { if (scannedAddress != null) setScannedAddress(null); else onSendPrefillConsumed?.(); }}
          ataAbsent={tokenAtaAbsent}
          solBalance={solBalance}
          solChecking={solChecking}
          ataSetupBusy={ataSetupBusy}
          ataSetupErr={ataSetupErr}
          onCreateAta={onCreateAta}
          onShowSolAddress={onShowSolAddress}
          onOpenAddressBook={onOpenAddressBook}
          onSent={sendOnSent}
          onClose={() => onSubModeChange('scan')}
          onSendActiveChange={setSendActive}
          onOpenReceipt={onOpenReceipt}
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
        refuseScan(M.pay.requestExpired);
        return;
      }
      // Per-request-mint absent-ATA gate (OPEN_ISSUES 6(a)): the solreq names its OWN mint, which
      // need not be the selected asset's — a KNOWN-absent mint would sign pure against an ATA
      // that doesn't exist and the merchant's broadcast would be REJECTED (dead QR). Refuse at
      // the scan, by name, exactly like startSpay's absent refusal; unknown mints (dpay carries
      // no registry entry) get the same honest unknown-mint copy. Every UNCONFIRMED state fails
      // open — see solSplSignGate.
      const signGate = solSplSignGate(r.mint, tokenBalances);
      if (signGate === 'unregistered' || signGate === 'absent') {
        setReq(null);
        refuseScan(
          signGate === 'unregistered'
            ? M.pay.spay.unknownMint(r.mint ?? '')
            : M.errors.solana.senderNoTokenAccount(solanaTokenOfMint(r.mint) ?? r.mint ?? ''),
        );
        return;
      }
      // …and when it failed OPEN, the payer is told so. The caveat rides the signed payment to the
      // hand-off surface below — the one screen this rail shows while the payment is still in the
      // payer's hands (`approve` is synchronous, so the 'review' phase never paints on this path).
      setSignCaveat(solSignCaveat(signGate, r.mint));
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
  // not-sendable branch here. A `solana:` URI is the ONE verdict the two rails answer differently:
  // here it is this rail's own standard and starts the Solana Pay review; the IC rail refuses it
  // by name with the switch instruction.
  function onNotARequest(raw: string) {
    const what = classifyScan(raw);
    if (what.kind === 'link') { setErr(null); onScannedLink(raw.trim()); return; }
    if (what.kind === 'opencryptopay') { void startOcp(what.ocp); return; }
    if (what.kind === 'coin-request') {
      const named = coinDisplayOfScheme(what.scheme);
      refuseScan(M.pay.scannedCoinRequest(named.coin, named.uri));
      return;
    }
    if (what.kind === 'solana-pay') { startSpay(raw); return; }
    if (what.kind === 'walletconnect') {
      // A WC pairing URI asks dpay (the WALLET) to connect - never this rail's payer. Routed to
      // the Wallet's pairing entry; absent handler (harness) = dropped.
      if (onWalletConnectPair) { setErr(null); onWalletConnectPair(raw.trim()); }
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

  // The SOLANA PAY entry — a scanned `solana:` URI, the open standard the receive tab's own QR is
  // built from. Refuse-early discipline (opencryptopay.ts): every unusable code is refused BY NAME
  // on the scan surface with a way out, and only a request this rail can actually pay reaches the
  // review. Unlike a solreq this transfer is BROADCAST BY THE PAYER (the merchant is not standing
  // there to submit it), so online is a scan-time gate; and it is reviewed explicitly — every
  // value on the screen came from a code a stranger printed, the one-press rule never reaches it.
  function startSpay(raw: string) {
    const parsed = parseSolanaPayUri(raw);
    if (!parsed.ok) { refuseScan(spayRefusalMessage(parsed.reason, parsed.param ?? '')); return; }
    const request = parsed.request;
    if (!online) { refuseScan(M.pay.spay.offline); return; }
    // The registry gate: this rail pays native SOL and any REGISTERED SPL mint (USDC, EURC —
    // `sendSolanaPay` re-asserts the same allowlist at the engine). A mint outside it is refused
    // BY NAME with the pubkey, exactly as before — the codec's structural checks said the URI is
    // well-formed; this says whether the wallet can actually pay it.
    if (request.splToken !== null && solanaTokenOfMint(request.splToken) === null) {
      refuseScan(M.pay.spay.unknownMint(request.splToken));
      return;
    }
    // The registry gate's second half: an SPL request needs a token account of THAT mint to debit
    // from (the request's own mint — not necessarily the selected asset's), and a KNOWN-absent one
    // is refusable the moment the code is read — the same fail-closed check sendSpl makes at the
    // RPC, surfaced at the scan where the way out (one-tap setup in Receive) is nameable.
    if (request.splToken !== null && tokenBalances[request.splToken]?.status === 'absent') {
      refuseScan(M.errors.solana.senderNoTokenAccount(solanaTokenOfMint(request.splToken) ?? request.splToken));
      return;
    }
    if (request.amount !== null) {
      const resolved = parseDecimalToUnits(request.amount, request.splToken === null ? SOL_DECIMALS : solanaTokenInfo(solanaTokenOfMint(request.splToken) ?? '')?.decimals ?? SOL_DECIMALS);
      if (!resolved.ok || resolved.raw === '0') { refuseScan(M.pay.spay.badAmount); return; }
    }
    setSpay(request);
    setSpayAmount(request.amount ?? '');
    setErr(null);
    setPhase('spay-review');
  }

  /** The four-locale copy for a parser refusal, one key per code — the payer always gets the
   *  broken part and the way out, never the parser's internals. */
  function spayRefusalMessage(reason: SolanaPayRefusal, param: string): string {
    switch (reason) {
      case 'malformed-uri': return M.pay.spay.badUri;
      case 'bad-recipient': return M.pay.spay.badRecipient;
      case 'bad-amount': return M.pay.spay.badAmount;
      case 'bad-spl-token': return M.pay.spay.badSplToken;
      case 'bad-reference': return M.pay.spay.badReference;
      case 'unexpected-parameter': return M.pay.spay.unexpectedParam(param);
      case 'memo-too-long': return M.pay.spay.memoTooLong;
    }
  }

  // Approve on a Solana Pay review: the payer's phone builds the transfer (reference keys attached
  // to the instruction, memo as its own SPL Memo instruction), signs locally, broadcasts, and
  // confirms. The `onBroadcast` split is the OCP one (sendSolForOcp): a throw before the network
  // accepted anything is a plain refusal, a throw after it is UNKNOWN — the money may be landing,
  // so the outcome screen shows the signature as the record instead of a retry affordance.
  async function approveSpay(request: SolanaPayRequest) {
    const isSol = request.splToken === null;
    // The request's OWN token (registry truth — startSpay already refused foreign mints), not the
    // selected asset's: a USDC scan is payable while EURC is selected.
    const spayToken = isSol ? null : solanaTokenOfMint(request.splToken!);
    const decimals = isSol ? SOL_DECIMALS : solanaTokenInfo(spayToken ?? '')?.decimals ?? SOL_DECIMALS;
    const unit = isSol ? SOL_UNIT : spayToken ?? request.splToken!;
    const raw = toUnits(spayAmount, decimals);
    if (raw === '0') { setErr(M.pay.spay.badAmount); return; }
    const rawAmount = BigInt(raw);
    // The same fee-inclusive gate the review renders, re-asserted at the press: the balance prop
    // can refresh between render and tap, and this is the last point before irreversible money.
    // An unknown token balance (loading/error) gates as zero — fail closed.
    if (isSol) {
      if (BigInt(solBalance) < rawAmount + SOL_FEE_LAMPORTS) { setErr(M.pay.notEnoughBalance); return; }
    } else {
      if (BigInt(tokenBalances[request.splToken ?? '']?.amount ?? '0') < rawAmount) { setErr(M.pay.notEnoughBalance); return; }
    }
    const who = sanitiseDisplayText(request.label ?? '') || request.recipient;
    // TOTAL DEBIT for the done screen: native SOL adds the network fee (the number the wallet
    // actually moved); a spl-token transfer spends its fee in SOL, a different unit — the token
    // amount is the honest total for its own row.
    const amount = fmtAssetCompact((isSol ? rawAmount + SOL_FEE_LAMPORTS : rawAmount).toString(), decimals, unit);
    const broadcast: {sig: string | null} = {sig: null};
    const {signal, cancel} = withTimeout(solSendTimeoutMs());
    setBusy(true);
    setErr(null);
    try {
      const sig = await sendSolanaPay(identity.secretHex, {recipient: request.recipient, splToken: request.splToken, amount: rawAmount, references: request.references, memo: request.memo}, signal, s => { broadcast.sig = s; });
      // Payer-side annotation (services/txNotes): the signature IS the row's join key (a SOL row's
      // identity), so record the URI's label/message the moment the send hands it back — the ONLY
      // place the association exists. Never re-derived on read: parsing on-chain memos for
      // incoming rows would re-fetch every transaction per history tick (flow 160's forbidden
      // path). `message` is the human text the payer saw; `memo` is the same text when the URI
      // carried only the on-chain memo — one message is saved, never both. Founder rule
      // 2026-09-14: native SOL also carries the gross (amount + fee = the exact total debit) +
      // the fee so the log row headlines what the done screen showed; SPL rows are their own
      // token truth (the fee is separate-asset gas) — nothing to annotate.
      void saveTxNote(identity.publicHex, {k: sig, who: sanitiseDisplayText(request.label ?? '') || undefined, msg: sanitiseDisplayText(request.message ?? '') || sanitiseDisplayText(request.memo ?? '') || undefined, ...(isSol ? {gross: (rawAmount + SOL_FEE_LAMPORTS).toString(), fee: SOL_FEE_LAMPORTS.toString()} : {})}, Date.now());
      // Refresh the account that actually moved — the REQUEST's mint, not the selection's.
      if (isSol) onSent(); else onSentToken(request.splToken);
      beepPaymentComplete(); // broadcast CONFIRMED — the only spay-done variant that beeps
      setSpayDone({amount, who, signature: sig, note: null});
      setPhase('spay-done');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('solana pay send failed:', msg);
      if (broadcast.sig !== null) {
        // The network accepted the transaction; only the confirmation is missing. Definitively
        // NOT-sent is off the table, so this is the honest pending screen with the signature.
        // Same gross/fee carry as the settled save above (founder rule 2026-09-14).
        void saveTxNote(identity.publicHex, {k: broadcast.sig, who: sanitiseDisplayText(request.label ?? '') || undefined, msg: sanitiseDisplayText(request.message ?? '') || sanitiseDisplayText(request.memo ?? '') || undefined, ...(isSol ? {gross: (rawAmount + SOL_FEE_LAMPORTS).toString(), fee: SOL_FEE_LAMPORTS.toString()} : {})}, Date.now());
        // Founder requirement 2026-09-15 #1/#3 — an unconfirmed broadcast is a PENDING PAYMENT
        // exactly like the offline QR hand-off: the outbox record (join key = the signature) puts
        // the row in Home/Ledger and the gross into the offline subtraction until history
        // reconciles the same signature. kind 'sol-qr' — the SOL rail's QR-side flow.
        addPendingPays(identity.publicHex, [{k: broadcast.sig, assetId: `solana:${unit}`, currency: null, wireAmount: rawAmount.toString(), ...(isSol ? {fee: SOL_FEE_LAMPORTS.toString(), gross: (rawAmount + SOL_FEE_LAMPORTS).toString()} : {}), ...(sanitiseDisplayText(request.label ?? '') ? {who: sanitiseDisplayText(request.label ?? '')} : {}), ...(sanitiseDisplayText(request.message ?? '') || sanitiseDisplayText(request.memo ?? '') ? {msg: sanitiseDisplayText(request.message ?? '') || sanitiseDisplayText(request.memo ?? '')} : {}), ts: Date.now(), kind: 'sol-qr'}]);
        if (isSol) onSent(); else onSentToken(request.splToken);
        setSpayDone({amount, who, signature: broadcast.sig, note: M.pay.spay.pendingNote});
        setPhase('spay-done');
      } else {
        setErr(isSolTransactionFailed(msg) ? M.pay.ocp.transferFailed : friendlySolError(msg));
      }
    } finally {
      setBusy(false);
      cancel();
    }
  }

  // The OPENCRYPTOPAY entry — the IC rail's twin (PayMode.startOcp), running the SAME resolution so
  // a checkout code behaves identically whichever asset is selected (CLAUDE.md same-surfaces rule).
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
    const id: AssetId = siblingAssetId;
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

  /** Where BOTH checkout paths end — the direct one and the one the payer picked off the menu. IC twin:
   *  PayMode's `landOcp`, same shape so a checkout behaves identically on either rail. */
  function landOcp(out: OcpResolveResult, declined: string) {
    // Back to the scanner on any refusal, including one reached FROM the menu: leaving the phase on
    // 'ocp-choose' would strand the payer on a list they can no longer act on.
    if (out.kind === 'refused') { setOcpChoice(null); setPhase('scan'); refuseScan(out.message); return; }
    if (out.kind === 'choose') { setOcpChoice({...out, declined}); setPhase('ocp-choose'); return; }
    // Fail closed on anything but native SOL: the send below is a System Program transfer, so a
    // token target would move SOL against a token price. The resolver already refuses Solana
    // token targets by name (its URI does not say which token account to pay); this is the second
    // lock on it, still naming the token it refused.
    if (out.target.assetId !== 'solana:SOL') {
      const sym = out.target.assetId.startsWith('solana:') ? out.target.assetId.slice('solana:'.length) : String(out.target.assetId);
      setOcpChoice(null); setPhase('scan'); refuseScan(M.pay.ocp.solanaTokenUnsupported(sym)); return;
    }
    setOcp(out.target);
    setPhase('ocp');
  }

  /** The payer picked an asset off the checkout's menu. IC twin: PayMode's `chooseOcpOffer`. `Date.now()`
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
    const {signal, cancel} = withTimeout(solSendTimeoutMs());
    try {
      const sig = await sendSol(identity.secretHex, target.to, BigInt(target.rawAmount), signal, s => { broadcast.sig = s; });
      // Same payer-side annotation as approveSpay, keyed by the signature (this rail signs no
      // memo to key by): a checkout's claimed name AND claimed note are the context the rail-side
      // send still has at hand — the IC seam saves the same pair keyed by the on-chain memo.
      // Founder rule 2026-09-14: the gross (amount + fee = the payer's exact debit) + the fee
      // ride along so the log row headlines the price the review showed.
      void saveTxNote(identity.publicHex, {k: sig, who: target.details.claimedMerchantName || undefined, msg: target.details.claimedNote || undefined, gross: (BigInt(target.rawAmount) + SOL_FEE_LAMPORTS).toString(), fee: SOL_FEE_LAMPORTS.toString()}, Date.now());
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

  // Approve on an OpenCryptoPay checkout: the funds move first and the provider is told exactly once,
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
    // TOTAL DEBIT for the done screen — amount + network fee, compact (matches the review).
    const amount = fmtAssetCompact((BigInt(target.rawAmount) + SOL_FEE_LAMPORTS).toString(), SOL_DECIMALS, SOL_UNIT);
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
      // Device-saved annotation (services/txNotes): the request's claimed name + human memo are
      // known only on this device and only now, and neither survives the QR hand-off. Join key =
      // the signature this device just produced (the SOL key the settling row will carry),
      // extracted exactly as SolNfcTap binds its receipt. Sanitised for display only — the signed
      // bytes above stay canonical (the merchant re-derives the request to verify the payment).
      // Founder rule 2026-09-14: a netted native-SOL request carries the gross (wire + fee = the
      // payer's exact debit, the same sum the hand-off screen shows) + the fee; SPL requests
      // never net (separate-asset gas) — nothing to annotate.
      const parts = extractSignedTxParts(solpay.tx);
      const sig = parts != null ? bs58.encode(parts.signature) : '';
      void saveTxNote(identity.publicHex, {k: sig, who: sanitiseDisplayText(r.name) || undefined, msg: sanitiseDisplayText(r.memo) || undefined, ...(r.cur === 'SOL' ? {gross: (BigInt(r.amt) + SOL_FEE_LAMPORTS).toString(), fee: SOL_FEE_LAMPORTS.toString()} : {})}, Date.now());
      // Founder requirements 2026-09-15 #1/#3 — the offline hand-off writes its pending-outbox
      // record NOW (the envelope left the payer's hands the moment the QR renders — same rule as
      // PayMode's fall-through, and for the same crash-safety reason). Join key = the signature
      // (identical to the note's and to the settling SOL history row's identity); `ts` starts the
      // subtraction clock that the next successful balance read retires. The discard button below
      // is the explicit user retraction that removes it again. No signature extractable → no key
      // → nothing worth recording (the note above makes the same empty-key no-op).
      if (sig !== '') {
        solpaySigRef.current = sig;
        addPendingPays(identity.publicHex, [{k: sig, assetId: `solana:${r.cur}`, currency: null, wireAmount: r.amt, ...(r.cur === 'SOL' ? {fee: SOL_FEE_LAMPORTS.toString(), gross: (BigInt(r.amt) + SOL_FEE_LAMPORTS).toString()} : {}), ...(sanitiseDisplayText(r.name) ? {who: sanitiseDisplayText(r.name)} : {}), ...(sanitiseDisplayText(r.memo) ? {msg: sanitiseDisplayText(r.memo)} : {}), ts: Date.now(), kind: 'sol-qr'}]);
      }
      setSolpayUri(encodeSolPay(solpay));
      setPhase('qr');
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function reset() { setReq(null); setSolpayUri(null); solpaySigRef.current = ''; setOcp(null); setOcpChoice(null); setOcpDone(null); setOcpClaim(null); setSpay(null); setSpayAmount(''); setSpayDone(null); setErr(null); setSignCaveat(null); setPhase('scan'); }

  // NFC card outcome: success/pending → paid (awaiting merchant confirmation); declined → back to scan.
  function onNfcOutcome(outcome: 'success' | 'pending' | 'declined') {
    if (outcome === 'declined') { reset(); return; }
    setPhase('paid');
  }

  // The in-flight solreq's own token (registry truth — a signed request carries its cur literal,
  // whatever the current selection is).
  const decimals = req != null && req.cur !== 'SOL' ? solanaTokenInfo(req.cur)?.decimals ?? SOL_DECIMALS : SOL_DECIMALS;
  const unit = req != null && req.cur !== 'SOL' ? req.cur : SOL_UNIT;
  // The merchant's CLAIMED name and note, from a code a stranger printed or a phone that tapped
  // this one. Same threat and same helper as the IC wire request (`wireRequestToIntent`), a payment
  // link's `label`/`memo` (`clampLinkText`) and a checkout's merchant name (`claimedMerchantNameOf`):
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
    // ── WHAT GATES THE CAMERA, AND WHAT GATES THE SIGNATURE (X3, 2026-09-08) ──────────────────
    //
    // IC twin: the identical rule, stated in full in PayMode. THE CAMERA IS NEVER GATED ON FUNDS.
    // A merchant's `solreq:v2` names its OWN currency and mint — which need not be the selected
    // asset's — so the selection says nothing about whether the request is payable, and gating the
    // lens on it stopped a payer from even READING a code they could have settled. The camera and
    // the HCE card go live the moment the pay tab opens (founder 2026-10-09): opening the tab IS
    // the scan intent.
    //
    // THE SIGNATURE IS GATED PER REQUEST, in `onScan`/`SolNfcTap`, on the REQUEST's own mint:
    // `solSplSignGate` refuses before signing when that mint's token account is KNOWN absent (a
    // pure offline sign against a non-existent ATA is a dead QR the payer cannot see), and every
    // UNCONFIRMED state fails open per the offline-first rule.
    //
    // THE FUND AND SETUP INSTRUCTIONS ARE NOT DELETED, THEY ARE DEMOTED: they ride BELOW the live
    // camera, so the 2026-08-16 funding funnel and the one-tap ATA create both keep their entry
    // point without standing in front of the lens. The send sub-mode above keeps its
    // full-replacement gate, because there is no request to read there.
    //
    // loading/error/unavailable never produce a gate at all (the Wallet's `solPayGate` fails OPEN
    // — offline-first rule).
    const isSolGate = payGate === 'sol-zero';
    const fundIdle = payGate === 'sol-zero' || payGate === 'token-zero' ? (
      <InstructionPanel
        testID="sol-pay-fund"
        title={M.pay.fundTitle(isSolGate ? 'SOL' : selectedSymbol)}
        body={isSolGate
          ? M.pay.fundBody('SOL', 'pay')
          : M.pay.fundBodyToken(selectedSymbol)}
        primaryLabel={M.pay.showMyAddress(isSolGate ? 'SOL' : selectedSymbol)}
        onPrimary={isSolGate ? onShowSolAddress : onShowTokenAddress}
        secondaryLabel={!isSolGate && solZero ? M.pay.showMyAddress('SOL') : undefined}
        onSecondary={!isSolGate && solZero ? onShowSolAddress : undefined}
        onRecheck={onRecheckBalances}
        recheckBusy={recheckBusy}
      />
    ) : payGate === 'token-absent' ? (
      // Token selected + its account KNOWN absent: the one-tap setup card, with the fund-SOL
      // secondary when SOL is also zero. Setup first, then pay — but the lens stays open, because
      // a request naming SOL or any other mint is perfectly payable from here.
      <AtaSetupCard
        surface="create"
        asset={selectedSymbol}
        instrTestID="sol-pay-ata-instructions"
        btnTestID="btn-sol-pay-ata-create"
        buttonLabel={M.pay.createTokenAccount(selectedSymbol)}
        hasSol={BigInt(solBalance) >= SOL_ATA_SETUP_MIN_LAMPORTS}
        checkingSol={solChecking}
        busy={ataSetupBusy}
        err={ataSetupErr}
        onCreateAta={onCreateAta}
        onShowSolAddress={onShowSolAddress}
      />
    ) : null;
    return (
      <View style={S.center}>
        {toggle}
        {/* Pay tab = scan intent (same rule as IC PayMode, founder 2026-10-09): the camera and
            the NFC card go live the moment the tab opens — card in the background (if ready), QR
            live, no press first. No setup needed in v2. */}
        {nfcReady && DpaySolNfc ? (
          <SolNfcTap
            key={nfcKey} role="card" identity={identity}
            tokenBalances={tokenBalances}
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
              <QrScanner key={scanKey} onScan={onScan} />
              {fundIdle}
              {fundIdle != null ? railNote : null}
              {fundIdle != null ? fundedElsewhere('pay') : null}
            </View>
            {/* The checkout lookup is two network reads and can take tens of seconds. IC twin:
                PayMode's `ocp-checking`. */}
            {ocpBusy ? <Text testID="ocp-checking" style={S.dim2}>{M.pay.ocp.checkingCheckout}</Text> : null}
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
        // This rail spends lamports, so every option it can take is denominated in SOL. The label
        // is the TOTAL DEBIT (amount + network fee, fee constant and known here) — a checkout prices
        // the fee in, so the option reads the shelf price, not wire-minus-fee.
        labelOf={o => fmtAssetCompact((BigInt(o.rawAmount) + SOL_FEE_LAMPORTS).toString(), SOL_DECIMALS, SOL_UNIT)}
        onPick={o => void chooseOcpOffer(o)}
        onCancel={reset}
      />
    );
  }

  if (phase === 'ocp' && ocp) {
    // A merchant checkout: reviewed and approved explicitly, NEVER auto-signed. The one-press rule does
    // not reach here — it covers a dpay request whose amount and payee came off a dpay QR, while
    // every value on this screen came from a provider the wallet has no relationship with. Mirrors
    // the IC rail's checkout review (PayMode), down to the testIDs.
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
        {/* No screen title: it sat directly above "Pay <amount>" with Approve underneath, and the
            IC rail's review dropped its own for the same reason (founder, 2026-09-09). */}
        {/* TOTAL DEBIT (amount + network fee — the fee is a known constant on this rail, so the
            headline IS the shelf price at a checkout; founder rule 2026-09-13). Compact, like every
            glanceable money surface. */}
        <Text testID="sol-pay-amount" style={S.reviewAmount}>{M.pay.payAmount(fmtAssetCompact((BigInt(ocp.rawAmount) + SOL_FEE_LAMPORTS).toString(), SOL_DECIMALS, SOL_UNIT))}</Text>
        <Text style={S.reviewTo}>{M.pay.toWho(ocp.details.claimedMerchantName ?? ocp.host)}</Text>
        {/* The FULL destination address, never shortened: the provider chose it, so it is the one
            thing on this screen the payer can actually check. */}
        <Text testID="sol-pay-payee" style={S.dim2}>{ocp.to}</Text>
        <OcpQuoteLines
          host={ocp.host}
          requested={ocp.details.requestedAmount}
          payableUntil={ocp.payableUntil}
          onTooLate={() => setErr(ocpTimeRefusal(ocp, Date.now()))}
        />
        {/* The checkout's claimed note — what the charge is for — on the same line the IC rail shows
            it (`review-memo`) and this rail's own link path shows a memo (`sol-pay-memo` in the
            review phase): one surface per question, whichever rail pays. Renders nothing when the
            checkout sent none. */}
        {ocp.details.claimedNote ? <Text testID="sol-pay-memo" style={S.dim2}>{ocp.details.claimedNote}</Text> : null}
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
          <Text style={[S.primaryText, approveDisabled && S.disabledText]}>{busy ? M.pay.signing : M.pay.approve}</Text>
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

  if (phase === 'spay-review' && spay) {
    // A scanned Solana Pay request: reviewed and approved explicitly, NEVER auto-signed — the same
    // rule as the OCP checkout review above (every value came from a code a stranger printed; the
    // one-press rule covers only dpay's own solreq QRs). The amount is fixed text when the URI
    // carried one, an entry field when it did not (the spec makes it optional, and this wallet's
    // own receive QR emits it without one — reading that QR back is the flow this screen serves).
    const isSol = spay.splToken === null;
    // The request's OWN token (registry truth — startSpay already refused foreign mints).
    const spayToken = isSol ? null : solanaTokenOfMint(spay.splToken);
    const decimals = isSol ? SOL_DECIMALS : solanaTokenInfo(spayToken ?? '')?.decimals ?? SOL_DECIMALS;
    const unit = isSol ? SOL_UNIT : spayToken ?? spay.splToken ?? '';
    const raw = toUnits(spayAmount, decimals);
    const amountValid = raw !== '0';
    const balance = isSol ? BigInt(solBalance) : BigInt(tokenBalances[spay.splToken ?? '']?.amount ?? '0');
    // SOL must cover the transfer AND the fee — the same fee-inclusive gate the checkout review uses.
    const insufficient = !amountValid || (isSol ? balance < BigInt(raw) + SOL_FEE_LAMPORTS : balance < BigInt(raw));
    const spayLabel = sanitiseDisplayText(spay.label ?? '');
    const spayMessage = sanitiseDisplayText(spay.message ?? '');
    const approveDisabled = busy || !!err || !amountValid || insufficient;
    return (
      <View style={S.center}>
        {spay.amount !== null ? (
          // TOTAL DEBIT where the fee shares the asset (native SOL); a spl-token transfer's fee is
          // SOL — different unit — so its review shows the token amount. Compact either way.
          <Text testID="sol-pay-amount" style={S.reviewAmount}>{M.pay.payAmount(fmtAssetCompact((isSol ? BigInt(raw) + SOL_FEE_LAMPORTS : BigInt(raw)).toString(), decimals, unit))}</Text>
        ) : (
          <>
            <Text style={S.dim2}>{M.pay.spay.amountLabel}</Text>
            <TextInput
              testID="sol-spay-amount-input"
              style={[S.amountInput, amountFontFor(spayAmount)]}
              value={spayAmount}
              onChangeText={setSpayAmount}
              keyboardType="decimal-pad"
              accessibilityLabel={M.pay.spay.amountLabel}
            />
          </>
        )}
        <Text style={S.reviewTo}>{M.pay.toWho(spayLabel || spay.recipient)}</Text>
        {/* The FULL destination, never shortened (the checkout review's discipline): for a spl-token
            request this is the recipient's WALLET address — the transfer itself targets the
            derived associated token account, and the payable address is the thing to check. */}
        <Text testID="sol-pay-payee" style={S.dim2}>{spay.recipient}</Text>
        {spayMessage ? <Text testID="sol-spay-message" style={S.dim2}>{M.pay.spay.merchantMessage(spayMessage)}</Text> : null}
        {/* The token path may need the recipient's token account created in the same transaction —
            the sender covers its one-time rent. Same disclosure line as the send form. */}
        {!isSol ? <Text testID="sol-spay-ata-note" style={S.dim2}>{M.withdraw.sol.recipientAtaNote(fmtAssetCompact(String(SOL_ATA_SETUP_MIN_LAMPORTS), SOL_DECIMALS, SOL_UNIT), unit)}</Text> : null}
        {insufficient ? <Text testID="sol-pay-lowbal" style={S.warnNote}>{M.pay.notEnoughBalance}</Text> : null}
        {err ? <Text testID="sol-pay-err" style={S.err}>{err}</Text> : null}
        <Pressable
          testID="btn-approve"
          style={[S.primary, approveDisabled && S.disabledFlat]}
          disabled={approveDisabled}
          accessibilityRole="button"
          accessibilityLabel={M.pay.approveA11y}
          accessibilityHint={M.pay.approveHint}
          accessibilityState={{disabled: approveDisabled}}
          onPress={() => void approveSpay(spay)}>
          <Text style={[S.primaryText, approveDisabled && S.disabledText]}>{busy ? M.pay.signing : M.pay.approve}</Text>
        </Pressable>
        <Pressable testID="btn-sol-pay-cancel" style={S.secondaryBtn} onPress={reset} accessibilityRole="button" accessibilityLabel={M.common.cancel} accessibilityState={{disabled: false}}>
          <Text style={S.secondaryBtnText}>{M.common.cancel}</Text>
        </Pressable>
      </View>
    );
  }

  if (phase === 'spay-done' && spayDone) {
    // Two outcomes, one surface — the ocp-done discipline. A `null` note = the transfer confirmed;
    // a note = the network accepted it and the confirmation did not land in the window, so the
    // check mark is replaced by the clock and the signature below is the payer's record. No retry
    // affordance in the noted case: the transaction may still be landing, and paying again is the
    // one action that could double-charge.
    return (
      <View style={S.center}>
        <View style={[S.check, spayDone.note ? S.checkAlready : null]}>
          {spayDone.note ? <IconClock size={44} color={C.brandInk}/> : <IconCheck size={44} color={C.brandInk}/>}
        </View>
        <Text testID="sol-pay-status" style={[S.paidText, spayDone.note ? S.alreadyText : null]}>
          {spayDone.note ? M.pay.sent(spayDone.amount) : M.nfc.paidAmount(spayDone.amount)}
        </Text>
        <Text style={S.paidSub}>{M.pay.toWho(spayDone.who)}</Text>
        {spayDone.note ? <Text testID="sol-spay-outcome" style={S.warnNote}>{spayDone.note}</Text> : null}
        <Text style={S.dim2}>{M.withdraw.sol.txSignature}</Text>
        <Text testID="sol-spay-signature" selectable={true} style={S.sheetAddr} accessibilityLabel={M.pay.ocp.ref.solTransaction(spayDone.signature)}>{spayDone.signature}</Text>
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
        <Text testID="sol-pay-amount" style={S.reviewAmount}>{M.pay.payAmount(fmtAssetCompact((req.cur === 'SOL' ? BigInt(req.amt) + SOL_FEE_LAMPORTS : BigInt(req.amt)).toString(), decimals, unit))}</Text>
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
        <Text style={S.amountBig}>{M.pay.amountToWho(fmtAssetCompact((req!.cur === 'SOL' ? BigInt(req!.amt) + SOL_FEE_LAMPORTS : BigInt(req!.amt)).toString(), decimals, unit), claimedName || req!.to)}</Text>
        {/* U-F5: the sync auto-sign batch-skips the sign-status surface (straight to qr), so the
            short destination must live HERE — a merchant name alone is not verifiable. */}
        {claimedName ? <Text testID="sol-pay-payee" style={S.dim2}>{short(req!.to)}</Text> : null}
        <Text style={S.badgeOk}>{M.pay.signedOffline}</Text>
        <Text style={S.qrHint}>{M.pay.solOfflineSettles}</Text>
        {/* The fact-less-signature caveat (M1). It sits ON the hand-off surface because that is
            where this rail's payer actually reviews a signed payment — the sync auto-sign skips
            the 'review' phase entirely — and because it is still actionable here: the payer can
            hand a different asset over instead. It never blocks the hand-off. */}
        {signCaveat ? (
          <View testID="sol-pay-sign-caveat" style={S.railOutageRow}>
            <IconAlert size={14} color={C.warn} />
            <Text style={S.railHealthText}>{signCaveat}</Text>
          </View>
        ) : null}
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
          {/* The user retracts the hand-off: the merchant never scanned the code, nothing can
              settle, so the pending-outbox record's optimistic deduction + row must go (the
              ledger is the backstop if a scan the payer missed slipped through — that settled
              row arrives in history under the same signature key). Same retraction semantics as
              PayMode's btn-notpaid. */}
          <Pressable testID="btn-sol-pay-discard" style={S.notPaidBtn} onPress={() => { if (solpaySigRef.current !== '') void removePendingPays(identity.publicHex, [solpaySigRef.current]); reset(); }} accessibilityRole="button" accessibilityLabel={M.common.cancel} accessibilityState={{disabled: false}}>
            <Text style={S.notPaidText}>{M.common.cancel}</Text>
          </Pressable>
        </View>
        <Pressable style={S.ghostBtn} onPress={() => share(solpayUri)} accessibilityRole="button" accessibilityLabel={M.pay.shareSignedCode} accessibilityState={{disabled: false}}>
          <IconShare size={16} color={C.sub}/>
          <Text style={S.ghostBtnText}>{shared ? shareConfirmLabel(M.pay.copied) : M.pay.shareSignedCode}</Text>
        </Pressable>
      </View>
    );
  }

  // phase === 'paid'. `req` may be null if the payment was via NFC (the autoSign decoded the
  // request internally; SolPayMode's `req` state is only set on QR scan). TOTAL DEBIT for native
  // SOL (fee is a known constant); the token amount alone for a spl-token (fee is SOL).
  const paidAmt = req ? fmtAssetCompact((req.cur === 'SOL' ? BigInt(req.amt) + SOL_FEE_LAMPORTS : BigInt(req.amt)).toString(), decimals, unit) : null;
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
      <Pressable testID="btn-sol-pay-done" style={[S.ghostBtn, S.ghostBtnMuted]} onPress={reset} accessibilityRole="button" accessibilityLabel={M.pay.newPayment} accessibilityState={{disabled: false}}>
        <Text style={S.ghostBtnText}>{M.pay.newPayment}</Text>
      </Pressable>
    </View>
  );
}

/** What the chain's own verdict on a broadcast signature means for a checkout payment. IC twin:
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
