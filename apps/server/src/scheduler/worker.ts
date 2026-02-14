import { Worker } from 'bullmq';
import { eq, and, inArray, sql } from 'drizzle-orm';
import type { AnyMessageContent } from '@whiskeysockets/baileys';
import { scheduledMessages, contacts, groups, recurringRules } from '../db/schema.js';
import type { AppConfig } from '../config/schema.js';
import type { AppContext } from '../context.js';

/**
 * Build the appropriate Baileys message payload based on media type.
 */
function buildMessagePayload(
  content: string,
  mediaUrl?: string | null,
  mediaType?: string | null,
): AnyMessageContent {
  if (!mediaUrl || !mediaType) {
    return { text: content };
  }

  switch (mediaType) {
    case 'image':
      return { image: { url: mediaUrl }, caption: content };
    case 'video':
      return { video: { url: mediaUrl }, caption: content };
    case 'audio':
      return { audio: { url: mediaUrl }, mimetype: 'audio/mp4' };
    case 'document': {
      const fileName = decodeURIComponent(mediaUrl.split('/').pop()?.split('?')[0] ?? 'file');
      return { document: { url: mediaUrl }, caption: content, fileName, mimetype: 'application/octet-stream' };
    }
    default:
      return { text: content };
  }
}

/**
 * Create the BullMQ worker that processes message send jobs.
 *
 * Handles job types:
 * - 'send': One-time message send (from scheduling API)
 * - 'recurring-send': Recurring rule fire (from BullMQ job scheduler)
 * - 'cleanup': Message history cleanup (daily at 3 AM)
 *
 * Uses resolveContext to get the right db/broadcast/socket per job.
 * In single-tenant mode, this always returns the singleton.
 * In multi-tenant mode, it resolves the tenant from job data.
 *
 * CRITICAL: Worker connection uses maxRetriesPerRequest: null to avoid
 * MaxRetriesPerRequestError during blocking Redis commands (BRPOPLPUSH).
 *
 * Concurrency: 1 (sequential sends for rate limiting)
 * Limiter: max 1 job per 2 seconds (minimum gap between sends)
 */
export function createMessageWorker(
  config: AppConfig,
  resolveContext: (jobData: Record<string, unknown>) => AppContext | null,
): Worker {
  // Build worker connection directly -- must have maxRetriesPerRequest: null
  const connection = {
    host: config.valkey.host,
    port: config.valkey.port,
    password: config.valkey.password,
    maxRetriesPerRequest: null as null,
  };

  const worker = new Worker(
    'message-send',
    async (job) => {
      if (job.name === 'send') {
        const ctx = resolveContext(job.data as Record<string, unknown>);
        if (!ctx) return; // Context not found (e.g., tenant deleted)
        await processSendJob(ctx, config, job.data.scheduledMessageId as string);
      } else if (job.name === 'recurring-send') {
        const ctx = resolveContext(job.data as Record<string, unknown>);
        if (!ctx) return;
        await processRecurringSendJob(ctx, config, job.data.recurringRuleId as string);
      } else if (job.name === 'cleanup') {
        const ctx = resolveContext(job.data as Record<string, unknown>);
        if (ctx) {
          processCleanupJob(ctx, config);
        }
      }
    },
    {
      connection,
      concurrency: 1,
      limiter: {
        max: 1,
        duration: 2000,
      },
    },
  );

  // Handle failed jobs: update SQLite status
  worker.on('failed', (job, error) => {
    if (!job) return;

    const messageId = job.data?.scheduledMessageId as string | undefined;
    if (!messageId) return;

    const ctx = resolveContext(job.data as Record<string, unknown>);
    if (!ctx) return;

    try {
      const now = new Date();
      ctx.db.update(scheduledMessages)
        .set({
          status: 'failed',
          failedAt: now,
          failureReason: error.message,
          attempts: (job.attemptsMade ?? 0) + 1,
          updatedAt: now,
        })
        .where(eq(scheduledMessages.id, messageId))
        .run();

      ctx.broadcast({
        type: 'message:failed',
        data: {
          messageId,
          status: 'failed',
          reason: error.message,
          at: now.toISOString(),
        },
      });
    } catch {
      // Best-effort status update
    }
  });

  return worker;
}

/**
 * Process a 'send' job: read message from SQLite, send via Baileys, update status.
 */
