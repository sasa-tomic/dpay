import AsyncStorage from '@react-native-async-storage/async-storage';
import {DpayCore} from '../services/native';
import {
  CONVERT_LEGACY_STORAGE_KEY,
  CONVERT_PRIOR_SCOPED_STORAGE_PREFIX,
  CONVERT_UNSCOPED_STORAGE_KEY,
  convertStoreKey,
} from '../config/convert';
import {icAmmVenueForPair, venueEndpointOf, venueOfId} from '../config/venues';
import {
  CHAIN_CONVERT_STEPS,
  COMPOSED_CONVERT_STEPS,
  CONVERT_STEPS,
  CROSSRAIL_CONVERT_STEPS,
  PROVIDER_CONVERT_STEPS,
  PROVIDER_ONLY_STEPS,
  EVM_CONVERT_STEPS,
  SOLANA_CONVERT_STEPS,
  type ChainRouteInfo,
  type ComposedDepositInfo,
  type ConvertRecord,
  type ConvertStep,
  type CrossRailInfo,
  type EvmSwapLeg,
  type GasFundPreLeg,
  type LegKind,
  type LegPlan,
  type LegState,
  type SignedLeg,
  type SolanaSwapLeg,
} from './types';
import {BUNDLED_MAINNET_VENUE_ID} from './quotes';
/** The min-out a record's swap leg signed, re-derived from the record's OWN frozen quote and
 *  slippage through the compiled core — deterministic, so this is the same figure
 *  `prepareConvertRecord` baked into the arg, not a new opinion. The hub widening (2026-09-18,
 *  spec §11) adds the leg discriminator: ONE derivation rule PER swap leg — leg 2's floor is
 *  its OWN frozen gross (`expectedGross2`, quoted on leg 1's min-out) × (1−slippage), floors
 *  only, never an expected gross. A hub record always carries expectedGross2 (hydration
 *  refuses otherwise); anything else is a caller bug and throws fail-closed. */
export async function convertRecordMinOut(record: ConvertRecord, swapLeg: 1 | 2 = 1): Promise<string> {
  const gross = swapLeg === 2 ? record.expectedGross2 : record.expectedGross;
  if (gross == null) throw new Error('record carries no quote for that swap leg');
  return DpayCore.icpSwapMinOut(gross, record.slippageBps);
}

/** Do two decimal STRINGS name the same number? Pure string normalization — never float math
 *  on money. Shapes outside `/^\d*\.?\d+$/` (a venue echoing garbage) never compare equal
 *  unless the raw strings do — fail-closed. The prepare guard uses this so a venue that
 *  reformats ITS OWN echo of the quoted deposit ('1' vs '1.00000000') still adopts the order:
 *  refusing it after the venue already 201'd would orphan a real order and leave the record
 *  unadopted (the live attempt-#3 non-adoption class). A DIFFERENT amount still refuses. */
export function sameDecimalAmount(a: string, b: string): boolean {
  if (a === b) return true;
  const norm = (s: string): string | null => {
    const m = /^\d*\.?\d+$/.exec(s.trim());
    if (m == null) return null;
    const [intRaw, fracRaw = ''] = s.trim().split('.');
    const int = (intRaw.replace(/^0+(?=\d)/, '') || '0');
    const frac = fracRaw.replace(/0+$/, '');
    return frac.length > 0 ? `${int}.${frac}` : int;
  };
  const na = norm(a);
  const nb = norm(b);
  return na != null && nb != null && na === nb;
}

/** Migrate a pre-legs (v1 store) record to the legs schema: the two old envelope pairs become
 *  two SignedLegs against the venue the record's pair resolves to. The founder's device holds
 *  REAL v1 records — they must survive this, byte-frozen, never rebuilt. */
function migrateLegacyRecord(r: Record<string, unknown>, out: Record<string, ConvertRecord>, id: string): ConvertRecord | null {
  const str = (k: string) => (typeof r[k] === 'string' ? r[k] as string : null);
  const inLedger = str('inLedger');
  const outLedger = str('outLedger');
  if (!inLedger || !outLedger) return null;
  // v1 records were all ICPSwap trades — resolve the venue from the record's OWN pair, with
  // the bundled registry's mainnet IC-AMM id as the honest fallback if the registry no longer
  // lists it (derived the same way ConvertMode derives REGISTERED_VENUE_ID — the literal
  // 'icpswap' this line used to carry was the one hardcoded venue id outside the registry).
  const venueId = icAmmVenueForPair(inLedger, outLedger)?.venue_id ?? BUNDLED_MAINNET_VENUE_ID;
  const expiresAtMs = typeof r.approveExpiresAtMs === 'number' ? r.approveExpiresAtMs : 0;
  const legs: SignedLeg[] = [
    {
      canister: inLedger,
      method: 'icrc2_approve',
      argHex: '',
      envelopeHex: str('approveEnvelopeHex') ?? '',
      requestIdHex: str('approveRequestIdHex') ?? '',
      expiresAtMs,
    },
    {
      canister: venueEndpointOf(venueId),
      method: 'depositFromAndSwap',
      argHex: '',
      envelopeHex: str('swapEnvelopeHex') ?? '',
      requestIdHex: str('swapRequestIdHex') ?? '',
      expiresAtMs,
    },
  ];
  const rec: Record<string, unknown> = {...r};
  delete rec.approveEnvelopeHex;
  delete rec.approveRequestIdHex;
  delete rec.approveExpiresAtMs;
  delete rec.swapEnvelopeHex;
  delete rec.swapRequestIdHex;
  delete rec.amountOutMin;
  delete rec.zeroForOne;
  rec.venueId = venueId;
  rec.legs = legs;
  return hydrateOneRecord(rec, out, id);
}

