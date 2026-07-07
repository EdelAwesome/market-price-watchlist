import { env } from '../config/env.js';
import { systemClock, realSleep } from './clock.js';
import { TokenBucket } from './rate-limit.js';
import { MarketCalendar } from './market-hours.js';
import { QuoteService } from './quote-service.js';
import { makeQuoteProvider } from './factory.js';
import { RedisCacheStore, quoteCodec } from './redis-cache.js';
import { makeCacheRedis } from '../queue/connection.js';
import type { EvalQuote } from '../alerts/fsm.js';

/**
 * Build the production QuoteService: Alpaca provider behind the Redis-cached, deduped,
 * rate-limited layer. Cache retention outlives the freshness TTL so the degrade path can serve a
 * last-known quote during a provider outage.
 */
export function makeQuoteService(): QuoteService {
  const retentionSeconds = Math.max(env.DISPLAY_STALENESS_SECONDS * 4, env.QUOTE_TTL_SECONDS * 20);
  return new QuoteService({
    provider: makeQuoteProvider(),
    cache: new RedisCacheStore(makeCacheRedis(), {
      namespace: 'quote',
      retentionSeconds,
      codec: quoteCodec,
      clock: systemClock,
    }),
    clock: systemClock,
    // Alpaca free = 200 req/min.
    rateLimiter: new TokenBucket(200, 200 / 60, systemClock, realSleep),
    calendar: new MarketCalendar(),
    config: {
      ttlSeconds: env.QUOTE_TTL_SECONDS,
      staleness: { alertSec: env.ALERT_STALENESS_SECONDS, displaySec: env.DISPLAY_STALENESS_SECONDS },
      retry: { retries: 4, baseMs: 250, maxMs: 4000, sleep: realSleep, rng: () => Math.random() },
    },
  });
}

/** Adapter: QuoteService results -> the EvalQuote map the poll cycle/FSM consume. */
export function makeGetQuotes(svc: QuoteService) {
  return async (symbols: string[]): Promise<Map<string, EvalQuote>> => {
    const results = await svc.getQuotes(symbols);
    const out = new Map<string, EvalQuote>();
    for (const [symbol, r] of results) {
      out.set(symbol, { price: r.price, asOf: r.asOf, okForAlerts: r.okForAlerts });
    }
    return out;
  };
}
