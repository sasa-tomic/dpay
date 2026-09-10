//! The agent-build relay faucet's cooldown — the relay-side resurrection of the old canister
//! faucet's rate limit (5a729ee), kept byte-identical in window, granularity and error text so
//! the app's verbatim-reason surface (Wallet N5: "faucet cooldown: try again in ~58 min") shows
//! exactly what it showed before the 2026-08-20 faucet moved to the relay.
//!
//! Pure and lock-free by itself: `FaucetCooldown::check_and_mark` is synchronous
//! (check-then-insert with NO await in between — the canister's RefCell discipline translated to
//! host code), so a `Mutex<FaucetCooldown>` can never be held across an await. Callers wrap it in
//! the repo's poison-tolerant lock convention (`unwrap_or_else(|p| p.into_inner())`).

use std::collections::HashMap;

/// The per-top-up amount, minor units: $100.00 (10_000 cents) — the old canister
/// `FAUCET_AMOUNT`, the fixed amount a self-service top-up can print per call.
pub(crate) const FAUCET_AMOUNT: u64 = 10_000;

/// The cooldown window between top-ups for the same account, per currency: 1 hour (the old
/// canister `FAUCET_COOLDOWN_SECS`). Generous for a demo; tune here — redeploying the relay is a
/// one-line image swap, no canister upgrade cycle (the reason the cooldown lives relay-side).
pub(crate) const FAUCET_COOLDOWN_SECS: u64 = 60 * 60;

/// Is this request the canonical SELF-SERVICE TOP-UP — the one and only shape the production
/// faucet serves? Both faucet handlers ask this question through this function, and it is what
/// makes the offline fixture behave like production on every request production would accept.
///
/// WHY IT EXISTS AT ALL. The two builds serve the same route with deliberately different reach:
/// the agent build accepts EXACTLY this shape and refuses everything else (an arbitrary amount is
/// a self-service surface printing arbitrary money), while the offline fixture build additionally
/// serves the e2e harness, which credits arbitrary raw amounts of arbitrary currencies to set a
/// flow's opening balance — a request production answers `422` to and therefore never rate-limits.
/// So the rule is one rule, not two: *a request production would accept is subject to production's
/// cooldown*. Before this existed the fixture had no cooldown at all, and flow 02 asserted the
/// top-up button was repeatable — a behaviour the shipped faucet has never had.
pub(crate) fn is_self_service_top_up(amount: u64) -> bool {
    amount == FAUCET_AMOUNT
}

/// Per-key (account pubkey × currency) last-top-up timestamps. The key is the same shape the old
/// canister `CacheKey` carried.
#[derive(Debug, Default)]
pub(crate) struct FaucetCooldown {
    window_secs: u64,
    last: HashMap<([u8; 32], u32), u64>,
}

impl FaucetCooldown {
    /// A cooldown with a custom window (tests shrink it; production uses
    /// [`FAUCET_COOLDOWN_SECS`]).
    pub(crate) fn with_window(window_secs: u64) -> Self {
        Self {
            window_secs,
            last: HashMap::new(),
        }
    }

    /// Check-and-mark, atomically from the caller's perspective: if the key is still cooling
    /// down, return the exact old-faucet error text (`"faucet cooldown: try again in ~58 min"`);
    /// otherwise mark `now_secs` as the key's latest top-up so a concurrent second call is
    /// refused. `Err` carries the human wait, not just seconds, because the app surfaces the
    /// string verbatim.
    pub(crate) fn check_and_mark(
        &mut self,
        pk: &[u8; 32],
        currency: u32,
        now_secs: u64,
    ) -> Result<(), String> {
        let key = (*pk, currency);
        if let Some(&last) = self.last.get(&key) {
            let ready_at = last.saturating_add(self.window_secs);
            if now_secs < ready_at {
                // Byte-identical shape to the retired canister faucet's message (5a729ee):
                // whole-unit truncation, unit picking h/min/s — the app shows it verbatim (N5).
                let secs = ready_at - now_secs;
                let (v, unit) = if secs >= 3600 {
                    (secs / 3600, "h")
                } else if secs >= 60 {
                    (secs / 60, "min")
                } else {
                    (secs, "s")
                };
                return Err(format!("faucet cooldown: try again in ~{v} {unit}"));
            }
        }
        self.last.insert(key, now_secs);
        Ok(())
    }
}