/** Validate ONE already-current-shape record (pure). */
function hydrateOneRecord(r: Record<string, unknown>, out: Record<string, ConvertRecord>, id: string): ConvertRecord | null {
  const str = (k: string) => (typeof r[k] === 'string' ? r[k] as string : null);
  const rec: Partial<ConvertRecord> = {
    id: str('id') ?? undefined,
    venueId: str('venueId') ?? undefined,
    inSymbol: str('inSymbol') ?? undefined,
    outSymbol: str('outSymbol') ?? undefined,
    inLedger: str('inLedger') ?? undefined,
    outLedger: str('outLedger') ?? undefined,
    amountIn: str('amountIn') ?? undefined,
    expectedGross: str('expectedGross') ?? undefined,
    expectedNet: str('expectedNet') ?? undefined,
    inFee: str('inFee') ?? undefined,
    outFee: str('outFee') ?? undefined,
    // The payout destination facts (planned records set them via the plan; the CEFI record
    // sets them directly — the venue pays out to the user's own settle address).
    destAddress: str('destAddress') ?? undefined,
    destSymbol: str('destSymbol') ?? undefined,
    outAmountNet: str('outAmountNet') ?? undefined,
    outTx: str('outTx') ?? undefined,
    refundTx: str('refundTx') ?? undefined,
    failureDetail: str('failureDetail') ?? undefined,
  };
  if (typeof r.createdAtMs !== 'number') return null;
  rec.createdAtMs = r.createdAtMs;
  // IC records carry numeric catalog currency ids; a Solana-shaped record has none to carry
  // (the Solana rail keys assets by mint + symbol). Parsed when present, REQUIRED below for
  // the IC shapes — the discriminator is `solanaLeg`, parsed after the legs. The CEFI
  // widening (2026-09-15): the two parse INDEPENDENTLY — a cefi provider record legitimately
  // carries the IC deposit side's id and NO out id (SOL is not an IC catalog currency; the
  // provider driver advances it by statusUrl alone). Every non-cefi shape still needs BOTH,
  // enforced where the requirement has always lived (the gate below), so this changes no
  // verdict except the cefi half-pair's survival.
  if (r.inCurrency != null) {
    if (typeof r.inCurrency !== 'number') return null;
    rec.inCurrency = r.inCurrency;
  }
  if (r.outCurrency != null) {
    if (typeof r.outCurrency !== 'number') return null;
    rec.outCurrency = r.outCurrency;
  }
  if (typeof r.slippageBps !== 'number') return null;
  rec.slippageBps = r.slippageBps;
  if (!CONVERT_STEPS.includes(r.step as ConvertStep)) return null;
  rec.step = r.step as ConvertStep;
  if (typeof r.acknowledgedStuckAtMs === 'number') rec.acknowledgedStuckAtMs = r.acknowledgedStuckAtMs;
  // The cefi-deposit handoff marker (2026-10-02 P0): parsed so the once-only deposit gate
  // survives a restart. Absent on every record this build wrote before it — byte-identical.
  if (typeof r.depositSentAtMs === 'number') rec.depositSentAtMs = r.depositSentAtMs;
  // The setup-ownership link (2026-10-02 P0): optional, but when present it must be a real
  // mint list — a corrupt one is a shape this build never wrote (fail closed, like every
  // other field the setup card renders from).
  if (r.ataTargetMints != null) {
    if (!Array.isArray(r.ataTargetMints)
      || (r.ataTargetMints as unknown[]).some(m => typeof m !== 'string' || (m as string).length === 0)) return null;
    rec.ataTargetMints = r.ataTargetMints as string[];
  }
  // The COMPOSED IC→CeFi block (2026-09-26, brief §5.4 item 2): parsed BEFORE the plan so
  // the plan-shape checks below can key on it. Every venue-issued string must be present
  // and well-formed — a half-written deposit block on a record the engine signs against is
  // refused like any other corrupt money field (per-record salvage drops it, never the
  // store). Durable facts only: the order's ids, the venue's verbatim address + amounts,
  // the fee, the windows, and the sent evidence as it arrives.
  let composedDeposit: ComposedDepositInfo | undefined;
  if (r.composedDeposit != null) {
    const c = r.composedDeposit as Record<string, unknown>;
    if (!c || typeof c !== 'object') return null;
    const cs = (k: string): string | null =>
      (typeof c[k] === 'string' && (c[k] as string).length > 0 ? c[k] as string : null);
    const digits = (k: string): string | null => {
      const v = cs(k);
      return v != null && /^\d+$/.test(v) ? v : null;
    };
    const venueId = cs('venueId');
    const orderId = cs('orderId');
    const depositAddress = cs('depositAddress');
    const depositOwner = cs('depositOwner');
    const amountDecimal = cs('amountDecimal');
    const amountRaw = digits('amountRaw');
    const fee = digits('fee');
    const settleSymbol = cs('settleSymbol');
    const settleDecimals =
      typeof c.settleDecimals === 'number' && Number.isSafeInteger(c.settleDecimals) && c.settleDecimals >= 0
        ? c.settleDecimals
        : null;
    if (venueId == null || orderId == null || depositAddress == null || depositOwner == null
      || amountDecimal == null || amountRaw == null || fee == null
      || settleSymbol == null || settleDecimals == null) return null;
    const expiresAtMs =
      typeof c.expiresAtMs === 'number' && Number.isSafeInteger(c.expiresAtMs) && c.expiresAtMs > 0
        ? c.expiresAtMs
        : null;
    composedDeposit = {
      venueId,
      orderId,
      depositAddress,
      depositOwner,
      amountDecimal,
      amountRaw,
      fee,
      settleSymbol,
      settleDecimals,
      ...(cs('depositMemo') != null ? {depositMemo: cs('depositMemo') as string} : {}),
      ...(cs('settleAmountDecimal') != null ? {settleAmountDecimal: cs('settleAmountDecimal') as string} : {}),
      ...(cs('settleAmountRaw') != null ? {settleAmountRaw: cs('settleAmountRaw') as string} : {}),
      ...(expiresAtMs != null ? {expiresAtMs} : {}),
      ...(cs('sentTx') != null ? {sentTx: cs('sentTx') as string} : {}),
    };
    rec.composedDeposit = composedDeposit;
  }
  if (typeof r.abortedAtMs === 'number') rec.abortedAtMs = r.abortedAtMs;
  if (typeof r.abortedFromStep === 'string' && (CONVERT_STEPS as string[]).includes(r.abortedFromStep)) {
    rec.abortedFromStep = r.abortedFromStep as ConvertStep;
  }
  if (typeof r.inDecimals === 'number') rec.inDecimals = r.inDecimals;
  if (typeof r.outDecimals === 'number') rec.outDecimals = r.outDecimals;
  if (r.failureCode != null && !['approve_refused', 'swap_refused', 'refunded', 'withdraw_refused', 'unknown', 'external_declined', 'gas_short'].includes(r.failureCode as string)) return null;
  if (r.failureCode != null) rec.failureCode = r.failureCode as ConvertRecord['failureCode'];
  // The legs: every signed update must be complete. An EMPTY legs list is the CeFi shape and
  // requires a providerRef with an orderId — a legless, providerless record is meaningless.
  if (!Array.isArray(r.legs)) return null;
  const legs: SignedLeg[] = [];
  for (const l of r.legs) {
    if (!l || typeof l !== 'object') return null;
    const leg = l as Record<string, unknown>;
    const canister = typeof leg.canister === 'string' ? leg.canister : null;
    const method = typeof leg.method === 'string' ? leg.method : null;
    const argHex = typeof leg.argHex === 'string' ? leg.argHex : null;
    const envelopeHex = typeof leg.envelopeHex === 'string' ? leg.envelopeHex : null;
    const requestIdHex = typeof leg.requestIdHex === 'string' ? leg.requestIdHex : null;
    const expiresAtMs = typeof leg.expiresAtMs === 'number' ? leg.expiresAtMs : null;
    if (!canister || !method || argHex == null || !envelopeHex || !requestIdHex || expiresAtMs == null) return null;
    legs.push({canister, method, argHex, envelopeHex, requestIdHex, expiresAtMs});
  }
  rec.legs = legs;
  // The CROSS-RAIL block (2026-09-16, Routes B/C): present iff the route composed a CCTP
  // leg. Parsed before the plan so the plan/legs parallelism check can key on its shape.
  // Durable facts only — kind, the two frozen addresses, and the observed tx hashes /
  // verified credit as they arrive. A record carrying it must live in the cross-rail
  // vocabulary (the IC phases + the three cross-rail phases + the shared terminals), or
  // the resume engine would arm a poll no driver can advance — the same rule every other
  // widening applies.
  let crossRail: CrossRailInfo | undefined;
  if (r.crossRail != null) {
    const c = r.crossRail as Record<string, unknown>;
    if (!c || typeof c !== 'object') return null;
    if (c.kind !== 'cctp' && c.kind !== 'cctp_sol') return null;
    if (typeof c.solAddress !== 'string' || c.solAddress.length === 0) return null;
    if (typeof c.mintRecipientAta !== 'string' || c.mintRecipientAta.length === 0) return null;
    const optStr = (k: string): string | undefined =>
      (typeof c[k] === 'string' && (c[k] as string).length > 0 ? c[k] as string : undefined);
    if (!CROSSRAIL_CONVERT_STEPS.has(rec.step)) return null;
    // The SPL-out widening (2026-09-19): the out mint + its decimals travel TOGETHER,
    // the frozen subunit floor requires both, and the two floor shapes — native lamports
    // vs SPL subunits of the out mint — are mutually exclusive. Any other pairing is a
    // shape this build never wrote (fail closed); every field stays optional, so legacy
    // native-SOL records hydrate byte-identically.
    const solExpectedLamports = optStr('solExpectedLamports');
    const solOutMint = optStr('solOutMint');
    const solOutDecimals =
      typeof c.solOutDecimals === 'number' && Number.isSafeInteger(c.solOutDecimals) && c.solOutDecimals >= 0
        ? c.solOutDecimals
        : undefined;
    const solExpectedSubunits = optStr('solExpectedSubunits');
    if ((solOutMint != null) !== (solOutDecimals != null)) return null;
    if (solExpectedSubunits != null && (solOutMint == null || solExpectedLamports != null)) return null;
    if (solOutMint != null && solExpectedLamports != null) return null;
    crossRail = {
      kind: c.kind,
      solAddress: c.solAddress,
      mintRecipientAta: c.mintRecipientAta,
      maxFeeSubunits: optStr('maxFeeSubunits'),
      mintFloorSubunits: optStr('mintFloorSubunits'),
      burnTxHash: optStr('burnTxHash'),
      forwardTxHash: optStr('forwardTxHash'),
      mintSubunits: optStr('mintSubunits'),
      solVenueId: optStr('solVenueId'),
      solExpectedLamports,
      ...(solOutMint != null && solOutDecimals != null ? {solOutMint, solOutDecimals} : {}),
      ...(solExpectedSubunits != null ? {solExpectedSubunits} : {}),
    };
    rec.crossRail = crossRail;
  }
  // The IC-AMM shape the executor drives is exactly TWO legs — the icrc2_approve on the input
  // ledger, then the venue's depositFromAndSwap. A record with legs but fewer than two cannot be
  // resumed by any driver this build ships, so it fails hydration rather than crash mid-retry.
  // THE MULTI-HOP WIDENING (2026-09-14 spec §3, the line the old comment promised would widen):
  // a PLANNED record carries `legPlan`, a parallel array — one entry per leg, same length,
  // ≥2 — and is driven leg-by-leg by the planned executor. The direct 2-leg shape (legPlan
  // absent) is untouched: same bytes, same behavior, same hydration verdicts as always.
  let legPlan: LegPlan[] | undefined;
  if (r.legPlan != null) {
    if (!Array.isArray(r.legPlan)) return null;
    const kinds: LegKind[] = ['approve', 'swap', 'approve_gas', 'withdraw_erc20', 'cctp_burn', 'sol_swap', 'deposit_transfer'];
    const states: LegState[] = ['pending', 'sent', 'confirmed', 'failed'];
    const parsed: LegPlan[] = [];
    for (const p of r.legPlan) {
      if (!p || typeof p !== 'object') return null;
      const q = p as Record<string, unknown>;
      if (typeof q.kind !== 'string' || !kinds.includes(q.kind as LegKind)) return null;
      if (typeof q.state !== 'string' || !states.includes(q.state as LegState)) return null;
      // The IC kinds target an IC canister (non-empty). The cross-rail kinds call NO IC
      // canister — the external-signature leg's "target" is the user's own wallet — so
      // their canister is '' by construction; anything else is a shape this build never
      // wrote.
      const externalKind = q.kind === 'cctp_burn' || q.kind === 'sol_swap';
      if (externalKind ? q.canister !== '' : (typeof q.canister !== 'string' || !q.canister)) return null;
      if (typeof q.fee !== 'string') return null;
      parsed.push({kind: q.kind as LegKind, state: q.state as LegState, canister: q.canister as string, fee: q.fee});
    }
    // The cross-rail block is parsed ABOVE so the plan/legs parallelism can key on
    // its shape: an IC-only plan is exactly parallel to `legs` (same length, ≥2); a
    // cross-rail plan extends it by one cctp_burn entry and (Route C) one sol_swap entry,
    // in that order, after the withdraw_erc20. Any other length pairing is corrupt.
    if (crossRail != null) {
      const expected = legs.length + 1 + (crossRail.kind === 'cctp_sol' ? 1 : 0);
      if (parsed.length !== expected || parsed.length < 3) return null;
      const tail = parsed.slice(legs.length).map(p => p.kind);
      if (tail[0] !== 'cctp_burn') return null;
      if (crossRail.kind === 'cctp_sol' && tail[1] !== 'sol_swap') return null;
    } else if (parsed.length !== legs.length || parsed.length < 2) return null;
    // The HUB shape (2026-09-18, spec §11): exactly four IC legs in the approve/swap/approve/
    // swap order. Its destination is the user's own principal on the dest IC ledger —
    // `destAddress` is NOT part of this shape — but every number its executor, watch, and
    // min-out re-derivation need must be frozen on the record. A swap2 the record cannot
    // watch or re-price is corrupt: refuse the quadrant, never improvise a number.
    const isHubPlan = legs.length === 4
      && parsed[0].kind === 'approve' && parsed[1].kind === 'swap'
      && parsed[2].kind === 'approve' && parsed[3].kind === 'swap';
    // A planned record must be able to name its destination and its hop asset — every state
    // screen it can ever render keys off those facts (spec §4: name what the user holds,
    // where the exit is). A plan that cannot be NAMED fails hydration, like every other
    // shape that would render a nameless screen.
    const hopStr = (k: 'destAddress' | 'destSymbol' | 'destNetwork' | 'hopLedger' | 'hopSymbol' | 'destLedger' | 'venue2Id' | 'expectedGross2' | 'expectedNet2' | 'destFee'): string | null =>
      typeof r[k] === 'string' && (r[k] as string).length > 0 ? r[k] as string : null;
    if (hopStr('destSymbol') == null || hopStr('destNetwork') == null
      || hopStr('hopLedger') == null || hopStr('hopSymbol') == null) return null;
    if (typeof r.hopCurrency !== 'number' || typeof r.hopDecimals !== 'number') return null;
    if (isHubPlan) {
      if (hopStr('destLedger') == null || hopStr('venue2Id') == null
        || hopStr('expectedGross2') == null || hopStr('expectedNet2') == null
        || hopStr('destFee') == null) return null;
      const destCurrency = r.destCurrency;
      const destDecimals = r.destDecimals;
      const feeMillionths2 = r.feeMillionths2;
      if (typeof destCurrency !== 'number' || typeof destDecimals !== 'number'
        || typeof feeMillionths2 !== 'number') return null;
      if (r.destTx != null && (typeof r.destTx !== 'string' || (r.destTx as string).length === 0)) return null;
    } else if (hopStr('destAddress') == null) return null;
    legPlan = parsed;
    rec.legPlan = legPlan;
    if (isHubPlan) {
      rec.destLedger = hopStr('destLedger') ?? undefined;
      rec.destCurrency = r.destCurrency as number;
      rec.destDecimals = r.destDecimals as number;
      rec.destFee = hopStr('destFee') ?? undefined;
      rec.venue2Id = hopStr('venue2Id') ?? undefined;
      rec.expectedGross2 = hopStr('expectedGross2') ?? undefined;
      rec.expectedNet2 = hopStr('expectedNet2') ?? undefined;
      rec.feeMillionths2 = r.feeMillionths2 as number;
      if (r.destTx != null) rec.destTx = r.destTx as string;
    } else {
      rec.destAddress = hopStr('destAddress') ?? undefined;
    }
    rec.destSymbol = hopStr('destSymbol') ?? undefined;
    rec.destNetwork = hopStr('destNetwork') ?? undefined;
    rec.hopLedger = hopStr('hopLedger') ?? undefined;
    rec.hopSymbol = hopStr('hopSymbol') ?? undefined;
    rec.hopCurrency = r.hopCurrency;
    rec.hopDecimals = r.hopDecimals;
    if (typeof r.gasFeeWei === 'string') rec.gasFeeWei = r.gasFeeWei;
    if (typeof r.gasSymbol === 'string') rec.gasSymbol = r.gasSymbol;
    if (typeof r.gasDecimals === 'number') rec.gasDecimals = r.gasDecimals;
    if (typeof r.hopTx === 'string') rec.hopTx = r.hopTx;
    if (typeof r.feeMillionths === 'number') rec.feeMillionths = r.feeMillionths;
    // The GAS-FUND block (2026-09-20), fail-closed: digit strings only, every leg's six
    // facts non-empty, the ledger chain unbroken, and the plan/legs rhythm pinned — the
    // pre-legs are approve+swap PAIRS ahead of the route's five IC legs. A legacy record
    // carries no gasPre at all (byte-identical history); a gasPre without a plan (or any
    // malformed shape) is a shape this build never wrote — dropped below.
    if (r.gasPre != null) {
      const g = r.gasPre as Record<string, unknown>;
      if (g == null || typeof g !== 'object' || Array.isArray(g)) return null;
      if (typeof g.neededWei !== 'string' || !/^\d+$/.test(g.neededWei)) return null;
      if (!Array.isArray(g.legs) || g.legs.length === 0) return null;
      const preLegs: GasFundPreLeg[] = [];
      for (const pl of g.legs) {
        if (pl == null || typeof pl !== 'object' || Array.isArray(pl)) return null;
        const p = pl as Record<string, unknown>;
        for (const k of ['venueId', 'pool', 'fromLedger', 'toLedger', 'inAmount', 'minOut']) {
          if (typeof p[k] !== 'string' || (p[k] as string).length === 0) return null;
        }
        if (!/^\d+$/.test(p.inAmount as string) || !/^\d+$/.test(p.minOut as string)) return null;
        preLegs.push({
          venueId: p.venueId as string, pool: p.pool as string,
          fromLedger: p.fromLedger as string, toLedger: p.toLedger as string,
          inAmount: p.inAmount as string, minOut: p.minOut as string,
        });
      }
      for (let pi = 0; pi < preLegs.length - 1; pi += 1) {
        if (preLegs[pi]!.toLedger !== preLegs[pi + 1]!.fromLedger) return null;
      }
      if (legs.length !== preLegs.length * 2 + 5) return null;
      for (let pi = 0; pi < preLegs.length; pi += 1) {
        if (parsed[pi * 2]?.kind !== 'approve' || parsed[pi * 2 + 1]?.kind !== 'swap') return null;
      }
      rec.gasPre = {neededWei: g.neededWei, legs: preLegs};
    }
  } else if (legs.length > 0 && legs.length !== 2) return null;
  if (r.gasPre != null && rec.gasPre == null) return null; // gasPre rides a PLANNED record only
  // The COMPOSED shape (2026-09-26, brief §5.4 item 2): exactly three planned legs in the
  // approve/swap/deposit_transfer order, the deposit transfer targeting the record's own
  // hop ledger, and the providerRef the final phase polls (whose orderId MUST be the
  // deposit block's — one order, one id). A record carrying the deposit block lives in the
  // composed vocabulary only; cross-rail/gas-fund/Solana shapes are mutually exclusive
  // with it (the solanaLeg check runs after that block parses).
  if (composedDeposit != null) {
    if (crossRail != null || rec.gasPre != null) return null;
    if (!COMPOSED_CONVERT_STEPS.has(rec.step)) return null;
    // 1 or 2 IC legs (each approve+swap), then the deposit transfer — the plan is the legs'
    // mirror, and the swap/approve rhythm is pinned.
    if (legPlan == null) return null;
    const icLegs = (legPlan.length - 1) / 2;
    if (!Number.isInteger(icLegs) || icLegs < 1 || icLegs > 2
      || legs.length !== icLegs * 2 + 1) return null;
    for (let k = 0; k < icLegs; k += 1) {
      if (legPlan[k * 2]!.kind !== 'approve' || legPlan[k * 2 + 1]!.kind !== 'swap') return null;
    }
    if (legPlan[legPlan.length - 1]!.kind !== 'deposit_transfer') return null;
    const depositLeg = legs[legs.length - 1]!;
    if (depositLeg.canister !== (rec.destLedger ?? rec.hopLedger)
      || (depositLeg.method !== 'icrc1_transfer' && depositLeg.method !== 'transfer')) return null;
    const pr = r.providerRef;
    if (!pr || typeof pr !== 'object' || typeof (pr as Record<string, unknown>).orderId !== 'string') return null;
    const pOrderId = (pr as Record<string, unknown>).orderId as string;
    if (pOrderId.length === 0 || pOrderId !== composedDeposit.orderId) return null;
    const statusUrl = (pr as Record<string, unknown>).statusUrl;
    if (statusUrl != null && (typeof statusUrl !== 'string' || (statusUrl as string).length === 0)) return null;
    const relayOrderId = (pr as Record<string, unknown>).relayOrderId;
    if (relayOrderId != null && (typeof relayOrderId !== 'string' || relayOrderId.length === 0)) return null;
    rec.providerRef = {
      orderId: pOrderId,
      ...(statusUrl != null ? {statusUrl: String(statusUrl)} : {}),
      ...(relayOrderId != null ? {relayOrderId: relayOrderId as string} : {}),
    };
  }
  // The SOLANA WIDENING (2026-09-15): `solanaLeg` — ONE signed Solana transaction. Mutually
  // exclusive with legs>0, legPlan, and providerRef (a record is exactly ONE of the three
  // shapes); when present, `legs` must be empty and the step must be in the Solana driver's
  // vocabulary, or the resume engine would arm a poll no driver can advance.
  // The CROSS-RAIL exception (2026-09-16, Route C): the record's five IC legs are all
  // confirmed when the final Jupiter leg is signed, so `solanaLeg` coexists WITH legs and
  // the plan — exactly on a crossRail-bearing record (never on Route A, whose terminal is
  // done, and never standalone). The step then lives in the cross-rail vocabulary.
  // The CHAIN shape (2026-09-28, the any-pair mandate): the cefi order + signed Solana
  // deposit come FIRST (phase 1: legs empty, solanaLeg set, providerRef present), the IC
  // legs are signed at phase time (phase 2: 2 legs + the direct plan, or 4 + the hub plan)
  // while the deposit leg and providerRef STAY on the record. The chain block is mutually
  // exclusive with composed/cross-rail/gas-fund, its step lives in the chain vocabulary,
  // and the providerRef's orderId MUST be the chain block's (one order, one id).
  let chainRoute: ChainRouteInfo | undefined;
  if (r.chainRoute != null) {
    const c = r.chainRoute as Record<string, unknown>;
    if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
    for (const k of ['venueId', 'orderId', 'depositAddress', 'amountDecimal', 'amountRaw']) {
      if (typeof c[k] !== 'string' || (c[k] as string).length === 0) return null;
    }
    if (!Array.isArray(c.icLegs) || c.icLegs.length < 1 || c.icLegs.length > 2) return null;
    const icLegs: ChainRouteInfo['icLegs'] = [];
    for (const l of c.icLegs) {
      if (l == null || typeof l !== 'object' || Array.isArray(l)) return null;
      const p = l as Record<string, unknown>;
      for (const k of ['venueId', 'pool', 'fromLedger', 'toLedger']) {
        if (typeof p[k] !== 'string' || (p[k] as string).length === 0) return null;
      }
      icLegs.push({
        venueId: p.venueId as string, pool: p.pool as string,
        fromLedger: p.fromLedger as string, toLedger: p.toLedger as string,
      });
    }
    for (let i = 0; i < icLegs.length - 1; i += 1) {
      if (icLegs[i]!.toLedger !== icLegs[i + 1]!.fromLedger) return null;
    }
    if (!Array.isArray(c.icFromFees) || c.icFromFees.length !== icLegs.length
      || c.icFromFees.some(f => typeof f !== 'string' || !/^\d+$/.test(f))) return null;
    if (c.settleAmountDecimal != null && (typeof c.settleAmountDecimal !== 'string' || (c.settleAmountDecimal as string).length === 0)) return null;
    if (c.settleAmountRaw != null && (typeof c.settleAmountRaw !== 'string' || !/^\d+$/.test(c.settleAmountRaw as string))) return null;
    if (c.settleTx != null && (typeof c.settleTx !== 'string' || (c.settleTx as string).length === 0)) return null;
    if (c.depositMemo != null && typeof c.depositMemo !== 'string') return null;
    if (c.expiresAtMs != null && (typeof c.expiresAtMs !== 'number' || !Number.isSafeInteger(c.expiresAtMs) || c.expiresAtMs <= 0)) return null;
    chainRoute = {
      venueId: c.venueId as string,
      orderId: c.orderId as string,
      depositAddress: c.depositAddress as string,
      amountDecimal: c.amountDecimal as string,
      amountRaw: c.amountRaw as string,
      icLegs,
      icFromFees: c.icFromFees as string[],
      ...(c.depositMemo != null ? {depositMemo: c.depositMemo as string} : {}),
      ...(c.expiresAtMs != null ? {expiresAtMs: c.expiresAtMs as number} : {}),
      ...(c.settleAmountDecimal != null ? {settleAmountDecimal: c.settleAmountDecimal as string} : {}),
      ...(c.settleAmountRaw != null ? {settleAmountRaw: c.settleAmountRaw as string} : {}),
      ...(c.settleTx != null ? {settleTx: c.settleTx as string} : {}),
    };
    if (composedDeposit != null || crossRail != null || rec.gasPre != null) return null;
    if (!CHAIN_CONVERT_STEPS.has(rec.step)) return null;
    // The venue's order id is the record's correlation id — one order, one id (the
    // composed block's own pin). The providerRef itself parses below (both phases carry
    // it from birth, next to the deposit leg).
    const pr = r.providerRef;
    if (!pr || typeof pr !== 'object' || typeof (pr as Record<string, unknown>).orderId !== 'string') return null;
    const pOrderId = (pr as Record<string, unknown>).orderId as string;
    if (pOrderId.length === 0 || pOrderId !== chainRoute.orderId) return null;
    const statusUrl = (pr as Record<string, unknown>).statusUrl;
    if (statusUrl != null && (typeof statusUrl !== 'string' || (statusUrl as string).length === 0)) return null;
    const relayOrderId = (pr as Record<string, unknown>).relayOrderId;
    if (relayOrderId != null && (typeof relayOrderId !== 'string' || relayOrderId.length === 0)) return null;
    rec.providerRef = {
      orderId: pOrderId,
      ...(statusUrl != null ? {statusUrl: String(statusUrl)} : {}),
      ...(relayOrderId != null ? {relayOrderId: relayOrderId as string} : {}),
    };
    // Phase 1: legs empty + the deposit leg signed + NO plan. Phase 2: the legs mirror
    // the frozen plan exactly (one approve+swap pair per IC leg) — anything else is a
    // shape this build never wrote.
    if (legs.length === 0) {
      if (legPlan != null) return null;
      rec.chainRoute = chainRoute;
    } else {
      if (legs.length !== icLegs.length * 2 || legPlan == null || legPlan.length !== legs.length) return null;
      for (let k = 0; k < icLegs.length; k += 1) {
        if (legPlan[k * 2]!.kind !== 'approve' || legPlan[k * 2 + 1]!.kind !== 'swap') return null;
      }
      rec.chainRoute = chainRoute;
    }
  }
  let solanaLeg: SolanaSwapLeg | undefined;
  if (r.solanaLeg != null) {
    if (legs.length > 0 || legPlan != null) {
      if (crossRail == null && chainRoute == null) return null;
    }
    const s = r.solanaLeg as Record<string, unknown>;
    if (!s || typeof s !== 'object' || s.protocol !== 'solana') return null;
    if (typeof s.signedTxHex !== 'string' || s.signedTxHex.length === 0) return null;
    if (typeof s.signature !== 'string' || s.signature.length === 0) return null;
    if (typeof s.lastValidBlockHeight !== 'number' || !Number.isSafeInteger(s.lastValidBlockHeight) || s.lastValidBlockHeight <= 0) return null;
    if (crossRail == null && chainRoute == null && !SOLANA_CONVERT_STEPS.has(rec.step)) return null;
    solanaLeg = {
      protocol: 'solana',
      signedTxHex: s.signedTxHex,
      signature: s.signature,
      lastValidBlockHeight: s.lastValidBlockHeight,
    };
    rec.solanaLeg = solanaLeg;
    if (typeof r.solFeeLamports === 'string' && /^\d+$/.test(r.solFeeLamports)) {
      rec.solFeeLamports = r.solFeeLamports;
    }
  }
  if (composedDeposit != null && solanaLeg != null) return null; // composed never carries a Solana leg
  let evmSwap: EvmSwapLeg | undefined;
  if (r.evmSwap != null) {
    // The EVM widening (2026-09-28): mutually exclusive with every other shape (the Solana
    // leg's pins, verbatim) and only at the driver's own steps.
    if (solanaLeg != null || legs.length > 0 || legPlan != null) return null;
    if (composedDeposit != null || crossRail != null || chainRoute != null || rec.gasPre != null) return null;
    if (r.providerRef != null) return null;
    const e = r.evmSwap as Record<string, unknown>;
    if (!e || typeof e !== 'object' || e.protocol !== 'evm') return null;
    if (typeof e.venueId !== 'string' || e.venueId.length === 0) return null;
    if (typeof e.chainId !== 'number' || !Number.isSafeInteger(e.chainId)) return null;
    for (const k of ['inRailId', 'outRailId', 'tokenIn', 'tokenOut', 'inSymbol', 'outSymbol'] as const) {
      if (typeof e[k] !== 'string') return null;
    }
    for (const k of ['amountIn', 'minOut'] as const) {
      if (typeof e[k] !== 'string' || !/^\d+$/.test(e[k] as string)) return null;
    }
    for (const k of ['inDecimals', 'outDecimals', 'feeTier', 'deadlineSecs', 'slippageBps'] as const) {
      if (typeof e[k] !== 'number' || !Number.isSafeInteger(e[k] as number)) return null;
    }
    if (!EVM_CONVERT_STEPS.has(rec.step)) return null;
    evmSwap = {
      protocol: 'evm',
      chainId: e.chainId as number,
      venueId: e.venueId as string,
      inRailId: e.inRailId as string,
      outRailId: e.outRailId as string,
      tokenIn: e.tokenIn as string,
      tokenOut: e.tokenOut as string,
      inSymbol: e.inSymbol as string,
      outSymbol: e.outSymbol as string,
      inDecimals: e.inDecimals as number,
      outDecimals: e.outDecimals as number,
      amountIn: e.amountIn as string,
      minOut: e.minOut as string,
      feeTier: e.feeTier as number,
      deadlineSecs: e.deadlineSecs as number,
      slippageBps: e.slippageBps as number,
      ...(typeof e.preOutRaw === 'string' && /^\d+$/.test(e.preOutRaw) ? {preOutRaw: e.preOutRaw} : {}),
      ...(e.hub != null && typeof e.hub === 'object'
        && typeof (e.hub as Record<string, unknown>).feeTierLeg1 === 'number'
        && typeof (e.hub as Record<string, unknown>).feeTierLeg2 === 'number'
        && typeof (e.hub as Record<string, unknown>).minOutLeg1 === 'string'
        && /^\d+$/.test((e.hub as Record<string, unknown>).minOutLeg1 as string)
        ? {hub: {
            feeTierLeg1: (e.hub as Record<string, unknown>).feeTierLeg1 as number,
            feeTierLeg2: (e.hub as Record<string, unknown>).feeTierLeg2 as number,
            minOutLeg1: (e.hub as Record<string, unknown>).minOutLeg1 as string,
          }}
        : {}),
      ...(Array.isArray(e.txHashes) && e.txHashes.every(h => typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h))
        ? {txHashes: e.txHashes as string[]}
        : {}),
    };
    rec.evmSwap = evmSwap;
  }
  if (evmSwap != null && solanaLeg != null) return null; // one leg protocol per record
  // A legs>0 record parked at `quote`/`confirming` is a shape no driver can advance: the
  // executor only knows approving→approved→swapping→settling→pending_withdrawal, so the resume
  // engine would re-arm a no-op drive forever with no escape (the unreachable-by-construction
  // quadrant — prepare lands at `approving` with legs already signed). Refuse the record like
  // any other malformed one rather than wedge the watcher.
  if (legs.length > 0 && (rec.step === 'quote' || rec.step === 'confirming')) return null;
  // The mirror quadrant: a legs-bearing record at a PROVIDER-only step (every step of the
  // provider vocabulary except the shared terminal `done`) is equally driverless — the IC
  // executor's transition set never visits those steps and the provider driver never picks a
  // record with legs — so the same eternal no-op poll would arm. Refuse it the same way.
  // THE COMPOSED EXCEPTION (2026-09-26): a composed record's OWN final phase lives in the
  // provider vocabulary (the venue poll advances it once the deposit transfer is sent) —
  // its engine dispatch keys on composedDeposit, so these steps are drivable for it.
  if (legs.length > 0 && composedDeposit == null && PROVIDER_ONLY_STEPS.has(rec.step)) return null;
  if (legs.length === 0 && solanaLeg == null && evmSwap == null) {
    const pr = r.providerRef;
    if (!pr || typeof pr !== 'object' || typeof (pr as Record<string, unknown>).orderId !== 'string') return null;
    const statusUrl = (pr as Record<string, unknown>).statusUrl;
    // The partner-agreement correlation id (X-Dpay-Order-Id, 2026-09-22): OPTIONAL — every
    // pre-agreement record (and the sideshift family) carries none — but when present it
    // must be a non-empty string, like every other durable identity on a record.
    const relayOrderId = (pr as Record<string, unknown>).relayOrderId;
    if (relayOrderId != null && (typeof relayOrderId !== 'string' || relayOrderId.length === 0)) return null;
    rec.providerRef = {
      orderId: (pr as Record<string, unknown>).orderId as string,
      ...(statusUrl == null ? {} : {statusUrl: String(statusUrl)}),
      ...(relayOrderId != null ? {relayOrderId: relayOrderId as string} : {}),
    };
    // The CeFi handoff block (SideShift widening, 2026-09-15): optional but when present
    // it must be the whole truth — a corrupt or half-written deposit block on a record
    // the deposit screen renders verbatim is a money-adjacent lie, so refuse the record.
    // (Persisted by prepareCeFiConvertRecord only, always complete.)
    const pd = r.providerDeposit;
    if (pd != null) {
      if (typeof pd !== 'object') return null;
      const pdR = pd as Record<string, unknown>;
      const addr = pdR.depositAddress;
      const amt = pdR.depositAmount;
      const memo = pdR.depositMemo;
      const exp = pdR.expiresAtMs;
      if (typeof addr !== 'string' || addr.length === 0) return null;
      if (typeof amt !== 'string' || amt.length === 0) return null;
      if (memo != null && typeof memo !== 'string') return null;
      if (exp != null && (typeof exp !== 'number' || !Number.isSafeInteger(exp) || exp <= 0)) return null;
      rec.providerDeposit = {
        depositAddress: addr,
        depositAmount: amt,
        ...(memo != null ? {depositMemo: memo} : {}),
        ...(exp != null ? {expiresAtMs: exp} : {}),
      };
    }
    // A legless record lives ONLY in the provider vocabulary (the driver's transition matrix
    // starts at awaiting_* and ends at done/quote_expired/provider_refunded). At any IC-driver
    // step (approving/swapping/settling/…) it is malformed-by-construction: the IC executor
    // has no legs to submit and the provider driver can never transition those steps, so the
    // resume engine would arm an eternal no-op poll. Refuse it like any other malformed
    // record — salvage drops it, it does not brick the store.
    if (!PROVIDER_CONVERT_STEPS.has(rec.step)) return null;
  }
  for (const k of ['id', 'venueId', 'inSymbol', 'outSymbol', 'inLedger', 'outLedger', 'amountIn',
    'expectedGross', 'expectedNet', 'inFee', 'outFee'] as const) {
    if (rec[k] == null) return null;
  }
  // The IC shapes (legs>0 or providerRef) name their assets by numeric catalog currency — the
  // ledger-watch probes key on those ids. A Solana record is exempt (mint + symbol are its
  // identifiers); every legacy/historical IC record always carried them, so this cannot orphan
  // real history. A cross-rail record carries IC legs too — it always names both currencies.
  // The CEFI widening (2026-09-15): a cefi providerRef record's OUT side may live on another
  // rail entirely (ICP → SOL: there IS no numeric catalog currency for SOL) — and it needs
  // none, because the provider driver advances it by statusUrl alone, never a ledger watch.
  // Its identifiers are the ledger/mint pair + symbols, already enforced above.
  // The COMPOSED widening (2026-09-26): the same half-pair rule — the out side is the settle
  // MINT, the hub side's numeric id lives on hopCurrency (the probe's key). (venueId was
  // null-checked in the loop above; the `?? ''` is for the type-narrower — venueOfId('')
  // resolves no venue, so the classification is still fail-closed.)
  const cefiProviderRecord = legs.length === 0 && solanaLeg == null
    && venueOfId(rec.venueId ?? '')?.kind === 'cefi';
  if ((solanaLeg == null || crossRail != null) && evmSwap == null && !cefiProviderRecord && composedDeposit == null
    && (rec.inCurrency == null || rec.outCurrency == null)) return null;
  if (rec.id !== id) return null;
  const full = rec as ConvertRecord;
  out[id] = full;
  return full;
}

