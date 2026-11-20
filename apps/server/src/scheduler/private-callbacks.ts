import { randomUUID } from 'node:crypto';
import type makeWASocket from '@whiskeysockets/baileys';
import { and, eq, inArray, lt, notInArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { createDatabase } from '../db/client.js';
import { peekPrivateDb } from '../db/private.js';
import { contacts, scheduledMessages } from '../db/schema.js';
import { toJid } from '../webhooks/jid.js';
import { fireWebhook } from '../webhooks/webhook.listener.js';
import { createWebhooksService } from '../webhooks/webhooks.service.js';

type Database = ReturnType<typeof createDatabase>;
type WASocket = ReturnType<typeof makeWASocket>;
type MessageRow = typeof scheduledMessages.$inferSelect;

/** How long a finished private message's status is kept in memory (for `delivered`, GET, the daily cap). */
export const PRIVATE_KEEP_MS = 24 * 60 * 60 * 1000;

/**
 * Tell the client what became of a private message. Its status is not kept anywhere the
 * client could read it later (the row is in memory and soon dropped), so each change is sent
 * as a `message.status` webhook, to catch-all webhooks that opted in with allEvents.
 *
 * db is the account's private database: the webhooks are read through from disk.
 */
export function notifyMessageStatus(
  db: Database,
  logger: Logger,
  row: MessageRow,
  fields: { status: 'sent' | 'delivered' | 'failed'; reason?: string },
): void {
  let chatId: string | null = row.groupId;
  let phone: string | null = null;
  if (!chatId && row.contactId) {
    const contact = db
      .select({ phone: contacts.phone })
      .from(contacts)
      .where(eq(contacts.id, row.contactId))
      .get();
    chatId = contact ? toJid(contact.phone) : null;
    phone = contact ? contact.phone.replace('+', '') : null;
  }
  const payload = {
    event: 'message.status',
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    private: true,
    scheduledMessageId: row.id,
    messageId: row.whatsappMessageId,
    status: fields.status,
    reason: fields.reason ?? null,
    chatId,
    phone,
    isGroup: !!row.groupId,
  };
  for (const hook of createWebhooksService(db).getAllEvents())
    fireWebhook(hook, payload, logger);
}

/**
 * A queued private message whose job came up after a restart: nothing of it is left but its
 * id, which the queue kept. Report it as failed so the client can send it again.
 */
export function notifyLostMessage(
  db: Database,
  logger: Logger,
  scheduledMessageId: string,
): void {
  const payload = {
    event: 'message.status',
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    private: true,
    scheduledMessageId,
    messageId: null,
    status: 'failed',
    reason: 'lost_on_restart',
    chatId: null,
    phone: null,
    isGroup: null,
  };
  for (const hook of createWebhooksService(db).getAllEvents())
    fireWebhook(hook, payload, logger);
}

/** What was sent is no longer needed once it is out: keep only ids, times and status. */
export function scrubSent(db: Database, id: string): void {
  db.update(scheduledMessages)
    .set({ content: '', mediaUrl: null, options: null })
    .where(eq(scheduledMessages.id, id))
    .run();
}

/** Drop private messages that finished more than a day ago, and contacts nothing refers to. */
export function sweepPrivateMessages(db: Database, now = Date.now()): void {
  db.delete(scheduledMessages)
    .where(
      and(
        inArray(scheduledMessages.status, [
          'sent',
          'delivered',
          'failed',
          'cancelled',
        ]),
        lt(scheduledMessages.updatedAt, new Date(now - PRIVATE_KEEP_MS)),
      ),
    )
    .run();
  const inUse = db
    .selectDistinct({ id: scheduledMessages.contactId })
    .from(scheduledMessages)
    .all()
    .map((r) => r.id)
    .filter((id): id is string => !!id);
  db.delete(contacts)
    .where(inUse.length ? notInArray(contacts.id, inUse) : undefined)
    .run();
}

/**
 * Delivery receipts for private messages: marked in memory and sent on as message.status.
 * (The regular delivery listener only knows the on-disk messages.) Attach on every connection.
 */
export function setupPrivateDelivery(
  sock: WASocket,
  db: Database,
  logger: Logger,
): void {
  sock.ev.on('messages.update', (updates) => {
    const priv = peekPrivateDb(db);
    if (!priv) return;
    for (const { key, update } of updates) {
      // 3 = DELIVERY_ACK
      if (update.status !== 3 || !key.id) continue;
      try {
        const now = new Date();
        const row = priv
          .update(scheduledMessages)
          .set({ status: 'delivered', deliveredAt: now, updatedAt: now })
          .where(
            and(
              eq(scheduledMessages.whatsappMessageId, key.id),
              eq(scheduledMessages.status, 'sent'),
            ),
          )
          .returning()
          .get();
        if (row)
          notifyMessageStatus(priv, logger, row, { status: 'delivered' });
      } catch {
        // Best effort, like the regular delivery listener
      }
    }
  });
}
