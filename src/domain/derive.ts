/**
 * Ledger derivation — the heart of the "positions and P/L are DERIVED, never stored" model.
 *
 * Everything here is a PURE fold over plain transaction objects (no DB coupling) so it is
 * unit-testable with zero infrastructure. The dangerous surface, per the plan, is the signed
 * cash balance: a mis-signed line produces a plausible-but-wrong terminal value and therefore a
 * plausible-but-wrong XIRR. `cashEffect` is the single source of truth for those signs.
 */
import { Decimal } from 'decimal.js';

export type TxnType = 'BUY' | 'SELL' | 'DIVIDEND' | 'DEPOSIT' | 'WITHDRAWAL' | 'FEE';

/**
 * Storage convention (see DECISIONS.md):
 *  - BUY/SELL: `quantity` = shares, `price` = per-share price, `fees` = commission (>= 0).
 *  - DIVIDEND: `quantity` = shares, `price` = per-share dividend  (notional = total cash).
 *  - DEPOSIT/WITHDRAWAL/FEE (cash-only): put the amount in `price` with `quantity` = 1.
 * `notional = quantity * price` in all cases; `fees` is a non-negative magnitude.
 */
export interface LedgerTxn {
  type: TxnType;
  symbol: string | null;
  quantity: Decimal.Value;
  price: Decimal.Value;
  fees: Decimal.Value;
  tradeTime: Date;
}

const D = (v: Decimal.Value | null | undefined): Decimal => new Decimal(v ?? 0);

/**
 * THE one true sign table. Any deviation is a bug.
 *
 *   DEPOSIT    +notional         investor adds cash
 *   WITHDRAWAL -notional         investor removes cash
 *   BUY        -(notional+fees)  cash -> shares
 *   SELL       +(notional-fees)  shares -> cash
 *   DIVIDEND   +notional         income lands as cash
 *   FEE        -(notional+fees)  cost leaves cash
 */
export function cashEffect(t: Pick<LedgerTxn, 'type' | 'quantity' | 'price' | 'fees'>): Decimal {
  const notional = D(t.quantity).mul(D(t.price));
  const fees = D(t.fees);
  switch (t.type) {
    case 'DEPOSIT':
      return notional;
    case 'WITHDRAWAL':
      return notional.neg();
    case 'DIVIDEND':
      return notional;
    case 'BUY':
      return notional.add(fees).neg();
    case 'SELL':
      return notional.sub(fees);
    case 'FEE':
      return notional.add(fees).neg();
    default: {
      const _exhaustive: never = t.type;
      throw new Error(`unknown transaction type: ${String(_exhaustive)}`);
    }
  }
}

/** Portfolio-wide derived cash balance = sum of every row's signed cash effect. */
export function deriveCashBalance(txns: readonly LedgerTxn[]): Decimal {
  return txns.reduce((acc, t) => acc.add(cashEffect(t)), new Decimal(0));
}

export interface Position {
  symbol: string;
  quantity: Decimal; // shares currently held
  costBasis: Decimal; // total cost of the open shares (fees capitalized into basis)
  avgCost: Decimal; // costBasis / quantity, or 0 when flat
}

/**
 * Per-symbol position via AVERAGE-COST basis:
 *  - BUY adds shares and adds (notional + fees) to the cost pool.
 *  - SELL removes shares at the current average; the average is UNCHANGED by a sell.
 * Fees are capitalized into basis (documented). Overselling more than held throws — that is a
 * data error we surface rather than silently produce a negative/short position.
 */
export function derivePositions(txns: readonly LedgerTxn[]): Map<string, Position> {
  const pool = new Map<string, { shares: Decimal; cost: Decimal }>();

  // Process in trade-time order so average cost reflects the real sequence.
  const ordered = [...txns].sort((a, b) => a.tradeTime.getTime() - b.tradeTime.getTime());

  for (const t of ordered) {
    if (t.type !== 'BUY' && t.type !== 'SELL') continue;
    if (!t.symbol) throw new Error(`${t.type} transaction is missing a symbol`);
    const sym = t.symbol.toUpperCase();
    const cur = pool.get(sym) ?? { shares: new Decimal(0), cost: new Decimal(0) };
    const qty = D(t.quantity);

    if (t.type === 'BUY') {
      cur.shares = cur.shares.add(qty);
      cur.cost = cur.cost.add(D(t.quantity).mul(D(t.price))).add(D(t.fees));
    } else {
      if (qty.gt(cur.shares)) {
        throw new Error(
          `oversell of ${sym}: selling ${qty.toString()} but only ${cur.shares.toString()} held`,
        );
      }
      const avg = cur.shares.isZero() ? new Decimal(0) : cur.cost.div(cur.shares);
      cur.cost = cur.cost.sub(avg.mul(qty));
      cur.shares = cur.shares.sub(qty);
      if (cur.shares.isZero()) cur.cost = new Decimal(0); // avoid tiny residue when flat
    }
    pool.set(sym, cur);
  }

  const out = new Map<string, Position>();
  for (const [symbol, { shares, cost }] of pool) {
    if (shares.lte(0)) continue; // only surface open positions
    out.set(symbol, {
      symbol,
      quantity: shares,
      costBasis: cost,
      avgCost: cost.div(shares),
    });
  }
  return out;
}

export interface PortfolioState {
  cash: Decimal;
  positions: Position[];
}

/** Convenience: derived cash + open positions from a single fold of the ledger. */
export function derivePortfolio(txns: readonly LedgerTxn[]): PortfolioState {
  return {
    cash: deriveCashBalance(txns),
    positions: [...derivePositions(txns).values()],
  };
}