/** One store's salvage outcome: the records that survived, and how many were dropped. */
export type SalvagedStore = {records: Record<string, ConvertRecord>; dropped: number};

/** Validate an unknown storage value RECORD BY RECORD (pure; jest-pinned; never throws).
 *  Accepts BOTH store generations in any mix: current-shape records pass through, pre-legs
 *  (v1) records are migrated. A record that fails validation (corrupt bytes, unknown shape,
 *  or a shape no driver can ever advance) is DROPPED and its siblings SURVIVE — one bad
 *  record must not take a whole money-adjacent store with it. Top-level garbage (not an
 *  object) salvages nothing and drops nothing: there were no records to lose. */
export function salvageConvertStore(state: unknown): SalvagedStore {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return {records: {}, dropped: 0};
  const records: Record<string, ConvertRecord> = {};
  let dropped = 0;
  for (const [id, v] of Object.entries(state as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') {dropped += 1; continue;}
    const r = v as Record<string, unknown>;
    const record = r.legs == null && typeof r.approveEnvelopeHex === 'string'
      ? migrateLegacyRecord(r, records, id)
      : hydrateOneRecord(r, records, id);
    if (record == null) dropped += 1;
  }
  return {records, dropped};
}

/** The salvaged records alone (the long-standing read shape of a store). */
export function hydrateConvertStore(state: unknown): Record<string, ConvertRecord> {
  return salvageConvertStore(state).records;
}

/** Parse + salvage ONE raw store string. Unparseable bytes salvage nothing and report
 *  dropped=1 — the whole source is unreadable, which the caller treats as a NOT-fully-
 *  successful adoption (a legacy key in that state is never removed from disk). */
function salvageRawStore(raw: string): SalvagedStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {records: {}, dropped: 1};
  }
  return salvageConvertStore(parsed);
}

