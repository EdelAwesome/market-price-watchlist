import type { Redis } from 'ioredis';
import type { Clock } from './clock.js';
import type { CacheStore, CacheEntry } from './cache.js';
import type { Quote } from './provider.js';

/**
 * Redis-backed CacheStore — the production swap for InMemoryCacheStore, same interface.
 *
 * Key detail preserved from the in-memory store: we do NOT expire entries at the freshness TTL.
 * Freshness is decided by the QuoteService from `storedAt`; the entry must OUTLIVE its freshness so
 * the degrade path can still serve a last-known quote (flagged stale) when the provider is down.
 * `retentionSeconds` is that longer survival bound (independent of, and >, the quote TTL).
 *
 * Values are JSON-encoded via an injected codec (Dates don't survive raw JSON), so the store stays
 * generic while handling `asOf`/`storedAt` correctly.
 */
export interface CacheCodec<T> {
  encode: (value: T) => unknown;
  decode: (raw: unknown) => T;
}

export class RedisCacheStore<T> implements CacheStore<T> {
  constructor(
    private readonly redis: Redis,
    private readonly opts: {
      namespace: string;
      retentionSeconds: number;
      codec: CacheCodec<T>;
      clock: Clock;
    },
  ) {}

  private key(k: string): string {
    return `${this.opts.namespace}:${k}`;
  }

  async get(key: string): Promise<CacheEntry<T> | undefined> {
    const raw = await this.redis.get(this.key(key));
    if (raw == null) return undefined;
    const parsed = JSON.parse(raw) as { v: unknown; s: string };
    return { value: this.opts.codec.decode(parsed.v), storedAt: new Date(parsed.s) };
  }

  async set(key: string, value: T): Promise<void> {
    const payload = JSON.stringify({
      v: this.opts.codec.encode(value),
      s: this.opts.clock.now().toISOString(),
    });
    await this.redis.set(this.key(key), payload, 'EX', this.opts.retentionSeconds);
  }
}

/** Codec for Quote — handles the `asOf` Date across JSON. */
export const quoteCodec: CacheCodec<Quote> = {
  encode: (q) => ({ ...q, asOf: q.asOf.toISOString() }),
  decode: (raw) => {
    const o = raw as { symbol: string; price: number; prevClose: number | null; asOf: string; source: string };
    return {
      symbol: o.symbol,
      price: o.price,
      prevClose: o.prevClose ?? null,
      asOf: new Date(o.asOf),
      source: o.source,
    };
  },
};
