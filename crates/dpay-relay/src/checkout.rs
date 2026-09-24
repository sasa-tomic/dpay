//! The merchant half of OpenCryptoPay — dpay **as** the provider.
//!
//! Everything else in this repo pays someone else's checkout. This serves one: a shop shows a code, a
//! dpay wallet pays it, and the money lands at the MERCHANT'S OWN account. A DPAY wallet, and only
//! one — no other wallet on the standard settles the rail v1 quotes, which is measured in the
//! findings doc below and corrected through the plan. The standard's shape is still what this
//! serves, because it is the shape a second rail would arrive through. Plan, and the founder
//! decisions this implements: `docs/specs/2026-09-02-merchant-side-plan.md`. Measured provider
//! behaviour this must be compatible with: `docs/specs/2026-09-01-opencryptopay-findings.md`.
//!
//! FIVE THINGS DECIDE THE WHOLE DESIGN.
//!
//! 0. **A checkout-open is SIGNED, and so is a cancellation.** The merchant's account is DERIVED from
//!    the key they name, so naming a key is claiming an account — and until 2026-09-04 that claim
//!    was taken on trust. A probe opened a live production charge with `deadbeef…deadbeef`, a key
//!    nobody holds, and this relay served a full payment page for it on dpay's own domain under
//!    dpay's own certificate: a phishing page aimed at the one control a payer's review has, which
//!    host served the quote. The whole acceptance rule now lives in `dpay_core::validate_checkout_open`
//!    (skew window, then signature, then nonce) and both merchant routes go through
//!    [`CheckoutStore::authorize`]. The two are told apart by a SIGNED field rather than by which URL
//!    they arrived at: a checkout-open is `cents >= 1`, a cancellation is `cents == 0`, so neither
//!    signature can ever be replayed as the other.
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
//!    and its mechanism live at [`match_payment`] and [`CheckoutStore`].
//!
//! 5. **EVERY CHARGE NAMES ITSELF.** A charge mints a 16-byte reference at open
//!    ([`Charge::reference`]), hands it to the payer on the step-3 URI as `&ref=`, and credits only
//!    a transfer whose ICRC-1 memo carries it. That turns "a transfer that looks like this sale"
//!    into "the transfer for this sale", and it is what a checkout serving many customers at once needs
//!    before it can serve them — matching on amount alone cannot tell two identical prices apart.
//!    The MERCHANT is told it too, on the checkout-open they signed ([`open_charge`]) and nowhere else —
//!    without that, a payment the merchant collects any other way than through the payer routes
//!    (a tap, which never touches them) moves the money and credits no sale.
//!
//! NO CUSTODY, and it is structural rather than promised: the destination in every response is the
//! merchant's own account, supplied by the merchant, and this relay never holds a key that could
//! move it. dpay publishes a price and observes an arrival. That is the whole of its role.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use dpay_core::{validate_checkout_open, CheckoutOpen, CheckoutOpenError, NONCE_LEN, PUBKEY_LEN, SIG_LEN};
use serde::{Deserialize, Serialize};

use crate::ledger::TxnRecord;
use crate::now_secs;

/// VCHF's decimals — the raw units a `1.` on the wire means, the scale `RAW_PER_CENT` below is
/// derived from, and the precision [`Charge::amount_text`] spells a settlement amount at. The drift
/// alarm in this module's tests checks it against the compiled catalog, so a catalog row that moved
/// to another precision fails the build instead of silently re-pricing every charge this checkout
/// quotes.
const VCHF_DECIMALS: u32 = 8;

/// Raw VCHF units per CHF cent: `10^8 / 100`. Integer arithmetic end to end — a price that passed
/// through an `f64` is a price that can be wrong in the last digit, and the last digit of money is
/// the one people notice.
const RAW_PER_CENT: u64 = 1_000_000;

/// THE VCHF LEDGER'S OWN TRANSFER FEE, and the shop's to pay — not the customer's.
///
/// A price is a price: open CHF 1.00 and the customer's account must go down by CHF 1.00, not by
/// CHF 1.0001. That is how every card terminal in the world behaves and it is now how this checkout
/// behaves (founder, 2026-09-12). An ICRC ledger gives exactly one lever for it, because the
/// protocol ALWAYS debits the fee from the sender on top of the amount and has no way to charge the
/// recipient: quote the price MINUS the fee as the settlement amount. The payer's wallet then
/// debits `(price - fee) + fee` — the price, exactly — and the shop receives the rest, which is the
/// shop absorbing the fee. It also means the amount on the wire can never again equal the price,
/// which is why [`Charge::amount_text`] formats raw units rather than cents.
///
/// Pinned against the compiled catalog's VCHF row by this module's own drift test, for the same
/// reason [`RAW_PER_CENT`] is: a fee that moved under us would silently overcharge or undercharge
/// every sale by the difference.
const LEDGER_FEE_RAW: u64 = 10_000;

/// How long a quote is good for. Matched to the measured provider (300 s) so a wallet written
/// against DFX meets the timing it already expects. It costs us nothing to honour — the price is
/// 1:1 and cannot move — but a wallet's countdown and runway maths are calibrated to this. Public
/// because it is a stated property of this provider rather than an implementation detail: the wire
/// golden pins every deadline this module emits against it.
pub const QUOTE_TTL_SECS: u64 = 300;

/// How long a charge stays payable before the checkout must open a fresh charge. THE ONE LIFETIME: a
/// quote is clamped to it (see [`CheckoutStore::quote`]) so nothing this checkout hands out can outlive
/// the charge it belongs to, and every read decides payability through [`Charge::state`] rather
/// than re-deriving a deadline of its own. Public for the same reason [`QUOTE_TTL_SECS`] is: the
/// wire states it (`expires_at`), so the golden pins the served instant against the rule instead of
/// against a second copy of the arithmetic.
pub const CHARGE_TTL_SECS: u64 = 60 * 60;

/// How long a CREDITED charge is kept after it was opened. Deliberately far longer than
/// [`CHARGE_TTL_SECS`], because the two are different facts: an unpaid stale charge is litter,
/// while a paid one is the merchant's record of a sale AND the mark that stops its ledger row
/// paying anything else (see [`CheckoutStore::consumed_blocks`]). A day is the bound because that mark
/// only has to outlive the row's own visibility: a settlement scan looks back [`HISTORY_LIMIT`]
/// rows, which even a checkout doing a transfer a second exhausts in under a minute. Not forever:
/// memory is bounded.
const SETTLED_TTL_SECS: u64 = 24 * 60 * 60;

/// The most charges one merchant may hold in this store at once.
///
/// It exists because ringing up is AUTHENTICATED but not RATIONED: a merchant holding their own key
/// can sign as fast as they like, and every accepted checkout-open adds a charge that lives an hour
/// unpaid ([`CHARGE_TTL_SECS`]) or a day credited ([`SETTLED_TTL_SECS`]). Unbounded, that is one
/// signer growing this relay's memory without limit — the residual risk the signed-checkout-open change
/// left open.
///
/// The number is a MEMORY bound, deliberately far above any trading limit: a checkout ringing up a sale
/// every ten seconds, without a pause, for the whole day a credited charge is kept, makes 8 640 —
/// already several times what a human counter does — and a charge costs on the order of a kilobyte
/// (its ids, the merchant's account text, a clamped name and up to [`MAX_LIVE_QUOTES`] quotes). So
/// this caps one merchant at roughly ten megabytes and will not be met by a shop.
///
/// Enforced in the STORE rather than at the door, unlike [`MAX_CENTS`], because it is a fact about
/// what the store holds and nowhere else can answer it. The refusal is still given a voice
/// ([`CheckoutError::CheckoutFull`]).
const MAX_CHARGES_PER_MERCHANT: usize = 10_000;

/// How long one ledger observation of a charge is reused for.
///
/// Every read of a charge re-derives settlement from the merchant's own history, which is a real
/// IC walk (measured at 0.6–1.05 s against mainnet). Unbounded, that makes two public routes an
/// amplifier: one cheap HTTP request, one mainnet ledger walk. This bounds the walk to at most one
/// per charge per window however many callers ask, and costs nothing that matters — the answer it
/// reuses is at most two seconds old, and the sale it may not yet name is named on the next poll.
const OBSERVE_TTL_SECS: u64 = 2;

/// The most a single charge may be for, in CHF cents — one million francs, which is not a checkout
/// charge. It exists so `Charge::amount_raw` can never saturate: a price whose raw units do not
/// fit is a price the checkout would quote wrongly, and quoting a wrong number is worse than refusing.
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
    /// What the charge is FOR, in the merchant's own words ("2× Kafi, Tisch 4") — the one-line
    /// purpose a payer reads on review before paying. CLAIMED like the name and SIGNED with it
    /// (under `CHECKOUT_OPEN_DOMAIN_V2`), because an unsigned field inside a signed request is a field
    /// this relay cannot attribute to anybody — and this one tells the payer what they are paying
    /// for. `None` = the note-less v1 request every older app sends. Clamped for display by
    /// [`CheckoutStore::open`] under the same bound as the name, strictly AFTER the signature covered
    /// every byte (see [`clamp_name`]).
    pub note: Option<String>,
    /// The price in CHF cents — the number the merchant typed and the cashier reads aloud.
    pub cents: u64,
    /// THIS CHARGE'S NAME ON THE LEDGER: 16 bytes of OS randomness as hex, minted at open, put
    /// on the step-3 URI as `&ref=`, and echoed back by the payer as the transfer's ICRC-1 memo.
    /// `match_payment` credits only a row carrying it, which is what makes a match exact rather
    /// than a resemblance — and the reason a checkout will be able to hold several customers' charges
    /// at the same price at once without any of them being ambiguous.
    ///
    /// 16 bytes because that is the width dpay's reconciliation memo already has everywhere else
    /// (`ref` in the payment-link grammar, `app/lib/deepLink.ts`); one width for one kind of value,
    /// rather than a second one invented here. Unguessable for the same reason a charge id is: it
    /// is handed to exactly one payer, and a party who does not hold it cannot aim a transfer at
    /// this sale.
    ///
    /// SERVED TO THE MERCHANT ON THE CHECKOUT-OPEN, and to nobody else on the merchant's own routes —
    /// see [`open_charge`] for what it unlocks and [`ChargeStatus`] for why the poll does not
    /// repeat it.
    pub reference: String,
    pub created_secs: u64,
    /// Quote ids issued for this charge and still live, with their expiries.
    quotes: Vec<(String, u64)>,
    /// Why this charge stopped being payable without being paid, if it has. Voiding stops it being
    /// QUOTED (nobody new may be sent to pay it) and never stops it being OBSERVED: a payer who was
    /// already holding its instructions may have sent the money a heartbeat before it was voided,
    /// and refusing to see that transfer would lose it.
    ///
    /// The CAUSE is carried rather than just the fact, because the two causes send a payer standing
    /// at the counter to do opposite things — scan the cashier's new code, or put their phone away.
    /// The FIRST cause wins ([`CheckoutStore::void`] inserts, never overwrites): a charge the cashier
    /// cancelled and then closed was cancelled, and saying it was merely replaced would be a
    /// nudge to go and pay the new one.
    voided: Option<VoidCause>,
    /// When the ledger was last read on this charge's behalf — the amplification bound, see
    /// [`OBSERVE_TTL_SECS`]. Not a settlement fact: it says when we looked, never what we found.
    observed_at: Option<u64>,
    /// The settlement, once observed on the ledger. Set once and never cleared: a credited sale
    /// does not become uncredited because a later read of history was slow or empty.
    pub paid: Option<Settled>,
    /// A payer's CLAIM that they have approved this shop to collect the charge — see [`PullClaim`].
    /// Nothing here believes it; it is carried to the merchant, whose own device is the only thing
    /// that can act on it and the only thing that can find out whether it was true.
    pub pull: Option<PullClaim>,
}

/// "I have approved you — come and take it."
///
/// The report an ICRC-2 *allowance* wallet makes instead of sending a transfer (Oisy is one): it
/// calls `icrc2_approve` naming the shop as spender, then reports its own principal to step 4 so
/// the provider can call `icrc2_transfer_from`. dpay's relay cannot: it holds no key, by the
/// non-custody rule, and it never will. The shop's own phone can — the allowance names the SHOP as
/// spender, that phone holds the shop's key and is already polling this charge — so the relay's
/// whole job here is to carry the message.
///
/// **This is a claim, not a fact, and it arrives on an unauthenticated route.** Anyone who holds
/// the charge id can post any principal. What stops that from mattering: a pull can only ever move
/// money that principal DELIBERATELY approved this shop to take, for this charge's exact amount, so
/// a made-up claim moves nothing and fails at the ledger. The residual is real and narrow, and is
/// written down rather than hidden: a customer who approved this shop for one charge and walked
/// away leaves an allowance that a claim naming them could aim at the shop's NEXT charge of the
/// same size, inside the wallet's five-minute approval window. One live charge per merchant and
/// that window are the bounds; the customer is standing at the counter for both.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct PullClaim {
    /// The account the payer says they approved FROM, as canonical principal text — claimed, never
    /// verified here. It is also, deliberately, the same fact this route already publishes about a
    /// SETTLED charge (`Settled::from`), so carrying it changes no disclosure class.
    pub payer: String,
    /// When the claim arrived. The merchant's screen uses it to say how fresh it is, and the store
    /// uses nothing at all: a claim is not a clock and does not expire on its own — the allowance
    /// behind it does, on the ledger, which is the only place that can be checked.
    pub at_secs: u64,
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

/// Why a charge stopped being payable without having been paid. Named at the store's door
/// ([`CheckoutStore::void`]) so the ONE mechanism serves both: ringing up the next customer, and a
/// cashier clearing a total they mis-keyed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VoidCause {
    /// A newer charge for the same merchant replaced this one.
    Superseded,
    /// The merchant cancelled it — a signed `cents = 0` on `POST /api/v1/checkout/void`.
    Cancelled,
}

impl VoidCause {
    fn state(self) -> ChargeState {
        match self {
            VoidCause::Superseded => ChargeState::Superseded,
            VoidCause::Cancelled => ChargeState::Cancelled,
        }
    }
}

/// Where a charge stands, as one answer rather than four booleans a caller has to combine.
/// `Paid` outranks everything (a credited sale is credited however the charge was opened),
/// then the void causes, then `Expired`.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChargeState {
    /// Payable: quotes may be minted and transfer instructions handed out.
    Open,
    /// Credited on the ledger. Nothing more is owed and nothing more may be quoted.
    Paid,
    /// The cashier opened a newer charge for this merchant, which replaced this one.
    Superseded,
    /// The merchant cancelled it. TOLD APART from `Superseded` because the instruction differs:
    /// a superseded code means "scan the new one", a cancelled one means "nothing is owed".
    Cancelled,
    /// Past [`CHARGE_TTL_SECS`] with nothing credited — the cashier must open a fresh charge.
    Expired,
}

/// A raw VCHF amount as this provider spells a decimal on the wire — the measured provider's own
/// rule, applied to raw units: trailing zeros trimmed, and the point kept even when nothing is left
/// after it (`1.` for one whole token). That bare trailing point is the spelling naive decimal
/// parsers reject and dpay's own accepts, so it is reproduced rather than tidied away.
///
/// Pure and separate from [`Charge::amount_text`] so the spelling can be tested across its whole
/// input domain — including the whole-token case, which a fee-netted price can no longer reach but
/// which is still the rule, and would be reachable again the day the fee is zero.
fn raw_decimal(raw: u64) -> String {
    let scale = 10u64.pow(VCHF_DECIMALS);
    let frac = format!("{:0width$}", raw % scale, width = VCHF_DECIMALS as usize);
    format!("{}.{}", raw / scale, frac.trim_end_matches('0'))
}