/// Test-only constructor sugar for the production window.
#[cfg(test)]
impl FaucetCooldown {
    /// The production cooldown: 1h window, empty map.
    fn new() -> Self {
        Self::with_window(FAUCET_COOLDOWN_SECS)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PK_A: [u8; 32] = [0x11; 32];
    const PK_B: [u8; 32] = [0x22; 32];

    #[test]
    fn first_top_up_is_allowed_and_marks() {
        let mut cd = FaucetCooldown::new();
        assert!(cd.check_and_mark(&PK_A, 0, 1_000).is_ok());
        // Marked: an immediate second call is refused, ~full window remaining.
        let err = cd.check_and_mark(&PK_A, 0, 1_001).unwrap_err();
        assert_eq!(
            err, "faucet cooldown: try again in ~59 min",
            "verbatim old-faucet text"
        );
    }

    #[test]
    fn window_rollover_allows_again() {
        let mut cd = FaucetCooldown::with_window(60);
        assert!(cd.check_and_mark(&PK_A, 0, 1_000).is_ok());
        // One second before the window closes: still cooling.
        let err = cd.check_and_mark(&PK_A, 0, 1_059).unwrap_err();
        assert_eq!(err, "faucet cooldown: try again in ~1 s");
        // At/after the boundary: allowed again (and re-marked).
        assert!(cd.check_and_mark(&PK_A, 0, 1_060).is_ok());
        assert!(cd.check_and_mark(&PK_A, 0, 1_061).is_err());
    }

    #[test]
    fn per_account_and_per_currency_independence() {
        let mut cd = FaucetCooldown::new();
        assert!(cd.check_and_mark(&PK_A, 0, 1_000).is_ok());
        // Different pubkey, same currency: independent.
        assert!(cd.check_and_mark(&PK_B, 0, 1_000).is_ok());
        // Same pubkey, different currency: independent.
        assert!(cd.check_and_mark(&PK_A, 1, 1_000).is_ok());
        // Only the original key is cooling down.
        assert!(cd.check_and_mark(&PK_A, 0, 1_001).is_err());
    }

    /// The shape gate BOTH builds share. Production refuses everything it rejects; the offline
    /// fixture serves those as harness credits and rate-limits exactly what production accepts.
    #[test]
    fn only_the_canonical_amount_is_a_self_service_top_up() {
        assert!(
            is_self_service_top_up(FAUCET_AMOUNT),
            "$100.00 is the self-service top-up"
        );
        assert!(!is_self_service_top_up(FAUCET_AMOUNT - 1));
        assert!(!is_self_service_top_up(FAUCET_AMOUNT + 1));
        assert!(!is_self_service_top_up(0), "a zero credit is not a top-up");
        // The raw-unit seeds the e2e harness sends (sats, wei, 8-decimal VCHF) are not top-ups.
        assert!(!is_self_service_top_up(500_000_000));
    }

    #[test]
    fn unit_text_matches_the_old_faucet_shape() {
        let mut cd = FaucetCooldown::new();
        assert!(cd.check_and_mark(&PK_A, 0, 0).is_ok());
        // 3599s remaining → "~59 min"; 3600s → "~1 h"; 7_200s → "~2 h"; sub-minute → "~N s".
        assert_eq!(
            cd.check_and_mark(&PK_A, 0, 1).unwrap_err(),
            "faucet cooldown: try again in ~59 min"
        );
        let mut cd = FaucetCooldown::with_window(7_200);
        assert!(cd.check_and_mark(&PK_A, 0, 0).is_ok());
        assert_eq!(
            cd.check_and_mark(&PK_A, 0, 1).unwrap_err(),
            "faucet cooldown: try again in ~1 h"
        );
        let mut cd = FaucetCooldown::with_window(14_400);
        assert!(cd.check_and_mark(&PK_A, 0, 0).is_ok());
        assert_eq!(
            cd.check_and_mark(&PK_A, 0, 1).unwrap_err(),
            "faucet cooldown: try again in ~3 h"
        );
        let mut cd = FaucetCooldown::with_window(5);
        assert!(cd.check_and_mark(&PK_A, 0, 0).is_ok());
        assert_eq!(
            cd.check_and_mark(&PK_A, 0, 1).unwrap_err(),
            "faucet cooldown: try again in ~4 s"
        );
    }
}
