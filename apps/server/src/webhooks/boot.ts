import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { createDatabase } from '../db/client.js';
import { fireWebhook } from './webhook.listener.js';
import { createWebhooksService } from './webhooks.service.js';

type Database = ReturnType<typeof createDatabase>;

/** When this server process started. */
export const STARTED_AT = new Date();

const announced = new WeakSet<object>();

/**
 * Tell the client the bridge has (re)started: bridge.started, once per account per process,
 * to catch-all webhooks with allEvents. Sent when the account is loaded, whether or not its
 * WhatsApp number is linked.
 *
 * Everything held only in memory was lost in the restart: queued private messages, private
 * polls and events, unacknowledged stealth votes. The client resends what had no
 * message.status.
 */
export function announceStarted(db: Database, logger: Logger): void {
  if (announced.has(db)) return;
  announced.add(db);
  const payload = {
    event: 'bridge.started',
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    startedAt: STARTED_AT.toISOString(),
  };
  try {
    for (const hook of createWebhooksService(db).getAllEvents())
      fireWebhook(hook, payload, logger);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'bridge.started not sent');
  }
}
