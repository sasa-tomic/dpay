//! The merchant half of OpenCryptoPay — dpay **as** the provider.
//!
//! Everything else in this repo pays someone else's till. This serves one: a shop shows a code, any
//! OpenCryptoPay wallet (Cake, Phoenix, Binance, dpay) pays it, and the money lands at the
//! MERCHANT'S OWN account. Plan, and the founder decisions this implements:
//! `docs/specs/2026-09-02-merchant-side-plan.md`. Measured provider behaviour this must be
//! compatible with: `docs/specs/2026-09-01-opencryptopay-findings.md`.
//!
//! FOUR THINGS DECIDE THE WHOLE DESIGN.
//!
//! 1. **VCHF only, priced 1:1 with CHF.** A charge of CHF 10 is `10.00000000` VCHF. There is no
//!    exchange rate anywhere in this file, no price feed to fetch, nothing for dpay to quote and
//!    therefore nothing for dpay to be wrong about. The pricing problem is deleted, not solved —
//!    which is why v1 accepts exactly one asset and why adding a second is a policy decision, not a
//!    config line.
//!
//! 2. **Arrival is OBSERVED, never announced.** The payer reports a transaction identifier because
//!    the standard says so, and this module treats it as a hint and nothing more: settlement is
//!    decided by reading the MERCHANT's own incoming transfers on the charge's own ledger
//!    (`Ledger::transactions_on_ledger`, the same primitive the Receive tab's exact-memo
//!    reconciliation uses). That is a direct response to what the payer side cost us on 2026-09-03:
//!    DFX takes the reported index, looks it up on the WRONG ledger, and refuses a correct payment
//!    while keeping the money. A provider that never trusts a payer-supplied identifier cannot have
//!    that bug — the ledger is ours, chosen by us, and a lying payer can only fail to be credited.
//!
//! 3. **The submission is IDEMPOTENT.** Re-reporting re-reads history and reaches the same answer,
//!    so a retry is safe and a timeout is survivable. DFX's one-shot burns the quote AND the
//!    transaction id on any failure, which is the loss path the payer side is built around. As the
//!    provider we simply decline to inflict it.
//!
//! 4. **ONE TRANSFER, ONE SALE.** A ledger row credits at most one charge, and ringing up a new
//!    charge voids the merchant's previous one. Without the first, two CHF 4.50 charges and a
//!    single CHF 4.50 payment both read as paid and the shop hands over the goods twice — the rule
//!    and its mechanism live at [`match_payment`] and [`TillStore`].
//!
//! NO CUSTODY, and it is structural rather than promised: the destination in every response is the
//! merchant's own account, supplied by the merchant, and this relay never holds a key that could
//! move it. dpay publishes a price and observes an arrival. That is the whole of its role.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::ledger::TxnRecord;

/// VCHF's decimals — the raw units a `1.` on the wire means, and the scale `RAW_PER_CENT` below is
/// derived from. It exists to be ASSERTED rather than used: the drift alarm in this module's tests
/// checks it against the compiled catalog, so a catalog row that moved to another precision fails
/// the build instead of silently re-pricing every charge this till quotes.
#[cfg(test)]
const VCHF_DECIMALS: u32 = 8;

/// Raw VCHF units per CHF cent: `10^8 / 100`. Integer arithmetic end to end — a price that passed
/// through an `f64` is a price that can be wrong in the last digit, and the last digit of money is
/// the one people notice.
const RAW_PER_CENT: u64 = 1_000_000;

/// How long a quote is good for. Matched to the measured provider (300 s) so a wallet written
/// against DFX meets the timing it already expects. It costs us nothing to honour — the price is
/// 1:1 and cannot move — but a wallet's countdown and runway maths are calibrated to this. Public
/// because it is a stated property of this provider rather than an implementation detail: the wire
/// golden pins every deadline this module emits against it.
pub const QUOTE_TTL_SECS: u64 = 300;

/// How long a charge stays payable before the till must ring it up again. THE ONE LIFETIME: a
/// quote is clamped to it (see [`TillStore::quote`]) so nothing this till hands out can outlive
/// the charge it belongs to, and every read decides payability through [`Charge::state`] rather
/// than re-deriving a deadline of its own.
const CHARGE_TTL_SECS: u64 = 60 * 60;

/// How long a CREDITED charge is kept after it was rung up. Deliberately far longer than
/// [`CHARGE_TTL_SECS`], because the two are different facts: an unpaid stale charge is litter,
/// while a paid one is the merchant's record of a sale AND the mark that stops its ledger row
/// paying anything else (see [`TillStore::consumed_blocks`]). It must therefore comfortably
/// outlive [`LEDGER_CLOCK_SKEW_SECS`] — the only window in which an older row is looked at at all
/// — which a day does by four orders of magnitude. Not forever: memory is bounded.
const SETTLED_TTL_SECS: u64 = 24 * 60 * 60;

/// How far a ledger row may predate the charge it pays.
///
/// THE CLOCK ANCHOR, and the reason there is one at all: `Charge::created_secs` is the RELAY's
/// wall clock while a row's `timestamp` is IC CONSENSUS time, and the two are different clocks.
/// At QR speed ~30 s of human latency hides any disagreement; an NFC tap settles in ~2 s, so a
/// relay running a couple of seconds ahead would stamp a correct payment as older than the charge
/// it paid — money moved, sale never credited, nothing logged anywhere. That failure is silent and
/// costs a customer their goods, so the allowance is sized generously against it.
///
/// The alternative considered and REJECTED was anchoring each charge on the ledger's own tip at
/// ring-up, which needs no clock at all. It was rejected because it puts an uncacheable IC read on
/// `POST /api/v1/till` — today an unauthenticated route — which trades a clock problem for a
/// worse amplification one, and because the per-charge reference that is coming next (a `ref` memo
/// the payer echoes) makes the matching exact and this whole clause nearly moot.
///
/// It COMPOSES with consumption rather than replacing it. Widening the floor admits exactly one
/// extra kind of row: a same-amount transfer to the same merchant in the last two minutes that no
/// live charge has already claimed. Consumption (a block index is spent once) still guarantees ONE
/// SALE PER TRANSFER — what the window can do is credit the merchant's own earlier unobserved
/// payment to their newer charge, never credit two sales from one transfer, and never credit a
/// sale from nothing.
const LEDGER_CLOCK_SKEW_SECS: u64 = 120;

/// How long one ledger observation of a charge is reused for.
///
/// Every read of a charge re-derives settlement from the merchant's own history, which is a real
/// IC walk (measured at 0.6–1.05 s against mainnet). Unbounded, that makes two public routes an
/// amplifier: one cheap HTTP request, one mainnet ledger walk. This bounds the walk to at most one
/// per charge per window however many callers ask, and costs nothing that matters — the answer it
/// reuses is at most two seconds old, and the sale it may not yet name is named on the next poll.
const OBSERVE_TTL_SECS: u64 = 2;

/// The most a single charge may be for, in CHF cents — one million francs, which is not a till
/// charge. It exists so `Charge::amount_raw` can never saturate: a price whose raw units do not
/// fit is a price the till would quote wrongly, and quoting a wrong number is worse than refusing.
/// Enforced at the door ([`open_charge`]) rather than in the store, because refusing needs a voice
/// — the payer/cashier is told what the limit is.
const MAX_CENTS: u64 = 100_000_000;

/// The byte cap on a merchant's claimed name. Same bound the payer side clamps every stranger's
/// display text to (`PAY_LINK_TEXT_BYTES` in `app/lib/deepLink.ts`) — one rule for one kind of
/// string, rather than a second number invented here. Unlike [`MAX_CENTS`] this CLAMPS instead of
/// refusing: a name is display text and must never block a sale, and a clamp has nothing to say.
const MERCHANT_NAME_BYTES: usize = 32;

/// Live quotes remembered per charge. A wallet may re-read the details several times (every read
/// mints a fresh quote, as the measured provider does), and each issued id must stay acceptable
/// until it expires. Bounded so a hostile or looping wallet cannot grow this without limit.
const MAX_LIVE_QUOTES: usize = 32;

/// What the merchant is owed, and — once observed — what paid it.
#[derive(Clone, Debug)]
pub struct Charge {
    /// The payment-link id, `pl_<16 hex>`; the last path segment of every URL below.
    pub id: String,
    /// The merchant's own ICRC-1 account, as canonical principal text. The destination of every
    /// transfer instruction this module hands out. dpay never holds it and never signs for it.
    pub merchant: String,
    /// The same account as the 32-byte device pubkey it derives from. Carried alongside the text
    /// because the two are used by different halves: the TEXT is what goes on the wire and what a
    /// ledger row's `to` is compared against, while the PUBKEY is what the relay's history read is
    /// keyed by (`Ledger::transactions_on_ledger`). Derived once by the caller so this module stays
    /// pure — it does no key maths and pulls in no IC dependency, exactly like `faucet.rs`.
    pub merchant_pubkey: [u8; 32],
    /// What the merchant calls themselves. CLAIMED, never verified — every wallet that renders it
    /// must mark it so, exactly as dpay's own payer side marks a provider's `displayName`.
    pub merchant_name: String,
    /// The price in CHF cents — the number the merchant typed and the cashier reads aloud.
    pub cents: u64,
    pub created_secs: u64,
    /// Quote ids issued for this charge and still live, with their expiries.
    quotes: Vec<(String, u64)>,
    /// When a NEWER charge for the same merchant replaced this one, if it has been. Voiding stops
    /// this charge being QUOTED (nobody new may be sent to pay it) and never stops it being
    /// OBSERVED: a payer who was already holding its instructions may have sent the money a
    /// heartbeat before the cashier re-rang, and refusing to see that transfer would lose it.
    pub voided_at: Option<u64>,
    /// When the ledger was last read on this charge's behalf — the amplification bound, see
    /// [`OBSERVE_TTL_SECS`]. Not a settlement fact: it says when we looked, never what we found.
    observed_at: Option<u64>,
    /// The settlement, once observed on the ledger. Set once and never cleared: a credited sale
    /// does not become uncredited because a later read of history was slow or empty.
    pub paid: Option<Settled>,
}

