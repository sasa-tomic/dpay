//! Property tests for the ICPSwap conversion surface (delegated-conversion PoC,
//! spec 2026-09-07): the `depositFromAndSwap` arg encoder/decoder pair and the
//! minimum-out helper. Byte-level goldens against the production @dfinity/candid
//! encoder live in tests/goldens.rs; this file pins the algebra the goldens can
//! only sample — full-range round-trips and the exact floor semantics of the
//! slippage math (never above the quote, never the overflow-to-0 of the naive
//! saturating form).

use dpay_icp::icrc;
use proptest::prelude::*;

#[test]
fn min_out_known_values() {
    assert_eq!(icrc::swap_amount_out_minimum(10_000, 100), 9_900); // exactly 1%
    assert_eq!(icrc::swap_amount_out_minimum(2_000_000, 300), 1_940_000); // 3% of the float-op quote
    assert_eq!(icrc::swap_amount_out_minimum(3, 3_333), 2); // floor(3 × 6667 ÷ 10_000) = 2
    assert_eq!(icrc::swap_amount_out_minimum(1, 9_999), 0);
    assert_eq!(icrc::swap_amount_out_minimum(10_000, 9_999), 1);
    assert_eq!(icrc::swap_amount_out_minimum(9_999, 9_999), 0);
    assert_eq!(icrc::swap_amount_out_minimum(0, 0), 0);
}

#[test]
fn min_out_edges_saturate_without_overflow() {
    // 0 bps is the identity, even at the u128 ceiling.
    assert_eq!(icrc::swap_amount_out_minimum(u128::MAX, 0), u128::MAX);
    // bps at or above 10_000 floors at 0 — including the u16 ceiling.
    assert_eq!(icrc::swap_amount_out_minimum(u128::MAX, 10_000), 0);
    assert_eq!(icrc::swap_amount_out_minimum(123, u16::MAX), 0);
    // Hand-derived exact floor(u128::MAX × 9_900 ÷ 10_000) — the region where the naive
    // `quoted.saturating_sub(quoted.saturating_mul(bps) / 10_000)` form overflows its
    // multiply to 0 and would silently drop slippage protection on the largest quotes.
    assert_eq!(
        icrc::swap_amount_out_minimum(u128::MAX, 100),
        336_879_543_251_729_078_828_740_861_357_450_529_340u128
    );
}

/// Spec §6 conservation: the min-out derived from a venue quote never exceeds the quote
/// it is derived from, at any width — the swap can only refuse to execute, never
/// over-promise the venue's number.
#[test]
fn min_out_never_exceeds_the_quote() {
    for &(q, bps) in &[
        (0u128, 0u16),
        (1, 0),
        (1, 1),
        (9_999, 9_999),
        (10_000, 100),
        (u128::MAX, 0),
        (u128::MAX, 1),
        (u128::MAX, 100),
        (u128::MAX, 9_999),
        (u128::MAX, 10_000),
        (u128::MAX, u16::MAX),
    ] {
        assert!(
            icrc::swap_amount_out_minimum(q, bps) <= q,
            "min_out({q}, {bps}) exceeded the quote"
        );
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// Round-trip: decode(deposit_and_swap_arg(...)) is the identity for arbitrary
    /// amounts — the full u128 range on every numeric field, so the uleb edges and the
    /// 39-char text ceiling are both exercised.
    #[test]
    fn deposit_and_swap_round_trip(
        amount_in in any::<u128>(),
        amount_out_minimum in any::<u128>(),
        token_in_fee in any::<u128>(),
        token_out_fee in any::<u128>(),
        zero_for_one in any::<bool>(),
    ) {
        let arg = icrc::deposit_and_swap_arg(
            amount_in,
            amount_out_minimum,
            token_in_fee,
            token_out_fee,
            zero_for_one,
        );
        prop_assert_eq!(
            icrc::decode_deposit_and_swap_arg(&arg).unwrap(),
            icrc::DepositAndSwapArg {
                amount_in,
                amount_out_minimum,
                token_in_fee,
                token_out_fee,
                zero_for_one,
            }
        );
    }

    /// Min-out equals the exact floor `quoted × k ÷ 10_000` (k = 10_000 − bps, clamped
    /// at 0) wherever the direct product cannot overflow — quoted < 2^112 keeps
    /// quoted × 0xFFFF inside u128 — and never exceeds the quote.
    #[test]
    fn min_out_is_the_exact_floor(
        quoted in 0..(1u128 << 112),
        bps in 0u16..=u16::MAX,
    ) {
        let got = icrc::swap_amount_out_minimum(quoted, bps);
        let k = 10_000u128.saturating_sub(u128::from(bps));
        prop_assert_eq!(got, quoted * k / 10_000);
        prop_assert!(got <= quoted);
    }
}
