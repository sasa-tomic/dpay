import {useEffect, useState} from 'react';
import {View, Text, Pressable, ActivityIndicator, Platform} from 'react-native';
import {QrCode} from './QrCode';
import {InstructionPanel} from './InstructionPanel';
import {NfcTap} from './NfcTap';
import {NfcStatusRow} from './NfcStatusRow';
import {NfcIcon} from './NfcIcon';
import {C} from '../config/palette';
import {S} from '../styles';
import {NFC_UPDATE_AHEAD_S, POLL, PROOF_POLL_BUDGET, QR_SIZE} from '../config/constants';
import {fmtAsset, fmtAssetCompact, nowSecs, short} from '../lib/format';
import {offerNamesAsset} from '../lib/opencryptopay';
import type {CurrencyDescriptor} from '../config/catalog';
import type {SelectableAsset} from '../config/assets';
import {currencyOfAsset} from '../config/currency';
import {tokenEq} from '../config/assets';
import type {AssetId, Identity, NfcStatus} from '../lib/types';
import {DpayCore, DpayNfc} from '../services/native';
import {icStampExpiry} from '../services/icp';
import {preparePull, submitTransfer} from '../services/rail';
import {saveTxNote} from '../services/txNotes';
import {
  CHECKOUT_OFFER, cancelCheckoutCharge, openCheckoutCharge, priceCents, checkoutChargeStatus, checkoutPriceUnits, checkoutRawUnits,
  checkoutSettlementAssets, checkoutSettlementShape,
  type CheckoutCharge as Charge, type CheckoutOpenOutcome, type CheckoutSettled, type CheckoutVoidOutcome,
} from '../services/checkout';
import {useReportLock} from '../hooks/useReportLock';
import {IconCheck, IconClock} from './icons';
import {M} from '../i18n';

/**
 * The counter: a cashier opens a charge in francs, shows a code, and watches it be paid.
 *
 * WHERE THIS LIVES, AND WHY IT IS NOT A TAB. A checkout charge is not a third kind of receiving — it is
 * the SAME request with a wider audience — so it sits inside Receive ▸ Request payment beside the
 * checkout-code CHECKBOX: the amount row and the message row are the dpay-code form's own, shared, and
 * the checkbox is what flips the single button from building a dpay payment link to opening a
 * checkout charge. The message row is the ONE box in both modes (founder 2026-09-14): same input, same
 * place, same text whether or not the checkbox is checked — in checkout mode its text is the signed
 * note, and it arrives here as a prop exactly like the amount does. The
 * `[ Request payment | My address ]` toggle is structurally two-segment and widening it would assert
 * a distinction that does not exist. Two QR payloads cannot share one frame, which is the only
 * reason there is a checkbox at all: the request screen already runs QR and NFC reader mode at the
 * same time with no per-payment toggle.
 *
 * BOTH RAILS MOUNT THIS, and that is the point (the same-surfaces hard rule). The checkbox renders
 * for every asset on both Receive forms; a control that appeared only for VCHF would be exactly the
 * per-rail special case the rule forbids. What differs is the ANSWER: a checkout code is paid in VCHF
 * on the Internet Computer and in nothing else (`crates/dpay-relay/src/checkout.rs`), so every other
 * asset — ckBTC, ICP, SOL, USDC on Solana — lands on a refusal that names it, names the rail, and
 * offers the one tap that fixes it.
 *
 * THE PAID LIGHT IS THE RELAY'S ANSWER, NEVER THIS SCREEN'S INFERENCE. A charge settles when the
 * relay OBSERVES money arriving on the merchant's own ledger — including from a payer who never
 * touched the OpenCryptoPay endpoints — so nothing here may conclude anything from a countdown, a
 * scan, a TAP, or the absence of an answer. The status route deliberately exposes no quote count and
 * no "scanned" signal, so this screen cannot claim the customer is looking at it, and an unreadable
 * poll says "can't check" rather than "unpaid" (`services/checkout.ts`, rule 2).
 *
 * A DPAY PAYER CAN ALSO TAP IT, and that costs the standard nothing. While a charge is up this
 * screen ALSO arms the IC reader with a 132-byte request built from the charge itself — the price in
 * VCHF, this wallet's own account, and `charge.reference` as the request NONCE. `prepareNfcTransfer`
 * puts that nonce on the transfer as its ICRC-1 memo, which is exactly the value the relay's
 * `match_payment` credits this sale on, so a tap settles the SAME charge a scan would with no second
 * crediting path, no new AID and no protocol change. The tap is not the settlement: `onSettled` is
 * deliberately NOT passed to `NfcTap`, so nothing the radio does can turn this light green — the
 * relay's poll is the only thing that can. And a tap in flight OWNS the screen (the `nfcActive`
 * branch below, the same rule `ReceiveMode` applies), because a tap's own "not confirmed" beside the
 * checkout's "paid" would be two answers to one question and the cashier would learn to trust neither.
 *
 * The tap window is SHORTER than the code's life and says so. The request carries a certified IC
 * ingress expiry (`NFC_UPDATE_AHEAD_S`, minutes) while a charge stays payable for the relay's own
 * hour, so a code outlives its own tappability — stated on screen rather than left to fail silently,
 * with the next action named (scan it, or open a fresh charge).
 */

