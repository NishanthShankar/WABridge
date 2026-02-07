import { z } from 'zod';

/** Validation schema for POST /api/templates (create) */
export const templateCreateSchema = z.object({
  name: z.string().min(1).max(100),
  body: z.string().min(1),
});

/** Validation schema for PUT /api/templates/:id (update) */
export const templateUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  body: z.string().min(1).optional(),
});

/** Validation schema for POST /api/templates/:id/preview */
export const templatePreviewSchema = z.object({
  contactId: z.string().min(1),
});