impl Charge {
    /// The exact raw VCHF the payer must transfer — the price, LESS the ledger fee the payer's own
    /// transfer will cost, so that what leaves the customer's account is the price and nothing
    /// more. The whole reasoning is [`LEDGER_FEE_RAW`]; the arithmetic is here because this is the
    /// ONE place the settlement amount exists (the wire quotes it, the payer sends it, and
    /// [`match_payment`] credits nothing else).
    ///
    /// Neither saturation can bind, and both are saturations rather than panics only so this stays
    /// total for a caller holding a charge from anywhere: [`MAX_CENTS`] is refused at the door, and
    /// the smallest price this checkout can open is one rappen — [`RAW_PER_CENT`] raw units, a
    /// hundred times the fee.
    pub fn amount_raw(&self) -> u64 {
        self.cents
            .saturating_mul(RAW_PER_CENT)
            .saturating_sub(LEDGER_FEE_RAW)
    }

    /// The settlement amount as the wire spells a decimal: `0.9999` for CHF 1, `9.9999` for CHF 10.
    /// Trailing zeros are trimmed because the measured provider trims them (`1.` for one franc),
    /// and a wallet written against it must meet the spelling it already parses — including the
    /// bare trailing point, which is the spelling naive decimal parsers reject and dpay's own does
    /// not. That bare-point case is unreachable while the fee is subtracted (a whole number of
    /// francs stops being a whole number of tokens), but the spelling is the provider's and this is
    /// the function that owns it, so it is stated once here rather than left to a future fee of 0.
    ///
    /// Built from [`Charge::amount_raw`] rather than from cents: the two must agree to the last
    /// digit — a wallet reads this string and [`match_payment`] compares that integer — and the
    /// only way to guarantee that is to have one of them derive the other.
    ///
    /// This is the ASSET amount, and it is machine-read. What a human reads is
    /// [`Charge::price_text`] — a DIFFERENT number now as well as a different audience, because the
    /// customer is asked for the price and the shop receives the price less the fee.
    pub fn amount_text(&self) -> String {
        raw_decimal(self.amount_raw())
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
        match (&self.paid, self.voided) {
            (Some(_), _) => ChargeState::Paid,
            (None, Some(cause)) => cause.state(),
            (None, None) if self.expired(now_secs) => ChargeState::Expired,
            (None, None) => ChargeState::Open,
        }
    }

    /// May this charge be quoted / instructed right now? The refusal names WHICH fact stopped it,
    /// because "ask the cashier for the new code" and "this was already paid" send a payer to do
    /// two different things.
    fn payable(&self, now_secs: u64) -> Result<(), CheckoutError> {
        match self.state(now_secs) {
            ChargeState::Open => Ok(()),
            ChargeState::Paid => Err(CheckoutError::AlreadyPaid),
            ChargeState::Superseded => Err(CheckoutError::Superseded),
            ChargeState::Cancelled => Err(CheckoutError::Cancelled),
            ChargeState::Expired => Err(CheckoutError::NoPendingCharge),
        }
    }

    /// The second this charge stops being payable — THE ONE deadline, stated rather than left to
    /// each reader to re-derive. It is what `expires_at` on both merchant-facing bodies carries, so
    /// a cashier's screen can count a charge down without a copy of [`CHARGE_TTL_SECS`] of its own.
    pub fn expires_at(&self) -> u64 {
        self.created_secs.saturating_add(CHARGE_TTL_SECS)
    }

    fn expired(&self, now_secs: u64) -> bool {
        now_secs >= self.expires_at()
    }
}

/// A merchant's claimed name, bounded to [`MERCHANT_NAME_BYTES`] on a CHARACTER boundary (a name
/// cut mid-codepoint is not a string). Total, and lossy only for a name no checkout could print.
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
/// costs the cashier a re-open, never a payment — and never a double credit, because settlement is
/// re-derived from ledger history rather than from anything stored here.
///
/// MANY CHARGES PER MERCHANT, ON PURPOSE. "One live charge per merchant" is a POLICY this store
/// applies at open ([`CheckoutStore::open`] voids the previous one), never the SHAPE of the store —
/// which is why `by_id` holds N charges per merchant and `current` is merely an index into it. The
/// next step for this checkout is an online shop: one merchant, many customers, each with their own
/// charge, none blocking another. A store that could only hold one charge per merchant would have
/// to be rebuilt to get there; this one only has to stop calling `void_current`.
#[derive(Default)]
pub struct CheckoutStore {
    by_id: HashMap<String, Charge>,
    /// merchant account text → the id of THEIR current charge. An index over `by_id`, never a
    /// second copy of it: it may only ever name a charge this store still holds (the sweep clears
    /// it alongside), and a dangling entry is a bug this store reports rather than absorbs.
    current: HashMap<String, String>,
    /// `(merchant_pubkey, nonce)` → the second it was ACCEPTED. What makes a merchant's signature
    /// single-use, and the reason [`CheckoutStore::authorize`] is the only way in: an entry is written
    /// on `Ok(())` and nowhere else, so a stranger firing forged checkout-opens at this relay all day
    /// cannot add one byte to it.
    ///
    /// Bounded by the clock rather than by a cap, which is the whole point of `issued_at` carrying
    /// a time at all: a request is accepted only within ±`CHECKOUT_OPEN_MAX_SKEW_SECS` of its own
    /// `issued_at`, so a nonce accepted at `t` can next be replayed at latest
    /// `issued_at + skew <= t + 2 * skew`. Remembering exactly that long is therefore not a
    /// heuristic — it is the full replay window, and an eviction cap would instead make an evicted
    /// nonce silently replayable.
    seen_nonces: HashMap<([u8; PUBKEY_LEN], [u8; NONCE_LEN]), u64>,
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
pub enum CheckoutError {
    /// No such payment link — a stale or hostile code.
    UnknownCharge,
    /// The link exists but nothing has been opened on it yet. A DIFFERENT fact from the above, and
    /// the measured provider distinguishes them too: this one means "ask the cashier", the other
    /// means "this code is not ours". Collapsing them sends a payer to talk to a cashier who does
    /// not exist.
    NoPendingCharge,
    /// The cashier opened a newer charge for this merchant, which replaced this one. The payer is
    /// holding a code that was current a moment ago — they need the new one, which is a different
    /// instruction from both 404s above.
    Superseded,
    /// The merchant cancelled this charge. NOT the same as `Superseded`, and the difference is the
    /// payer's next move: a superseded code means "scan the cashier's new one", a cancelled one
    /// means "nothing is owed — do not send anything". Telling a payer to go and pay a code that
    /// was cancelled is exactly the mistake this variant exists to prevent.
    Cancelled,
    /// This charge has already been credited on the ledger. Said out loud rather than quietly
    /// quoting it again, because quoting a settled charge invites a SECOND payment that nothing
    /// would ever credit.
    AlreadyPaid,
    /// The quote id is unknown or has expired.
    DeadQuote,
    /// A method/asset pair this checkout does not accept.
    UnsupportedAsset,
    /// This merchant is already holding [`MAX_CHARGES_PER_MERCHANT`] charges. The only refusal here
    /// a PAYER can never meet: it answers a checkout-open, and nothing on the payer's three routes opens
    /// one.
    CheckoutFull,
}

/// Why a merchant's cancellation could not clear their checkout. Two outcomes only, because from the
/// counter there are only two: there was nothing payable to clear, or the money already arrived.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VoidRefusal {
    /// This merchant has no charge in this store at all. Nothing was opened, or the last one was
    /// swept — either way there is no code out there for a customer to be holding.
    NothingOpened,
    /// The charge was CREDITED on the ledger. Money moved, so nothing rings it away; the merchant
    /// is told which block paid them so they can act on the real thing that happened.
    AlreadyPaid(Settled),
}

impl CheckoutStore {
    /// Prove a merchant's request came from the key it names, and BURN its nonce if it did.
    ///
    /// The whole acceptance rule is `dpay_core::validate_checkout_open` — this adds only the two
    /// things a pure function cannot have: the seen-nonce set, and the guarantee that testing it
    /// and marking it happen under one borrow. Split apart, two copies of one signed request
    /// arriving together would both read "unseen" and both open a charge, which is precisely what
    /// a nonce exists to stop.
    ///
    /// RECORDING ONLY ON SUCCESS is what keeps [`CheckoutStore::seen_nonces`] finite: every entry cost
    /// somebody a valid Ed25519 signature over their own key, so the set grows at the rate real
    /// merchants open charges and not at the rate strangers can POST.
    pub fn authorize(
        &mut self,
        open: &CheckoutOpen,
        sig: &[u8; SIG_LEN],
        now_secs: u64,
    ) -> Result<(), CheckoutOpenError> {
        let key = (open.merchant_pubkey, open.nonce);
        validate_checkout_open(open, sig, now_secs, self.seen_nonces.contains_key(&key))?;
        self.seen_nonces.insert(key, now_secs);
        Ok(())
    }

    /// Open a charge, VOIDING this merchant's previous one. `id` and `reference` are supplied by
    /// the caller so the randomness stays in one place (the HTTP layer, which has the CSPRNG) and
    /// this module stays pure and testable.
    ///
    /// The void is the "one live charge per merchant" policy: a cashier who rings up a new total
    /// has abandoned the last one. It is a POLICY over a store that holds many — see the type's own
    /// note for why that distinction is the whole design.
    ///
    /// REFUSED when this merchant is already at [`MAX_CHARGES_PER_MERCHANT`], and refused BEFORE
    /// the void: a checkout-open that cannot be honoured must not also take away the payable charge the
    /// merchant already had, which would turn a bounded refusal into a lost sale.
    ///
    /// AUTHORISATION IS THE CALLER'S: this takes a merchant account and believes it. The one route
    /// that reaches it puts [`CheckoutStore::authorize`] first, which is what makes the void above
    /// safe — before that, an anonymous POST naming somebody else's key could keep re-ringing
    /// their checkout and force a cashier to open a fresh charge on every attempt.
    pub fn open(
        &mut self,
        id: String,
        reference: String,
        merchant: String,
        merchant_pubkey: [u8; 32],
        merchant_name: String,
        note: Option<String>,
        cents: u64,
        now_secs: u64,
    ) -> Result<Charge, CheckoutError> {
        if self.charges_of(&merchant) >= MAX_CHARGES_PER_MERCHANT {
            return Err(CheckoutError::CheckoutFull);
        }
        match self.void(&merchant, VoidCause::Superseded) {
            // The previous charge is closed to new payers. It stays readable and stays OBSERVED —
            // see `Charge::voided` for why blinding it would lose a real payment.
            Ok(_) => {}
            // This merchant's first charge, or their last one was already paid. Nothing to close
            // either way, and a credited sale is not voided by the next customer.
            Err(VoidRefusal::NothingOpened | VoidRefusal::AlreadyPaid(_)) => {}
        }
        let charge = Charge {
            id: id.clone(),
            merchant,
            merchant_pubkey,
            // Clamped HERE so no caller can store an unbounded name: a name arrives from a
            // stranger, is display text, and must not be a way to spend this relay's memory.
            merchant_name: clamp_name(&merchant_name),
            // Same rule for the same kind of string: the note is display text a stranger typed.
            // `None` passes through untouched — an absent note is not an empty one.
            note: note.as_deref().map(clamp_name),
            cents,
            reference,
            created_secs: now_secs,
            quotes: Vec::new(),
            voided: None,
            observed_at: None,
            paid: None,
            pull: None,
        };
        self.current.insert(charge.merchant.clone(), id.clone());
        self.by_id.insert(id, charge.clone());
        Ok(charge)
    }

    /// How many charges this store is holding for one merchant — the count [`MAX_CHARGES_PER_MERCHANT`]
    /// bounds. Derived from `by_id` rather than kept beside it, for the same reason `current` is an
    /// index and not a copy: a second tally is a second thing to drift, and the sweep would have to
    /// keep it honest. A scan is affordable because it happens once per checkout-open, which costs the
    /// caller an Ed25519 signature.
    fn charges_of(&self, merchant: &str) -> usize {
        self.by_id
            .values()
            .filter(|c| c.merchant == merchant)
            .count()
    }

    /// Stop this merchant's current charge being payable, for the stated reason, and return it as
    /// it now stands. Unpaid only: a settled charge is a record of money that moved, and nothing
    /// rings that away.
    ///
    /// THE ONE VOID MECHANISM, with the reason as a parameter — the next checkout-open supersedes, the
    /// cashier cancels, and both land in the same field so `Charge::state` has one thing to read.
    /// IDEMPOTENT, and deliberately so: cancelling an already-cancelled charge is what a cashier
    /// pressing a button twice does, and it succeeds with the charge unchanged rather than
    /// inventing a failure. The first cause is kept (see `Charge::voided`).
    ///
    /// Authorisation is the CALLER's: this takes an account text and believes it. Both routes that
    /// reach it call [`CheckoutStore::authorize`] first.
    pub fn void(&mut self, merchant: &str, cause: VoidCause) -> Result<Charge, VoidRefusal> {
        let Some(id) = self.current.get(merchant).cloned() else {
            return Err(VoidRefusal::NothingOpened); // nothing opened — no code is out there
        };
        let Some(charge) = self.by_id.get_mut(&id) else {
            // The index may only ever name a charge this store holds (the sweep clears both
            // together), so this is a broken invariant rather than an ordinary absence. It is
            // REPORTED and then answered as the truth the caller can act on: nothing is payable.
            eprintln!(
                "dpay-relay: checkout: the merchant index named {id}, which this store no longer \
                 holds — nothing was voided"
            );
            return Err(VoidRefusal::NothingOpened);
        };
        match &charge.paid {
            Some(settled) => Err(VoidRefusal::AlreadyPaid(settled.clone())),
            None => {
                charge.voided.get_or_insert(cause);
                Ok(charge.clone())
            }
        }
    }

    pub fn get(&self, id: &str) -> Option<&Charge> {
        self.by_id.get(id)
    }

    /// Record a payer's claim that they have approved this shop to collect the charge
    /// ([`PullClaim`]). Refused for a charge that is no longer payable, and for one already paid —
    /// there is nothing left to collect in either case, and carrying a claim onto a settled sale
    /// would put a "come and take it" on a screen that has already said "paid".
    ///
    /// The LATEST claim wins, and exactly one is kept. Two customers cannot be mid-payment on one
    /// charge (a checkout-open voids the previous charge, and a shop serves one person at a time), so a
    /// second claim is the same person's wallet reporting again — which is the retry the standard
    /// makes free. Keeping a list would only give the merchant's phone several doomed pulls to try.
    pub fn claim_pull(&mut self, id: &str, payer: String, now_secs: u64) -> Result<(), CheckoutError> {
        let Some(charge) = self.by_id.get_mut(id) else {
            return Err(CheckoutError::UnknownCharge);
        };
        charge.payable(now_secs)?;
        charge.pull = Some(PullClaim {
            payer,
            at_secs: now_secs,
        });
        Ok(())
    }

    /// Mint a quote for a charge and return it. Every read of the payment details mints a fresh one
    /// — the behaviour measured on the live provider, and the reason a wallet may hold several.
    ///
    /// The expiry is CLAMPED to the charge's own death, so this checkout never states a deadline it
    /// will not honour: a quote minted with five minutes left on a charge that has thirty seconds
    /// to live is good for thirty seconds, and says so.
    pub fn quote(
        &mut self,
        id: &str,
        quote_id: String,
        now_secs: u64,
    ) -> Result<(String, u64), CheckoutError> {
        let charge = self.by_id.get_mut(id).ok_or(CheckoutError::UnknownCharge)?;
        charge.payable(now_secs)?;
        let expires = now_secs
            .saturating_add(QUOTE_TTL_SECS)
            .min(charge.expires_at());
        charge.quotes.retain(|(_, exp)| *exp > now_secs);
        if charge.quotes.len() >= MAX_LIVE_QUOTES {
            charge.quotes.remove(0);
        }
        charge.quotes.push((quote_id.clone(), expires));
        Ok((quote_id, expires))
    }

