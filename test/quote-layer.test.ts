import { describe, it, expect } from 'vitest';
import { FakeClock, fakeSleep } from '../src/market/clock.js';
import { InMemoryCacheStore } from '../src/market/cache.js';
import { TokenBucket } from '../src/market/rate-limit.js';
import { withRetry, retryableHttp } from '../src/market/retry.js';
import { classifyStaleness } from '../src/market/staleness.js';
import { MarketCalendar } from '../src/market/market-hours.js';
import { MockQuoteProvider } from '../src/market/mock-provider.js';
import { QuoteService } from '../src/market/quote-service.js';
import { ProviderHttpError, type Quote } from '../src/market/provider.js';

const OPEN_NOW = new Date('2025-06-10T18:00:00Z'); // Tue 14:00 ET — market open
const WEEKEND_NOW = new Date('2025-06-14T18:00:00Z'); // Sat — market closed

function makeService(now: Date, prices: Record<string, number> = { AAPL: 100, MSFT: 200, SPY: 500 }) {
  const clock = new FakeClock(now);
  const provider = new MockQuoteProvider(clock, prices);
  const cache = new InMemoryCacheStore<Quote>(clock);
  const rateLimiter = new TokenBucket(100, 100, clock, fakeSleep(clock));
  const calendar = new MarketCalendar();
  const svc = new QuoteService({
    provider,
    cache,
    clock,
    rateLimiter,
    calendar,
    config: {
      ttlSeconds: 60,
      staleness: { alertSec: 90, displaySec: 300 },
      retry: { retries: 3, baseMs: 10, maxMs: 100, sleep: fakeSleep(clock), rng: () => 0.5 },
    },
  });
  return { svc, provider, clock, cache, calendar };
}

describe('classifyStaleness — two independent bounds', () => {
  const now = new Date('2025-06-10T18:00:00Z');
  const bounds = { alertSec: 90, displaySec: 300 };
  it('fresh: ok for both', () => {
    const r = classifyStaleness(new Date(now.getTime() - 30_000), now, bounds);
    expect(r.okForAlerts).toBe(true);
    expect(r.okForDisplay).toBe(true);
  });
  it('stale for alerts but ok for display', () => {
    const r = classifyStaleness(new Date(now.getTime() - 120_000), now, bounds);
    expect(r.okForAlerts).toBe(false);
    expect(r.okForDisplay).toBe(true);
  });
  it('stale for both', () => {
    const r = classifyStaleness(new Date(now.getTime() - 400_000), now, bounds);
    expect(r.okForAlerts).toBe(false);
    expect(r.okForDisplay).toBe(false);
  });
});

describe('MarketCalendar (NYSE, ET)', () => {
  const cal = new MarketCalendar();
  it('open midday on a weekday', () => {
    expect(cal.isOpen(new Date('2025-06-10T18:00:00Z'))).toBe(true); // 14:00 ET Tue
  });
  it('closed before the open', () => {
    expect(cal.isOpen(new Date('2025-06-10T13:00:00Z'))).toBe(false); // 09:00 ET
  });
  it('closed at/after 16:00 ET', () => {
    expect(cal.isOpen(new Date('2025-06-10T20:00:00Z'))).toBe(false); // 16:00 ET
  });
  it('closed on weekends', () => {
    expect(cal.isOpen(new Date('2025-06-14T18:00:00Z'))).toBe(false); // Sat
  });
  it('closed on a holiday (Christmas)', () => {
    expect(cal.isOpen(new Date('2025-12-25T15:00:00Z'))).toBe(false); // 10:00 ET
  });
});

describe('TokenBucket', () => {
  it('consumes then refuses when empty, refills over time', async () => {
    const clock = new FakeClock(OPEN_NOW);
    const bucket = new TokenBucket(2, 1, clock, fakeSleep(clock)); // cap 2, 1 token/sec
    expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(false); // empty
    await bucket.acquire(1); // must wait ~1s; fakeSleep advances the clock so it refills
    expect(bucket.tryRemove()).toBe(false); // that one token was consumed by acquire
  });
});

