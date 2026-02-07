import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { labelCreateSchema, labelUpdateSchema } from './labels.schema.js';
import { createLabelsService } from './labels.service.js';
import { getContext } from '../context.js';

/**
 * Create the labels API router.
 *
 * Routes:
 * - POST /          Create label
 * - GET /           List all labels
 * - PUT /:id        Update label
 * - DELETE /:id     Delete label
 */
export function createLabelsRouter() {
  const router = new Hono();

  // CREATE
  router.post(
    '/',
    zValidator('json', labelCreateSchema),
    async (c) => {
      const { db } = getContext(c);
      const service = createLabelsService(db);
      const data = c.req.valid('json');
      const result = service.create(data);

      if (result.conflict) {
        return c.json({ error: `Label "${data.name}" already exists` }, 409);
      }

      return c.json(result.label, 201);
    },
  );

  // LIST
  router.get('/', async (c) => {
    const { db } = getContext(c);
    const service = createLabelsService(db);
    const result = service.list();
    return c.json(result);
  });

  // UPDATE
  router.put(
    '/:id',
    zValidator('json', labelUpdateSchema),
    async (c) => {
      const { db } = getContext(c);
      const service = createLabelsService(db);
      const id = c.req.param('id');
      const data = c.req.valid('json');

      try {
        const label = service.update(id, data);
        if (!label) return c.json({ error: 'Label not found' }, 404);
        return c.json(label);
      } catch (err) {
        if ((err as Error).message?.includes('UNIQUE constraint failed')) {
          return c.json({ error: `Label "${data.name}" already exists` }, 409);
        }
        throw err;
      }
    },
  );

  // DELETE
  router.delete('/:id', async (c) => {
    const { db } = getContext(c);
    const service = createLabelsService(db);
    const id = c.req.param('id');
    const deleted = service.delete(id);
    if (!deleted) return c.json({ error: 'Label not found' }, 404);
    return c.json({ deleted: true });
  });

  return router;
}
