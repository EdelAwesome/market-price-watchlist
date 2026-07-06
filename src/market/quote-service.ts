import type { Clock } from './clock.js';
import type { CacheStore } from './cache.js';
import type { Quote, QuoteProvider } from './provider.js';
import { TokenBucket } from './rate-limit.js';
import { withRetry, retryableHttp, type RetryOptions } from './retry.js';
import { classifyStaleness, type StalenessBounds } from './staleness.js';
import { MarketCalendar } from './market-hours.js';

export interface QuoteResult {
  symbol: string;
  price: number;
  prevClose: number | null;
  asOf: Date;
  source: string;
  fromCache: boolean; // served from cache without hitting the provider this call
  degraded: boolean; // served last-known because the provider was unavailable
  ageSeconds: number;
  okForAlerts: boolean; // fresh enough to evaluate an alert (strict bound)
  okForDisplay: boolean; // fresh enough to show unflagged (lenient bound)
}

export interface QuoteServiceConfig {
  ttlSeconds: number; // don't re-hit the provider within this window
  staleness: StalenessBounds;
  retry: Omit<RetryOptions, 'isRetryable'>;
}

export interface QuoteServiceDeps {
  provider: QuoteProvider;
  cache: CacheStore<Quote>;
  clock: Clock;
  rateLimiter: TokenBucket;
  calendar: MarketCalendar;
  config: QuoteServiceConfig;
}

/**
 * The cached / deduped / rate-limited / market-hours-aware quote layer. This is the core slice-2
 * deliverable and is entirely provider-agnostic (depends only on QuoteProvider). Guarantees:
 *  - Dedup: a symbol requested N times (across the universe or concurrently) costs 1 upstream call.
 *  - Cache-through: within TTL, served from cache; only misses hit the provider.
 *  - Batch: all misses go out in a single provider.getQuotes() call.
 *  - Market-hours aware: when the market is closed, a cached value is served without refetching
 *    (don't burn quota at 3am) — only a true cache miss reaches the provider.
 *  - Backoff: provider calls are rate-limited (token bucket) and retried with jittered backoff.
 *  - Degrade: if the provider is down, serve the last-known cached value flagged degraded/stale
 *    instead of throwing — the alert run must never crash, and never fire on this stale data.
 */
export class QuoteService {
  // In-flight batch promise per symbol: concurrent callers awaiting the same symbol share one call.
  private readonly inFlight = new Map<string, Promise<Map<string, Quote>>>();

  constructor(private readonly deps: QuoteServiceDeps) {}

  async getQuotes(symbols: string[]): Promise<Map<string, QuoteResult>> {
    const { cache, clock, config, calendar } = this.deps;
    const now = clock.now();
    const marketOpen = calendar.isOpen(now);
    const wanted = [...new Set(symbols.map((s) => s.toUpperCase()))]; // dedup the universe

    const results = new Map<string, QuoteResult>();
    const misses: string[] = [];

    for (const sym of wanted) {
      const entry = await cache.get(sym);
      if (entry) {
        const ageSinceStore = (now.getTime() - entry.storedAt.getTime()) / 1000;
        // Fresh if within TTL, OR the market is closed (no point refetching a static last close).
        if (ageSinceStore <= config.ttlSeconds || !marketOpen) {
          results.set(sym, this.toResult(entry.value, now, { fromCache: true, degraded: false }));
          continue;
        }
      }
      misses.push(sym);
    }

    if (misses.length > 0) {
      let fetched: Map<string, Quote>;
      try {
        fetched = await this.fetchThroughInFlight(misses);
      } catch (err) {
        // Provider is down after retries: DEGRADE. Serve last-known for any miss we have cached;
        // omit the rest. Never throw — the caller (incl. the alert run) must survive an outage.
        for (const sym of misses) {
          const entry = await cache.get(sym);
          if (entry) {
            results.set(sym, this.toResult(entry.value, now, { fromCache: true, degraded: true }));
          }
        }
        return results;
      }

      for (const sym of misses) {
        const q = fetched.get(sym);
        if (q) {
          await cache.set(sym, q);
          results.set(sym, this.toResult(q, now, { fromCache: false, degraded: false }));
        } else {
          // Provider returned OK but had no data for this symbol: fall back to last-known if any.
          const entry = await cache.get(sym);
          if (entry) {
            results.set(sym, this.toResult(entry.value, now, { fromCache: true, degraded: true }));
          }
        }
      }
    }

    return results;
  }

  /**
   * Coalesce concurrent fetches: symbols already in flight reuse that promise; only genuinely-new
   * symbols form a fresh batch. Result: overlapping getQuotes() calls collapse to one upstream call.
   */
  private async fetchThroughInFlight(symbols: string[]): Promise<Map<string, Quote>> {
    const toFetch: string[] = [];
    const awaited = new Map<string, Promise<Map<string, Quote>>>();

    for (const sym of symbols) {
      const pending = this.inFlight.get(sym);
      if (pending) awaited.set(sym, pending);
      else toFetch.push(sym);
    }

    if (toFetch.length > 0) {
      const batch = this.fetchBatch(toFetch).finally(() => {
        for (const sym of toFetch) this.inFlight.delete(sym);
      });
      for (const sym of toFetch) this.inFlight.set(sym, batch);
      for (const sym of toFetch) awaited.set(sym, batch);
    }

    const merged = new Map<string, Quote>();
    // Await each distinct batch promise once, then pick out the symbols we asked for.
    for (const batch of new Set(awaited.values())) {
      const got = await batch;
      for (const [sym, q] of got) if (symbols.includes(sym)) merged.set(sym, q);
    }
    return merged;
  }

  private fetchBatch(symbols: string[]): Promise<Map<string, Quote>> {
    const { provider, rateLimiter, config } = this.deps;
    return withRetry(
      async () => {
        await rateLimiter.acquire(1); // one snapshot call regardless of symbol count
        return provider.getQuotes(symbols);
      },
      { ...config.retry, isRetryable: retryableHttp },
    );
  }

  private toResult(
    q: Quote,
    now: Date,
    flags: { fromCache: boolean; degraded: boolean },
  ): QuoteResult {
    const s = classifyStaleness(q.asOf, now, this.deps.config.staleness);
    return {
      symbol: q.symbol,
      price: q.price,
      prevClose: q.prevClose,
      asOf: q.asOf,
      source: q.source,
      fromCache: flags.fromCache,
      degraded: flags.degraded,
      ageSeconds: s.ageSeconds,
      okForAlerts: s.okForAlerts,
      okForDisplay: s.okForDisplay,
    };
  }
}
