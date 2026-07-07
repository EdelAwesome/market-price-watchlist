/**
 * XIRR — the internal rate of return of a dated, irregular cashflow series (the money-weighted
 * return). Solved with Newton–Raphson and a bisection fallback, because Newton can diverge or
 * leave the valid domain (rate <= -1) on irregular sign patterns; bisection is slower but robust
 * once a sign-change bracket exists.
 *
 * Day count is actual/365 from the earliest cashflow date. Returns null when the series can't
 * yield a rate (fewer than 2 flows, or all-same-sign) — the caller surfaces "unavailable" rather
 * than a bogus number.
 */
export interface Cashflow {
  date: Date;
  amount: number; // sign from the INVESTOR's view: money in = negative, money out/value = positive
}

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

interface Discounted {
  years: number;
  amount: number;
}

function npv(rate: number, cfs: Discounted[]): number {
  let sum = 0;
  for (const c of cfs) sum += c.amount / Math.pow(1 + rate, c.years);
  return sum;
}

function dNpv(rate: number, cfs: Discounted[]): number {
  let sum = 0;
  for (const c of cfs) sum += (-c.years * c.amount) / Math.pow(1 + rate, c.years + 1);
  return sum;
}

export function xirr(cashflows: Cashflow[]): number | null {
  if (cashflows.length < 2) return null;
  if (!cashflows.some((c) => c.amount < 0) || !cashflows.some((c) => c.amount > 0)) return null;

  const t0 = Math.min(...cashflows.map((c) => c.date.getTime()));
  const cfs: Discounted[] = cashflows.map((c) => ({
    years: (c.date.getTime() - t0) / YEAR_MS,
    amount: c.amount,
  }));

  // --- Newton–Raphson from a reasonable guess ---
  let rate = 0.1;
  for (let i = 0; i < 100; i++) {
    const f = npv(rate, cfs);
    if (Math.abs(f) < 1e-9) return rate;
    const fp = dNpv(rate, cfs);
    if (!isFinite(fp) || fp === 0) break;
    const next = rate - f / fp;
    if (!isFinite(next) || next <= -0.999999) break; // left the valid domain -> bisection
    if (Math.abs(next - rate) < 1e-12) {
      rate = next;
      break;
    }
    rate = next;
  }
  if (isFinite(rate) && rate > -1 && Math.abs(npv(rate, cfs)) < 1e-6) return rate;

  // --- Bisection fallback: scan for a sign change, then halve ---
  return bisect(cfs);
}

function bisect(cfs: Discounted[]): number | null {
  // Sample rates from just above -1 upward; returns can be large but are effectively bracketed here.
  const samples: number[] = [-0.999999];
  for (let r = -0.99; r < 1; r += 0.01) samples.push(Number(r.toFixed(4)));
  for (let r = 1; r <= 100; r += 1) samples.push(r);
  for (let r = 200; r <= 1e6; r *= 10) samples.push(r);

  let prev = samples[0]!;
  let fPrev = npv(prev, cfs);
  for (let i = 1; i < samples.length; i++) {
    const cur = samples[i]!;
    const fCur = npv(cur, cfs);
    if (isFinite(fPrev) && isFinite(fCur) && fPrev * fCur < 0) {
      let a = prev;
      let b = cur;
      let fa = fPrev;
      for (let k = 0; k < 200; k++) {
        const m = (a + b) / 2;
        const fm = npv(m, cfs);
        if (Math.abs(fm) < 1e-9 || b - a < 1e-13) return m;
        if (fa * fm < 0) b = m;
        else {
          a = m;
          fa = fm;
        }
      }
      return (a + b) / 2;
    }
    prev = cur;
    fPrev = fCur;
  }
  return null;
}
