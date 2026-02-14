import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { Queue } from 'bullmq';
import {
  scheduleMessageSchema,
  editMessageSchema,
  listMessagesSchema,
  createRecurringRuleSchema,
  updateRecurringRuleSchema,
  listRecurringRulesSchema,
  bulkScheduleSchema,
} from './scheduling.schema.js';
import { createSchedulingService } from './scheduling.service.js';
import { getContext } from '../context.js';

/**
 * Create the scheduling API router.
 *
 * Routes:
 * - POST /              Schedule message (or send immediately if no scheduledAt)
 * - POST /bulk          Bulk schedule messages
 * - GET /               List messages with query filters
 * - GET /:id            Get single message
 * - PATCH /:id          Edit pending message (content/scheduledAt/media)
 * - PATCH /:id/cancel   Cancel pending message
 * - POST /:id/retry     Retry failed message
 * - POST /recurring              Create recurring rule
 * - GET /recurring               List recurring rules
 * - GET /recurring/:id           Get single recurring rule
 * - PATCH /recurring/:id         Update recurring rule
 * - DELETE /recurring/:id        Delete (disable) recurring rule
 */
export function createSchedulingRouter(queue: Queue) {
  const router = new Hono();

  /** Create a scheduling service from the current request's context */
  function getService(c: Parameters<typeof getContext>[0]) {
    const ctx = getContext(c);
    return createSchedulingService(ctx.db, queue, ctx.config, ctx.rateLimiter, ctx.tenantId);
  }

  // SCHEDULE / SEND IMMEDIATELY
  router.post(
    '/',
    zValidator('json', scheduleMessageSchema),
    async (c) => {
      const { contactId, phone, name, groupId, content, scheduledAt, mediaUrl, mediaType } = c.req.valid('json');
      try {
        const service = getService(c);
        const msg = await service.scheduleMessage(contactId, content, scheduledAt, phone, name, mediaUrl, mediaType, groupId);
        return c.json(msg, 201);
      } catch (err) {
        const error = err as Error & { statusCode?: number };
        if (error.message === 'Contact not found') {
          return c.json({ error: error.message }, 404);
        }
        if (error.statusCode === 429) {
          return c.json({ error: error.message }, 429);
        }
        return c.json({ error: error.message }, 500);
      }
    },
  );

  // BULK SCHEDULE
  router.post(
    '/bulk',
    zValidator('json', bulkScheduleSchema),
    async (c) => {
      const { messages } = c.req.valid('json');
      try {
        const service = getService(c);
        const result = await service.bulkScheduleMessages(messages);
        return c.json(result, 201);
      } catch (err) {
        const error = err as Error & { statusCode?: number };
        if (error.statusCode === 429) {
          return c.json({ error: error.message }, 429);
        }
        return c.json({ error: (err as Error).message }, 500);
      }
    },
  );

  // LIST with filters
  router.get(
    '/',
    zValidator('query', listMessagesSchema),
    async (c) => {
      const service = getService(c);
      const filters = c.req.valid('query');
      const result = service.listMessages(filters);
      return c.json(result);
    },
  );

  // GET single message
  router.get('/:id', async (c) => {
    const service = getService(c);
    const id = c.req.param('id');
    const msg = service.getMessage(id);
    if (!msg) return c.json({ error: 'Message not found' }, 404);
    return c.json(msg);
  });

  // EDIT pending message
  router.patch(
    '/:id',
    zValidator('json', editMessageSchema),
    async (c) => {
      const service = getService(c);
      const id = c.req.param('id');
      const updates = c.req.valid('json');
      try {
        const msg = await service.editMessage(id, updates);
        if (!msg) {
          return c.json(
            { error: 'Message not found or not in pending status' },
            404,
          );
        }
        return c.json(msg);
      } catch (err) {
        return c.json({ error: (err as Error).message }, 500);
      }
    },
  );

  // CANCEL pending message
  router.patch('/:id/cancel', async (c) => {
    const service = getService(c);
    const id = c.req.param('id');
    try {
      const msg = await service.cancelMessage(id);
      if (!msg) {
        return c.json(
          { error: 'Message not found or not in pending status' },
          404,
        );
      }
      return c.json(msg);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // RETRY failed message
  router.post('/:id/retry', async (c) => {
    const service = getService(c);
    const id = c.req.param('id');
    try {
      const msg = await service.retryMessage(id);
      if (!msg) {
        return c.json(
          { error: 'Message not found or not in failed status' },
          404,
        );
      }
      return c.json(msg);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // ─── Recurring Rules Routes ────────────────────────────────────────────

  // CREATE recurring rule
  router.post(
    '/recurring',
    zValidator('json', createRecurringRuleSchema),
    async (c) => {
      const service = getService(c);
      const data = c.req.valid('json');
      try {
        const rule = await service.createRecurringRule(data);
        return c.json(rule, 201);
      } catch (err) {
        const message = (err as Error).message;
        if (message === 'Contact not found') {
          return c.json({ error: message }, 404);
        }
        return c.json({ error: message }, 500);
      }
    },
  );

  // LIST recurring rules
  router.get(
    '/recurring',
    zValidator('query', listRecurringRulesSchema),
    async (c) => {
      const service = getService(c);
      const filters = c.req.valid('query');
      const result = service.listRecurringRules(filters);
      return c.json(result);
    },
  );

  // GET single recurring rule
  router.get('/recurring/:id', async (c) => {
    const service = getService(c);
    const id = c.req.param('id');
    const rule = service.getRecurringRule(id);
    if (!rule) return c.json({ error: 'Recurring rule not found' }, 404);
    return c.json(rule);
  });

  // UPDATE recurring rule
  router.patch(
    '/recurring/:id',
    zValidator('json', updateRecurringRuleSchema),
    async (c) => {
      const service = getService(c);
      const id = c.req.param('id');
      const updates = c.req.valid('json');
      try {
        const rule = await service.updateRecurringRule(id, updates);
        if (!rule) {
          return c.json({ error: 'Recurring rule not found' }, 404);
        }
        return c.json(rule);
      } catch (err) {
        return c.json({ error: (err as Error).message }, 500);
      }
    },
  );

  // DELETE (disable) recurring rule
  router.delete('/recurring/:id', async (c) => {
    const service = getService(c);
    const id = c.req.param('id');
    try {
      const rule = await service.deleteRecurringRule(id);
      if (!rule) {
        return c.json({ error: 'Recurring rule not found' }, 404);
      }
      return c.json(rule);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  return router;
}