type EndReason = 'expired' | 'cancelled' | 'superseded' | 'gone';

/** The armed reader, built from a live charge. `expiry` is the request's own certified deadline —
 *  held beside the hex because it is what decides whether a NEW tap can still start. `reqInfo.amount`
 *  stays the settlement wire; `displayAmount` is the opened price the readout headlines (founder rule
 *  2026-09-14). */
type Tap = {requestHex: string; reqInfo: {amount: string; displayAmount?: string; nonce: string; who: string; currency: number}; expiry: number};

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
  | {k: 'paid'; charge: Charge; paid: CheckoutSettled | null; late: boolean}
  | {k: 'ended'; reason: EndReason}
  /** The checkout-open did not happen. The outcome is carried whole so the panel can say WHICH way it
   *  failed — the four causes send the merchant to do four different things. */
  | {k: 'failed'; outcome: Exclude<CheckoutOpenOutcome, {kind: 'open'}>};

export function CheckoutCharge({identity, relayUrl, asset, assets, catalog, nfcStatus, onRepickAsset, amount, note, onHoldsForm}: {
  identity: Identity;
  relayUrl: string;
  /** The asset the wallet is currently on — the one the whole Receive tab is about. */
  asset: SelectableAsset | null;
  assets: SelectableAsset[];
  /** The IC currency rows. Needed for the same reason the dpay-code form needs them: the reader
   *  resolves the request's currency to the LEDGER it submits the payer's envelope to. */
  catalog: CurrencyDescriptor[];
  /** The radio's 4-state answer, not a boolean — "off", "unsupported" and "unknown" send the
   *  cashier to three different places, and `NfcStatusRow` owns those instructions for every
   *  surface in the app. */
  nfcStatus: NfcStatus;
  // The checkout's OWN re-pick (the pills, the wrong-asset fix, the served-other fix): the charge
  // re-decides which asset it is about, and the wallet's selection FOLLOWS it — one truth. This is
  // the programmatic move (Wallet's selectAsset), never the user-gesture handler: the served-other
  // fix fires while the held form still holds the selection lock, and a lock-respecting select
  // would silently bounce, leaving a dollar badge over a franc charge (found 2026-09-24).
  onRepickAsset: (id: AssetId) => void;
  /** The price typed into the SHARED amount row above (the parent owns the input; this component
   *  owns what a checkout charge does with it). In francs, like every checkout input — parsed here by the
   *  checkout's own 2-decimal rule, never by the parent's per-asset one. */
  amount: string;
  /** The message typed into the SHARED message row above — the ONE box that stays mounted, in the
   *  same place, whether or not the checkout checkbox is checked (founder 2026-09-14: the box must not
   *  move, restyle or reset on the toggle; the parent owns input + state, this component owns what
   *  a checkout charge does with it). It is the charge's signed note: what the payer sees on review,
   *  trimmed here, and kept for the next charge for the same reason the amount is. */
  note: string;
  /** Fires from the first checkout-open attempt until the cashier presses "next customer" — every phase
   *  that is not the entry tail — so the parent can hide the shared amount row and the checkbox and
   *  lock the asset selection. Flipping away from a live code would leave a payable charge on
   *  screen nowhere, and leaving the row up under a Paid screen would answer a question nobody
   *  asked. */
  onHoldsForm?: (held: boolean) => void;
}) {
  const [phase, setPhase] = useState<Phase>({k: 'entering'});
  /** The price the last checkout-open ATTEMPTED, in cents — what a failure panel quotes back. Kept beside
   *  the charge rather than re-parsed from the input, so the number in the message is the number
   *  that was actually signed and sent. */
  const [entered, setEntered] = useState<string | null>(null);
  /** The poll could not reach the checkout. NOT a payment state — see the component doc. */
  const [unchecked, setUnchecked] = useState<string | null>(null);
  /** The relay says the code has expired and we are still watching for a late transfer. */
  const [watchingLate, setWatchingLate] = useState(false);
  /** A customer approved this shop to COLLECT rather than sending the money, and this phone is
   *  spending that allowance right now. Display only — it never turns the paid light green, which
   *  stays the relay's own answer (see the component doc). */
  const [collecting, setCollecting] = useState(false);
  /** Why a collection did not work, in the cashier's terms. Not a payment state either: the charge
   *  stays open and payable by every other means. */
  const [collectErr, setCollectErr] = useState<string | null>(null);
  /** Claims this screen has already acted on, as `payer@at_secs`. A pull is attempted ONCE per
   *  claim: the ledger's verdict does not change between polls, and a doomed one retried every
   *  1.5 s would be a loop with a cashier watching it. */
  const [tried] = useState<Set<string>>(() => new Set());
  const [err, setErr] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [now, setNow] = useState(() => nowSecs());
  /** The reader armed for the live charge, or null when this phone could not build one (no radio,
   *  or the certified clock the request's expiry needs was unreachable). Null is QR-only, said out
   *  loud — never a tap that silently does nothing. */
  const [tap, setTap] = useState<Tap | null>(null);
  /** A tap is mid-exchange. It owns the screen while it is — see the component doc. */
  const [nfcActive, setNfcActive] = useState(false);
  /** Remounts the reader: after a completed exchange its state machine is terminal, so a customer
   *  re-tapping a charge that is still open needs a fresh one. */
  const [nfcKey, setNfcKey] = useState(0);

  // The radio is either usable or it is not; the three ways it can be unusable are `NfcStatusRow`'s
  // business, and this boolean is only the local "can a tap happen at all" gate.
  const nfcReady = nfcStatus === 'ready';

  // THE SETTLEMENT RULE (multi-currency build-out, 2026-09). The checkout prices in the merchant's
  // own currency and settles 1:1 into that currency's token, so the cashier PICKS the settlement
  // asset at open (`checkoutSettlementAssets` — the assets `services/checkout.ts` admits: IC, mainnet,
  // catalog fee stated, a home currency). The PAYER keeps the fixed `CHECKOUT_OFFER` pair: a payer is
  // told the asset by the code they scan, and never chooses.
  //
  // Three rows matter, and they are kept apart on purpose:
  //   • `checkoutRows` — every asset this counter may open a charge in (the picker's options);
  //   • `servedRow` — the row the checkout's provider NAMES (`CHECKOUT_OFFER`, the relay's own served
  //     pair) — the wrong-asset refusal's one-tap fix, exactly as before the picker existed;
  //   • `picked` — the asset THIS checkout-open settles in: the cashier's pick, defaulting to the row
  //     the wallet is on when that row is a settlement asset itself. Price unit, ledger fee,
  //     decimals and the armed tap all follow it.
  const checkoutRows = checkoutSettlementAssets(assets, catalog);
  const servedRow = checkoutRows.find(a => offerNamesAsset(CHECKOUT_OFFER, a)) ?? null;
  // The asset the wallet is on, narrowed to the checkout's own shape (IC rail — `checkoutSettlementShape`
  // decides the rest: mainnet, a home currency, a price the currency's two decimals can express).
  // This is the ENTRY gate, unchanged in shape since the counter was single-asset: a checkout code is
  // offered on the checkout's own rows, and every other row is refused by name (flow 115 pins that).
  const checkoutRow = asset !== null && asset.protocol === 'ic' && checkoutSettlementShape(asset, catalog) ? asset : null;
  // The LEDGER's transfer fee for the selected row, read from the catalog the relay itself serves —
  // the fee the SHOP absorbs, so a customer's account moves by the price and nothing more
  // (`checkoutRawUnits`, `services/checkout.ts`). A row that states no fee cannot be priced honestly here:
  // quoting the full price would silently charge the customer the fee on top, which is the exact
  // thing this is for, so the counter refuses instead (`payable` below).
  const checkoutFeeRaw = checkoutRow !== null ? catalog.find(c => c.currency === checkoutRow.currency)?.fee ?? null : null;
  // The cashier's settlement pick. Kept as an id and re-resolved every render, so a catalog
  // change can never leave it naming a row the wallet no longer carries.
  const [settleId, setSettleId] = useState<AssetId | null>(null);
  const picked = (settleId !== null ? checkoutRows.find(a => a.id === settleId) : null)
    ?? checkoutRow // the wallet's own row, when it is a settlement asset — today's behaviour, unchanged
    ?? servedRow;
  // The picked row's own fee — the same honesty gate as the selected row's above. Non-null for
  // every `checkoutSettlementRow` answer by construction; the null check keeps the checkout-open honest even
  // so (a fee guessed at would be a customer charged one).
  const pickedFee = picked !== null && picked.protocol === 'ic'
    ? catalog.find(c => c.currency === picked.currency)?.fee ?? null
    : null;
  const payable = picked !== null && pickedFee !== null && checkoutRow !== null && checkoutFeeRaw !== null;
  // The picked asset's own currency — the PRICE unit. ISO 4217 letters in every locale, like the
  // franc was when the counter was single-asset: a unit, never a translated word.
  const priceUnit = picked !== null ? currencyOfAsset(picked) ?? 'CHF' : 'CHF';

  // Reported to the parent through the SAME hook every other engine reports its selection lock
  // with: the contract is identical (report each change, reset on unmount, parent's setter is a
  // stable `useState` setter), and a live checkout charge is exactly a thing the wallet must not be
  // switched out from under. `held` is broader than the live charge: a paid, ended or failed
  // screen still replaces the entry form, so the parent's shared rows stay hidden through all of
  // them — and come back exactly when the cashier presses the button that restarts the form.
  const held = phase.k !== 'entering' && phase.k !== 'opening';
  useReportLock(onHoldsForm, held);

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
      const answer = await checkoutChargeStatus(relayUrl, chargeId);
      if (!alive) return;
      if (answer.kind === 'unchecked') { setUnchecked(answer.detail); return; }
      setUnchecked(null);
      if (answer.kind === 'gone') { setPhase({k: 'ended', reason: 'gone'}); return; }
      const s = answer.status;
      // A CUSTOMER WHO APPROVED INSTEAD OF SENDING. Their wallet cannot move the money and the
      // relay must not, so this phone — which holds the key the allowance names — collects it.
      // Attempted once per distinct claim: a doomed pull retried on every poll would hammer the
      // ledger and tell the cashier nothing new.
      if (s.pull !== null && phase.k === 'showing') void collect(s.pull, phase.charge);
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
    // `collect` and `phase` are read inside `tick` but deliberately NOT depended on: this effect is
    // keyed by the CHARGE, and re-running it on every phase change would restart the poll clock
    // mid-charge. `collect` guards its own re-entry by claim, and reads the charge it was handed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chargeId, relayUrl]);

  /**
   * COLLECT an allowance a customer granted this shop — the other way an OpenCryptoPay wallet pays.
   *
   * Oisy and wallets like it do not send money: they call `icrc2_approve` naming this shop as
   * spender and then tell the provider to take it. The relay cannot (it holds no key, by the
   * non-custody rule) and this phone can, because the allowance names the key this phone holds. So
   * the claim arrives on the poll and is spent here, with the charge's own reference as the memo —
   * without which the money would move and the sale would stay open.
   *
   * THIS DOES NOT SETTLE THE SALE. It moves money; the relay's next poll observes it on the ledger
   * and only that turns the light green — the same rule a tap obeys, and for the same reason: one
   * settlement owner. A pull that fails leaves the charge exactly as payable as it was.
   */
  async function collect(claim: {payer: string; atSecs: number}, charge: Charge) {
    if (picked === null || picked.protocol !== 'ic' || pickedFee === null) return;
    const key = `${claim.payer}@${claim.atSecs}`;
    if (tried.has(key)) return;
    tried.add(key);
    setCollectErr(null);
    setCollecting(true);
    try {
      const me = await DpayCore.icpPrincipalFromPubkey(identity.publicHex);
      const prepared = await preparePull(identity.secretHex, {currencies: catalog}, {
        fromAccount: claim.payer,
        toAccount: me,
        amount: checkoutRawUnits(charge.cents, picked.decimals, pickedFee),
        currency: picked.currency,
        nonceHex: charge.reference,
      });
      const outcome = await submitTransfer(
        prepared, identity.secretHex, PULL_POLL,
        hex => DpayCore.icpDecodeTransferFromResult(hex),
      );
      // 'settled' says the ledger moved it; the RELAY still has to see it, so nothing is claimed
      // here. 'unknown' is honest ignorance and is left to the same poll — the money may well have
      // moved. Only a refusal is worth a sentence, because only a refusal needs the cashier.
      if (outcome.kind === 'rejected') setCollectErr(collectRefusal(outcome.variant ?? ''));
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      console.warn(`checkout: could not collect the approval for ${charge.id}: ${detail}`);
      setCollectErr(M.receive.checkout.collectFailed);
    } finally {
      setCollecting(false);
    }
  }

  /** The 132-byte reader request for a live charge, or null when this phone cannot serve one — no
   *  radio, or the certified IC instant its expiry needs was out of reach. Null is a QR-only code
   *  and is said out loud on screen; it is never a tap that quietly does nothing.
   *
   *  THE NONCE IS THE CHARGE'S REFERENCE, and that single line is what makes a tap credit a sale:
   *  `prepareNfcTransfer` writes the request's nonce onto the payer's transfer as its ICRC-1 memo,
   *  and the relay credits only a transfer whose memo is this charge's reference. A tap built with
   *  a nonce of this wallet's own would move the customer's money and leave the sale open. */
  async function armReader(charge: Charge, row: Extract<SelectableAsset, {protocol: 'ic'}>, feeRaw: string, note: string): Promise<Tap | null> {
    if (!nfcReady || !DpayNfc) return null;
    // THE SETTLEMENT AMOUNT, not the price — the same number the QR quotes, so a tap and a scan
    // pay the identical sale and the shop absorbs the fee either way.
    const amountRaw = checkoutRawUnits(charge.cents, row.decimals, feeRaw);
    try {
      const expiryNs = await icStampExpiry(identity.secretHex, NFC_UPDATE_AHEAD_S);
      const expiry = Number(BigInt(expiryNs) / 1_000_000_000n);
      // The opened-note rides the tap request as its DISPLAY memo — what the payer's phone shows
      // while it asks them to confirm. The SETTLEMENT memo is and stays `charge.reference`.
      const requestHex = await DpayNfc.buildRequest(
        identity.publicHex, amountRaw, charge.reference, expiry, row.currency, identity.username, note,
      );
      return {
        requestHex,
        // `displayAmount` is the opened price (founder rule 2026-09-14): the merchant's tap readout
        // headlines it while `amount` stays the settlement wire the ledger-match uses.
        reqInfo: {amount: amountRaw, displayAmount: checkoutPriceUnits(charge.cents, row.decimals), nonce: charge.reference, who: M.receive.payer, currency: row.currency},
        expiry,
      };
    } catch (e) {
      console.warn(`checkout: could not arm a tap for ${charge.id} - the code still scans: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  async function openCharge() {
    // The checkout's own row is what makes a charge both priceable and tappable: its precision turns
    // rappen into raw units, and its currency is what the tap request names. Its LEDGER FEE is
    // what makes the price honest — the shop pays it out of the price. Neither can be missing by
    // the time this runs (both are the render's own `payable` gate, which returns a panel instead
    // of this form), and neither is defaulted here: a fee guessed at would be a customer charged
    // one.
    if (picked === null || picked.protocol !== 'ic' || pickedFee === null) return;
    const parsed = priceCents(amount);
    if (!parsed.ok) { setErr(M.receive.checkout.badAmount(parsed.reason)); return; }
    // One spelling of the note everywhere it travels: the signed body, the wire key, the payer's
    // tap-request display, and the history annotation below. Whitespace-only is nothing.
    const noteVal = note.trim();
    setErr(null);
    setUnchecked(null);
    setWatchingLate(false);
    setTap(null);
    setNfcActive(false);
    setNfcKey(k => k + 1);
    setEntered(parsed.cents);
    setPhase({k: 'opening'});
    const outcome = await openCheckoutCharge(relayUrl, identity, parsed.cents, picked.decimals, pickedFee, noteVal, picked.linkToken ?? picked.symbol);
    if (outcome.kind !== 'open') { setPhase({k: 'failed', outcome}); return; }
    // The payee-side annotation, the same save the dpay form makes: keyed by the charge's
    // reference — the memo the incoming transfer carries, so the history row this sale settles
    // into shows what it was for. No `who`: whoever pays is exactly what a checkout does not know at
    // checkout-open time. Founder rule 2026-09-14: the note carries the GROSS (the opened price — the row
    // headlines it) + the fee (its annotation line); the wire stays the ledger truth. The checkout's
    // fee gate above makes both non-null here — the save always carries them.
    void saveTxNote(identity.publicHex, {k: outcome.charge.reference, msg: noteVal || undefined, gross: checkoutPriceUnits(parsed.cents, picked.decimals), fee: pickedFee}, Date.now());
    setNow(nowSecs());
    setPhase({k: 'showing', charge: outcome.charge});
    // The code goes up FIRST and the reader is armed after it: building the request needs a
    // certified IC instant, and a customer must never wait on the radio for a code they can scan.
    setTap(await armReader(outcome.charge, picked, pickedFee, noteVal));
  }

  async function cancel() {
    if (cancelling) return;
    setCancelling(true);
    setErr(null);
    const outcome = await cancelCheckoutCharge(relayUrl, identity);
    setCancelling(false);
    if (outcome.kind === 'cancelled') { setPhase({k: 'ended', reason: 'cancelled'}); return; }
    // Still showing, still polling: a cancellation that did not happen leaves a payable code, and
    // the merchant has to be told that rather than shown a cleared checkout.
    setErr(cancelRefusal(outcome));
  }

  /** Back to an empty counter. The amount and the note are the PARENT's (the shared rows above)
   *  and are kept untouched — a mis-keyed total is retyped, a refused one is usually opened
   *  again unchanged, and the next charge is almost always for the same thing. */
  function reset() {
    setPhase({k: 'entering'});
    setUnchecked(null);
    setWatchingLate(false);
    setErr(null);
    // The reader was armed for the charge that just ended. Dropping it (and remounting on the next
    // checkout-open) is what stops a tap arriving against a request whose reference names a dead sale.
    setTap(null);
    setNfcActive(false);
    setNfcKey(k => k + 1);
  }

  if (checkoutRow !== null && checkoutFeeRaw === null) {
    // The right asset, and still not priceable: the shop pays the ledger fee out of the price, so a
    // catalog row that states no fee leaves nothing to subtract. Quoting the full price instead
    // would put the fee back on the customer silently — the one outcome this whole rule exists to
    // prevent — so the counter closes and names the fix rather than opening a charge for a wrong number.
    return (
      <InstructionPanel
        testID="checkout-no-fee"
        title={M.receive.checkout.noFeeTitle}
        body={M.receive.checkout.noFee(checkoutRow.symbol, relayHost(relayUrl))}
      />
    );
  }

  if (!payable) {
    // Every asset reaches this control, and every asset that is not one the checkout can settle lands
    // here by name. `servedRow` is the one tap that fixes it — the row the checkout's provider NAMES —
    // and when this wallet carries no settlement asset at all there is no tap to offer, so the
    // panel says so instead of showing a button that cannot work.
    return (
      <InstructionPanel
        testID="checkout-refused"
        title={M.receive.checkout.wrongAssetTitle}
        body={servedRow === null
          ? M.receive.checkout.noCheckoutAsset
          : M.receive.checkout.wrongAsset(asset?.symbol ?? '', asset?.network ?? null)}
        primaryLabel={servedRow ? M.receive.checkout.switchTo(servedRow.symbol) : undefined}
        onPrimary={servedRow ? () => onRepickAsset(servedRow.id) : undefined}
      />
    );
  }

  // The armed reader. Mounted while a charge is up and its request is still inside its certified
  // expiry, and KEPT mounted through an exchange that has already started (`nfcActive`) — including
  // across the poll flipping the charge to paid underneath it, because the merchant still owes the
  // payer's phone its signed result. It renders nothing until a real tap begins.
  //
  // NO `onSettled`. The tap must not be able to turn the paid light green; only the relay's own
  // answer may (see the component doc).
  const tapLive = tap !== null && now < tap.expiry;
  const tapNode = tap !== null && (tapLive || nfcActive) && DpayNfc ? (
    <NfcTap
      key={nfcKey} role="reader" identity={identity} relayUrl={relayUrl}
      requestHex={tap.requestHex} reqInfo={tap.reqInfo} catalog={catalog}
      onActive={() => setNfcActive(true)}
      onClose={() => { setNfcActive(false); setNfcKey(k => k + 1); }}
    />
  ) : null;

  // A tap in flight OWNS the screen. Two settlement surfaces at once — the tap's own "not
  // confirmed" beside the checkout's "waiting" or "paid" — would be two answers to one question, and a
  // cashier who is shown that learns to distrust both. Placed BEFORE every phase branch so the
  // exchange survives the charge settling underneath it.
  if (nfcActive && tapNode) {
    return <View style={S.center}>{tapNode}</View>;
  }

  if (phase.k === 'failed' && phase.outcome.kind === 'served-other') {
    // The checkout opened the charge in what IT serves, not what was picked. The money path is right
    // (the charge pays this merchant) but the asset is not the one the counter chose, so nothing
    // is shown; the fix is one tap — re-pick the served asset and open a fresh charge.
    const servedToken = phase.outcome.served;
    const served = checkoutRows.find(a => tokenEq(a.linkToken ?? a.symbol, servedToken)) ?? null;
    return (
      <InstructionPanel
        testID="checkout-failed"
        title={M.receive.checkout.failedTitle}
        body={M.receive.checkout.servedOther(servedToken, priceUnit)}
        primaryLabel={served ? M.receive.checkout.switchTo(served.symbol) : M.receive.checkout.tryAgain}
        onPrimary={served
          ? () => { setSettleId(served.id); onRepickAsset(served.id); reset(); } // re-pick moves the wallet's asset too — one truth (see the pills)
          : reset}
      />
    );
  }

  if (phase.k === 'failed' && phase.outcome.kind !== 'served-other') {
    return (
      <InstructionPanel
        testID="checkout-failed"
        title={M.receive.checkout.failedTitle}
        body={failureBody(phase.outcome, fmtAsset(entered ?? "0", 2, priceUnit))}
        primaryLabel={M.receive.checkout.tryAgain}
        onPrimary={reset}
      />
    );
  }

  if (phase.k === 'ended') {
    return (
      <InstructionPanel
        testID="checkout-ended"
        title={M.receive.checkout.endedTitle(phase.reason)}
        body={M.receive.checkout.endedBody(phase.reason)}
        primaryLabel={M.receive.checkout.openChargeNext}
        onPrimary={reset}
      />
    );
  }

  if (phase.k === 'paid') {
    return (
      <View style={S.center}>
        <View style={S.check}><IconCheck size={44} color={C.brandInk}/></View>
        <Text testID="checkout-paid" style={S.paidText}>{M.receive.checkout.paidAmount(fmtAsset(phase.charge.cents, 2, priceUnit))}</Text>
        {phase.paid ? <Text style={S.paidSub}>{M.receive.fromWho(short(phase.paid.from))}</Text> : null}
        {phase.paid ? <Text testID="checkout-paid-block" style={S.dim2}>{M.receive.checkout.paidBlock(phase.paid.block)}</Text> : null}
        {phase.late ? <Text testID="checkout-paid-late" style={S.dim2}>{M.receive.checkout.paidLate}</Text> : null}
        <Pressable
          testID="btn-checkout-new"
          style={[S.ghostBtn, S.ghostBtnMuted]}
          onPress={reset}
          accessibilityRole="button"
          accessibilityLabel={M.receive.checkout.openChargeNext}
          accessibilityState={{disabled: false}}>
          <Text style={S.ghostBtnText}>{M.receive.checkout.openChargeNext}</Text>
        </Pressable>
      </View>
    );
  }

  if (phase.k === 'showing') {
    const {charge} = phase;
    const remaining = charge.expiresAt - now;
    // `payable` above narrows the checkout-open to a priced asset; `picked` is the asset THIS charge
    // settles in, whose precision formats the settlement line. Two numbers, deliberately: what the
    // SHOP receives, beside the price the customer pays — they differ by the ledger fee the shop
    // now absorbs, and a cashier shown only the smaller one would read it as a misprice.
    const settles = fmtAssetCompact(
      checkoutRawUnits(charge.cents, picked.decimals, pickedFee ?? '0'), picked.decimals, picked.symbol, undefined, picked.minFractionDigits,
    );
    return (
      <View style={S.center}>
        {tapNode}
        {/* TWO DIFFERENT QUESTIONS, one line — the same split the dpay-code form makes. With a
            working radio the only thing left to say is whether THIS code can be tapped: live, past
            its certified expiry (the code still scans for the rest of its hour), or never built at
            all. With a radio that is off, absent or unreadable the question is about the PHONE, and
            `NfcStatusRow` owns those three instructions for every surface in the app. Web is
            neither — no radio to report on — so it keeps the per-code line. */}
        {nfcReady || Platform.OS === 'web' ? (
          <View style={S.nfcHintRow}>
            {tapLive ? <NfcIcon color={C.brandText} size={18} /> : null}
            <Text testID="checkout-tap-hint" style={S.nfcHintLabel}>
              {M.receive.checkout.showToCustomer(tapLive ? 'tap' : tap ? 'expired' : 'none')}
            </Text>
          </View>
        ) : (
          <NfcStatusRow nfcStatus={nfcStatus} testID="checkout-nfc" />
        )}
        <View testID="checkout-qr" style={S.qrCard}><QrCode value={charge.qr} size={QR_SIZE} ecl="M" /></View>
        <Text testID="checkout-amount" style={S.amountBig}>{fmtAsset(charge.cents, 2, priceUnit)}</Text>
        <Text style={S.qrHint}>{M.receive.checkout.settlesAs(settles, fmtAsset(charge.cents, 2, priceUnit))}</Text>
        {remaining > 60 ? (
          <View style={{flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6}}>
            <IconClock size={14} color={C.sub}/>
            <Text style={[S.qrExpiry, {marginTop: 0}]}>{M.receive.validForMin(Math.floor(remaining / 60))}</Text>
          </View>
        ) : remaining > 0 ? (
          <Text style={S.qrExpiryWarn}>{M.receive.expiresIn((remaining % 60).toString().padStart(2, '0'))}</Text>
        ) : null}
        {/* The four things this screen may say about the money, in the order they outrank each
            other: we are collecting an approval the customer granted (the one state where something
            is actively happening); we cannot see the checkout; the code has expired but a late transfer
            can still land; or we are simply waiting. None of them ever claims the customer has
            scanned anything, and none of them claims a sale — only the relay's own answer does. */}
        {/* `qrExpiryWarn` rather than `warnNote`: this line sits directly under the countdown, and
            warnNote's top margin (negative until the 2026-09-13 clearance fix) drew the warning ON
            TOP of the validity line. */}
        <Text testID="checkout-status" style={unchecked !== null || watchingLate ? S.qrExpiryWarn : S.qrHint}>
          {collecting
            ? M.receive.checkout.collecting
            : unchecked !== null
            ? M.receive.checkout.cantCheck
            : watchingLate ? M.receive.checkout.expiredWatching : M.receive.checkout.waiting}
        </Text>
        {/* A collection that did not work. It is NOT a payment state: the charge is still payable by
            every other means, which is exactly what each of these sentences goes on to say. */}
        {collectErr ? <Text testID="checkout-collect-err" style={S.err}>{collectErr}</Text> : null}
        {err ? <Text testID="checkout-err" style={S.err}>{err}</Text> : null}
        {cancelling ? <ActivityIndicator color={C.brandText} /> : null}
        <Pressable
          testID="btn-checkout-cancel"
          style={[S.ghostBtn, S.ghostBtnMuted, cancelling && S.disabledFlat]}
          disabled={cancelling}
          onPress={cancel}
          accessibilityRole="button"
          accessibilityLabel={M.receive.checkout.cancel}
          accessibilityState={{disabled: cancelling}}>
          <Text style={[S.ghostBtnText, cancelling && S.disabledText]}>{cancelling ? M.receive.checkout.cancelling : M.receive.checkout.cancel}</Text>
        </Pressable>
      </View>
    );
  }

  // phase 'entering' / 'opening' — the counter's entry tail. The amount row and the message row
  // above this are the PARENT's, shared with the dpay-code form (one box, both modes — founder
  // 2026-09-14); this component takes the typed price and the typed note from there and parses the
  // price with the CHECKOUT's own rule (`priceCents` — two decimals, a third is refused rather than
  // rounded, because a rounded price is a misprice). No submit-on-Enter from the shared rows: a
  // checkout-open is signed, so the button stays the only thing that does it.
  const opening = phase.k === 'opening';
  return (
    <View style={S.centerTop}>
      {err ? <Text testID="checkout-err" style={S.err}>{err}</Text> : null}
      {opening ? <ActivityIndicator color={C.brandText} /> : null}
      {/* THE SETTLEMENT PICKER — rendered only when more than one asset can settle (one option is
          not a choice, and its row alone is the answer). Each pill names the asset and, beside it,
          the currency the price is read in — the whole honest contract of a multi-asset checkout in
          one line. Same joined-pill language as the mode toggle, deliberately quieter than the
          checkout-open button. */}
      {checkoutRows.length > 1 ? (
        <View testID="checkout-settle" style={S.railRow}>
          {checkoutRows.map(r => {
            const on = picked !== null && r.id === picked.id;
            return (
              <Pressable
                key={r.id}
                testID={`checkout-asset-${(r.linkToken ?? r.symbol).toLowerCase()}`}
                style={[S.railPill, on && S.railPillActive, opening && S.dim]}
                disabled={opening}
                onPress={() => {
                  setSettleId(r.id);
                  // The pick moves the wallet's own selection too, so the shared amount field's
                  // unit badge above names the currency the price is ACTUALLY read in — a dollar
                  // pick must never sit under a franc badge (the same one-truth move the
                  // wrong-asset panel's "Switch to" button makes).
                  onRepickAsset(r.id);
                }}
                accessibilityRole="radio"
                accessibilityState={{checked: on}}
                accessibilityLabel={M.receive.checkout.settleOption(r.linkToken ?? r.symbol, currencyOfAsset(r) ?? '')}>
                <Text style={[S.railPillText, on && S.railPillTextActive]}>
                  {M.receive.checkout.settleOption(r.linkToken ?? r.symbol, currencyOfAsset(r) ?? '')}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {/* Never disabled for an empty amount (founder 2026-09-17): parity with the dpay form's
          always-tappable Show code. An empty or malformed total is refused by `priceCents` with the
          honest badAmount error, not by a greyed-out button that reads as broken. */}
      <Pressable
        testID="btn-checkout-open"
        style={[S.primaryWide, opening && S.disabledFlat]}
        disabled={opening}
        onPress={openCharge}
        accessibilityRole="button"
        accessibilityLabel={M.receive.request}
        accessibilityHint={M.receive.checkout.openChargeHint}
        accessibilityState={{disabled: opening}}>
        <Text style={[S.primaryText, opening && S.disabledText]}>{opening ? M.receive.creating : M.receive.request}</Text>
      </Pressable>
    </View>
  );
}

/** How long this phone waits for the ledger's verdict on a collection. Short and bounded: a
 *  customer is standing at the counter, the relay's own poll keeps running underneath, and an
 *  answer that has not arrived by then is honest ignorance rather than a failure — the money may
 *  well have moved, and the sale will turn green the moment the relay sees it. */
const PULL_POLL = {attempts: 12, intervalMs: 500} as const;

/** Why a collection was refused, in the cashier's terms — and every one of them ends somewhere.
 *  The variant tags are the ledger's own (`icp_decode_transfer_from_result`, dpay-ffi); an
 *  unrecognised one is not guessed at, because a wrong instruction at a checkout is worse than a
 *  general one. */
function collectRefusal(variant: string): string {
  switch (variant) {
    // The two that mean the CUSTOMER must do something, and they are opposite things: approve
    // again (or approve enough), versus put money in the account first.
    case 'InsufficientAllowance': return M.receive.checkout.collectNotApproved;
    case 'InsufficientFunds': return M.receive.checkout.collectNoFunds;
    default: return M.receive.checkout.collectFailed;
  }
}

/** The host a merchant would name when they ask why their checkout did not answer — the relay that was
 *  actually ASKED (the outcome's own address(es): under a walk that need not be the preferred
 *  URL, and once a session is pinned it never is). A URL this app could not parse falls back to
 *  the setting's own text, because an unparseable relay URL is exactly the thing the message
 *  needs to show them. */
function relayHost(relayUrl: string): string {
  try {
    return new URL(relayUrl).host;
  } catch (e) {
    console.warn(`checkout: the configured relay URL is not a URL (${relayUrl}): ${e instanceof Error ? e.message : String(e)}`);
    return relayUrl;
  }
}

/** Why the checkout-open did not happen, in the merchant's terms. Each arm ends somewhere different: turn
 *  the checkout on, check the connection, fix what the checkout named, or stop trusting this code. The
 *  addresses come from the OUTCOME (the relay that answered / did not answer), never from the
 *  wallet's preferred URL — a walk or a pin may have made a different relay the one that owes the
 *  merchant an explanation. */
function failureBody(outcome: Exclude<CheckoutOpenOutcome, {kind: 'open'} | {kind: 'served-other'}>, entered: string): string {
  switch (outcome.kind) {
    case 'not-served': return M.receive.checkout.notServed(relayHost(outcome.addr));
    case 'unreachable': {
      // The CLASSIFIED blame picks the sentence (work order 2026-09-30): offline blames nobody;
      // online says the connection is fine and names the relay(s) that did not answer.
      const hosts = outcome.tried.map(relayHost).join(', ');
      return outcome.blame === 'offline'
        ? M.receive.checkout.unreachableOffline(hosts)
        : M.receive.checkout.unreachable(hosts);
    }
    case 'unsigned': return M.receive.checkout.unsigned;
    case 'mispriced': return M.receive.checkout.mispriced(entered, outcome.quoted);
    case 'refused':
      return outcome.said !== null
        ? M.receive.checkout.refused(outcome.said)
        : M.receive.checkout.refusedNoReason(outcome.status);
  }
}

/** A cancellation that did not clear the checkout. The charge is STILL PAYABLE in every one of these
 *  cases, which is the fact the cashier needs — including the one where it was already paid, where
 *  the relay's own sentence names the block that paid it. */
function cancelRefusal(outcome: Exclude<CheckoutVoidOutcome, {kind: 'cancelled'}>): string {
  switch (outcome.kind) {
    // Wave-2: the SAME host attribution as the open path — the outcome carries the addresses
    // actually tried (the pin alone, or the whole walk), so the cashier reads WHO did not
    // answer instead of a generic "the checkout" that blames nobody and helps nobody.
    case 'unreachable': {
      const hosts = outcome.tried.map(relayHost).join(', ');
      // The CLASSIFIED blame picks the sentence (work order 2026-09-30); the charge stays
      // payable in BOTH arms — that fact never moves.
      return outcome.blame === 'offline'
        ? M.receive.checkout.cancelUnreachableOffline(hosts)
        : M.receive.checkout.cancelUnreachable(hosts);
    }
    case 'unsigned': return M.receive.checkout.unsigned;
    case 'refused':
      return outcome.said !== null
        ? M.receive.checkout.cancelFailed(outcome.said)
        : M.receive.checkout.cancelFailedNoReason(outcome.status);
  }
}
