import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { Hono } from 'hono';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AppContext, setContext } from '../../context.js';
import { createDatabase } from '../../db/client.js';
import { webhooks } from '../../db/schema.js';
import { createReplyRouter } from '../../reply/reply.router.js';
import { recordInbound } from '../../webhooks/chat-activity.js';
import {
  getLastRead,
  getPresence,
  replyWindow,
  setupChatStateListener,
} from '../chat-state.js';
import { createChatsRouter } from '../chats.router.js';

const CHAT = '919800000001@s.whatsapp.net';
const LID = '555000111@lid';
const logger = pino({ level: 'silent' });

function setup() {
  const db = createDatabase(':memory:');
  migrate(db, { migrationsFolder: resolve(__dirname, '../../../drizzle') });
  const now = new Date();
  db.insert(webhooks)
    .values({
      id: 'w1',
      phone: null,
      url: 'https://hook.test/x',
      enabled: true,
      allEvents: true,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const ev = new EventEmitter();
  const sent: unknown[] = [];
  const subscribed: string[] = [];
  const sock = {
    ev: {
      on: (name: string, fn: (...a: unknown[]) => void) => ev.on(name, fn),
    },
    sendPresenceUpdate: async () => {},
    sendMessage: async (_j: string, content: unknown) => {
      sent.push(content);
      return { key: { id: `MSG${sent.length}` } };
    },
    presenceSubscribe: async (jid: string) => {
      subscribed.push(jid);
    },
    signalRepository: {
      lidMapping: {
        getLIDForPN: async (pn: string) => (pn === CHAT ? LID : null),
        getPNForLID: async (lid: string) => (lid === LID ? CHAT : null),
      },
    },
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    setContext(c, {
      db,
      getSocket: () => sock,
      tenantId: 't1',
    } as unknown as AppContext);
    await next();
  });
  app.route('/api/reply', createReplyRouter());
  app.route('/api/chats', createChatsRouter());
  const post = (body: unknown) =>
    app.request('/api/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { db, ev, sock, sent, subscribed, app, post };
}

afterEach(() => vi.unstubAllGlobals());

describe('reply window', () => {
  it('reports open, closesAt and seconds since they wrote', () => {
    const t = setup();
    const at = new Date('2026-11-18T10:00:00Z');
    recordInbound(t.db, LID, CHAT, at);
    const w = replyWindow(t.db, [CHAT], at.getTime() + 90_000);
    expect(w).toEqual({
      open: true,
      lastInboundAt: '2026-11-18T10:00:00.000Z',
      closesAt: '2026-11-19T10:00:00.000Z',
      secondsSinceInbound: 90,
    });
    expect(replyWindow(t.db, [CHAT], at.getTime() + 25 * 3_600_000).open).toBe(
      false,
    );
    expect(replyWindow(t.db, ['1@s.whatsapp.net']).lastInboundAt).toBeNull();
  });

  it('GET /api/reply/window and every /api/reply answer carry replyWindow', async () => {
    const t = setup();
    expect(
      await (
        await t.app.request(`/api/reply/window?phone=919800000001`)
      ).json(),
    ).toMatchObject({
      chatId: CHAT,
      replyWindow: { open: false },
    });
    const closed = await t.post({ chatId: CHAT, text: 'hi' });
    expect(closed.status).toBe(409);
    expect(await closed.json()).toMatchObject({ replyWindow: { open: false } });
    recordInbound(t.db, LID, null); // they wrote from their LID: opens the phone chat too
    const ok = await t.post({ chatId: CHAT, text: 'hi', typing: false });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      messageId: 'MSG1',
      replyWindow: { open: true },
    });
  });
});

