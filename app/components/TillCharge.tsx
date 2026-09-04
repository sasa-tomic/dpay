import {useEffect, useState} from 'react';
import {View, Text, Pressable, TextInput, ActivityIndicator} from 'react-native';
import {QrCode} from './QrCode';
import {InstructionPanel} from './InstructionPanel';
import {C} from '../config/palette';
import {S} from '../styles';
import {POLL, PROOF_POLL_BUDGET, QR_SIZE} from '../config/constants';
import {fmtAsset, fmtAssetCompact, nowSecs, short} from '../lib/format';
import {offerNamesAsset} from '../lib/opencryptopay';
import type {SelectableAsset} from '../config/assets';
import type {AssetId, Identity} from '../lib/types';
import {
  TILL_OFFER, cancelTillCharge, chfCents, openTillCharge, tillChargeStatus, tillRawUnits,
  type TillCharge as Charge, type TillOpenOutcome, type TillSettled, type TillVoidOutcome,
} from '../services/till';
import {useReportLock} from '../hooks/useReportLock';
import {IconCheck, IconClock} from './icons';
import {M} from '../i18n';

/** The franc, as ISO 4217 writes it — the till's pricing unit, and the same three letters in every
 *  locale, so it is a unit like `BTC`/`SOL` rather than a translated word. Formatted by the wallet's
 *  own amount formatter (`fmtAsset`), never by string concatenation. */
const CHF = 'CHF';

/**
 * The counter: a cashier rings up a price in francs, shows a code, and watches it be paid.
 *
 * WHERE THIS LIVES, AND WHY IT IS NOT A TAB. A till charge is not a third kind of receiving — it is
 * the SAME request with a wider audience — so it sits inside Receive ▸ Request payment as a second
 * code FORM, chosen by the small selector above it. The `[ Request payment | My address ]` toggle
 * is structurally two-segment and widening it would assert a distinction that does not exist. Two
 * QR payloads cannot share one frame, which is the only reason there is a selector at all: the
 * request screen already runs QR and NFC reader mode at the same time with no per-payment toggle.
 *
 * BOTH RAILS MOUNT THIS, and that is the point (the same-surfaces hard rule). The selector renders
 * for every asset on both Receive forms; a control that appeared only for VCHF would be exactly the
 * per-rail special case the rule forbids. What differs is the ANSWER: a till code is paid in VCHF
 * on the Internet Computer and in nothing else (`crates/dpay-relay/src/till.rs`), so every other
 * asset — ckBTC, ICP, SOL, USDC on Solana — lands on a refusal that names it, names the rail, and
 * offers the one tap that fixes it.
 *
 * THE PAID LIGHT IS THE RELAY'S ANSWER, NEVER THIS SCREEN'S INFERENCE. A charge settles when the
 * relay OBSERVES money arriving on the merchant's own ledger — including from a payer who never
 * touched the OpenCryptoPay endpoints — so nothing here may conclude anything from a countdown, a
 * scan, or the absence of an answer. The status route deliberately exposes no quote count and no
 * "scanned" signal, so this screen cannot claim the customer is looking at it, and an unreadable
 * poll says "can't check" rather than "unpaid" (`services/till.ts`, rule 2).
 */

type EndReason = 'expired' | 'cancelled' | 'superseded' | 'gone';

/** The counter's state machine. Every one of these tells the cashier what to do next; that is the
 *  founder rule (2026-08-29) applied to a surface whose whole job is dead ends. */
/// The charge rides INSIDE the two phases that have one, rather than beside them: a "showing" with
/// no charge, or a "paid" with no price, are states this screen must not be able to represent — the
/// first would hide a payable code and the second would name a sale it could not price.
type Phase =
  | {k: 'entering'}
  | {k: 'opening'}
  | {k: 'showing'; charge: Charge}
  /** Credited on the ledger. `late` means the money arrived after the code expired — accepted, and
   *  said out loud, because the alternative is dropping a real payment for being slow. */
  | {k: 'paid'; charge: Charge; paid: TillSettled | null; late: boolean}
  | {k: 'ended'; reason: EndReason}
  /** The ring-up did not happen. The outcome is carried whole so the panel can say WHICH way it
   *  failed — the four causes send the merchant to do four different things. */
  | {k: 'failed'; outcome: Exclude<TillOpenOutcome, {kind: 'open'}>};