describe('withRetry', () => {
  it('retries retryable errors then succeeds; gives up on non-retryable', async () => {
    const clock = new FakeClock(OPEN_NOW);
    let attempts = 0;
    const value = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw new ProviderHttpError(503);
        return 'ok';
      },
      { retries: 3, baseMs: 10, maxMs: 100, sleep: fakeSleep(clock), rng: () => 0.5, isRetryable: retryableHttp },
    );
    expect(value).toBe('ok');
    expect(attempts).toBe(3);

    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new ProviderHttpError(400); // 4xx: not retryable
        },
        { retries: 3, baseMs: 10, maxMs: 100, sleep: fakeSleep(clock), rng: () => 0.5, isRetryable: retryableHttp },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe('QuoteService — dedup / cache / batch', () => {
  it('dedups repeated symbols within a call', async () => {
    const { svc, provider } = makeService(OPEN_NOW);
    await svc.getQuotes(['AAPL', 'AAPL', 'aapl']);
    expect(provider.callCount).toBe(1);
    expect(provider.calls[0]).toEqual(['AAPL']);
  });

  it('serves from cache within TTL (1 upstream call), refetches after TTL', async () => {
    const { svc, provider, clock } = makeService(OPEN_NOW);
    const first = await svc.getQuotes(['AAPL']);
    expect(first.get('AAPL')!.fromCache).toBe(false);

    const second = await svc.getQuotes(['AAPL']);
    expect(second.get('AAPL')!.fromCache).toBe(true);
    expect(provider.callCount).toBe(1); // no new upstream call within TTL

    clock.advance(61_000); // past 60s TTL
    await svc.getQuotes(['AAPL']);
    expect(provider.callCount).toBe(2);
  });

  it('batches all misses into ONE provider call', async () => {
    const { svc, provider } = makeService(OPEN_NOW);
    await svc.getQuotes(['AAPL', 'MSFT', 'SPY']);
    expect(provider.callCount).toBe(1);
    expect(provider.calls[0]!.sort()).toEqual(['AAPL', 'MSFT', 'SPY']);
  });

  it('coalesces concurrent requests for the same symbol into one upstream call', async () => {
    const { svc, provider } = makeService(OPEN_NOW);
    await Promise.all([svc.getQuotes(['AAPL']), svc.getQuotes(['AAPL']), svc.getQuotes(['AAPL'])]);
    expect(provider.callCount).toBe(1);
  });
});

describe('QuoteService — market-hours awareness', () => {
  it('when the market is closed, serves cache without refetching even past TTL', async () => {
    const { svc, provider, clock } = makeService(WEEKEND_NOW);
    await svc.getQuotes(['AAPL']); // cold miss fetches once (to get the last close)
    expect(provider.callCount).toBe(1);

    clock.advance(10 * 60_000); // 10 min later, still the weekend
    const r = await svc.getQuotes(['AAPL']);
    expect(r.get('AAPL')!.fromCache).toBe(true);
    expect(provider.callCount).toBe(1); // did NOT burn quota refetching while closed
  });
});

describe('QuoteService — graceful degrade', () => {
  it('serves last-known (flagged degraded, not alert-safe) when the provider is down', async () => {
    const { svc, provider, clock } = makeService(OPEN_NOW);
    await svc.getQuotes(['AAPL']); // seed cache while healthy
    expect(provider.callCount).toBe(1);

    clock.advance(120_000); // past TTL and past the 90s alert-staleness bound
    provider.failNext(4); // exceed the retry budget -> all attempts fail

    const r = await svc.getQuotes(['AAPL']); // must NOT throw
    const q = r.get('AAPL')!;
    expect(q.degraded).toBe(true);
    expect(q.fromCache).toBe(true);
    expect(q.okForAlerts).toBe(false); // critical: never fire an alert on degraded/stale data
    expect(q.price).toBe(100); // last-known value still served for display
  });
});
