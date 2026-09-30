/**
 * The one-tap ATA setup planner (`app/lib/ataSetup.ts`) — pure, unit-tested.
 *
 * The founder gap it closes (2026-09-30): "EUR (EURC) says that a setup is needed -> complete
 * that setup as soon as user adds funds to any currency, by swapping + completing the setup."
 * The planner is the DECISION half: given the wallet's known SPL token states, its SOL balance
 * and the venue registry, it answers with exactly one plan:
 *   create — SOL already covers every absent account's rent+fee: no swap;
 *   fund   — SOL is short but a FUNDED SPL token has a registered solana_amm venue pairing
 *            its mint with wrapped SOL: name the candidates, the SOL target to reach;
 *   refuse — nothing in the wallet can pay for the setup: the honest dead end (the user is
 *            shown the needSol copy + their SOL address, never a forced losing swap).
 *
 * `sizeAtaFundPlan` is the executor's sizing walk (quotes injected — still network-free):
 * shrink-to-fit the smallest input whose venue floor covers the target, never up past the
 * balance, first deliverable candidate wins.
 */
import {describe, test, expect} from '@jest/globals';
import {SOL_ATA_SETUP_MIN_LAMPORTS, SOL_FEE_LAMPORTS} from '../solana/spl';
import {EURC_MINT_ADDRESS, USDC_MINT_ADDRESS} from '../solana/tokens';
import {planAtaSetup, sizeAtaFundPlan, sizeAtaIcFundPlan, type AtaIcFundSource, type AtaSetupTokenInput} from '../lib/ataSetup';

const EURC = EURC_MINT_ADDRESS;
const USDC = USDC_MINT_ADDRESS;

const absent = (over: Partial<AtaSetupTokenInput> = {}): AtaSetupTokenInput => ({
  mint: EURC, symbol: 'EURC', status: 'absent', ...over,
});
const funded = (over: Partial<AtaSetupTokenInput> = {}): AtaSetupTokenInput => ({
  mint: USDC, symbol: 'USDC', decimals: 6, amount: '5000000', status: 'balance', ...over,
});

describe('planAtaSetup — the create branch (SOL already covers)', () => {
  test('SOL >= N * (rent + fee) → create every absent mint, no swap', () => {
    const plan = planAtaSetup({
      targets: [absent(), absent({mint: USDC, symbol: 'USDC'})],
      solBalance: String(2 * Number(SOL_ATA_SETUP_MIN_LAMPORTS)),
      sources: [],
    });
    expect(plan).toMatchObject({kind: 'create', mints: [EURC, USDC]});
    if (plan.kind === 'create') {
      expect(BigInt(plan.costLamports)).toBe(2n * SOL_ATA_SETUP_MIN_LAMPORTS);
    }
  });

  test('SOL exactly at the floor → create (the boundary is inclusive; the chain enforces the real rent)', () => {
    const plan = planAtaSetup({targets: [absent()], solBalance: SOL_ATA_SETUP_MIN_LAMPORTS.toString(), sources: []});
    expect(plan.kind).toBe('create');
  });

  test('no absent account → nothing to do', () => {
    const plan = planAtaSetup({
      targets: [absent({status: 'balance', amount: '0'})],
      solBalance: '0',
      sources: [],
    });
    expect(plan).toEqual({kind: 'none'});
  });
});

