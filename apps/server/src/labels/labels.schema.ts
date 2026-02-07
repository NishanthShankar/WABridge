import { z } from 'zod';

/** Validation schema for POST /api/labels (create) */
export const labelCreateSchema = z.object({
  name: z.string().min(1).max(50),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Color must be a hex color like #FF0000')
    .optional(),
});

/** Validation schema for PUT /api/labels/:id (update) */
export const labelUpdateSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Color must be a hex color like #FF0000')
    .nullable()
    .optional(),
});

/** Validation schema for POST /api/contacts/:id/labels (assign) */
export const labelAssignSchema = z.object({
  labelIds: z.array(z.string().uuid()).min(1),
});
