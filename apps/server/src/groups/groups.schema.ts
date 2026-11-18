import { z } from 'zod';

/** Schema for listing groups with optional search and pagination */
export const listGroupsSchema = z.object({
  search: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).default(50),
  offset: z.coerce.number().min(0).default(0),
});

const person = z.string().min(3).max(64);

/**
 * Group permissions. Each one left out is not changed.
 * - membersCanAdd: false = only admins can add members
 * - membersCanEditInfo: false = only admins can change the name, photo and description
 * - adminsOnlyMessages: true = only admins can send messages
 */
const groupSettingsFields = z.object({
  membersCanAdd: z.boolean().optional(),
  membersCanEditInfo: z.boolean().optional(),
  adminsOnlyMessages: z.boolean().optional(),
  /** true: people joining by link need an admin to approve them (see /:id/requests) */
  joinApproval: z.boolean().optional(),
});

export const groupSettingsSchema = groupSettingsFields.refine(
  (v) =>
    v.membersCanAdd !== undefined ||
    v.membersCanEditInfo !== undefined ||
    v.adminsOnlyMessages !== undefined ||
    v.joinApproval !== undefined,
  { message: 'Give membersCanAdd, membersCanEditInfo, adminsOnlyMessages or joinApproval' },
);

export type GroupSettingsInput = z.infer<typeof groupSettingsFields>;

export const createGroupSchema = z.object({
  name: z.string().trim().min(1).max(100),
  /** Phones or JIDs to add. This account is always in it (as admin). */
  participants: z.array(person).min(1).max(50),
  description: z.string().max(512).optional(),
  /** Permissions to set right after creating it (see groupSettingsSchema). */
  settings: groupSettingsFields.optional(),
  /** Group picture to set right after creating it: public http(s) image URL. */
  pictureUrl: z
    .string()
    .url()
    .max(2048)
    .refine((u) => /^https?:\/\//i.test(u), { message: 'pictureUrl must be http or https' })
    .optional(),
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

/** PATCH /api/groups/:id: rename and/or change the description. description "" clears it. */
export const updateGroupInfoSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().max(2048).optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined, {
    message: 'Give name, description or both',
  });

/** PUT /api/groups/:id/picture */
export const groupPictureSchema = z.object({
  /** Public http(s) URL of a JPEG, PNG or WebP image. It is cropped to a square. */
  imageUrl: z
    .string()
    .url()
    .max(2048)
    .refine((u) => /^https?:\/\//i.test(u), { message: 'imageUrl must be http or https' }),
});

/** POST /api/groups/join and GET /api/groups/join?link=: an invite link or its code */
export const joinGroupSchema = z.object({
  link: z.string().trim().min(10).max(200),
});

/** POST /api/groups/:id/requests: let people in, or turn them away */
export const joinRequestsSchema = z
  .object({
    approve: z.array(person).max(50).optional(),
    reject: z.array(person).max(50).optional(),
  })
  .refine((v) => (v.approve?.length ?? 0) + (v.reject?.length ?? 0) > 0, {
    message: 'Give approve, reject or both',
  });