/** The user's Stop requests, keyed by record id. Module-level so BOTH drivers (the confirm-flow
 *  executor here and the engine's driveOne) honor one flag regardless of adoption timing. */
const ABORT_REQUESTED = new Set<string>();

/** The user tapped Stop on a live record. Idempotent; the next driver checkpoint collapses it. */
export function requestConvertAbort(id: string): void {
  ABORT_REQUESTED.add(id);
}

/** Internal: has the user asked this record to stop? */
export function convertAborted(id: string): boolean {
  return ABORT_REQUESTED.has(id);
}

/** What the user gave up — the aborted panel's one-line body flavor.
 *  'watching': a swap was already submitted — it may still go through.
 *  'fee': an approve confirmed — its tiny network fee is spent, principal untouched.
 *  'clean': nothing left the wallet at all.
 *  'provider': the venue holds the order (2026-09-24) — dpay only watched its status;
 *  the flavor carries the two-sided truth (no deposit sent → the order dies unfunded;
 *  deposit already sent → the trade may still settle at the venue). */
export function convertAbortFlavor(rec: ConvertRecord): 'clean' | 'fee' | 'watching' | 'provider' {
  // The provider-held and cross-rail phases read off the step machine FIRST (2026-09-24):
  // the plan-based reads below misread them (a crossing/sol_ready record's confirmed IC
  // approves would say 'fee' — but the abort's honest story is the mint that may still
  // land, or the USDC already sitting at the user's ATA).
  const at = rec.step === 'aborted' ? rec.abortedFromStep : rec.step;
  if (at === 'awaiting_deposit' || at === 'provider_processing') return 'provider';
  if (at === 'crossing') return 'watching'; // the CCTP mint may still land at the user's ATA
  if (at === 'sol_ready') return 'clean'; // the final Jupiter leg was UNSIGNED — nothing in flight
  if (rec.solanaLeg != null) return 'watching';
  const plan = rec.legPlan ?? [];
  if (plan.some(l => l.kind === 'swap' && l.state !== 'pending')) return 'watching';
  if (plan.some(l => l.kind === 'approve' && l.state === 'confirmed')) return 'fee';
  // DIRECT records carry no legPlan at all (hydration: "The direct 2-leg shape (legPlan
  // absent)"), so the plan-based reads above never fire for them — and the abort rewrite of
  // `step` erases the flight position, which made an abort mid-flight read as "nothing left
  // the wallet" while the swap envelope was already on the wire. The step machine's own
  // vocabulary carries the facts: from 'swapping' on, the depositFromAndSwap bytes are
  // submitted (watching); 'approved' means the approve settled and its fee is spent (fee);
  // anything earlier is genuinely clean. `abortedFromStep` preserves that position through
  // the abort rewrite, so the terminal aborted card keeps the honest flavor.
  const flown = rec.step === 'aborted' ? rec.abortedFromStep : rec.legPlan == null ? rec.step : undefined;
  if (flown === 'swapping' || flown === 'settling' || flown === 'pending_withdrawal') return 'watching';
  if (flown === 'approved') return 'fee';
  return 'clean';
}

