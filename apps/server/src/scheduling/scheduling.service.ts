import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import { scheduledMessages, contacts, recurringRules } from '../db/schema.js';
import { scheduleOneTimeJob, cancelJob, rescheduleJob } from '../scheduler/jobs.js';
import { normalizeIndianPhone } from '../contacts/phone.js';
import type { RateLimiter } from '../rate-limit/rate-limiter.js';
import type { createDatabase } from '../db/client.js';
import type { AppConfig } from '../config/schema.js';

type Database = ReturnType<typeof createDatabase>;

// ─── Cron Expression Builder ──────────────────────────────────────────────

interface CronParams {
  sendHour?: number;
  sendMinute?: number;
  dayOfWeek?: number;
  dayOfMonth?: number;
  month?: number;
}

/**
 * Convert user-friendly recurring types to cron expressions.
 *
 * BullMQ cron format: seconds minute hour dayOfMonth month dayOfWeek
 *
 * Monthly edge case: if dayOfMonth > 28, uses 'L' (last day of month).
 * The user intent for "31st" is "end of month" -- this is what L does.
 */
export function buildCronExpression(
  type: string,
  params: CronParams,
  defaultSendHour: number,
): string {
  const hour = params.sendHour ?? defaultSendHour;
  const minute = params.sendMinute ?? 0;

  switch (type) {
    case 'daily':
      return `0 ${minute} ${hour} * * *`;
    case 'weekly':
      return `0 ${minute} ${hour} * * ${params.dayOfWeek ?? 1}`;
    case 'monthly': {
      const day = (params.dayOfMonth ?? 1) > 28 ? 'L' : params.dayOfMonth ?? 1;
      return `0 ${minute} ${hour} ${day} * *`;
    }
    case 'yearly':
      return `0 ${minute} ${hour} ${params.dayOfMonth ?? 1} ${params.month ?? 1} *`;
    case 'birthday':
      return `0 ${minute} ${hour} ${params.dayOfMonth ?? 1} ${params.month ?? 1} *`;
    case 'custom':
      // Custom intervals use BullMQ 'every' in milliseconds, not cron
      return '';
    default:
      throw new Error(`Unknown recurring type: ${type}`);
  }
}

/**
 * Create the scheduling service with CRUD and queue operations.
 *
 * Pattern: SQLite is the source of truth, BullMQ is the executor.
 * All state lives in SQLite. BullMQ jobs reference SQLite records by ID.
 */