export function TillCharge({identity, relayUrl, asset, assets, onSelectAsset, onLiveChange}: {
  identity: Identity;
  relayUrl: string;
  /** The asset the wallet is currently on — the one the whole Receive tab is about. */
  asset: SelectableAsset | null;
  assets: SelectableAsset[];
  onSelectAsset: (id: AssetId) => void;
  /** Fires while a charge exists that a customer could pay, so the parent can lock the asset
   *  selection and hide the code-form selector — flipping away from a live code would leave a
   *  payable charge on screen nowhere. */
  onLiveChange?: (live: boolean) => void;
}) {
  const [amount, setAmount] = useState('');
  const [phase, setPhase] = useState<Phase>({k: 'entering'});
  /** The price the last ring-up ATTEMPTED, in cents — what a failure panel quotes back. Kept beside
   *  the charge rather than re-parsed from the input, so the number in the message is the number
   *  that was actually signed and sent. */
  const [rung, setRung] = useState<string | null>(null);
  /** The poll could not reach the till. NOT a payment state — see the component doc. */
  const [unchecked, setUnchecked] = useState<string | null>(null);
  /** The relay says the code has expired and we are still watching for a late transfer. */
  const [watchingLate, setWatchingLate] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [now, setNow] = useState(() => nowSecs());

  // The asset a till code is paid in, matched by the SAME rule the payer half matches a provider's
  // offer with (`offerNamesAsset`) — one statement of "does this row name that asset", not two.
  const tillAsset = assets.find(a => offerNamesAsset(TILL_OFFER, a)) ?? null;
  const payable = asset != null && offerNamesAsset(TILL_OFFER, asset);

  // Reported to the parent through the SAME hook every other engine reports its selection lock
  // with: the contract is identical (report each change, reset on unmount, parent's setter is a
  // stable `useState` setter), and a live till charge is exactly a thing the wallet must not be
  // switched out from under.
  const live = phase.k === 'opening' || phase.k === 'showing';
  useReportLock(onLiveChange, live);

  // The display clock — only while a code is on screen, and only to count it down.
  useEffect(() => {
    if (phase.k !== 'showing') return;
    const id = setInterval(() => setNow(nowSecs()), 1000);
    return () => clearInterval(id);
  }, [phase.k]);

  // THE POLL. The merchant's own cadence (`POLL.receiptRcv` — the same one the request screen
  // reconciles an incoming payment at), and the same bounded budget (`PROOF_POLL_BUDGET`) once the
  // code has expired: an offline payer's transfer can land after the deadline, and the relay will
  // still credit it, so watching a little past expiry is the difference between "paid late" and a
  // sale dropped for being slow.
  const chargeId = phase.k === 'showing' ? phase.charge.id : null;
  useEffect(() => {
    if (chargeId === null) return;
    let alive = true;
    let lateTicks = 0;
    const tick = async () => {
      const answer = await tillChargeStatus(relayUrl, chargeId);
      if (!alive) return;
      if (answer.kind === 'unchecked') { setUnchecked(answer.detail); return; }
      setUnchecked(null);
      if (answer.kind === 'gone') { setPhase({k: 'ended', reason: 'gone'}); return; }
      const s = answer.status;
      switch (s.state) {
        case 'paid':
          // Functional form: the charge comes from the phase this poll belongs to, so a settlement
          // can never be attached to a charge that has since been replaced.
          setPhase(prev => prev.k === 'showing'
            ? {k: 'paid', charge: prev.charge, paid: s.paid, late: s.paid != null && s.paid.atSecs >= s.expiresAt}
            : prev);
          return;
        case 'cancelled':
        case 'superseded':
          setPhase({k: 'ended', reason: s.state});
          return;
        case 'expired':
          lateTicks += 1;
          if (lateTicks > PROOF_POLL_BUDGET) setPhase({k: 'ended', reason: 'expired'});
          else setWatchingLate(true);
          return;
        case 'open':
          setWatchingLate(false);
          return;
      }
    };
    void tick();
    const id = setInterval(() => { void tick(); }, POLL.receiptRcv);
    return () => { alive = false; clearInterval(id); };
  }, [chargeId, relayUrl]);

  async function ringUp() {
    // `payable` narrows `asset` to the till's own row (an aliased-condition narrowing), which is
    // what makes `asset.decimals` below the precision of the asset this charge settles in.
    if (!payable) return;
    const parsed = chfCents(amount);
    if (!parsed.ok) { setErr(M.receive.till.badAmount(parsed.reason)); return; }
    setErr(null);
    setUnchecked(null);
    setWatchingLate(false);
    setRung(parsed.cents);
    setPhase({k: 'opening'});
    const outcome = await openTillCharge(relayUrl, identity, parsed.cents, asset.decimals);
    if (outcome.kind === 'open') {
      setNow(nowSecs());
      setPhase({k: 'showing', charge: outcome.charge});
      return;
    }
    setPhase({k: 'failed', outcome});
  }

  async function cancel() {
    if (cancelling) return;
    setCancelling(true);
    setErr(null);
    const outcome = await cancelTillCharge(relayUrl, identity);
    setCancelling(false);
    if (outcome.kind === 'cancelled') { setPhase({k: 'ended', reason: 'cancelled'}); return; }
    // Still showing, still polling: a cancellation that did not happen leaves a payable code, and
    // the merchant has to be told that rather than shown a cleared till.
    setErr(cancelRefusal(outcome));
  }

  /** Back to an empty counter. The amount is kept — a mis-keyed total is retyped, a refused one is
   *  usually rung up again unchanged. */
  function reset() {
    setPhase({k: 'entering'});
    setUnchecked(null);
    setWatchingLate(false);
    setErr(null);
  }

  if (!payable) {
    // Every asset reaches this control, and every asset that is not the till's own lands here by
    // name. `tillAsset` is the one tap that fixes it — and when this wallet carries no VCHF row at
    // all there is no tap to offer, so the panel says so instead of showing a button that cannot work.
    return (
      <InstructionPanel
        testID="till-refused"
        title={M.receive.till.wrongAssetTitle}
        body={tillAsset === null
          ? M.receive.till.noTillAsset
          : M.receive.till.wrongAsset(asset?.symbol ?? '', asset?.network ?? null)}
        primaryLabel={tillAsset ? M.receive.till.switchTo(tillAsset.symbol) : undefined}
        onPrimary={tillAsset ? () => onSelectAsset(tillAsset.id) : undefined}
      />
    );
  }

  if (phase.k === 'failed') {
    return (
      <InstructionPanel
        testID="till-failed"
        title={M.receive.till.failedTitle}
        body={failureBody(phase.outcome, relayHost(relayUrl), fmtAsset(rung ?? '0', 2, CHF))}
        primaryLabel={M.receive.till.tryAgain}
        onPrimary={reset}
      />
    );
  }

  if (phase.k === 'ended') {
    return (
      <InstructionPanel
        testID="till-ended"
        title={M.receive.till.endedTitle(phase.reason)}
        body={M.receive.till.endedBody(phase.reason)}
        primaryLabel={M.receive.till.ringUpNext}
        onPrimary={reset}
      />
    );
  }

  if (phase.k === 'paid') {
    return (
      <View style={S.center}>
        <View style={S.check}><IconCheck size={44} color={C.brandInk}/></View>
        <Text testID="till-paid" style={S.paidText}>{M.receive.till.paidAmount(fmtAsset(phase.charge.cents, 2, CHF))}</Text>
        {phase.paid ? <Text style={S.paidSub}>{M.receive.fromWho(short(phase.paid.from))}</Text> : null}
        {phase.paid ? <Text testID="till-paid-block" style={S.dim2}>{M.receive.till.paidBlock(phase.paid.block)}</Text> : null}
        {phase.late ? <Text testID="till-paid-late" style={S.dim2}>{M.receive.till.paidLate}</Text> : null}
        <Pressable
          testID="btn-till-new"
          style={[S.ghostBtn, S.ghostBtnMuted]}
          onPress={reset}
          accessibilityRole="button"
          accessibilityLabel={M.receive.till.ringUpNext}
          accessibilityState={{disabled: false}}>
          <Text style={S.ghostBtnText}>{M.receive.till.ringUpNext}</Text>
        </Pressable>
      </View>
    );
  }

  if (phase.k === 'showing') {
    const {charge} = phase;
    const remaining = charge.expiresAt - now;
    // `payable` above proves `asset` is the till's own row; this reads its precision for the
    // settlement line, which is the only place the asset is needed once a charge exists.
    const settles = fmtAssetCompact(
      tillRawUnits(charge.cents, asset.decimals), asset.decimals, asset.symbol, undefined, asset.minFractionDigits,
    );
    return (
      <View style={S.center}>
        <View testID="till-qr" style={S.qrCard}><QrCode value={charge.qr} size={QR_SIZE} ecl="M" /></View>
        <Text testID="till-amount" style={S.amountBig}>{fmtAsset(charge.cents, 2, CHF)}</Text>
        <Text style={S.qrHint}>{M.receive.till.settlesAs(settles)}</Text>
        {remaining > 60 ? (
          <View style={{flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6}}>
            <IconClock size={14} color={C.sub}/>
            <Text style={[S.qrExpiry, {marginTop: 0}]}>{M.receive.validForMin(Math.floor(remaining / 60))}</Text>
          </View>
        ) : remaining > 0 ? (
          <Text style={S.qrExpiryWarn}>{M.receive.expiresIn((remaining % 60).toString().padStart(2, '0'))}</Text>
        ) : null}
        {/* The three things this screen may say about the money, in the order they outrank each
            other: we cannot see the till; the code has expired but a late transfer can still land;
            or we are simply waiting. None of them ever claims the customer has scanned anything. */}
        {/* `qrExpiryWarn` rather than `warnNote`: this line sits directly under the countdown, and
            warnNote's negative top margin (it is built to hug the element above it on a form) drew
            the warning ON TOP of the validity line. */}
        <Text testID="till-status" style={unchecked !== null || watchingLate ? S.qrExpiryWarn : S.qrHint}>
          {unchecked !== null
            ? M.receive.till.cantCheck
            : watchingLate ? M.receive.till.expiredWatching : M.receive.till.waiting}
        </Text>
        <Text style={S.dim2}>{M.receive.till.showToCustomer}</Text>
        {err ? <Text testID="till-err" style={S.err}>{err}</Text> : null}
        {cancelling ? <ActivityIndicator color={C.brand} /> : null}
        <Pressable
          testID="btn-till-cancel"
          style={[S.ghostBtn, S.ghostBtnMuted, cancelling && S.disabledFlat]}
          disabled={cancelling}
          onPress={cancel}
          accessibilityRole="button"
          accessibilityLabel={M.receive.till.cancel}
          accessibilityHint={M.receive.till.cancelHint}
          accessibilityState={{disabled: cancelling}}>
          <Text style={S.ghostBtnText}>{cancelling ? M.receive.till.cancelling : M.receive.till.cancel}</Text>
        </Pressable>
      </View>
    );
  }

  // phase 'entering' / 'opening' — the counter itself. The amount is in FRANCS (the till prices in
  // CHF and settles 1:1 in VCHF), which is why this field is its own and not the asset-denominated
  // one above it: a rappen is two decimals and VCHF is eight, and mixing them would let a cashier
  // ring up a total the till cannot charge.
  const opening = phase.k === 'opening';
  return (
    <View style={S.center}>
      <Text style={S.label}>{M.receive.till.chargeLabel}</Text>
      <View style={S.amountRow}>
        <View style={S.prefixBtn}><Text style={S.currency}>{CHF}</Text></View>
        <TextInput
          testID="till-amount-input"
          style={S.amountInput}
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
          placeholder={M.receive.amountPlaceholder}
          placeholderTextColor={C.sub}
          accessibilityLabel={M.receive.till.chargeLabel}
          accessibilityHint={M.receive.till.chargeHint}
        />
      </View>
      <Text style={S.dim2}>{M.receive.till.chargeHint}</Text>
      {err ? <Text testID="till-err" style={S.err}>{err}</Text> : null}
      {opening ? <ActivityIndicator color={C.brand} /> : null}
      <Pressable
        testID="btn-till-ring-up"
        style={[S.primaryWide, (opening || amount.trim().length === 0) && S.disabledFlat]}
        disabled={opening || amount.trim().length === 0}
        onPress={ringUp}
        accessibilityRole="button"
        accessibilityLabel={M.receive.till.ringUp}
        accessibilityHint={M.receive.till.ringUpHint}
        accessibilityState={{disabled: opening || amount.trim().length === 0}}>
        <Text style={S.primaryText}>{opening ? M.receive.till.ringingUp : M.receive.till.ringUp}</Text>
      </Pressable>
    </View>
  );
}

