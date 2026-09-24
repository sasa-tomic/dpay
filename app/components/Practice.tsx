/**
 * Practice — the first-run payment, made for real, alone, on this device
 * (spec docs/specs/2026-09-08-first-run-redesign.md §3; it REPLACES `Rehearsal.tsx`, whose first
 * instruction was "Open dpay on another phone…" — something a solo user cannot do).
 *
 * The user pays ∂1.00 of practice money to `PRACTICE_PAYEE_PUBKEY`, a pinned keyless account
 * (config/constants.ts owns why that is acceptable and what keeps it acceptable). Nothing here is
 * simulated: the request goes through the SAME 132-byte wire codec a shop's QR does
 * (`encodeRequest` → `decodeRequest` → `wireRequestToIntent`), the review is the SAME component
 * the Pay tab renders (`PaymentReview`), and the transfer is the SAME signed `icrc1_transfer` the
 * rail signs for real money. That is the point — a lookalike would teach the wrong screen.
 *
 * THE GUARD. `practiceRefusal` refuses every currency but `PRACTICE_CURRENCY`, and it is checked
 * again immediately before signing. It is the only thing standing between a keyless address and
 * real money; do not weaken it to "the intent always says 0 anyway".
 *
 * HONESTY. Three outcomes, and only one of them is a success: `settled` shows the confirmed mark
 * and awards `flowUnderstood`; `unknown` shows the pending mark with no stamp and no success
 * colour ("this is exactly what a real pending payment looks like"); `rejected` shows the ledger's
 * own decoded reason. It never awards `paymentTested` — that stamp is about a tap-or-scan payment
 * to a real counterparty, and leaving it unfilled is what makes "ONE PAYMENT TO GO" true.
 *
 * NEVER A DEAD END. Every state, including all four fail-closed branches (no faucet, faucet
 * cooldown, offline, empty balance), exits through one Continue and none of them renders a deposit
 * address or an add-money action — nothing may ask a new user for funds before the app has given
 * them anything (anti-scam rules R1/R5).
 *
 * testID contract: root `practice`, request card `practice-card`, balance `practice-balance`,
 * outcome `practice-outcome` + `practice-outcome-body`, refusal reason `practice-refused-reason`,
 * fail-closed panels `practice-nofaucet` / `practice-cooldown` / `practice-offline` /
 * `practice-empty`, footer `practice-punchline`, buttons `btn-practice-review` /
 * `btn-practice-continue` / `btn-practice-skip`. The review's own testIDs are PaymentReview's.
 */
import {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, Pressable, SafeAreaView, ScrollView, StatusBar, Text, View} from 'react-native';
import {C} from '../config/palette';
import {S, isDark} from '../styles';
import {M} from '../i18n';
import {
  BALANCE_TIMEOUT_MS, EXPIRY_WINDOW, FAUCET_TIMEOUT_MS, POLL,
  PRACTICE_AMOUNT_RAW, PRACTICE_CURRENCY, PRACTICE_PAYEE_PUBKEY, TOP_UP_CENTS,
} from '../config/constants';
import {base, randNonceHex} from '../lib/format';
import {cmpRaw} from '../lib/amount';
import {icpCatalogOf, fmtCurrencyAmountCompact} from '../config/catalog';
import {useCatalog} from '../hooks/useCatalog';
import {DpayCore} from '../services/native';
import {fetchWithTimeout, readJsonOrEmpty, relayCapabilities, relayFetch} from '../services/relay';
import {saveTxNote} from '../services/txNotes';
import {prepareTransfer, submitTransfer, wireRequestToIntent} from '../services/rail';
import {JOURNEY_STAMPS, awardStamp} from '../lib/journey';
import {useEscapeToClose} from '../hooks/useHotkeys';
import type {Identity, PayIntent} from '../lib/types';
import {PaymentReview} from './PaymentReview';
import {InstructionPanel} from './InstructionPanel';
import {IconAlert, IconCheck, IconClock, IconClose} from './icons';