async function processSendJob(
  ctx: AppContext,
  config: AppConfig,
  scheduledMessageId: string,
): Promise<void> {
  const { db, broadcast, rateLimiter, getSocket } = ctx;

  // Read the current message from SQLite (source of truth)
  const msg = db
    .select()
    .from(scheduledMessages)
    .where(eq(scheduledMessages.id, scheduledMessageId))
    .get();

  if (!msg) return;
  if (msg.status === 'cancelled') return;

  // Check daily cap before sending (second layer of enforcement)
  const { allowed, sentToday, dailyCap } = rateLimiter.canSend();
  if (!allowed) {
    const now = new Date();
    db.update(scheduledMessages)
      .set({
        status: 'failed',
        failedAt: now,
        failureReason: `Daily message cap reached (${sentToday}/${dailyCap})`,
        updatedAt: now,
      })
      .where(eq(scheduledMessages.id, msg.id))
      .run();

    broadcast({
      type: 'message:failed',
      data: {
        messageId: msg.id,
        status: 'failed',
        reason: `Daily message cap reached (${sentToday}/${dailyCap})`,
        at: now.toISOString(),
      },
    });

    rateLimiter.checkAndWarn();
    return;
  }

  // Resolve JID: group messages use groupId directly, individual messages look up contact
  let jid: string;
  if (msg.groupId) {
    jid = msg.groupId; // Already a JID like 120363123456@g.us
  } else if (msg.contactId) {
    const contact = db
      .select()
      .from(contacts)
      .where(eq(contacts.id, msg.contactId))
      .get();

    if (!contact) {
      throw new Error(`Contact ${msg.contactId} not found`);
    }
    jid = contact.phone.replace('+', '') + '@s.whatsapp.net';
  } else {
    throw new Error('Message has neither contactId nor groupId');
  }

  // Get WhatsApp socket
  const sock = getSocket();
  if (!sock) {
    throw new Error('WhatsApp not connected');
  }

  // Send message via Baileys (with optional media)
  const payload = buildMessagePayload(msg.content, msg.mediaUrl, msg.mediaType);
  const result = await sock.sendMessage(jid, payload);

  // Update SQLite with success
  const now = new Date();
  db.update(scheduledMessages)
    .set({
      status: 'sent',
      whatsappMessageId: result?.key?.id ?? null,
      sentAt: now,
      attempts: msg.attempts + 1,
      updatedAt: now,
    })
    .where(eq(scheduledMessages.id, msg.id))
    .run();

  broadcast({
    type: 'message:sent',
    data: {
      messageId: msg.id,
      status: 'sent',
      at: now.toISOString(),
    },
  });

  rateLimiter.checkAndWarn();

  // Random delay between sends (2-8 seconds) for human-like behavior
  const minDelay = config.rate_limit.min_delay_ms;
  const maxDelay = config.rate_limit.max_delay_ms;
  const delay = minDelay + Math.random() * (maxDelay - minDelay);
  await new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Process a 'recurring-send' job: load rule, create message record, send via Baileys.
 */
async function processRecurringSendJob(
  ctx: AppContext,
  config: AppConfig,
  recurringRuleId: string,
): Promise<void> {
  const { db, broadcast, rateLimiter, getSocket } = ctx;

  // Load the recurring rule from SQLite
  const rule = db
    .select()
    .from(recurringRules)
    .where(eq(recurringRules.id, recurringRuleId))
    .get();

  if (!rule) return;
  if (!rule.enabled) return;

  // Check if maxOccurrences reached
  if (rule.maxOccurrences && rule.occurrenceCount >= rule.maxOccurrences) {
    db.update(recurringRules)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(recurringRules.id, recurringRuleId))
      .run();
    return;
  }

  // Check daily cap before sending
  const { allowed, sentToday, dailyCap } = rateLimiter.canSend();
  if (!allowed) {
    const now = new Date();
    const msgId = crypto.randomUUID();

    db.insert(scheduledMessages)
      .values({
        id: msgId,
        contactId: rule.contactId,
        recurringRuleId: rule.id,
        content: rule.content,
        scheduledAt: now,
        status: 'failed',
        failedAt: now,
        failureReason: `Daily message cap reached (${sentToday}/${dailyCap})`,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    broadcast({
      type: 'message:failed',
      data: {
        messageId: msgId,
        recurringRuleId: rule.id,
        status: 'failed',
        reason: `Daily message cap reached (${sentToday}/${dailyCap})`,
        at: now.toISOString(),
      },
    });

    rateLimiter.checkAndWarn();
    return;
  }

  // Get contact
  const contact = db
    .select()
    .from(contacts)
    .where(eq(contacts.id, rule.contactId))
    .get();

  if (!contact) return;

  // Get WhatsApp socket
  const sock = getSocket();
  if (!sock) {
    throw new Error('WhatsApp not connected');
  }

  // Create a scheduled message record for this occurrence
  const now = new Date();
  const msgId = crypto.randomUUID();

  db.insert(scheduledMessages)
    .values({
      id: msgId,
      contactId: rule.contactId,
      recurringRuleId: rule.id,
      content: rule.content,
      scheduledAt: now,
      status: 'pending',
      mediaUrl: rule.mediaUrl,
      mediaType: rule.mediaType,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  // Build JID from phone number
  const jid = contact.phone.replace('+', '') + '@s.whatsapp.net';

  // Send message via Baileys (with optional media)
  const payload = buildMessagePayload(rule.content, rule.mediaUrl, rule.mediaType);
  const result = await sock.sendMessage(jid, payload);

  // Update the scheduled message record
  db.update(scheduledMessages)
    .set({
      status: 'sent',
      whatsappMessageId: result?.key?.id ?? null,
      sentAt: now,
      attempts: 1,
      updatedAt: now,
    })
    .where(eq(scheduledMessages.id, msgId))
    .run();

  // Update the recurring rule
  db.update(recurringRules)
    .set({
      occurrenceCount: rule.occurrenceCount + 1,
      lastFiredAt: now,
      updatedAt: now,
    })
    .where(eq(recurringRules.id, recurringRuleId))
    .run();

  broadcast({
    type: 'message:sent',
    data: {
      messageId: msgId,
      recurringRuleId: rule.id,
      status: 'sent',
      at: now.toISOString(),
    },
  });

  rateLimiter.checkAndWarn();

  // Random delay between sends (2-8 seconds)
  const minDelay = config.rate_limit.min_delay_ms;
  const maxDelay = config.rate_limit.max_delay_ms;
  const delay = minDelay + Math.random() * (maxDelay - minDelay);
  await new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Process a 'cleanup' job: delete old messages past retention period.
 */
function processCleanupJob(ctx: AppContext, config: AppConfig): void {
  const retentionDays = config.scheduling.retention_days;
  if (retentionDays === 0) return;

  const cutoff = new Date(Date.now() - retentionDays * 86400000);

  ctx.db.delete(scheduledMessages)
    .where(
      and(
        sql`${scheduledMessages.sentAt} < ${cutoff}`,
        inArray(scheduledMessages.status, ['sent', 'delivered', 'failed']),
      ),
    )
    .run();
}
