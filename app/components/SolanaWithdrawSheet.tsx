import {useEffect, useMemo, useRef, useState} from 'react';
import {View, Text, Pressable, TextInput, ActivityIndicator, Platform} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';
import {solSendTimeoutMs} from '../config/constants';
import {fmtAssetCompact, fmtTime, toUnits} from '../lib/format';
import {cmpRaw} from '../lib/amount';
import type {Txn} from '../lib/types';
import {useJourney} from '../lib/journey';
import {awardPaymentTested} from '../lib/readiness';
import {detectAddressShape, routeForSolana, chainNameOfShape, isBase58NearMiss} from '../lib/destination';
import type {Identity} from '../lib/types';
import {SOL_DECIMALS, SOL_UNIT, deriveSolanaAddress, isValidSolanaAddress} from '../solana/identity';
import {SOL_ATA_SETUP_MIN_LAMPORTS, SOL_FEE_LAMPORTS, deriveAta} from '../solana/spl';
import {solanaTokenInfo} from '../solana/tokens';
import {sendSol, sendSpl, preloadSolanaRpc, getSolSignatureStatus, getSolAccountExists} from '../solana';
import bs58 from 'bs58';
import {friendlySolError, isSolTransactionFailed} from '../solana/errors';
import {loadAddressBook, rememberAddress, forgetAddress, type SavedAddress} from '../services/addressBook';
import {saveTxNote} from '../services/txNotes';
import {useEscapeToClose} from '../hooks/useHotkeys';
import {useCopyFeedback} from '../hooks/useCopyFeedback';
import {withTimeout} from '../lib/timeout';
import {AddressField} from './AddressField';
import {SolanaAtaSetupCard} from './SolanaAtaSetupCard';
import {SendTerminal} from './SendTerminal';
import {M} from '../i18n';

/** The chain this rail settles on. Wire/display proper noun, never translated — the twin of
 *  SendSheet's `IC_NETWORK`. */
const SOL_NETWORK = 'Solana';

/**
 * Send SOL or USDC to a native Solana address (Phase 6 — asset-aware direct send). Mirrors
 * WithdrawSheet's form/submitting/done/error phases, but signs LOCALLY on the device (SLIP-10
 * ed25519 via noble) and broadcasts directly to the Solana RPC — no relay, no DpayCore, no facade.
 * The non-custodial gate is the on-device SLIP-10 key itself.
 *
 * The `token` prop (a registry symbol — 'SOL', 'USDC', 'EURC', …) selects which transfer path runs:
 *   - 'SOL'  → System Program Transfer (sendSol). `balance` is lamports (9 decimals).
 *   - a token → SPL Token transfer (sendSpl at that token's mint + decimals — both passed in from
 *              the selected asset row). The recipient is still a base58 Solana WALLET address —
 *              the recipient ATA is derived internally by sendSpl. If the recipient has NO token
 *              account yet, sendSpl creates it IN THE SAME transaction (real createIdempotent
 *              instruction; the sender pays the one-time rent, disclosed on the review card via
 *              `sol-send-ata-note`). The device's source ATA is pre-checked here via `ataAbsent` —
 *              when absent, the form is replaced by the same one-tap account-setup card the
 *              Receive tab has (2026-08-14; was a dead-end "set one up elsewhere" message).
 *
 * Rendered inline in the Pay tab's "Send to address" sub-mode. The testIDs stay token-agnostic
 * (`sol-send-*`) — "send" applies to both SOL and SPL. The review-amount text carries the unit
 * (USDC vs EURC vs SOL) so e2e can distinguish them.
 *
 * The destination is the SHARED `AddressField` — the same input, scanner button and saved-address
 * list the IC rail uses — over the shared `destination.ts` classifier. Before this it was a bare
 * TextInput whose only verdict was "not a valid Solana address", which cannot tell a typo from a
 * Bitcoin address pasted into the wrong wallet, and which offered neither a scanner nor an address
 * book that the IC surface had. CLAUDE.md's same-surfaces rule calls that divergence a bug.
 */
