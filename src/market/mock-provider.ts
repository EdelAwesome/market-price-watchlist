import type { Clock } from './clock.js';
import type { Quote, QuoteProvider } from './provider.js';
import { ProviderHttpError } from './provider.js';

/**
 * Test double for QuoteProvider. Records every batch call so tests can PROVE dedup/batching, can
 * inject failures (to exercise retry + degrade), and stamps asOf from an injected clock.
 */
export class MockQuoteProvider implements QuoteProvider {
  readonly name = 'mock';
  readonly calls: string[][] = []; // one entry per getQuotes call = the symbols requested
  private readonly prices = new Map<string, number>();
  private failQueue: Error[] = [];
  private missing = new Set<string>(); // symbols to deliberately omit from responses

  constructor(
    private readonly clock: Clock,
    initialPrices: Record<string, number> = {},
  ) {
    for (const [s, p] of Object.entries(initialPrices)) this.prices.set(s.toUpperCase(), p);
  }

  setPrice(symbol: string, price: number): void {
    this.prices.set(symbol.toUpperCase(), price);
  }

  /** Queue up failures for the next N calls (used to test retry/backoff and degrade). */
  failNext(count: number, err: Error = new ProviderHttpError(503, 'mock outage')): void {
    for (let i = 0; i < count; i++) this.failQueue.push(err);
  }

  omit(symbol: string): void {
    this.missing.add(symbol.toUpperCase());
  }

  get callCount(): number {
    return this.calls.length;
  }

  async getQuotes(symbols: string[]): Promise<Map<string, Quote>> {
    const requested = symbols.map((s) => s.toUpperCase());
    this.calls.push(requested);

    const fail = this.failQueue.shift();
    if (fail) throw fail;

    const out = new Map<string, Quote>();
    for (const s of requested) {
      if (this.missing.has(s)) continue;
      const price = this.prices.get(s);
      if (price == null) continue;
      out.set(s, {
        symbol: s,
        price,
        prevClose: null,
        asOf: this.clock.now(),
        source: 'mock',
      });
    }
    return out;
  }
}
