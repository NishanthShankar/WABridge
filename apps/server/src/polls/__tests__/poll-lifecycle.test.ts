import {
  createCipheriv,
  createHash,
  createHmac,
  randomBytes,
} from 'node:crypto';
import { resolve } from 'node:path';
import { proto } from '@whiskeysockets/baileys';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { Hono } from 'hono';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AppContext, setContext } from '../../context.js';
import { createDatabase } from '../../db/client.js';
import {
  pollVotes,
  polls,
  scheduledMessages,
  webhooks,
} from '../../db/schema.js';
import { createReplyRouter } from '../../reply/reply.router.js';
import { recordInbound } from '../../webhooks/chat-activity.js';
import {
  DELETE_RETRY_MS,
  attachPollJobs,
  releaseAllAwaiting,
  sweepPolls,
} from '../poll-jobs.js';
import { getPoll, handlePollVote } from '../polls.js';
import { createPollsRouter } from '../polls.router.js';
import { ackVote, holdVote } from '../stealth-inbox.js';

const logger = pino({ level: 'silent' });
const CHAT = '919800000001@s.whatsapp.net';
const VOTER = '555000111@lid';
const OUR_PN = '919800000009@s.whatsapp.net';

/** Encrypt a vote the way the voter's phone does. */
function encryptVote(o: {
  pollId: string;
  secret: Buffer;
  selected: string[];
}): proto.Message.IPollUpdateMessage {
  const sign = Buffer.concat([
    Buffer.from(o.pollId),
    Buffer.from(OUR_PN),
    Buffer.from(VOTER),
    Buffer.from('Poll Vote'),
    new Uint8Array([1]),
  ]);
  const key0 = createHmac('sha256', new Uint8Array(32))
    .update(o.secret)
    .digest();
  const decKey = createHmac('sha256', key0).update(sign).digest();
  const aad = Buffer.from(`${o.pollId}\u0000${VOTER}`);
  const iv = randomBytes(12);
  const plain = proto.Message.PollVoteMessage.encode({
    selectedOptions: o.selected.map((x) =>
      createHash('sha256').update(x).digest(),
    ),
  }).finish();
  const c = createCipheriv('aes-256-gcm', decKey, iv);
  c.setAAD(aad);
  const enc = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return {
    pollCreationMessageKey: { id: o.pollId },
    vote: { encPayload: enc, encIv: iv },
  };
}

