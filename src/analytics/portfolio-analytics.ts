import { Decimal } from 'decimal.js';
import { derivePositions, deriveCashBalance, type LedgerTxn } from '../domain/derive.js';
import { xirr, type Cashflow } from './xirr.js';

/**
 * Slice-3 analytics — exactly three numbers, all from the ledger + a current quote:
 *   1. XIRR (money-weighted return) on EXACT external cashflows + terminal value.
 *   2. Average-cost unrealized P/L per holding.
 *   3. Allocation by weight.
 * No historical series, no TWR/vol/drawdown/Sharpe/beta (removed with the history dependency).
 */

export interface HoldingAnalytics {
  symbol: string;
  quantity: string;
  avgCost: string;
  price: string | null; // null when no quote is available for the symbol
  marketValue: string | null;
  unrealizedPl: string | null;
  unrealizedPlPct: string | null;
  weight: number; // % of holdings market value
}

export interface MwrResult {
  available: boolean;
  rate: number | null; // annualized money-weighted return (e.g. 0.11 = 11%)
  syntheticFunding: boolean; // funding inferred from the first BUY (no explicit deposit)
  note?: string;
}

export interface PortfolioAnalytics {
  cash: string; // derived cash balance
  holdingsValue: string; // Σ market value of open positions
  totalValue: string; // holdingsValue + cash
  holdings: HoldingAnalytics[];
  allocation: { symbol: string; weight: number }[];
  mwr: MwrResult;
}

/** `quotes` maps SYMBOL -> current price. Missing symbols leave that holding's market fields null. */
export function computePortfolioAnalytics(
  txns: LedgerTxn[],
  quotes: Map<string, number>,
  valuationDate: Date,
): PortfolioAnalytics {
  const positions = derivePositions(txns);
  const cash = deriveCashBalance(txns);

  // First pass: market values (needed before we can compute weights).
  const rows = [...positions.values()].map((p) => {
    const priceNum = quotes.get(p.symbol);
    const price = priceNum != null ? new Decimal(priceNum) : null;
    const marketValue = price ? price.mul(p.quantity) : null;
    return { p, price, marketValue };
  });

  const holdingsValue = rows.reduce(
    (acc, r) => (r.marketValue ? acc.add(r.marketValue) : acc),
    new Decimal(0),
  );

  const holdings: HoldingAnalytics[] = rows.map(({ p, price, marketValue }) => {
    const unrealized = marketValue ? marketValue.sub(p.costBasis) : null;
    const weight =
      marketValue && holdingsValue.gt(0)
        ? Number(marketValue.div(holdingsValue).mul(100).toFixed(2))
        : 0;
    return {
      symbol: p.symbol,
      quantity: p.quantity.toString(),
      avgCost: p.avgCost.toFixed(4),
      price: price ? price.toFixed(4) : null,
      marketValue: marketValue ? marketValue.toFixed(2) : null,
      unrealizedPl: unrealized ? unrealized.toFixed(2) : null,
      unrealizedPlPct:
        price && p.avgCost.gt(0) ? price.div(p.avgCost).sub(1).mul(100).toFixed(2) : null,
      weight,
    };
  });

  const allocation = holdings
    .filter((h) => h.marketValue != null)
    .map((h) => ({ symbol: h.symbol, weight: h.weight }));

  const mwr = computeMwr(txns, cash, holdingsValue, valuationDate);

  return {
    cash: cash.toFixed(2),
    holdingsValue: holdingsValue.toFixed(2),
    totalValue: holdingsValue.add(cash).toFixed(2),
    holdings,
    allocation,
    mwr,
  };
}

/**
 * Money-weighted return. Cashflows are EXACT external boundary crossings only:
 *   DEPOSIT -> -notional (money in),  WITHDRAWAL -> +notional (money out).
 * BUY/SELL/DIVIDEND/FEE are internal and captured in the terminal value, never as cashflows.
 * Terminal value (dated valuationDate, positive) = holdings market value + derived cash.
 *
 * Funding fallback (no DEPOSIT rows): synthesize a single contribution = the first BUY's total
 * cost on its date, and add it to the terminal cash so the two sides stay consistent. If funding
 * still can't be resolved, return unavailable — never a guessed rate.
 */
function computeMwr(
  txns: LedgerTxn[],
  cash: Decimal,
  holdingsValue: Decimal,
  valuationDate: Date,
): MwrResult {
  const cashflows: Cashflow[] = [];
  let hasDeposit = false;

  for (const t of txns) {
    const notional = new Decimal(t.quantity).mul(t.price);
    if (t.type === 'DEPOSIT') {
      cashflows.push({ date: t.tradeTime, amount: notional.neg().toNumber() });
      hasDeposit = true;
    } else if (t.type === 'WITHDRAWAL') {
      cashflows.push({ date: t.tradeTime, amount: notional.toNumber() });
    }
  }

  let terminalCash = cash;
  let syntheticFunding = false;
  if (!hasDeposit) {
    const firstBuy = txns
      .filter((t) => t.type === 'BUY')
      .sort((a, b) => a.tradeTime.getTime() - b.tradeTime.getTime())[0];
    if (firstBuy) {
      const cost = new Decimal(firstBuy.quantity).mul(firstBuy.price).add(firstBuy.fees);
      cashflows.push({ date: firstBuy.tradeTime, amount: cost.neg().toNumber() });
      terminalCash = cash.add(cost); // keep terminal consistent with the synthetic contribution
      syntheticFunding = true;
    }
  }

  const terminal = holdingsValue.add(terminalCash);
  if (!terminal.isZero()) {
    cashflows.push({ date: valuationDate, amount: terminal.toNumber() });
  }

  const rate = xirr(cashflows);
  if (rate == null) {
    return {
      available: false,
      rate: null,
      syntheticFunding,
      note: 'unavailable — add a deposit to fund the account',
    };
  }
  return {
    available: true,
    rate,
    syntheticFunding,
    ...(syntheticFunding
      ? { note: 'funding inferred from first purchase; add explicit deposits for exact MWR' }
      : {}),
  };
}
