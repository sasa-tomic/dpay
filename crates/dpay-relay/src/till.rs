//! The merchant half of OpenCryptoPay — dpay **as** the provider.
//!
//! Everything else in this repo pays someone else's till. This serves one: a shop shows a code, any
//! OpenCryptoPay wallet (Cake, Phoenix, Binance, dpay) pays it, and the money lands at the
//! MERCHANT'S OWN account. Plan, and the founder decisions this implements:
//! `docs/specs/2026-09-02-merchant-side-plan.md`. Measured provider behaviour this must be
//! compatible with: `docs/specs/2026-09-01-opencryptopay-findings.md`.
//!
//! THREE THINGS DECIDE THE WHOLE DESIGN.
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
//! NO CUSTODY, and it is structural rather than promised: the destination in every response is the
//! merchant's own account, supplied by the merchant, and this relay never holds a key that could
//! move it. dpay publishes a price and observes an arrival. That is the whole of its role.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

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

/// How long a charge stays payable before the till must ring it up again.
const CHARGE_TTL_SECS: u64 = 60 * 60;

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
}

impl Charge {
    /// The exact raw VCHF the payer must transfer. 1:1 with CHF, in integers.
    pub fn amount_raw(&self) -> u64 {
        self.cents.saturating_mul(RAW_PER_CENT)
    }

    /// The price as the wire spells a decimal: `10.` for CHF 10, `10.5` for CHF 10.50. Trailing
    /// zeros are trimmed because the measured provider trims them (`1.` for one franc), and a
    /// wallet written against it must meet the spelling it already parses — including the bare
    /// trailing point, which is the spelling naive decimal parsers reject and dpay's own does not.
    pub fn amount_text(&self) -> String {
        let whole = self.cents / 100;
        match self.cents % 100 {
            0 => format!("{whole}."),
            r if r % 10 == 0 => format!("{whole}.{}", r / 10),
            r => format!("{whole}.{r:02}"),
        }
    }

    fn expired(&self, now_secs: u64) -> bool {
        now_secs >= self.created_secs.saturating_add(CHARGE_TTL_SECS)
    }
}

/// Every charge this relay is serving. In memory on purpose for v1: a charge is worth less than the
/// hour it lives, and the money it describes is on a ledger that outlives any process. A restart
/// costs the cashier a re-ring, never a payment — and never a double credit, because settlement is
/// re-derived from ledger history rather than from anything stored here.
#[derive(Default)]
pub struct TillStore {
    by_id: HashMap<String, Charge>,
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
    /// The quote id is unknown or has expired.
    DeadQuote,
    /// A method/asset pair this till does not accept.
    UnsupportedAsset,
}

impl TillStore {
    /// Ring up a charge. `id` is supplied by the caller so the id generator stays in one place (the
    /// HTTP layer, which has the randomness) and this module stays pure and testable.
    pub fn open(
        &mut self,
        id: String,
        merchant: String,
        merchant_pubkey: [u8; 32],
        merchant_name: String,
        cents: u64,
        now_secs: u64,
    ) -> Charge {
        let charge = Charge {
            id: id.clone(),
            merchant,
            merchant_pubkey,
            merchant_name,
            cents,
            created_secs: now_secs,
            quotes: Vec::new(),
            paid: None,
        };
        self.by_id.insert(id, charge.clone());
        charge
    }

    pub fn get(&self, id: &str) -> Option<&Charge> {
        self.by_id.get(id)
    }

    /// Mint a quote for a charge and return it. Every read of the payment details mints a fresh one
    /// — the behaviour measured on the live provider, and the reason a wallet may hold several.
    pub fn quote(&mut self, id: &str, quote_id: String, now_secs: u64) -> Result<(String, u64), TillError> {
        let charge = self.by_id.get_mut(id).ok_or(TillError::UnknownCharge)?;
        if charge.expired(now_secs) {
            return Err(TillError::NoPendingCharge);
        }
        let expires = now_secs.saturating_add(QUOTE_TTL_SECS);
        charge.quotes.retain(|(_, exp)| *exp > now_secs);
        if charge.quotes.len() >= MAX_LIVE_QUOTES {
            charge.quotes.remove(0);
        }
        charge.quotes.push((quote_id.clone(), expires));
        Ok((quote_id, expires))
    }

