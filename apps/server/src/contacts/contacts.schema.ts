import { z } from 'zod';

/** Birthday format: MM-DD (e.g., "03-15" for March 15) */
const birthdaySchema = z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, {
  message: 'Birthday must be in MM-DD format (e.g., "03-15")',
});

/** Validation schema for POST /api/contacts (create) */
export const contactCreateSchema = z.object({
  phone: z.string().min(10),
  name: z.string().optional(),
  email: z.string().email().optional(),
  notes: z.string().optional(),
  birthday: birthdaySchema.optional(),
  birthdayReminderEnabled: z.boolean().optional(),
});

/** Validation schema for PUT /api/contacts/:id (update) */
export const contactUpdateSchema = z.object({
  phone: z.string().min(10).optional(),
  name: z.string().optional(),
  email: z.string().email().optional(),
  notes: z.string().optional(),
  birthday: birthdaySchema.nullable().optional(),
  birthdayReminderEnabled: z.boolean().optional(),
});

/** Validation schema for GET /api/contacts query params (list) */
export const contactListQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  search: z.string().optional(),
  label: z.string().optional(),
});
