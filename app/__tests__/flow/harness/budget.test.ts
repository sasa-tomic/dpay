import {describe, expect, it} from '@jest/globals';
import {BUDGET_MAX, factorOf, psiFactorOf} from './budget';

describe('budget BUDGET_MAX - the ceiling that bounds every scaled wait', () => {
  it('is the clamp both contention terms respect, so any scaled wait is base x BUDGET_MAX at worst', () => {
    expect(BUDGET_MAX).toBe(6);
    expect(factorOf(Number.POSITIVE_INFINITY)).toBe(BUDGET_MAX);
    expect(psiFactorOf(Number.POSITIVE_INFINITY)).toBe(BUDGET_MAX);
  });
});
