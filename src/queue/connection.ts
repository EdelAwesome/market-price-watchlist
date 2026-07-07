import type { ConnectionOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';

/** A Redis client on the CACHE db (separate from the queue db so eviction can't drop jobs). */
export function makeCacheRedis(): Redis {
  const url = new URL(env.REDIS_URL);
  return new Redis({
    host: url.hostname,
    port: Number(url.port || 6379),
    db: env.REDIS_CACHE_DB,
    maxRetriesPerRequest: null,
  });
}

/**
 * Redis connection OPTIONS for BullMQ (BullMQ creates/owns its own connections per queue/worker,
 * so worker.close() tears them down cleanly). `maxRetriesPerRequest: null` is required by BullMQ.
 * Queue data lives on REDIS_QUEUE_DB (0), separate from the quote cache DB (1) so cache eviction
 * can never drop queue keys — see DECISIONS "Redis eviction isolation".
 */
export function makeQueueConnectionOptions(): ConnectionOptions {
  const url = new URL(env.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    db: env.REDIS_QUEUE_DB,
    maxRetriesPerRequest: null,
  };
}

export const QUEUE_NAMES = {
  poll: 'alert-poll',
  email: 'alert-email',
} as const;
