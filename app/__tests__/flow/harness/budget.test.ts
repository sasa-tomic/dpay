import {describe, expect, it} from '@jest/globals';
import {BUDGET_MAX, ceiling, factorOf, psiFactorOf} from './budget';

describe('budget BUDGET_MAX - the ceiling that bounds every scaled wait', () => {
  it('is the clamp both contention terms respect, so any scaled wait is base x BUDGET_MAX at worst', () => {
    expect(BUDGET_MAX).toBe(6);
    expect(factorOf(Number.POSITIVE_INFINITY)).toBe(BUDGET_MAX);
    expect(psiFactorOf(Number.POSITIVE_INFINITY)).toBe(BUDGET_MAX);
  });
});

describe('budget ceiling - the per-test jest ceiling that dominates, never races', () => {
  it('scales the nominal internal total by BUDGET_MAX statically (not at the install factor)', () => {
    // A test whose internal budgetDeadline waits total ~ms nominal can never exceed
    // ms x BUDGET_MAX under the clamped factor, whatever the load does later.
    expect(ceiling(10_000)).toBe(60_000);
    expect(ceiling(300_000)).toBe(1_800_000);
  });
});