/// A charge that has been paid, as OBSERVED on the merchant's own ledger history.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Settled {
    /// Who paid, as the ledger records them. Display/audit only — never an authorisation.
    pub from: String,
    /// Raw VCHF units that arrived. Equal to the charge's own amount by construction: a transfer of
    /// a different amount is not a match and is not consumed.
    pub amount_raw: String,
    /// Ledger timestamp, unix seconds.
    pub at_secs: u64,
    /// The ledger BLOCK that paid — the row's only stable identity ([`TxnRecord::block`]). It is
    /// what the merchant's screen names when it says which transfer credited them, and what makes
    /// "one transfer, one sale" a checkable property instead of a hope: a block recorded here is
    /// spent, and [`match_payment`] will not spend it again.
    pub block: u64,
}

/// Where a charge stands, as one answer rather than three booleans a caller has to combine.
/// `Paid` outranks everything (a credited sale is credited however the charge was rung up),
/// then `Superseded`, then `Expired`.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChargeState {
    /// Payable: quotes may be minted and transfer instructions handed out.
    Open,
    /// Credited on the ledger. Nothing more is owed and nothing more may be quoted.
    Paid,
    /// The cashier rang up a newer charge for this merchant, which replaced this one.
    Superseded,
    /// Past [`CHARGE_TTL_SECS`] with nothing credited — the cashier must ring it up again.
    Expired,
}

impl Charge {
    /// The exact raw VCHF the payer must transfer. 1:1 with CHF, in integers. `saturating_mul`
    /// cannot bind: [`MAX_CENTS`] is refused at the door, and it is a saturation rather than a
    /// panic only so this stays total for a caller holding a charge from anywhere.
    pub fn amount_raw(&self) -> u64 {
        self.cents.saturating_mul(RAW_PER_CENT)
    }

    /// The price as the wire spells a decimal: `10.` for CHF 10, `10.5` for CHF 10.50. Trailing
    /// zeros are trimmed because the measured provider trims them (`1.` for one franc), and a
    /// wallet written against it must meet the spelling it already parses — including the bare
    /// trailing point, which is the spelling naive decimal parsers reject and dpay's own does not.
    ///
    /// This is the ASSET amount, and it is machine-read. What a human reads is
    /// [`Charge::price_text`] — the same money, a different audience, which is why there are two.
    pub fn amount_text(&self) -> String {
        let whole = self.cents / 100;
        match self.cents % 100 {
            0 => format!("{whole}."),
            r if r % 10 == 0 => format!("{whole}.{}", r / 10),
            r => format!("{whole}.{r:02}"),
        }
    }

    /// The price as a person writes a franc: `10`, `10.50`, `10.05`. Never the wire's bare
    /// trailing point — `CHF 10.` is a machine's spelling leaking onto a receipt, and the measured
    /// provider's own human text says `CHF 1`. Used only in the LUD-06 `metadata` description.
    pub fn price_text(&self) -> String {
        let whole = self.cents / 100;
        match self.cents % 100 {
            0 => format!("{whole}"),
            r => format!("{whole}.{r:02}"),
        }
    }

    /// Where this charge stands at `now_secs` — the ONE lifetime rule, which every reader asks
    /// rather than re-deriving (the step-2 quote, the step-3 instruction, the merchant's screen).
    pub fn state(&self, now_secs: u64) -> ChargeState {
        match (&self.paid, self.voided_at) {
            (Some(_), _) => ChargeState::Paid,
            (None, Some(_)) => ChargeState::Superseded,
            (None, None) if self.expired(now_secs) => ChargeState::Expired,
            (None, None) => ChargeState::Open,
        }
    }

    /// May this charge be quoted / instructed right now? The refusal names WHICH fact stopped it,
    /// because "ask the cashier for the new code" and "this was already paid" send a payer to do
    /// two different things.
    fn payable(&self, now_secs: u64) -> Result<(), TillError> {
        match self.state(now_secs) {
            ChargeState::Open => Ok(()),
            ChargeState::Paid => Err(TillError::AlreadyPaid),
            ChargeState::Superseded => Err(TillError::Superseded),
            ChargeState::Expired => Err(TillError::NoPendingCharge),
        }
    }

    fn expired(&self, now_secs: u64) -> bool {
        now_secs >= self.created_secs.saturating_add(CHARGE_TTL_SECS)
    }
}

/// A merchant's claimed name, bounded to [`MERCHANT_NAME_BYTES`] on a CHARACTER boundary (a name
/// cut mid-codepoint is not a string). Total, and lossy only for a name no till could print.
fn clamp_name(name: &str) -> String {
    let mut out = String::new();
    for ch in name.chars() {
        if out.len() + ch.len_utf8() > MERCHANT_NAME_BYTES {
            break;
        }
        out.push(ch);
    }
    out
}

/// Every charge this relay is serving. In memory on purpose for v1: a charge is worth less than the
/// hour it lives, and the money it describes is on a ledger that outlives any process. A restart
/// costs the cashier a re-ring, never a payment — and never a double credit, because settlement is
/// re-derived from ledger history rather than from anything stored here.
///
/// MANY CHARGES PER MERCHANT, ON PURPOSE. "One live charge per merchant" is a POLICY this store
/// applies at ring-up ([`TillStore::open`] voids the previous one), never the SHAPE of the store —
/// which is why `by_id` holds N charges per merchant and `current` is merely an index into it. The
/// next step for this till is an online shop: one merchant, many customers, each with their own
/// charge, none blocking another. A store that could only hold one charge per merchant would have
/// to be rebuilt to get there; this one only has to stop calling `void_current`.
#[derive(Default)]
pub struct TillStore {
    by_id: HashMap<String, Charge>,
    /// merchant account text → the id of THEIR current charge. An index over `by_id`, never a
    /// second copy of it: it may only ever name a charge this store still holds (the sweep clears
    /// it alongside), and a dangling entry is a bug this store reports rather than absorbs.
    current: HashMap<String, String>,
}

/// What a poll should do about a charge, decided under the store's own lock so the decision and
/// the mark that enforces it cannot race.
pub enum Observation {
    /// Read the ledger. This caller has claimed the walk for the next [`OBSERVE_TTL_SECS`], so
    /// concurrent callers are answered from what the last one found instead of piling on.
    Walk(Charge),
    /// Answer with this: the ledger was read for this charge moments ago, or the charge is
    /// already settled and settlement is never re-decided.
    Recent(Charge),
}

/// Why a provider call could not be answered. Mapped to the measured provider's own wording by the
/// HTTP layer, so a wallet written against DFX meets the errors it already handles.
#[derive(Debug, PartialEq, Eq)]
pub enum TillError {
    /// No such payment link — a stale or hostile code.
    UnknownCharge,
    /// The link exists but nothing has been rung up on it yet. A DIFFERENT fact from the above, and
    /// the measured provider distinguishes them too: this one means "ask the cashier", the other
    /// means "this code is not ours". Collapsing them sends a payer to talk to a cashier who does
    /// not exist.
    NoPendingCharge,
    /// The cashier rang up a newer charge for this merchant, which replaced this one. The payer is
    /// holding a code that was current a moment ago — they need the new one, which is a different
    /// instruction from both 404s above.
    Superseded,
    /// This charge has already been credited on the ledger. Said out loud rather than quietly
    /// quoting it again, because quoting a settled charge invites a SECOND payment that nothing
    /// would ever credit.
    AlreadyPaid,
    /// The quote id is unknown or has expired.
    DeadQuote,
    /// A method/asset pair this till does not accept.
    UnsupportedAsset,
}

impl TillStore {
    /// Ring up a charge, VOIDING this merchant's previous one. `id` is supplied by the caller so
    /// the id generator stays in one place (the HTTP layer, which has the randomness) and this
    /// module stays pure and testable.
    ///
    /// The void is the "one live charge per merchant" policy: a cashier who rings up a new total
    /// has abandoned the last one, and two payable charges for the same merchant at the same price
    /// are two ways for one transfer to be ambiguous. It is a POLICY over a store that holds many
    /// — see the type's own note for why that distinction is the whole design.
    pub fn open(
        &mut self,
        id: String,
        merchant: String,
        merchant_pubkey: [u8; 32],
        merchant_name: String,
        cents: u64,
        now_secs: u64,
    ) -> Charge {
        self.void_current(&merchant, now_secs);
        let charge = Charge {
            id: id.clone(),
            merchant,
            merchant_pubkey,
            // Clamped HERE so no caller can store an unbounded name: a name arrives from a
            // stranger, is display text, and must not be a way to spend this relay's memory.
            merchant_name: clamp_name(&merchant_name),
            cents,
            created_secs: now_secs,
            quotes: Vec::new(),
            voided_at: None,
            observed_at: None,
            paid: None,
        };
        self.current.insert(charge.merchant.clone(), id.clone());
        self.by_id.insert(id, charge.clone());
        charge
    }

