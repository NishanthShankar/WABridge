import {
  createCipheriv,
  createHash,
  createHmac,
  randomBytes,
} from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { proto } from '@whiskeysockets/baileys';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { Hono } from 'hono';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { privateMiddleware } from '../api/private.js';
import { configSchema } from '../config/schema.js';
import { type AppContext, setContext } from '../context.js';
import { createDatabase } from '../db/client.js';
import {
  closePrivateDb,
  isPrivateDb,
  peekPrivateDb,
  privateDb,
} from '../db/private.js';
import {
  contacts,
  pollVotes,
  polls,
  scheduledMessages,
  webhooks,
} from '../db/schema.js';
import { createPollsRouter } from '../polls/polls.router.js';
import { createRateLimiter } from '../rate-limit/rate-limiter.js';
import { createReplyRouter } from '../reply/reply.router.js';
import { contextFor, processSendJob } from '../scheduler/worker.js';
import { createSchedulingRouter } from '../scheduling/scheduling.router.js';
import { recordInbound } from '../webhooks/chat-activity.js';
import { setupWebhookListener } from '../webhooks/webhook.listener.js';
import { createWebhooksRouter } from '../webhooks/webhooks.router.js';

const logger = pino({ level: 'silent' });
const SECRET_TEXT = 'your test result is ready zq7';
const PHONE = '919812345678';
const CHAT = `${PHONE}@s.whatsapp.net`;
const CONTACT_ID = '0b0e2c1e-6f0a-4a57-9d3e-2f1a4c5b6d7e';
const VOTER = '555000111@lid';
const OUR_PN = '919800000009@s.whatsapp.net';
const tick = () => new Promise((r) => setTimeout(r, 20));

