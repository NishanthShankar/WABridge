import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { listGroupsSchema } from './groups.schema.js';
import { createGroupsService } from './groups.service.js';
import { getContext } from '../context.js';

/**
 * Create the groups API router.
 *
 * Routes:
 * - POST /sync  — Sync groups from WhatsApp
 * - GET /       — List groups (query: search, limit, offset)
 * - GET /:id    — Get single group by JID
 */
export function createGroupsRouter() {
  const router = new Hono();

  function getService(c: Parameters<typeof getContext>[0]) {
    const ctx = getContext(c);
    return createGroupsService(ctx.db, ctx.getSocket);
  }

  // SYNC groups from WhatsApp
  router.post('/sync', async (c) => {
    try {
      const service = getService(c);
      const result = await service.syncGroups();
      return c.json(result);
    } catch (err) {
      const message = (err as Error).message;
      if (message === 'WhatsApp not connected') {
        return c.json({ error: message }, 503);
      }
      return c.json({ error: message }, 500);
    }
  });

  // LIST groups
  router.get(
    '/',
    zValidator('query', listGroupsSchema),
    async (c) => {
      const service = getService(c);
      const filters = c.req.valid('query');
      const result = service.list(filters);
      return c.json(result);
    },
  );

  // GET single group
  router.get('/:id', async (c) => {
    const service = getService(c);
    const id = c.req.param('id');
    const group = service.getById(id);
    if (!group) return c.json({ error: 'Group not found' }, 404);
    return c.json(group);
  });

  return router;
}