    /// The expiry of a quote this checkout issued for this charge, if it is still live. Returning the
    /// instant rather than a yes/no is what lets step 3 state THE QUOTE's deadline instead of
    /// inventing a second one — one object, one death.
    pub fn quote_expiry(&self, id: &str, quote_id: &str, now_secs: u64) -> Result<u64, CheckoutError> {
        let charge = self.by_id.get(id).ok_or(CheckoutError::UnknownCharge)?;
        charge
            .quotes
            .iter()
            .find(|(q, exp)| q == quote_id && *exp > now_secs)
            .map(|(_, exp)| *exp)
            .ok_or(CheckoutError::DeadQuote)
    }

    /// Decide whether this poll should read the ledger, and mark the claim if it should. See
    /// [`Observation`] and [`OBSERVE_TTL_SECS`].
    pub fn observe(&mut self, id: &str, now_secs: u64) -> Result<Observation, CheckoutError> {
        let charge = self.by_id.get_mut(id).ok_or(CheckoutError::UnknownCharge)?;
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
    ) -> Result<Option<Settled>, CheckoutError> {
        let consumed = self.consumed_blocks();
        let charge = self.by_id.get_mut(id).ok_or(CheckoutError::UnknownCharge)?;
        if charge.paid.is_some() {
            return Ok(charge.paid.clone());
        }
        let Some(settled) = match_payment(charge, rows, &consumed) else {
            return Ok(None);
        };
        charge.paid = Some(settled.clone());
        Ok(Some(settled))
    }

    /// Every ledger row this checkout has already credited, by block index — the CONSUMPTION SET.
    ///
    /// Derived from the charges themselves rather than kept alongside them, so there is exactly
    /// one statement of "this row paid something" (the `Settled` record) and no second structure
    /// to drift out of step with it. Sweeping a settled charge releases its block, which is safe
    /// because [`SETTLED_TTL_SECS`] outlives [`LEDGER_CLOCK_SKEW_SECS`] by a day: by the time a
    /// block is forgotten, no charge this store could hold is allowed to look that far back.
    fn consumed_blocks(&self) -> HashSet<u64> {
        self.by_id
            .values()
            .filter_map(|c| c.paid.as_ref().map(|p| p.block))
            .collect()
    }

    /// Drop charges past their life, and nonces past their replay window. Called opportunistically;
    /// nothing depends on it having run, because every read re-checks state itself and
    /// [`CheckoutStore::authorize`] re-checks the clock.
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
        // A nonce is forgotten only once no signature carrying it could be accepted again — see
        // [`CheckoutStore::seen_nonces`] for why that is exactly twice the skew window. INCLUSIVE, and
        // that boundary is the whole correctness of it: a request accepted at `at` may have been
        // issued as late as `at + skew`, and such a request is still inside the clock window at
        // `at + 2 * skew` exactly. Dropping the nonce one second early hands the replay through the
        // only door that was holding it; keeping it longer is memory spent refusing what the clock
        // already refuses.
        self.seen_nonces
            .retain(|_, at| now_secs <= at.saturating_add(2 * dpay_core::CHECKOUT_OPEN_MAX_SKEW_SECS));
    }
}

/// Shared handle, wrapped the way the rest of the relay wraps mutable state: a poison-tolerant
/// `Mutex` that is never held across an await.
pub type SharedCheckouts = Arc<Mutex<CheckoutStore>>;

/// The one method/asset pair v1 serves. A pair outside this is `UnsupportedAsset` — refused rather
/// than quoted, because quoting anything else would mean holding an exchange rate.
pub(crate) const METHOD: &str = "InternetComputer";
pub(crate) const ASSET: &str = "VCHF";

/// Is this the pair we serve? Case-insensitive on the asset, because an outside wallet echoes back
/// whatever spelling it read and casing is not identity.
pub(crate) fn supported(method: &str, asset: &str) -> Result<(), CheckoutError> {
    if method == METHOD && asset.eq_ignore_ascii_case(ASSET) {
        Ok(())
    } else {
        Err(CheckoutError::UnsupportedAsset)
    }
}