describe('planAtaSetup — the fund branch (SOL short, a funded token can pay)', () => {
  test('SOL below the floor + funded USDC → fund plan naming USDC as the only candidate', () => {
    const plan = planAtaSetup({targets: [absent()], solBalance: '1000000', sources: [funded()]});
    expect(plan.kind).toBe('fund');
    if (plan.kind === 'fund') {
      expect(plan.candidates).toHaveLength(1);
      expect(plan.candidates[0]).toMatchObject({mint: USDC, symbol: 'USDC', decimals: 6, rawAmount: '5000000'});
      // target = the TOTAL SOL the wallet must hold afterwards: the full setup cost + the
      // swap's own fee buffer (2 signatures). The current SOL is subtracted by the sizer,
      // never by the plan — the plan states the wallet-level requirement.
      expect(BigInt(plan.targetLamports)).toBe(SOL_ATA_SETUP_MIN_LAMPORTS + 2n * SOL_FEE_LAMPORTS);
      expect(BigInt(plan.costLamports)).toBe(SOL_ATA_SETUP_MIN_LAMPORTS);
    }
  });

  test('a funded token with NO registered wrapped-SOL venue is not a candidate (fail closed)', () => {
    // USDC keeps its venue; the source below is a mint no venue pairs with wrapped SOL.
    const plan = planAtaSetup({
      targets: [absent()],
      solBalance: '0',
      sources: [funded({mint: 'MintNobodyPairsWith1111111111111111111111111', symbol: 'X'})],
    });
    expect(plan.kind).toBe('refuse');
  });

  test('an unmeasured (null) SOL balance is treated as zero — it never blocks the fund plan, never fakes a create', () => {
    const plan = planAtaSetup({targets: [absent()], solBalance: null, sources: [funded()]});
    expect(plan.kind).toBe('fund');
    if (plan.kind === 'fund') {
      expect(BigInt(plan.targetLamports)).toBe(SOL_ATA_SETUP_MIN_LAMPORTS + 2n * SOL_FEE_LAMPORTS);
    }
  });

  test('zero-balance and offline states are not funding sources (only a measured positive balance is)', () => {
    const plan = planAtaSetup({
      targets: [absent()],
      solBalance: '0',
      sources: [
        funded({amount: '0'}),
        funded({status: 'error' as const, amount: null}),
        funded({status: 'loading' as const, amount: null}),
      ],
    });
    expect(plan.kind).toBe('refuse');
  });

  test('N absent accounts raise the target by N rents (rent is per-token)', () => {
    const plan = planAtaSetup({
      targets: [absent(), absent({mint: USDC, symbol: 'USDC'})],
      solBalance: '0',
      sources: [funded()],
    });
    expect(plan.kind).toBe('fund');
    if (plan.kind === 'fund') {
      expect(BigInt(plan.targetLamports)).toBe(2n * SOL_ATA_SETUP_MIN_LAMPORTS + 2n * SOL_FEE_LAMPORTS);
      expect(plan.mints).toEqual([EURC, USDC]);
    }
  });
});

describe('planAtaSetup — the honest refusal', () => {
  test('SOL short, nothing funded → refuse (the needSol dead end, never a swap)', () => {
    const plan = planAtaSetup({targets: [absent()], solBalance: '0', sources: []});
    expect(plan).toEqual({kind: 'refuse'});
  });

  test('SOL unknown and nothing funded → refuse too (an unknown balance is not a funded one)', () => {
    const plan = planAtaSetup({targets: [absent()], solBalance: null, sources: []});
    expect(plan).toEqual({kind: 'refuse'});
  });
});

// ── The fund-ic branch (founder override 2026-09-30): a wallet holding ONLY IC-side money ──────
// (ckUSDC@ICP, VCHF@ICP, ICP) used to land in refuse. The founder: "complete that setup as soon
// as user adds some funds to ANY currency, by swapping + completing the setup". The IC candidates
// are pure data (the executor resolves the convert-engine route); the SPL fund branch keeps its
// precedence (a same-rail venue swap is cheaper than a cross-rail one).
const icSource = (over: Partial<AtaIcFundSource> = {}): AtaIcFundSource => ({
  currencyKey: 'ic:7', symbol: 'VCHF', decimals: 8, rawAmount: '2000000000', ...over,
});

describe('planAtaSetup — the fund-ic branch (no SPL source, IC-side money funds the swap)', () => {
  test('SOL short, no usable SPL source, a funded IC asset → fund-ic naming the candidate', () => {
    const plan = planAtaSetup({targets: [absent()], solBalance: '0', sources: [], icSources: [icSource()]});
    expect(plan.kind).toBe('fund-ic');
    if (plan.kind === 'fund-ic') {
      expect(plan.candidates).toEqual([icSource()]);
      // The same wallet-level target convention as the fund branch: the plan states the TOTAL
      // SOL the wallet must hold afterwards; the sizer subtracts the SOL already held.
      expect(BigInt(plan.targetLamports)).toBe(SOL_ATA_SETUP_MIN_LAMPORTS + 2n * SOL_FEE_LAMPORTS);
      expect(BigInt(plan.costLamports)).toBe(SOL_ATA_SETUP_MIN_LAMPORTS);
      expect(plan.mints).toEqual([EURC]);
    }
  });

  test('IC candidates keep the caller\'s registry/matrix order (first-listed first)', () => {
    const plan = planAtaSetup({
      targets: [absent()], solBalance: '0', sources: [],
      icSources: [icSource(), icSource({currencyKey: 'ic:2', symbol: 'ckUSDC', rawAmount: '1000000'})],
    });
    if (plan.kind !== 'fund-ic') throw new Error('expected fund-ic');
    expect(plan.candidates.map(c => c.currencyKey)).toEqual(['ic:7', 'ic:2']);
  });

  test('a zero or unmeasured IC balance is not a candidate (only a measured positive one is)', () => {
    const plan = planAtaSetup({
      targets: [absent()], solBalance: '0', sources: [],
      icSources: [icSource({rawAmount: '0'}), icSource({currencyKey: 'ic:2', symbol: 'ckUSDC', rawAmount: ''})],
    });
    expect(plan.kind).toBe('refuse');
  });

  test('a funded SPL token still wins: fund, never fund-ic (same-rail swap before a cross-rail one)', () => {
    const plan = planAtaSetup({
      targets: [absent()], solBalance: '0', sources: [funded()], icSources: [icSource()],
    });
    expect(plan.kind).toBe('fund');
  });

  test('SOL covers → create, even with IC sources sitting there (no swap at all)', () => {
    const plan = planAtaSetup({
      targets: [absent()], solBalance: SOL_ATA_SETUP_MIN_LAMPORTS.toString(), sources: [], icSources: [icSource()],
    });
    expect(plan.kind).toBe('create');
  });

  test('nothing funded anywhere → refuse is unchanged (the honest dead end stays)', () => {
    const plan = planAtaSetup({targets: [absent()], solBalance: '0', sources: [], icSources: []});
    expect(plan).toEqual({kind: 'refuse'});
  });
});