    /// Void whatever this merchant's current charge is. Unpaid only: a settled charge is a record
    /// of money that moved, and nothing rings that away.
    ///
    /// It is exactly as trustworthy as the caller's claim to be that merchant, which today is a
    /// pubkey anyone may type: a stranger can ring up against someone else's key and void their
    /// pending charge. Nothing is stolen by it — the destination is still the real merchant's
    /// account and a voided charge is still credited if it was paid — but the cashier is made to
    /// ring up again, which is why the routes ship OFF (`DPAY_ENABLE_TILL`) until a merchant must
    /// SIGN their ring-up.
    fn void_current(&mut self, merchant: &str, now_secs: u64) {
        let Some(prev_id) = self.current.get(merchant).cloned() else {
            return; // this merchant's first charge — nothing to replace
        };
        match self.by_id.get_mut(&prev_id) {
            Some(prev) if prev.paid.is_none() => {
                prev.voided_at.get_or_insert(now_secs);
            }
            Some(_) => {} // already paid: a credited sale is not voided by the next customer
            // The index may only ever name a charge this store holds (the sweep clears both
            // together), so this is a broken invariant rather than an ordinary absence.
            None => eprintln!(
                "dpay-relay: till: the merchant index named {prev_id}, which this store no longer \
                 holds — nothing was voided"
            ),
        }
    }

    pub fn get(&self, id: &str) -> Option<&Charge> {
        self.by_id.get(id)
    }

    /// Mint a quote for a charge and return it. Every read of the payment details mints a fresh one
    /// — the behaviour measured on the live provider, and the reason a wallet may hold several.
    ///
    /// The expiry is CLAMPED to the charge's own death, so this till never states a deadline it
    /// will not honour: a quote minted with five minutes left on a charge that has thirty seconds
    /// to live is good for thirty seconds, and says so.
    pub fn quote(&mut self, id: &str, quote_id: String, now_secs: u64) -> Result<(String, u64), TillError> {
        let charge = self.by_id.get_mut(id).ok_or(TillError::UnknownCharge)?;
        charge.payable(now_secs)?;
        let expires = now_secs
            .saturating_add(QUOTE_TTL_SECS)
            .min(charge.created_secs.saturating_add(CHARGE_TTL_SECS));
        charge.quotes.retain(|(_, exp)| *exp > now_secs);
        if charge.quotes.len() >= MAX_LIVE_QUOTES {
            charge.quotes.remove(0);
        }
        charge.quotes.push((quote_id.clone(), expires));
        Ok((quote_id, expires))
    }

    /// The expiry of a quote this till issued for this charge, if it is still live. Returning the
    /// instant rather than a yes/no is what lets step 3 state THE QUOTE's deadline instead of
    /// inventing a second one — one object, one death.
    pub fn quote_expiry(&self, id: &str, quote_id: &str, now_secs: u64) -> Result<u64, TillError> {
        let charge = self.by_id.get(id).ok_or(TillError::UnknownCharge)?;
        charge
            .quotes
            .iter()
            .find(|(q, exp)| q == quote_id && *exp > now_secs)
            .map(|(_, exp)| *exp)
            .ok_or(TillError::DeadQuote)
    }

    /// Decide whether this poll should read the ledger, and mark the claim if it should. See
    /// [`Observation`] and [`OBSERVE_TTL_SECS`].
    pub fn observe(&mut self, id: &str, now_secs: u64) -> Result<Observation, TillError> {
        let charge = self.by_id.get_mut(id).ok_or(TillError::UnknownCharge)?;
        if charge.paid.is_some() {
            return Ok(Observation::Recent(charge.clone()));
        }
        match charge.observed_at {
            Some(at) if now_secs < at.saturating_add(OBSERVE_TTL_SECS) => {
                Ok(Observation::Recent(charge.clone()))
            }
            _ => {
                charge.observed_at = Some(now_secs);
                Ok(Observation::Walk(charge.clone()))
            }
        }
    }

    /// Match the merchant's history against this charge and RECORD what it found, in one step
    /// under one borrow. The check and the act cannot be separated: two charges polled at the same
    /// instant would otherwise both match the same row and both be credited from it — the exact
    /// shape of the bug consumption exists to remove.
    ///
    /// Idempotent: the FIRST observation wins and later ones are ignored, so a re-report cannot
    /// rewrite who paid, when, or out of which block.
    pub fn settle_from_history(
        &mut self,
        id: &str,
        rows: &[TxnRecord],
    ) -> Result<Option<Settled>, TillError> {
        let consumed = self.consumed_blocks();
        let charge = self.by_id.get_mut(id).ok_or(TillError::UnknownCharge)?;
        if charge.paid.is_some() {
            return Ok(charge.paid.clone());
        }
        let Some(settled) = match_payment(charge, rows, &consumed) else {
            return Ok(None);
        };
        charge.paid = Some(settled.clone());
        Ok(Some(settled))
    }

    /// Every ledger row this till has already credited, by block index — the CONSUMPTION SET.
    ///
    /// Derived from the charges themselves rather than kept alongside them, so there is exactly
    /// one statement of "this row paid something" (the `Settled` record) and no second structure
    /// to drift out of step with it. Sweeping a settled charge releases its block, which is safe
    /// because [`SETTLED_TTL_SECS`] outlives [`LEDGER_CLOCK_SKEW_SECS`] by a day: by the time a
    /// block is forgotten, no charge this store could hold is allowed to look that far back.
    fn consumed_blocks(&self) -> HashSet<u64> {
        self.by_id.values().filter_map(|c| c.paid.as_ref().map(|p| p.block)).collect()
    }

    /// Drop charges past their life. Called opportunistically; nothing depends on it having run,
    /// because every read re-checks state itself.
    pub fn sweep(&mut self, now_secs: u64) {
        self.by_id.retain(|_, c| match c.paid {
            // A credited sale is the merchant's record of it, and the mark that stops its ledger
            // row paying anything else — so it outlives the charge's payable hour.
            Some(_) => now_secs < c.created_secs.saturating_add(SETTLED_TTL_SECS),
            None => !c.expired(now_secs),
        });
        // The index only ever names charges this store holds.
        let by_id = &self.by_id;
        self.current.retain(|_, id| by_id.contains_key(id));
    }
}

/// Shared handle, wrapped the way the rest of the relay wraps mutable state: a poison-tolerant
/// `Mutex` that is never held across an await.
pub type SharedTills = Arc<Mutex<TillStore>>;

/// The one method/asset pair v1 serves. A pair outside this is `UnsupportedAsset` — refused rather
/// than quoted, because quoting anything else would mean holding an exchange rate.
pub(crate) const METHOD: &str = "InternetComputer";
pub(crate) const ASSET: &str = "VCHF";

/// Is this the pair we serve? Case-insensitive on the asset, because an outside wallet echoes back
/// whatever spelling it read and casing is not identity.
pub(crate) fn supported(method: &str, asset: &str) -> Result<(), TillError> {
    if method == METHOD && asset.eq_ignore_ascii_case(ASSET) {
        Ok(())
    } else {
        Err(TillError::UnsupportedAsset)
    }
}

/// Pick the transfer that pays a charge out of the merchant's incoming history.
///
/// THE MATCHING RULE, and every clause of it earns its place:
///   * `to` is the merchant's account — we read their history, but a history walk can carry their
///     outgoing rows too, and an outgoing transfer of the right size must never credit a sale;
///   * the amount is EXACT in raw units — never "at least", so an underpayment is not a payment and
///     a rounding difference is not silently absorbed;
///   * the row has NOT already paid something. `consumed` holds the block index of every row this
///     till has credited, and a spent row is spent. THIS is the clause that makes one transfer pay
///     one sale. The timestamp clause below never could and never did: it excludes rows older than
///     the charge, so two charges rung up a minute apart for the same price both accept the same
///     later transfer, and a shop hands over goods twice for one payment;
///   * the transfer is not older than the charge by more than [`LEDGER_CLOCK_SKEW_SECS`] — a floor
///     that keeps last week's identical sale out while surviving the two clocks' disagreement.
///
/// Returns the FIRST match in the order history was given (newest-first from the ledger walk), or
/// `None`. `None` is honest "not seen yet", never "refused" — the caller keeps the charge open.
pub(crate) fn match_payment(
    charge: &Charge,
    rows: &[TxnRecord],
    consumed: &HashSet<u64>,
) -> Option<Settled> {
    let want = charge.amount_raw().to_string();
    let floor = charge.created_secs.saturating_sub(LEDGER_CLOCK_SKEW_SECS);
    rows.iter()
        .find(|r| {
            r.to == charge.merchant
                && r.amount.0.to_string() == want
                && !consumed.contains(&r.block)
                && r.timestamp >= floor
        })
        .map(|r| Settled {
            from: r.from.clone(),
            amount_raw: want.clone(),
            at_secs: r.timestamp,
            block: r.block,
        })
}