/** The host a merchant would name when they ask why their till did not answer — the relay they are
 *  pointed at. A URL this app could not parse falls back to the setting's own text, because an
 *  unparseable relay URL is exactly the thing the message needs to show them. */
function relayHost(relayUrl: string): string {
  try {
    return new URL(relayUrl).host;
  } catch (e) {
    console.warn(`till: the configured relay URL is not a URL (${relayUrl}): ${e instanceof Error ? e.message : String(e)}`);
    return relayUrl;
  }
}

/** Why the ring-up did not happen, in the merchant's terms. Each arm ends somewhere different: turn
 *  the till on, check the connection, fix what the till named, or stop trusting this code. */
function failureBody(outcome: Exclude<TillOpenOutcome, {kind: 'open'}>, host: string, rung: string): string {
  switch (outcome.kind) {
    case 'not-served': return M.receive.till.notServed(host);
    case 'unreachable': return M.receive.till.unreachable(host);
    case 'unsigned': return M.receive.till.unsigned;
    case 'mispriced': return M.receive.till.mispriced(rung, outcome.quoted);
    case 'refused':
      return outcome.said !== null
        ? M.receive.till.refused(outcome.said)
        : M.receive.till.refusedNoReason(outcome.status);
  }
}

/** A cancellation that did not clear the till. The charge is STILL PAYABLE in every one of these
 *  cases, which is the fact the cashier needs — including the one where it was already paid, where
 *  the relay's own sentence names the block that paid it. */
function cancelRefusal(outcome: Exclude<TillVoidOutcome, {kind: 'cancelled'}>): string {
  switch (outcome.kind) {
    case 'unreachable': return M.receive.till.cancelUnreachable;
    case 'unsigned': return M.receive.till.unsigned;
    case 'refused':
      return outcome.said !== null
        ? M.receive.till.cancelFailed(outcome.said)
        : M.receive.till.cancelFailedNoReason(outcome.status);
  }
}
