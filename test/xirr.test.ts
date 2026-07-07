import { describe, it, expect } from 'vitest';
import { xirr, type Cashflow } from '../src/analytics/xirr.js';

const cf = (iso: string, amount: number): Cashflow => ({ date: new Date(iso), amount });

describe('xirr — known-answer fixtures', () => {
  it('matches the Microsoft Excel XIRR reference example (0.373362535)', () => {
    // This exact series + dates is the documented Excel XIRR example; the reference answer is
    // 0.373362535. Cross-checking against an independent implementation, not our own output.
    const rate = xirr([
      cf('2008-01-01', -10000),
      cf('2008-03-01', 2750),
      cf('2008-10-30', 4250),
      cf('2009-02-15', 3250),
      cf('2009-04-01', 2750),
    ]);
    expect(rate).not.toBeNull();
    expect(rate!).toBeCloseTo(0.373362535, 5);
  });

  it('a clean +10% over exactly 365 days', () => {
    // -1000 in, 1100 out one 365-day year later -> (1.1)^1 - 1 = 0.10 exactly.
    const rate = xirr([cf('2023-01-01', -1000), cf('2024-01-01', 1100)]);
    expect(rate!).toBeCloseTo(0.1, 9);
  });

  it('a loss resolves to a negative rate', () => {
    const rate = xirr([cf('2023-01-01', -1000), cf('2024-01-01', 900)]);
    expect(rate!).toBeCloseTo(-0.1, 9);
  });
});

describe('xirr — unresolvable series return null (never a bogus number)', () => {
  it('all-positive cashflows', () => {
    expect(xirr([cf('2023-01-01', 100), cf('2024-01-01', 100)])).toBeNull();
  });
  it('all-negative cashflows', () => {
    expect(xirr([cf('2023-01-01', -100), cf('2024-01-01', -100)])).toBeNull();
  });
  it('a single cashflow', () => {
    expect(xirr([cf('2023-01-01', -100)])).toBeNull();
  });
});
