import type { Quote, QuoteProvider } from './provider.js';

export interface AlpacaConfig {
  keyId: string;
  secretKey: string;
  dataUrl: string; // e.g. https://data.alpaca.markets
  feed: 'iex' | 'sip'; // free tier = iex
}

/**
 * Alpaca Market Data provider — QUOTES ONLY.
 *
 * Uses the multi-symbol snapshot endpoint (`/v2/stocks/snapshots?symbols=...&feed=iex`), which
 * returns latest trade + latest quote + daily/prev-daily bars per symbol in ONE call. The `feed`
 * (iex vs sip) is what the free tier gates — the snapshot endpoint itself is available on free.
 */
export class AlpacaQuoteProvider implements QuoteProvider {
  readonly name = 'alpaca';

  constructor(private readonly cfg: AlpacaConfig) {}

  private headers(): Record<string, string> {
    return {
      'APCA-API-KEY-ID': this.cfg.keyId,
      'APCA-API-SECRET-KEY': this.cfg.secretKey,
      Accept: 'application/json',
    };
  }

  async getQuotes(symbols: string[]): Promise<Map<string, Quote>> {
    const out = new Map<string, Quote>();
    const unique = [...new Set(symbols.map((s) => s.toUpperCase()))];
    if (unique.length === 0) return out;

    const url = new URL('/v2/stocks/snapshots', this.cfg.dataUrl);
    url.searchParams.set('symbols', unique.join(','));
    url.searchParams.set('feed', this.cfg.feed);

    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new AlpacaError(res.status, `snapshots failed: ${res.status} ${body.slice(0, 300)}`);
    }

    // Shape: { "AAPL": { latestTrade: { p, t }, latestQuote: { ap, bp, t }, prevDailyBar: { c } }, ... }
    const data = (await res.json()) as Record<string, AlpacaSnapshot>;
    for (const [symbol, snap] of Object.entries(data)) {
      const q = toQuote(symbol, snap, `alpaca:${this.cfg.feed}`);
      if (q) out.set(symbol, q);
    }
    return out;
  }
}

export class AlpacaError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AlpacaError';
  }
}

interface AlpacaBar {
  c?: number;
}
interface AlpacaSnapshot {
  latestTrade?: { p?: number; t?: string };
  latestQuote?: { ap?: number; bp?: number; t?: string };
  dailyBar?: AlpacaBar;
  prevDailyBar?: AlpacaBar;
}

function toQuote(symbol: string, snap: AlpacaSnapshot, source: string): Quote | null {
  // Prefer the latest trade; fall back to the quote midpoint if no trade is present.
  let price = snap.latestTrade?.p;
  let asOfStr = snap.latestTrade?.t;
  if (price == null && snap.latestQuote?.ap != null && snap.latestQuote?.bp != null) {
    price = (snap.latestQuote.ap + snap.latestQuote.bp) / 2;
    asOfStr = snap.latestQuote.t;
  }
  if (price == null) return null;

  return {
    symbol: symbol.toUpperCase(),
    price,
    prevClose: snap.prevDailyBar?.c ?? null,
    asOf: asOfStr ? new Date(asOfStr) : new Date(),
    source,
  };
}