const hooks: Array<Record<string, unknown>> = [];
beforeEach(() => {
  hooks.length = 0;
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    hooks.push(JSON.parse(init.body));
    return new Response('ok', { status: 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());
const tick = () => new Promise((r) => setTimeout(r, 20));

function setup() {
  const db = createDatabase(':memory:');
  migrate(db, { migrationsFolder: resolve(__dirname, '../../../drizzle') });
  db.insert(webhooks)
    .values({
      id: 'w1',
      url: 'http://hook.test',
      enabled: true,
      allEvents: true,
    })
    .run();
  const sent: Array<Record<string, unknown>> = [];
  const secrets: Buffer[] = [];
  const ctl = { failDeletes: 0 };
  const sock = {
    ws: { isOpen: true },
    user: { id: '919800000009:12@s.whatsapp.net', lid: '777888:12@lid' },
    sendPresenceUpdate: async () => {},
    sendMessage: async (_jid: string, content: Record<string, unknown>) => {
      if (content.delete && ctl.failDeletes > 0) {
        ctl.failDeletes--;
        throw new Error('delete refused');
      }
      sent.push(content);
      const poll = content.poll as { messageSecret?: Buffer } | undefined;
      if (poll?.messageSecret) secrets.push(poll.messageSecret);
      return { key: { id: `MSG${sent.length}` } };
    },
    signalRepository: { lidMapping: { getLIDForPN: async () => null } },
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
  app.route('/api/polls', createPollsRouter());
  recordInbound(db, CHAT, null);
  attachPollJobs(sock as never, db, logger);
  const post = async (poll: Record<string, unknown>) => {
    const res = await app.request('/api/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: CHAT, poll }),
    });
    return {
      status: res.status,
      body: (await res.json()) as Record<string, unknown>,
    };
  };
  const sendPoll = async (poll: Record<string, unknown>) => {
    const r = await post(poll);
    expect(r.status).toBe(200);
    return { id: r.body.messageId as string, secret: secrets.at(-1) as Buffer };
  };
  const vote = (p: { id: string; secret: Buffer }, selected: string[]) =>
    handlePollVote({
      sock: sock as never,
      db,
      logger,
      update: encryptVote({ pollId: p.id, secret: p.secret, selected }),
      voterJid: VOTER,
      voterAltJid: CHAT,
      voterPhone: '919800000001',
    });
  const deletes = () => sent.filter((c) => c.delete);
  return { db, app, post, sendPoll, vote, sent, deletes, ctl };
}

describe('poll ref and lookups', () => {
  it('echoes ref in poll.vote and filters GET /api/polls by it', async () => {
    const t = setup();
    const p = await t.sendPoll({
      name: 'Q',
      options: ['A', 'B'],
      ref: 'kural-q-42',
    });
    expect(await t.vote(p, ['A'])).toMatchObject({ ref: 'kural-q-42' });
    const list = await (
      await t.app.request('/api/polls?ref=kural-q-42')
    ).json();
    expect(list.polls.map((x: { id: string }) => x.id)).toEqual([p.id]);
    const none = await (await t.app.request('/api/polls?ref=other')).json();
    expect(none.polls).toEqual([]);
  });

  it('GET and DELETE accept the scheduledMessageId of a queued poll', async () => {
    const t = setup();
    const p = await t.sendPoll({ name: 'Q', options: ['A', 'B'] });
    t.db
      .insert(scheduledMessages)
      .values({
        id: 'sched-1',
        content: '{}',
        scheduledAt: new Date(),
        status: 'delivered',
        mediaType: 'poll',
        whatsappMessageId: p.id,
      })
      .run();
    t.db
      .insert(scheduledMessages)
      .values({
        id: 'sched-2',
        content: '{}',
        scheduledAt: new Date(),
        status: 'failed',
        mediaType: 'poll',
      })
      .run();
    const got = await (await t.app.request('/api/polls/sched-1')).json();
    expect(got.id).toBe(p.id);
    const notSent = await t.app.request('/api/polls/sched-2');
    expect(notSent.status).toBe(409);
    expect((await notSent.json()).error).toBe('not_sent_yet');
    const del = await t.app.request('/api/polls/sched-1', { method: 'DELETE' });
    expect(await del.json()).toMatchObject({ deleted: true, pollId: p.id });
  });
});

describe('deleteAt', () => {
  it('deletes an unanswered poll when its time comes and reports poll.deleted', async () => {
    const t = setup();
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const p = await t.sendPoll({
      name: 'Q',
      options: ['A', 'B'],
      deleteAt: at,
      ref: 'r1',
    });
    await sweepPolls(t.db);
    expect(t.deletes()).toHaveLength(0);
    await sweepPolls(t.db, Date.now() + 2 * 3_600_000);
    expect(t.deletes()).toHaveLength(1);
    expect(getPoll(t.db, p.id)?.deletedAt).toBeTruthy();
    await tick();
    expect(hooks.at(-1)).toMatchObject({
      event: 'poll.deleted',
      reason: 'expired',
      pollId: p.id,
      ref: 'r1',
    });
  });

  it('keeps a poll someone voted on', async () => {
    const t = setup();
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const p = await t.sendPoll({
      name: 'Q',
      options: ['A', 'B'],
      deleteAt: at,
      stealth: true,
    });
    await t.vote(p, ['B']);
    await sweepPolls(t.db, Date.now() + 2 * 3_600_000);
    expect(t.deletes()).toHaveLength(0);
    expect(getPoll(t.db, p.id)).toMatchObject({
      deletedAt: null,
      deleteAt: null,
    });
    expect(getPoll(t.db, p.id)?.votedAt).toBeTruthy();
  });

  it('refuses deleteAt more than 48 hours away, or in the past', async () => {
    const t = setup();
    for (const ms of [49 * 3_600_000, -60_000]) {
      const r = await t.post({
        name: 'Q',
        options: ['A', 'B'],
        deleteAt: new Date(Date.now() + ms).toISOString(),
      });
      expect(r.status).toBe(400);
    }
  });
});

describe('failed deletes', () => {
  it('retries a failed deleteAfterVote delete by itself', async () => {
    const t = setup();
    const p = await t.sendPoll({
      name: 'Q',
      options: ['A', 'B'],
      mode: 'deleteAfterVote',
      confirmText: false,
    });
    t.ctl.failDeletes = 1;
    expect(await t.vote(p, ['A'])).toMatchObject({ pollDeleted: false });
    expect(getPoll(t.db, p.id)).toMatchObject({
      deleteAttempts: 1,
      deleteReason: 'voted',
    });
    await sweepPolls(t.db, Date.now() + DELETE_RETRY_MS[0] + 1000);
    expect(getPoll(t.db, p.id)?.deletedAt).toBeTruthy();
    await tick();
    expect(hooks.at(-1)).toMatchObject({
      event: 'poll.deleted',
      reason: 'voted',
      attempts: 2,
    });
  });

  it('gives up after the last retry and reports poll.delete_failed', async () => {
    const t = setup();
    const p = await t.sendPoll({
      name: 'Q',
      options: ['A', 'B'],
      mode: 'deleteAfterVote',
      confirmText: false,
    });
    t.ctl.failDeletes = 99;
    await t.vote(p, ['A']);
    let now = Date.now();
    for (const wait of DELETE_RETRY_MS) {
      now += wait + 1000;
      await sweepPolls(t.db, now);
    }
    const row = getPoll(t.db, p.id);
    expect(row?.deleteFailedAt).toBeTruthy();
    expect(row?.deletedAt).toBeNull();
    await tick();
    expect(hooks.filter((h) => h.event === 'poll.delete_failed')).toHaveLength(
      1,
    );
    expect(hooks.at(-1)).toMatchObject({
      event: 'poll.delete_failed',
      reason: 'voted',
      attempts: 6,
    });
  });
});

describe('stealth deleteAfterVote waits for the acknowledgment', () => {
  it('deletes only after the vote is acknowledged', async () => {
    const t = setup();
    const p = await t.sendPoll({
      name: 'Q',
      options: ['A', 'B'],
      mode: 'deleteAfterVote',
      stealth: true,
    });
    const v = (await t.vote(p, ['B'])) as Record<string, unknown>;
    expect(v).toMatchObject({
      awaitingAck: true,
      pollDeleted: false,
      current: ['B'],
    });
    expect(t.deletes()).toHaveLength(0);
    expect(t.sent.some((c) => c.text)).toBe(false); // no "You chose" yet
    const held = holdVote(t.db, v);
    expect(JSON.stringify(held)).not.toContain('afterAck');
    expect(ackVote(t.db, held.voteId as string)).toBe(true);
    await tick();
    expect(t.sent.find((c) => c.text)?.text).toBe('You chose B');
    expect(t.deletes()).toHaveLength(1);
    const rows = t.db.select().from(pollVotes).all();
    expect(rows).toEqual([
      expect.objectContaining({ note: 'hidden', selected: '[]' }),
    ]);
    expect(hooks.at(-1)).toMatchObject({
      event: 'poll.deleted',
      reason: 'voted',
    });
  });

  it('an unacknowledged vote expires: the poll stays and they can vote again', async () => {
    const t = setup();
    const p = await t.sendPoll({
      name: 'Q',
      options: ['A', 'B'],
      mode: 'deleteAfterVote',
      stealth: true,
    });
    const v = (await t.vote(p, ['A'])) as Record<string, unknown>;
    holdVote(t.db, v, 20);
    expect(t.db.select().from(pollVotes).all()[0].note).toBe('awaiting_ack');
    await new Promise((r) => setTimeout(r, 50));
    expect(t.db.select().from(pollVotes).all()).toHaveLength(0);
    expect(getPoll(t.db, p.id)).toMatchObject({
      deletedAt: null,
      votedAt: null,
    });
    expect(t.deletes()).toHaveLength(0);
    expect(await t.vote(p, ['B'])).toMatchObject({
      counted: true,
      note: null,
      awaitingAck: true,
    });
  });

  it('a restart releases votes that were waiting', async () => {
    const t = setup();
    const p = await t.sendPoll({
      name: 'Q',
      options: ['A', 'B'],
      mode: 'deleteAfterVote',
      stealth: true,
    });
    await t.vote(p, ['A']);
    releaseAllAwaiting(t.db);
    expect(t.db.select().from(pollVotes).all()).toHaveLength(0);
    expect(
      t.db.select().from(polls).where(eq(polls.id, p.id)).get()?.votedAt,
    ).toBeNull();
  });
});
