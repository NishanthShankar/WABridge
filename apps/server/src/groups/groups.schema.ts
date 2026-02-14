import { z } from 'zod';

/** Schema for listing groups with optional search and pagination */
export const listGroupsSchema = z.object({
  search: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).default(50),
  offset: z.coerce.number().min(0).default(0),
});