/// Pick the transfer that pays a charge out of the merchant's incoming history.
///
/// THE MATCHING RULE, and every clause of it earns its place:
///   * `to` is the merchant's account — we read their history, but a history walk can carry their
///     outgoing rows too, and an outgoing transfer of the right size must never credit a sale;
///   * the amount is EXACT in raw units — never "at least", so an underpayment is not a payment and
///     a rounding difference is not silently absorbed;
///   * the memo IS this charge's [`Charge::reference`]. The clause that makes a match exact: two
///     customers owing the same shop the same CHF 4.50 are told apart by the thing the checkout minted
///     for each of them, not by which of two identical rows arrived first;
///   * the row has NOT already paid something. `consumed` holds the block index of every row this
///     checkout has credited, and a spent row is spent. It survives the reference rather than being
///     replaced by it, because the two rest on different things: the reference is read out of a
///     PAYER-SUPPLIED memo, while consumption is derived from this store's own settlements. One
///     transfer, one sale therefore stays true without depending on a stranger's field being
///     unforgeable — and unlike the clause below it can only ever refuse a SECOND credit, never a
///     first.
///
/// THE CLOCK CLAUSE IS GONE, and its removal is the point rather than a tidy-up. It refused rows
/// timestamped more than two minutes before the charge, to keep last week's identical sale out —
/// work the reference now does completely, because a 16-byte value minted at open cannot appear
/// on a transfer sent before the checkout-open. What the clause could still do was LOSE money: a row's
/// `timestamp` is IC consensus time and `created_secs` is this relay's wall clock, so a relay
/// running far enough ahead would refuse a correct, referenced payment and credit nothing. A clause
/// that can no longer refuse a wrong payment and can still refuse a right one is not defence.
///
/// Returns the FIRST match in the order history was given (newest-first from the ledger walk), or
/// `None`. `None` is honest "not seen yet", never "refused" — the caller keeps the charge open.
pub(crate) fn match_payment(
    charge: &Charge,
    rows: &[TxnRecord],
    consumed: &HashSet<u64>,
) -> Option<Settled> {
    let want = charge.amount_raw().to_string();
    rows.iter()
        .find(|r| {
            r.to == charge.merchant
                && r.amount.0.to_string() == want
                && r.memo.eq_ignore_ascii_case(&charge.reference)
                && !consumed.contains(&r.block)
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
    /// LUD-06 defines both of these in MILLISATOSHIS, and this checkout cannot state a millisatoshi
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
    /// What the charge is FOR, in the merchant's own signed words ("2× Kafi, Tisch 4"). An
    /// addition to the measured provider's field set, exactly like `ref` on the step-3 URI: the
    /// standard's own wallets read named fields, so one more name costs them nothing, while dpay's
    /// payer renders it on review. Absent for a note-less (v1) charge, so that body stays
    /// byte-identical to what the provider served before the field existed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
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
    /// `now + QUOTE_TTL` here (what this used to do) states a deadline the checkout does not honour:
    /// it outlives the quote by however long the wallet took between step 2 and step 3, so a payer
    /// who waited is told the money is still good for a price that is already dead.
    #[serde(rename = "expiryDate")]
    pub expiry_date: String,
    /// Echoes the requested method VERBATIM. The URI names no asset, so for a wallet this echo is
    /// the only integrity signal the answer carries — dpay's own payer refuses a mismatch, and so
    /// should anyone else's.
    pub blockchain: &'static str,
    /// `icp:<LEDGER>/transfer?to=<PRINCIPAL>&amount=<DECIMAL>&ref=<32 HEX>` — the measured
    /// provider's LIVE shape (not the one its public README documents — findings doc, "Stale-README
    /// trap #1"), plus this checkout's own `ref`.
    ///
    /// `ref` is an ADDITION to that grammar, and it costs compatibility nothing: the wallets that
    /// speak this standard settle rails this checkout does not quote (measured — see the module
    /// header), so the only payer a dpay checkout can have is a dpay build, which ships this parameter
    /// with the relay that emits it. A payer that cannot read a parameter must refuse rather than
    /// drop it (dpay's own does: `ICP_URI_PARAMS`, `app/lib/opencryptopay.ts`), so a wallet meeting
    /// this for the first time fails closed and is never quietly credited to the wrong charge.
    pub uri: String,
    pub hint: String,
}

/// What the merchant's own app and the cashier page poll. `state` is the answer `paid` alone cannot
/// give: a charge that was superseded by the next checkout-open and one that is still waiting look
/// identical through a null `paid`, and the cashier's screen has to tell a customer which of those
/// it is.
///
/// # THE CHARGE ID IS A BEARER READ TOKEN — the threat model this body survives
///
/// `GET /api/v1/checkout/{id}` is UNAUTHENTICATED, and has to be: the cashier page
/// (`../assets/checkout.html`) is a plain browser page on a screen that holds no key, so the route
/// cannot tell the merchant from a bystander by anything it sees. Anybody who photographs the code
/// at the counter can therefore read this body. The question is not whether that is comfortable, it
/// is what such a reader LEARNS THAT THEY COULD NOT OTHERWISE and what they can DO with it — worked
/// field by field against the routes the standard ALREADY obliges this checkout to serve to any caller
/// holding the same id:
///
/// * `id` — the caller's own token.
/// * `cents` / `amount` — the price, in francs and in VCHF. Step 2 (`GET /v1/lnurlp/{id}`) serves
///   both to any caller: `requestedAmount` and `transferAmounts[].assets[].amount`.
/// * `merchant_name` — step 2 serves the same string as `displayName`. Claimed on both, verified on
///   neither; every renderer must mark it so.
/// * `state` — steps 2 and 3 refuse a charge that is not payable, BY CAUSE ([`Charge::payable`]),
///   so superseded / cancelled / expired is already disclosed to a payer who asks.
/// * `created_secs` / `expires_at` — step 2 serves the quote's `expiration` and step 3 the
///   instruction's `expiryDate`. The checkout-open second is the one value here no other route states,
///   and all it says is when a cashier typed a price.
/// * `paid` — the settlement, INCLUDING the payer's account ([`Settled::from`]). The only field
///   worth arguing over, and what closes it is DERIVATION, not obscurity: an id-holder is handed
///   this charge's `reference` and the merchant's account by step 3 (they must be — that is the
///   payer's own instruction), and ICRC-1 ledgers are public, so the transfer carrying that memo to
///   that account is readable straight off the chain by anyone — sender, amount, timestamp and
///   block included. Step 4 ([`lnurlp_submit`]) hands the whole `Settled` back to any caller too.
///   This field restates public state; it creates no link the QR had not already created.
///
/// WHAT AN ID-HOLDER STILL CANNOT DO, which is what makes the above tolerable rather than merely
/// equal: they cannot ENUMERATE (an id is 16 bytes of OS randomness — [`fresh_id`]); cannot open one,
/// void or re-aim anything (both merchant routes demand the signature of the key the destination
/// account derives from — rule 0); cannot make this relay pay anything; and cannot even make it
/// walk a ledger on demand ([`OBSERVE_TTL_SECS`] bounds a charge to one history read every 2 s
/// however hard it is polled). Settlement is derived from this store's own observations, never from
/// anything a stranger writes.
///
/// WHAT IS DELIBERATELY OFF THIS BODY. [`Charge::reference`] — not because it would leak (step 3
/// hands it to any id-holder) but because the merchant was told it on the checkout-open they signed, so
/// restating it here would widen an unauthenticated body for no reader. The same rule retired
/// `merchant`, the destination principal, on 2026-09-08: its only reader was the cashier page,
/// which was printing a 63-character principal in the place it meant the shop's NAME.
///
/// THE PROPERTY ALL OF THIS RESTS ON IS PINNED, not asserted:
/// `the_unauthenticated_status_body_is_exactly_these_fields` fails the moment a field is added, so
/// widening this body forces a deliberate re-derivation of the paragraphs above rather than a diff
/// nobody re-read.
#[derive(Debug, Serialize)]
pub(crate) struct ChargeStatus {
    pub id: String,
    pub cents: u64,
    pub amount: String,
    /// The shop's own CLAIMED name, as signed into the checkout-open and clamped to
    /// [`MERCHANT_NAME_BYTES`]. Every renderer treats it as display text and never as markup.
    pub merchant_name: String,
    pub state: ChargeState,
    /// Unix seconds this charge was opened, and the second it stops being payable
    /// ([`Charge::expires_at`]). Both are on the wire so the cashier's screen can render an honest
    /// countdown without a copy of this module's lifetime constant — the same reason the payer's
    /// half is given the quote's own `expiration` rather than a TTL to add up itself. They are
    /// STATED, never re-derived: `state` above already answers whether the deadline has passed.
    pub created_secs: u64,
    pub expires_at: u64,
    pub paid: Option<Settled>,
    /// A payer's claim that they approved this shop to COLLECT the charge ([`PullClaim`]) — the
    /// one thing on this body the merchant's phone is expected to act on rather than render.
    ///
    /// It rides the unauthenticated poll for the same reason `paid.from` already does: it is the
    /// payer's own principal, which this route publishes the moment the charge settles anyway. What
    /// keeps that safe is that the claim is not a capability — acting on it can only move money the
    /// named account deliberately approved this shop to take. Omitted entirely when there is none,
    /// so a wallet that never claims changes no byte of this body.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pull: Option<PullClaim>,
}

impl ChargeStatus {
    /// One rendering of a charge, so the poll and the cancellation cannot describe the same charge
    /// two different ways. `state` is REPORTED, never enforced: an expired, superseded or
    /// cancelled charge that WAS paid still shows its settlement, because the money moved.
    fn of(charge: &Charge, now_secs: u64) -> Self {
        ChargeStatus {
            id: charge.id.clone(),
            cents: charge.cents,
            amount: charge.amount_text(),
            merchant_name: charge.merchant_name.clone(),
            state: charge.state(now_secs),
            created_secs: charge.created_secs,
            expires_at: charge.expires_at(),
            pull: charge.pull.clone(),
            paid: charge.paid.clone(),
        }
    }
}

/// The merchant's SIGNED request: open one charge (\`cents >= 1\`), or clear the checkout (\`cents == 0\`).
///
/// Every field below is covered by `signature` — `dpay_core::CheckoutOpen::signing_bytes` is the
/// canonical encoding and `dfx/checkout_open_signing.json` pins it for the app that produces one. The
/// two actions share this shape ON PURPOSE and are separated by the SIGNED `cents`, so a captured
/// checkout-open cannot be re-aimed at the cancel route, nor a cancellation at the checkout-open route.
#[derive(Debug, Deserialize)]
pub(crate) struct OpenCharge {
    /// The merchant's own device pubkey, 64 hex. Their account is DERIVED from it exactly as every
    /// other balance and history read in this relay derives one, and the signature must verify
    /// under this very key — so a merchant cannot name an account they cannot sign for, and dpay
    /// still never holds the key.
    pub merchant_pubkey: String,
    #[serde(default)]
    pub merchant_name: String,
    /// The one-line purpose the payer reads on review ("2× Kafi, Tisch 4"), or absent for the
    /// note-less (v1) request every older app sends — `None` and an omitted field are the same
    /// thing, which is what `serde(default)` buys. Inside the signed bytes under
    /// `CHECKOUT_OPEN_DOMAIN_V2` when present, so the relay can attribute it.
    #[serde(default)]
    pub note: Option<String>,
    /// The price in CHF cents; `0` on the cancel route and nowhere else.
    pub cents: u64,
    /// 32 hex — the 16-byte single-use nonce that makes this signature good exactly once.
    pub nonce: String,
    /// Unix SECONDS the merchant's device built this request. Accepted only within
    /// ±`CHECKOUT_OPEN_MAX_SKEW_SECS` of this relay's clock, which is what bounds the nonce set.
    pub issued_at: u64,
    /// 128 hex — the Ed25519 signature over `dpay_core::CheckoutOpen::signing_bytes`.
    pub signature: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use dpay_core::{sign_checkout_open, CHECKOUT_OPEN_MAX_SKEW_SECS};
    use ed25519_dalek::SigningKey;

    const MERCHANT: &str = "ygf2v-iniac-cojwe-damoz-s4act-k4xft-xgpjy-776wl-wr754-qxkgo-4ae";
    const OTHER_MERCHANT: &str = "3sgnf-nsdcx-tojvm-zvbdz-3v6ec-4uqfa-mgstv-xu4tv-uh5r6-wd7yd-cae";
    const PAYER: &str = "lrdna-ain6m-ja6ko-ac4j2-jqk3t-nqs22-4irws-bsm3b-trzzq-3yfz6-mqe";

    /// The reference every fixture charge below is opened with. A fixed value, because what the
    /// tests are about is whether a row CARRIES it — the randomness of a real one is
    /// `an_id_is_minted_unguessably_and_in_the_standards_shape`'s business.
    const REF: &str = "7c1de0f5a3b264978e0d1a5f2c6b4093";

    /// Open a charge, or fail the test with the refusal. The store's `Result` is about the
    /// per-merchant bound, which only its own test provokes.
    fn ring_up(
        s: &mut CheckoutStore,
        id: &str,
        merchant: &str,
        pk: [u8; 32],
        cents: u64,
        at: u64,
    ) -> Charge {
        s.open(
            id.into(),
            REF.into(),
            merchant.into(),
            pk,
            "Shop".into(),
            None,
            cents,
            at,
        )
        .unwrap_or_else(|e| panic!("ringing up {id}: {e:?}"))
    }

    /// A store holding one charge, and that charge.
    fn charge(cents: u64, created: u64) -> Charge {
        let mut s = CheckoutStore::default();
        s.open(
            "pl_test".into(),
            REF.into(),
            MERCHANT.into(),
            [7u8; 32],
            "Test Shop".into(),
            None,
            cents,
            created,
        )
        .expect("an empty store rings one up")
    }

    /// One incoming ledger row carrying the charge's own reference — i.e. a payment somebody was
    /// actually instructed to make. `block` is its identity (the thing that decides whether it has
    /// already paid for something) and `memo` is its claim on a charge, so every fixture states
    /// both rather than sharing a default.
    fn row(to: &str, amount: u64, ts: u64, block: u64) -> TxnRecord {
        row_memo(to, amount, ts, block, REF)
    }

    /// The transfer that PAYS a charge of `cents` — the settlement amount that charge quotes,
    /// asked of the production rule rather than hand-typed, because a payer reads the quote and
    /// sends exactly it. A literal here would be a fixture describing a payment nobody would make,
    /// and it would go stale the moment the fee it nets off moved. The rule's own arithmetic is
    /// pinned against literals once, in `a_charge_is_priced_one_to_one_with_the_franc_in_integers`.
    fn paying_row(to: &str, cents: u64, ts: u64, block: u64) -> TxnRecord {
        row_memo(to, charge(cents, 0).amount_raw(), ts, block, REF)
    }

    /// A transfer of exactly the right SIZE for a charge of `cents`, carrying whatever memo the
    /// caller names — the shape every "right money, wrong sale" test needs, and the reason the
    /// amount must not be a literal there either: a fixture that pays the wrong amount would be
    /// refused for the wrong reason and prove nothing about the memo.
    fn paying_row_memo(to: &str, cents: u64, ts: u64, block: u64, memo: &str) -> TxnRecord {
        row_memo(to, charge(cents, 0).amount_raw(), ts, block, memo)
    }

    /// The same row with an explicit memo — a transfer nobody's step 3 asked for.
    fn row_memo(to: &str, amount: u64, ts: u64, block: u64, memo: &str) -> TxnRecord {
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
            memo: memo.into(),
        }
    }

    /// Nothing has been credited yet.
    fn unspent() -> HashSet<u64> {
        HashSet::new()
    }

    #[test]
    fn a_charge_is_priced_one_to_one_with_the_franc_in_integers() {
        // The entire reason v1 is VCHF-only: there is no rate here, so there is nothing to be wrong
        // about. CHF 10 is ten francs of a franc-denominated token, exactly, forever — less the fee
        // the SHOP absorbs so the customer's account moves by the price and nothing else
        // (`LEDGER_FEE_RAW`).
        assert_eq!(charge(1_000, 0).amount_raw(), 1_000_000_000 - 10_000);
        assert_eq!(charge(1, 0).amount_raw(), 1_000_000 - 10_000);
        // …and never through a float: a price that visits f64 can be wrong in the last digit, which
        // is the digit a customer notices.
        assert_eq!(
            charge(u64::from(u32::MAX), 0).amount_raw(),
            4_294_967_295 * RAW_PER_CENT - LEDGER_FEE_RAW
        );
        // The largest charge the door admits still multiplies exactly — which is what the door's
        // bound is for: past it the arithmetic would saturate and the checkout would quote a lie.
        assert_eq!(
            charge(MAX_CENTS, 0).amount_raw(),
            MAX_CENTS * RAW_PER_CENT - LEDGER_FEE_RAW
        );
    }

    /// WHAT THE CUSTOMER PAYS IS THE PRICE — the property the fee subtraction exists for, stated as
    /// the customer's bank statement rather than as the arithmetic that produces it.
    ///
    /// An ICRC ledger debits the sender `amount + fee` and credits the recipient `amount`. So for
    /// every price this checkout can open, the debit must be the price exactly, and the shop must be
    /// the one out of pocket by the fee.
    #[test]
    fn the_customer_is_debited_the_price_and_the_shop_pays_the_fee() {
        for cents in [1u64, 5, 99, 100, 250, 1_000, 99_999, MAX_CENTS] {
            let c = charge(cents, 0);
            let price_raw = cents * RAW_PER_CENT;
            assert_eq!(
                c.amount_raw() + LEDGER_FEE_RAW,
                price_raw,
                "CHF {cents} cents: the customer's ledger debit must be the price"
            );
            assert_eq!(
                price_raw - c.amount_raw(),
                LEDGER_FEE_RAW,
                "CHF {cents} cents: the shop is the one short by the fee"
            );
            // A rappen is a hundred times the fee, so nothing the door admits can price at or below
            // it — the subtraction never saturates into a free or unpayable charge.
            assert!(c.amount_raw() > 0, "CHF {cents} cents priced at nothing");
        }
    }

    #[test]
    fn the_amount_is_spelled_the_way_the_measured_provider_spells_it() {
        // Trailing zeros trimmed, exactly as the real provider trims them. Every one of these is
        // the price less the fee the shop absorbs, which is why none of them is a round franc.
        assert_eq!(charge(100, 0).amount_text(), "0.9999");
        assert_eq!(charge(1_000, 0).amount_text(), "9.9999");
        assert_eq!(charge(1_050, 0).amount_text(), "10.4999");
        assert_eq!(charge(1_005, 0).amount_text(), "10.0499");
        assert_eq!(charge(1, 0).amount_text(), "0.0099");
        // The rest of the spelling rule, on inputs a fee-netted price can no longer reach: a whole
        // number of tokens keeps the provider's bare trailing point rather than growing a `.0` or
        // losing the point. Stated here so it stays true the day the subtracted fee is zero.
        assert_eq!(raw_decimal(1_000_000_000), "10.");
        assert_eq!(raw_decimal(100_000_000), "1.");
        assert_eq!(raw_decimal(0), "0.");
        assert_eq!(raw_decimal(1), "0.00000001");
        assert_eq!(raw_decimal(150_000_000), "1.5");
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
        assert_ne!(
            charge(1_000, 0).price_text(),
            charge(1_000, 0).amount_text()
        );
    }

    #[test]
    fn a_matching_transfer_settles_the_charge_and_names_the_block_that_paid() {
        let c = charge(100, 1_000);
        let got = match_payment(&c, &[paying_row(MERCHANT, 100, 1_050, 77)], &unspent());
        assert_eq!(
            got,
            Some(Settled {
                from: PAYER.into(),
                // What the SHOP was credited: the price less the fee it absorbs.
                amount_raw: "99990000".into(),
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
        // Off by ONE raw unit either way, from the amount this charge actually quotes.
        assert_eq!(
            match_payment(&c, &[row(MERCHANT, c.amount_raw() - 1, 1_050, 1)], &unspent()),
            None
        );
        assert_eq!(
            match_payment(&c, &[row(MERCHANT, c.amount_raw() + 1, 1_050, 2)], &unspent()),
            None
        );
        // Including the one an old checkout would have asked for: a payer who sent the PRICE rather
        // than the quote has overpaid by the fee this shop absorbs, and that is not this sale.
        assert_eq!(
            match_payment(&c, &[row(MERCHANT, 100 * RAW_PER_CENT, 1_050, 3)], &unspent()),
            None
        );
        // Someone else's account: reading a history does not mean everything in it is ours.
        assert_eq!(
            match_payment(&c, &[paying_row(PAYER, 100, 1_050, 4)], &unspent()),
            None
        );
    }

    #[test]
    fn one_transfer_can_only_ever_pay_one_sale() {
        // THE MONEY BUG: two charges for the same price at the same checkout and ONE payment, both
        // reading as paid, and the shop hands over the goods twice.
        //
        // The reference now stops that on its own — a transfer names ONE charge
        // (`only_a_transfer_carrying_this_charges_reference_settles_it`). What is asserted here is
        // the clause that stops it WITHOUT the reference, which is why both charges below are opened
        // up with the same one: a state `open_charge` cannot produce, and deliberately so. The two
        // rules rest on different things — the reference is read out of a memo the PAYER supplies,
        // consumption out of this store's own settlements — so consumption is what keeps "one
        // transfer, one sale" from depending on a stranger's field being unforgeable.
        let mut s = CheckoutStore::default();
        ring_up(&mut s, "pl_a", MERCHANT, [7u8; 32], 450, 1_000);
        ring_up(&mut s, "pl_b", MERCHANT, [7u8; 32], 450, 1_001);
        let rows = [paying_row(MERCHANT, 450, 1_010, 12)];

        let first = s.settle_from_history("pl_a", &rows).expect("a live charge");
        assert_eq!(
            first.map(|p| p.block),
            Some(12),
            "the first charge polled takes the transfer"
        );
        let second = s.settle_from_history("pl_b", &rows).expect("a live charge");
        assert_eq!(second, None, "the SAME row must not credit a second sale");
        assert!(s.get("pl_b").expect("still open").paid.is_none());

        // A second, distinct transfer pays the second charge — consumption spends rows, not sales.
        let more = [paying_row(MERCHANT, 450, 1_011, 13), rows[0].clone()];
        let third = s.settle_from_history("pl_b", &more).expect("a live charge");
        assert_eq!(
            third.map(|p| p.block),
            Some(13),
            "a different block pays the other charge"
        );
    }

    #[test]
    fn no_clock_comparison_decides_a_sale() {
        // The relay stamps a charge with ITS wall clock; the ledger stamps a row with IC consensus
        // time. They are different clocks, so any rule that compares them can refuse a correct
        // payment — money moved, sale never credited. Since a charge's reference cannot exist
        // before the checkout-open that minted it, the row's timestamp has nothing left to prove, and
        // this pins that no floor was reintroduced: a referenced payment settles however far the
        // two clocks disagree, in either direction.
        let c = charge(100, 1_000);
        for stamped in [995u64, 1_000 - 2 * QUOTE_TTL_SECS, 1, 9_999] {
            assert!(
                match_payment(&c, &[paying_row(MERCHANT, 100, stamped, 5)], &unspent()).is_some(),
                "a row stamped {stamped} carries this charge's reference and must credit it"
            );
        }
    }

    #[test]
    fn only_a_transfer_carrying_this_charges_reference_settles_it() {
        // THE CLAUSE THAT MAKES A MATCH EXACT. Two customers owe the same shop the same CHF 4.50;
        // each is handed the checkout's own reference for their charge, and each transfer credits
        // exactly the sale it was made for — with no help from consumption, which never sees a
        // second candidate.
        let mut s = CheckoutStore::default();
        let (first, second) = ("ab".repeat(16), "cd".repeat(16));
        s.open(
            "pl_a".into(),
            first.clone(),
            MERCHANT.into(),
            [7u8; 32],
            "Shop".into(),
            None,
            450,
            1_000,
        )
        .expect("a fresh store rings one up");
        s.open(
            "pl_b".into(),
            second.clone(),
            MERCHANT.into(),
            [7u8; 32],
            "Shop".into(),
            None,
            450,
            1_001,
        )
        .expect("many charges per merchant is the store's shape");
        let rows = [
            paying_row_memo(MERCHANT, 450, 1_010, 12, &second),
            paying_row_memo(MERCHANT, 450, 1_011, 13, &first),
        ];
        assert_eq!(
            s.settle_from_history("pl_a", &rows)
                .expect("a live charge")
                .map(|p| p.block),
            Some(13),
            "the charge takes the transfer that names it, not the one that arrived first"
        );
        assert_eq!(
            s.settle_from_history("pl_b", &rows)
                .expect("a live charge")
                .map(|p| p.block),
            Some(12),
        );

        // A transfer of the right size to the right merchant carrying somebody else's reference —
        // or none at all, which is what a wallet that ignored the instruction would send — is not
        // this sale and is not credited.
        let c = charge(100, 1_000);
        assert_eq!(
            match_payment(
                &c,
                &[paying_row_memo(MERCHANT, 100, 1_050, 8, &first)],
                &unspent()
            ),
            None
        );
        assert_eq!(
            match_payment(
                &c,
                &[paying_row_memo(MERCHANT, 100, 1_050, 9, "")],
                &unspent()
            ),
            None
        );
        // Casing is not identity: a ledger that renders the memo's hex in capitals still pays.
        assert!(match_payment(
            &c,
            &[paying_row_memo(
                MERCHANT,
                100,
                1_050,
                10,
                &REF.to_uppercase()
            )],
            &unspent()
        )
        .is_some());
    }

    #[test]
    fn settlement_is_recorded_once_and_never_rewritten() {
        // The idempotence that lets a payer re-report safely: a second observation must not be able
        // to change who paid. Re-reporting is a RETRY here, not a second chance to lose the money.
        let mut s = CheckoutStore::default();
        ring_up(&mut s, "pl_a", MERCHANT, [7u8; 32], 100, 0);
        let first = s
            .settle_from_history("pl_a", &[paying_row(MERCHANT, 100, 10, 1)])
            .unwrap();
        assert!(first.is_some());
        // A later history that no longer carries that row (a walk that scrolled past it), plus a
        // different transfer of the same size: neither may rewrite the settlement.
        let again = s
            .settle_from_history("pl_a", &[paying_row(OTHER_MERCHANT, 100, 99, 2)])
            .unwrap();
        assert_eq!(
            again, first,
            "the first observation is the settlement, forever"
        );
        assert_eq!(s.get("pl_a").unwrap().paid, first);
    }

    #[test]
    fn a_charge_this_store_does_not_hold_is_reported_rather_than_swallowed() {
        // Every one of these used to be (or could quietly become) a silent no-op. A caller acting
        // on an id that is gone must be told, not answered with a shrug.
        let mut s = CheckoutStore::default();
        assert_eq!(
            s.settle_from_history("pl_gone", &[]),
            Err(CheckoutError::UnknownCharge)
        );
        assert_eq!(
            s.quote("pl_gone", "plq_1".into(), 0),
            Err(CheckoutError::UnknownCharge)
        );
        assert_eq!(
            s.quote_expiry("pl_gone", "plq_1", 0),
            Err(CheckoutError::UnknownCharge)
        );
        assert!(matches!(
            s.observe("pl_gone", 0),
            Err(CheckoutError::UnknownCharge)
        ));
    }

    #[test]
    fn only_a_quote_this_checkout_issued_and_has_not_expired_is_accepted() {
        let mut s = CheckoutStore::default();
        ring_up(&mut s, "pl_a", MERCHANT, [7u8; 32], 100, 0);
        s.quote("pl_a", "plq_1".into(), 0).unwrap();

        // The expiry comes BACK, because step 3 states the quote's own deadline rather than
        // inventing a second one.
        assert_eq!(s.quote_expiry("pl_a", "plq_1", 0), Ok(QUOTE_TTL_SECS));
        assert_eq!(
            s.quote_expiry("pl_a", "plq_1", QUOTE_TTL_SECS - 1),
            Ok(QUOTE_TTL_SECS)
        );
        // Past its life, and one we never issued: both dead, neither payable.
        assert_eq!(
            s.quote_expiry("pl_a", "plq_1", QUOTE_TTL_SECS),
            Err(CheckoutError::DeadQuote)
        );
        assert_eq!(
            s.quote_expiry("pl_a", "plq_invented", 0),
            Err(CheckoutError::DeadQuote)
        );
    }

    #[test]
    fn several_reads_may_each_hold_a_live_quote_without_growing_forever() {
        // The measured provider mints a NEW quote on every read and leaves the old ones valid, so a
        // wallet that reads twice must not find its first quote dead. Bounded, though: a looping
        // wallet must not be able to grow this map without limit.
        let mut s = CheckoutStore::default();
        ring_up(&mut s, "pl_a", MERCHANT, [7u8; 32], 100, 0);
        for i in 0..MAX_LIVE_QUOTES {
            s.quote("pl_a", format!("plq_{i}"), 0).unwrap();
        }
        assert!(s.quote_expiry("pl_a", "plq_0", 0).is_ok());
        s.quote("pl_a", "plq_overflow".into(), 0).unwrap();
        assert_eq!(s.get("pl_a").unwrap().quotes.len(), MAX_LIVE_QUOTES);
        assert_eq!(
            s.quote_expiry("pl_a", "plq_0", 0),
            Err(CheckoutError::DeadQuote)
        );
        assert!(s.quote_expiry("pl_a", "plq_overflow", 0).is_ok());
    }

    #[test]
    fn a_opened_charge_stops_being_payable_when_it_goes_stale() {
        let mut s = CheckoutStore::default();
        ring_up(&mut s, "pl_a", MERCHANT, [7u8; 32], 100, 0);
        assert!(s.quote("pl_a", "plq_1".into(), CHARGE_TTL_SECS - 1).is_ok());
        assert_eq!(
            s.quote("pl_a", "plq_2".into(), CHARGE_TTL_SECS),
            Err(CheckoutError::NoPendingCharge)
        );
        assert_eq!(
            s.get("pl_a").unwrap().state(CHARGE_TTL_SECS),
            ChargeState::Expired
        );
    }

    #[test]
    fn a_quote_never_outlives_the_charge_it_prices() {
        // ONE lifetime, not two. A quote minted with five minutes of runway on a charge with ten
        // seconds left is good for ten seconds — and says so, rather than promising a deadline
        // this checkout would refuse to honour.
        let mut s = CheckoutStore::default();
        ring_up(&mut s, "pl_a", MERCHANT, [7u8; 32], 100, 0);
        let late = CHARGE_TTL_SECS - 10;
        let (_, expires) = s.quote("pl_a", "plq_late".into(), late).unwrap();
        assert_eq!(
            expires, CHARGE_TTL_SECS,
            "clamped to the charge's own death"
        );
        assert!(expires < late + QUOTE_TTL_SECS);
        // …and it really is dead then, so nothing outlives the sweep that clears the charge.
        assert_eq!(
            s.quote_expiry("pl_a", "plq_late", CHARGE_TTL_SECS),
            Err(CheckoutError::DeadQuote)
        );
    }

    #[test]
    fn ringing_up_a_new_charge_voids_the_merchants_previous_one() {
        // ONE LIVE CHARGE PER MERCHANT, as a policy over a store that holds many: the old charge
        // is still here, still readable, just no longer payable.
        let mut s = CheckoutStore::default();
        ring_up(&mut s, "pl_first", MERCHANT, [7u8; 32], 450, 100);
        ring_up(&mut s, "pl_second", MERCHANT, [7u8; 32], 900, 200);

        assert_eq!(
            s.get("pl_first").unwrap().state(200),
            ChargeState::Superseded
        );
        assert_eq!(
            s.get("pl_first").unwrap().voided,
            Some(VoidCause::Superseded)
        );
        assert_eq!(
            s.quote("pl_first", "plq_1".into(), 200),
            Err(CheckoutError::Superseded)
        );
        assert_eq!(s.get("pl_second").unwrap().state(200), ChargeState::Open);
        assert!(s.quote("pl_second", "plq_2".into(), 200).is_ok());

        // ANOTHER merchant's charge is untouched — the policy is per merchant, and the store is
        // not a one-charge box.
        ring_up(&mut s, "pl_other", OTHER_MERCHANT, [8u8; 32], 450, 300);
        assert_eq!(s.get("pl_second").unwrap().state(300), ChargeState::Open);
        assert_eq!(s.get("pl_other").unwrap().state(300), ChargeState::Open);
    }

    #[test]
    fn a_voided_charge_still_credits_money_that_already_moved() {
        // The payer was holding the old code and sent the money a heartbeat before the cashier
        // re-opened. Voiding must close the door to NEW payers, never blind the checkout to a transfer
        // that already happened — that would lose a real payment.
        let mut s = CheckoutStore::default();
        ring_up(&mut s, "pl_first", MERCHANT, [7u8; 32], 450, 100);
        ring_up(&mut s, "pl_second", MERCHANT, [7u8; 32], 450, 200);
        let rows = [paying_row(MERCHANT, 450, 150, 21)];

        let paid = s.settle_from_history("pl_first", &rows).unwrap();
        assert_eq!(
            paid.map(|p| p.block),
            Some(21),
            "a voided charge still sees its own payment"
        );
        assert_eq!(s.get("pl_first").unwrap().state(300), ChargeState::Paid);
        // …and that transfer is spent: the new charge is NOT paid by the old one's money.
        assert_eq!(s.settle_from_history("pl_second", &rows).unwrap(), None);
    }

    #[test]
    fn a_credited_charge_is_not_quoted_again() {
        // Quoting a settled charge invites a SECOND payment for the same sale, which nothing would
        // ever credit — the payer's money would simply sit on the ledger unclaimed.
        let mut s = CheckoutStore::default();
        ring_up(&mut s, "pl_a", MERCHANT, [7u8; 32], 100, 0);
        s.settle_from_history("pl_a", &[paying_row(MERCHANT, 100, 10, 31)])
            .unwrap();
        assert_eq!(
            s.quote("pl_a", "plq_1".into(), 20),
            Err(CheckoutError::AlreadyPaid)
        );
        // Being paid also outranks having been superseded or having gone stale.
        assert_eq!(
            s.get("pl_a").unwrap().state(CHARGE_TTL_SECS + 1),
            ChargeState::Paid
        );
    }

    #[test]
    fn a_second_poll_within_the_window_reuses_the_first_walk() {
        // The amplification bound: one cheap HTTP request must not buy an unlimited number of
        // mainnet ledger walks. Whoever asks first claims the walk; everyone else inside the
        // window is answered from what it found.
        let mut s = CheckoutStore::default();
        ring_up(&mut s, "pl_a", MERCHANT, [7u8; 32], 100, 1_000);
        assert!(matches!(s.observe("pl_a", 1_000), Ok(Observation::Walk(_))));
        assert!(matches!(
            s.observe("pl_a", 1_000),
            Ok(Observation::Recent(_))
        ));
        assert!(matches!(
            s.observe("pl_a", 1_000 + OBSERVE_TTL_SECS - 1),
            Ok(Observation::Recent(_))
        ));
        // The window ENDS — a cache that never expired would be a checkout that never sees the money.
        assert!(matches!(
            s.observe("pl_a", 1_000 + OBSERVE_TTL_SECS),
            Ok(Observation::Walk(_))
        ));

        // A settled charge is never re-walked at all: settlement is not re-decided.
        s.settle_from_history("pl_a", &[paying_row(MERCHANT, 100, 1_010, 41)])
            .unwrap();
        assert!(matches!(
            s.observe("pl_a", 9_999),
            Ok(Observation::Recent(_))
        ));
    }

    #[test]
    fn a_merchant_name_is_bounded_however_long_it_arrives() {
        // A name is a stranger's text held for an hour. Unbounded, it is a way to spend this
        // relay's memory a megabyte per checkout-open.
        let mut s = CheckoutStore::default();
        let named = |s: &mut CheckoutStore, id: &str, name: String| {
            s.open(
                id.into(),
                REF.into(),
                MERCHANT.into(),
                [7u8; 32],
                name,
                None,
                100,
                0,
            )
            .expect("a fresh store rings one up")
        };
        let c = named(&mut s, "pl_a", "A".repeat(1_000_000));
        assert_eq!(c.merchant_name.len(), MERCHANT_NAME_BYTES);
        // Cut on a CHARACTER boundary, never mid-codepoint: a name is text or it is nothing.
        let wide = "é".repeat(100); // 2 bytes each — 16 fit, the 17th would be one byte over
        let c = named(&mut s, "pl_b", wide);
        assert_eq!(c.merchant_name.chars().count(), MERCHANT_NAME_BYTES / 2);
        assert!(c.merchant_name.len() <= MERCHANT_NAME_BYTES);
        // A name that fits is untouched — clamping is a bound, not a filter.
        let c = named(&mut s, "pl_c", "Bahnhof Kiosk".into());
        assert_eq!(c.merchant_name, "Bahnhof Kiosk");
    }

    #[test]
    fn a_credited_sale_outlives_the_charge_but_not_the_day() {
        // A stale unpaid charge is litter; a credited one is the merchant's record of a sale AND
        // the mark that keeps its ledger row from paying anything else. Neither is kept forever.
        let mut s = CheckoutStore::default();
        ring_up(&mut s, "pl_paid", MERCHANT, [7u8; 32], 100, 0);
        ring_up(&mut s, "pl_stale", OTHER_MERCHANT, [8u8; 32], 100, 0);
        s.settle_from_history("pl_paid", &[paying_row(MERCHANT, 100, 5, 51)])
            .unwrap();

        s.sweep(CHARGE_TTL_SECS + 1);
        assert!(
            s.get("pl_paid").is_some(),
            "a credited sale survives the payable hour"
        );
        assert!(
            s.get("pl_stale").is_none(),
            "an unpaid stale charge is litter"
        );

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
        assert_eq!(
            ids.len(),
            256,
            "a repeated id would mean the generator is not random"
        );
        for id in &ids {
            let tail = id
                .strip_prefix("pl_")
                .expect("the standard's shape: pl_<hex>");
            assert_eq!(tail.len(), 16);
            assert!(
                tail.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')),
                "{id}"
            );
        }
    }

    /// The tripwire under [`ChargeStatus`]'s threat model. `GET /api/v1/checkout/{id}` is a bearer read
    /// token, and the argument that this is acceptable is field-by-field: every key below is either
    /// already served to the same caller by the standard's own payer routes, or derivable from the
    /// public ICRC-1 ledger the QR itself names. That argument is only true of THIS key set, so the
    /// key set is pinned — a new field fails here and has to be argued into the doc above rather
    /// than merged as a diff nobody re-read.
    #[test]
    fn the_unauthenticated_status_body_is_exactly_these_fields() {
        let mut s = CheckoutStore::default();
        let charge = ring_up(
            &mut s,
            "pl_0123456789abcdef",
            MERCHANT,
            [7u8; 32],
            450,
            1_000,
        );
        let json = serde_json::to_value(ChargeStatus::of(&charge, 1_000))
            .expect("a status body serialises");
        let mut keys: Vec<&str> = json
            .as_object()
            .expect("the status body is a JSON object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "amount",
                "cents",
                "created_secs",
                "expires_at",
                "id",
                "merchant_name",
                "paid",
                "state",
            ],
            "a field was added to (or removed from) the unauthenticated charge status — \
             re-derive ChargeStatus's threat model before changing this list"
        );
        // The two the argument names explicitly, so their absence is asserted rather than implied:
        // the reference (the merchant holds it from the checkout-open they signed) and the destination
        // principal (retired 2026-09-08 — its only reader was printing it as the shop's name).
        assert!(
            json.get("reference").is_none(),
            "the reference stays off the bearer body"
        );
        assert!(
            json.get("merchant").is_none(),
            "the destination principal has no reader here"
        );
        // …and what IS there is the claimed name, which step 2 already serves as `displayName`.
        assert_eq!(json["merchant_name"], serde_json::json!("Shop"));
    }

    #[test]
    fn the_lnurl_encoder_reproduces_a_code_a_real_checkout_printed() {
        // AN OUTSIDE-AUTHORED VECTOR, which is the only kind worth pinning an encoder against: this
        // string was decoded from a photograph of a live DFX checkout's QR (`artifacts/spar-test-checkout-qr.png`),
        // so nothing in this repo wrote it and agreeing with it is a real check rather than a
        // tautology. Its 94 characters are also arithmetic: 6 (hrp + separator) + ceil(51 * 8 / 5)
        // (the URL's data symbols) + 6 (checksum).
        let encoded = lnurl_of("https://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e");
        assert_eq!(
            encoded,
            "LNURL1DP68GURN8GHJ7CTSDYHXGENC9EEHW6TNWVHHVVF0D3H82UNVWQHHQMZLVFJK2ERYVG6RZCMYX33RVEPEV5YEJ9WT"
        );
        assert_eq!(encoded.len(), 94);

        // UPPERCASE and single-case, which is what makes it valid: bech32's checksum is defined
        // over one case, so a mixed-case string has no well-defined answer at all — and the wallet
        // that reads this refuses one (`decodeLnurl`, app/lib/opencryptopay.ts).
        assert_eq!(encoded, encoded.to_uppercase());
        // A one-character difference in the URL must change the code, or the checksum is not being
        // computed over the payload at all.
        assert_ne!(
            encoded,
            lnurl_of("https://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9f")
        );
        // The padding branch: URL lengths mod 5 exercise both "the last group is whole" and "the
        // last group is zero-padded", and every one of them must still carry a six-symbol checksum
        // after the `lnurl1` prefix.
        for n in 1..=10usize {
            let code = lnurl_of(&"a".repeat(n));
            assert_eq!(
                code.len(),
                LNURL_HRP.len() + 1 + n.saturating_mul(8).div_ceil(5) + BECH32_CHECKSUM_LEN
            );
        }
    }

    #[test]
    fn a_charge_states_the_one_deadline_every_reader_uses() {
        // The wire carries `expires_at` so a cashier's screen can count down without a copy of
        // CHARGE_TTL_SECS. It has to be the SAME instant the store enforces, or the screen and the
        // checkout disagree about whether a customer can still pay.
        let c = charge(100, 1_000);
        assert_eq!(c.expires_at(), 1_000 + CHARGE_TTL_SECS);
        assert_eq!(c.state(c.expires_at() - 1), ChargeState::Open);
        assert_eq!(
            c.state(c.expires_at()),
            ChargeState::Expired,
            "the stated second is the last one"
        );
        // And a quote is clamped to exactly that instant rather than to a second derivation of it.
        let mut s = CheckoutStore::default();
        let opened = ring_up(&mut s, "pl_a", MERCHANT, [7u8; 32], 100, 1_000);
        let (_, quote_expires) = s
            .quote("pl_a", "plq_1".into(), 1_000 + CHARGE_TTL_SECS - 5)
            .unwrap();
        assert_eq!(quote_expires, opened.expires_at());
    }

    #[test]
    fn a_merchant_may_not_hold_more_charges_than_the_store_bounds() {
        // Ringing up is authenticated but not rationed, so without this one signer grows this
        // relay's memory without limit. The bound is per merchant and counted from the store
        // itself, so another merchant's checkout is unaffected by a neighbour at its limit.
        let mut s = CheckoutStore::default();
        for i in 0..MAX_CHARGES_PER_MERCHANT {
            ring_up(&mut s, &format!("pl_{i}"), MERCHANT, [7u8; 32], 100, 0);
        }
        assert_eq!(
            s.open(
                "pl_over".into(),
                REF.into(),
                MERCHANT.into(),
                [7u8; 32],
                "Shop".into(),
                None,
                100,
                0
            )
            .err(),
            Some(CheckoutError::CheckoutFull)
        );
        // REFUSED BEFORE THE VOID: the charge the merchant already had is still the payable one, so
        // a bounded refusal never costs them the sale in front of them.
        let live = s
            .current
            .get(MERCHANT)
            .cloned()
            .expect("the merchant still has a current charge");
        assert_eq!(s.get(&live).expect("held").state(0), ChargeState::Open);
        assert!(
            s.get("pl_over").is_none(),
            "a refused checkout-open stores nothing"
        );

        // Per MERCHANT, not per store.
        assert!(s
            .open(
                "pl_other".into(),
                REF.into(),
                OTHER_MERCHANT.into(),
                [8u8; 32],
                "Kiosk".into(),
                None,
                100,
                0
            )
            .is_ok());
        // And it frees itself with time: the sweep drops the stale charges, and the next checkout-open
        // is accepted — which is exactly what the refusal tells the merchant to wait for.
        s.sweep(CHARGE_TTL_SECS);
        assert!(s
            .open(
                "pl_after".into(),
                REF.into(),
                MERCHANT.into(),
                [7u8; 32],
                "Shop".into(),
                None,
                100,
                CHARGE_TTL_SECS
            )
            .is_ok());
    }

    #[test]
    fn only_the_one_pair_v1_serves_is_accepted() {
        assert_eq!(supported("InternetComputer", "VCHF"), Ok(()));
        assert_eq!(supported("InternetComputer", "vchf"), Ok(())); // casing is not identity
                                                                   // Everything else is refused rather than quoted: quoting it would mean holding a rate.
        assert_eq!(
            supported("InternetComputer", "ICP"),
            Err(CheckoutError::UnsupportedAsset)
        );
        assert_eq!(
            supported("InternetComputer", "ckBTC"),
            Err(CheckoutError::UnsupportedAsset)
        );
        assert_eq!(
            supported("Solana", "VCHF"),
            Err(CheckoutError::UnsupportedAsset)
        );
    }

    /// A merchant key and a checkout-open genuinely signed by it. The key IS the claim, so a fixture that
    /// let the two drift would be testing nothing.
    fn signed(seed: u8, cents: u64, nonce: u8, issued_at: u64) -> (CheckoutOpen, [u8; SIG_LEN]) {
        let sk = SigningKey::from_bytes(&[seed; PUBKEY_LEN]);
        let open = CheckoutOpen {
            merchant_pubkey: sk.verifying_key().to_bytes(),
            cents,
            nonce: [nonce; NONCE_LEN],
            issued_at,
            merchant_name: "Bahnhof Kiosk".to_string(),
            note: None,
        };
        let sig = sign_checkout_open(&sk, &open).to_bytes();
        (open, sig)
    }

    #[test]
    fn a_forged_ring_up_is_refused_and_leaves_nothing_behind() {
        // THE HOLE THIS CLOSES. `POST /api/v1/checkout` took any 32 bytes of hex as the account every
        // payer would then be sent to; a probe opened a live production charge with
        // `deadbeef…deadbeef` on 2026-09-03. The acceptance rule itself is the core's
        // (`validate_checkout_open`, tested there); what is asserted here is the STORE's half of it —
        // that a refusal writes nothing, which is what keeps the nonce set finite when the callers
        // are strangers.
        let mut s = CheckoutStore::default();
        let now = 1_000_000;
        let (open, sig) = signed(5, 450, 0xa1, now);

        // A key nobody holds: not a curve point, so it is told apart from a wrong signature — a
        // merchant who pasted a placeholder must hear about the KEY, not about their signing.
        let deadbeef = CheckoutOpen {
            merchant_pubkey: <[u8; PUBKEY_LEN]>::try_from(
                hex::decode("deadbeef".repeat(8))
                    .expect("a hex fixture")
                    .as_slice(),
            )
            .expect("32 bytes"),
            ..open.clone()
        };
        assert_eq!(
            s.authorize(&deadbeef, &sig, now),
            Err(CheckoutOpenError::MalformedKey)
        );
        // A real key, someone else's signature.
        let (_, other_sig) = signed(6, 450, 0xa1, now);
        assert_eq!(
            s.authorize(&open, &other_sig, now),
            Err(CheckoutOpenError::BadSignature)
        );
        // The right signature, an hour late — a captured request replayed long after the fact.
        assert_eq!(
            s.authorize(&open, &sig, now + CHECKOUT_OPEN_MAX_SKEW_SECS + 1),
            Err(CheckoutOpenError::Stale)
        );

        // NOT ONE of those three wrote a nonce, which is the property that matters: a stranger
        // firing forgeries all day cannot grow this store by a byte, and the honest holder of that
        // very nonce is still able to use it.
        assert_eq!(s.authorize(&open, &sig, now), Ok(()));
        // …and exactly once. The same request again is the replay a nonce exists to refuse.
        assert_eq!(
            s.authorize(&open, &sig, now),
            Err(CheckoutOpenError::NonceReused)
        );
        // A fresh nonce from the same merchant is a new request, not a blocked one.
        let (again, again_sig) = signed(5, 450, 0xa2, now);
        assert_eq!(s.authorize(&again, &again_sig, now), Ok(()));
    }

    #[test]
    fn a_nonce_is_remembered_for_exactly_as_long_as_it_could_be_replayed() {
        // The nonce set is bounded by the CLOCK, not by a cap — an evicted nonce is a replayable
        // one, so "when may this be forgotten" has to be an argument rather than a tuning knob. A
        // request accepted at `t` may have been issued as late as `t + skew`, and one issued then
        // is still inside the window at `t + 2 * skew` EXACTLY. That last second is the whole test.
        let mut s = CheckoutStore::default();
        let t = 1_000_000;
        let (open, sig) = signed(7, 100, 0xb1, t + CHECKOUT_OPEN_MAX_SKEW_SECS);
        assert_eq!(
            s.authorize(&open, &sig, t),
            Ok(()),
            "a device a skew-window fast is accepted"
        );

        let last = t + 2 * CHECKOUT_OPEN_MAX_SKEW_SECS;
        s.sweep(last);
        assert_eq!(
            s.authorize(&open, &sig, last),
            Err(CheckoutOpenError::NonceReused),
            "the last second this replay could have passed the clock is the second the nonce must \
             still be held"
        );
        // One second later the clock refuses it on its own, so the memory is released.
        s.sweep(last + 1);
        assert!(
            s.seen_nonces.is_empty(),
            "nothing is kept past the window that justifies it"
        );
        assert_eq!(
            s.authorize(&open, &sig, last + 1),
            Err(CheckoutOpenError::Stale)
        );
    }

    #[test]
    fn a_mis_keyed_total_can_be_cancelled_and_a_credited_one_cannot() {
        // CHF 100.00 keyed for a CHF 1.00 coffee. Before this the cashier could not kill the code:
        // it stayed payable for an hour, and the only way out was to open something else and
        // leave THAT payable instead.
        let mut s = CheckoutStore::default();
        ring_up(&mut s, "pl_oops", MERCHANT, [7u8; 32], 10_000, 100);
        let cancelled = s
            .void(MERCHANT, VoidCause::Cancelled)
            .expect("a live charge is cancellable");
        assert_eq!(cancelled.state(100), ChargeState::Cancelled);
        // TOLD APART from a superseded code, because the payer's next move is the opposite one:
        // "scan the new code" versus "nothing is owed".
        assert_eq!(
            s.quote("pl_oops", "plq_1".into(), 100),
            Err(CheckoutError::Cancelled)
        );

        // Idempotent — a cashier pressing the button twice has not failed at anything — and the
        // FIRST cause survives a later checkout-open, so a cancelled charge is never described as merely
        // replaced.
        assert!(s.void(MERCHANT, VoidCause::Cancelled).is_ok());
        ring_up(&mut s, "pl_next", MERCHANT, [7u8; 32], 100, 200);
        assert_eq!(
            s.get("pl_oops").expect("still readable").state(200),
            ChargeState::Cancelled
        );

        // A CREDITED charge is not cancellable, and the refusal carries the block that paid — a
        // merchant told "cancelled" here would hand over goods they have already been paid for.
        s.settle_from_history("pl_next", &[paying_row(MERCHANT, 100, 210, 61)])
            .unwrap();
        assert!(matches!(
            s.void(MERCHANT, VoidCause::Cancelled),
            Err(VoidRefusal::AlreadyPaid(p)) if p.block == 61
        ));
        assert_eq!(
            s.get("pl_next").unwrap().state(220),
            ChargeState::Paid,
            "still paid, not voided"
        );

        // A checkout nobody has opened anything on has nothing to clear, and says so rather than
        // reporting a success that describes no charge.
        assert_eq!(
            s.void(OTHER_MERCHANT, VoidCause::Cancelled).unwrap_err(),
            VoidRefusal::NothingOpened
        );
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
        assert_eq!(
            row.decimals,
            Some(u8::try_from(VCHF_DECIMALS).expect("decimals fit a u8"))
        );
        assert_eq!(10u64.pow(VCHF_DECIMALS) / 100, RAW_PER_CENT);
        // The fee the SHOP now absorbs. A catalog row whose fee moved would have this checkout quote a
        // price-minus-the-wrong-fee, which lands as either a customer overcharged by the difference
        // or a transfer the ledger refuses for underfunding — silently, on every sale.
        assert_eq!(
            row.fee.map(|f| f.0),
            Some(LEDGER_FEE_RAW),
            "the checkout subtracts the VCHF ledger fee from every price; it must be the fee the \
             catalog serves"
        );
    }
}

// --- HTTP: the provider surface, and the merchant's own two routes ------------------------------
// Split from the pure half above deliberately: everything up to here does no I/O, holds no state
// handle and pulls in no framework, so the money rules are tested as plain functions. Below is the
// wiring that exposes them, in the shape the STANDARD dictates rather than one of our choosing —
// `/v1/lnurlp/{id}`, `/v1/lnurlp/cb/{id}`, `/v1/lnurlp/tx/{id}` — because a third-party wallet
// derives the submission URL from the callback by swapping `/cb/` for `/tx/` (dpay's own payer
// does exactly that), so the segments are load-bearing, not cosmetic.

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
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
    (
        status,
        Json(json!({"statusCode": status.as_u16(), "message": message, "error": error})),
    )
        .into_response()
}

impl CheckoutError {
    /// Map to the wire, matching the measured provider's own wording where an equivalent exists so
    /// a wallet's error handling behaves the same against either implementation.
    fn to_response(&self) -> Response {
        match self {
            // The two DIFFERENT 404s. A wallet must tell them apart: one means "ask the cashier to
            // "a fresh charge", the other means "this code is not ours". The measured provider signals
            // the first by answering with the payment-link payload instead of an error envelope —
            // reproduced by the details handler, so this arm is only ever the honest error case.
            CheckoutError::UnknownCharge => provider_error(StatusCode::NOT_FOUND, "Payment link not found"),
            CheckoutError::NoPendingCharge => provider_error(StatusCode::NOT_FOUND, "Payment link not found"),
            // Both of these have no counterpart on the measured provider, so they say what
            // happened and what to do about it — a payer holding a dead code must be told which
            // kind of dead it is, or they stand at the counter re-scanning it.
            CheckoutError::Superseded => provider_error(
                StatusCode::NOT_FOUND,
                "This code was replaced by a newer charge — ask the cashier for the current one",
            ),
            // The opposite instruction from the one above, which is the entire reason the two are
            // separate: a payer holding a cancelled code must NOT go and pay it.
            CheckoutError::Cancelled => provider_error(
                StatusCode::NOT_FOUND,
                "This charge was cancelled at the checkout — nothing is owed, so do not send anything. \
                 Ask the cashier to open a fresh charge if you still want to pay",
            ),
            CheckoutError::AlreadyPaid => provider_error(
                StatusCode::CONFLICT,
                "This charge has already been paid — do not send again; ask the cashier to open \
                 a new one if you are paying for something else",
            ),
            CheckoutError::DeadQuote => provider_error(StatusCode::NOT_FOUND, "No actual quote with ID found"),
            CheckoutError::UnsupportedAsset => provider_error(StatusCode::BAD_REQUEST, "Invalid method or asset"),
            // A merchant's refusal, not a payer's, and the one that has to say what will make it go
            // away by itself: nothing the cashier can press frees a slot (cancelling a charge stops
            // it being payable, it does not forget it), so the honest instruction is the timescale.
            CheckoutError::CheckoutFull => provider_error(
                StatusCode::TOO_MANY_REQUESTS,
                &format!(
                    "this checkout is already holding its limit of {MAX_CHARGES_PER_MERCHANT} charges. \
                     They clear themselves: an unpaid charge is dropped {} h after it was opened \
                     and a paid one {} h after. Open a fresh charge again once the oldest has aged out — \
                     cancelling does not free one, and a retry needs a fresh nonce",
                    CHARGE_TTL_SECS / 3_600,
                    SETTLED_TTL_SECS / 3_600,
                ),
            ),
        }
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

// --- LNURL (LUD-01): the code a wallet can actually scan -----------------------------------------
// A bare `https://<host>/v1/lnurlp/<id>` is scannable by dpay and by nothing else: LUD-01 defines
// the bech32 `lnurl1…` form, and plain-https LNURL-pay is standardised only through LUD-16/LUD-17.
// So the checkout-open answer carries the bech32 too, and the `?lightning=` wrapper the measured checkout QR
// actually prints.
//
// THE ENCODER LIVES HERE, in the relay, and not in `dpay-core`. Opening a charge already requires
// this relay, so there is no path on which the app holds a charge id but not this relay's answer —
// the relay computes the string once and every surface that renders it (the merchant's screen
// today, a relay-served page tomorrow) renders the same one. That is ONE production
// implementation, which is the whole test: a second one in the core would be a second thing to
// keep in step for a value only this route can produce.
//
// HAND-ROLLED, for the reason [`iso8601_utc`] below is: encode-only bech32 for one fixed hrp is the
// polymod, the charset and a 5-bit regroup. `bech32-0.11.0` is in the local cargo cache and was
// considered — it brings a decoder, an hrp type, a checksum-variant type and its own error enum for
// a function that has none of those problems, and the crate would also have to be vendored and
// locked. The wallet already carries the matching DECODER hand-rolled at the same size
// (`decodeLnurl`, `app/lib/opencryptopay.ts`), so a crate on this side would make the two halves of
// one format two different kinds of thing.

const BECH32_CHARSET: &[u8; 32] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_GENERATORS: [u32; 5] = [
    0x3b6a_57b2,
    0x2650_8e6d,
    0x1ea1_19fa,
    0x3d42_33dd,
    0x2a14_62b3,
];
const LNURL_HRP: &str = "lnurl";
/// The bech32 checksum is six 5-bit symbols.
const BECH32_CHECKSUM_LEN: usize = 6;

/// BIP-173 polymod over the hrp-expanded values followed by the data. Stays inside 30 bits.
fn bech32_polymod(values: &[u8]) -> u32 {
    let mut chk: u32 = 1;
    for v in values {
        let top = chk >> 25;
        chk = ((chk & 0x01ff_ffff) << 5) ^ u32::from(*v);
        for (i, generator) in BECH32_GENERATORS.iter().enumerate() {
            if (top >> i) & 1 == 1 {
                chk ^= generator;
            }
        }
    }
    chk
}

/// `url` as a LUD-01 `LNURL1…` string with a valid bech32 checksum.
///
/// UPPERCASE, which is what the measured checkout QR carries and what lets a QR encoder choose
/// alphanumeric mode — a denser code for the same string. bech32 is case-insensitive, so this is a
/// spelling and not a different code; MIXED case would be the invalid one, because the checksum is
/// defined over a single case.
///
/// Public because it IS a stated property of this provider (the wire golden pins the string), and
/// because the test that proves it is the one that matters: an outside-authored code, decoded from
/// a real DFX checkout QR, must come back out of this function byte for byte.
pub fn lnurl_of(url: &str) -> String {
    // 8-bit → 5-bit, zero-padding the final partial group (BIP-173). `acc` is masked so a long URL
    // cannot shift bits off the top.
    let mut words: Vec<u8> = Vec::with_capacity(url.len() * 8 / 5 + 1);
    let (mut acc, mut bits) = (0u32, 0u32);
    for byte in url.bytes() {
        acc = ((acc << 8) | u32::from(byte)) & 0xffff;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            words.push(((acc >> bits) & 31) as u8);
        }
    }
    if bits > 0 {
        words.push(((acc << (5 - bits)) & 31) as u8);
    }
    // hrp expansion: high bits, separator, low bits — then the data and six zero placeholders the
    // checksum is solved for.
    let mut values: Vec<u8> = LNURL_HRP.bytes().map(|c| c >> 5).collect();
    values.push(0);
    values.extend(LNURL_HRP.bytes().map(|c| c & 31));
    values.extend_from_slice(&words);
    values.extend_from_slice(&[0u8; BECH32_CHECKSUM_LEN]);
    let checksum = bech32_polymod(&values) ^ 1;

    let mut out = String::with_capacity(LNURL_HRP.len() + 1 + words.len() + BECH32_CHECKSUM_LEN);
    out.push_str(LNURL_HRP);
    out.push('1');
    let symbol = |w: u8| char::from(BECH32_CHARSET[usize::from(w)]);
    out.extend(words.iter().map(|w| symbol(*w)));
    for i in 0..BECH32_CHECKSUM_LEN {
        out.push(symbol(
            ((checksum >> (5 * (BECH32_CHECKSUM_LEN - 1 - i))) & 31) as u8,
        ));
    }
    out.to_ascii_uppercase()
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
    format!("{prefix}{}", fresh_hex::<8>())
}

/// `N` bytes from the OS CSPRNG, lowercase hex. The ONE randomness call site in this module, so the
/// charge id, the quote id and a charge's [`Charge::reference`] cannot end up drawn from different
/// sources — and a relay whose CSPRNG is unavailable stops here rather than handing out a guessable
/// value that every caller would believe was random.
fn fresh_hex<const N: usize>() -> String {
    let mut bytes = [0u8; N];
    match getrandom::getrandom(&mut bytes) {
        Ok(()) => {}
        // No fallback, deliberately — see above.
        Err(e) => panic!(
            "dpay-relay: checkout: the OS CSPRNG is unavailable ({e}) — cannot mint {N} random bytes"
        ),
    }
    hex::encode(bytes)
}

/// The width of a charge's reconciliation reference, in bytes — the width dpay's ICRC memo already
/// has everywhere else (`ref` in `app/lib/deepLink.ts`).
const REFERENCE_BYTES: usize = 16;

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
            "dpay-relay: checkout: {PUBLIC_ORIGIN_ENV} is set but unreadable ({e}); deriving the origin \
             from the request instead"
        ),
    }
    // Absent or unreadable header values fall to what a local run honestly is, and say so — a
    // silently wrong origin would put an unreachable URL in a merchant's QR.
    let host = match headers.get("host").map(|v| v.to_str()) {
        Some(Ok(host)) => host,
        Some(Err(e)) => {
            eprintln!("dpay-relay: checkout: the Host header is not text ({e}); using localhost");
            "localhost"
        }
        None => "localhost",
    };
    let scheme = match headers.get("x-forwarded-proto").map(|v| v.to_str()) {
        Some(Ok(scheme)) => scheme,
        Some(Err(e)) => {
            eprintln!("dpay-relay: checkout: X-Forwarded-Proto is not text ({e}); using http");
            "http"
        }
        None => "http", // nothing in front of us: a direct local run really is http
    };
    format!("{scheme}://{host}")
}

