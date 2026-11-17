import {
  createCipheriv,
  createHash,
  createHmac,
  randomBytes,
} from 'node:crypto';
import { resolve } from 'node:path';
import { proto } from '@whiskeysockets/baileys';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { Hono } from 'hono';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { type AppContext, setContext } from '../../context.js';
import { createDatabase } from '../../db/client.js';
import { createReplyRouter } from '../../reply/reply.router.js';
import { recordInbound } from '../../webhooks/chat-activity.js';
import { getPoll, handlePollVote, judgeVote } from '../polls.js';
import { createPollsRouter } from '../polls.router.js';

const logger = pino({ level: 'silent' });
const CHAT = '919800000001@s.whatsapp.net';
const VOTER_LID = '555000111@lid';
const OUR_PN = '919800000009@s.whatsapp.net';

/** Encrypt a vote exactly as a phone does (inverse of Baileys' decryptPollVote). */
function encryptVote(opts: {
  pollId: string;
  secret: Buffer;
  creatorJid: string;
  voterJid: string;
  selected: string[];
}): proto.Message.IPollUpdateMessage {
  const sign = Buffer.concat([
    Buffer.from(opts.pollId),
    Buffer.from(opts.creatorJid),
    Buffer.from(opts.voterJid),
    Buffer.from('Poll Vote'),
    Buffer.from([1]),
  ]);
  const key0 = createHmac('sha256', Buffer.alloc(32))
    .update(opts.secret)
    .digest();
  const key = createHmac('sha256', key0).update(sign).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${opts.pollId}\u0000${opts.voterJid}`));
  const plain = proto.Message.PollVoteMessage.encode({
    selectedOptions: opts.selected.map((o) =>
      createHash('sha256').update(o).digest(),
    ),
  }).finish();
  const enc = Buffer.concat([
    cipher.update(plain),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    pollCreationMessageKey: { id: opts.pollId, remoteJid: CHAT, fromMe: true },
    vote: { encPayload: enc, encIv: iv },
  };
}

function setup() {
  const db = createDatabase(':memory:');
  migrate(db, { migrationsFolder: resolve(__dirname, '../../../drizzle') });
  const sent: Array<{ jid: string; content: Record<string, unknown> }> = [];
  const secrets: Buffer[] = [];
  const sock = {
    user: { id: '919800000009:12@s.whatsapp.net', lid: '777888:12@lid' },
    sendPresenceUpdate: async () => {},
    sendMessage: async (jid: string, content: Record<string, unknown>) => {
      sent.push({ jid, content });
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
  const sendPoll = async (poll: Record<string, unknown>) => {
    const res = await app.request('/api/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: CHAT, poll }),
    });
    expect(res.status).toBe(200);
    const { messageId } = (await res.json()) as { messageId: string };
    return { id: messageId, secret: secrets.at(-1) as Buffer };
  };
  const settled: Array<Record<string, unknown>> = [];
  const vote = (
    poll: { id: string; secret: Buffer },
    selected: string[],
    creatorJid = OUR_PN,
  ) =>
    handlePollVote({
      settleMs: 30,
      onSettled: (p) => settled.push(p),
      sock: sock as never,
      db,
      logger,
      update: encryptVote({
        pollId: poll.id,
        secret: poll.secret,
        creatorJid,
        voterJid: VOTER_LID,
        selected,
      }),
      voterJid: VOTER_LID,
      voterAltJid: CHAT,
      voterPhone: '919800000001',
    });
  return { db, sent, app, sendPoll, vote, settled };
}

describe('poll votes', () => {
  it('updateEveryTime: decrypts, counts every change and reacts 👍', async () => {
    const t = setup();
    const poll = await t.sendPoll({ name: 'Pick', options: ['A', 'B', 'C'] });
    const v1 = await t.vote(poll, ['B']);
    expect(v1).toMatchObject({
      event: 'poll.vote',
      selected: ['B'],
      counted: true,
      current: ['B'],
    });
    expect(t.sent.at(-1)?.content).toEqual({
      react: {
        text: '👍',
        key: { remoteJid: CHAT, id: poll.id, fromMe: true },
      },
    });
    // creator signed as our LID this time: still decrypts
    const v2 = await t.vote(poll, ['C'], '777888@lid');
    expect(v2).toMatchObject({
      selected: ['C'],
      counted: true,
      current: ['C'],
    });
    const res = await t.app.request(`/api/polls/${poll.id}`);
    const body = (await res.json()) as {
      results: { tally: Record<string, number> };
      votes: unknown[];
    };
    expect(body.results.tally).toEqual({ A: 0, B: 0, C: 1 });
    expect(body.votes).toHaveLength(2);
  });

  it('lockFirstVote: the first answer stays, later ones are recorded as locked', async () => {
    const t = setup();
    const poll = await t.sendPoll({
      name: 'Pick',
      options: ['A', 'B'],
      mode: 'lockFirstVote',
      confirmText: 'Locked in: {{option}}',
    });
    expect(await t.vote(poll, ['A'])).toMatchObject({
      counted: true,
      current: ['A'],
    });
    expect(t.sent.map((s) => s.content.text).filter(Boolean)).toEqual([
      'Locked in: A',
    ]);
    const n = t.sent.length;
    expect(await t.vote(poll, ['B'])).toMatchObject({
      counted: false,
      note: 'locked',
      current: ['A'],
    });
    expect(t.sent.length).toBe(n); // no reaction or text for an ignored vote
  });

  it('deleteAfterVote: says what they chose, then deletes the poll for everyone', async () => {
    const t = setup();
    const poll = await t.sendPoll({
      name: 'Pick',
      options: ['A', 'B'],
      mode: 'deleteAfterVote',
    });
    expect(await t.vote(poll, ['B'])).toMatchObject({
      counted: true,
      pollDeleted: true,
    });
    const after = t.sent.slice(1).map((s) => s.content);
    expect(after).toEqual([
      { text: 'You chose B' },
      { delete: { remoteJid: CHAT, id: poll.id, fromMe: true } },
    ]);
    expect(getPoll(t.db, poll.id)?.deletedAt).toBeInstanceOf(Date);
    expect(await t.vote(poll, ['A'])).toMatchObject({
      counted: false,
      note: 'poll_deleted',
    });
  });

  it('react: false and confirmText: false turn the responses off', async () => {
    const t = setup();
    const poll = await t.sendPoll({
      name: 'Pick',
      options: ['A', 'B'],
      react: false,
    });
    await t.vote(poll, ['A']);
    expect(t.sent).toHaveLength(1); // only the poll itself
    const quiet = await t.sendPoll({
      name: 'Q',
      options: ['A', 'B'],
      mode: 'deleteAfterVote',
      confirmText: false,
    });
    await t.vote(quiet, ['A']);
    expect(t.sent.at(-1)?.content).toHaveProperty('delete');
    expect(t.sent.some((s) => s.content.text)).toBe(false);
  });

  it('ignores votes it cannot decrypt or polls it did not send', async () => {
    const t = setup();
    const poll = await t.sendPoll({ name: 'Pick', options: ['A', 'B'] });
    expect(
      await t.vote({ id: poll.id, secret: randomBytes(32) }, ['A']),
    ).toBeNull();
    expect(
      await t.vote({ id: 'UNKNOWN', secret: poll.secret }, ['A']),
    ).toBeNull();
  });

  it('DELETE /api/polls/:id deletes for everyone once', async () => {
    const t = setup();
    const poll = await t.sendPoll({ name: 'Pick', options: ['A', 'B'] });
    const r1 = await t.app.request(`/api/polls/${poll.id}`, {
      method: 'DELETE',
    });
    expect(r1.status).toBe(200);
    expect(t.sent.at(-1)?.content).toHaveProperty('delete');
    const n = t.sent.length;
    await t.app.request(`/api/polls/${poll.id}`, { method: 'DELETE' });
    expect(t.sent.length).toBe(n);
    expect(
      (await t.app.request('/api/polls/NOPE', { method: 'DELETE' })).status,
    ).toBe(404);
  });

  it('multi-choice updateEveryTime: counts every option picked', async () => {
    const t = setup();
    const poll = await t.sendPoll({
      name: 'Pick any',
      options: ['A', 'B', 'C'],
      multiple: true,
    });
    expect(t.sent[0].content).toMatchObject({ poll: { selectableCount: 0 } });
    expect(await t.vote(poll, ['A', 'C'])).toMatchObject({
      multiple: true,
      selected: ['A', 'C'],
      counted: true,
      note: null,
    });
    const body = (await (
      await t.app.request(`/api/polls/${poll.id}`)
    ).json()) as { results: { tally: Record<string, number> } };
    expect(body.results.tally).toEqual({ A: 1, B: 0, C: 1 });
  });

  it('multi-choice lockFirstVote: waits for the taps to stop, then locks', async () => {
    const t = setup();
    const poll = await t.sendPoll({
      name: 'Pick any',
      options: ['A', 'B', 'C'],
      multiple: true,
      mode: 'lockFirstVote',
      confirmText: 'Got {{option}}',
    });
    expect(await t.vote(poll, ['A'])).toMatchObject({
      note: 'settling',
      counted: true,
    });
    expect(await t.vote(poll, ['A', 'C'])).toMatchObject({
      note: 'settling',
      current: ['A', 'C'],
    });
    expect(t.sent).toHaveLength(1); // nothing sent while settling
    await new Promise((r) => setTimeout(r, 80));
    expect(t.settled).toHaveLength(1);
    expect(t.settled[0]).toMatchObject({
      selected: ['A', 'C'],
      note: null,
      counted: true,
    });
    expect(t.sent.map((x) => x.content.text).filter(Boolean)).toEqual([
      'Got A, C',
    ]);
    expect(await t.vote(poll, ['B'])).toMatchObject({
      counted: false,
      note: 'locked',
      current: ['A', 'C'],
    });
    const body = (await (
      await t.app.request(`/api/polls/${poll.id}`)
    ).json()) as { votes: Array<{ note: string | null }> };
    expect(body.votes.map((v) => v.note)).toEqual([
      'superseded',
      null,
      'locked',
    ]);
  });

  it('multi-choice deleteAfterVote: deletes once they stop tapping', async () => {
    const t = setup();
    const poll = await t.sendPoll({
      name: 'Pick any',
      options: ['A', 'B'],
      multiple: true,
      mode: 'deleteAfterVote',
    });
    await t.vote(poll, ['B']);
    await t.vote(poll, ['A', 'B']);
    await new Promise((r) => setTimeout(r, 80));
    expect(t.sent.slice(1).map((x) => x.content)).toEqual([
      { text: 'You chose A, B' },
      { delete: { remoteJid: CHAT, id: poll.id, fromMe: true } },
    ]);
    expect(t.settled[0]).toMatchObject({ pollDeleted: true });
  });

  it('judgeVote: an empty first vote does not lock', () => {
    expect(
      judgeVote({ mode: 'lockFirstVote', deletedAt: null }, [], []),
    ).toMatchObject({ counted: false, note: 'empty' });
  });
});
