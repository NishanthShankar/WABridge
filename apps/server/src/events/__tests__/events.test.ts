import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { proto } from '@whiskeysockets/baileys';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { Hono } from 'hono';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { type AppContext, setContext } from '../../context.js';
import { createDatabase } from '../../db/client.js';
import { events, scheduledMessages } from '../../db/schema.js';
import { sendStored } from '../../scheduler/send-stored.js';
import { createEventsRouter } from '../events.router.js';
import { handleEventResponse } from '../events.js';

const GROUP = '120363000000000001@g.us';
const OUR_PN = '919800000009@s.whatsapp.net';
const OUR_LID = '55500000000009@lid';
const GUEST_PN = '919800000001@s.whatsapp.net';
const GUEST_LID = '77700000000001@lid';
const EVENT = {
  name: 'Review call',
  startAt: '2026-11-20T10:00:00+05:30',
  endAt: '2026-11-20T10:30:00+05:30',
  ref: 'review-nov',
};
const logger = pino({ level: 'silent' });

/** Encrypt an answer exactly as a phone does (inverse of Baileys' decryptEventResponse). */
function encryptAnswer(opts: {
  eventId: string;
  secret: Buffer;
  creatorJid: string;
  responderJid: string;
  response: number;
  extraGuestCount?: number;
}): proto.Message.IEncEventResponseMessage {
  const sign = Buffer.concat([
    Buffer.from(opts.eventId),
    Buffer.from(opts.creatorJid),
    Buffer.from(opts.responderJid),
    Buffer.from('Event Response'),
    Buffer.from([1]),
  ]);
  const key0 = createHmac('sha256', Buffer.alloc(32))
    .update(opts.secret)
    .digest();
  const key = createHmac('sha256', key0).update(sign).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${opts.eventId}\u0000${opts.responderJid}`));
  const plain = proto.Message.EventResponseMessage.encode({
    response: opts.response,
    timestampMs: Date.now(),
    extraGuestCount: opts.extraGuestCount,
  }).finish();
  const encPayload = Buffer.concat([
    cipher.update(plain),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    eventCreationMessageKey: {
      remoteJid: GROUP,
      id: opts.eventId,
      fromMe: true,
    },
    encPayload,
    encIv: iv,
  };
}

async function setup() {
  const db = createDatabase(':memory:');
  migrate(db, { migrationsFolder: resolve(__dirname, '../../../drizzle') });
  const sent: Array<{ event: { messageSecret: Uint8Array; name: string } }> =
    [];
  const sock = {
    user: { id: '919800000009:3@s.whatsapp.net', lid: '55500000000009:3@lid' },
    async sendMessage(_jid: string, content: never) {
      sent.push(content);
      return { key: { id: `EV${sent.length}` } };
    },
  };
  const eventId = (await sendStored(sock as never, db, GROUP, {
    content: JSON.stringify(EVENT),
    mediaType: 'event',
  })) as string;
  const secret = Buffer.from(sent[0].event.messageSecret);
  const answer = (o: {
    response: number;
    creatorJid?: string;
    signedAs?: string;
    from?: string;
    alt?: string | null;
    phone?: string | null;
    extraGuestCount?: number;
    secret?: Buffer;
  }) =>
    handleEventResponse({
      sock: sock as never,
      db,
      logger,
      enc: encryptAnswer({
        eventId,
        secret: o.secret ?? secret,
        creatorJid: o.creatorJid ?? OUR_PN,
        responderJid: o.signedAs ?? o.from ?? GUEST_PN,
        response: o.response,
        extraGuestCount: o.extraGuestCount,
      }),
      responderJid: o.from ?? GUEST_PN,
      responderAltJid: o.alt,
      responderPhone: o.phone === undefined ? '919800000001' : o.phone,
    });
  const app = new Hono();
  app.use('*', async (c, next) => {
    setContext(c, {
      db,
      getSocket: () => sock,
      tenantId: 't1',
    } as unknown as AppContext);
    await next();
  });
  app.route('/api/events', createEventsRouter());
  const get = async (path: string) => {
    const res = await app.request(path);
    return {
      status: res.status,
      body: (await res.json()) as Record<string, never>,
    };
  };
  return { db, eventId, answer, get, sent };
}

describe('event answers', () => {
  it('the card is sent with a secret, and the event is remembered with its ref', async () => {
    const t = await setup();
    expect(t.sent[0].event.messageSecret).toHaveLength(32);
    expect(t.db.select().from(events).all()).toMatchObject([
      { id: t.eventId, chatJid: GROUP, name: 'Review call', ref: 'review-nov' },
    ]);
  });

  it('going, with guests: decrypted, counted and described for the webhook', async () => {
    const t = await setup();
    expect(t.answer({ response: 1, extraGuestCount: 2 })).toEqual({
      event: 'event.response',
      eventId: t.eventId,
      ref: 'review-nov',
      chatId: GROUP,
      name: 'Review call',
      startAt: '2026-11-20T04:30:00.000Z',
      endAt: '2026-11-20T05:00:00.000Z',
      createdAt: expect.any(String),
      counts: { going: 1, notGoing: 0, maybe: 0, extraGuests: 2 },
      response: 'going',
      extraGuests: 2,
      previousResponse: null,
    });
  });

  it('a changed answer replaces the earlier one', async () => {
    const t = await setup();
    t.answer({ response: 1, extraGuestCount: 1 });
    const changed = t.answer({ response: 2 });
    expect(changed).toMatchObject({
      response: 'notGoing',
      previousResponse: 'going',
      counts: { going: 0, notGoing: 1, maybe: 0, extraGuests: 0 },
    });
    t.answer({
      response: 3,
      from: '919800000002@s.whatsapp.net',
      phone: '919800000002',
    });
    const { body } = await t.get(`/api/events/${t.eventId}`);
    expect(body.counts).toEqual({
      going: 0,
      notGoing: 1,
      maybe: 1,
      extraGuests: 0,
    });
    expect(body.responses).toMatchObject([
      { from: '919800000001', response: 'notGoing' },
      { from: '919800000002', response: 'maybe' },
    ]);
  });

  it('answers signed with LIDs, or with the other JID of the sender, still decrypt', async () => {
    const t = await setup();
    expect(
      t.answer({
        response: 1,
        creatorJid: OUR_LID,
        from: GUEST_LID,
        alt: GUEST_PN,
      }),
    ).toMatchObject({ response: 'going' });
    expect(
      t.answer({
        response: 3,
        from: GUEST_LID,
        alt: GUEST_PN,
        signedAs: GUEST_PN,
      }),
    ).toMatchObject({ response: 'maybe', previousResponse: 'going' });
  });

  it('ignores what it cannot trust: a wrong key, an unknown event, an unknown answer code', async () => {
    const t = await setup();
    expect(t.answer({ response: 1, secret: randomBytes(32) })).toBeNull();
    expect(t.answer({ response: 9 })).toBeNull();
    t.db.delete(events).run();
    expect(t.answer({ response: 1 })).toBeNull();
    expect((await t.get(`/api/events/${t.eventId}`)).status).toBe(404);
  });

  it('GET /api/events lists by chat and ref; a queued event is found by its message id', async () => {
    const t = await setup();
    t.answer({ response: 1 });
    const list = await t.get(`/api/events?chatId=${GROUP}&ref=review-nov`);
    expect(list.body.events).toMatchObject([
      { eventId: t.eventId, counts: { going: 1 } },
    ]);
    expect(list.body.events[0]).not.toHaveProperty('responses');
    expect((await t.get('/api/events?ref=other')).body.events).toEqual([]);

    const row = {
      content: JSON.stringify(EVENT),
      mediaType: 'event',
      scheduledAt: new Date(),
    };
    t.db
      .insert(scheduledMessages)
      .values([
        { id: 'q-sent', ...row, status: 'sent', whatsappMessageId: t.eventId },
        { id: 'q-wait', ...row, status: 'pending' },
      ])
      .run();
    expect((await t.get('/api/events/q-sent')).body.eventId).toBe(t.eventId);
    expect(await t.get('/api/events/q-wait')).toMatchObject({
      status: 409,
      body: { status: 'pending' },
    });
  });
});