/// The deploy-time answer to "what URL do wallets reach this relay at".
const PUBLIC_ORIGIN_ENV: &str = "DPAY_PUBLIC_ORIGIN";

/// A hex field of an exact byte width, or a refusal that names the field and both bounds.
///
/// Every one of these is the FIRST thing a merchant integrating against this checkout gets wrong, so
/// the message states the width in the unit the caller typed (characters) as well as the one the
/// wire means (bytes) — "must be 32-byte hex" reads, to somebody holding a 128-character string,
/// like their signature is the wrong length.
fn hex_field<const N: usize>(value: &str, field: &str) -> Result<[u8; N], Response> {
    match hex::decode(value.trim())
        .ok()
        .and_then(|b| <[u8; N]>::try_from(b).ok())
    {
        Some(bytes) => Ok(bytes),
        None => Err(provider_error(
            StatusCode::BAD_REQUEST,
            &format!("{field} must be {N} bytes as {} hex characters", N * 2),
        )),
    }
}

/// The merchant's signed request, decoded — the ONE place `OpenCharge`'s three hex fields become
/// the core's own type. Both routes go through it, so neither can verify a differently-assembled
/// payload than the other.
///
/// `merchant_name` is carried through UNTOUCHED. It is inside the signed bytes, so the value
/// verified here must be the byte-identical string the merchant signed; the display clamp
/// ([`clamp_name`], applied by `CheckoutStore::open`) runs strictly AFTER acceptance. Clamping first
/// would silently rewrite the message and refuse every honest signature over a name of 33 bytes
/// or more. `note` follows the same rule for the same reason.
fn decoded(req: &OpenCharge) -> Result<(CheckoutOpen, [u8; SIG_LEN]), Response> {
    let open = CheckoutOpen {
        merchant_pubkey: hex_field::<PUBKEY_LEN>(&req.merchant_pubkey, "merchant_pubkey")?,
        cents: req.cents,
        nonce: hex_field::<NONCE_LEN>(&req.nonce, "nonce")?,
        issued_at: req.issued_at,
        merchant_name: req.merchant_name.clone(),
        note: req.note.clone(),
    };
    Ok((open, hex_field::<SIG_LEN>(&req.signature, "signature")?))
}