/** Has EVERY leg's submission authority died (device-clock death of the signed envelope)?
 *  An unconfirmed leg past this point may STILL have executed — the outcome is unknown, the
 *  bytes must never be re-submitted (V6 trichotomy arm (b)). */
export function convertLegsExpired(record: ConvertRecord, nowMs: number = Date.now()): boolean {
  return record.legs.length > 0 && record.legs.every(l => l.expiresAtMs <= nowMs);
}

/** The IC hub 2-hop record shape (2026-09-18, spec §11): planned, non-cross-rail, four IC
 *  legs in the approve/swap/approve/swap order, with the dest ledger named. Hydration
 *  enforces exactly this shape AND its frozen facts; this predicate is the executor's and
 *  resume engine's cheap discriminator for the hub-specific state machine. */
export function isHubConvertRecord(rec: ConvertRecord): boolean {
  const plan = rec.legPlan;
  return rec.destLedger != null && rec.crossRail == null && plan != null && plan.length === 4
    && plan[0].kind === 'approve' && plan[1].kind === 'swap'
    && plan[2].kind === 'approve' && plan[3].kind === 'swap';
}

/** The COMPOSED IC→CeFi record shape (2026-09-26, brief §5.4 item 2): planned, three legs
 *  (approve/swap/deposit_transfer), the venue's deposit block frozen, providerRef present.
 *  Hydration enforces the full shape; this is the resume engine's cheap dispatch key (a
 *  composed record drives as IC legs + deposit leg through the planned executor, then
 *  switches to the provider poll for the venue's final phase). */
