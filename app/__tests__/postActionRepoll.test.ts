/**
 * The post-action re-poll window (founder 2026-10-05: "Solana refresh => should be done also
 * periodically and/or for some time after making payments and after conversions").
 *
 * A conversion whose payout lands on the Solana rail (a cefi venue payout, a CCTP mint) or a
 * payment sent on the Solana rail arms a BOUNDED window: the rail's balances + transactions
 * re-poll at a short cadence for a few minutes, then the window closes for good. The arithmetic
 * and the payout-rail derivation live PURE in lib/postActionRepoll.ts — no timers, no module
 * state, clock always injected — so what is pinned here is the law, not the wiring:
 *   • the window runs for a Solana payout and for an UNKNOWN payout rail (a bounded window is
 *     cheap; a missed payout is a founder support session) and never for a known IC/EVM payout
 *     (those rails' own polls already cover them);
 *   • a re-arm EXTENDS the deadline (one window, never a stack, never forever);
 *   • the tick delay is the interval inside the window and the REMAINING time at its edge, and
 *     null once it is over.
 */
import {describe, expect, test} from '@jest/globals';

import {
  convertRecordPayoutRail,
  extendRepollDeadline,
  nextRepollDelayMs,
  repollWantedForPayoutRail,
} from '../lib/postActionRepoll';

describe('convertRecordPayoutRail — which rail a conversion pays out on, from the record alone', () => {
  test('a Solana-shaped record (Jupiter leg) pays out on Solana', () => {
    expect(convertRecordPayoutRail({outLedger: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', solanaLeg: {signature: 'x'}})).toBe('solana');
  });

  test('a cross-rail record (CCTP burn → Solana mint) pays out on Solana', () => {
    expect(convertRecordPayoutRail({outLedger: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', crossRail: {mintRecipientAta: 'a'}})).toBe('solana');
  });

  test('an EVM-shaped record pays out on EVM (no Solana window)', () => {
    expect(convertRecordPayoutRail({outLedger: 'evm:native-eth', evmSwap: {txHashes: []}})).toBe('evm');
  });

  test('a cefi record pays out where its outLedger says: mint → Solana', () => {
    // A cefi record's outLedger carries the Solana MINT for a SOL-rail payout (config/swap.ts
    // hands quote.tokenOutLedger the mint) and the ledger principal for an IC payout.
    expect(convertRecordPayoutRail({outLedger: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'})).toBe('solana');
  });

  test('a cefi record with an IC-ledger payout carries a principal text → IC', () => {
    expect(convertRecordPayoutRail({outLedger: 'ryjl3-tyaaa-aaaaa-aaaba-cai'})).toBe('ic');
    expect(convertRecordPayoutRail({outLedger: 'mxzaz-hqaaa-aaaar-qaadq-cai'})).toBe('ic');
  });

  test('an EVM-native rail id and an 0x contract payout are EVM', () => {
    expect(convertRecordPayoutRail({outLedger: 'evm:native-eth'})).toBe('evm');
    expect(convertRecordPayoutRail({outLedger: '0xa0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'})).toBe('evm');
  });

  test('anything unrecognizable is UNKNOWN (the bounded window runs anyway)', () => {
    expect(convertRecordPayoutRail({outLedger: ''})).toBe('unknown');
    expect(convertRecordPayoutRail({outLedger: '??'})).toBe('unknown');
  });

  test('shape fields win over the outLedger guess', () => {
    // An EVM-shaped record whose outLedger survived as an unclear string is still EVM.
    expect(convertRecordPayoutRail({outLedger: 'not-clear', evmSwap: {}})).toBe('evm');
    expect(convertRecordPayoutRail({outLedger: 'ryjl3-tyaaa-aaaaa-aaaba-cai', crossRail: {}})).toBe('solana');
  });
});

describe('repollWantedForPayoutRail — solana or unknown runs the window; known IC/EVM do not', () => {
  test('every rail is decided', () => {
    expect(repollWantedForPayoutRail('solana')).toBe(true);
    expect(repollWantedForPayoutRail('unknown')).toBe(true);
    expect(repollWantedForPayoutRail('ic')).toBe(false);
    expect(repollWantedForPayoutRail('evm')).toBe(false);
  });
});

describe('window arithmetic — pure, injected clock', () => {
  test('extendRepollDeadline: a fresh arm starts now+window; a re-arm keeps the LATER deadline', () => {
    expect(extendRepollDeadline(0, 1_000, 350)).toBe(1_350);
    // t=300 inside the first window (deadline 1_350): the re-arm must NOT shorten the window.
    expect(extendRepollDeadline(1_350, 300, 350)).toBe(1_350);
    // t=1_100 still inside the first window, but now+window reaches past it → extended.
    expect(extendRepollDeadline(1_350, 1_100, 350)).toBe(1_450);
  });

  test('nextRepollDelayMs: interval inside the window, the remaining time at the edge, null past it', () => {
    expect(nextRepollDelayMs(0, 350, 100)).toBe(100);
    expect(nextRepollDelayMs(300, 350, 100)).toBe(50); // clamped to the remaining window
    expect(nextRepollDelayMs(350, 350, 100)).toBeNull(); // the window closes exactly at its end
    expect(nextRepollDelayMs(1_000, 350, 100)).toBeNull();
  });
});
