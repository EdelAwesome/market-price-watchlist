import type { Clock } from './clock.js';

/**
 * Cache seam. The QuoteService depends only on this interface; an in-memory impl backs tests and
 * the Redis impl lands at the end of slice 2. Entries are NEVER auto-evicted here — we keep the
 * last-known value even after its TTL so the degrade path can serve it (flagged stale).
 */
export interface CacheEntry<T> {
  value: T;
  storedAt: Date; // when WE cached it — drives TTL freshness (distinct from the quote's own asOf)
}

export interface CacheStore<T> {
  get(key: string): Promise<CacheEntry<T> | undefined>;
  set(key: string, value: T): Promise<void>;
}

export class InMemoryCacheStore<T> implements CacheStore<T> {
  private readonly m = new Map<string, CacheEntry<T>>();
  constructor(private readonly clock: Clock) {}

  async get(key: string): Promise<CacheEntry<T> | undefined> {
    return this.m.get(key);
  }

  async set(key: string, value: T): Promise<void> {
    this.m.set(key, { value, storedAt: this.clock.now() });
  }
}
