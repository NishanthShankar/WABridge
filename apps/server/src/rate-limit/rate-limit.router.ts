import { Hono } from 'hono';
import { getContext } from '../context.js';

/**
 * Create the rate limit status router.
 *
 * Routes:
 * - GET /status -> Current rate limit state (sent today, cap, remaining, reset time)
 */
export function createRateLimitRouter() {
  const router = new Hono();

  /**
   * GET /status
   *
   * Returns the current rate limit status:
   * - sentToday: number of messages sent today (IST)
   * - dailyCap: configured daily message cap
   * - remaining: messages remaining before cap
   * - resetAt: ISO timestamp of next midnight IST
   * - warning: true if sentToday >= warn threshold (80% by default)
   */
  router.get('/status', (c) => {
    const { rateLimiter } = getContext(c);
    const status = rateLimiter.getStatus();
    return c.json(status);
  });

  return router;
}