/// The step-2 payment-details body, in the measured provider's own shape.
///
/// The field set is copied from the live recording (findings doc, "Step-2 body") rather than
/// invented, because third-party wallets parse THAT shape: `tag`/`callback`/`quote`/
/// `requestedAmount`/`transferAmounts`, the per-asset amount as a decimal STRING while
/// `requestedAmount.amount` is a JSON number, and `metadata` as the LUD-06 escaped array.
#[derive(Debug, Serialize)]
pub(crate) struct DetailsBody {
    pub tag: &'static str,
    pub callback: String,
    /// LUD-06 defines both of these in MILLISATOSHIS, and this till cannot state a millisatoshi
    /// amount: pricing 1:1 against the franc with no rate anywhere is the premise of the whole
    /// module, and converting CHF to msat needs exactly the BTC price this design deletes. So they
    /// are `0` — the honest declaration that nothing here is payable over Lightning, which is also
    /// simply true: `transferAmounts` offers one method, and the callback refuses every other pair
    /// with `Invalid method or asset`. They stay PRESENT because the measured provider always
    /// sends them and an LNURL-shaped parser may require the field to exist.
    ///
    /// The number that used to sit here was `charge.cents`, i.e. CHF 10 went out as
    /// `minSendable: 1000`, which a Lightning wallet reads as one satoshi. A wrong price is worse
    /// than no price: the real provider CAN quote msat (measured: `1593000` for CHF 1, a live BTC
    /// rate) and a wallet has no way to know ours was a different unit wearing the same name.
    #[serde(rename = "minSendable")]
    pub min_sendable: u64,
    #[serde(rename = "maxSendable")]
    pub max_sendable: u64,
    pub metadata: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub standard: &'static str,
    #[serde(rename = "possibleStandards")]
    pub possible_standards: Vec<&'static str>,
    #[serde(rename = "displayQr")]
    pub display_qr: bool,
    pub quote: QuoteBody,
    #[serde(rename = "requestedAmount")]
    pub requested_amount: RequestedAmount,
    #[serde(rename = "transferAmounts")]
    pub transfer_amounts: Vec<TransferAmount>,
}

#[derive(Debug, Serialize)]
pub(crate) struct QuoteBody {
    pub id: String,
    /// ISO-8601 UTC with the `Z` and milliseconds — the ONE spelling the measured provider emits and
    /// the only one dpay's own strict reader accepts. A local-time spelling here would be read as
    /// device-local by a lenient wallet, which is up to 14 hours of skew on a 300-second quote.
    pub expiration: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct RequestedAmount {
    pub asset: &'static str,
    /// A JSON NUMBER, matching the measured provider's asymmetry with the string amounts below.
    pub amount: f64,
}

#[derive(Debug, Serialize)]
pub(crate) struct TransferAmount {
    pub method: &'static str,
    #[serde(rename = "minFee")]
    pub min_fee: u64,
    pub available: bool,
    pub assets: Vec<AssetAmount>,
}

#[derive(Debug, Serialize)]
pub(crate) struct AssetAmount {
    pub asset: &'static str,
    /// A decimal STRING, trailing point and all.
    pub amount: String,
}

/// The step-3 transfer-instruction body.
#[derive(Debug, Serialize)]
pub(crate) struct TransferBody {
    /// THE QUOTE's own expiry — the instruction dies with the price it belongs to. Minting a fresh
    /// `now + QUOTE_TTL` here (what this used to do) states a deadline the till does not honour:
    /// it outlives the quote by however long the wallet took between step 2 and step 3, so a payer
    /// who waited is told the money is still good for a price that is already dead.
    #[serde(rename = "expiryDate")]
    pub expiry_date: String,
    /// Echoes the requested method VERBATIM. The URI names no asset, so for a wallet this echo is
    /// the only integrity signal the answer carries — dpay's own payer refuses a mismatch, and so
    /// should anyone else's.
    pub blockchain: &'static str,
    /// `icp:<LEDGER>/transfer?to=<PRINCIPAL>&amount=<DECIMAL>` — the LIVE shape, not the shape the
    /// public README documents (findings doc, "Stale-README trap #1").
    pub uri: String,
    pub hint: String,
}

/// What the merchant's own app polls. `state` is the answer `paid` alone cannot give: a charge
/// that was superseded by the next ring-up and one that is still waiting look identical through a
/// null `paid`, and the cashier's screen has to tell a customer which of those it is.
#[derive(Debug, Serialize)]
pub(crate) struct ChargeStatus {
    pub id: String,
    pub cents: u64,
    pub amount: String,
    pub merchant: String,
    pub state: ChargeState,
    pub paid: Option<Settled>,
}

/// The merchant's request to ring one up.
#[derive(Debug, Deserialize)]
pub(crate) struct OpenCharge {
    /// The merchant's own device pubkey, 64 hex. Their account is DERIVED from it exactly as every
    /// other balance and history read in this relay derives one, so a merchant cannot name an
    /// account they cannot sign for — and dpay still never holds the key.
    pub merchant_pubkey: String,
    #[serde(default)]
    pub merchant_name: String,
    /// The price in CHF cents.
    pub cents: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    const MERCHANT: &str = "ygf2v-iniac-cojwe-damoz-s4act-k4xft-xgpjy-776wl-wr754-qxkgo-4ae";
    const OTHER_MERCHANT: &str = "3sgnf-nsdcx-tojvm-zvbdz-3v6ec-4uqfa-mgstv-xu4tv-uh5r6-wd7yd-cae";
    const PAYER: &str = "lrdna-ain6m-ja6ko-ac4j2-jqk3t-nqs22-4irws-bsm3b-trzzq-3yfz6-mqe";

    /// A store holding one charge, and that charge.
    fn charge(cents: u64, created: u64) -> Charge {
        let mut s = TillStore::default();
        s.open("pl_test".into(), MERCHANT.into(), [7u8; 32], "Test Shop".into(), cents, created)
    }

    /// One incoming ledger row. `block` is its identity — the thing that decides whether it has
    /// already paid for something — so every fixture states it rather than sharing a default.
    fn row(to: &str, amount: u64, ts: u64, block: u64) -> TxnRecord {
        TxnRecord {
            from: PAYER.into(),
            to: to.into(),
            amount: crate::ledger::types::U64String(amount),
            nonce: String::new(),
            currency: 7,
            block,
            timestamp: ts,
            from_name: String::new(),
            to_name: String::new(),
            memo: String::new(),
        }
    }

    /// Nothing has been credited yet.
    fn unspent() -> HashSet<u64> {
        HashSet::new()
    }

    #[test]
    fn a_charge_is_priced_one_to_one_with_the_franc_in_integers() {
        // The entire reason v1 is VCHF-only: there is no rate here, so there is nothing to be wrong
        // about. CHF 10 is ten francs of a franc-denominated token, exactly, forever.
        assert_eq!(charge(1_000, 0).amount_raw(), 1_000_000_000);
        assert_eq!(charge(1, 0).amount_raw(), 1_000_000);
        // …and never through a float: a price that visits f64 can be wrong in the last digit, which
        // is the digit a customer notices.
        assert_eq!(charge(u64::from(u32::MAX), 0).amount_raw(), 4_294_967_295 * RAW_PER_CENT);
        // The largest charge the door admits still multiplies exactly — which is what the door's
        // bound is for: past it the arithmetic would saturate and the till would quote a lie.
        assert_eq!(charge(MAX_CENTS, 0).amount_raw(), MAX_CENTS * RAW_PER_CENT);
    }

    #[test]
    fn the_amount_is_spelled_the_way_the_measured_provider_spells_it() {
        // Including the bare trailing point — the spelling naive decimal parsers reject, which is
        // exactly why a wallet written against the real provider must meet it here too.
        assert_eq!(charge(100, 0).amount_text(), "1.");
        assert_eq!(charge(1_000, 0).amount_text(), "10.");
        assert_eq!(charge(1_050, 0).amount_text(), "10.5");
        assert_eq!(charge(1_005, 0).amount_text(), "10.05");
        assert_eq!(charge(1_099, 0).amount_text(), "10.99");
    }

    #[test]
    fn the_price_a_person_reads_is_not_the_one_the_wire_carries() {
        // The wire's trailing point is a machine's spelling. On a receipt it reads as a typo, and
        // the measured provider's own human text says `CHF 1` — so the description says it too.
        assert_eq!(charge(100, 0).price_text(), "1");
        assert_eq!(charge(1_000, 0).price_text(), "10");
        // Cents survive, in the two-digit shape money is written in (never `10.5`).
        assert_eq!(charge(1_050, 0).price_text(), "10.50");
        assert_eq!(charge(1_005, 0).price_text(), "10.05");
        assert_ne!(charge(1_000, 0).price_text(), charge(1_000, 0).amount_text());
    }

    #[test]
    fn a_matching_transfer_settles_the_charge_and_names_the_block_that_paid() {
        let c = charge(100, 1_000);
        let got = match_payment(&c, &[row(MERCHANT, 100_000_000, 1_050, 77)], &unspent());
        assert_eq!(
            got,
            Some(Settled {
                from: PAYER.into(),
                amount_raw: "100000000".into(),
                at_secs: 1_050,
                // The merchant's screen can say WHICH transfer paid them, and this store can say
                // which one is spent. Same fact, one field.
                block: 77,
            })
        );
    }

    #[test]
    fn a_transfer_that_is_not_this_sale_never_settles_it() {
        let c = charge(100, 1_000);
        // Wrong amount — an underpayment is not a payment, and an overpayment is not this charge.
        assert_eq!(match_payment(&c, &[row(MERCHANT, 99_999_999, 1_050, 1)], &unspent()), None);
        assert_eq!(match_payment(&c, &[row(MERCHANT, 100_000_001, 1_050, 2)], &unspent()), None);
        // Someone else's account: reading a history does not mean everything in it is ours.
        assert_eq!(match_payment(&c, &[row(PAYER, 100_000_000, 1_050, 3)], &unspent()), None);
        // Far older than the charge: last week's identical sale is not this one.
        assert_eq!(match_payment(&c, &[row(MERCHANT, 100_000_000, 500, 4)], &unspent()), None);
    }

