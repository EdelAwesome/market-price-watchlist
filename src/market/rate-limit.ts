import type { Clock } from './clock.js';

/**
 * Token-bucket rate limiter sized to the provider's budget (Alpaca free = 200 req/min).
 * Time and sleep are injected so it is fully deterministic under a FakeClock.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly clock: Clock,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {
    this.tokens = capacity;
    this.lastRefillMs = clock.now().getTime();
  }

  private refill(): void {
    const nowMs = this.clock.now().getTime();
    const elapsedSec = (nowMs - this.lastRefillMs) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
    this.lastRefillMs = nowMs;
  }

  /** Non-blocking: returns true and consumes n tokens if available, else false. */
  tryRemove(n = 1): boolean {
    this.refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  /** Blocks (via injected sleep) until n tokens are available, then consumes them. */
  async acquire(n = 1): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= n) {
        this.tokens -= n;
        return;
      }
      const deficit = n - this.tokens;
      const waitMs = Math.max(1, Math.ceil((deficit / this.refillPerSec) * 1000));
      await this.sleep(waitMs);
    }
  }

  get available(): number {
    this.refill();
    return this.tokens;
  }
}
