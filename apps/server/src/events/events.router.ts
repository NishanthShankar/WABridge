import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { type AppContext, getContext } from '../context.js';
import { scheduledMessages } from '../db/schema.js';
import { toJid } from '../webhooks/jid.js';
import {
  getEvent,
  listEvents,
  responsesFor,
  summariseEvent,
} from './events.js';

/** :id may be the event's WhatsApp id, or the id POST /api/messages returned for it. */
function findEvent(ctx: AppContext, id: string) {
  const direct = getEvent(ctx.db, id);
  if (direct) return { event: direct };
  const queued = ctx.db
    .select()
    .from(scheduledMessages)
    .where(
      and(
        eq(scheduledMessages.id, id),
        eq(scheduledMessages.mediaType, 'event'),
      ),
    )
    .get();
  if (!queued) return null;
  const sent = queued.whatsappMessageId
    ? getEvent(ctx.db, queued.whatsappMessageId)
    : undefined;
  return sent ? { event: sent } : { status: queued.status };
}

/**
 * /api/events: the event cards this account sent, and who answered what.
 *
 * - GET /        recent events, newest first, with counts (?chatId= | ?phone=, ?ref=, ?limit=)
 * - GET /:id     one event with its counts and each person's latest answer
 */
export function createEventsRouter() {
  const router = new Hono();

  router.get('/', (c) => {
    const { db } = getContext(c);
    const chat = c.req.query('chatId') ?? c.req.query('phone');
    const limit = Math.min(
      Math.max(Number(c.req.query('limit')) || 20, 1),
      100,
    );
    const rows = listEvents(db, {
      chatJid: chat ? (toJid(chat) ?? undefined) : undefined,
      ref: c.req.query('ref'),
      limit,
    });
    return c.json({
      events: rows.map((e) => {
        const { responses: _responses, ...rest } = summariseEvent(
          e,
          responsesFor(db, e.id),
        );
        return rest;
      }),
    });
  });

  router.get('/:id', (c) => {
    const ctx = getContext(c);
    const found = findEvent(ctx, c.req.param('id'));
    if (!found)
      return c.json(
        { error: 'not_found', message: 'No event with this id' },
        404,
      );
    if (!found.event)
      return c.json(
        {
          error: 'not_sent_yet',
          message: 'This event is still in the queue (or was never sent)',
          status: found.status,
        },
        409,
      );
    return c.json(
      summariseEvent(found.event, responsesFor(ctx.db, found.event.id)),
    );
  });

  return router;
}
