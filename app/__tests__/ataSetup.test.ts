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
import {ataConfirmPlan, planAtaSetup, sizeAtaFundPlan, sizeAtaIcFundPlan, ataPlanAfterFundShort, ataPlanSignature, ataRecordErrLine, sendCefiDepositForRecord, type AtaIcFundSource, type AtaSetupTokenInput} from '../lib/ataSetup';

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

describe('planAtaSetup - the fund-ic branch (no SPL source, IC-side money funds the swap)', () => {
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

  test('QUOTE FITNESS: the abundant-ICP wallet sizes the direct-cefi ICP shape, never the composed VCHF route', async () => {
    // The founder wallet, mock-shaped (2026-10-01 audit F1-F3): registry order puts VCHF FIRST
    // (its route to SOL is composed - ICP->SOL is the direct single-leg cefi pair) - and the
    // fitness pick must still land on ICP: the seam's SOL output is the one comparable unit,
    // and ICP's direct venue-min shape carries the highest floor. The direct ICP leg answers
    // ~0.2735 lamports per raw e8s against a FLOATING venue minimum of 0.91960303 ICP; the
    // two-account target is 2 x 2,044,280 rent + 2 x 5,000 fee = 4,098,560 lamports. NO live
    // exact number appears in a pin - shape only: the candidate, the input EXACTLY at the
    // mock's venue minimum, the floor covering the target.
    const VENUE_MIN = 91_960_303n;
    const vchf = icSource({rawAmount: '262489246'}); // 2.62 VCHF, composed, registry-FIRST
    const icp: AtaIcFundSource = {currencyKey: 'ic:8', symbol: 'ICP', decimals: 8, rawAmount: '1097488672'};
    const plan = planAtaSetup({targets: [absent(), absent({mint: USDC, symbol: 'USDC'})], solBalance: '0', sources: [], icSources: [vchf, icp]});
    if (plan.kind !== 'fund-ic') throw new Error('fixture: expected fund-ic');
    const sized = await sizeAtaIcFundPlan({
      plan,
      solKnown: '0',
      quote: async (source, inRaw) => {
        if (source.symbol === 'ICP') {
          return BigInt(inRaw) < VENUE_MIN
            ? {kind: 'belowMin', minInRaw: VENUE_MIN.toString()}
            : {kind: 'quote', outLamports: ((BigInt(inRaw) * 2735n) / 10000n).toString()};
        }
        // The composed VCHF route: deliverable, but a thin floor at any input.
        return {kind: 'quote', outLamports: ((BigInt(inRaw) * 1660n) / 100000n).toString()};
      },
    });
    expect(sized).not.toBeNull();
    if (sized == null) return;
    expect(sized.source.symbol).toBe('ICP');
    expect(BigInt(sized.inAmount)).toBe(VENUE_MIN);
    expect(BigInt(sized.outFloor)).toBeGreaterThanOrEqual(4_098_560n);
  });

  test('QUOTE FITNESS: at an equal floor the SMALLER input wins; a full tie keeps registry order', async () => {
    // Constant-floor seam: every input answers the same SOL floor (above the target), so each
    // candidate's walk only shrinks its input - the smaller starting balance lands the same
    // floor with a smaller input and must win; identical balances tie into registry order.
    const a = icSource({currencyKey: 'ic:3', symbol: 'A', decimals: 8, rawAmount: '600000000'});
    const b = icSource({currencyKey: 'ic:4', symbol: 'B', decimals: 8, rawAmount: '500000000'});
    const plan = planAtaSetup({targets: [absent()], solBalance: '0', sources: [], icSources: [a, b]});
    if (plan.kind !== 'fund-ic') throw new Error('fixture: expected fund-ic');
    const constantFloor = async () => ({kind: 'quote' as const, outLamports: '5000000'});
    const smaller = await sizeAtaIcFundPlan({plan, solKnown: '0', quote: constantFloor});
    expect(smaller?.source.symbol).toBe('B');
    const tie = planAtaSetup({targets: [absent()], solBalance: '0', sources: [], icSources: [b, icSource({currencyKey: 'ic:3', symbol: 'A', decimals: 8, rawAmount: '500000000'})]});
    if (tie.kind !== 'fund-ic') throw new Error('fixture: expected fund-ic');
    const tied = await sizeAtaIcFundPlan({plan: tie, solKnown: '0', quote: constantFloor});
    expect(tied?.source.symbol).toBe('B'); // identical walks: the registry-first seat holds
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

describe('sizeAtaIcFundPlan - the injected-quote sizing walk over the IC candidates', () => {
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

describe('sizeAtaIcFundPlan - the DIRECT-cefi shape, mocked seam (2026-10-01 live diagnosis)', () => {
  // The founder wallet's winning walk, mock-shaped: ICP direct cefi (~0.2735 lamports per raw
  // e8s unit ≈ 0.02735 SOL/ICP) against a FLOATING venue minimum of 0.91960303 ICP. NO live
  // exact number appears in a pin: the assertions are SHAPE only - the candidate, the input
  // EXACTLY at the mock's venue minimum, and a floor that covers the two-account target
  // (2 x 2,044,280 rent + 2 x 5,000 fee = 4,098,560 lamports).
  const VENUE_MIN = 91_960_303n; // 0.91960303 ICP, this minute's minimum (the pin's own mock)
  const TARGET = 4_098_560n;
  const directIcpPlan = planAtaSetup({
    targets: [absent(), absent({mint: USDC, symbol: 'USDC'})],
    solBalance: '0', sources: [],
    icSources: [{currencyKey: 'ic:8', symbol: 'ICP', decimals: 8, rawAmount: '1097488672'}],
  });
  if (directIcpPlan.kind !== 'fund-ic') throw new Error('fixture: expected fund-ic');
  const quote: NonNullable<Parameters<typeof sizeAtaIcFundPlan>[0]['quote']> = async (_source, inRaw) =>
    BigInt(inRaw) < VENUE_MIN
      ? {kind: 'belowMin', minInRaw: VENUE_MIN.toString()}
      : {kind: 'quote', outLamports: ((BigInt(inRaw) * 2735n) / 10000n).toString()};

  test('walks to the venue minimum, delivers EXACTLY it, floor covering the two-account target', async () => {
    const sized = await sizeAtaIcFundPlan({plan: directIcpPlan, solKnown: '0', quote});
    expect(sized).not.toBeNull();
    if (sized == null) return;
    expect(sized.source.symbol).toBe('ICP');
    expect(BigInt(sized.inAmount)).toBe(VENUE_MIN);
    expect(BigInt(sized.outFloor)).toBeGreaterThanOrEqual(TARGET);
  });

  test('a balance below the venue minimum cannot deliver - null falls through to refuse', async () => {
    const plan = planAtaSetup({
      targets: [absent()], solBalance: '0', sources: [],
      icSources: [{currencyKey: 'ic:8', symbol: 'ICP', decimals: 8, rawAmount: (VENUE_MIN - 1n).toString()}],
    });
    if (plan.kind !== 'fund-ic') throw new Error('fixture: expected fund-ic');
    const sized = await sizeAtaIcFundPlan({plan, solKnown: '0', quote});
    expect(sized).toBeNull();
  });

  test('SOL already held never pulls the input below the venue minimum (the minimum is a floor on the input)', async () => {
    // SOL already held lowers the shortfall, but the venue minimum is a FLOOR on the input,
    // not on the output: even one lamport short of the target, the input stays at the min.
    const oneAccountTarget = BigInt(SOL_ATA_SETUP_MIN_LAMPORTS) + 2n * SOL_FEE_LAMPORTS;
    const plan = planAtaSetup({
      targets: [absent()], solBalance: '0', sources: [],
      icSources: [{currencyKey: 'ic:8', symbol: 'ICP', decimals: 8, rawAmount: '1097488672'}],
    });
    if (plan.kind !== 'fund-ic') throw new Error('fixture: expected fund-ic');
    const sized = await sizeAtaIcFundPlan({plan, solKnown: (oneAccountTarget - 1n).toString(), quote});
    expect(sized).not.toBeNull();
    if (sized == null) return;
    expect(BigInt(sized.inAmount)).toBe(VENUE_MIN);
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

  test('QUOTE FITNESS: every deliverable candidate is sized; the higher floor wins over registry order', async () => {
    // Registry order puts X FIRST; USDC's constant floor is higher, so fitness must displace
    // the positional pick (2026-10-01 audit F1-F2, the computeAutoPick canon).
    const planXFirst = planAtaSetup({
      targets: [absent()], solBalance: '0',
      sources: [
        funded({symbol: 'X', amount: '10000000'}),
        funded(),
      ],
    });
    if (planXFirst.kind !== 'fund') throw new Error('fixture: expected fund');
    const sized = await sizeAtaFundPlan({
      plan: planXFirst,
      solKnown: '0',
      quote: async source => ({
        outAmount: '5000000',
        otherAmountThreshold: source.symbol === 'X' ? '4500000' : '5000000',
      }),
    });
    expect(sized?.source.symbol).toBe('USDC');
  });
});

describe('ataPlanAfterFundShort - the proven-unfundable flip to the refuse panel', () => {
  // The live run proved no IC candidate can reach the target (sizing null, or the run-time
  // floor check). The banner must trade the doomed retry button for the refuse panel — the
  // honest dead end that carries the SOL receive address with its copy affordance.
  test('a fund-ic plan flips to refuse', () => {
    const plan = planAtaSetup({targets: [absent()], solBalance: '0', sources: [], icSources: [icSource()]});
    if (plan.kind !== 'fund-ic') throw new Error('fixture: expected fund-ic');
    expect(ataPlanAfterFundShort(plan)).toEqual({kind: 'refuse'});
  });

  test('create, fund, none and refuse pass through unchanged (only fund-ic flips)', () => {
    const create = planAtaSetup({targets: [absent()], solBalance: SOL_ATA_SETUP_MIN_LAMPORTS.toString(), sources: [], icSources: [icSource()]});
    expect(ataPlanAfterFundShort(create)).toEqual(create);
    const fund = planAtaSetup({targets: [absent()], solBalance: '0', sources: [funded()], icSources: [icSource()]});
    if (fund.kind !== 'fund') throw new Error('fixture: expected fund');
    expect(ataPlanAfterFundShort(fund)).toEqual(fund);
    expect(ataPlanAfterFundShort({kind: 'none'})).toEqual({kind: 'none'});
    expect(ataPlanAfterFundShort({kind: 'refuse'})).toEqual({kind: 'refuse'});
  });
});

describe('ataRecordErrLine - the real cause reaches the card, ONE line (2026-10-01)', () => {
  test('the failureDetail IS the line - the venue words, never a paraphrase', () => {
    expect(ataRecordErrLine({step: 'failed_refunded', failureDetail: 'deposit amount below venue minimum'}))
      .toBe('deposit amount below venue minimum');
    expect(ataRecordErrLine({step: 'failed_leg', failureDetail: '  rate moved  '})).toBe('rate moved');
  });

  test('no detail: a stuck record maps to the unknown-outcome copy, never a fake retry promise', () => {
    expect(ataRecordErrLine({step: 'stuck'})).not.toContain('try again');
  });

  test('no detail, any other terminal step: the honest swap-failed fallback', () => {
    expect(ataRecordErrLine({step: 'failed_refunded'})).toContain('did not go through');
  });
});

describe('ataConfirmPlan - the confirm-time re-verify verdict (2026-10-02 trip fix)', () => {
  // The live-trip defect: the confirm-time fresh re-quote threw fundShort naming a symbol the
  // user never confirmed (ICP while VCHF was confirmed) and the card silently fell back to the
  // un-probed idle. The verdict is now a PURE decision over the confirmed candidate's fresh
  // route answers: sign the best covering route, RE-CONFIRM on a floated minimum the balance
  // still covers, refuse honestly otherwise - never a throw naming a foreign symbol.
  const target = '4098560';

  test('a covering route signs: the highest settle wins, registry order breaks ties', () => {
    const v = ataConfirmPlan({answers: [{kind: 'quoted', settleRaw: '681770'}, {kind: 'quoted', settleRaw: '4303480'}], targetLamports: target, solKnown: '0', balanceRaw: '300000000'});
    expect(v).toEqual({kind: 'sign', routeIndex: 1});
    const tied = ataConfirmPlan({answers: [{kind: 'quoted', settleRaw: '4303480'}, {kind: 'quoted', settleRaw: '4303480'}], targetLamports: target, solKnown: '0', balanceRaw: '300000000'});
    expect(tied).toEqual({kind: 'sign', routeIndex: 0});
  });

  test('the best settle below the target refuses (cannot-cover) - never signs a doomed order', () => {
    const v = ataConfirmPlan({answers: [{kind: 'quoted', settleRaw: '4098559'}], targetLamports: target, solKnown: '0', balanceRaw: '300000000'});
    expect(v).toEqual({kind: 'refuse', reason: 'cannot-cover'});
  });

  test('SOL already held counts toward the cover check', () => {
    const v = ataConfirmPlan({answers: [{kind: 'quoted', settleRaw: '1'}], targetLamports: target, solKnown: (Number(target) - 1).toString(), balanceRaw: '300000000'});
    expect(v).toEqual({kind: 'sign', routeIndex: 0});
  });

  test('every route refused below-minimum and the balance covers the fresh minimum: RE-CONFIRM', () => {
    const v = ataConfirmPlan({answers: [{kind: 'belowMin', minInRaw: '270000000'}, {kind: 'belowMin', minInRaw: '262487136'}], targetLamports: target, solKnown: '0', balanceRaw: '300000000'});
    expect(v).toEqual({kind: 'reconfirm', minInRaw: '262487136'}); // the MOST PERMISSIVE minimum
  });

  test('every route refused below-minimum and the balance cannot reach it: refuse (below-min)', () => {
    const v = ataConfirmPlan({answers: [{kind: 'belowMin', minInRaw: '92000000'}], targetLamports: target, solKnown: '0', balanceRaw: '100000'});
    expect(v).toEqual({kind: 'refuse', reason: 'below-min'});
  });

  test('all routes dead: refuse (no-route) - nothing was quoted, nothing signs', () => {
    const v = ataConfirmPlan({answers: [{kind: 'dead'}, {kind: 'dead'}], targetLamports: target, solKnown: '0', balanceRaw: '300000000'});
    expect(v).toEqual({kind: 'refuse', reason: 'no-route'});
  });

  test('a quoting route outranks refusals: one live answer is enough to sign', () => {
    const v = ataConfirmPlan({answers: [{kind: 'belowMin', minInRaw: '270000000'}, {kind: 'quoted', settleRaw: '4303480'}], targetLamports: target, solKnown: '0', balanceRaw: '300000000'});
    expect(v).toEqual({kind: 'sign', routeIndex: 1});
  });
});

describe('ataPlanSignature - the latch key that survives poll churn', () => {
  // The refuse verdict must live across re-renders. The model is a useMemo over POLLED data
  // (assets / tokenStates / assetBalances): its object identity churns on every real balance
  // write even when nothing about the plan moved - the live device run cleared the refuse
  // panel that way (banner back to idle, button silently re-armed). The reset latch must
  // therefore key on a VALUE signature: equal-value models are equal, only a plan whose
  // semantics genuinely moved may re-arm the question.
  const fundIcModel = (rawAmount: string) => {
    const plan = planAtaSetup({targets: [absent()], solBalance: '0', sources: [], icSources: [icSource({rawAmount})]});
    if (plan.kind !== 'fund-ic') throw new Error('fixture: expected fund-ic');
    return {plan, targets: ['EURC'], costLine: '0.00408856 SOL'};
  };

  test('equal-value twins built separately carry the SAME signature (poll churn cannot re-arm)', () => {
    expect(ataPlanSignature(fundIcModel('450000000'))).toBe(ataPlanSignature(fundIcModel('450000000')));
  });

  test('a candidate balance change is a new answer - the signature moves', () => {
    expect(ataPlanSignature(fundIcModel('450000000'))).not.toBe(ataPlanSignature(fundIcModel('450000001')));
  });

  test('a kind change moves the signature', () => {
    const fundIc = fundIcModel('450000000');
    const create = planAtaSetup({targets: [absent()], solBalance: SOL_ATA_SETUP_MIN_LAMPORTS.toString(), sources: [], icSources: [icSource()]});
    expect(ataPlanSignature(fundIc)).not.toBe(ataPlanSignature({plan: create, targets: ['EURC'], costLine: '0.00408856 SOL'}));
  });

  test('a targets change moves the signature', () => {
    const a = fundIcModel('450000000');
    const b = fundIcModel('450000000');
    expect(ataPlanSignature({...a, targets: ['EURC', 'USDC']})).not.toBe(ataPlanSignature(b));
  });
});

describe('sendCefiDepositForRecord - the fund-ic deposit the venue order needs (2026-10-02 live-trip fix)', () => {
  const catalog = {currencies: [{currency: 8, ledger: 'ryjl3-tyaaa-aaaaa-aaaba-cai', fee: '10000'}]};
  const prepared = {ledger: 'ryjl3-tyaaa-aaaaa-aaaba-cai', envelopeHex: 'ee', requestIdHex: 'aa'};
  const rec = {
    inCurrency: 8,
    amountIn: '0.89848158',
    providerDeposit: {depositAddress: '2vxsx-fae', depositMemo: 'm-42'},
  };
  const baseDeps = (over: Partial<Parameters<typeof sendCefiDepositForRecord>[1]> = {}): Parameters<typeof sendCefiDepositForRecord>[1] =>
    // `over` may override a now-required seam with undefined (the ICRC-1 pin), so the
    // spread needs the explicit cast to the deps shape.
    ({
    catalog,
    secretHex: 'ab',
    prepareTransfer: async (_s, _c, req) => {
      expect(req.toAccount).toBe('2vxsx-fae');
      expect(req.amount).toBe('0.89848158');
      expect(req.currency).toBe(8);
      expect(req.nonceHex).toBe(Buffer.from('m-42', 'utf8').toString('hex'));
      return prepared;
    },
    submitTransfer: async () => ({kind: 'settled' as const, blockIndex: '4242'}),
    decodeLegacyReply: async () => ({ok: true, blockIndex: '4242'}),
    ...over,
  }) as Parameters<typeof sendCefiDepositForRecord>[1];

  test('sends the exact deposit with the venue memo and reports the block', async () => {
    await expect(sendCefiDepositForRecord(rec, baseDeps())).resolves.toEqual({kind: 'sent', blockIndex: '4242'});
  });

  test('a record with no IC-side input is not-applicable (SOL-source, other-rail)', async () => {
    const deps = baseDeps({prepareTransfer: () => { throw new Error('must not prepare'); }});
    await expect(sendCefiDepositForRecord({...rec, inCurrency: null}, deps)).resolves.toEqual({kind: 'not-applicable'});
    await expect(sendCefiDepositForRecord({...rec, providerDeposit: {depositAddress: ''}}, baseDeps())).resolves.toEqual({kind: 'not-applicable'});
  });

  test('an unknown submit leaves the record standing (venue is the source of truth, no resubmit)', async () => {
    const deps = baseDeps({submitTransfer: async () => ({kind: 'unknown' as const})});
    await expect(sendCefiDepositForRecord(rec, deps)).resolves.toEqual({kind: 'unknown'});
  });

  test('a rejected transfer throws the venue reason tagged for the card', async () => {
    const deps = baseDeps({submitTransfer: async () => ({kind: 'rejected' as const, reason: 'insufficient balance'})});
    await expect(sendCefiDepositForRecord(rec, deps)).rejects.toMatchObject({ataDepositRefused: 'insufficient balance', message: 'insufficient balance'});
  });

  test('a missing memo sends an empty nonce (the no-memo case, never a dropped one)', async () => {
    let seen = '';
    const deps = baseDeps({prepareTransfer: async (_s, _c, req) => {
      seen = req.nonceHex;
      return prepared;
    }});
    await sendCefiDepositForRecord({...rec, providerDeposit: {depositAddress: '2vxsx-fae'}}, deps);
    expect(seen).toBe('');
  });

  test('a 64-hex venue deposit rides the LEGACY ICP transfer (exact amount, catalog fee, empty memo)', async () => {
    let seen: unknown = null;
    let seenDecoder: unknown = 'not-called';
    const deps = baseDeps({
      prepareTransfer: () => { throw new Error('must not take the ICRC-1 path'); },
      prepareLegacyTransfer: async (_s, req) => { seen = req; return prepared; },
      submitTransfer: async (_p, _s, _o, decodeReply) => { seenDecoder = decodeReply; return {kind: 'settled' as const, blockIndex: '4242'}; },
    });
    const out = await sendCefiDepositForRecord(
      {...rec, providerDeposit: {depositAddress: 'a4ef38803ebbab5595d1afb8a7a136f8b75167d5693579df60651f96829f4ac9'}},
      deps,
    );
    expect(out).toEqual({kind: 'sent', blockIndex: '4242'});
    expect(seen).toEqual({
      ledger: 'ryjl3-tyaaa-aaaaa-aaaba-cai',
      toAccountId: 'a4ef38803ebbab5595d1afb8a7a136f8b75167d5693579df60651f96829f4ac9',
      amountE8s: '0.89848158',
      feeE8s: '10000',
    });
    // The legacy reply MUST decode through the legacy tag set - the ICRC-1 default decoder
    // throws 'DIDL decode error: trailing bytes after value' on it (live 2026-10-02: the
    // transfer LANDED, the decode threw, the run aborted with a scary red line).
    expect(seenDecoder).toBe(deps.decodeLegacyReply);
  });

  test('the ICRC-1 path keeps the default reply decoder', async () => {
    let seenDecoder: unknown = 'not-called';
    const deps = baseDeps({
      submitTransfer: async (_p, _s, _o, decodeReply) => { seenDecoder = decodeReply; return {kind: 'settled' as const, blockIndex: '4242'}; },
    });
    await sendCefiDepositForRecord(rec, deps);
    expect(seenDecoder).toBeUndefined();
  });

  test('a legacy deposit carrying a venue memo is refused honestly (the legacy ledger cannot carry it)', async () => {
    const deps = baseDeps({prepareLegacyTransfer: () => { throw new Error('must not prepare'); }});
    await expect(sendCefiDepositForRecord(
      {...rec, providerDeposit: {depositAddress: 'a4ef38803ebbab5595d1afb8a7a136f8b75167d5693579df60651f96829f4ac9', depositMemo: 'm-42'}},
      deps,
    )).rejects.toMatchObject({ataDepositRefused: expect.any(String)});
  });

  test('a 64-hex deposit on a ledger that is not the ICP mainnet ledger is refused (legacy is ICP-mainnet-only)', async () => {
    const deps = baseDeps({
      catalog: {currencies: [{currency: 8, ledger: 'some-other-ledger-canister', fee: '10000'}]},
      prepareLegacyTransfer: () => { throw new Error('must not prepare'); },
    });
    await expect(sendCefiDepositForRecord(
      {...rec, providerDeposit: {depositAddress: 'a4ef38803ebbab5595d1afb8a7a136f8b75167d5693579df60651f96829f4ac9'}},
      deps,
    )).rejects.toMatchObject({ataDepositRefused: expect.any(String)});
  });
});