describe('rate limit weights', () => {
  it('a message weighs 1 and a reaction 0.25', async () => {
    const t = setup();
    recordInbound(t.db, CHAT, null);
    const reaction = { messageId: 'X', emoji: '👍' };
    for (let i = 0; i < 11; i++)
      expect(
        (await t.post({ chatId: CHAT, text: `m${i}`, typing: false })).status,
      ).toBe(200);
    for (let i = 0; i < 4; i++)
      expect((await t.post({ chatId: CHAT, reaction })).status).toBe(200);
    const over = await t.post({ chatId: CHAT, reaction });
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({
      error: 'too_many_replies',
      retryAfterSeconds: expect.any(Number),
    });
  });

  it('48 reactions fit in a minute', async () => {
    const t = setup();
    recordInbound(t.db, CHAT, null);
    for (let i = 0; i < 48; i++)
      expect(
        (
          await t.post({
            chatId: CHAT,
            reaction: { messageId: `X${i}`, emoji: '👍' },
          })
        ).status,
      ).toBe(200);
    expect(
      (
        await t.post({
          chatId: CHAT,
          reaction: { messageId: 'Y', emoji: '👍' },
        })
      ).status,
    ).toBe(429);
  });
});

describe('presence and read receipts', () => {
  const tick = () => new Promise((r) => setTimeout(r, 20));
  const hooked = () => {
    const calls: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      calls.push(JSON.parse(init.body));
      return new Response('', { status: 200 });
    });
    return calls;
  };

  it('records presence under the phone chat and fires presence.update', async () => {
    const t = setup();
    const calls = hooked();
    setupChatStateListener(t.sock as never, t.db, logger);
    t.ev.emit('presence.update', {
      id: LID,
      presences: { [LID]: { lastKnownPresence: 'composing' } },
    });
    await tick();
    expect(getPresence(t.sock, [CHAT])).toMatchObject({
      presence: 'composing',
    });
    expect(calls[0]).toMatchObject({
      event: 'presence.update',
      from: '919800000001',
      presence: 'composing',
      isGroup: false,
    });
  });

  it('1:1 read receipts: message.read once, and lastRead on GET /api/chats/:id', async () => {
    const t = setup();
    const calls = hooked();
    setupChatStateListener(t.sock as never, t.db, logger);
    const upd = [
      {
        key: { remoteJid: CHAT, id: 'M1', fromMe: true },
        update: { status: 4 },
      },
    ];
    t.ev.emit('messages.update', upd);
    t.ev.emit('messages.update', upd);
    // their own messages and delivery acks are ignored
    t.ev.emit('messages.update', [
      {
        key: { remoteJid: CHAT, id: 'M2', fromMe: false },
        update: { status: 4 },
      },
    ]);
    t.ev.emit('messages.update', [
      {
        key: { remoteJid: CHAT, id: 'M3', fromMe: true },
        update: { status: 3 },
      },
    ]);
    await tick();
    expect(calls.filter((c) => c.event === 'message.read')).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      messageId: 'M1',
      status: 'read',
      from: '919800000001',
    });
    const body = (await (
      await t.app.request('/api/chats/919800000001')
    ).json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      chatId: CHAT,
      lastRead: { messageId: 'M1', status: 'read' },
    });
  });

  it('group receipts per member', async () => {
    const t = setup();
    const calls = hooked();
    setupChatStateListener(t.sock as never, t.db, logger);
    t.ev.emit('message-receipt.update', [
      {
        key: { remoteJid: '1203@g.us', id: 'G1', fromMe: true },
        receipt: { userJid: LID, readTimestamp: 1794940000 },
      },
      {
        key: { remoteJid: 'status@broadcast', id: 'S1', fromMe: true },
        receipt: { userJid: LID, readTimestamp: 1 },
      },
    ]);
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      event: 'message.read',
      chatId: '1203@g.us',
      isGroup: true,
      from: '919800000001',
    });
    expect(getLastRead(t.sock, ['1203@g.us'])).toMatchObject({
      messageId: 'G1',
    });
  });

  it('GET /api/chats/:id/presence subscribes once a minute and waits for a fresh update', async () => {
    const t = setup();
    hooked();
    setupChatStateListener(t.sock as never, t.db, logger);
    setTimeout(
      () =>
        t.ev.emit('presence.update', {
          id: CHAT,
          presences: { [CHAT]: { lastKnownPresence: 'available' } },
        }),
      100,
    );
    const body = (await (
      await t.app.request('/api/chats/919800000001/presence?wait=2000')
    ).json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      presence: { presence: 'available' },
      fresh: true,
    });
    await t.app.request('/api/chats/919800000001/presence');
    expect(t.subscribed).toEqual([CHAT]);
  });
});