const hooks: Array<Record<string, unknown>> = [];
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wab-private-'));
  hooks.length = 0;
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    hooks.push(JSON.parse(init.body));
    return new Response('ok', { status: 200 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

/** Everything the account's database has on disk, as one buffer. */
function diskBytes(): Buffer {
  return Buffer.concat(readdirSync(dir).map((f) => readFileSync(join(dir, f))));
}

function setup() {
  const db = createDatabase(join(dir, 'openwa.db'));
  migrate(db, { migrationsFolder: resolve(__dirname, '../../drizzle') });
  db.insert(webhooks)
    .values({
      id: 'w1',
      url: 'http://hook.test',
      enabled: true,
      allEvents: true,
    })
    .run();
  const config = configSchema.parse({});
  const jobs: Array<Record<string, unknown>> = [];
  const queue = {
    add: async (_name: string, data: Record<string, unknown>) => {
      jobs.push(data);
    },
    getJob: async () => null,
  };
  const sent: Array<{ jid: string; content: Record<string, unknown> }> = [];
  const secrets: Buffer[] = [];
  const sock = {
    ws: { isOpen: true },
    ev: new EventEmitter(),
    user: { id: '919800000009:12@s.whatsapp.net', lid: '777888:12@lid' },
    sendPresenceUpdate: async () => {},
    sendMessage: async (jid: string, content: Record<string, unknown>) => {
      sent.push({ jid, content });
      const poll = content.poll as { messageSecret?: Buffer } | undefined;
      if (poll?.messageSecret) secrets.push(poll.messageSecret);
      return { key: { id: `WA${sent.length}` } };
    },
    groupMetadata: async () => ({ participants: [] }),
    signalRepository: { lidMapping: { getLIDForPN: async () => null } },
  };
  const ctx = {
    db,
    config,
    rateLimiter: createRateLimiter(db, config, () => {}),
    broadcast: () => {},
    getSocket: () => sock,
    getHealth: () => ({}),
    tenantId: 't1',
  } as unknown as AppContext;
  const app = new Hono();
  app.use('*', async (c, next) => {
    setContext(c, ctx);
    await next();
  });
  app.use('*', privateMiddleware());
  app.route('/api/messages', createSchedulingRouter(queue as never));
  app.route('/api/reply', createReplyRouter(queue as never));
  app.route('/api/polls', createPollsRouter(queue as never));
  app.route('/api/webhooks', createWebhooksRouter());
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await app.request(path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    // biome-ignore lint/suspicious/noExplicitAny: response bodies of several routes
    return { status: res.status, body: (await res.json()) as any, res };
  };
  /** Run the queued job the way the worker does. */
  const runJob = async (job: Record<string, unknown>) => {
    const jobCtx = contextFor(() => ctx, job);
    if (jobCtx)
      await processSendJob(
        jobCtx,
        {
          ...config,
          rate_limit: {
            ...config.rate_limit,
            min_delay_ms: 0,
            max_delay_ms: 0,
          },
        },
        job.scheduledMessageId as string,
        logger,
      );
  };
  return { db, ctx, app, call, jobs, sent, secrets, sock, runJob };
}

describe('the private database', () => {
  it('keeps writes in memory, reads settings from disk, and cannot write to disk', () => {
    const t = setup();
    const priv = privateDb(t.db);
    expect(isPrivateDb(priv)).toBe(true);
    expect(privateDb(t.db)).toBe(priv);

    priv
      .insert(polls)
      .values({
        id: 'P1',
        chatJid: CHAT,
        name: SECRET_TEXT,
        options: '[]',
        selectableCount: 1,
        mode: 'updateEveryTime',
        secret: 'x',
        createdAt: new Date(),
      })
      .run();
    expect(priv.select().from(polls).all()).toHaveLength(1);
    expect(t.db.select().from(polls).all()).toEqual([]);

    // Settings are read through, including ones added later
    expect(
      priv
        .select()
        .from(webhooks)
        .all()
        .map((w) => w.id),
    ).toEqual(['w1']);
    t.db.insert(webhooks).values({ id: 'w2', url: 'http://b.test' }).run();
    expect(priv.select().from(webhooks).all()).toHaveLength(2);

    // ...but never written
    expect(() =>
      priv.insert(webhooks).values({ id: 'w3', url: 'http://c.test' }).run(),
    ).toThrow(/readonly/i);

    expect(diskBytes().includes(SECRET_TEXT)).toBe(false);

    // A restart: the private rows are gone
    closePrivateDb(t.db);
    expect(privateDb(t.db).select().from(polls).all()).toEqual([]);
  });
});

describe('a private queued message (POST /api/messages)', () => {
  it('is sent and reported by webhook, and nothing about it reaches the disk', async () => {
    const t = setup();
    const res = await t.call(
      'POST',
      '/api/messages',
      { phone: PHONE, name: 'Priya Private', content: SECRET_TEXT },
      { 'X-Private': 'true' },
    );
    expect(res.status).toBe(201);
    expect(res.res.headers.get('X-Private')).toBe('true');
    const id = res.body.id as string;

    // The job says it is private and carries no content
    expect(t.jobs).toEqual([
      { scheduledMessageId: id, tenantId: 't1', private: true },
    ]);
    // Nothing on disk: no message, no contact
    expect(t.db.select().from(scheduledMessages).all()).toEqual([]);
    expect(t.db.select().from(contacts).all()).toEqual([]);

    // Only a private request can see it
    expect((await t.call('GET', `/api/messages/${id}`)).status).toBe(404);
    const seen = await t.call('GET', `/api/messages/${id}`, undefined, {
      'X-Private': '1',
    });
    expect(seen.body).toMatchObject({ id, status: 'pending' });

    await t.runJob(t.jobs[0]);
    expect(t.sent).toEqual([{ jid: CHAT, content: { text: SECRET_TEXT } }]);
    await tick();
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({
      event: 'message.status',
      private: true,
      scheduledMessageId: id,
      messageId: 'WA1',
      status: 'sent',
      chatId: CHAT,
      phone: PHONE,
    });
    expect(JSON.stringify(hooks[0])).not.toContain(SECRET_TEXT);

    // Once sent, even memory forgets what it said
    const priv = privateDb(t.db);
    expect(priv.select().from(scheduledMessages).all()).toMatchObject([
      { id, status: 'sent', content: '', whatsappMessageId: 'WA1' },
    ]);
    // It counts toward the number's daily cap like any other send
    expect(t.ctx.rateLimiter.getSentTodayCount()).toBe(1);

    // The delivery receipt is passed on too
    setupWebhookListener(t.sock as never, t.db, logger);
    t.sock.ev.emit('messages.update', [
      { key: { id: 'WA1' }, update: { status: 3 } },
    ]);
    await tick();
    expect(hooks.at(-1)).toMatchObject({
      event: 'message.status',
      status: 'delivered',
      scheduledMessageId: id,
    });

    expect(t.db.select().from(scheduledMessages).all()).toEqual([]);
    expect(t.db.select().from(contacts).all()).toEqual([]);
    const bytes = diskBytes();
    for (const needle of [SECRET_TEXT, PHONE, 'Priya Private', id])
      expect(bytes.includes(needle)).toBe(false);
  });

  it('accepts "private": true in the body instead of the header', async () => {
    const t = setup();
    const res = await t.call('POST', '/api/messages', {
      phone: PHONE,
      content: SECRET_TEXT,
      private: true,
    });
    expect(res.status).toBe(201);
    expect(t.jobs[0]).toMatchObject({ private: true });
    expect(t.db.select().from(scheduledMessages).all()).toEqual([]);
  });

  it('without the flag everything is stored as before', async () => {
    const t = setup();
    const res = await t.call('POST', '/api/messages', {
      phone: PHONE,
      content: 'hello',
    });
    expect(res.status).toBe(201);
    expect(res.res.headers.get('X-Private')).toBeNull();
    expect(t.jobs[0]).toEqual({
      scheduledMessageId: res.body.id,
      tenantId: 't1',
    });
    expect(t.db.select().from(scheduledMessages).all()).toHaveLength(1);
    expect(peekPrivateDb(t.db)).toBeNull();
  });

  it('uses a saved contact without changing it', async () => {
    const t = setup();
    const now = new Date();
    t.db
      .insert(contacts)
      .values({
        id: CONTACT_ID,
        phone: `+${PHONE}`,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const res = await t.call(
      'POST',
      '/api/messages',
      { contactId: CONTACT_ID, content: SECRET_TEXT },
      { 'X-Private': 'true' },
    );
    expect(res.status).toBe(201);
    await t.runJob(t.jobs[0]);
    expect(t.sent[0].jid).toBe(CHAT);
    expect(t.db.select().from(contacts).all()).toHaveLength(1);
  });

  it('after a restart there is nothing left to send', async () => {
    const t = setup();
    await t.call(
      'POST',
      '/api/messages',
      { phone: PHONE, content: SECRET_TEXT },
      { 'X-Private': 'true' },
    );
    closePrivateDb(t.db); // the process ended; memory is gone
    await t.runJob(t.jobs[0]);
    expect(t.sent).toEqual([]);
  });
});

describe('private on other routes', () => {
  it('refuses a request that has to store something on disk', async () => {
    const t = setup();
    const res = await t.call(
      'POST',
      '/api/webhooks',
      { url: 'https://example.com/hook' },
      { 'X-Private': 'true' },
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not_available_private');
    expect(t.db.select().from(webhooks).all()).toHaveLength(1);
  });

  it('a private poll and its votes stay in memory; the vote goes to the webhook', async () => {
    const t = setup();
    recordInbound(t.db, CHAT, null); // they wrote to us: the reply window is open
    setupWebhookListener(t.sock as never, t.db, logger);

    const res = await t.call(
      'POST',
      '/api/reply',
      { chatId: CHAT, poll: { name: SECRET_TEXT, options: ['Yes', 'No'] } },
      { 'X-Private': 'true' },
    );
    expect(res.status).toBe(200);
    const pollId = res.body.messageId as string;
    expect(t.db.select().from(polls).all()).toEqual([]);

    // A vote, encrypted the way the voter's phone does
    const secret = t.secrets[0];
    const sign = Buffer.concat([
      Buffer.from(pollId),
      Buffer.from(OUR_PN),
      Buffer.from(VOTER),
      Buffer.from('Poll Vote'),
      new Uint8Array([1]),
    ]);
    const key0 = createHmac('sha256', new Uint8Array(32))
      .update(secret)
      .digest();
    const decKey = createHmac('sha256', key0).update(sign).digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', decKey, iv);
    cipher.setAAD(Buffer.from(`${pollId}\u0000${VOTER}`));
    const plain = proto.Message.PollVoteMessage.encode({
      selectedOptions: [createHash('sha256').update('Yes').digest()],
    }).finish();
    const enc = Buffer.concat([
      cipher.update(plain),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    t.sock.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: VOTER, id: 'VOTE1', fromMe: false },
          message: {
            pollUpdateMessage: {
              pollCreationMessageKey: { id: pollId },
              vote: { encPayload: enc, encIv: iv },
            },
          },
        },
      ],
    });
    await tick();

    const vote = hooks.find((h) => h.event === 'poll.vote');
    expect(vote).toMatchObject({
      pollId,
      selected: ['Yes'],
      counted: true,
      private: true,
    });
    expect(t.db.select().from(polls).all()).toEqual([]);
    expect(t.db.select().from(pollVotes).all()).toEqual([]);
    // Results are readable, by a private request only, until a restart
    expect((await t.call('GET', `/api/polls/${pollId}`)).status).toBe(404);
    const results = await t.call('GET', `/api/polls/${pollId}`, undefined, {
      'X-Private': 'true',
    });
    expect(results.body.results.tally).toEqual({ Yes: 1, No: 0 });
    expect(diskBytes().includes(SECRET_TEXT)).toBe(false);
  });
});