describe('sizeAtaIcFundPlan — the injected-quote sizing walk over the IC candidates', () => {
  // The target for one absent account, SOL 0.
  const plan = planAtaSetup({targets: [absent()], solBalance: '0', sources: [], icSources: [icSource()]});
  if (plan.kind !== 'fund-ic') throw new Error('fixture: expected a fund-ic plan');
  const target = BigInt(plan.targetLamports);

  test('the full balance more than covers → shrink toward the shortfall, never below the venue minimum', async () => {
    // Price: 1 raw VCHF unit → 16 lamports. 2 VCHF → 0.032 SOL, far above the ~0.00205 target.
    const calls: string[] = [];
    const sized = await sizeAtaIcFundPlan({
      plan,
      solKnown: '0',
      quote: async (_source, inRaw) => {
        calls.push(inRaw);
        return {kind: 'quote', outLamports: (BigInt(inRaw) * 16n).toString()};
      },
    });
    expect(sized).not.toBeNull();
    if (sized == null) return;
    expect(BigInt(sized.inAmount)).toBeLessThan(2_000_000_000n); // shrunk below the full balance
    expect(BigInt(sized.outFloor)).toBeGreaterThanOrEqual(target);
    expect(calls[calls.length - 1]).toBe(sized.inAmount); // the sized input was quoted fresh
    expect(calls.length).toBeLessThanOrEqual(6);
  });

  test('the venue minimum is discovered from the below-min refusal and used as the input when it covers', async () => {
    // Venue minimum: 1 VCHF (100000000 raw). At the full 2 VCHF the venue would quote fine, so
    // force the walk onto the refusal path directly: quote refuses everything with the minimum.
    const sized = await sizeAtaIcFundPlan({
      plan,
      solKnown: '0',
      quote: async (_source, inRaw) => {
        // Refuse below the minimum; at/above it quote 16 lamports per raw unit.
        if (BigInt(inRaw) < 100_000_000n) return {kind: 'belowMin', minInRaw: '100000000'};
        return {kind: 'quote', outLamports: (BigInt(inRaw) * 16n).toString()};
      },
    });
    expect(sized).not.toBeNull();
    if (sized == null) return;
    expect(BigInt(sized.inAmount)).toBeGreaterThanOrEqual(100_000_000n); // never below the venue minimum
    expect(BigInt(sized.outFloor)).toBeGreaterThanOrEqual(target);
  });

  test('the wallet cannot reach the venue minimum → the candidate is skipped (never a forced swap)', async () => {
    const second: AtaIcFundSource = icSource({currencyKey: 'ic:2', symbol: 'ckUSDC', decimals: 6, rawAmount: '1000000'});
    const plan2 = planAtaSetup({targets: [absent()], solBalance: '0', sources: [], icSources: [icSource({rawAmount: '50000000'}), second]});
    if (plan2.kind !== 'fund-ic') throw new Error('fixture: expected fund-ic');
    // Candidate 1 holds 0.5 VCHF, venue minimum 1 VCHF → skipped. Candidate 2 (1 USDC at 16
    // lamports per raw unit) covers easily.
    const sized = await sizeAtaIcFundPlan({
      plan: plan2,
      solKnown: '0',
      quote: async (source, inRaw) => {
        if (source.currencyKey === 'ic:7' && BigInt(inRaw) < 100_000_000n) {
          return {kind: 'belowMin', minInRaw: '100000000'};
        }
        return {kind: 'quote', outLamports: (BigInt(inRaw) * 16n).toString()};
      },
    });
    expect(sized).not.toBeNull();
    if (sized == null) return;
    expect(sized.source.currencyKey).toBe('ic:2');
  });

  test('no candidate can reach the target → null (the honest fall-through to refuse)', async () => {
    const sized = await sizeAtaIcFundPlan({
      plan,
      solKnown: '0',
      quote: async () => ({kind: 'quote', outLamports: '1'}), // a dust venue rate
    });
    expect(sized).toBeNull();
  });

  test('the venue minimum itself cannot reach the target → null', async () => {
    const sized = await sizeAtaIcFundPlan({
      plan,
      solKnown: '0',
      quote: async (_source, inRaw) => {
        if (BigInt(inRaw) < 100_000_000n) return {kind: 'belowMin', minInRaw: '100000000'};
        // Even at the venue minimum the rate is dust: ~0.0016 SOL at 1 VCHF, under the target.
        return {kind: 'quote', outLamports: (BigInt(inRaw) / 625_000_000n).toString()};
      },
    });
    expect(sized).toBeNull();
  });

  test('an unquotable candidate (venue refused / no market) is skipped, not a crash', async () => {
    const sized = await sizeAtaIcFundPlan({plan, solKnown: '0', quote: async () => null});
    expect(sized).toBeNull();
  });

  test('existing SOL counts toward the target: the swap only covers the shortfall', async () => {
    const shortSol = (SOL_ATA_SETUP_MIN_LAMPORTS - 1n).toString();
    const sized = await sizeAtaIcFundPlan({
      plan,
      solKnown: shortSol,
      quote: async (_source, inRaw) => ({kind: 'quote', outLamports: (BigInt(inRaw) * 16n).toString()}),
    });
    expect(sized).not.toBeNull();
    if (sized == null) return;
    expect(BigInt(sized.outFloor) + BigInt(shortSol)).toBeGreaterThanOrEqual(target);
    expect(BigInt(sized.inAmount)).toBeLessThan(1_000_000n); // a tiny swap only
  });
});

