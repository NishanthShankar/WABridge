import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { webhookCreateSchema, webhookUpdateSchema } from './webhooks.schema.js';
import { createWebhooksService } from './webhooks.service.js';
import { getContext } from '../context.js';

export function createWebhooksRouter() {
  const router = new Hono();

  // CREATE
  router.post(
    '/',
    zValidator('json', webhookCreateSchema),
    async (c) => {
      const { db } = getContext(c);
      const service = createWebhooksService(db);
      const data = c.req.valid('json');
      const webhook = service.create(data);
      return c.json(webhook, 201);
    },
  );

  // LIST
  router.get('/', async (c) => {
    const { db } = getContext(c);
    const service = createWebhooksService(db);
    return c.json(service.list());
  });

  // GET
  router.get('/:id', async (c) => {
    const { db } = getContext(c);
    const service = createWebhooksService(db);
    const webhook = service.getById(c.req.param('id'));
    if (!webhook) return c.json({ error: 'Webhook not found' }, 404);
    return c.json(webhook);
  });

  // UPDATE
  router.put(
    '/:id',
    zValidator('json', webhookUpdateSchema),
    async (c) => {
      const { db } = getContext(c);
      const service = createWebhooksService(db);
      const webhook = service.update(c.req.param('id'), c.req.valid('json'));
      if (!webhook) return c.json({ error: 'Webhook not found' }, 404);
      return c.json(webhook);
    },
  );

  // DELETE
  router.delete('/:id', async (c) => {
    const { db } = getContext(c);
    const service = createWebhooksService(db);
    const deleted = service.delete(c.req.param('id'));
    if (!deleted) return c.json({ error: 'Webhook not found' }, 404);
    return c.json({ deleted: true });
  });

  return router;
}