export function SolanaWithdrawSheet({identity, token, mint = null, symbol, decimals: decimalsProp, balance, ataAbsent = false, solBalance = null, solChecking = false, ataSetupBusy = false, ataSetupErr = null, onCreateAta, onShowSolAddress, prefill = null, onPrefillConsumed, onOpenAddressBook, onSent, onClose, onSendActiveChange, online = true, onReviewShown, onOpenReceipt}: {identity: Identity; token: string; mint?: string | null; symbol?: string; decimals?: number; /** The LAST-KNOWN balance in raw units — null when no balance was EVER known. Deliberately NOT a fresh-poll demand: a poll that is currently aborting/timing out must never gate a review that checks out against the last-known figure (the stale-ok rule, 2026-09-21 live EURC attempt #7). */ balance: string | null; ataAbsent?: boolean; solBalance?: string | null; solChecking?: boolean; ataSetupBusy?: boolean; ataSetupErr?: string | null; onCreateAta?: () => void; onShowSolAddress?: () => void; prefill?: {address: string; amount: string; label?: string; memo?: string} | null; onPrefillConsumed?: () => void; onOpenAddressBook?: () => void; onSent: () => void; onClose: () => void; onSendActiveChange?: (active: boolean) => void; /** The device's connectivity as the parent's balance polls see it — only shapes the in-sheet notice, never a gate. */ online?: boolean; /** Fired ONCE per mount, the first time this sheet renders its review card (surface ownership, 2026-09-21): the parent's offline strike gate must then stop replacing this sheet — offline may only speak inside it. */ onReviewShown?: (shown: boolean) => void; /** Open the shared `TxnReceipt` for a finished send (the sheet builds the `Txn`; the receipt stays mounted at the Wallet root). Optional so narrow mounts (tests) keep working. */ onOpenReceipt?: (t: Txn) => void;}) {
  const [address, setAddress] = useState('');
  const [amountStr, setAmountStr] = useState('');
  const [phase, setPhase] = useState<'form' | 'submitting' | 'done' | 'unknown' | 'error'>('form');
  const [err, setErr] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  // The destination + acceptance fact of the LAST submit, for the terminal surface and the
  // error-phase guidance. `accepted` mirrors `broadcast.sig !== null` into render space: the
  // terminal (unknown with the kept signature) and the two refund-safe guidance lines
  // (nothing-sent vs fee-only) are decisions about whether the network ACCEPTED anything.
  const [sentTo, setSentTo] = useState('');
  const [accepted, setAccepted] = useState(false);
  // Check status (the unknown terminal's read-only re-read of the chain): busy flag, a failed
  // check (the rail answered and cannot be reached right now), and the VERDICT state — the
  // status carried an on-chain `err`, which is the definitive fee-only failure panel.
  const [checkBusy, setCheckBusy] = useState(false);
  const [checkErr, setCheckErr] = useState<string | null>(null);
  const [checkFailed, setCheckFailed] = useState(false);
  const [saved, setSaved] = useState<SavedAddress[]>([]);
  const [saveName, setSaveName] = useState('');
  // A pay link's claimed label + memo (the SOL twin of the IC prefill's toName/memo). `for` pins
  // them to the recipient the link named: the claim belongs to that address, so it renders and is
  // saved only while the destination is still that address — a hand-edited destination is a
  // different payment with no claim.
  const [linkNote, setLinkNote] = useState<{who: string; msg: string; for: string} | null>(null);
  // Copy feedback for the affordability gate's top-up address (the same affordance the
  // deposit sheets carry).
  const {copied, copy: doCopy} = useCopyFeedback();
  // Trip Ready J5b — paymentTested: the same stamp the IC rails award, on the same event (a send
  // that CONFIRMED). `sendSol`/`sendSpl` resolve only on a confirmed signature and throw otherwise,
  // so the catch below — the honest "we don't know" path — never reaches the award.
  const {journey} = useJourney();

  useEscapeToClose(onClose);

  // Warm the network module at mount, OFF the money path (2026-09-21 root cause): the send chain's
  // first await is the lazy `rpc-*.js` chunk load, which no deadline can cut from below — a
  // user who types destination+amount gives this preload minutes to land, so the click-time
  // import resolves instantly (and the bounded loadRpcForSend covers the pathological case).
  useEffect(() => { preloadSolanaRpc(); }, []);

  // The send OWNS its surface while it is off the form (2026-09-21, live EURC attempt #3): the
  // parent's connectivity/fund gates would otherwise tear THIS sheet down mid-send — the balance
  // poll's 3-strike offline flip replaced the whole sheet with the offline panel while a transfer
  // was in flight, so no terminal surface (sent/unknown/error) ever rendered and the failure was
  // undiagnosable. While active, the parent must keep this sheet mounted; the honest
  // unknown-outcome panel gets its moment, and the offline panel returns only after the user
  // leaves the send. `submitting` and every terminal phase count; the unmount cleanup clears the
  // flag so a mid-send sub-mode flip cannot leave it stuck.
  const sendActive = phase !== 'form';
  useEffect(() => {
    onSendActiveChange?.(sendActive);
  }, [sendActive, onSendActiveChange]);
  useEffect(() => () => onSendActiveChange?.(false), []);

  // A shared payment link resolved to this rail: fill the form with its destination + amount and
  // let the payer confirm. It ONLY pre-fills — the Review/Send presses below are still the consent,
  // exactly as when the user types the two fields by hand. Guarded on the form phase so an incoming
  // link can never rewrite a send that is already submitting, and consumed as it is taken so the
  // payer's own edits are never overwritten by a re-render.
  useEffect(() => {
    if (prefill == null || phase !== 'form') return;
    setAddress(prefill.address);
    setAmountStr(prefill.amount);
    setLinkNote((prefill.label ?? '') !== '' || (prefill.memo ?? '') !== '' ? {who: prefill.label ?? '', msg: prefill.memo ?? '', for: prefill.address} : null);
    onPrefillConsumed?.();
    // onPrefillConsumed is an inline closure; the [prefill, phase] guard + immediate clear make its
    // identity irrelevant (exhaustive-deps would force a re-run on every render's new closure).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill, phase]);

  const isSpl = token !== 'SOL';
  const decimals = decimalsProp ?? (isSpl ? solanaTokenInfo(token)?.decimals ?? SOL_DECIMALS : SOL_DECIMALS);
  const unit = symbol ?? token;
  // Every amount on this sheet is the same token at the same precision — one formatter, one place.
  const fmt = (rawAmount: string) => fmtAssetCompact(rawAmount, decimals, unit);

  // Per-token address book, mirroring the IC rail's `ic:<currency>` key: distinct tokens are sent
  // to the same KIND of address but to different people, so one shared list would mix audiences.
  const assetKey = `sol:${token}`;
  useEffect(() => {
    let alive = true;
    loadAddressBook(assetKey).then(list => { if (alive) setSaved(list); });
    return () => { alive = false; };
  }, [assetKey]);

  // The wallet's own Solana address — the self-send warning. Derivation is pure and synchronous
  // here (SLIP-10 over the device seed), unlike the IC rail's async core validators.
  const selfAddress = useMemo(() => deriveSolanaAddress(identity.secretHex), [identity.secretHex]);

  // Convert the entered amount to base units at the selected token's decimals. `cmpRaw` (BigInt) for
  // presence — never `>` on strings (lexicographic trap).
  const raw = toUnits(amountStr, decimals);
  // STALE-OK BALANCE GATING (2026-09-21, live EURC attempt #7): `balance` is the LAST-KNOWN
  // figure — by hook contract it survives degraded polls (useSolanaBalances keeps the prior
  // amount on every abort/timeout and re-seeds the persisted fact at mount). The gate reads it
  // WITHOUT demanding a fresh poll:
  //   - known + amount ≤ known  → the confirm is ENABLED even while every poll is failing —
  //     a rendered review must be able to complete;
  //   - known + amount > known  → gated (a real over-spend, stated against the real figure);
  //   - never known (null)      → gated — an honest unknown never enables a blind send.
  // The old `?? '0'` coercion at the caller erased exactly the first case: one aborted-poll
  // season gated a funded wallet's review behind "More than your available 0" (four blind
  // presses on attempt #7).
  const balanceKnown = balance != null;
  const overBalance = balanceKnown && cmpRaw(raw, balance!) > 0;

  // What the typed destination IS. Two stages, exactly as the IC rail: `detectAddressShape` names
  // the NAMESPACE and `routeForSolana` says whether this rail can reach it, then the rail's own
  // parser decides validity — so a checksum failure is reported against a known namespace ("not a
  // valid Solana address") instead of being lumped in with a Bitcoin address pasted by mistake.
  // Synchronous, so no resolution race to guard: `isValidSolanaAddress` is a local base58 decode.
  const resolved = useMemo((): {ok: true; destination: string} | {ok: false; message: string} | null => {
    const text = address.trim();
    if (text.length === 0) return null;
    const routed = routeForSolana(detectAddressShape(text));
    if (!routed.ok) {
      // A base58-band string no namespace claimed is an ALMOST address (band-true, pubkey-false):
      // in this unambiguously-Solana field it is a malformed Solana address — name that problem
      // (the rail's own validity refusal below) rather than the generic "can't tell" shrug.
      if (routed.refusal.reason === 'unrecognised' && isBase58NearMiss(text)) {
        return {ok: false, message: M.withdraw.badAddress(SOL_NETWORK)};
      }
      return routed.refusal.reason === 'wrong-chain'
        ? {ok: false, message: M.withdraw.send.refuseWrongChain(chainNameOfShape(routed.refusal.shape) ?? '', unit, SOL_NETWORK)}
        : {ok: false, message: M.withdraw.send.refuseUnrecognised(unit)};
    }
    if (!isValidSolanaAddress(text)) return {ok: false, message: M.withdraw.badAddress(SOL_NETWORK)};
    return {ok: true, destination: text};
  }, [address, unit]);

  // The one status line under the field: the route when usable, the specific reason when not.
  const status = useMemo((): {text: string; tone: 'ok' | 'warn' | 'bad'} | null => {
    if (resolved == null) return null;
    if (!resolved.ok) return {text: resolved.message, tone: 'bad'};
    if (resolved.destination === selfAddress) return {text: M.withdraw.send.selfWarning, tone: 'warn'};
    return {text: M.withdraw.send.routeSolana(SOL_NETWORK), tone: 'ok'};
  }, [resolved, selfAddress]);

  // The recipient-ATA AFFORDABILITY GATE (2026-09-30, the INERT-confirm defect): a token send
  // to a destination with no token account yet makes the SENDER pay the one-time ATA rent
  // (about 0.00204428 SOL — the review card already discloses it). With rail SOL below that
  // floor the press used to strand the user: the send refused pre-broadcast and the form just
  // stayed. Now the gate engages BEFORE the press — disabled confirm + the reason + the exact
  // top-up address and amount — but ONLY on a KNOWN-absent recipient ATA with KNOWN-short SOL:
  //   • the existence read runs ONLY for short-SOL SPL sends (healthy wallets gain zero RPC
  //     calls), on the derived ATA of the resolved destination;
  //   • 'checking' and 'unknown' (failed read) never gate — the form stays usable and the
  //     send-time pre-check remains the honest backstop (its error phase is the pinned
  //     behavior in flow 52);
  //   • an EXISTING recipient account means only the fee is owed, which short SOL covers —
  //     no gate (the venue-deposit wall from the live trip was exactly this state's absence).
  const solShort = solBalance != null && !solChecking && BigInt(solBalance) < SOL_ATA_SETUP_MIN_LAMPORTS;
  const ataCheckTarget: string | null =
    isSpl && !ataAbsent && solShort && resolved?.ok === true && mint != null ? `${resolved.destination}|${mint}` : null;
  const [recipientAtaState, setRecipientAtaState] = useState<'checking' | 'absent' | 'exists' | 'unknown'>('checking');
  useEffect(() => {
    if (ataCheckTarget == null) {
      setRecipientAtaState('checking'); // not gating — the state is simply not applicable
      return;
    }
    let alive = true;
    setRecipientAtaState('checking');
    const sep = ataCheckTarget.indexOf('|');
    const dest = ataCheckTarget.slice(0, sep);
    const mintKey = ataCheckTarget.slice(sep + 1);
    (async () => {
      try {
        const exists = await getSolAccountExists(bs58.encode(deriveAta(dest, mintKey)));
        if (alive) setRecipientAtaState(exists ? 'exists' : 'absent');
      } catch {
        if (alive) setRecipientAtaState('unknown'); // an unreadable state never gates
      }
    })();
    return () => { alive = false; };
  }, [ataCheckTarget]);
  const ataRentBlocked = recipientAtaState === 'absent';
  const ataRentCost = fmtAssetCompact(String(SOL_ATA_SETUP_MIN_LAMPORTS), SOL_DECIMALS, SOL_UNIT);
  const ataRentHeld = solBalance != null ? fmtAssetCompact(solBalance, SOL_DECIMALS, SOL_UNIT) : '';

  const canReview = resolved?.ok === true && raw !== '0' && balanceKnown && !overBalance && !ataRentBlocked;

  // Surface ownership (the offline-gate half of the same live attempt): the FIRST rendered
  // review reports up, sticky for this mount. The parent's 3-strike offline gate then stops
  // replacing this sheet — offline may only show a notice inside it (below) — so the review
  // surface a user is mid-flow on can never be torn down out from under them. A
  // genuinely-offline send still fails honestly at the broadcast boundary (no funds move until
  // the network accepts — the architecture's own safe failure).
  const reviewVisible = (phase === 'form' || phase === 'error') && raw !== '0';
  const reviewShownRef = useRef(false);
  useEffect(() => {
    if (!reviewVisible || reviewShownRef.current) return;
    reviewShownRef.current = true;
    onReviewShown?.(true);
  }, [reviewVisible, onReviewShown]);

  // The link's claimed name, live only while the destination is still the link's recipient — the
  // same claim window the address-book name would have (PaymentReview's PayeeLine presentation:
  // the name in the to-line, the checkable address demoted beneath it).
  const notedDestination = linkNote != null && address.trim() === linkNote.for && linkNote.who !== ''
    ? linkNote.who
    : null;

  async function confirm() {
    if (!canReview || !resolved?.ok) {
      // SILENT-guard trace (2026-09-21): this return used to be invisible — a press that landed
      // with a stale `canReview` looked exactly like a hung send. Now the money log names it.
      console.warn(`money: sol send confirm pressed but NOT sendable (canReview=${canReview}, resolved=${resolved?.ok === true})`);
      return;
    }
    const destination = resolved.destination;
    console.warn(`money: sol send sheet submit ${isSpl ? token : 'SOL'} to=${destination} amount=${raw}`);
    setPhase('submitting');
    setErr(null);
    // Fresh attempt: no acceptance fact, no check verdict, and the destination the review showed.
    setAccepted(false);
    setCheckFailed(false);
    setCheckErr(null);
    setSentTo(destination);
    const {signal, cancel} = withTimeout(solSendTimeoutMs());
    // The broadcast boundary, captured: the moment the network ACCEPTS the transaction this holds
    // its signature — the ONLY fact that separates "definitely not sent" (a throw before it) from
    // "unknown — may still land" (a throw after it). The Solana Pay rail's pattern
    // (SolPayMode.sendSolanaPay), applied to the send sheet: a timeout must never read as a failed
    // send (the user would resend and double-pay), and the sheet must never spin past the deadline
    // (2026-09-21: two live sends hung in `submitting` past SOL_SEND_TIMEOUT).
    const broadcast: {sig: string | null} = {sig: null};
    try {
      // Branch on token: SOL → System Transfer; a registry token → SPL Token transfer at its own
      // mint (recipient ATA derived + fail-closed checked inside sendSpl; an unchecked Token
      // transfer needs no decimals — the mint fixes them). Both sign locally + broadcast to the RPC.
      const splMint = isSpl ? mint : null;
      if (isSpl && splMint == null) throw new Error(`no mint for token ${token}`);
      const onBroadcast = (sig: string) => { broadcast.sig = sig; setAccepted(true); };
      const sig = splMint != null
        ? await sendSpl(identity.secretHex, destination, BigInt(raw), splMint, signal, onBroadcast)
        : await sendSol(identity.secretHex, destination, BigInt(raw), signal, onBroadcast);
      // Device-saved annotation (services/txNotes): a pay link's claimed label + memo, recorded
      // against the signature this send just produced (the SOL join key the settling row will
      // carry) — the same seam as the IC twin's PayMode.approve. Only for the link's own
      // recipient; best-effort by contract, it can never break the send it describes.
      if (linkNote != null && destination === linkNote.for) {
        void saveTxNote(identity.publicHex, {k: sig, who: linkNote.who || undefined, msg: linkNote.msg || undefined}, Date.now());
      }
      setSignature(sig);
      setPhase('done');
      void rememberAddress(assetKey, destination, saveName.trim(), Date.now());
      onSent(); // trigger an immediate balance refresh (per-token — the parent wires the right one)
      awardPaymentTested(journey);
    } catch (e: unknown) {
      // The honest outcome split. The seam guarantees this catch runs by the caller's deadline
      // (sendSol/sendSpl settle on abort), so `submitting` can never outlive SOL_SEND_TIMEOUT.
      // INVARIANT (pinned in SolanaWithdrawSheet.test.tsx): the error phase — the only phase that
      // returns to the form and so offers a fresh send — is reachable ONLY when nothing was
      // accepted (`broadcast.sig === null`) or the failure is the chain's own definitive
      // `transaction failed:` verdict (fee-only; nothing moved but the fee). Every other
      // post-acceptance throw lands in `unknown`, which has NO send control at all.
      const msg = e instanceof Error ? e.message : String(e);
      if (broadcast.sig !== null && !isSolTransactionFailed(msg)) {
        // The network ACCEPTED the transaction; only the confirmation is missing (deadline, abort,
        // transport). Definitively-not-sent is off the table, so this is the honest "may still
        // land" state with the signature kept — never an error that invites a resend, never a
        // spinner. The annotation is recorded against the broadcast signature (the join key),
        // exactly as the settled path does.
        if (linkNote != null && destination === linkNote.for) {
          void saveTxNote(identity.publicHex, {k: broadcast.sig, who: linkNote.who || undefined, msg: linkNote.msg || undefined}, Date.now());
        }
        setSignature(broadcast.sig);
        setPhase('unknown');
        console.warn(`money: sol send sheet UNKNOWN outcome — broadcast accepted, confirmation missed, sig kept: ${broadcast.sig}`);
        onSent(); // the balance may already reflect it — refresh rather than claim either way
      } else {
        // A Solana RPC error (insufficient funds / rent-exempt violation / network / missing ATA),
        // the venue's own broadcast rejection (a 2xx JSON-RPC error body — thrown before anything
        // was accepted), or an on-chain failure (`transaction failed:` — definite, fee only).
        // The form returns with a per-class guidance line below (nothing-sent vs fee-only).
        console.warn(`money: sol send sheet ERROR (accepted=${broadcast.sig !== null}): ${msg}`);
        setErr(friendlySolError(msg));
        setPhase('error');
      }
    } finally {
      cancel();
    }
  }

  /** The unknown terminal's Check status — a READ, never a re-sign. `getSolSignatureStatus`
   *  re-reads the chain for the kept signature; the resolution matrix (pinned in
   *  SolanaWithdrawSheet.test.tsx): confirmed/finalized ⇒ the settled panel (the transfer
   *  landed — the stamp follows, now that it is a confirmed payment); an on-chain `err` ⇒ the
   *  terminal failed panel (fee-only truth); null (never heard of it) or 'processed' ⇒ the
   *  honest pending stays, unchanged; a throw (rail unreachable) ⇒ a check-failed line under
   *  the button and the pending STAYS — a check that cannot complete is never a verdict. */
  async function checkStatus() {
    if (!signature || checkBusy) return;
    setCheckBusy(true);
    setCheckErr(null);
    try {
      const st = await getSolSignatureStatus(signature);
      if (st != null && st.err != null) {
        setCheckFailed(true);
        console.warn(`money: sol send sheet check → ON-CHAIN FAILURE for ${signature}`);
        return;
      }
      if (st != null && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
        setPhase('done');
        awardPaymentTested(journey); // confirmed NOW — the stamp follows the resolution, as ever
        console.warn(`money: sol send sheet check → CONFIRMED ${signature}`);
        return;
      }
      console.warn(`money: sol send sheet check → still pending (${st?.confirmationStatus ?? 'unknown to the cluster'})`);
    } catch (e: unknown) {
      setCheckErr(M.withdraw.send.checkFailed);
      console.warn(`money: sol send sheet check FAILED:`, e instanceof Error ? e.message : String(e));
    } finally {
      setCheckBusy(false);
    }
  }

  // Phase 6 fail-closed + 2026-08-14 setup action: token send when the device's ATA is KNOWN
  // absent → the shared one-tap setup card (SolanaAtaSetupCard — same surface as the Receive
  // tab). You can't send tokens you don't have an account for; the card offers the REAL one-tap
  // create (device-key-signed createIdempotent tx) instead of a dead end. On success the parent's
  // ATA refresh flips `ataAbsent` and the form appears. Only 'absent' gates — loading/error/
  // unavailable states let the form through (the send itself fails honestly if the ATA is missing).
  if (isSpl && ataAbsent) {
    const hasSol = solBalance != null && BigInt(solBalance) >= SOL_ATA_SETUP_MIN_LAMPORTS;
    const checkingSol = solBalance == null;
    return (
      <View style={S.sheetBody}>
        <SolanaAtaSetupCard
          asset={unit}
          instrTestID="sol-send-instructions"
          btnTestID="btn-sol-send-ata-create"
          buttonLabel={M.withdraw.sol.createAtaLabel(unit)}
          hasSol={hasSol}
          checkingSol={checkingSol}
          busy={ataSetupBusy}
          err={ataSetupErr}
          onCreateAta={onCreateAta}
          onShowSolAddress={onShowSolAddress}
        />
        <Pressable testID="btn-sol-send-done" style={[S.primaryWide, S.depositCopy]} onPress={onClose} accessibilityRole="button" accessibilityLabel={M.withdraw.sol.backToScan}><Text style={S.primaryText}>{M.withdraw.sol.backToScan}</Text></Pressable>
      </View>
    );
  }

  const body = (
    <>
      {(phase === 'done' || (phase === 'unknown' && signature)) ? (
        // The shared send terminal (both rails end here). Settled: the confirmed panel with the
        // signature as the reference. Unknown: the honest "may still land" panel — the signature
        // is real (the network ACCEPTED), so it is kept, shown, and re-checkable via the
        // read-only Check status; the receipt rides the pending flag so it says "not confirmed
        // yet" instead of printing a proof. A Check status that returns an on-chain err flips
        // the panel to the definitive fee-only failure (never a resend invite — the form is the
        // only place a NEW send is consented).
        <SendTerminal
          settled={phase === 'done'}
          failed={phase === 'unknown' && checkFailed}
          headline={phase === 'done' ? M.withdraw.sol.sent : checkFailed ? M.withdraw.send.failed : M.withdraw.sol.sentUnknown}
          amountText={fmt(raw)}
          destinationLabel={M.withdraw.ic.sentTo}
          destination={sentTo}
          pendingBody={checkFailed ? undefined : M.withdraw.sol.sentUnknownBody}
          failedBody={checkFailed ? M.withdraw.send.feeOnly : undefined}
          referenceLabel={M.withdraw.sol.txSignature}
          reference={signature ?? ''}
          refTestID="sol-send-signature"
          prefix="sol-send"
          onOpenReceipt={onOpenReceipt != null && signature != null
            ? () => onOpenReceipt({
                nonce: signature!,
                amount: raw,
                who: '',
                memo: '',
                time: fmtTime(Date.now()),
                ts: Date.now(),
                dir: 'out',
                assetId: `solana:${token}`,
                counterparty: sentTo,
                ledgerRef: signature!,
                ...(phase === 'unknown' && !checkFailed ? {pending: true as const} : {}),
              })
            : undefined}
          onCheckStatus={phase === 'unknown' ? () => { void checkStatus(); } : undefined}
          checkBusy={checkBusy}
          checkErr={checkErr}
          onDone={onClose}
        />
      ) : phase === 'submitting' ? (
        <View style={S.centerAll}>
          <ActivityIndicator color={C.brandText} />
          <Text style={S.dim2}>{M.withdraw.sol.sending(fmt(raw))}</Text>
          <Text style={S.dim2}>{M.withdraw.sol.confirmingOnSolana}</Text>
        </View>
      ) : (
        <>
          <Text style={S.label}>{M.withdraw.sol.sendToSolana(unit)}</Text>
          {balance != null ? <Text style={S.dim2}>{M.withdraw.sol.available(fmt(balance))}</Text> : null}

          <AddressField
            value={address}
            onChange={setAddress}
            status={status}
            saved={saved}
            onPickSaved={setAddress}
            onForgetSaved={a => { void forgetAddress(assetKey, a).then(setSaved); }}
            onManageSaved={onOpenAddressBook}
            testIDPrefix="sol-send"
          />

          {/* Naming is offered once the destination is usable — the IC rail's placement exactly. */}
          {resolved?.ok && saved.every(sv => sv.address !== resolved.destination) ? (
            <TextInput
              testID="sol-send-save-name"
              accessibilityLabel={M.withdraw.send.saveNamePlaceholder}
              style={S.withdrawNameInput}
              value={saveName}
              onChangeText={setSaveName}
              placeholder={M.withdraw.send.saveNamePlaceholder}
              placeholderTextColor={C.sub2}
              autoCapitalize="words"
            />
          ) : null}

          <Text style={S.inputLabel}>{M.withdraw.amountLabel(unit)}</Text>
          <TextInput
            testID="sol-send-amount-input"
            accessibilityLabel={M.withdraw.amountLabel(token)}
            style={S.withdrawAmtInput}
            value={amountStr}
            onChangeText={setAmountStr}
            keyboardType="decimal-pad"
            placeholder={isSpl ? M.withdraw.sol.tokenAmountPlaceholder : M.withdraw.sol.solAmountPlaceholder}
            placeholderTextColor={C.sub2}
          />

          {overBalance ? <Text style={S.warnNote}>{M.withdraw.overBalance(fmt(balance))}</Text> : null}
          {/* Known-zero SOL while sending a token (2026-08-16 UX review finding 13): fees + a possible
              recipient-ATA creation are paid in SOL — say so BEFORE the user types an amount, so
              a funded-token/zero-SOL wallet learns the real constraint up front (honest, no block). */}
          {isSpl && !solChecking && solBalance === '0' ? <Text testID="sol-send-needs-sol" style={S.warnNote}>{M.withdraw.sol.needsSol(unit)}</Text> : null}

          {/* The affordability gate: a KNOWN-absent recipient ATA + KNOWN-short SOL refuses
              BEFORE the press, with the reason and the practical instruction (the device's own
              SOL address to fund, exact amount named). Disabled confirm + this block replace
              the old inert press. */}
          {ataRentBlocked ? (
            <View testID="sol-send-ata-gate-wrap">
              <Text testID="sol-send-ata-gate" style={S.warnNote}>{M.withdraw.sol.ataRentGate(ataRentCost, ataRentHeld, unit)}</Text>
              <Text style={S.dim2}>{M.withdraw.sol.ataRentTopUp(ataRentCost)}</Text>
              <Text testID="sol-send-topup-address" style={S.dim2}>{selfAddress}</Text>
              <Pressable
                testID="btn-sol-send-topup-copy"
                style={S.linkBtn}
                onPress={() => { void doCopy(selfAddress); }}
                accessibilityRole="button"
                accessibilityLabel={M.deposit.copyAddress}>
                <Text style={S.linkText}>{copied === 'clipboard' ? M.deposit.copied : M.deposit.copyAddress}</Text>
              </Pressable>
            </View>
          ) : null}

          {(phase === 'form' || phase === 'error') && raw !== '0' ? (
            <View testID="sol-send-review" style={S.reviewCard}>
              <Text style={S.reviewLabel}>{M.withdraw.sol.reviewTitle}</Text>
              <Text testID="sol-send-review-amount" style={S.reviewAmount}>{M.withdraw.sol.sendAmount(fmt(raw))}</Text>
              {/* Fee + total disclosure (founder rule 2026-09-13), mirroring the IC SendSheet rows:
                  the fee is always real and paid in SOL; a TOTAL only exists for native-SOL sends
                  (a token amount and its SOL fee do not sum into one honest number). */}
              <View style={S.reviewRow}>
                <Text style={S.reviewRowLabel}>{M.withdraw.send.feeLine('')}</Text>
                <Text testID="sol-send-review-fee" style={S.reviewRowValue}>{fmtAssetCompact(String(SOL_FEE_LAMPORTS), SOL_DECIMALS, SOL_UNIT)}</Text>
              </View>
              {!isSpl ? (
                <View style={S.reviewRow}>
                  <Text style={S.reviewRowLabel}>{M.withdraw.send.totalLine('')}</Text>
                  <Text testID="sol-send-review-total" style={S.reviewRowValue}>{fmtAssetCompact((BigInt(raw) + SOL_FEE_LAMPORTS).toString(), SOL_DECIMALS, SOL_UNIT)}</Text>
                </View>
              ) : null}
              {notedDestination != null ? (
                <>
                  <Text style={S.reviewTo}>{M.pay.toWho(notedDestination)}</Text>
                  <Text testID="sol-send-review-payee" style={S.dim2}>{M.withdraw.toDestination(address.trim() || '—')}</Text>
                </>
              ) : (
                <Text style={S.reviewTo}>{M.withdraw.toDestination(address.trim() || '—')}</Text>
              )}
              {isSpl ? (
                <Text testID="sol-send-ata-note" style={S.dim2}>
                  {M.withdraw.sol.recipientAtaNote(fmtAssetCompact(String(SOL_ATA_SETUP_MIN_LAMPORTS), SOL_DECIMALS, SOL_UNIT), unit)}
                </Text>
              ) : null}
            </View>
          ) : null}

          {err ? <Text testID="sol-send-err" style={S.err}>{err}</Text> : null}

          {/* Error-phase guidance, one refund-safe line per failure class (the invariant comment
              in confirm()): nothing was accepted ⇒ the money never left, a fresh send is safe;
              the chain's own `transaction failed:` verdict over an ACCEPTED broadcast ⇒ fee-only
              truth. The form is the only place a NEW send is consented — no automatic re-send
              exists on either path. */}
          {phase === 'error' && !accepted ? <Text testID="sol-send-nothing-sent" style={S.dim2}>{M.withdraw.send.nothingSent}</Text> : null}
          {phase === 'error' && accepted ? <Text testID="sol-send-fee-note" style={S.warnNote}>{M.withdraw.send.feeOnly}</Text> : null}

          {/* Offline while the review is up: a NOTICE inside the sheet, never a teardown. The
              strike gate defers (see onReviewShown) — the honest statement of what offline means
              for THIS action lives here, and a genuinely-offline send fails at broadcast. */}
          {!online ? <Text testID="sol-send-offline-note" style={S.warnNote}>{M.withdraw.offlineReviewNote}</Text> : null}

          <Pressable
            testID="btn-sol-send-confirm"
            style={[S.primaryWide, !canReview && S.disabledFlat]}
            disabled={!canReview}
            onPress={confirm}
            accessibilityRole="button"
            accessibilityLabel={M.withdraw.sol.confirmLabel(unit)}
            accessibilityState={{disabled: !canReview}}>
            <Text style={[S.primaryText, !canReview && S.disabledText]}>{raw !== '0' ? M.withdraw.sol.sendAmount(fmt(raw)) : M.withdraw.enterAmount}</Text>
          </Pressable>

          {Platform.OS === 'web' ? <Text style={S.dim2}>{M.withdraw.pressEsc}</Text> : null}
        </>
      )}
    </>
  );

  return <View style={S.sheetBody}>{body}</View>;
}
