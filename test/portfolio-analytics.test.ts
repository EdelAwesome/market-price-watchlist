import { describe, it, expect } from 'vitest';
import { computePortfolioAnalytics } from '../src/analytics/portfolio-analytics.js';
import type { LedgerTxn } from '../src/domain/derive.js';

const t = (
  type: LedgerTxn['type'],
  symbol: string | null,
  quantity: number,
  price: number,
  fees: number,
  iso: string,
): LedgerTxn => ({ type, symbol, quantity, price, fees, tradeTime: new Date(iso) });

describe('computePortfolioAnalytics — mandatory fixture (cash asserted separately from rate)', () => {
  // Hand-worked lifecycle over exactly one 365-day year (2023 is not a leap year):
  //   DEPOSIT 1000              cash -> 1000
  //   BUY 5 AAPL @ 100 (500)    cash ->  500 ; position 5 @ avg 100, basis 500
  //   DIVIDEND 5 @ 0.24*... use 2/sh -> 10   cash ->  510
  //   valuation quote AAPL = 120 -> holdings 5*120 = 600
  //   terminal value = 600 + 510 = 1110 ; external CF = -1000 at t0, +1110 at +365d
  //   XIRR: (1110/1000)^(365/365) - 1 = 0.11 exactly
  const ledger: LedgerTxn[] = [
    t('DEPOSIT', null, 1, 1000, 0, '2023-01-01'),
    t('BUY', 'AAPL', 5, 100, 0, '2023-01-01'),
    t('DIVIDEND', 'AAPL', 5, 2, 0, '2023-06-01'),
  ];
  const quotes = new Map([['AAPL', 120]]);
  const a = computePortfolioAnalytics(ledger, quotes, new Date('2024-01-01'));

  it('derived cash balance is asserted as its OWN expectation', () => {
    // Separate from the XIRR rate: a cash-sign error here fails independently of the rate.
    expect(a.cash).toBe('510.00');
  });

  it('holdings value, total value, and unrealized P/L', () => {
    expect(a.holdingsValue).toBe('600.00');
    expect(a.totalValue).toBe('1110.00');
    expect(a.holdings[0]!.unrealizedPl).toBe('100.00'); // 600 - 500 basis
    expect(a.holdings[0]!.unrealizedPlPct).toBe('20.00'); // 120/100 - 1
  });

  it('allocation weight', () => {
    expect(a.allocation).toEqual([{ symbol: 'AAPL', weight: 100 }]);
  });

  it('XIRR rate is asserted separately and equals the hand-checked 0.11', () => {
    expect(a.mwr.available).toBe(true);
    expect(a.mwr.syntheticFunding).toBe(false);
    expect(a.mwr.rate!).toBeCloseTo(0.11, 9);
  });
});

describe('computePortfolioAnalytics — funding fallback', () => {
  it('synthesizes the first BUY as the contribution when no DEPOSIT exists', () => {
    // BUY 10 @ 100 (cost 1000) with no deposit; quote 110 one year later.
    // synthetic -1000 at buy date; terminal cash = -1000 (buy) + 1000 (synthetic) = 0;
    // terminal = 1100 -> XIRR = 0.10, flagged syntheticFunding.
    const ledger: LedgerTxn[] = [t('BUY', 'AAPL', 10, 100, 0, '2023-01-01')];
    const a = computePortfolioAnalytics(ledger, new Map([['AAPL', 110]]), new Date('2024-01-01'));
    // Reported cash is the HONEST ledger fold: a buy with no recorded deposit leaves -1000
    // (an "underfunded ledger" signal). Synthetic funding lives only inside the MWR math, so
    // the terminal cash it uses is -1000 + 1000 = 0 and the rate still resolves.
    expect(a.cash).toBe('-1000.00');
    expect(a.mwr.available).toBe(true);
    expect(a.mwr.syntheticFunding).toBe(true);
    expect(a.mwr.rate!).toBeCloseTo(0.1, 9);
  });

  it('reports unavailable (never a guess) when there is no funding at all', () => {
    const a = computePortfolioAnalytics([], new Map(), new Date('2024-01-01'));
    expect(a.mwr.available).toBe(false);
    expect(a.mwr.rate).toBeNull();
    expect(a.mwr.note).toMatch(/add a deposit/);
  });
});

describe('computePortfolioAnalytics — missing quote degrades that holding, not the whole call', () => {
  it('leaves market fields null when no quote is available', () => {
    const ledger: LedgerTxn[] = [
      t('DEPOSIT', null, 1, 1000, 0, '2023-01-01'),
      t('BUY', 'ZZZZ', 1, 50, 0, '2023-01-02'),
    ];
    const a = computePortfolioAnalytics(ledger, new Map(), new Date('2024-01-01'));
    expect(a.holdings[0]!.price).toBeNull();
    expect(a.holdings[0]!.marketValue).toBeNull();
    expect(a.holdingsValue).toBe('0.00');
    expect(a.cash).toBe('950.00'); // still derived correctly
  });
});