/**
 * The journey `seen` marker that retires this screen. It is a seen marker and not a stamp on
 * purpose: the stamp key set is closed, and "this one-time surface is done" is exactly what the
 * free-form seen dimension is for. Marked on completion AND on skip — a user who skipped has
 * decided, and asking again on the next launch would be nagging.
 */
export const FIRST_RUN_PRACTICE = 'firstRunPractice';

/** How long practice waits for its own transfer to reach a terminal state before calling the
 *  outcome unknown. Same shape as the pay rail's budget; the cadence is finer (250 ms), because
 *  there is a person waiting on a setup screen rather than standing at a checkout — settlement is
 *  detected the moment the subnet decides, not on the next half-second tick. */
const PRACTICE_POLL_BUDGET = {attempts: 12, intervalMs: 250} as const;

/**
 * THE GUARD. Returns null when `currency` may be practised with, and the reason it may not
 * otherwise. Exported so it can be tested in both directions without reaching through the
 * component: the negative half is the one that matters, because it is what stops the pinned
 * keyless payee ever receiving money somebody can lose.
 */
export function practiceRefusal(currency: number): string | null {
  return currency === PRACTICE_CURRENCY
    ? null
    : `practice refuses currency ${currency}: the pinned practice payee is keyless and may only ever receive currency ${PRACTICE_CURRENCY}`;
}

type Phase = 'request' | 'review' | 'outcome';
/** What the ledger said. `unknown` is a first-class answer, never rendered as either of the others. */
type Outcome = {kind: 'settled'} | {kind: 'unknown'} | {kind: 'rejected'; reason: string};
/** Why practice cannot run right now. Each one is a branch with its own instruction. */
type Blocker =
  | {kind: 'loading'}
  | {kind: 'offline'}
  | {kind: 'noFaucet'}
  | {kind: 'cooldown'; reason: string}
  | {kind: 'empty'}
  | null;

