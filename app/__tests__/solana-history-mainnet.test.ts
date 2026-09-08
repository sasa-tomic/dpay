/**
 * SOL rail history (`solana/history.ts`) against REAL SOLANA MAINNET DATA.
 *
 * WHY THIS FILE EXISTS. `solana-history.test.ts` asserts the same parser against hand-authored RPC
 * bodies, which proves the rules agree with themselves and nothing about whether they agree with a
 * validator. OPEN_ISSUES carried that gap as "Solana history is unit-proven, not cluster-proven"
 * and named the three pieces most likely to be wrong on real data: direction and amount derived
 * from balance deltas, v0 `loadedAddresses` indexing, and the USDC/SOL row suppression. All three
 * are exercised below on transactions this repo did not write.
 *
 * PROVENANCE. Every byte in `fixtures/solana/*.json` came out of
 * `https://api.mainnet-beta.solana.com` on 2026-09-08 (public endpoint, read-only, no key, nothing
 * spent — the shipped Helius key is out of quota and was deliberately not used). Each file records
 * its own `_provenance`: the owner queried, its canonical USDC ATA (derived by this repo's own
 * `deriveAta`), the page size and the capture time. The requests were exactly the two this module
 * issues — `getSignaturesForAddress(address, {limit, commitment:'confirmed'})` and
 * `getTransaction(sig, {encoding:'json', commitment:'confirmed', maxSupportedTransactionVersion:0})`
 * — and the answers are stored verbatim, with ONE reduction recorded in `_provenance`: the meta
 * arrays no code in this repo reads (`logMessages`, `innerInstructions`, `rewards`, `returnData`,
 * `computeUnitsConsumed`, `costUnits`) were dropped to keep the fixtures reviewable. Nothing that
 * the parser touches — account keys, loaded addresses, pre/post balances, pre/post token balances,
 * fee, err, blockTime, version, slot — was altered, reordered or filled in.
 *
 * HOW THE EXPECTATIONS WERE DERIVED. Not by running the code under test and recording what it said.
 * Every number below was recomputed from the raw `preBalances`/`postBalances`/token-balance arrays
 * by an independent script, and the interesting ones are restated inline so a reviewer can check
 * them against the fixture by eye.
 *
 * The page size passed to `fetchSolanaHistory` matches each fixture's `_provenance.limit`, because
 * this module unions the two signature pages, sorts by slot and cuts to `limit` BEFORE fetching
 * details — so a larger limit would ask for details the capture does not hold.
 */
import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';
import type {SolanaRpcStub} from '../solana/rpc';
import {fetchSolanaHistory, resetSolanaHistoryCache} from '../solana/history';

import lutTrader from './fixtures/solana/mainnet-lut-trader.json';
import legacyTransfers from './fixtures/solana/mainnet-legacy-transfers.json';
import lutLoadedOwner from './fixtures/solana/mainnet-lut-loaded-owner.json';

const RPC = 'https://rpc.example';

/** A captured page: the two signature queries and one detail per signature, keyed as the RPC keys
 *  them. `_provenance` is the capture's own record, not RPC data. */
type Capture = {
  _provenance: {owner: string; ata: string; limit: number; endpoint: string; captured_utc: string};
  getSignaturesForAddress: Record<string, {signature: string; slot: number}[]>;
  getTransaction: Record<string, unknown>;
};

let warn: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  // Details are cached by signature across calls — clear it so one capture cannot answer another's
  // fetch (the three fixtures share no signature, but the cache is global and this is money).
  resetSolanaHistoryCache();
});