/// The merchant's own body, or a refusal that says what a request must carry.
///
/// axum's own JSON rejection names the field it choked on and nothing more, which leaves a
/// merchant integrating against this checkout to guess the rest. The rejection's text is kept (it is
/// the precise diagnosis) and the shape is added to it, because "what do I send instead" is the
/// question a refusal has to answer.
fn body_of(body: Result<Json<OpenCharge>, JsonRejection>) -> Result<OpenCharge, Response> {
    match body {
        Ok(Json(req)) => Ok(req),
        Err(rejection) => Err(provider_error(
            StatusCode::BAD_REQUEST,
            &format!(
                "{}. A checkout request is {{merchant_pubkey, merchant_name, cents, nonce, issued_at, \
                 signature}}, signed with the merchant's own key — see dfx/checkout_open_signing.json",
                rejection.body_text()
            ),
        )),
    }
}

/// Why an authenticated checkout request was refused, said so the merchant can fix it.
///
/// One arm per `dpay_core::CheckoutOpenError`, because the four failures need four different actions
/// and a single "unauthorized" would send every one of them to re-check the wrong thing. `now` is
/// stated back on the clock refusal: the merchant cannot see this relay's clock, and the gap is
/// the whole diagnosis.
fn checkout_open_response(e: CheckoutOpenError, now: u64, issued_at: u64) -> Response {
    match e {
        CheckoutOpenError::Stale => provider_error(
            StatusCode::UNAUTHORIZED,
            &format!(
                "issued_at is {} s from this checkout's clock, which allows ±{} s (checkout clock {now}, \
                 your issued_at {issued_at}). Re-sync the device clock, then sign and send again",
                now.abs_diff(issued_at),
                dpay_core::CHECKOUT_OPEN_MAX_SKEW_SECS,
            ),
        ),
        CheckoutOpenError::MalformedKey => provider_error(
            StatusCode::BAD_REQUEST,
            "merchant_pubkey is 32 bytes of hex but not an Ed25519 public key, so no signature \
             could ever verify under it and no account derives from it. Send the public key your \
             own wallet shows — a placeholder or a truncated paste lands exactly here",
        ),
        CheckoutOpenError::BadSignature => provider_error(
            StatusCode::UNAUTHORIZED,
            "the signature does not verify under merchant_pubkey. Sign the request with the key \
             whose account is to be paid, and sign it AFTER settling cents, nonce, issued_at and \
             merchant_name — every one of them is covered, so changing any of them afterwards \
             invalidates it",
        ),
        CheckoutOpenError::NonceReused => provider_error(
            StatusCode::CONFLICT,
            "this nonce was already accepted, so the charge it opened exists — poll it with \
             GET /api/v1/checkout/{id} rather than signing again. A retry needs a FRESH nonce, and a \
             fresh nonce is a new charge, not the same one",
        ),
    }
}