describe('sizeAtaFundPlan — the injected-quote sizing walk', () => {
  // Build the fund plan once (SOL 0, one funded 5-USDC source).
  const plan = planAtaSetup({targets: [absent()], solBalance: '0', sources: [funded()]});
  if (plan.kind !== 'fund') throw new Error('fixture: expected a fund plan');
  const target = BigInt(plan.targetLamports);

  test('the full balance more than covers → shrink to the smallest input whose floor still covers', async () => {
    // Price: 1 raw USDC unit → 16 lamports (≈ $1 per 0.016 SOL). 5 USDC → 0.08 SOL, far above
    // the ~0.00205 target, so the walk must shrink.
    const calls: string[] = [];
    const sized = await sizeAtaFundPlan({
      plan,
      solKnown: '0',
      quote: async (_source, inRaw) => {
        calls.push(inRaw);
        const out = BigInt(inRaw) * 16n;
        return {outAmount: out.toString(), otherAmountThreshold: out.toString()};
      },
    });
    expect(sized).not.toBeNull();
    if (sized == null) return;
    expect(BigInt(sized.inAmount)).toBeLessThan(5_000_000n); // shrunk below the full balance
    expect(BigInt(sized.outFloor)).toBeGreaterThanOrEqual(target);
    // Converged: the last quoted input IS the sized input, and it was re-quoted fresh.
    expect(calls[calls.length - 1]).toBe(sized.inAmount);
    expect(calls.length).toBeLessThanOrEqual(5); // full pass + ≤4 shrink re-quotes
  });

  test('the full balance cannot reach the target → null (a smaller input never covers either)', async () => {
    const sized = await sizeAtaFundPlan({
      plan,
      solKnown: '0',
      quote: async (_source, inRaw) => {
        const out = (BigInt(inRaw) * 1n) / 1_000_000_000n; // ~0.000001 SOL per 5 USDC — far short
        return {outAmount: out.toString(), otherAmountThreshold: out.toString()};
      },
    });
    expect(sized).toBeNull();
  });

  test('an unquotable candidate (venue refused / minimum too small) is skipped, not a crash', async () => {
    const sized = await sizeAtaFundPlan({
      plan,
      solKnown: '0',
      quote: async () => null,
    });
    expect(sized).toBeNull();
  });

  test('existing SOL counts toward the target: the swap only covers the SHORTFALL', async () => {
    // SOL holds rent − 1 lamport; the swap only has to deliver the last lamport + buffer.
    const shortSol = (SOL_ATA_SETUP_MIN_LAMPORTS - 1n).toString();
    const sized = await sizeAtaFundPlan({
      plan,
      solKnown: shortSol,
      quote: async (_source, inRaw) => {
        const out = BigInt(inRaw) * 16n;
        return {outAmount: out.toString(), otherAmountThreshold: out.toString()};
      },
    });
    expect(sized).not.toBeNull();
    if (sized == null) return;
    // The floor of the sized swap + the SOL already held must reach the target…
    expect(BigInt(sized.outFloor) + BigInt(shortSol)).toBeGreaterThanOrEqual(target);
    // …and the sized input is tiny (it only covers the shortfall + buffer).
    expect(BigInt(sized.inAmount)).toBeLessThan(1_000_000n);
  });
});
