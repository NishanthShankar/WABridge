/**
 * Exponential backoff with jitter for WhatsApp reconnection.
 *
 * Sequence with defaults (1s base, 60s max):
 *   ~1s, ~2s, ~4s, ~8s, ~16s, ~32s, ~60s, 60s, 60s... (capped)
 *
 * Each value has +/- 20% random jitter to prevent thundering herd.
 */

export interface BackoffConfig {
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * Calculate the backoff delay for a given attempt number.
 * Formula: min(baseDelay * 2^attempt, maxDelay) * (1 + random(-0.2, 0.2))
 */
export function calculateBackoff(
  attempt: number,
  config: BackoffConfig,
): number {
  const { baseDelayMs, maxDelayMs } = config;
  const exponentialDelay = Math.min(
    baseDelayMs * 2 ** attempt,
    maxDelayMs,
  );
  // Jitter: multiply by a factor between 0.8 and 1.2
  const jitterFactor = 1 + (Math.random() * 2 - 1) * 0.2;
  return exponentialDelay * jitterFactor;
}

/**
 * Check if the retry window has been exhausted.
 * Returns true if more than maxRetryMs have passed since retryStartedAt.
 */
export function isRetryWindowExhausted(
  retryStartedAt: Date,
  maxRetryMs: number,
): boolean {
  return Date.now() - retryStartedAt.getTime() > maxRetryMs;
}