    #[test]
    fn one_transfer_can_only_ever_pay_one_sale() {
        // THE MONEY BUG. Two charges for the same price at the same till and ONE payment: without
        // consumption both read as paid and the shop hands over the goods twice. The timestamp
        // clause cannot help — the transfer is newer than both.
        let mut s = TillStore::default();
        s.open("pl_a".into(), MERCHANT.into(), [7u8; 32], "Shop".into(), 450, 1_000);
        s.open("pl_b".into(), MERCHANT.into(), [7u8; 32], "Shop".into(), 450, 1_001);
        let rows = [row(MERCHANT, 450_000_000, 1_010, 12)];

        let first = s.settle_from_history("pl_a", &rows).expect("a live charge");
        assert_eq!(first.map(|p| p.block), Some(12), "the first charge polled takes the transfer");
        let second = s.settle_from_history("pl_b", &rows).expect("a live charge");
        assert_eq!(second, None, "the SAME row must not credit a second sale");
        assert!(s.get("pl_b").expect("still open").paid.is_none());

        // A second, distinct transfer pays the second charge — consumption spends rows, not sales.
        let more = [row(MERCHANT, 450_000_000, 1_011, 13), rows[0].clone()];
        let third = s.settle_from_history("pl_b", &more).expect("a live charge");
        assert_eq!(third.map(|p| p.block), Some(13), "a different block pays the other charge");
    }

    #[test]
    fn a_payment_the_relay_clock_thinks_is_early_still_settles() {
        // The relay stamps the charge with ITS clock; the ledger stamps the row with IC consensus
        // time. At tap speed a relay running a few seconds fast makes a correct payment look older
        // than the charge it paid — money moved, sale never credited, nothing logged anywhere.
        let c = charge(100, 1_000);
        assert!(
            match_payment(&c, &[row(MERCHANT, 100_000_000, 995, 5)], &unspent()).is_some(),
            "a five-second disagreement between two clocks must not lose a payment"
        );
        // The allowance is BOUNDED, and the boundary is exact on both sides.
        let edge = 1_000 - LEDGER_CLOCK_SKEW_SECS;
        assert!(match_payment(&c, &[row(MERCHANT, 100_000_000, edge, 6)], &unspent()).is_some());
        assert_eq!(match_payment(&c, &[row(MERCHANT, 100_000_000, edge - 1, 7)], &unspent()), None);
    }

    #[test]
    fn settlement_is_recorded_once_and_never_rewritten() {
        // The idempotence that lets a payer re-report safely: a second observation must not be able
        // to change who paid. Re-reporting is a RETRY here, not a second chance to lose the money.
        let mut s = TillStore::default();
        s.open("pl_a".into(), MERCHANT.into(), [7u8; 32], "Shop".into(), 100, 0);
        let first = s.settle_from_history("pl_a", &[row(MERCHANT, 100_000_000, 10, 1)]).unwrap();
        assert!(first.is_some());
        // A later history that no longer carries that row (a walk that scrolled past it), plus a
        // different transfer of the same size: neither may rewrite the settlement.
        let again = s
            .settle_from_history("pl_a", &[row(OTHER_MERCHANT, 100_000_000, 99, 2)])
            .unwrap();
        assert_eq!(again, first, "the first observation is the settlement, forever");
        assert_eq!(s.get("pl_a").unwrap().paid, first);
    }

    #[test]
    fn a_charge_this_store_does_not_hold_is_reported_rather_than_swallowed() {
        // Every one of these used to be (or could quietly become) a silent no-op. A caller acting
        // on an id that is gone must be told, not answered with a shrug.
        let mut s = TillStore::default();
        assert_eq!(s.settle_from_history("pl_gone", &[]), Err(TillError::UnknownCharge));
        assert_eq!(s.quote("pl_gone", "plq_1".into(), 0), Err(TillError::UnknownCharge));
        assert_eq!(s.quote_expiry("pl_gone", "plq_1", 0), Err(TillError::UnknownCharge));
        assert!(matches!(s.observe("pl_gone", 0), Err(TillError::UnknownCharge)));
    }

    #[test]
    fn only_a_quote_this_till_issued_and_has_not_expired_is_accepted() {
        let mut s = TillStore::default();
        s.open("pl_a".into(), MERCHANT.into(), [7u8; 32], "Shop".into(), 100, 0);
        s.quote("pl_a", "plq_1".into(), 0).unwrap();

        // The expiry comes BACK, because step 3 states the quote's own deadline rather than
        // inventing a second one.
        assert_eq!(s.quote_expiry("pl_a", "plq_1", 0), Ok(QUOTE_TTL_SECS));
        assert_eq!(s.quote_expiry("pl_a", "plq_1", QUOTE_TTL_SECS - 1), Ok(QUOTE_TTL_SECS));
        // Past its life, and one we never issued: both dead, neither payable.
        assert_eq!(s.quote_expiry("pl_a", "plq_1", QUOTE_TTL_SECS), Err(TillError::DeadQuote));
        assert_eq!(s.quote_expiry("pl_a", "plq_invented", 0), Err(TillError::DeadQuote));
    }

    #[test]
    fn several_reads_may_each_hold_a_live_quote_without_growing_forever() {
        // The measured provider mints a NEW quote on every read and leaves the old ones valid, so a
        // wallet that reads twice must not find its first quote dead. Bounded, though: a looping
        // wallet must not be able to grow this map without limit.
        let mut s = TillStore::default();
        s.open("pl_a".into(), MERCHANT.into(), [7u8; 32], "Shop".into(), 100, 0);
        for i in 0..MAX_LIVE_QUOTES {
            s.quote("pl_a", format!("plq_{i}"), 0).unwrap();
        }
        assert!(s.quote_expiry("pl_a", "plq_0", 0).is_ok());
        s.quote("pl_a", "plq_overflow".into(), 0).unwrap();
        assert_eq!(s.get("pl_a").unwrap().quotes.len(), MAX_LIVE_QUOTES);
        assert_eq!(s.quote_expiry("pl_a", "plq_0", 0), Err(TillError::DeadQuote));
        assert!(s.quote_expiry("pl_a", "plq_overflow", 0).is_ok());
    }

    #[test]
    fn a_rung_up_charge_stops_being_payable_when_it_goes_stale() {
        let mut s = TillStore::default();
        s.open("pl_a".into(), MERCHANT.into(), [7u8; 32], "Shop".into(), 100, 0);
        assert!(s.quote("pl_a", "plq_1".into(), CHARGE_TTL_SECS - 1).is_ok());
        assert_eq!(s.quote("pl_a", "plq_2".into(), CHARGE_TTL_SECS), Err(TillError::NoPendingCharge));
        assert_eq!(s.get("pl_a").unwrap().state(CHARGE_TTL_SECS), ChargeState::Expired);
    }

    #[test]
    fn a_quote_never_outlives_the_charge_it_prices() {
        // ONE lifetime, not two. A quote minted with five minutes of runway on a charge with ten
        // seconds left is good for ten seconds — and says so, rather than promising a deadline
        // this till would refuse to honour.
        let mut s = TillStore::default();
        s.open("pl_a".into(), MERCHANT.into(), [7u8; 32], "Shop".into(), 100, 0);
        let late = CHARGE_TTL_SECS - 10;
        let (_, expires) = s.quote("pl_a", "plq_late".into(), late).unwrap();
        assert_eq!(expires, CHARGE_TTL_SECS, "clamped to the charge's own death");
        assert!(expires < late + QUOTE_TTL_SECS);
        // …and it really is dead then, so nothing outlives the sweep that clears the charge.
        assert_eq!(s.quote_expiry("pl_a", "plq_late", CHARGE_TTL_SECS), Err(TillError::DeadQuote));
    }

    #[test]
    fn ringing_up_a_new_charge_voids_the_merchants_previous_one() {
        // ONE LIVE CHARGE PER MERCHANT, as a policy over a store that holds many: the old charge
        // is still here, still readable, just no longer payable.
        let mut s = TillStore::default();
        s.open("pl_first".into(), MERCHANT.into(), [7u8; 32], "Shop".into(), 450, 100);
        s.open("pl_second".into(), MERCHANT.into(), [7u8; 32], "Shop".into(), 900, 200);

        assert_eq!(s.get("pl_first").unwrap().state(200), ChargeState::Superseded);
        assert_eq!(s.get("pl_first").unwrap().voided_at, Some(200));
        assert_eq!(s.quote("pl_first", "plq_1".into(), 200), Err(TillError::Superseded));
        assert_eq!(s.get("pl_second").unwrap().state(200), ChargeState::Open);
        assert!(s.quote("pl_second", "plq_2".into(), 200).is_ok());

        // ANOTHER merchant's charge is untouched — the policy is per merchant, and the store is
        // not a one-charge box.
        s.open("pl_other".into(), OTHER_MERCHANT.into(), [8u8; 32], "Kiosk".into(), 450, 300);
        assert_eq!(s.get("pl_second").unwrap().state(300), ChargeState::Open);
        assert_eq!(s.get("pl_other").unwrap().state(300), ChargeState::Open);
    }

    #[test]
    fn a_voided_charge_still_credits_money_that_already_moved() {
        // The payer was holding the old code and sent the money a heartbeat before the cashier
        // re-rang. Voiding must close the door to NEW payers, never blind the till to a transfer
        // that already happened — that would lose a real payment.
        let mut s = TillStore::default();
        s.open("pl_first".into(), MERCHANT.into(), [7u8; 32], "Shop".into(), 450, 100);
        s.open("pl_second".into(), MERCHANT.into(), [7u8; 32], "Shop".into(), 450, 200);
        let rows = [row(MERCHANT, 450_000_000, 150, 21)];

        let paid = s.settle_from_history("pl_first", &rows).unwrap();
        assert_eq!(paid.map(|p| p.block), Some(21), "a voided charge still sees its own payment");
        assert_eq!(s.get("pl_first").unwrap().state(300), ChargeState::Paid);
        // …and that transfer is spent: the new charge is NOT paid by the old one's money.
        assert_eq!(s.settle_from_history("pl_second", &rows).unwrap(), None);
    }

