import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { type AppContext, setContext } from '../../context.js';
import { createDatabase } from '../../db/client.js';
import { scheduledMessages } from '../../db/schema.js';
import { recordInbound } from '../../webhooks/chat-activity.js';
import { pollAsText } from '../reply-queue.js';
import { createReplyRouter } from '../reply.router.js';

const CHAT = '919800000001@s.whatsapp.net';
const POLL = { name: 'Pick', options: ['A', 'B'] };

function setup() {
  const db = createDatabase(':memory:');
  migrate(db, { migrationsFolder: resolve(__dirname, '../../../drizzle') });
  const jobs: unknown[] = [];
  const sent: unknown[] = [];
  const queue = { add: async (...a: unknown[]) => jobs.push(a) };
  const sock = {
    sendPresenceUpdate: async () => {},
    sendMessage: async (_j: string, content: unknown) => {
      sent.push(content);
      return { key: { id: 'NOW1' } };
    },
    signalRepository: {
      lidMapping: {
        getLIDForPN: async () => null,
        getPNForLID: async () => null,
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
  app.route('/api/reply', createReplyRouter(queue as never));
  const post = async (body: Record<string, unknown>) => {
    const res = await app.request('/api/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: CHAT, typing: false, ...body }),
    });
    return {
      status: res.status,
      body: (await res.json()) as Record<string, unknown>,
    };
  };
  const queued = () => db.select().from(scheduledMessages).all();
  return { db, jobs, sent, post, queued };
}

const DAY = 24 * 3_600_000;

describe('dontSkip and forcePoll outside the window', () => {
  it('without a flag: 409 as before', async () => {
    const t = setup();
    expect((await t.post({ text: 'hi' })).status).toBe(409);
    expect(t.jobs).toHaveLength(0);
  });

  it('dontSkip queues text through the queued route', async () => {
    const t = setup();
    const r = await t.post({
      text: 'hi',
      dontSkip: true,
      reaction: { messageId: 'X', emoji: '👍' },
    });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({
      queued: true,
      sentAs: 'text',
      dropped: ['reaction'],
      replyWindow: { open: false },
    });
    expect(t.jobs).toHaveLength(1);
    expect(t.queued()[0]).toMatchObject({ content: 'hi', status: 'pending' });
    expect(t.sent).toHaveLength(0);
  });

  it('dontSkip sends a poll as numbered text', async () => {
    const t = setup();
    const r = await t.post({ poll: POLL, dontSkip: true });
    expect(r.body).toMatchObject({ queued: true, sentAs: 'pollAsText' });
    expect(t.queued()[0].content).toBe(pollAsText(POLL));
    expect(t.queued()[0].content).toBe(
      'Pick\n\n1. A\n2. B\n\nReply with the number of your choice.',
    );
  });

  it('forcePoll: refused for a chat that never wrote', async () => {
    const t = setup();
    const r = await t.post({ poll: POLL, forcePoll: true });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('force_poll_not_allowed');
    expect(t.jobs).toHaveLength(0);
  });

  it('forcePoll: queues a real poll for a chat that wrote before', async () => {
    const t = setup();
    recordInbound(t.db, CHAT, null, new Date(Date.now() - 3 * DAY));
    const r = await t.post({
      poll: { ...POLL, mode: 'lockFirstVote' },
      forcePoll: true,
    });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({
      sentAs: 'poll',
      replyWindow: { open: false },
    });
    const row = t.queued()[0];
    expect(row.mediaType).toBe('poll');
    expect(JSON.parse(row.content)).toEqual({ ...POLL, mode: 'lockFirstVote' });
  });

  it('a reaction alone cannot be queued', async () => {
    const t = setup();
    const r = await t.post({
      reaction: { messageId: 'X', emoji: '👍' },
      dontSkip: true,
    });
    expect(r.status).toBe(409);
  });

  it('forcePoll needs a poll', async () => {
    const t = setup();
    expect((await t.post({ text: 'hi', forcePoll: true })).status).toBe(400);
  });

  it('inside the window the flags change nothing: sent at once', async () => {
    const t = setup();
    recordInbound(t.db, CHAT, null);
    const r = await t.post({ poll: POLL, dontSkip: true });
    expect(r.status).toBe(200);
    expect(r.body.messageId).toBe('NOW1');
    expect(t.jobs).toHaveLength(0);
    expect(
      t.db
        .select()
        .from(scheduledMessages)
        .where(eq(scheduledMessages.status, 'pending'))
        .all(),
    ).toHaveLength(0);
  });
});
