import { randomBytes } from 'node:crypto';
import type makeWASocket from '@whiskeysockets/baileys';
import { decryptEventResponse, type proto } from '@whiskeysockets/baileys';
import { and, desc, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { createDatabase } from '../db/client.js';
import { eventResponses, events } from '../db/schema.js';
import { type EventInput, eventPayload } from '../scheduler/rich-content.js';
import { ownJids } from '../webhooks/jid.js';

type Database = ReturnType<typeof createDatabase>;
type WASocket = ReturnType<typeof makeWASocket>;
type EventRow = typeof events.$inferSelect;
type ResponseRow = typeof eventResponses.$inferSelect;

/** WhatsApp's answer codes: 1 going, 2 not going, 3 maybe. */
const ANSWERS = { 1: 'going', 2: 'notGoing', 3: 'maybe' } as const;
export type EventAnswer = (typeof ANSWERS)[keyof typeof ANSWERS];

/** Send an event card and remember it, so its answers can be read. Returns the message id. */
export async function sendEvent(
  sock: WASocket,
  db: Database,
  jid: string,
  input: EventInput,
): Promise<string | null> {
  const secret = randomBytes(32);
  const sent = await sock.sendMessage(jid, eventPayload(input, secret));
  const id = sent?.key?.id ?? null;
  if (!id) return null;
  db.insert(events)
    .values({
      id,
      chatJid: jid,
      name: input.name,
      startAt: new Date(input.startAt),
      endAt: input.endAt ? new Date(input.endAt) : null,
      secret: secret.toString('base64'),
      ref: input.ref ?? null,
      createdAt: new Date(),
    })
    .run();
  return id;
}

function normalise(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const [user, server] = jid.split('@');
  return `${user.split(':')[0]}@${server}`;
}

/**
 * Decrypt an answer. Like a poll vote it is signed with the JIDs the answering phone used for
 * us and for itself (phone JIDs or LIDs), so every pairing is tried until one authenticates.
 */
export function decryptAnswer(
  sock: WASocket,
  event: EventRow,
  enc: proto.Message.IEncEventResponseMessage,
  responderJids: Array<string | null | undefined>,
): { answer: EventAnswer; extraGuests: number } | null {
  if (!enc.encPayload || !enc.encIv) return null;
  const responders = [
    ...new Set(responderJids.map(normalise).filter((j): j is string => !!j)),
  ];
  const eventEncKey = Buffer.from(event.secret, 'base64');
  for (const eventCreatorJid of ownJids(sock)) {
    for (const responderJid of responders) {
      try {
        const decoded = decryptEventResponse(
          { encPayload: enc.encPayload, encIv: enc.encIv },
          { eventCreatorJid, eventMsgId: event.id, eventEncKey, responderJid },
        );
        const answer = ANSWERS[decoded.response as keyof typeof ANSWERS];
        if (!answer) return null;
        return { answer, extraGuests: decoded.extraGuestCount ?? 0 };
      } catch {
        // wrong pairing: GCM authentication fails, try the next one
      }
    }
  }
  return null;
}

export function getEvent(db: Database, id: string): EventRow | undefined {
  return db.select().from(events).where(eq(events.id, id)).get();
}

export function responsesFor(db: Database, eventId: string): ResponseRow[] {
  return db
    .select()
    .from(eventResponses)
    .where(eq(eventResponses.eventId, eventId))
    .orderBy(eventResponses.at)
    .all();
}

export function listEvents(
  db: Database,
  filter: { chatJid?: string; ref?: string; limit: number },
): EventRow[] {
  const where = and(
    filter.chatJid ? eq(events.chatJid, filter.chatJid) : undefined,
    filter.ref ? eq(events.ref, filter.ref) : undefined,
  );
  return db
    .select()
    .from(events)
    .where(where)
    .orderBy(desc(events.createdAt))
    .limit(filter.limit)
    .all();
}

/** The event with its counts; extra guests are counted with the people who are going. */
export function summariseEvent(event: EventRow, rows: ResponseRow[]) {
  const count = (a: EventAnswer) => rows.filter((r) => r.response === a).length;
  return {
    eventId: event.id,
    ref: event.ref,
    chatId: event.chatJid,
    name: event.name,
    startAt: event.startAt.toISOString(),
    endAt: event.endAt ? event.endAt.toISOString() : null,
    createdAt: event.createdAt.toISOString(),
    counts: {
      going: count('going'),
      notGoing: count('notGoing'),
      maybe: count('maybe'),
      extraGuests: rows
        .filter((r) => r.response === 'going')
        .reduce((sum, r) => sum + r.extraGuests, 0),
    },
    responses: rows.map((r) => ({
      from: r.responderPhone,
      fromJid: r.responderJid,
      response: r.response,
      extraGuests: r.extraGuests,
      at: r.at.toISOString(),
    })),
  };
}

/**
 * Handle an incoming answer to an event card: decrypt it, keep the person's latest answer, and
 * return the webhook payload fields. Returns null for events this bridge didn't send (or
 * answers it can't decrypt).
 */
export function handleEventResponse(params: {
  sock: WASocket;
  db: Database;
  logger: Logger;
  enc: proto.Message.IEncEventResponseMessage;
  responderJid: string;
  responderAltJid?: string | null;
  responderPhone: string | null;
}): Record<string, unknown> | null {
  const { sock, db, logger, enc, responderJid, responderAltJid } = params;
  const eventId = enc.eventCreationMessageKey?.id;
  if (!eventId) return null;
  const event = getEvent(db, eventId);
  if (!event) return null;

  const decoded = decryptAnswer(sock, event, enc, [
    responderJid,
    responderAltJid,
  ]);
  if (!decoded) {
    logger.warn({ eventId }, 'Event answer could not be decrypted');
    return null;
  }
  const responder = normalise(responderJid) ?? responderJid;
  const earlier = responsesFor(db, eventId).find(
    (r) => r.responderJid === responder,
  );
  const row = {
    eventId,
    responderJid: responder,
    responderPhone: params.responderPhone,
    response: decoded.answer,
    extraGuests: decoded.extraGuests,
    at: new Date(),
  };
  db.insert(eventResponses)
    .values(row)
    .onConflictDoUpdate({
      target: [eventResponses.eventId, eventResponses.responderJid],
      set: {
        responderPhone: row.responderPhone,
        response: row.response,
        extraGuests: row.extraGuests,
        at: row.at,
      },
    })
    .run();

  const { responses: _responses, ...summary } = summariseEvent(
    event,
    responsesFor(db, eventId),
  );
  return {
    event: 'event.response',
    ...summary,
    response: decoded.answer,
    extraGuests: decoded.extraGuests,
    /** What this person had answered before, or null for a first answer */
    previousResponse: earlier?.response ?? null,
  };
}
