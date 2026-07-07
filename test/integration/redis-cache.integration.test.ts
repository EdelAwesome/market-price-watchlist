import { describe, it, expect, afterAll } from 'vitest';
import type { Redis } from 'ioredis';
import { makeCacheRedis } from '../../src/queue/connection.js';
import { RedisCacheStore, quoteCodec } from '../../src/market/redis-cache.js';
import { systemClock } from '../../src/market/clock.js';
import type { Quote } from '../../src/market/provider.js';

const redis: Redis = makeCacheRedis();
const store = new RedisCacheStore<Quote>(redis, {
  namespace: 'test:quote',
  retentionSeconds: 60,
  codec: quoteCodec,
  clock: systemClock,
});
const K = `AAPL_${Date.now()}`;

afterAll(async () => {
  await redis.del(`test:quote:${K}`);
  await redis.quit();
});

describe('RedisCacheStore — verifies the Redis wiring against real Redis', () => {
  it('round-trips a Quote (value + Dates) and misses return undefined', async () => {
    expect(await store.get(K)).toBeUndefined();

    const asOf = new Date('2025-06-10T14:00:00Z');
    await store.set(K, { symbol: 'AAPL', price: 101.5, prevClose: 100, asOf, source: 'test' });

    const entry = await store.get(K);
    expect(entry).toBeDefined();
    expect(entry!.value.price).toBe(101.5);
    expect(entry!.value.asOf.toISOString()).toBe(asOf.toISOString()); // Date survived JSON
    expect(entry!.storedAt).toBeInstanceOf(Date);

    // retention TTL is set (entry outlives the freshness TTL for the degrade path)
    const ttl = await redis.ttl(`test:quote:${K}`);
    expect(ttl).toBeGreaterThan(0);
  });
});