    /// Is this quote one we issued for this charge, and still live?
    pub fn quote_live(&self, id: &str, quote_id: &str, now_secs: u64) -> Result<(), TillError> {
        let charge = self.by_id.get(id).ok_or(TillError::UnknownCharge)?;
        let live = charge.quotes.iter().any(|(q, exp)| q == quote_id && *exp > now_secs);
        if live { Ok(()) } else { Err(TillError::DeadQuote) }
    }

    /// Record an observed settlement. Idempotent: the FIRST observation wins and later ones are
    /// ignored, so a re-report cannot rewrite who paid or when.
    pub fn settle(&mut self, id: &str, settled: Settled) {
        if let Some(charge) = self.by_id.get_mut(id) {
            if charge.paid.is_none() {
                charge.paid = Some(settled);
            }
        }
    }

    /// Drop charges past their life. Called opportunistically; nothing depends on it having run,
    /// because every read re-checks expiry itself.
    pub fn sweep(&mut self, now_secs: u64) {
        self.by_id.retain(|_, c| !c.expired(now_secs) || c.paid.is_some());
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
///   * the transfer arrived at or after the charge was rung up — an older transfer to the same
///     merchant for the same amount is somebody else's sale, and crediting it would let one payment
///     settle two charges.
///
/// Returns the FIRST match in the order history was given (newest-first from the ledger walk), or
/// `None`. `None` is honest "not seen yet", never "refused" — the caller keeps the charge open.
pub(crate) fn match_payment(
    charge: &Charge,
    rows: &[crate::ledger::TxnRecord],
) -> Option<Settled> {
    let want = charge.amount_raw().to_string();
    rows.iter()
        .find(|r| r.to == charge.merchant && r.amount.0.to_string() == want && r.timestamp >= charge.created_secs)
        .map(|r| Settled {
            from: r.from.clone(),
            amount_raw: want.clone(),
            at_secs: r.timestamp,
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

/// What the merchant's own app polls.
#[derive(Debug, Serialize)]
pub(crate) struct ChargeStatus {
    pub id: String,
    pub cents: u64,
    pub amount: String,
    pub merchant: String,
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
    use crate::ledger::TxnRecord;

    const MERCHANT: &str = "ygf2v-iniac-cojwe-damoz-s4act-k4xft-xgpjy-776wl-wr754-qxkgo-4ae";
    const PAYER: &str = "lrdna-ain6m-ja6ko-ac4j2-jqk3t-nqs22-4irws-bsm3b-trzzq-3yfz6-mqe";

    fn charge(cents: u64, created: u64) -> Charge {
        let mut s = TillStore::default();
        s.open("pl_test".into(), MERCHANT.into(), [7u8; 32], "Test Shop".into(), cents, created);
        s.get("pl_test").unwrap().clone()
    }

    fn row(to: &str, amount: u64, ts: u64) -> TxnRecord {
        TxnRecord {
            from: PAYER.into(),
            to: to.into(),
            amount: crate::ledger::types::U64String(amount),
            nonce: String::new(),
            currency: 7,
            timestamp: ts,
            from_name: String::new(),
            to_name: String::new(),
            memo: String::new(),
        }
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
    fn a_matching_transfer_settles_the_charge() {
        let c = charge(100, 1_000);
        let got = match_payment(&c, &[row(MERCHANT, 100_000_000, 1_050)]);
        assert_eq!(got, Some(Settled { from: PAYER.into(), amount_raw: "100000000".into(), at_secs: 1_050 }));
    }

    #[test]
    fn a_transfer_that_is_not_this_sale_never_settles_it() {
        let c = charge(100, 1_000);
        // Wrong amount — an underpayment is not a payment, and an overpayment is not this charge.
        assert_eq!(match_payment(&c, &[row(MERCHANT, 99_999_999, 1_050)]), None);
        assert_eq!(match_payment(&c, &[row(MERCHANT, 100_000_001, 1_050)]), None);
        // Someone else's account: reading a history does not mean everything in it is ours.
        assert_eq!(match_payment(&c, &[row(PAYER, 100_000_000, 1_050)]), None);
        // OLDER than the charge. The clause that stops one transfer paying two sales: without it a
        // merchant who was paid CHF 1 this morning would see every later CHF 1 charge settle itself.
        assert_eq!(match_payment(&c, &[row(MERCHANT, 100_000_000, 999)]), None);
        // Exactly at the ring-up instant still counts — the boundary is inclusive, not a race.
        assert!(match_payment(&c, &[row(MERCHANT, 100_000_000, 1_000)]).is_some());
    }

    #[test]
    fn settlement_is_recorded_once_and_never_rewritten() {
        // The idempotence that lets a payer re-report safely: a second observation must not be able
        // to change who paid. Re-reporting is a RETRY here, not a second chance to lose the money.
        let mut s = TillStore::default();
        s.open("pl_a".into(), MERCHANT.into(), [7u8; 32], "Shop".into(), 100, 0);
        let first = Settled { from: PAYER.into(), amount_raw: "100000000".into(), at_secs: 10 };
        s.settle("pl_a", first.clone());
        s.settle("pl_a", Settled { from: "someone-else".into(), amount_raw: "1".into(), at_secs: 99 });
        assert_eq!(s.get("pl_a").unwrap().paid, Some(first));
    }

    #[test]
    fn only_a_quote_this_till_issued_and_has_not_expired_is_accepted() {
        let mut s = TillStore::default();
        s.open("pl_a".into(), MERCHANT.into(), [7u8; 32], "Shop".into(), 100, 0);
        s.quote("pl_a", "plq_1".into(), 0).unwrap();

        assert_eq!(s.quote_live("pl_a", "plq_1", 0), Ok(()));
        assert_eq!(s.quote_live("pl_a", "plq_1", QUOTE_TTL_SECS - 1), Ok(()));
        // Past its life, and one we never issued: both dead, neither payable.
        assert_eq!(s.quote_live("pl_a", "plq_1", QUOTE_TTL_SECS), Err(TillError::DeadQuote));
        assert_eq!(s.quote_live("pl_a", "plq_invented", 0), Err(TillError::DeadQuote));
        assert_eq!(s.quote_live("pl_nope", "plq_1", 0), Err(TillError::UnknownCharge));
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
        assert_eq!(s.quote_live("pl_a", "plq_0", 0), Ok(()));
        s.quote("pl_a", "plq_overflow".into(), 0).unwrap();
        assert_eq!(s.get("pl_a").unwrap().quotes.len(), MAX_LIVE_QUOTES);
        assert_eq!(s.quote_live("pl_a", "plq_0", 0), Err(TillError::DeadQuote));
        assert_eq!(s.quote_live("pl_a", "plq_overflow", 0), Ok(()));
    }

    #[test]
    fn a_rung_up_charge_stops_being_payable_when_it_goes_stale() {
        let mut s = TillStore::default();
        s.open("pl_a".into(), MERCHANT.into(), [7u8; 32], "Shop".into(), 100, 0);
        assert!(s.quote("pl_a", "plq_1".into(), CHARGE_TTL_SECS - 1).is_ok());
        assert_eq!(s.quote("pl_a", "plq_2".into(), CHARGE_TTL_SECS), Err(TillError::NoPendingCharge));
    }

    #[test]
    fn a_paid_charge_survives_the_sweep_and_a_stale_unpaid_one_does_not() {
        // A credited sale is the merchant's record of it; an unpaid stale charge is litter.
        let mut s = TillStore::default();
        s.open("pl_paid".into(), MERCHANT.into(), [7u8; 32], "Shop".into(), 100, 0);
        s.open("pl_stale".into(), MERCHANT.into(), [7u8; 32], "Shop".into(), 100, 0);
        s.settle("pl_paid", Settled { from: PAYER.into(), amount_raw: "100000000".into(), at_secs: 5 });
        s.sweep(CHARGE_TTL_SECS + 1);
        assert!(s.get("pl_paid").is_some());
        assert!(s.get("pl_stale").is_none());
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
            TillError::DeadQuote => provider_error(StatusCode::NOT_FOUND, "No actual quote with ID found"),
            TillError::UnsupportedAsset => provider_error(StatusCode::BAD_REQUEST, "Invalid method or asset"),
        }
    }
}

/// Unix seconds now.
fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
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

/// An id that is awkward to guess without reaching for a random dependency: the process-random
/// `RandomState` hasher seeded per relay start, mixed with a nanosecond clock. A charge id is public
/// (it rides in the QR) so this guards enumeration of OTHER merchants' charges — amounts and names —
/// not money: reporting a payment for a charge you guessed credits nothing unless a real transfer
/// for that exact amount actually arrived.
fn fresh_id(prefix: &str) -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    );
    format!("{prefix}{:016x}", h.finish())
}

/// The origin to build absolute URLs from.
///
/// `DPAY_PUBLIC_ORIGIN` wins when set (an explicit deploy-time answer). Otherwise it is derived from
/// the request: `Host` plus `X-Forwarded-Proto`, which the Cloudflare tunnel in front of prod
/// already sets — so the deployed relay is self-configuring and a local run is honestly `http`.
/// Deriving from a client-supplied header is safe HERE because the value only ever travels back to
/// that same client: a forged `Host` can mislead nobody but its sender.
fn origin_of(headers: &HeaderMap) -> String {
    if let Ok(explicit) = std::env::var("DPAY_PUBLIC_ORIGIN") {
        if !explicit.is_empty() {
            return explicit.trim_end_matches('/').to_string();
        }
    }
    let host = headers.get("host").and_then(|v| v.to_str().ok()).unwrap_or("localhost");
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("http");
    format!("{scheme}://{host}")
}

/// `POST /api/v1/till` — the merchant rings one up.
pub(crate) async fn open_charge(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<OpenCharge>,
) -> Response {
    if req.cents == 0 {
        return provider_error(StatusCode::BAD_REQUEST, "a charge must be for more than nothing");
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
    if charge.paid.is_some() {
        return charge;
    }
    // With the fake-IC gateway attached (test-helpers) history lives in the gateway's
    // principal-keyed log — the same records a signed icrc1_transfer appends. Prod walks the real
    // ICRC ledger. Same discipline either way, and the SAME reason the branch exists for
    // `/transactions` in `app.rs`: the offline loop must exercise the code path, not a stub of it.
    #[cfg(feature = "test-helpers")]
    if let Some(fake) = state.fake_ic.clone() {
        let owner = dpay_icp::principal::Principal::self_authenticating_ed25519(&charge.merchant_pubkey);
        let rows = fake.transactions(&owner, VCHF_CURRENCY, HISTORY_LIMIT as usize, None);
        let Some(settled) = match_payment(&charge, &rows) else {
            return charge;
        };
        let mut tills = state.tills.lock().unwrap_or_else(|p| p.into_inner());
        tills.settle(&charge.id, settled);
        return tills.get(&charge.id).cloned().unwrap_or(charge);
    }
    let Some(row) = crate::catalog::ic_rows().into_iter().find(|d| d.currency == VCHF_CURRENCY) else {
        return charge;
    };
    let rows = match state
        .ledger
        .transactions_on_ledger(&row.ledger, charge.merchant_pubkey, VCHF_CURRENCY, HISTORY_LIMIT, None)
        .await
    {
        Ok(rows) => rows,
        Err(e) => {
            // Never downgrade a read failure into "not paid" — the caller keeps polling.
            eprintln!("dpay-relay: till {}: could not read merchant history: {e}", charge.id);
            return charge;
        }
    };
    let Some(settled) = match_payment(&charge, &rows) else {
        return charge;
    };
    let mut tills = state.tills.lock().unwrap_or_else(|p| p.into_inner());
    tills.settle(&charge.id, settled);
    tills.get(&charge.id).cloned().unwrap_or(charge)
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
        // Fixed-amount, exactly like the measured test till: min == max, in millisats as LUD-06
        // requires the field to be. Nothing pays in millisats here — the real amounts are below —
        // but a Lightning-shaped wallet reads these before anything else, and min != max would
        // invite it to offer an amount field the till does not accept.
        min_sendable: charge.cents,
        max_sendable: charge.cents,
        metadata: format!("[[\"text/plain\",\"{} - CHF {}\"]]", charge.merchant_name, charge.amount_text()),
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
    let charge = {
        let tills = state.tills.lock().unwrap_or_else(|p| p.into_inner());
        if let Err(e) = tills.quote_live(&id, q.quote.as_deref().unwrap_or_default(), now) {
            return e.to_response();
        }
        match tills.get(&id) {
            Some(c) => c.clone(),
            None => return TillError::UnknownCharge.to_response(),
        }
    };
    let Some(row) = crate::catalog::ic_rows().into_iter().find(|d| d.currency == VCHF_CURRENCY) else {
        return provider_error(StatusCode::INTERNAL_SERVER_ERROR, "VCHF is not in this relay's catalog");
    };
    let body = TransferBody {
        expiry_date: iso8601_utc(now.saturating_add(QUOTE_TTL_SECS)),
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
    if let Some(tx) = q.tx.as_deref() {
        eprintln!("dpay-relay: till {id}: payer reported transaction {tx}");
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
