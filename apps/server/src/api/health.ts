import { Hono } from 'hono';
import { getContext } from '../context.js';

/**
 * Create the health API router.
 * GET /api/health returns JSON health status.
 */
export function createHealthRouter() {
  const router = new Hono();

  router.get('/health', (c) => {
    const { getHealth } = getContext(c);
    // `features` lets a client check what this server can do before it relies on it.
    return c.json({ ...getHealth(), features: ['webhook-reply-actions'] });
  });

  return router;
}