afterEach(() => {
  warn.mockRestore();
  delete (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB;
});

/**
 * Serve a capture through the RPC seam. The stub is a TRANSPORT double only: it answers the two
 * methods out of the recorded tables and nothing else, so what the parser sees is what the mainnet
 * node said. An address the capture does not hold answers `[]` — which is what the node answered
 * for an ATA that has never been used.
 */
function serve(capture: Capture): void {
  (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = {
    getSignaturesForAddress: (params: unknown[]) => capture.getSignaturesForAddress[params[0] as string] ?? [],
    getTransaction: (params: unknown[]) => {
      const sig = params[0] as string;
      if (!(sig in capture.getTransaction)) {
        throw new Error(`the capture holds no detail for ${sig} — the test asked for more than it recorded`);
      }
      return capture.getTransaction[sig];
    },
  };
}

/** Read a capture and drive the module exactly as the app does, at the page size it was captured
 *  with. Returns the rows keyed the way the assertions below read them. */
async function historyOf(capture: Capture) {
  serve(capture);
  return fetchSolanaHistory(RPC, capture._provenance.owner, {limit: capture._provenance.limit});
}

describe('solana history against real mainnet transactions', () => {
  test('v0 swaps with address-lookup tables: USDC direction and amount come out of the token deltas, and the SOL leg is the fee', async () => {
    const capture = lutTrader as unknown as Capture;
    const {rows, dropped} = await historyOf(capture);

    // Nothing in a real page was unreadable. This is the load-bearing half of the LUT assertion:
    // every one of these transactions carries `meta.loadedAddresses`, and `preBalances` is indexed
    // over statics ++ writable ++ readonly. A parser that read only `message.accountKeys` would
    // fail the length agreement on all five and report `dropped: 5` with five console lines.
    expect(dropped).toBe(0);
    expect(warn).not.toHaveBeenCalled();

    // Five movements out of an eight-transaction page. The three that produce nothing are real
    // too: the wallet is listed in them but neither its lamports nor its USDC moved, which is
    // "readable, just not a movement" rather than a drop.
    expect(rows).toHaveLength(5);

    // Newest first, by slot, with no re-derivation of time: `blockTime` is the node's, verbatim.
    expect(rows.map(r => r.slot)).toEqual([445367331, 445367225, 445367166, 445367118, 445367097]);
    expect(rows.every(r => r.token === 'USDC')).toBe(true);
    expect(rows.every(r => r.ok)).toBe(true);

    // 4QmTxeTC…: preTokenBalances says this owner held 36_520_225 more USDC than postTokenBalances
    // does, so the row is an OUT of exactly that many 1e-6 units. The wallet is the fee payer
    // (account index 0), so the 105_000-lamport fee is broken out rather than folded into a
    // second row.
    expect(rows[0]).toMatchObject({
      signature: '4QmTxeTC9cLGMiEA62behEeMUfXUm5tL7vsHHxFJo5PcoMEd4k3vMXdkwPknp6YimkoM4f7PCxeLDzRvvnCmgqND',
      blockTime: 1788879668,
      direction: 'out',
      amount: '36520225',
      feeLamports: '105000',
    });

    // …and no SOL row for it: the wallet's whole lamport delta on that transaction is −105_000,
    // exactly the fee it paid, so showing a second row would double-count one payment. This is the
    // suppression rule meeting a real swap rather than a constructed one.
    expect(rows.filter(r => r.token === 'SOL')).toHaveLength(0);

    // 2YsuK32r…: the same wallet on the receiving side — 8_104_441 units IN — inside a 44-account
    // transaction whose static message names only 14. Direction is the sign of the delta, nothing
    // else.
    expect(rows[2]).toMatchObject({
      signature: '2YsuK32rM95zRc3xiTm4XsfLVEebYRzhiY1C53QXjCCx5SWzKoGbX2HPiKcZAkwbvjGMwe2do3F91hLFnrSARtAT',
      direction: 'in',
      amount: '8104441',
      feeLamports: '60953',
    });

    // The counterparty is the one other USDC owner whose balance moved the opposite way. On these
    // swaps that is the pool's own account — a fact about the transaction, not a guess.
    expect(rows.map(r => r.counterparty)).toEqual([
      '7wXtGayssQRekJYop299FoJZmcD7fvRW6NUwLk3r6VWM',
      'CJQVxjQRM1pcy7Gptbs1PcY3wTGGxvJ1q52RVzSvX7Dp',
      'F2KCaXcp7AoQtxTDvNEDCyMyWjSCAMWNzcyN9dsPfPs5',
      'FpCMFDFGYotvufJ7HrFHsWEiiQCGbkLCtwHiDnh7o28Q',
      'FGQoLafigpyVb7mLa6pvsDDpDaEE3JetrzQoAggTo3n7',
    ]);
  });

  test('legacy transfers: a USDC payment that also moved SOL keeps BOTH rows, and one that moved only the fee keeps one', async () => {
    const capture = legacyTransfers as unknown as Capture;
    const {rows, dropped} = await historyOf(capture);

    expect(dropped).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    // Eight transactions, nine rows — because exactly one of them produced two.
    expect(rows).toHaveLength(9);

    // 3cgJQ2iT… is the case the suppression rule must NOT swallow: 136_872_920 units of USDC left,
    // AND 1_940_569 lamports left. The fee was 85_000, so the lamports are a real movement (an
    // account rent-exemption alongside the transfer) and hiding them would understate what left the
    // wallet by ~0.0019 SOL.
    const both = rows.filter(r => r.signature.startsWith('3cgJQ2iT'));
    expect(both).toHaveLength(2);
    expect(both[0]).toMatchObject({token: 'USDC', direction: 'out', amount: '136872920', feeLamports: '85000'});
    expect(both[1]).toMatchObject({token: 'SOL', direction: 'out', amount: '1940569', feeLamports: '85000'});

    // MAeTJy9Y… is the same shape with the lamport delta EQUAL to the fee, so it keeps one row.
    const suppressed = rows.filter(r => r.signature.startsWith('MAeTJy9Y'));
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]).toMatchObject({token: 'USDC', direction: 'out', amount: '6158081559'});

    // A plain SOL transfer: the row is the NET delta, fee included, with the fee stated beside it —
    // 53_522_830 left the wallet and 53_515_830 arrived, the 7_000 difference being the fee.
    const plain = rows.filter(r => r.signature.startsWith('4gLRhTTJ'));
    expect(plain).toEqual([expect.objectContaining({
      token: 'SOL',
      direction: 'out',
      amount: '53522830',
      feeLamports: '7000',
      counterparty: 'ESaAnxau4k7h9Rn2U4DF1ehvLyNHWmfZchj5tgymUBVZ',
    })]);

    // Two of these transactions moved nothing but the fee, and they are rows: the wallet really is
    // that much poorer. `counterparty` is null because a fee has no opposite party in the balances.
    const feeOnly = rows.filter(r => r.token === 'SOL' && r.amount === r.feeLamports);
    expect(feeOnly.map(r => r.amount)).toEqual(['15000', '45000']);
    expect(feeOnly.every(r => r.counterparty === null)).toBe(true);

    // A multi-party transaction names nobody rather than picking one: 3cgJQ2iT… has more than one
    // account on the opposite side of the USDC move.
    expect(both[0].counterparty).toBeNull();
  });

  test('a v0 transaction indexes balances over the LOOKUP-TABLE addresses too — an owner the static message never names', async () => {
    const capture = lutLoadedOwner as unknown as Capture;
    // This owner appears in NEITHER transaction's `message.accountKeys`. It is at index 32 of one
    // and 16 of the other, both inside `meta.loadedAddresses`, so its lamports can only be found by
    // concatenating statics ++ writable ++ readonly IN THAT ORDER. Get the order or the offset
    // wrong and the row is a different account's money.
    const {rows, dropped} = await historyOf(capture);

    expect(dropped).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);

    // 2bkK1axd…: 52 accounts, 14 of them static. postBalances[32] − preBalances[32] = +173_768_339.
    // The fee is NOT charged to this account — it is index 32, not index 0 — so `feeLamports` is
    // '0' and the amount is the whole delta.
    expect(rows[0]).toEqual({
      signature: '2bkK1axdhgH63jMzGQcEtVU3MvpKBPm6KfWoomy2Nc8B19J4DCCJwCy3KwVYDkV2iJjs2GhtudmMJxNBbRpCY1ve',
      slot: 445368824,
      blockTime: 1788880138,
      token: 'SOL',
      direction: 'in',
      amount: '173768339',
      feeLamports: '0',
      counterparty: 'JDaqLSxhAtYvxsCWcaHsccnHiCxxW9HHUPHfvDYh6Jwi',
      ok: true,
    });

    // The second transaction FAILED on chain (`meta.err` = InstructionError 3 / Custom 6001). The
    // chain rolled everything back except the fee, which this account did not pay, so it moved
    // nothing and produces no row — not a phantom payment, and not a drop either.
    expect(rows.some(r => r.signature.startsWith('4GjbnYEm'))).toBe(false);
  });

  test('the fixtures are what a mainnet node answered, not something this repo wrote', () => {
    // A capture with no provenance is a capture nobody can check. Pinned so a future edit cannot
    // quietly replace real bytes with convenient ones.
    for (const capture of [lutTrader, legacyTransfers, lutLoadedOwner] as unknown as Capture[]) {
      expect(capture._provenance.endpoint).toBe('https://api.mainnet-beta.solana.com');
      expect(capture._provenance.captured_utc).toMatch(/^2026-09-08T/);
      // Both signature pages are recorded — the owner's and its canonical USDC ATA's — because the
      // module issues both and a fixture holding only one would silently test half the query.
      expect(Object.keys(capture.getSignaturesForAddress).sort())
        .toEqual([capture._provenance.owner, capture._provenance.ata].sort());
      // Every signature the module will ask a detail for is present.
      const union = new Set<string>();
      for (const page of Object.values(capture.getSignaturesForAddress)) {
        for (const e of page) union.add(e.signature);
      }
      const asked = [...union].length;
      expect(Object.keys(capture.getTransaction).length)
        .toBe(Math.min(asked, capture._provenance.limit));
    }
  });
});
