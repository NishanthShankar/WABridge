import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  templateCreateSchema,
  templateUpdateSchema,
  templatePreviewSchema,
} from './templates.schema.js';
import { createTemplatesService } from './templates.service.js';
import { getContext } from '../context.js';

/**
 * Create the templates API router.
 *
 * Routes:
 * - POST /              Create template
 * - GET /               List all templates
 * - GET /:id            Get single template
 * - PUT /:id            Update template
 * - DELETE /:id         Delete template
 * - POST /:id/preview   Preview template with contact data
 */
export function createTemplatesRouter() {
  const router = new Hono();

  // CREATE
  router.post(
    '/',
    zValidator('json', templateCreateSchema),
    async (c) => {
      const { db } = getContext(c);
      const service = createTemplatesService(db);
      const data = c.req.valid('json');
      const result = service.create(data);

      if (result.conflict) {
        return c.json({ error: `Template "${data.name}" already exists` }, 409);
      }

      return c.json(result.template, 201);
    },
  );

  // LIST
  router.get('/', async (c) => {
    const { db } = getContext(c);
    const service = createTemplatesService(db);
    const result = service.list();
    return c.json(result);
  });

  // GET single
  router.get('/:id', async (c) => {
    const { db } = getContext(c);
    const service = createTemplatesService(db);
    const id = c.req.param('id');
    const template = service.getById(id);
    if (!template) return c.json({ error: 'Template not found' }, 404);
    return c.json(template);
  });

  // UPDATE
  router.put(
    '/:id',
    zValidator('json', templateUpdateSchema),
    async (c) => {
      const { db } = getContext(c);
      const service = createTemplatesService(db);
      const id = c.req.param('id');
      const data = c.req.valid('json');

      const result = service.update(id, data);
      if (!result) return c.json({ error: 'Template not found' }, 404);
      if ('conflict' in result) {
        return c.json({ error: `Template "${data.name}" already exists` }, 409);
      }
      return c.json(result);
    },
  );

  // DELETE
  router.delete('/:id', async (c) => {
    const { db } = getContext(c);
    const service = createTemplatesService(db);
    const id = c.req.param('id');
    const deleted = service.delete(id);
    if (!deleted) return c.json({ error: 'Template not found' }, 404);
    return c.json({ deleted: true });
  });

  // PREVIEW - resolve template variables against a contact
  router.post(
    '/:id/preview',
    zValidator('json', templatePreviewSchema),
    async (c) => {
      const { db } = getContext(c);
      const service = createTemplatesService(db);
      const templateId = c.req.param('id');
      const { contactId } = c.req.valid('json');

      const result = service.preview(templateId, contactId);

      if ('error' in result) {
        return c.json({ error: result.error }, 404);
      }

      return c.json(result);
    },
  );

  return router;
}
