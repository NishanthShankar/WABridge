import { z } from 'zod';

/** Shared media type enum */
export const mediaTypeEnum = z.enum(['image', 'video', 'audio', 'document']);

/** Schema for scheduling a new message (or sending immediately) */
export const scheduleMessageSchema = z.object({
  contactId: z.string().uuid().optional(),
  phone: z.string().optional(),
  name: z.string().optional(),
  groupId: z.string().optional(),
  content: z.string().min(1, 'Message content is required'),
  scheduledAt: z.string().datetime().optional(),
  mediaUrl: z.string().url().optional(),
  mediaType: mediaTypeEnum.optional(),
}).refine(
  (d) => d.contactId || d.phone || d.groupId,
  { message: 'contactId, phone, or groupId is required' },
).refine(
  (d) => !d.mediaUrl || d.mediaType,
  { message: 'mediaType is required when mediaUrl is provided' },
);

/** Schema for editing a pending message */
export const editMessageSchema = z.object({
  content: z.string().min(1).optional(),
  scheduledAt: z.string().datetime().optional(),
  mediaUrl: z.string().url().nullable().optional(),
  mediaType: mediaTypeEnum.nullable().optional(),
}).refine(
  (data) => data.content !== undefined || data.scheduledAt !== undefined
    || data.mediaUrl !== undefined || data.mediaType !== undefined,
  { message: 'At least one of content, scheduledAt, mediaUrl, or mediaType must be provided' },
).refine(
  (d) => !(d.mediaUrl && !d.mediaType),
  { message: 'mediaType is required when mediaUrl is provided' },
);

/** Schema for listing messages with filters */
export const listMessagesSchema = z.object({
  status: z.enum(['pending', 'sent', 'delivered', 'failed', 'cancelled']).optional(),
  contactId: z.string().uuid().optional(),
  phone: z.string().optional(),
  phoneMode: z.enum(['include', 'exclude']).default('include'),
  limit: z.coerce.number().min(1).max(200).default(50),
  offset: z.coerce.number().min(0).default(0),
});

// ─── Recurring Rules Schemas ────────────────────────────────────────────────

/** Recurring rule types */
export const recurringTypeEnum = z.enum([
  'daily',
  'weekly',
  'monthly',
  'yearly',
  'custom',
  'birthday',
]);

/** Schema for creating a recurring rule */
export const createRecurringRuleSchema = z.object({
  contactId: z.string().uuid().optional(),
  phone: z.string().optional(),
  name: z.string().optional(),
  type: recurringTypeEnum,
  content: z.string().min(1, 'Message content is required'),
  /** Hour of day to send (0-23, IST). Defaults to config default_send_hour */
  sendHour: z.number().min(0).max(23).optional(),
  /** Minute of hour to send (0-59). Defaults to 0 */
  sendMinute: z.number().min(0).max(59).optional(),
  /** Day of week for weekly (0=Sun, 1=Mon, ..., 6=Sat) */
  dayOfWeek: z.number().min(0).max(6).optional(),
  /** Day of month for monthly/yearly (1-31). Days > 28 use L (last day) for monthly */
  dayOfMonth: z.number().min(1).max(31).optional(),
  /** Month for yearly (1-12) */
  month: z.number().min(1).max(12).optional(),
  /** Interval in days for custom type ("every N days") */
  intervalDays: z.number().min(1).optional(),
  /** ISO date string for when to stop recurring */
  endDate: z.string().datetime().optional(),
  /** Maximum number of occurrences before auto-disabling */
  maxOccurrences: z.number().min(1).optional(),
  mediaUrl: z.string().url().optional(),
  mediaType: mediaTypeEnum.optional(),
}).refine(
  (d) => d.contactId || d.phone,
  { message: 'contactId or phone is required' },
).refine(
  (d) => !d.mediaUrl || d.mediaType,
  { message: 'mediaType is required when mediaUrl is provided' },
);

/** Schema for updating a recurring rule */
export const updateRecurringRuleSchema = z.object({
  content: z.string().min(1).optional(),
  sendHour: z.number().min(0).max(23).optional(),
  sendMinute: z.number().min(0).max(59).optional(),
  dayOfWeek: z.number().min(0).max(6).optional(),
  dayOfMonth: z.number().min(1).max(31).optional(),
  month: z.number().min(1).max(12).optional(),
  intervalDays: z.number().min(1).optional(),
  endDate: z.string().datetime().nullable().optional(),
  maxOccurrences: z.number().min(1).nullable().optional(),
  enabled: z.boolean().optional(),
  mediaUrl: z.string().url().nullable().optional(),
  mediaType: mediaTypeEnum.nullable().optional(),
}).refine(
  (d) => !(d.mediaUrl && !d.mediaType),
  { message: 'mediaType is required when mediaUrl is provided' },
);

/** Schema for listing recurring rules with filters */
export const listRecurringRulesSchema = z.object({
  contactId: z.string().uuid().optional(),
  type: recurringTypeEnum.optional(),
  enabled: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  limit: z.coerce.number().min(1).max(200).default(50),
  offset: z.coerce.number().min(0).default(0),
});

// ─── Bulk Scheduling ──────────────────────────────────────────────────────

/** Schema for bulk scheduling multiple messages at once */
export const bulkScheduleSchema = z.object({
  messages: z.array(z.object({
    contactId: z.string().uuid().optional(),
    phone: z.string().optional(),
    name: z.string().optional(),
    groupId: z.string().optional(),
    content: z.string().min(1),
    scheduledAt: z.string().datetime().optional(),
    mediaUrl: z.string().url().optional(),
    mediaType: mediaTypeEnum.optional(),
  }).refine(d => d.contactId || d.phone || d.groupId, { message: 'contactId, phone, or groupId required' })
    .refine(d => !d.mediaUrl || d.mediaType, { message: 'mediaType is required when mediaUrl is provided' }))
    .min(1).max(500),
});