/// `POST /api/v1/checkout` — the merchant rings one up, and proves the account they are ringing up on
/// is theirs.
///
/// ORDER IS THE DESIGN. The price bounds are integer comparisons and go first, so a flood of
/// forged requests is refused without an Ed25519 verification each. Authorisation comes next, and
/// the store is only touched once it has passed — nothing a stranger sends reaches the charge map
/// or the nonce set.
pub(crate) async fn open_charge(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<OpenCharge>, JsonRejection>,
) -> Response {
    let req = match body_of(body) {
        Ok(req) => req,
        Err(refusal) => return refusal,
    };
    if req.cents == 0 {
        return provider_error(
            StatusCode::BAD_REQUEST,
            "a charge must be for more than nothing. A signed cents = 0 is how this checkout is \
             CLEARED, and that goes to POST /api/v1/checkout/void",
        );
    }
    if req.cents > MAX_CENTS {
        return provider_error(
            StatusCode::BAD_REQUEST,
            &format!(
                "a charge must be at most {} CHF — split a larger sale, or take it off the checkout",
                MAX_CENTS / 100
            ),
        );
    }
    let (open, sig) = match decoded(&req) {
        Ok(pair) => pair,
        Err(refusal) => return refusal,
    };
    // The merchant's account is DERIVED from their key by the same rule every other read in this
    // relay uses, and the signature checked just below proves they hold it — so they cannot open one
    // up on an account they could not spend from. dpay still holds nothing: this is a public
    // derivation, not a key.
    let account =
        dpay_icp::principal::Principal::self_authenticating_ed25519(&open.merchant_pubkey)
            .to_text();

    let id = fresh_id("pl_");
    let now = now_secs();
    let charge = {
        let mut checkouts = state.checkouts.lock().unwrap_or_else(|p| p.into_inner());
        checkouts.sweep(now);
        if let Err(e) = checkouts.authorize(&open, &sig, now) {
            return checkout_open_response(e, now, open.issued_at);
        }
        // The name is clamped HERE, after the signature has covered every byte of it — see
        // `decoded`. The store's own bound is the last thing that can refuse, and it refuses
        // AFTER the nonce is burnt on purpose: the request was authentic, so a retry needs a fresh
        // signature exactly as every other retry does.
        match checkouts.open(
            id.clone(),
            fresh_hex::<REFERENCE_BYTES>(),
            account,
            open.merchant_pubkey,
            open.merchant_name,
            open.note,
            req.cents,
            now,
        ) {
            Ok(charge) => charge,
            Err(e) => return e.to_response(),
        }
    };
    let origin = origin_of(&headers);
    let url = format!("{origin}/v1/lnurlp/{}", charge.id);
    // The three spellings of ONE address, so the merchant's screen picks by what it is rendering
    // rather than by re-deriving anything: `url` is the endpoint itself (what dpay's own payer
    // accepts directly and what a support transcript wants), `lnurl` is the LUD-01 bech32 a
    // Lightning-world wallet expects, and `qr` is the string that actually belongs in a QR — the
    // `?lightning=` wrapper the measured checkout QR prints, which a GENERIC phone camera opens as an
    // ordinary web page (see [`checkout_code_page`]) instead of showing the user a string they cannot
    // use.
    let lnurl = lnurl_of(&url);
    (
        StatusCode::OK,
        Json(json!({
            "id": charge.id,
            "amount": charge.amount_text(),
            "asset": ASSET,
            "merchant": charge.merchant,
            "url": url,
            "lnurl": lnurl,
            "qr": format!("{origin}{CHECKOUT_CODE_PATH}?lightning={lnurl}"),
            // THIS CHARGE'S NAME ON THE LEDGER, told to the one party who signed for it. Until it
            // was here the merchant could not learn it without walking their own checkout's payer
            // routes as a fake customer, so any payment they collected THEMSELVES — a tap, which
            // uses no OpenCryptoPay endpoint at all — carried some other memo, moved the money and
            // credited no sale (`match_payment`). The merchant's own app now builds its tap around
            // this value; the payer keeps learning it from step 3, which is unchanged.
            "reference": charge.reference,
            // The charge's own clock, stated rather than implied, so a cashier's screen can count
            // it down without a copy of this module's lifetime — see `ChargeStatus`.
            "created_secs": charge.created_secs,
            "expires_at": charge.expires_at(),
        })),
    )
        .into_response()
}

/// The path the `?lightning=` wrapper points at — one definition for the string this relay emits
/// and the route [`crate::app`] registers for it.
pub const CHECKOUT_CODE_PATH: &str = "/pl/";

/// `GET /pl/` — where a GENERIC phone camera lands after scanning a checkout code.
///
/// The QR carries `…/pl/?lightning=LNURL1…` because that is the shape the measured provider's own
/// checkout prints, and a camera that is not a wallet treats it as an ordinary web address. Without
/// this route that scan ends on a 404: the customer standing at the counter is shown nothing, which
/// is the dead end the founder rule forbids. The page tells them the one thing that is true — this
/// checkout settles on the Internet Computer, so the dpay app is what pays it — and where to get it.
///
/// It deliberately does NOT decode the `lightning` parameter. Doing so would put a second bech32
/// implementation (a decoder) in this crate to render a price the page would then have to fetch,
/// and none of that changes the instruction: the payment happens in the app either way.
pub(crate) async fn checkout_code_page() -> Response {
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        crate::app::with_palette(include_str!("../assets/checkout-code.html")),
    )
        .into_response()
}

