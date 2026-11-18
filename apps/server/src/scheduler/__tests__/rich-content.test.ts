import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { type AppContext, setContext } from '../../context.js';
import { createDatabase } from '../../db/client.js';
import { scheduledMessages } from '../../db/schema.js';
import { createReplyRouter } from '../../reply/reply.router.js';
import { createSchedulingRouter } from '../../scheduling/scheduling.router.js';
import { recordInbound } from '../../webhooks/chat-activity.js';
import { buildMessagePayload } from '../message-payload.js';
import { buildVcard } from '../rich-content.js';

const CHAT = '919800000001@s.whatsapp.net';
const CLINIC = {
  latitude: 12.9716,
  longitude: 77.5946,
  name: 'City Clinic',
  address: 'MG Road',
};
const DOCTOR = {
  name: 'Dr. Rao',
  phone: '+91 98123 45678',
  org: 'City Clinic',
};

describe('payloads', () => {
  it('location', () => {
    expect(
      buildMessagePayload(JSON.stringify(CLINIC), null, 'location'),
    ).toEqual({
      location: {
        degreesLatitude: 12.9716,
        degreesLongitude: 77.5946,
        name: 'City Clinic',
        address: 'MG Road',
      },
    });
  });

  it('one contact card, with a WhatsApp number on the TEL line', () => {
    const p = buildMessagePayload(JSON.stringify(DOCTOR), null, 'contact') as {
      contacts: { displayName: string; contacts: { vcard: string }[] };
    };
    expect(p.contacts.displayName).toBe('Dr. Rao');
    expect(p.contacts.contacts[0].vcard).toContain(
      'TEL;type=CELL;type=VOICE;waid=919812345678:+919812345678',
    );
    expect(p.contacts.contacts[0].vcard).toContain('ORG:City Clinic;');
  });

  it('several cards in one message', () => {
    const p = buildMessagePayload(
      JSON.stringify([DOCTOR, { name: 'Desk', phone: '919800000000' }]),
      null,
      'contact',
    ) as {
      contacts: { displayName: string; contacts: unknown[] };
    };
    expect(p.contacts).toMatchObject({ displayName: '2 contacts' });
    expect(p.contacts.contacts).toHaveLength(2);
  });

  it('a name cannot break out of its vCard line', () => {
    expect(
      buildVcard({ name: 'A\nTEL:1;x', phone: '919800000000' }),
    ).not.toMatch(/\nTEL:1/);
  });

  it('sticker and round video note', () => {
    expect(
      buildMessagePayload('ignored', 'https://x.test/s.webp', 'sticker'),
    ).toEqual({ sticker: { url: 'https://x.test/s.webp' } });
    expect(
      buildMessagePayload('ignored', 'https://x.test/v.mp4', 'videoNote'),
    ).toEqual({
      video: { url: 'https://x.test/v.mp4' },
      ptv: true,
    });
  });
});

function setup() {
  const db = createDatabase(':memory:');
  migrate(db, { migrationsFolder: resolve(__dirname, '../../../drizzle') });
  const sent: unknown[] = [];
  const jobs: unknown[] = [];
  const sock = {
    sendPresenceUpdate: async () => {},
    sendMessage: async (_j: string, content: unknown) => {
      sent.push(content);
      return { key: { id: `S${sent.length}` } };
    },
    signalRepository: {
      lidMapping: {
        getLIDForPN: async () => null,
        getPNForLID: async () => null,
      },
    },
  };
  const queue = { add: async (...a: unknown[]) => jobs.push(a) };
  const app = new Hono();
  app.use('*', async (c, next) => {
    setContext(c, {
      db,
      getSocket: () => sock,
      tenantId: 't1',
    } as unknown as AppContext);
    await next();
  });
  app.route('/api/reply', createReplyRouter(queue as never));
  app.route('/api/messages', createSchedulingRouter(queue as never));
  const post = async (path: string, body: object) => {
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      body: (await res.json()) as Record<string, unknown>,
    };
  };
  return { db, sent, post };
}

