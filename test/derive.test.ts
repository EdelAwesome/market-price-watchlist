import { describe, it, expect } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  cashEffect,
  deriveCashBalance,
  derivePositions,
  type LedgerTxn,
} from '../src/domain/derive.js';

const t = (
  type: LedgerTxn['type'],
  symbol: string | null,
  quantity: Decimal.Value,
  price: Decimal.Value,
  fees: Decimal.Value,
  day: number,
): LedgerTxn => ({
  type,
  symbol,
  quantity,
  price,
  fees,
  tradeTime: new Date(Date.UTC(2024, 0, day)),
});

describe('cashEffect — the one true sign table', () => {
  it('signs each ledger type correctly', () => {
    // amount 100 encoded as qty=1, price=100 for cash-only rows
    expect(cashEffect({ type: 'DEPOSIT', quantity: 1, price: 100, fees: 0 }).toNumber()).toBe(100);
    expect(cashEffect({ type: 'WITHDRAWAL', quantity: 1, price: 100, fees: 0 }).toNumber()).toBe(-100);
    expect(cashEffect({ type: 'DIVIDEND', quantity: 10, price: 0.5, fees: 0 }).toNumber()).toBe(5);
    // BUY 10 @ 150 + 1 fee = -1501
    expect(cashEffect({ type: 'BUY', quantity: 10, price: 150, fees: 1 }).toNumber()).toBe(-1501);
    // SELL 4 @ 170 - 1 fee = +679
    expect(cashEffect({ type: 'SELL', quantity: 4, price: 170, fees: 1 }).toNumber()).toBe(679);
    expect(cashEffect({ type: 'FEE', quantity: 1, price: 9.99, fees: 0 }).toNumber()).toBe(-9.99);
  });
});

describe('deriveCashBalance + derivePositions — hand-checked fixture', () => {
  // A full lifecycle. Cash walked by hand:
  //   0
  //   +10000 (DEPOSIT)              -> 10000.00
  //   -(10*150 + 1)  BUY  10@150 f1 ->  8499.00
  //   -( 5*160 + 1)  BUY   5@160 f1 ->  7698.00
  //   +( 4*170 - 1)  SELL  4@170 f1 ->  8377.00
  //   +(11*0.24)     DIVIDEND        ->  8379.64
  //   -500           WITHDRAWAL      ->  7879.64
  //   -9.99          FEE             ->  7869.65
  const ledger: LedgerTxn[] = [
    t('DEPOSIT', null, 1, 10000, 0, 1),
    t('BUY', 'AAPL', 10, 150, 1, 2),
    t('BUY', 'AAPL', 5, 160, 1, 3),
    t('SELL', 'AAPL', 4, 170, 1, 4),
    t('DIVIDEND', 'AAPL', 11, 0.24, 0, 5),
    t('WITHDRAWAL', null, 1, 500, 0, 6),
    t('FEE', null, 1, 9.99, 0, 7),
  ];

  it('asserts the derived cash balance as its own expectation (separate from any rate)', () => {
    expect(deriveCashBalance(ledger).toFixed(2)).toBe('7869.65');
  });

  it('matches an INDEPENDENT oracle (raw arithmetic, never touches cashEffect)', () => {
    // Recompute terminal cash straight from the stated sign RULES with bare operators, so the
    // 7869.65 literal above cannot merely be a pinned copy of the code's own output. If the
    // module and this oracle ever disagree, one of them is wrong — a real correctness check.
    const oracle =
      10000 + // DEPOSIT
      -(10 * 150 + 1) + // BUY  10@150 +1 fee
      -(5 * 160 + 1) + // BUY   5@160 +1 fee
      (4 * 170 - 1) + // SELL  4@170 -1 fee
      11 * 0.24 + // DIVIDEND
      -500 + // WITHDRAWAL
      -9.99; // FEE
    expect(new Decimal(oracle).toFixed(2)).toBe('7869.65');
    expect(deriveCashBalance(ledger).toFixed(2)).toBe(new Decimal(oracle).toFixed(2));
  });

  it('derives the average-cost position correctly (sell does not move the average)', () => {
    const pos = derivePositions(ledger).get('AAPL');
    expect(pos).toBeDefined();
    // qty = 10 + 5 - 4 = 11
    expect(pos!.quantity.toString()).toBe('11');
    // cost pool before sell = 1501 + 801 = 2302 over 15 shares -> avg 153.4666...
    // sell 4 removes 4*avg; remaining basis = 2302 * 11/15 = 25322/15 = 1688.1333...
    expect(pos!.costBasis.toFixed(4)).toBe('1688.1333');
    expect(pos!.avgCost.toFixed(6)).toBe('153.466667');
  });
});

describe('derivePositions — guards', () => {
  it('throws on overselling more than held', () => {
    const ledger: LedgerTxn[] = [t('BUY', 'MSFT', 5, 100, 0, 1), t('SELL', 'MSFT', 6, 110, 0, 2)];
    expect(() => derivePositions(ledger)).toThrow(/oversell/);
  });

  it('drops a fully-closed position and leaves no basis residue', () => {
    const ledger: LedgerTxn[] = [t('BUY', 'MSFT', 5, 100, 0, 1), t('SELL', 'MSFT', 5, 110, 0, 2)];
    expect(derivePositions(ledger).has('MSFT')).toBe(false);
  });
});