export function isComposedConvertRecord(rec: ConvertRecord): boolean {
  return rec.composedDeposit != null;
}

/** The CHAIN record shape (2026-09-28): the cefi order + signed Solana deposit leg come
 *  first, the IC legs are signed at phase time. Hydration enforces the shape; this
 *  predicate is the resume engine's dispatch discriminator. */
export function isChainConvertRecord(rec: ConvertRecord): boolean {
  return rec.chainRoute != null;
}

export async function loadConvertRecords(publicHex: string): Promise<Record<string, ConvertRecord>> {
  const scopedKey = convertStoreKey(publicHex);
  try {
    const raw = await AsyncStorage.getItem(scopedKey);
    // Scoped-first short-circuit: THIS identity's own store is the answer, healthy or not —
    // legacy keys are never consulted once a scoped store exists. Salvage is PER-RECORD: valid
    // records load, corrupt ones are dropped from the working set; the bytes stay on disk
    // untouched (nothing is rewritten on a load) and the next saveConvertRecord rebuilds the
    // store clean around the survivors.
    if (raw != null) {
      const salvaged = salvageRawStore(raw);
      if (salvaged.dropped > 0) {
        console.warn(`convert store ${scopedKey}: ${salvaged.dropped} record(s) unreadable — dropped from the working set (bytes left on disk until the next save)`);
      }
      return salvaged.records;
    }
    // No scoped store yet: fold ALL legacy sources into ONE pass — the pre-legs v1 store
    // first (the older generation), the pre-scoping unscoped v2 store OVERLAYING it on id
    // collision, then the PRIOR per-identity v2 store (this key's immediate predecessor,
    // 2026-09-26) overlaying both (the newest generation wins). One v3 write, then each
    // legacy key is retired ONLY if its own salvage was total: a key that lost records to
    // corruption STAYS on disk (source preserved for manual recovery) while its valid
    // records still land in the v3 store. The adopting identity is the one that wrote the
    // prior stores (single-active-identity deployment) and a record must survive an app
    // upgrade, byte-frozen. Composed-shape records only ever exist in a v3 store — a v2
    // record hydrates under v3 unchanged (the shapes are additive).
    const legacy: Array<{key: string; raw: string | null}> = [
      {key: CONVERT_LEGACY_STORAGE_KEY, raw: await AsyncStorage.getItem(CONVERT_LEGACY_STORAGE_KEY)},
      {key: CONVERT_UNSCOPED_STORAGE_KEY, raw: await AsyncStorage.getItem(CONVERT_UNSCOPED_STORAGE_KEY)},
      {key: `${CONVERT_PRIOR_SCOPED_STORAGE_PREFIX}.${publicHex}`, raw: await AsyncStorage.getItem(`${CONVERT_PRIOR_SCOPED_STORAGE_PREFIX}.${publicHex}`)},
    ];
    if (legacy.every(s => s.raw == null)) return {};
    const merged: Record<string, ConvertRecord> = {};
    const adopted: Array<{key: string; dropped: number}> = [];
    for (const s of legacy) {
      if (s.raw == null) continue;
      const salvaged = salvageRawStore(s.raw);
      Object.assign(merged, salvaged.records);
      adopted.push({key: s.key, dropped: salvaged.dropped});
    }
    await AsyncStorage.setItem(scopedKey, JSON.stringify(merged));
    for (const s of adopted) {
      if (s.dropped === 0) {
        await AsyncStorage.removeItem(s.key); // fully copied — retire the legacy key
      } else {
        console.warn(`convert legacy store ${s.key}: ${s.dropped} record(s) unreadable — valid records were copied to ${scopedKey}; the legacy key is KEPT on disk (source preserved)`);
      }
    }
    return merged;
  } catch (e) {
    console.warn('convert records load failed:', e instanceof Error ? e.message : String(e));
    return {};
  }
}

export async function saveConvertRecord(publicHex: string, record: ConvertRecord): Promise<void> {
  try {
    const all = await loadConvertRecords(publicHex);
    all[record.id] = record;
    await AsyncStorage.setItem(convertStoreKey(publicHex), JSON.stringify(all));
  } catch (e) {
    console.warn('convert record save failed:', e instanceof Error ? e.message : String(e));
  }
}