/// `GET /checkout/{id}` — the CASHIER's own screen: watches the charge the merchant opened in the
/// app (the app rings up; this page is the plan's "web page later" — same endpoints, additive).
///
/// THE FENCE this page stands on: it can WATCH a charge and it can NEVER open one, void one,
/// or move a cent — those actions live behind the merchant's key in the app, and the app is
/// where they stay. Putting a seed in a browser to make this page "smarter" would be
/// custody-shaped (rule 1), and no amount of watching is worth that. What the page CAN do is
/// render the poll's own answer: [`ChargeState`]'s five states with the copy the enum documents
/// for each, so every terminal state names the cashier's next action.
///
/// Served for ANY `{id}` — the handler does not look the charge up, because the PAGE renders
/// client-side from `GET /api/v1/checkout/{id}` (the same poll the app uses). That keeps the
/// claimed merchant name out of every Rust string on this route entirely (it is untrusted
/// CLAIMED text; the browser writes it via `textContent`, never as markup), and it means an
/// unknown id gets the poll's honest answer on the first fetch rather than a server-rendered
/// guess. `no-store`: a cashier's screen must never resume a stale verdict.
pub(crate) async fn checkout_page() -> Response {
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        crate::app::with_palette(include_str!("../assets/checkout.html")),
    )
        .into_response()
}

/// `POST /api/v1/checkout/void` — the merchant clears their checkout.
///
/// THE MIS-KEYED TOTAL, which until now nobody could take back: a cashier who rings up CHF 100.00
/// for a CHF 1.00 coffee has put a payable code in front of a customer for the next hour, and the
/// only way out was to open something else and leave THAT payable instead.
///
/// It is authenticated by the same signature as a checkout-open and told apart from one by the SIGNED
/// `cents = 0` — the reason this needs no domain of its own in the core. A checkout-open carries
/// `cents >= 1` and is refused here; a cancellation carries `cents == 0` and is refused there. So
/// neither signature is a valid instance of the other action, and an attacker holding one has
/// nothing they could aim at the opposite route.
///
/// IDEMPOTENT for the cashier (cancelling an already-cleared checkout succeeds and says so), and never
/// for the money: a credited charge is refused, and the refusal names the block that paid.
pub(crate) async fn void_charge(
    State(state): State<AppState>,
    body: Result<Json<OpenCharge>, JsonRejection>,
) -> Response {
    let req = match body_of(body) {
        Ok(req) => req,
        Err(refusal) => return refusal,
    };
    if req.cents != 0 {
        return provider_error(
            StatusCode::BAD_REQUEST,
            "a cancellation is signed with cents = 0 — that is what keeps a checkout-open signature from \
             being replayed as one. Sign the request again with cents = 0 and send that",
        );
    }
    let (open, sig) = match decoded(&req) {
        Ok(pair) => pair,
        Err(refusal) => return refusal,
    };
    let account =
        dpay_icp::principal::Principal::self_authenticating_ed25519(&open.merchant_pubkey)
            .to_text();

    let now = now_secs();
    let mut checkouts = state.checkouts.lock().unwrap_or_else(|p| p.into_inner());
    checkouts.sweep(now);
    if let Err(e) = checkouts.authorize(&open, &sig, now) {
        return checkout_open_response(e, now, open.issued_at);
    }
    match checkouts.void(&account, VoidCause::Cancelled) {
        Ok(charge) => (StatusCode::OK, Json(ChargeStatus::of(&charge, now))).into_response(),
        Err(VoidRefusal::NothingOpened) => provider_error(
            StatusCode::NOT_FOUND,
            "nothing is opened on this checkout, so there is nothing to cancel. Open a charge with \
             POST /api/v1/checkout when the next customer is ready",
        ),
        // Money moved. Saying "cancelled" here would tell a merchant to hand over goods they have
        // in fact been paid for, or to chase a payment that already arrived.
        Err(VoidRefusal::AlreadyPaid(settled)) => provider_error(
            StatusCode::CONFLICT,
            &format!(
                "this charge was already paid — {} raw VCHF arrived in ledger block {}, so it \
                 cannot be cancelled. Refund it on the ledger if the sale is off; open the next \
                 customer with POST /api/v1/checkout either way",
                settled.amount_raw, settled.block,
            ),
        ),
    }
}

/// `GET /api/v1/checkout/{id}` — what the merchant's screen polls.
///
/// Settlement is re-derived from the LEDGER on every poll, not read out of memory, so the answer
/// survives a relay restart and cannot drift from what actually happened on chain.
pub(crate) async fn charge_status(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Response {
    let charge = {
        let checkouts = state.checkouts.lock().unwrap_or_else(|p| p.into_inner());
        checkouts.get(&id).cloned()
    };
    let Some(charge) = charge else {
        return CheckoutError::UnknownCharge.to_response();
    };
    let charge = observe_payment(&state, charge).await;
    (StatusCode::OK, Json(ChargeStatus::of(&charge, now_secs()))).into_response()
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
        let mut checkouts = state.checkouts.lock().unwrap_or_else(|p| p.into_inner());
        match checkouts.observe(&charge.id, now) {
            Ok(Observation::Walk(c)) => c,
            Ok(Observation::Recent(c)) => return c,
            Err(e) => {
                // The charge was swept between the caller's read and this claim. Nothing to
                // observe and nowhere to record it — say so rather than walking a ledger for a
                // charge that no longer exists.
                eprintln!(
                    "dpay-relay: checkout {}: cannot observe a charge this store no longer holds ({e:?})",
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
            eprintln!(
                "dpay-relay: checkout {}: could not read merchant history: {e}",
                charge.id
            );
            return charge;
        }
    };
    let mut checkouts = state.checkouts.lock().unwrap_or_else(|p| p.into_inner());
    match checkouts.settle_from_history(&charge.id, &rows) {
        Ok(Some(settled)) => Charge {
            paid: Some(settled),
            ..charge
        },
        Ok(None) => charge,
        Err(e) => {
            eprintln!(
                "dpay-relay: checkout {}: the charge was swept while its history was read ({e:?}) — \
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
        let owner =
            dpay_icp::principal::Principal::self_authenticating_ed25519(&charge.merchant_pubkey);
        return Ok(fake.transactions(&owner, VCHF_CURRENCY, HISTORY_LIMIT as usize, None));
    }
    let Some(row) = crate::catalog::ic_rows()
        .into_iter()
        .find(|d| d.currency == VCHF_CURRENCY)
    else {
        // The compiled catalog is this relay's own code, so a missing VCHF row is a build that
        // cannot serve this checkout at all — loud, not a silent "not seen yet".
        return Err(crate::ledger::LedgerError::Rejected(
            "VCHF is not in this relay's compiled catalog — this build cannot serve a checkout".into(),
        ));
    };
    state
        .ledger
        .transactions_on_ledger(
            &row.ledger,
            charge.merchant_pubkey,
            VCHF_CURRENCY,
            HISTORY_LIMIT,
            None,
        )
        .await
}

/// VCHF's catalog id — the one asset v1 serves.
const VCHF_CURRENCY: dpay_core::Currency = 7;
/// How far back a settlement scan looks. A charge lives an hour; a checkout doing a transfer a second
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
        let mut checkouts = state.checkouts.lock().unwrap_or_else(|p| p.into_inner());
        let Some(charge) = checkouts.get(&id).cloned() else {
            return CheckoutError::UnknownCharge.to_response();
        };
        match checkouts.quote(&id, fresh_id("plq_"), now) {
            Ok((q, exp)) => (charge, q, exp),
            Err(e) => return e.to_response(),
        }
    };

    let body = DetailsBody {
        tag: "payRequest",
        callback: format!("{origin}/v1/lnurlp/cb/{}", charge.id),
        // See the field's own note: LUD-06 means millisatoshis, this checkout has no rate, so it
        // states nothing rather than a number in the wrong unit.
        min_sendable: 0,
        max_sendable: 0,
        // BUILT, not formatted. `metadata` is a JSON document inside a JSON string, and the
        // merchant's name is a stranger's text: pasted into the shape with `format!`, a name of
        // `X"],["image/png;base64,…` closes the entry and opens a second one that wallets parse
        // and render — proven against this very checkout on prod. A serialiser cannot be talked into
        // that, because it escapes what it is given instead of trusting it.
        metadata: serde_json::json!([[
            "text/plain",
            match &charge.note {
                // The note is display text the payer reads, so the LUD-06 description carries it
                // too — same string, same serialiser, same rule.
                Some(note) => format!("{} - CHF {} - {}", charge.merchant_name, charge.price_text(), note),
                None => format!("{} - CHF {}", charge.merchant_name, charge.price_text()),
            }
        ]])
        .to_string(),
        display_name: charge.merchant_name.clone(),
        note: charge.note.clone(),
        standard: "OpenCryptoPay",
        possible_standards: vec!["OpenCryptoPay"],
        display_qr: true,
        quote: QuoteBody {
            id: quote_id,
            expiration: iso8601_utc(expires),
        },
        requested_amount: RequestedAmount {
            asset: "CHF",
            amount: charge.cents as f64 / 100.0,
        },
        transfer_amounts: vec![TransferAmount {
            method: METHOD,
            min_fee: 0,
            available: true,
            assets: vec![AssetAmount {
                asset: ASSET,
                amount: charge.amount_text(),
            }],
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
    /// The payer's own principal, reported INSTEAD of a transaction: the marker of a wallet that
    /// paid by granting an ICRC-2 allowance and is asking this provider to pull it with
    /// `icrc2_transfer_from`. Oisy is one, and names the parameter for exactly that purpose
    /// (`payIcp`, `src/frontend/src/icp/services/ic-open-crypto-pay.services.ts`).
    ///
    /// dpay's checkout cannot pull: it holds no key, by the non-custody rule, and a charge is credited
    /// by reading a transfer that ALREADY happened. So this parameter decides nothing about the
    /// money and exists here only to be REFUSED out loud — see [`lnurlp_submit`].
    pub sender: Option<String>,
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
        let checkouts = state.checkouts.lock().unwrap_or_else(|p| p.into_inner());
        let charge = match checkouts.get(&id) {
            Some(c) => c.clone(),
            None => return CheckoutError::UnknownCharge.to_response(),
        };
        // The charge's own state first, then the quote's: a payer whose code was superseded needs
        // to hear THAT, not "no actual quote with ID found", which tells them nothing they can act
        // on. Both refusals name the next move.
        if let Err(e) = charge.payable(now) {
            return e.to_response();
        }
        match checkouts.quote_expiry(&id, q.quote.as_deref().unwrap_or_default(), now) {
            Ok(expires) => (charge, expires),
            Err(e) => return e.to_response(),
        }
    };
    let Some(row) = crate::catalog::ic_rows()
        .into_iter()
        .find(|d| d.currency == VCHF_CURRENCY)
    else {
        return provider_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "VCHF is not in this relay's catalog",
        );
    };
    let body = TransferBody {
        expiry_date: iso8601_utc(expires),
        blockchain: METHOD,
        // The LIVE URI shape, not the README's. The ledger is named explicitly so a wallet pays the
        // right one — which is precisely what the measured provider fails to do on its own
        // verification side — and `ref` names THIS charge, so what credits the sale is the transfer
        // the payer was told to make rather than one that merely resembles it.
        uri: format!(
            "icp:{}/transfer?to={}&amount={}&ref={}",
            row.ledger,
            charge.merchant,
            charge.amount_text(),
            charge.reference,
        ),
        hint: "Transfer the exact amount to the address in the URI, carrying `ref` as the transfer's \
               memo, then report the transaction. Reporting is idempotent: if it fails, retry — the \
               payment is confirmed by reading the ledger, not by this call."
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
///
/// THE ONE REPORT THIS ROUTE DOES SOMETHING WITH: a `sender` principal in place of a transaction id
/// says the wallet granted an ICRC-2 allowance and is waiting to be collected from. Nothing will
/// ever arrive from such a wallet on its own, so the report is recorded as a [`PullClaim`] and
/// handed to the merchant, whose phone holds the key the allowance names. The answer stays the
/// standard's retryable `PENDING`, which is now true rather than merely polite — and it matters
/// that it is, because the wallet that sends it (Oisy) treats ANY 2xx as a completed payment and
/// tells its user so.
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
        let checkouts = state.checkouts.lock().unwrap_or_else(|p| p.into_inner());
        match checkouts.get(&id) {
            Some(c) => c.clone(),
            None => return CheckoutError::UnknownCharge.to_response(),
        }
    };
    // Recorded for support, never believed. Both values came off the wire from a stranger, so
    // both are sanitised: a raw `%0A` here writes whatever line its sender chose into this
    // relay's log.
    match (q.tx.as_deref(), q.sender.as_deref()) {
        (Some(tx), _) => eprintln!(
            "dpay-relay: checkout {}: payer reported transaction {}",
            log_safe(&id),
            log_safe(tx)
        ),
        // An allowance wallet, named so the line that follows the refusal below says WHO to look
        // for on the ledger if they later send the transfer this checkout actually reads.
        (None, Some(sender)) => eprintln!(
            "dpay-relay: checkout {}: payer {} reported an approval instead of a transfer",
            log_safe(&id),
            log_safe(sender)
        ),
        // The standard's `tx` is optional and a report without one is still a valid nudge to
        // re-read the ledger — worth a line, because a wallet that never sends one is a wallet
        // whose behaviour we would otherwise be guessing at.
        (None, None) => eprintln!(
            "dpay-relay: checkout {}: payer reported a payment without a transaction id",
            log_safe(&id)
        ),
    }
    let charge = observe_payment(&state, charge).await;
    match charge.paid {
        Some(settled) => (
            StatusCode::OK,
            Json(json!({"status": "OK", "paid": settled})),
        )
            .into_response(),
        // NOT an error the payer must act on, and deliberately not a refusal: the transfer may
        // simply not have landed yet. Retrying is correct and free.
        //
        // The reference is logged HERE and nowhere else on the settlement path. A report is the one
        // moment somebody CLAIMS to have paid, so it is bounded (one line per claim, not one per
        // poll) and it is the only line worth having when a payment moved and was never credited:
        // the memo the checkout was looking for, beside the identifier the payer reported.
        None => {
            eprintln!(
                "dpay-relay: checkout {}: no transfer carrying this charge's reference {} has been seen \
                 in the merchant's history yet",
                log_safe(&id),
                charge.reference
            );
            // INSTEAD OF, not merely alongside: a report carrying a transaction id is a wallet
            // that pushed, whatever else it also said about itself, and its transfer may simply
            // not have landed yet. Only a `sender` standing in FOR the transaction is the
            // allowance flow.
            // An allowance report is HANDED ON, not answered: the relay cannot collect it and the
            // merchant's own phone can, so the claim is recorded for that phone to find on its
            // next poll (see `PullClaim`). The answer stays the standard's retryable `PENDING`,
            // which is now true rather than merely polite — something IS about to happen, and the
            // wallet that sent it will see `OK` on its retry once the shop has pulled.
            if let (Some(payer), None) = (q.sender.as_deref(), q.tx.as_deref()) {
                let mut checkouts = state.checkouts.lock().unwrap_or_else(|p| p.into_inner());
                match checkouts.claim_pull(&id, payer.to_string(), now_secs()) {
                    Ok(()) => {}
                    // The charge stopped being payable between the read above and this write. The
                    // payer's own refusal is the honest answer — it names WHICH kind of dead, and
                    // an approval aimed at a dead charge must not be left looking live.
                    Err(e) => return e.to_response(),
                }
            }
            (
                StatusCode::ACCEPTED,
                Json(json!({"status": "PENDING", "message": "no matching transfer seen yet — safe to retry"})),
            )
                .into_response()
        }
    }
}
