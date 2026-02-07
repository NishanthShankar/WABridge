import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  contactCreateSchema,
  contactUpdateSchema,
  contactListQuerySchema,
} from './contacts.schema.js';
import { createContactsService } from './contacts.service.js';
import { createImportRouter } from '../import/import.router.js';
import { createLabelsService } from '../labels/labels.service.js';
import { createSchedulingService } from '../scheduling/scheduling.service.js';
import { labelAssignSchema } from '../labels/labels.schema.js';
import { getContext } from '../context.js';
import type { Queue } from 'bullmq';

/**
 * Create the contacts API router.
 *
 * Routes:
 * - POST /                      Create contact (upsert on phone)
 * - GET /                       List contacts (paginated, filterable)
 * - GET /:id                    Get single contact with labels
 * - PUT /:id                    Update contact
 * - DELETE /:id                 Delete contact
 * - POST /import                Import contacts from CSV/Excel (mounted separately)
 * - POST /:id/labels            Assign labels to contact
 * - DELETE /:id/labels/:labelId Remove label from contact
 *
 * Birthday create/update auto-syncs birthday reminders when queue is available.
 */
export function createContactsRouter(queue?: Queue) {
  const router = new Hono();

  // CREATE
  router.post(
    '/',
    zValidator('json', contactCreateSchema),
    async (c) => {
      const ctx = getContext(c);
      const service = createContactsService(ctx.db);
      const data = c.req.valid('json');
      try {
        const contact = service.create(data);

        // Auto-sync birthday reminder if birthday is provided
        if (queue && data.birthday) {
          const schedulingService = createSchedulingService(ctx.db, queue, ctx.config, ctx.rateLimiter, ctx.tenantId);
          await schedulingService.syncBirthdayReminder(
            contact.id,
            contact.birthday,
            contact.birthdayReminderEnabled,
            contact.name,
          );
        }

        return c.json(contact, 201);
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }
    },
  );

  // LIST (paginated)
  router.get(
    '/',
    zValidator('query', contactListQuerySchema),
    async (c) => {
      const { db } = getContext(c);
      const service = createContactsService(db);
      const query = c.req.valid('query');
      const result = service.list(query);
      return c.json(result);
    },
  );

  // GET single with labels
  router.get('/:id', async (c) => {
    const { db } = getContext(c);
    const service = createContactsService(db);
    const id = c.req.param('id');
    const contact = service.getById(id);
    if (!contact) return c.json({ error: 'Contact not found' }, 404);
    return c.json(contact);
  });

  // UPDATE
  router.put(
    '/:id',
    zValidator('json', contactUpdateSchema),
    async (c) => {
      const ctx = getContext(c);
      const service = createContactsService(ctx.db);
      const id = c.req.param('id');
      const data = c.req.valid('json');
      try {
        const contact = service.update(id, data);
        if (!contact) return c.json({ error: 'Contact not found' }, 404);

        // Auto-sync birthday reminder if birthday or toggle changed
        if (queue && (data.birthday !== undefined || data.birthdayReminderEnabled !== undefined)) {
          const schedulingService = createSchedulingService(ctx.db, queue, ctx.config, ctx.rateLimiter, ctx.tenantId);
          await schedulingService.syncBirthdayReminder(
            contact.id,
            contact.birthday,
            contact.birthdayReminderEnabled,
            contact.name,
          );
        }

        return c.json(contact);
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }
    },
  );

  // DELETE
  router.delete('/:id', async (c) => {
    const { db } = getContext(c);
    const service = createContactsService(db);
    const id = c.req.param('id');
    const deleted = service.delete(id);
    if (!deleted) return c.json({ error: 'Contact not found' }, 404);
    return c.json({ deleted: true });
  });

  // ASSIGN LABELS to contact
  router.post(
    '/:id/labels',
    zValidator('json', labelAssignSchema),
    async (c) => {
      const { db } = getContext(c);
      const labelsService = createLabelsService(db);
      const contactId = c.req.param('id');
      const { labelIds } = c.req.valid('json');
      const result = labelsService.assignToContact(contactId, labelIds);

      if (result.contactNotFound) {
        return c.json({ error: 'Contact not found' }, 404);
      }

      return c.json({ assigned: result.assigned });
    },
  );

  // REMOVE LABEL from contact
  router.delete('/:id/labels/:labelId', async (c) => {
    const { db } = getContext(c);
    const labelsService = createLabelsService(db);
    const contactId = c.req.param('id');
    const labelId = c.req.param('labelId');
    const removed = labelsService.removeFromContact(contactId, labelId);

    if (!removed) {
      return c.json({ error: 'Label assignment not found' }, 404);
    }

    return c.json({ removed: true });
  });

  // IMPORT (CSV/Excel file upload)
  const importRouter = createImportRouter();
  router.route('/import', importRouter);

  return router;
}
