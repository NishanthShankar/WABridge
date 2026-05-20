import { z } from 'zod';

export const webhookCreateSchema = z.object({
  phone: z.string().min(1).optional(),
  url: z.string().url('url must be a valid URL'),
  secret: z.string().optional(),
});

export const webhookUpdateSchema = z.object({
  phone: z.string().min(1).optional(),
  url: z.string().url().optional(),
  enabled: z.boolean().optional(),
  secret: z.string().nullable().optional(),
});