    #[test]
    fn a_credited_charge_is_not_quoted_again() {
        // Quoting a settled charge invites a SECOND payment for the same sale, which nothing would
        // ever credit — the payer's money would simply sit on the ledger unclaimed.
        let mut s = TillStore::default();
        s.open("pl_a".into(), MERCHANT.into(), [7u8; 32], "Shop".into(), 100, 0);
        s.settle_from_history("pl_a", &[row(MERCHANT, 100_000_000, 10, 31)]).unwrap();
        assert_eq!(s.quote("pl_a", "plq_1".into(), 20), Err(TillError::AlreadyPaid));
        // Being paid also outranks having been superseded or having gone stale.
        assert_eq!(s.get("pl_a").unwrap().state(CHARGE_TTL_SECS + 1), ChargeState::Paid);
    }

    #[test]
    fn a_second_poll_within_the_window_reuses_the_first_walk() {
        // The amplification bound: one cheap HTTP request must not buy an unlimited number of
        // mainnet ledger walks. Whoever asks first claims the walk; everyone else inside the
        // window is answered from what it found.
        let mut s = TillStore::default();
        s.open("pl_a".into(), MERCHANT.into(), [7u8; 32], "Shop".into(), 100, 1_000);
        assert!(matches!(s.observe("pl_a", 1_000), Ok(Observation::Walk(_))));
        assert!(matches!(s.observe("pl_a", 1_000), Ok(Observation::Recent(_))));
        assert!(matches!(
            s.observe("pl_a", 1_000 + OBSERVE_TTL_SECS - 1),
            Ok(Observation::Recent(_))
        ));
        // The window ENDS — a cache that never expired would be a till that never sees the money.
        assert!(matches!(s.observe("pl_a", 1_000 + OBSERVE_TTL_SECS), Ok(Observation::Walk(_))));

        // A settled charge is never re-walked at all: settlement is not re-decided.
        s.settle_from_history("pl_a", &[row(MERCHANT, 100_000_000, 1_010, 41)]).unwrap();
        assert!(matches!(s.observe("pl_a", 9_999), Ok(Observation::Recent(_))));
    }

    #[test]
    fn a_merchant_name_is_bounded_however_long_it_arrives() {
        // A name is a stranger's text held for an hour. Unbounded, it is a way to spend this
        // relay's memory a megabyte per ring-up.
        let mut s = TillStore::default();
        let huge = "A".repeat(1_000_000);
        let c = s.open("pl_a".into(), MERCHANT.into(), [7u8; 32], huge, 100, 0);
        assert_eq!(c.merchant_name.len(), MERCHANT_NAME_BYTES);
        // Cut on a CHARACTER boundary, never mid-codepoint: a name is text or it is nothing.
        let wide = "é".repeat(100); // 2 bytes each — 16 fit, the 17th would be one byte over
        let c = s.open("pl_b".into(), MERCHANT.into(), [7u8; 32], wide, 100, 0);
        assert_eq!(c.merchant_name.chars().count(), MERCHANT_NAME_BYTES / 2);
        assert!(c.merchant_name.len() <= MERCHANT_NAME_BYTES);
        // A name that fits is untouched — clamping is a bound, not a filter.
        let c = s.open("pl_c".into(), MERCHANT.into(), [7u8; 32], "Bahnhof Kiosk".into(), 100, 0);
        assert_eq!(c.merchant_name, "Bahnhof Kiosk");
    }

    #[test]
    fn a_credited_sale_outlives_the_charge_but_not_the_day() {
        // A stale unpaid charge is litter; a credited one is the merchant's record of a sale AND
        // the mark that keeps its ledger row from paying anything else. Neither is kept forever.
        let mut s = TillStore::default();
        s.open("pl_paid".into(), MERCHANT.into(), [7u8; 32], "Shop".into(), 100, 0);
        s.open("pl_stale".into(), OTHER_MERCHANT.into(), [8u8; 32], "Kiosk".into(), 100, 0);
        s.settle_from_history("pl_paid", &[row(MERCHANT, 100_000_000, 5, 51)]).unwrap();

        s.sweep(CHARGE_TTL_SECS + 1);
        assert!(s.get("pl_paid").is_some(), "a credited sale survives the payable hour");
        assert!(s.get("pl_stale").is_none(), "an unpaid stale charge is litter");

        s.sweep(SETTLED_TTL_SECS);
        assert!(s.get("pl_paid").is_none(), "and is not kept forever");
        // The per-merchant index is cleared with the charges, so it can never name a ghost.
        assert!(s.current.is_empty());
    }

    #[test]
    fn an_id_is_minted_unguessably_and_in_the_standards_shape() {
        // A charge id is a bearer read-token over the merchant's name and price. Sixteen lowercase
        // hex characters of OS randomness, and never the same twice.
        let ids: HashSet<String> = (0..256).map(|_| fresh_id("pl_")).collect();
        assert_eq!(ids.len(), 256, "a repeated id would mean the generator is not random");
        for id in &ids {
            let tail = id.strip_prefix("pl_").expect("the standard's shape: pl_<hex>");
            assert_eq!(tail.len(), 16);
            assert!(tail.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')), "{id}");
        }
    }

    #[test]
    fn only_the_one_pair_v1_serves_is_accepted() {
        assert_eq!(supported("InternetComputer", "VCHF"), Ok(()));
        assert_eq!(supported("InternetComputer", "vchf"), Ok(())); // casing is not identity
        // Everything else is refused rather than quoted: quoting it would mean holding a rate.
        assert_eq!(supported("InternetComputer", "ICP"), Err(TillError::UnsupportedAsset));
        assert_eq!(supported("InternetComputer", "ckBTC"), Err(TillError::UnsupportedAsset));
        assert_eq!(supported("Solana", "VCHF"), Err(TillError::UnsupportedAsset));
    }

    #[test]
    fn vchf_decimals_match_the_catalog_this_relay_serves() {
        // The scale every price here is built on. If the catalog's VCHF row ever moved to another
        // precision, `RAW_PER_CENT` would silently misprice every charge — so it is asserted, not
        // assumed, against the same compiled catalog the wallet reads.
        let row = crate::catalog::ic_rows()
            .into_iter()
            .find(|d| d.currency == 7)
            .expect("the compiled catalog must carry VCHF as currency 7");
        assert_eq!(row.decimals, Some(u8::try_from(VCHF_DECIMALS).expect("decimals fit a u8")));
        assert_eq!(10u64.pow(VCHF_DECIMALS) / 100, RAW_PER_CENT);
    }
}

// --- HTTP: the provider surface, and the merchant's own two routes ------------------------------
// Split from the pure half above deliberately: everything up to here does no I/O, holds no state
// handle and pulls in no framework, so the money rules are tested as plain functions. Below is the
// wiring that exposes them, in the shape the STANDARD dictates rather than one of our choosing —
// `/v1/lnurlp/{id}`, `/v1/lnurlp/cb/{id}`, `/v1/lnurlp/tx/{id}` — because a third-party wallet
// derives the submission URL from the callback by swapping `/cb/` for `/tx/` (dpay's own payer
// does exactly that), so the segments are load-bearing, not cosmetic.

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

use crate::app::AppState;

/// The provider's error envelope. NestJS's `{statusCode, message, error}` — the shape measured on
/// the live provider, reproduced here so a wallet written against it parses our failures with the
/// code it already has. Not the LNURL `{status:"ERROR"}` shape, which is what an implementer would
/// expect and what the ecosystem does NOT actually send.
fn provider_error(status: StatusCode, message: &str) -> Response {
    let error = status.canonical_reason().unwrap_or("Error");
    (status, Json(json!({"statusCode": status.as_u16(), "message": message, "error": error}))).into_response()
}

impl TillError {
    /// Map to the wire, matching the measured provider's own wording where an equivalent exists so
    /// a wallet's error handling behaves the same against either implementation.
    fn to_response(&self) -> Response {
        match self {
            // The two DIFFERENT 404s. A wallet must tell them apart: one means "ask the cashier to
            // ring it up", the other means "this code is not ours". The measured provider signals
            // the first by answering with the payment-link payload instead of an error envelope —
            // reproduced by the details handler, so this arm is only ever the honest error case.
            TillError::UnknownCharge => provider_error(StatusCode::NOT_FOUND, "Payment link not found"),
            TillError::NoPendingCharge => provider_error(StatusCode::NOT_FOUND, "Payment link not found"),
            // Both of these have no counterpart on the measured provider, so they say what
            // happened and what to do about it — a payer holding a dead code must be told which
            // kind of dead it is, or they stand at the counter re-scanning it.
            TillError::Superseded => provider_error(
                StatusCode::NOT_FOUND,
                "This code was replaced by a newer charge — ask the cashier for the current one",
            ),
            TillError::AlreadyPaid => provider_error(
                StatusCode::CONFLICT,
                "This charge has already been paid — do not send again; ask the cashier to ring up \
                 a new one if you are paying for something else",
            ),
            TillError::DeadQuote => provider_error(StatusCode::NOT_FOUND, "No actual quote with ID found"),
            TillError::UnsupportedAsset => provider_error(StatusCode::BAD_REQUEST, "Invalid method or asset"),
        }
    }
}

/// Unix seconds now. Every deadline this module states is derived from it.
fn now_secs() -> u64 {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_secs(),
        // Only a host whose clock is set before 1970 gets here. Substituting 0 (what this used to
        // do) would silently make every charge look an epoch stale and every quote already dead —
        // a till that quietly refuses every sale. Say what happened instead.
        Err(e) => panic!(
            "dpay-relay: till: the system clock is before the unix epoch ({e}) — this relay cannot \
             time a charge"
        ),
    }
}

/// The most characters of a stranger's string this module will put in a log line.
const LOG_FIELD_CHARS: usize = 64;

/// A value that came off the wire, made safe to LOG. Control characters become `.` — a `%0A` in a
/// query parameter would otherwise forge a whole log line and a `\r` would overwrite the real one
/// — and the result is capped, because a log is a record and not somewhere to keep somebody's
/// kilobyte. Everything printed below that a caller chose goes through here.
fn log_safe(s: &str) -> String {
    s.chars()
        .take(LOG_FIELD_CHARS)
        .map(|c| if c.is_control() { '.' } else { c })
        .collect()
}

/// ISO-8601 UTC with milliseconds and the `Z`, e.g. `2026-09-03T16:35:56.409Z`.
///
/// Hand-rolled rather than pulling in a date crate for one format, and it is the ONE spelling both
/// the measured provider emits and dpay's strict reader accepts. Civil-from-days is Howard
/// Hinnant's algorithm — the standard one, and correct across leap years and centuries. Public for
/// the same reason [`QUOTE_TTL_SECS`] is: it IS the deadline spelling this provider promises, so the
/// wire golden pins observed deadlines against it rather than against a second copy of the format.
pub fn iso8601_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let tod = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z",
        tod / 3_600,
        (tod % 3_600) / 60,
        tod % 60
    )
}