describe('POST /api/reply', () => {
  it('sends text then a location', async () => {
    const t = setup();
    recordInbound(t.db, CHAT, null);
    const r = await t.post('/api/reply', {
      chatId: CHAT,
      text: 'We are here:',
      location: CLINIC,
      typing: false,
    });
    expect(r.status).toBe(200);
    expect(t.sent).toEqual([
      { text: 'We are here:' },
      expect.objectContaining({ location: expect.any(Object) }),
    ]);
    expect(r.body.messageId).toBe('S2');
  });

  it('sends a contact card and a round video note', async () => {
    const t = setup();
    recordInbound(t.db, CHAT, null);
    expect(
      (await t.post('/api/reply', { chatId: CHAT, contact: DOCTOR })).status,
    ).toBe(200);
    expect(
      (
        await t.post('/api/reply', {
          chatId: CHAT,
          mediaUrl: 'https://x.test/v.mp4',
          mediaType: 'videoNote',
          typing: false,
        })
      ).status,
    ).toBe(200);
    expect(t.sent[0]).toHaveProperty('contacts');
    expect(t.sent[1]).toMatchObject({ ptv: true });
  });

  it('one kind per request', async () => {
    const t = setup();
    expect(
      (
        await t.post('/api/reply', {
          chatId: CHAT,
          location: CLINIC,
          contact: DOCTOR,
        })
      ).status,
    ).toBe(400);
  });

  it('dontSkip queues the location, dropping text', async () => {
    const t = setup();
    const r = await t.post('/api/reply', {
      chatId: CHAT,
      text: 'hi',
      location: CLINIC,
      dontSkip: true,
    });
    expect(r.status).toBe(202);
    expect(r.body.dropped).toEqual(['text']);
    const row = t.db.select().from(scheduledMessages).get();
    expect(row).toMatchObject({
      mediaType: 'location',
      content: JSON.stringify(CLINIC),
    });
  });
});

describe('POST /api/messages', () => {
  it('stores a location and a contact like polls: JSON in content', async () => {
    const t = setup();
    expect(
      (
        await t.post('/api/messages', {
          phone: '+919800000001',
          location: CLINIC,
          scheduledAt: '2099-01-01T00:00:00Z',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await t.post('/api/messages', {
          phone: '+919800000001',
          contact: [DOCTOR],
          scheduledAt: '2099-01-01T00:00:00Z',
        })
      ).status,
    ).toBe(201);
    const rows = t.db.select().from(scheduledMessages).all();
    expect(rows.map((r) => r.mediaType)).toEqual(['location', 'contact']);
    expect(JSON.parse(rows[0].content)).toEqual(CLINIC);
  });

  it('bulk too, and sticker as a media type', async () => {
    const t = setup();
    const r = await t.post('/api/messages/bulk', {
      messages: [
        {
          phone: '+919800000001',
          location: CLINIC,
          scheduledAt: '2099-01-01T00:00:00Z',
        },
        {
          phone: '+919800000001',
          mediaUrl: 'https://x.test/s.webp',
          mediaType: 'sticker',
          scheduledAt: '2099-01-01T00:00:00Z',
        },
      ],
    });
    expect(r.status).toBe(201);
    expect(
      t.db
        .select()
        .from(scheduledMessages)
        .all()
        .map((x) => x.mediaType),
    ).toEqual(['location', 'sticker']);
  });

  it('refuses a location with a mediaUrl, and a bad latitude', async () => {
    const t = setup();
    expect(
      (
        await t.post('/api/messages', {
          phone: '+919800000001',
          location: CLINIC,
          mediaUrl: 'https://x.test/a.jpg',
          mediaType: 'image',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await t.post('/api/messages', {
          phone: '+919800000001',
          location: { ...CLINIC, latitude: 120 },
        })
      ).status,
    ).toBe(400);
  });
});