export function createSchedulingService(db: Database, queue: Queue, config?: AppConfig, rateLimiter?: RateLimiter, tenantId?: string) {
  const defaultSendHour = config?.scheduling.default_send_hour ?? 9;
  const birthdayMessage = config?.scheduling.birthday_message ?? 'Happy Birthday {{name}}! Wishing you a wonderful day.';
  const retentionDays = config?.scheduling.retention_days ?? 90;

  /**
   * Resolve a contactId from either a direct ID or a phone number.
   * If phone is provided and no contact exists, auto-creates a nameless contact.
   */
  function resolveContactId(contactId?: string, phone?: string, name?: string): string {
    if (contactId) {
      const contact = db
        .select()
        .from(contacts)
        .where(eq(contacts.id, contactId))
        .get();
      if (!contact) throw new Error('Contact not found');
      // Update name if provided and contact has no name
      if (name && !contact.name) {
        db.update(contacts)
          .set({ name, updatedAt: new Date() })
          .where(eq(contacts.id, contactId))
          .run();
      }
      return contactId;
    }

    if (!phone) throw new Error('contactId or phone is required');

    const normalized = normalizeIndianPhone(phone);
    const existing = db
      .select()
      .from(contacts)
      .where(eq(contacts.phone, normalized))
      .get();

    if (existing) {
      // Update name if provided and contact has no name
      if (name && !existing.name) {
        db.update(contacts)
          .set({ name, updatedAt: new Date() })
          .where(eq(contacts.id, existing.id))
          .run();
      }
      return existing.id;
    }

    // Auto-create contact with optional name
    const now = new Date();
    const id = crypto.randomUUID();
    db.insert(contacts)
      .values({
        id,
        phone: normalized,
        name: name ?? null,
        email: null,
        notes: null,
        birthday: null,
        birthdayReminderEnabled: true,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    return id;
  }

  return {
    /**
     * Schedule a message for future delivery, or send immediately.
     *
     * - If scheduledAt is provided: schedules a delayed BullMQ job
     * - If scheduledAt is omitted: schedules for immediate delivery (delay=0)
     *
     * @throws Error if contact does not exist
     */
    async scheduleMessage(contactId: string | undefined, content: string, scheduledAt?: string, phone?: string, name?: string, mediaUrl?: string, mediaType?: string) {
      const resolvedContactId = resolveContactId(contactId, phone, name);

      const now = new Date();
      const sendAt = scheduledAt ? new Date(scheduledAt) : now;
      const isImmediate = !scheduledAt || sendAt.getTime() <= now.getTime();

      // For IMMEDIATE sends: check daily cap (reject fast with clear error)
      // For FUTURE scheduled sends: do NOT reject based on today's cap
      if (isImmediate && rateLimiter) {
        const { allowed, sentToday, dailyCap } = rateLimiter.canSend();
        if (!allowed) {
          const status = rateLimiter.getStatus();
          const error = new Error(
            `Daily message cap reached (${sentToday}/${dailyCap}). ` +
            `Resets at ${status.resetAt}. ` +
            `Increase daily_cap in config to send more messages.`,
          );
          (error as Error & { statusCode: number }).statusCode = 429;
          throw error;
        }
      }

      // Insert into SQLite
      const id = crypto.randomUUID();
      const msg = db
        .insert(scheduledMessages)
        .values({
          id,
          contactId: resolvedContactId,
          content,
          scheduledAt: sendAt,
          status: 'pending',
          mediaUrl: mediaUrl ?? null,
          mediaType: mediaType ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();

      // Schedule BullMQ job with appropriate delay
      const delay = Math.max(0, sendAt.getTime() - Date.now());
      await scheduleOneTimeJob(queue, msg.id, delay, tenantId);

      // Check and warn after successful schedule
      if (rateLimiter) {
        rateLimiter.checkAndWarn();
      }

      // Include rate limit metadata in response
      const rateLimit = rateLimiter ? rateLimiter.getStatus() : undefined;
      return { ...msg, rateLimit };
    },

    /**
     * Schedule multiple messages in bulk.
     * Returns per-item success/failure tracking and aggregate rate limit status.
     */
    async bulkScheduleMessages(items: Array<{
      contactId?: string;
      phone?: string;
      name?: string;
      content: string;
      scheduledAt?: string;
      mediaUrl?: string;
      mediaType?: string;
    }>) {
      const scheduled: Array<Record<string, unknown>> = [];
      const failed: Array<{ index: number; error: string }> = [];

      // Pre-check rate limit for immediate sends
      const now = new Date();
      const immediateCount = items.filter((item) => {
        if (!item.scheduledAt) return true;
        return new Date(item.scheduledAt).getTime() <= now.getTime();
      }).length;

      if (immediateCount > 0 && rateLimiter) {
        const { allowed, sentToday, dailyCap } = rateLimiter.canSend();
        const remaining = dailyCap - sentToday;
        if (!allowed || remaining < immediateCount) {
          const status = rateLimiter.getStatus();
          const error = new Error(
            `Bulk requires ${immediateCount} immediate sends but only ${Math.max(0, remaining)} remaining today (${sentToday}/${dailyCap}). ` +
            `Resets at ${status.resetAt}.`,
          );
          (error as Error & { statusCode: number }).statusCode = 429;
          throw error;
        }
      }

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        try {
          const resolvedContactId = resolveContactId(item.contactId, item.phone, item.name);

          const sendAt = item.scheduledAt ? new Date(item.scheduledAt) : now;
          const isImmediate = !item.scheduledAt || sendAt.getTime() <= now.getTime();

          if (isImmediate && rateLimiter) {
            const { allowed, sentToday, dailyCap } = rateLimiter.canSend();
            if (!allowed) {
              failed.push({ index: i, error: `Daily cap reached (${sentToday}/${dailyCap})` });
              continue;
            }
          }

          const id = crypto.randomUUID();
          const msg = db
            .insert(scheduledMessages)
            .values({
              id,
              contactId: resolvedContactId,
              content: item.content,
              scheduledAt: sendAt,
              status: 'pending',
              mediaUrl: item.mediaUrl ?? null,
              mediaType: item.mediaType ?? null,
              createdAt: now,
              updatedAt: now,
            })
            .returning()
            .get();

          const delay = Math.max(0, sendAt.getTime() - Date.now());
          await scheduleOneTimeJob(queue, msg.id, delay, tenantId);

          scheduled.push(msg);
        } catch (err) {
          failed.push({ index: i, error: (err as Error).message });
        }
      }

      if (rateLimiter) {
        rateLimiter.checkAndWarn();
      }

      const rateLimit = rateLimiter ? rateLimiter.getStatus() : undefined;
      return { scheduled, failed, rateLimit };
    },

    /**
     * Cancel a pending scheduled message.
     *
     * Only messages with status 'pending' can be cancelled.
     * Returns the updated message, or null if not found/not pending.
     */
    async cancelMessage(messageId: string) {
      const now = new Date();

      const msg = db
        .update(scheduledMessages)
        .set({ status: 'cancelled', updatedAt: now })
        .where(
          and(
            eq(scheduledMessages.id, messageId),
            eq(scheduledMessages.status, 'pending'),
          ),
        )
        .returning()
        .get();

      if (!msg) return null;

      // Remove BullMQ job (safe even if already processed)
      await cancelJob(queue, messageId);

      return msg;
    },

    /**
     * Edit a pending scheduled message (content and/or scheduledAt).
     *
     * Only messages with status 'pending' can be edited.
     * If scheduledAt changes, the BullMQ job is rescheduled.
     */
    async editMessage(
      messageId: string,
      updates: { content?: string; scheduledAt?: string; mediaUrl?: string | null; mediaType?: string | null },
    ) {
      // Check current message
      const existing = db
        .select()
        .from(scheduledMessages)
        .where(eq(scheduledMessages.id, messageId))
        .get();

      if (!existing || existing.status !== 'pending') {
        return null;
      }

      const now = new Date();
      const setValues: Record<string, unknown> = { updatedAt: now };

      if (updates.content !== undefined) {
        setValues.content = updates.content;
      }
      if (updates.mediaUrl !== undefined) {
        setValues.mediaUrl = updates.mediaUrl;
      }
      if (updates.mediaType !== undefined) {
        setValues.mediaType = updates.mediaType;
      }

      let newScheduledAt: Date | undefined;
      if (updates.scheduledAt !== undefined) {
        newScheduledAt = new Date(updates.scheduledAt);
        setValues.scheduledAt = newScheduledAt;
      }

      const msg = db
        .update(scheduledMessages)
        .set(setValues)
        .where(eq(scheduledMessages.id, messageId))
        .returning()
        .get();

      // If scheduledAt changed, reschedule the BullMQ job
      if (newScheduledAt) {
        const newDelay = Math.max(0, newScheduledAt.getTime() - Date.now());
        await rescheduleJob(queue, messageId, newDelay, tenantId);
      }

      return msg;
    },

    /**
     * Get a single message by ID.
     */
    getMessage(messageId: string) {
      return db
        .select()
        .from(scheduledMessages)
        .where(eq(scheduledMessages.id, messageId))
        .get() ?? null;
    },

    /**
     * List messages with optional filters and pagination.
     */
    listMessages(filters: {
      status?: string;
      contactId?: string;
      limit: number;
      offset: number;
    }) {
      const conditions = [];

      if (filters.status) {
        conditions.push(eq(scheduledMessages.status, filters.status));
      }
      if (filters.contactId) {
        conditions.push(eq(scheduledMessages.contactId, filters.contactId));
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const data = db
        .select()
        .from(scheduledMessages)
        .where(where)
        .orderBy(desc(scheduledMessages.createdAt))
        .limit(filters.limit)
        .offset(filters.offset)
        .all();

      const totalResult = db
        .select({ count: sql<number>`count(*)` })
        .from(scheduledMessages)
        .where(where)
        .get();

      return {
        data,
        total: totalResult?.count ?? 0,
        limit: filters.limit,
        offset: filters.offset,
      };
    },

    /**
     * Retry a failed message.
     *
     * Only messages with status 'failed' can be retried.
     * Resets status to 'pending' and attempts to 0, then schedules immediate send.
     */
    async retryMessage(messageId: string) {
      const now = new Date();

      const msg = db
        .update(scheduledMessages)
        .set({
          status: 'pending',
          attempts: 0,
          failedAt: null,
          failureReason: null,
          scheduledAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(scheduledMessages.id, messageId),
            eq(scheduledMessages.status, 'failed'),
          ),
        )
        .returning()
        .get();

      if (!msg) return null;

      // Schedule immediate send
      await scheduleOneTimeJob(queue, messageId, 0, tenantId);

      return msg;
    },

    // ─── Recurring Rules ──────────────────────────────────────────────────

    /**
     * Create a recurring rule and register its BullMQ job scheduler.
     *
     * For custom intervals ("every N days"), uses BullMQ 'every' in ms.
     * For all other types, uses cron expression with pattern.
     */
    async createRecurringRule(data: {
      contactId?: string;
      phone?: string;
      name?: string;
      type: string;
      content: string;
      sendHour?: number;
      sendMinute?: number;
      dayOfWeek?: number;
      dayOfMonth?: number;
      month?: number;
      intervalDays?: number;
      endDate?: string;
      maxOccurrences?: number;
      mediaUrl?: string;
      mediaType?: string;
    }) {
      const resolvedContactId = resolveContactId(data.contactId, data.phone, data.name);

      const cronExpression = buildCronExpression(data.type, {
        sendHour: data.sendHour,
        sendMinute: data.sendMinute,
        dayOfWeek: data.dayOfWeek,
        dayOfMonth: data.dayOfMonth,
        month: data.month,
      }, defaultSendHour);

      const now = new Date();
      const id = crypto.randomUUID();

      const rule = db
        .insert(recurringRules)
        .values({
          id,
          contactId: resolvedContactId,
          type: data.type,
          content: data.content,
          cronExpression: cronExpression || `every-${data.intervalDays ?? 1}-days`,
          intervalDays: data.intervalDays ?? null,
          endDate: data.endDate ? new Date(data.endDate) : null,
          maxOccurrences: data.maxOccurrences ?? null,
          mediaUrl: data.mediaUrl ?? null,
          mediaType: data.mediaType ?? null,
          enabled: true,
          occurrenceCount: 0,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();

      // Register BullMQ job scheduler
      if (data.type === 'custom' && data.intervalDays) {
        // Custom interval: use 'every' in milliseconds
        await queue.upsertJobScheduler(
          `recurring-${rule.id}`,
          {
            every: data.intervalDays * 86400000,
            endDate: data.endDate ? new Date(data.endDate) : undefined,
            limit: data.maxOccurrences ?? undefined,
          },
          {
            name: 'recurring-send',
            data: { recurringRuleId: rule.id, tenantId },
          },
        );
      } else {
        // Cron pattern
        await queue.upsertJobScheduler(
          `recurring-${rule.id}`,
          {
            pattern: cronExpression,
            endDate: data.endDate ? new Date(data.endDate) : undefined,
            limit: data.maxOccurrences ?? undefined,
          },
          {
            name: 'recurring-send',
            data: { recurringRuleId: rule.id, tenantId },
          },
        );
      }

      return rule;
    },

    /**
     * Update a recurring rule and re-register its BullMQ job scheduler.
     */
    async updateRecurringRule(
      ruleId: string,
      updates: {
        content?: string;
        sendHour?: number;
        sendMinute?: number;
        dayOfWeek?: number;
        dayOfMonth?: number;
        month?: number;
        intervalDays?: number;
        endDate?: string | null;
        maxOccurrences?: number | null;
        enabled?: boolean;
        mediaUrl?: string | null;
        mediaType?: string | null;
      },
    ) {
      // Load existing rule
      const existing = db
        .select()
        .from(recurringRules)
        .where(eq(recurringRules.id, ruleId))
        .get();

      if (!existing) return null;

      const now = new Date();
      const setValues: Record<string, unknown> = { updatedAt: now };

      if (updates.content !== undefined) setValues.content = updates.content;
      if (updates.intervalDays !== undefined) setValues.intervalDays = updates.intervalDays;
      if (updates.endDate !== undefined) setValues.endDate = updates.endDate ? new Date(updates.endDate) : null;
      if (updates.maxOccurrences !== undefined) setValues.maxOccurrences = updates.maxOccurrences;
      if (updates.enabled !== undefined) setValues.enabled = updates.enabled;
      if (updates.mediaUrl !== undefined) setValues.mediaUrl = updates.mediaUrl;
      if (updates.mediaType !== undefined) setValues.mediaType = updates.mediaType;

      // Rebuild cron expression if scheduling params changed
      const needsCronUpdate = updates.sendHour !== undefined || updates.sendMinute !== undefined
        || updates.dayOfWeek !== undefined || updates.dayOfMonth !== undefined
        || updates.month !== undefined || updates.intervalDays !== undefined;

      if (needsCronUpdate) {
        const newCron = buildCronExpression(existing.type, {
          sendHour: updates.sendHour,
          sendMinute: updates.sendMinute,
          dayOfWeek: updates.dayOfWeek,
          dayOfMonth: updates.dayOfMonth,
          month: updates.month,
        }, defaultSendHour);

        setValues.cronExpression = newCron || `every-${updates.intervalDays ?? existing.intervalDays ?? 1}-days`;
      }

      const rule = db
        .update(recurringRules)
        .set(setValues)
        .where(eq(recurringRules.id, ruleId))
        .returning()
        .get();

      if (!rule) return null;

      // Re-register or remove BullMQ job scheduler
      if (updates.enabled === false) {
        await queue.removeJobScheduler(`recurring-${ruleId}`);
      } else {
        const cronExpr = (setValues.cronExpression as string) ?? existing.cronExpression;
        const isCustom = existing.type === 'custom';

        if (isCustom) {
          const days = updates.intervalDays ?? existing.intervalDays ?? 1;
          await queue.upsertJobScheduler(
            `recurring-${ruleId}`,
            {
              every: days * 86400000,
              endDate: rule.endDate ?? undefined,
              limit: rule.maxOccurrences ?? undefined,
            },
            {
              name: 'recurring-send',
              data: { recurringRuleId: ruleId, tenantId },
            },
          );
        } else {
          await queue.upsertJobScheduler(
            `recurring-${ruleId}`,
            {
              pattern: cronExpr,
              endDate: rule.endDate ?? undefined,
              limit: rule.maxOccurrences ?? undefined,
            },
            {
              name: 'recurring-send',
              data: { recurringRuleId: ruleId, tenantId },
            },
          );
        }
      }

      return rule;
    },

    /**
     * Delete (disable) a recurring rule and remove its BullMQ job scheduler.
     */
    async deleteRecurringRule(ruleId: string) {
      const now = new Date();

      const rule = db
        .update(recurringRules)
        .set({ enabled: false, updatedAt: now })
        .where(eq(recurringRules.id, ruleId))
        .returning()
        .get();

      if (!rule) return null;

      await queue.removeJobScheduler(`recurring-${ruleId}`);

      return rule;
    },

    /**
     * List recurring rules with optional filters.
     */
    listRecurringRules(filters: {
      contactId?: string;
      type?: string;
      enabled?: boolean;
      limit: number;
      offset: number;
    }) {
      const conditions = [];

      if (filters.contactId) {
        conditions.push(eq(recurringRules.contactId, filters.contactId));
      }
      if (filters.type) {
        conditions.push(eq(recurringRules.type, filters.type));
      }
      if (filters.enabled !== undefined) {
        conditions.push(eq(recurringRules.enabled, filters.enabled));
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const data = db
        .select()
        .from(recurringRules)
        .where(where)
        .orderBy(desc(recurringRules.createdAt))
        .limit(filters.limit)
        .offset(filters.offset)
        .all();

      const totalResult = db
        .select({ count: sql<number>`count(*)` })
        .from(recurringRules)
        .where(where)
        .get();

      return {
        data,
        total: totalResult?.count ?? 0,
        limit: filters.limit,
        offset: filters.offset,
      };
    },

    /**
     * Get a single recurring rule by ID.
     */
    getRecurringRule(ruleId: string) {
      return db
        .select()
        .from(recurringRules)
        .where(eq(recurringRules.id, ruleId))
        .get() ?? null;
    },

    // ─── Birthday Reminder Sync ────────────────────────────────────────────

    /**
     * Sync birthday reminder for a contact.
     *
     * - If birthday is set AND birthdayReminderEnabled is not false:
     *   Creates/updates a yearly recurring rule of type='birthday'
     * - If birthday is cleared OR birthdayReminderEnabled is false:
     *   Finds and removes existing birthday rule for this contact
     *
     * Birthday format: "MM-DD" (e.g., "03-15" for March 15)
     */
    async syncBirthdayReminder(
      contactId: string,
      birthday: string | null,
      birthdayReminderEnabled: boolean | null,
      contactName: string | null,
    ) {
      if (birthday && birthdayReminderEnabled !== false) {
        // Parse MM-DD
        const parts = birthday.split('-');
        if (parts.length !== 2) return;
        const month = parseInt(parts[0], 10);
        const day = parseInt(parts[1], 10);
        if (isNaN(month) || isNaN(day) || month < 1 || month > 12 || day < 1 || day > 31) return;

        // Resolve birthday message template
        const name = contactName ?? 'Friend';
        const content = birthdayMessage.replace(/\{\{name\}\}/g, name);

        const cronExpression = buildCronExpression('birthday', {
          dayOfMonth: day,
          month,
        }, defaultSendHour);

        // Check if birthday rule already exists for this contact
        const existingRule = db
          .select()
          .from(recurringRules)
          .where(
            and(
              eq(recurringRules.contactId, contactId),
              eq(recurringRules.type, 'birthday'),
            ),
          )
          .get();

        const now = new Date();

        if (existingRule) {
          // Update existing rule
          db.update(recurringRules)
            .set({
              content,
              cronExpression,
              enabled: true,
              updatedAt: now,
            })
            .where(eq(recurringRules.id, existingRule.id))
            .run();

          await queue.upsertJobScheduler(
            `recurring-${existingRule.id}`,
            { pattern: cronExpression },
            {
              name: 'recurring-send',
              data: { recurringRuleId: existingRule.id, tenantId },
            },
          );
        } else {
          // Create new birthday rule
          const id = crypto.randomUUID();
          db.insert(recurringRules)
            .values({
              id,
              contactId,
              type: 'birthday',
              content,
              cronExpression,
              enabled: true,
              occurrenceCount: 0,
              createdAt: now,
              updatedAt: now,
            })
            .run();

          await queue.upsertJobScheduler(
            `recurring-${id}`,
            { pattern: cronExpression },
            {
              name: 'recurring-send',
              data: { recurringRuleId: id, tenantId },
            },
          );
        }
      } else {
        // Remove birthday rule if it exists
        const existingRule = db
          .select()
          .from(recurringRules)
          .where(
            and(
              eq(recurringRules.contactId, contactId),
              eq(recurringRules.type, 'birthday'),
            ),
          )
          .get();

        if (existingRule) {
          db.update(recurringRules)
            .set({ enabled: false, updatedAt: new Date() })
            .where(eq(recurringRules.id, existingRule.id))
            .run();

          await queue.removeJobScheduler(`recurring-${existingRule.id}`);
        }
      }
    },

    /**
     * Clean up old message history based on retention period.
     * Deletes messages older than retention_days that are in terminal states.
     * Does NOT delete 'pending' or 'cancelled' messages.
     *
     * @returns Number of deleted messages
     */
    cleanupMessageHistory(): number {
      if (retentionDays === 0) return 0; // Cleanup disabled

      const cutoff = new Date(Date.now() - retentionDays * 86400000);

      const result = db
        .delete(scheduledMessages)
        .where(
          and(
            sql`${scheduledMessages.sentAt} < ${cutoff}`,
            inArray(scheduledMessages.status, ['sent', 'delivered', 'failed']),
          ),
        )
        .run();

      return result.changes;
    },
  };
}