/// A charge or quote id: 8 bytes from the OS CSPRNG, hex.
///
/// It is a BEARER READ-TOKEN — the id alone opens the charge's price, the merchant's claimed name
/// and, once paid, the payer's principal — so it is generated the way a token is. What it used to
/// be was a `SipHash` of a nanosecond clock keyed by `RandomState`: a hash designed for spreading
/// keys in a map, over an input an observer can narrow to a handful of candidates. Guessing an id
/// still credits nobody (a report only ever settles what actually arrived on the ledger), which is
/// what makes this a privacy boundary rather than a money one — and privacy boundaries are still
/// boundaries.
fn fresh_id(prefix: &str) -> String {
    let mut bytes = [0u8; 8];
    match getrandom::getrandom(&mut bytes) {
        Ok(()) => {}
        // No fallback, deliberately: a guessable id would be handed out silently, and every
        // caller would believe it was random. A relay with no CSPRNG is a relay that must stop.
        Err(e) => panic!("dpay-relay: till: the OS CSPRNG is unavailable ({e}) — cannot mint an id"),
    }
    format!("{prefix}{}", hex::encode(bytes))
}

/// The origin to build absolute URLs from.
///
/// `DPAY_PUBLIC_ORIGIN` wins when set (an explicit deploy-time answer). Otherwise it is derived from
/// the request: `Host` plus `X-Forwarded-Proto`, which the Cloudflare tunnel in front of prod
/// already sets — so the deployed relay is self-configuring and a local run is honestly `http`.
/// Deriving from a client-supplied header is safe HERE because the value only ever travels back to
/// that same client: a forged `Host` can mislead nobody but its sender.
fn origin_of(headers: &HeaderMap) -> String {
    match std::env::var(PUBLIC_ORIGIN_ENV) {
        Ok(explicit) if !explicit.trim_end_matches('/').is_empty() => {
            return explicit.trim_end_matches('/').to_string()
        }
        Ok(_) => {} // set to nothing: the deploy said nothing, so the request answers instead
        Err(std::env::VarError::NotPresent) => {} // the ordinary local/dev case
        Err(e) => eprintln!(
            "dpay-relay: till: {PUBLIC_ORIGIN_ENV} is set but unreadable ({e}); deriving the origin \
             from the request instead"
        ),
    }
    // Absent or unreadable header values fall to what a local run honestly is, and say so — a
    // silently wrong origin would put an unreachable URL in a merchant's QR.
    let host = match headers.get("host").map(|v| v.to_str()) {
        Some(Ok(host)) => host,
        Some(Err(e)) => {
            eprintln!("dpay-relay: till: the Host header is not text ({e}); using localhost");
            "localhost"
        }
        None => "localhost",
    };
    let scheme = match headers.get("x-forwarded-proto").map(|v| v.to_str()) {
        Some(Ok(scheme)) => scheme,
        Some(Err(e)) => {
            eprintln!("dpay-relay: till: X-Forwarded-Proto is not text ({e}); using http");
            "http"
        }
        None => "http", // nothing in front of us: a direct local run really is http
    };
    format!("{scheme}://{host}")
}

/// The deploy-time answer to "what URL do wallets reach this relay at".
const PUBLIC_ORIGIN_ENV: &str = "DPAY_PUBLIC_ORIGIN";

/// `POST /api/v1/till` — the merchant rings one up.
pub(crate) async fn open_charge(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<OpenCharge>,
) -> Response {
    if req.cents == 0 {
        return provider_error(StatusCode::BAD_REQUEST, "a charge must be for more than nothing");
    }
    if req.cents > MAX_CENTS {
        return provider_error(
            StatusCode::BAD_REQUEST,
            &format!(
                "a charge must be at most {} CHF — split a larger sale, or take it off the till",
                MAX_CENTS / 100
            ),
        );
    }
    let Ok(raw) = hex::decode(&req.merchant_pubkey) else {
        return provider_error(StatusCode::BAD_REQUEST, "merchant_pubkey must be 32-byte hex");
    };
    let Ok(pk) = <[u8; 32]>::try_from(raw.as_slice()) else {
        return provider_error(StatusCode::BAD_REQUEST, "merchant_pubkey must be 32-byte hex");
    };
    // The merchant's account is DERIVED from their key by the same rule every other read in this
    // relay uses, so they cannot name an account they could not sign for — and dpay still holds
    // nothing: this is a public derivation, not a key.
    let account = dpay_icp::principal::Principal::self_authenticating_ed25519(&pk).to_text();

    let id = fresh_id("pl_");
    let now = now_secs();
    let charge = {
        let mut tills = state.tills.lock().unwrap_or_else(|p| p.into_inner());
        tills.sweep(now);
        tills.open(id.clone(), account, pk, req.merchant_name.clone(), req.cents, now)
    };
    let origin = origin_of(&headers);
    (
        StatusCode::OK,
        Json(json!({
            "id": charge.id,
            "amount": charge.amount_text(),
            "asset": ASSET,
            "merchant": charge.merchant,
            // What a wallet must be pointed at. The LNURL bech32 wrapper is NOT built here — the
            // surface that renders the QR owns that, and dpay's own payer accepts this bare
            // provider URL directly.
            "url": format!("{origin}/v1/lnurlp/{}", charge.id),
        })),
    )
        .into_response()
}

/// `GET /api/v1/till/{id}` — what the merchant's screen polls.
///
/// Settlement is re-derived from the LEDGER on every poll, not read out of memory, so the answer
/// survives a relay restart and cannot drift from what actually happened on chain.
pub(crate) async fn charge_status(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let charge = {
        let tills = state.tills.lock().unwrap_or_else(|p| p.into_inner());
        tills.get(&id).cloned()
    };
    let Some(charge) = charge else {
        return TillError::UnknownCharge.to_response();
    };
    let charge = observe_payment(&state, charge).await;
    (
        StatusCode::OK,
        Json(ChargeStatus {
            id: charge.id.clone(),
            cents: charge.cents,
            amount: charge.amount_text(),
            merchant: charge.merchant.clone(),
            // Reported, never enforced: an expired or superseded charge that WAS paid still shows
            // its settlement, because the money moved and the merchant needs to see it.
            state: charge.state(now_secs()),
            paid: charge.paid.clone(),
        }),
    )
        .into_response()
}

/// Read the merchant's own incoming history and settle the charge if the payment is there.
///
/// THE HEART OF THE DESIGN, and the reason this provider cannot repeat the defect that cost a real
/// payment on 2026-09-03: the ledger read is keyed by the CHARGE's asset and the MERCHANT's key,
/// both of which we chose. Nothing a payer sends selects a ledger, so there is no wrong ledger to
/// look at. A read failure leaves the charge exactly as it was — unpaid is never asserted, only
/// "not seen yet".
async fn observe_payment(state: &AppState, charge: Charge) -> Charge {
    let now = now_secs();
    let charge = {
        let mut tills = state.tills.lock().unwrap_or_else(|p| p.into_inner());
        match tills.observe(&charge.id, now) {
            Ok(Observation::Walk(c)) => c,
            Ok(Observation::Recent(c)) => return c,
            Err(e) => {
                // The charge was swept between the caller's read and this claim. Nothing to
                // observe and nowhere to record it — say so rather than walking a ledger for a
                // charge that no longer exists.
                eprintln!(
                    "dpay-relay: till {}: cannot observe a charge this store no longer holds ({e:?})",
                    log_safe(&charge.id)
                );
                return charge;
            }
        }
    };
    let rows = match merchant_history(state, &charge).await {
        Ok(rows) => rows,
        Err(e) => {
            // Never downgrade a read failure into "not paid" — the caller keeps polling.
            eprintln!("dpay-relay: till {}: could not read merchant history: {e}", charge.id);
            return charge;
        }
    };
    let mut tills = state.tills.lock().unwrap_or_else(|p| p.into_inner());
    match tills.settle_from_history(&charge.id, &rows) {
        Ok(Some(settled)) => Charge { paid: Some(settled), ..charge },
        Ok(None) => charge,
        Err(e) => {
            eprintln!(
                "dpay-relay: till {}: the charge was swept while its history was read ({e:?}) — \
                 nothing credited",
                log_safe(&charge.id)
            );
            charge
        }
    }
}