export function Practice({identity, relayUrl, onDone}: {identity: Identity; relayUrl: string; onDone: () => void}) {
  const networks = useCatalog(relayUrl);
  const catalog = icpCatalogOf(networks);

  const [phase, setPhase] = useState<Phase>('request');
  const [intent, setIntent] = useState<PayIntent | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [blocker, setBlocker] = useState<Blocker>({kind: 'loading'});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // The balance AFTER the payment settled — read once, at the moment the outcome landed, so the
  // "what is left" line on the success screen is a measured number and not the pre-payment one.
  const [settledBalance, setSettledBalance] = useState<string | null>(null);

  // Practice runs once, and its readiness check runs once with it: re-probing on every render
  // would ask a relay that has already answered. `attempt` re-arms it for the retry affordance the
  // offline branch offers.
  const [attempt, setAttempt] = useState(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  /** Read the practice balance. Returns null when the relay could not be reached at all — which is
   *  a DIFFERENT fact from a zero balance and drives a different branch. */
  const readBalance = useCallback(async (): Promise<string | null> => {
    try {
      const r = await relayFetch(relayUrl, `/api/v1/balances/${identity.publicHex}`, {}, BALANCE_TIMEOUT_MS);
      if (!r.ok) {
        console.warn(`practice: balances answered HTTP ${r.status}`);
        return null;
      }
      const j = await readJsonOrEmpty(r);
      const v = (j as Record<string, unknown>)[String(PRACTICE_CURRENCY)];
      if (typeof v !== 'string') {
        console.warn(`practice: balances carried no currency ${PRACTICE_CURRENCY} entry`);
        return null;
      }
      return v;
    } catch (e) {
      console.warn('practice: balance read failed:', e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [relayUrl, identity.publicHex]);

  // The readiness sequence, in the order the user experiences its failures: can this phone reach
  // the relay at all → is there practice money → if not, will this server hand some out → did it.
  // Each answer that is not "go" becomes a named branch with an action, never a spinner that
  // never ends (founder rule 2026-08-29).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setBlocker({kind: 'loading'});
      const first = await readBalance();
      if (cancelled || !alive.current) return;
      if (first === null) { setBlocker({kind: 'offline'}); return; }
      setBalance(first);
      if (cmpRaw(first, PRACTICE_AMOUNT_RAW) >= 0) { setBlocker(null); return; }
      // No practice money. Onboarding already asked for it on create; this is the second ask, and
      // it exists because the first one can legitimately have failed (a slow relay, an app killed
      // between create and here) and because the user is entitled to know WHY there is nothing to
      // practise with rather than staring at ∂0.00.
      const caps = await relayCapabilities(relayUrl);
      if (cancelled || !alive.current) return;
      if (!caps.demoFaucet) { setBlocker({kind: 'noFaucet'}); return; }
      const asked = await askForPracticeMoney(relayUrl, identity.publicHex);
      if (cancelled || !alive.current) return;
      if (asked.kind !== 'credited') { setBlocker(asked); return; }
      setBalance(asked.balance);
      setBlocker(cmpRaw(asked.balance, PRACTICE_AMOUNT_RAW) >= 0 ? null : {kind: 'empty'});
    })();
    return () => { cancelled = true; };
  }, [readBalance, relayUrl, identity.publicHex, attempt]);

  // Keep the shown balance honest while the user reads the card: it is the wallet's real number,
  // polled, not a value captured once at mount. Stops the moment a payment is under way — the
  // amount under review must not move while it is being approved.
  useEffect(() => {
    if (blocker !== null || phase !== 'request') return;
    const id = setInterval(() => {
      void readBalance().then(b => { if (b !== null && alive.current) setBalance(b); });
    }, POLL.balance);
    return () => { clearInterval(id); };
  }, [blocker, phase, readBalance]);

  /** Build the payment the way a scanned shop code builds one: encode the real 132-byte request,
   *  decode it back, and turn it into the intent the review renders. Nothing is signed here. */
  async function openReview() {
    setErr(null);
    try {
      const expiry = Math.floor(Date.now() / 1000) + EXPIRY_WINDOW;
      const wire = await DpayCore.encodeRequest(
        PRACTICE_PAYEE_PUBKEY, PRACTICE_AMOUNT_RAW, randNonceHex(), expiry,
        PRACTICE_CURRENCY, M.education.practice.payeeName, '',
      );
      const decoded = await DpayCore.decodeRequest(wire);
      const i = await wireRequestToIntent(decoded);
      if (!alive.current) return;
      setIntent(i);
      setPhase('review');
    } catch (e: unknown) {
      console.warn('practice: could not build the practice request:', e instanceof Error ? e.message : String(e));
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  /** Sign, submit, and report whatever actually happened. */
  async function approve(i: PayIntent) {
    // THE GUARD, at the last possible moment: this is the line that is between a keyless address
    // and real money, so it runs where the signing does, not only where the intent was built.
    const refusal = practiceRefusal(i.currency);
    if (refusal !== null) {
      console.warn(refusal);
      setErr(refusal);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      // Device-saved annotation (services/txNotes), at the same last-point-before-signing seam as
      // PayMode.approve: the practice row must read "to <payee>" in the log like every payment.
      // Keyed by the intent's nonce hex (the on-chain memo the relay echoes back). Best-effort by
      // contract — the note can never break the payment it describes.
      void saveTxNote(identity.publicHex, {k: i.nonceHex, who: M.education.practice.payeeName}, Date.now());
      const prepared = await prepareTransfer(identity.secretHex, {currencies: catalog}, i);
      const out = await submitTransfer(prepared, identity.secretHex, PRACTICE_POLL_BUDGET);
      if (!alive.current) return;
      if (out.kind === 'settled') {
        // The flow was not described to this user, it was performed by them. That is the stamp.
        // `paymentTested` is deliberately NOT awarded: this payee is not a counterparty.
        void awardStamp(JOURNEY_STAMPS.flowUnderstood);
        setOutcome({kind: 'settled'});
        setPhase('outcome');
        // The "what is left" line is still a MEASURED number read the moment settle was detected —
        // but it never delays the confirmed mark: the outcome renders at once and the line pops in
        // when the relay answers.
        void readBalance().then(after => { if (after !== null && alive.current) setSettledBalance(after); });
      } else if (out.kind === 'rejected') {
        setOutcome({kind: 'rejected', reason: out.reason});
        setPhase('outcome');
      } else {
        setOutcome({kind: 'unknown'});
        setPhase('outcome');
      }
    } catch (e: unknown) {
      // prepareTransfer throws BEFORE anything is submitted (unsupported asset, unreachable or
      // skewed IC clock), so nothing moved and the reason is the user's to act on.
      console.warn('practice: could not sign the practice payment:', e instanceof Error ? e.message : String(e));
      if (alive.current) setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const escape = useCallback(() => {
    if (phase === 'review') { setPhase('request'); setIntent(null); setErr(null); return; }
    onDone();
  }, [phase, onDone]);
  useEscapeToClose(escape);

  const fmt = (raw: string) => fmtCurrencyAmountCompact(catalog, PRACTICE_CURRENCY, raw);
  const shortfall = balance !== null && cmpRaw(PRACTICE_AMOUNT_RAW, balance) > 0;
  const P = M.education.practice;

  /** The footer's primary. `review` owns its own Approve/Cancel, and the readiness spinner asks
   *  nothing, so neither gets one — the header's skip is the exit while the screen resolves, and it
   *  is the SAME control before and after, so a tap can never land on a button that is replaced in
   *  the same frame. */
  const primary = phase === 'review' || blocker?.kind === 'loading' ? null
    : phase === 'outcome' || blocker !== null ? (
    <Pressable
      testID="btn-practice-continue"
      style={S.primary}
      onPress={onDone}
      accessibilityRole="button"
      accessibilityLabel={P.continue}
      accessibilityState={{disabled: false}}>
      <Text style={S.primaryText}>{P.continue}</Text>
    </Pressable>
  ) : (
    <Pressable
      testID="btn-practice-review"
      style={S.primary}
      onPress={() => void openReview()}
      accessibilityRole="button"
      accessibilityLabel={P.review}
      accessibilityState={{disabled: false}}>
      <Text style={S.primaryText}>{P.review}</Text>
    </Pressable>
  );

  return (
    <SafeAreaView testID="practice" style={S.walkRoot}>
      <StatusBar barStyle={isDark() ? 'light-content' : 'dark-content'} backgroundColor={C.bg} translucent={false} />
      {/* The app's standard sheet chrome. The skip affordance is the exit from the moment this
          screen mounts until the user commits to a review — including while the readiness checks
          are still running, so the spinner is never a dead end and the control does not change
          identity underneath a finger. Every other state has exactly one exit of its own: Cancel
          out of the review, Continue out of an outcome or a fail-closed branch. */}
      <View style={S.sheetHead}>
        <Text style={S.sheetTitle}>{P.sheetTitle}</Text>
        {phase === 'request' && (blocker === null || blocker.kind === 'loading') ? (
          <Pressable
            testID="btn-practice-skip"
            style={S.sheetClose}
            onPress={onDone}
            accessibilityRole="button"
            accessibilityLabel={P.skip}
            accessibilityState={{disabled: false}}>
            <IconClose size={18} color={C.sub} />
          </Pressable>
        ) : null}
      </View>
      {/* The request phase centers its short content in the frame (walkBodyCenter); every other
          branch — blocked, outcome, review — keeps the plain body layout it was designed with. */}
      <ScrollView
        style={S.walkScroll}
        contentContainerStyle={phase === 'request' && blocker === null ? [S.walkBody, S.walkBodyCenter] : S.walkBody}>
        {blocker !== null ? (
          <Blocked blocker={blocker} onRetry={() => setAttempt(a => a + 1)} />
        ) : phase === 'outcome' && outcome !== null ? (
          <Outcome outcome={outcome} amount={fmt(PRACTICE_AMOUNT_RAW)} left={settledBalance === null ? null : fmt(settledBalance)} />
        ) : phase === 'review' && intent !== null ? (
          <PaymentReview
            catalog={catalog}
            intent={intent}
            // Never the user's own account: the practice payee is `PRACTICE_PAYEE_PUBKEY`, a fixed
            // keyless address nobody holds the key to, which is the whole reason the money is gone
            // for good rather than round-tripping. Stated rather than computed.
            isSelf={false}
            // Practice only ever reaches this screen with a balance it has just READ, so the
            // warn-but-allow case the Pay tab keeps for a stale offline balance cannot arise here:
            // a shortfall is known, and a known shortfall blocks.
            insufficient={shortfall}
            blockApprove={shortfall}
            err={err}
            busy={busy}
            onApprove={() => void approve(intent)}
            onCancel={() => { setPhase('request'); setIntent(null); setErr(null); }}
            notes={
              <>
                {/* The fee, from the asset's own catalog row — DEMO registers none, so the line
                    says who decides it rather than printing a 0 that would be a claim. */}
                {/* `alignSelf` because a review row is a label/value PAIR that must sit on the
                    two edges of the column; the mode surface centres its children, which would
                    otherwise shrink the row to its own content and float it. */}
                <View style={[S.reviewRow, {alignSelf: 'stretch'}]}>
                  <Text style={S.reviewRowLabel}>{M.withdraw.send.feeLine('')}</Text>
                  <Text testID="practice-fee" style={S.reviewRowValue}>
                    {catalogFee(catalog, fmt)}
                  </Text>
                </View>
                <Text testID="practice-both-sides" style={S.dim2}>{P.bothSides}</Text>
              </>
            }
          />
        ) : (
          <>
            <Text style={S.walkTitle}>{P.title}</Text>
            <Text testID="practice-balance" style={S.rehStepBody}>
              {balance === null ? '' : P.balance(fmt(balance))}
            </Text>
            {/* The request card, in the walkthrough's own visual grammar: a corner stage tag, the
                payee, the amount. It is what the wire request actually carries. */}
            <View testID="practice-card" style={S.rehStep}>
              <View style={S.rehBadge}><Text style={S.rehBadgeText}>{P.eyebrow}</Text></View>
              <Text style={S.rehStepTitle}>{P.payeeName}</Text>
              {/* The review's amount type, left-aligned: this card is a left-flowing block in the
                  walkthrough's grammar, and a centred amount inside it reads as a stray. */}
              <Text style={[S.reviewAmount, {textAlign: 'left', marginTop: 2}]}>{fmt(PRACTICE_AMOUNT_RAW)}</Text>
              <Text style={S.rehStepBody}>{P.cardLine}</Text>
            </View>
            {err ? <Text testID="practice-err" style={S.err}>{err}</Text> : null}
          </>
        )}
      </ScrollView>
      <View style={S.walkFooter}>
        <Text
          testID="practice-punchline"
          style={[S.walkCampaignText, {textAlign: 'center', textTransform: 'none', letterSpacing: 0.4, fontSize: 12.5, lineHeight: 18, flex: 0}]}>
          {P.punchline}
        </Text>
        {primary}
      </View>
    </SafeAreaView>
  );
}

/**
 * Ask the relay for practice money. Onboarding already asked once, on create; this is the second
 * ask, and it exists because the first one can legitimately have failed (a slow relay, an app
 * killed between create and here) and because a user staring at ∂0.00 is entitled to know WHY
 * rather than to a screen that simply cannot proceed.
 *
 * Every answer that is not a credit is one of the named branches, so no failure here reaches the
 * screen as a spinner or a raw error.
 */
async function askForPracticeMoney(relayUrl: string, publicHex: string): Promise<{kind: 'credited'; balance: string} | NonNullable<Blocker>> {
  try {
    const r = await fetchWithTimeout(`${base(relayUrl)}/api/v1/faucet`, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({account: publicHex, amount: TOP_UP_CENTS}),
    }, FAUCET_TIMEOUT_MS);
    const j = await readJsonOrEmpty(r);
    if (r.ok && typeof j.balance === 'string') return {kind: 'credited', balance: j.balance};
    // The relay's own reason, VERBATIM — it is the only thing that carries the retry time
    // ("faucet cooldown: try again in ~58 min"). A refusal with no reason is not a cooldown and
    // must not claim to be one, so it falls to the plain empty-balance branch instead.
    const reason = typeof j?.error === 'string' && j.error.length > 0 ? j.error : null;
    if (reason === null) console.warn(`practice: the faucet answered HTTP ${r.status} with no reason`);
    return reason === null ? {kind: 'empty'} : {kind: 'cooldown', reason};
  } catch (e) {
    console.warn('practice: faucet request failed:', e instanceof Error ? e.message : String(e));
    return {kind: 'offline'};
  }
}

/** The registered ledger fee for practice money, or who sets it when the catalog registers none.
 *  Never `0`: an unregistered fee is unknown, and printing zero would be a claim about money. */
function catalogFee(catalog: Array<{currency: number; fee: string | null}>, fmt: (raw: string) => string): string {
  const desc = catalog.find(c => c.currency === PRACTICE_CURRENCY) ?? null;
  return desc?.fee == null ? M.withdraw.send.feeUnknown : fmt(desc.fee);
}

/** The outcome, whatever actually happened. Three states, and exactly one of them is a success. */
function Outcome({outcome, amount, left}: {outcome: Outcome; amount: string; left: string | null}) {
  const P = M.education.practice;
  const settled = outcome.kind === 'settled';
  return (
    <View testID="practice-outcome" style={S.center}>
      {/* Three marks for three outcomes, and the difference between the last two is the whole
          point: a clock means "not known yet", and a refusal IS known — it is simply a no. */}
      <View style={[S.check, !settled && S.checkAlready]}>
        {settled ? <IconCheck size={44} color={C.brandInk} />
          : outcome.kind === 'unknown' ? <IconClock size={44} color={C.brandInk} />
          : <IconAlert size={44} color={C.brandInk} />}
      </View>
      <Text style={[S.paidText, !settled && S.alreadyText]}>
        {settled ? M.nfc.paidAmount(amount) : outcome.kind === 'unknown' ? M.pay.sent(amount) : P.refusedTitle}
      </Text>
      {/* Centred: the pay screen's `paidSub` carries one short line, and this one is a whole
          sentence that wraps — left-ragged text under a centred mark reads as a layout bug. */}
      <Text testID="practice-outcome-body" style={[S.paidSub, {textAlign: 'center'}]}>
        {settled ? P.settledBody : outcome.kind === 'unknown' ? P.pendingBody : P.refusedBody}
      </Text>
      {/* The ledger's own decoded words, verbatim — the payer is entitled to the actual reason. */}
      {outcome.kind === 'rejected' ? <Text testID="practice-refused-reason" style={S.warnNote}>{outcome.reason}</Text> : null}
      {settled && left !== null ? <Text testID="practice-left" style={S.dim2}>{P.settledBalance(left)}</Text> : null}
    </View>
  );
}

/** The four fail-closed branches. Each names what happened and what the user can do; none of them
 *  shows a deposit address, a fundable QR or an add-money action (anti-scam rule R1). */
function Blocked({blocker, onRetry}: {blocker: NonNullable<Blocker>; onRetry: () => void}) {
  const P = M.education.practice;
  if (blocker.kind === 'loading') {
    return <View style={S.center}><ActivityIndicator size="large" color={C.brandText} /></View>;
  }
  if (blocker.kind === 'offline') {
    return <InstructionPanel testID="practice-offline" title={P.offline.title} body={P.offline.body} onRecheck={onRetry} />;
  }
  if (blocker.kind === 'noFaucet') {
    return <InstructionPanel testID="practice-nofaucet" title={P.noFaucet.title} body={P.noFaucet.body} />;
  }
  if (blocker.kind === 'cooldown') {
    return <InstructionPanel testID="practice-cooldown" title={P.cooldown.title} body={P.cooldown.body(blocker.reason)} />;
  }
  return <InstructionPanel testID="practice-empty" title={P.empty.title} body={P.empty.body} onRecheck={onRetry} />;
}
