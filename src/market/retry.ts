/**
 * Retry with exponential backoff + jitter. Sleep and RNG are injected so backoff is deterministic
 * in tests. Only retries errors deemed retryable (429 / 5xx) — a 4xx (bad symbol, auth) fails fast.
 */
export interface RetryOptions {
  retries: number;
  baseMs: number;
  maxMs: number;
  sleep: (ms: number) => Promise<void>;
  rng: () => number; // [0,1); inject a fixed value in tests
  isRetryable: (err: unknown) => boolean;
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= opts.retries || !opts.isRetryable(err)) throw err;
      const capped = Math.min(opts.maxMs, opts.baseMs * 2 ** attempt);
      // Full jitter over the exponential window: delay in [0, capped].
      const delayMs = Math.floor(capped * opts.rng());
      opts.onRetry?.(attempt + 1, delayMs, err);
      await opts.sleep(delayMs);
      attempt++;
    }
  }
}

/** Retryable = HTTP 429 or any 5xx (errors carrying a numeric `status`). */
export function retryableHttp(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return status === 429 || (typeof status === 'number' && status >= 500 && status < 600);
}