/// The merchant's own incoming history on the charge's asset, from whichever ledger this build
/// talks to.
///
/// With the fake-IC gateway attached (test-helpers) history lives in the gateway's principal-keyed
/// log — the same records a signed icrc1_transfer appends. Prod walks the real ICRC ledger. Same
/// discipline either way, and the SAME reason the branch exists for `/transactions` in `app.rs`:
/// the offline loop must exercise the code path, not a stub of it.
async fn merchant_history(
    state: &AppState,
    charge: &Charge,
) -> Result<Vec<TxnRecord>, crate::ledger::LedgerError> {
    #[cfg(feature = "test-helpers")]
    if let Some(fake) = state.fake_ic.clone() {
        let owner = dpay_icp::principal::Principal::self_authenticating_ed25519(&charge.merchant_pubkey);
        return Ok(fake.transactions(&owner, VCHF_CURRENCY, HISTORY_LIMIT as usize, None));
    }
    let Some(row) = crate::catalog::ic_rows().into_iter().find(|d| d.currency == VCHF_CURRENCY) else {
        // The compiled catalog is this relay's own code, so a missing VCHF row is a build that
        // cannot serve this till at all — loud, not a silent "not seen yet".
        return Err(crate::ledger::LedgerError::Rejected(
            "VCHF is not in this relay's compiled catalog — this build cannot serve a till".into(),
        ));
    };
    state
        .ledger
        .transactions_on_ledger(&row.ledger, charge.merchant_pubkey, VCHF_CURRENCY, HISTORY_LIMIT, None)
        .await
}

/// VCHF's catalog id — the one asset v1 serves.
const VCHF_CURRENCY: dpay_core::Currency = 7;
/// How far back a settlement scan looks. A charge lives an hour; a till doing a transfer a second
/// would still be covered many times over.
const HISTORY_LIMIT: u32 = 50;

#[derive(Debug, Deserialize)]
pub(crate) struct DetailsQuery {
    /// Long-poll seconds, per the standard. Honoured only as `0` today (answer immediately); a
    /// wallet that asks to wait simply gets the current state, which is a legal answer.
    #[allow(dead_code)]
    pub timeout: Option<u64>,
}

/// `GET /v1/lnurlp/{id}` — step 2, the payment details and a fresh quote.
pub(crate) async fn lnurlp_details(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(_q): Query<DetailsQuery>,
) -> Response {
    let now = now_secs();
    let origin = origin_of(&headers);
    let (charge, quote_id, expires) = {
        let mut tills = state.tills.lock().unwrap_or_else(|p| p.into_inner());
        let Some(charge) = tills.get(&id).cloned() else {
            return TillError::UnknownCharge.to_response();
        };
        match tills.quote(&id, fresh_id("plq_"), now) {
            Ok((q, exp)) => (charge, q, exp),
            Err(e) => return e.to_response(),
        }
    };

    let body = DetailsBody {
        tag: "payRequest",
        callback: format!("{origin}/v1/lnurlp/cb/{}", charge.id),
        // See the field's own note: LUD-06 means millisatoshis, this till has no rate, so it
        // states nothing rather than a number in the wrong unit.
        min_sendable: 0,
        max_sendable: 0,
        // BUILT, not formatted. `metadata` is a JSON document inside a JSON string, and the
        // merchant's name is a stranger's text: pasted into the shape with `format!`, a name of
        // `X"],["image/png;base64,…` closes the entry and opens a second one that wallets parse
        // and render — proven against this very till on prod. A serialiser cannot be talked into
        // that, because it escapes what it is given instead of trusting it.
        metadata: serde_json::json!([[
            "text/plain",
            format!("{} - CHF {}", charge.merchant_name, charge.price_text())
        ]])
        .to_string(),
        display_name: charge.merchant_name.clone(),
        standard: "OpenCryptoPay",
        possible_standards: vec!["OpenCryptoPay"],
        display_qr: true,
        quote: QuoteBody { id: quote_id, expiration: iso8601_utc(expires) },
        requested_amount: RequestedAmount { asset: "CHF", amount: charge.cents as f64 / 100.0 },
        transfer_amounts: vec![TransferAmount {
            method: METHOD,
            min_fee: 0,
            available: true,
            assets: vec![AssetAmount { asset: ASSET, amount: charge.amount_text() }],
        }],
    };
    (StatusCode::OK, Json(body)).into_response()
}

#[derive(Debug, Deserialize)]
pub(crate) struct PayQuery {
    pub quote: Option<String>,
    pub method: Option<String>,
    pub asset: Option<String>,
    /// The payer's transaction identifier. Accepted because the standard says so and recorded for
    /// support, but NEVER the thing that decides settlement — see `observe_payment`.
    pub tx: Option<String>,
}

/// `GET /v1/lnurlp/cb/{id}` — step 3, where to send the money.
pub(crate) async fn lnurlp_callback(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<PayQuery>,
) -> Response {
    let now = now_secs();
    let (method, asset) = (q.method.unwrap_or_default(), q.asset.unwrap_or_default());
    if let Err(e) = supported(&method, &asset) {
        return e.to_response();
    }
    let (charge, expires) = {
        let tills = state.tills.lock().unwrap_or_else(|p| p.into_inner());
        let charge = match tills.get(&id) {
            Some(c) => c.clone(),
            None => return TillError::UnknownCharge.to_response(),
        };
        // The charge's own state first, then the quote's: a payer whose code was superseded needs
        // to hear THAT, not "no actual quote with ID found", which tells them nothing they can act
        // on. Both refusals name the next move.
        if let Err(e) = charge.payable(now) {
            return e.to_response();
        }
        match tills.quote_expiry(&id, q.quote.as_deref().unwrap_or_default(), now) {
            Ok(expires) => (charge, expires),
            Err(e) => return e.to_response(),
        }
    };
    let Some(row) = crate::catalog::ic_rows().into_iter().find(|d| d.currency == VCHF_CURRENCY) else {
        return provider_error(StatusCode::INTERNAL_SERVER_ERROR, "VCHF is not in this relay's catalog");
    };
    let body = TransferBody {
        expiry_date: iso8601_utc(expires),
        blockchain: METHOD,
        // The LIVE URI shape, not the README's: `icp:<LEDGER>/transfer?to=<PRINCIPAL>&amount=…`.
        // The ledger is named explicitly so a wallet pays the right one — which is precisely what
        // the measured provider fails to do on its own verification side.
        uri: format!("icp:{}/transfer?to={}&amount={}", row.ledger, charge.merchant, charge.amount_text()),
        hint: "Transfer the exact amount to the address in the URI, then report the transaction. \
               Reporting is idempotent: if it fails, retry — the payment is confirmed by reading the \
               ledger, not by this call."
            .to_string(),
    };
    (StatusCode::OK, Json(body)).into_response()
}

/// `GET /v1/lnurlp/tx/{id}` — step 4, the payer reports having paid.
///
/// SAFE TO RETRY, which is the whole point. It does not consume the quote, does not bind the
/// reported identifier to anything, and reaches its answer by re-reading the ledger — so a timeout
/// costs a round trip rather than a payment. The measured provider burns both the quote and the
/// transaction id here even on failure, which is the loss path dpay's payer side is built to
/// survive; as the provider, we refuse to create it.
pub(crate) async fn lnurlp_submit(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<PayQuery>,
) -> Response {
    let (method, asset) = (q.method.unwrap_or_default(), q.asset.unwrap_or_default());
    if let Err(e) = supported(&method, &asset) {
        return e.to_response();
    }
    let charge = {
        let tills = state.tills.lock().unwrap_or_else(|p| p.into_inner());
        match tills.get(&id) {
            Some(c) => c.clone(),
            None => return TillError::UnknownCharge.to_response(),
        }
    };
    // Recorded for support, never believed. Both values came off the wire from a stranger, so
    // both are sanitised: a raw `%0A` here writes whatever line its sender chose into this
    // relay's log.
    match q.tx.as_deref() {
        Some(tx) => eprintln!(
            "dpay-relay: till {}: payer reported transaction {}",
            log_safe(&id),
            log_safe(tx)
        ),
        // The standard's `tx` is optional and a report without one is still a valid nudge to
        // re-read the ledger — worth a line, because a wallet that never sends one is a wallet
        // whose behaviour we would otherwise be guessing at.
        None => eprintln!(
            "dpay-relay: till {}: payer reported a payment without a transaction id",
            log_safe(&id)
        ),
    }
    let charge = observe_payment(&state, charge).await;
    match charge.paid {
        Some(settled) => (StatusCode::OK, Json(json!({"status": "OK", "paid": settled}))).into_response(),
        // NOT an error the payer must act on, and deliberately not a refusal: the transfer may
        // simply not have landed yet. Retrying is correct and free.
        None => (
            StatusCode::ACCEPTED,
            Json(json!({"status": "PENDING", "message": "no matching transfer seen yet — safe to retry"})),
        )
            .into_response(),
    }
}
