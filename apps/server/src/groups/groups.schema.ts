import { z } from 'zod';

/** Schema for listing groups with optional search and pagination */
export const listGroupsSchema = z.object({
  search: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).default(50),
  offset: z.coerce.number().min(0).default(0),
});

const person = z.string().min(3).max(64);

export const createGroupSchema = z.object({
  name: z.string().trim().min(1).max(100),
  /** Phones or JIDs to add. This account is always in it (as admin). */
  participants: z.array(person).min(1).max(50),
  description: z.string().max(512).optional(),
});

export const updateParticipantsSchema = z
  .object({
    add: z.array(person).max(50).optional(),
    remove: z.array(person).max(50).optional(),
    promote: z.array(person).max(50).optional(),
    demote: z.array(person).max(50).optional(),
  })
  .refine((v) => v.add?.length || v.remove?.length || v.promote?.length || v.demote?.length, {
    message: 'Give add, remove, promote or demote',
  });
