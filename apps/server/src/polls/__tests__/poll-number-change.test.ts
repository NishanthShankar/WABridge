import {
  createCipheriv,
  createHash,
  createHmac,
  randomBytes,
} from 'node:crypto';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { proto } from '@whiskeysockets/baileys';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../../db/client.js';
import { pollVotes, polls, webhooks } from '../../db/schema.js';
import { setupWebhookListener } from '../../webhooks/webhook.listener.js';
import { setPollSiblings } from '../poll-accounts.js';
import { attachPollJobs, sweepPolls } from '../poll-jobs.js';
import {
  PollNotOursError,
  deletePoll,
  getPoll,
  handlePollVote,
  locatePoll,
  sendPoll,
  votesFor,
} from '../polls.js';

const logger = pino({ level: 'silent' });
const GROUP = '120363000000000001@g.us';
const DM = '919800000001@s.whatsapp.net';
const VOTER = '555000111@lid';

// Two numbers of the same owner
const ZELFRED = { id: '919800000009:12@s.whatsapp.net', lid: '777888:12@lid' };
const JR = { id: '919800000010:3@s.whatsapp.net', lid: '999111:3@lid' };
const ZELFRED_PN = '919800000009@s.whatsapp.net';

/** Encrypt a vote the way the voter's phone does: signed against the poll's sender. */
function encryptVote(o: {
  pollId: string;
  secret: Buffer;
  selected: string[];
  creator?: string;
}): proto.Message.IPollUpdateMessage {
  const sign = Buffer.concat([
    Buffer.from(o.pollId),
    Buffer.from(o.creator ?? ZELFRED_PN),
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

const hooks: Array<{ url: string; body: Record<string, unknown> }> = [];
beforeEach(() => {
  hooks.length = 0;
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    hooks.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response('ok', { status: 200 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  setPollSiblings(null);
});
const tick = () => new Promise((r) => setTimeout(r, 20));

let msgSeq = 0;

/** One account: its own database, webhook and socket. */
function account(
  user: { id: string; lid: string } | undefined,
  hookUrl: string,
  admin = false,
) {
  const db = createDatabase(':memory:');
  migrate(db, { migrationsFolder: resolve(__dirname, '../../../drizzle') });
  db.insert(webhooks)
    .values({ id: hookUrl, url: hookUrl, enabled: true, allEvents: true })
    .run();
  const sent: Array<Record<string, unknown>> = [];
  const secrets: Buffer[] = [];
  const sock = {
    ws: { isOpen: true },
    user,
    ev: new EventEmitter(),
    sendPresenceUpdate: async () => {},
    sendMessage: async (_jid: string, content: Record<string, unknown>) => {
      sent.push(content);
      const poll = content.poll as { messageSecret?: Buffer } | undefined;
      if (poll?.messageSecret) secrets.push(poll.messageSecret);
      return { key: { id: `MSG${++msgSeq}` } };
    },
    groupMetadata: async (jid: string) => ({
      id: jid,
      subject: 'Team',
      participants: [
        { id: '777888@lid', admin: null },
        {
          id: '999111@lid',
          phoneNumber: '919800000010@s.whatsapp.net',
          admin: admin ? 'admin' : null,
        },
      ],
    }),
    signalRepository: { lidMapping: { getLIDForPN: async () => null } },
  };
  return { db, sock, sent, secrets };
}

type Account = ReturnType<typeof account>;

async function pollFrom(a: Account, jid: string, extra = {}) {
  const id = (await sendPoll(a.sock as never, a.db, jid, {
    name: 'Lunch?',
    options: ['Yes', 'No'],
    ...extra,
  })) as string;
  return { id, secret: a.secrets.at(-1) as Buffer };
}

describe('a poll remembers which number sent it', () => {
  it('stores the sender on send, and stamps older polls on the next connection', async () => {
    const z = account(ZELFRED, 'http://zelfred.test');
    const p = await pollFrom(z, GROUP);
    expect(JSON.parse(getPoll(z.db, p.id)?.senderJids as string)).toEqual([
      ZELFRED_PN,
      '777888@lid',
    ]);

    z.db
      .update(polls)
      .set({ senderJids: null })
      .where(eq(polls.id, p.id))
      .run();
    attachPollJobs(z.sock as never, z.db, logger);
    expect(JSON.parse(getPoll(z.db, p.id)?.senderJids as string)).toEqual([
      ZELFRED_PN,
      '777888@lid',
    ]);
  });
});

describe('the account is re-paired with a different number', () => {
  it('still reads votes on polls the old number sent, and answers as the new number', async () => {
    const z = account(ZELFRED, 'http://zelfred.test');
    const p = await pollFrom(z, GROUP, { confirmText: 'Got {{option}}' });
    // Same account, same database, new number
    z.sock.user = JR;

    const vote = await handlePollVote({
      sock: z.sock as never,
      db: z.db,
      logger,
      update: encryptVote({
        pollId: p.id,
        secret: p.secret,
        selected: ['Yes'],
      }),
      voterJid: VOTER,
      voterPhone: '919800000001',
    });
    expect(vote).toMatchObject({ selected: ['Yes'], counted: true });

    const react = z.sent.find((c) => c.react)?.react as {
      key: Record<string, unknown>;
    };
    // The poll is no longer "from me": it is addressed as the old number's message
    expect(react.key).toEqual({
      remoteJid: GROUP,
      id: p.id,
      fromMe: false,
      participant: '777888@lid',
    });
    expect(z.sent.some((c) => c.text === 'Got Yes')).toBe(true);
  });

  it('cannot delete the old number’s poll in a 1:1 chat, or in a group where it is not admin', async () => {
    const z = account(ZELFRED, 'http://zelfred.test');
    const dm = await pollFrom(z, DM);
    const group = await pollFrom(z, GROUP);
    z.sock.user = JR;
    for (const p of [dm, group]) {
      await expect(
        deletePoll(z.sock as never, z.db, getPoll(z.db, p.id) as never),
      ).rejects.toBeInstanceOf(PollNotOursError);
      expect(getPoll(z.db, p.id)?.deletedAt).toBeNull();
    }
    expect(z.sent.some((c) => c.delete)).toBe(false);
  });

  it('deletes the old number’s poll as a group admin', async () => {
    const z = account(ZELFRED, 'http://zelfred.test', true);
    const p = await pollFrom(z, GROUP);
    z.sock.user = JR;
    await deletePoll(z.sock as never, z.db, getPoll(z.db, p.id) as never);
    expect(z.sent.find((c) => c.delete)?.delete).toEqual({
      remoteJid: GROUP,
      id: p.id,
      fromMe: false,
      participant: '777888@lid',
    });
    expect(getPoll(z.db, p.id)?.deletedAt).toBeInstanceOf(Date);
  });

  it('a due delete it cannot do is given up at once and reported, not retried', async () => {
    const z = account(ZELFRED, 'http://zelfred.test');
    attachPollJobs(z.sock as never, z.db, logger);
    const p = await pollFrom(z, DM, {
      deleteAt: new Date(Date.now() + 60_000).toISOString(),
    });
    z.sock.user = JR;
    await sweepPolls(z.db, Date.now() + 120_000);
    await tick();
    const row = getPoll(z.db, p.id);
    expect(row?.deleteFailedAt).toBeInstanceOf(Date);
    expect(row?.deleteAt).toBeNull();
    expect(hooks.map((h) => h.body.event)).toEqual(['poll.delete_failed']);
  });
});

describe('a second number of the same tenant hears the vote', () => {
  function pair() {
    const z = account(ZELFRED, 'http://zelfred.test');
    const jr = account(JR, 'http://jr.test');
    const all = [z, jr];
    setPollSiblings((db) =>
      all
        .filter((a) => a.db !== db)
        .map((a) => ({ db: a.db, getSocket: () => a.sock as never })),
    );
    return { z, jr };
  }

  it('leaves the vote to the sending number while that number is linked', async () => {
    const { z, jr } = pair();
    const p = await pollFrom(z, GROUP);
    expect(locatePoll(jr.db, jr.sock as never, p.id)).toBeNull();
    // The sender itself finds its own poll
    expect(locatePoll(z.db, z.sock as never, p.id)?.db).toBe(z.db);
  });

  it('ignores polls nobody in the tenant sent', () => {
    const { jr } = pair();
    expect(locatePoll(jr.db, jr.sock as never, 'SOMEONE-ELSES')).toBeNull();
  });

  it('takes the vote once the sending number is unlinked, and keeps it with the poll', async () => {
    const { z, jr } = pair();
    const p = await pollFrom(z, GROUP, { ref: 'lunch-1' });
    z.sock.user = undefined; // Zelfred logged out: back to pairing
    setupWebhookListener(jr.sock as never, jr.db, logger);

    const voteMsg = {
      key: {
        remoteJid: GROUP,
        id: 'VOTE1',
        fromMe: false,
        participant: VOTER,
      },
      message: {
        pollUpdateMessage: encryptVote({
          pollId: p.id,
          secret: p.secret,
          selected: ['No'],
        }),
      },
    };
    jr.sock.ev.emit('messages.upsert', { messages: [voteMsg], type: 'notify' });
    await tick();
    // The same vote offered again (a third number in the group, a redelivery) is not counted twice
    jr.sock.ev.emit('messages.upsert', { messages: [voteMsg], type: 'notify' });
    await tick();

    // Recorded where the poll lives, not in Jr.'s database
    expect(
      votesFor(z.db, p.id).map((v) => [JSON.parse(v.selected), v.counted]),
    ).toEqual([[['No'], true]]);
    expect(jr.db.select().from(pollVotes).all()).toEqual([]);

    // Reported once, to the webhook of the account that sent the poll
    const votes = hooks.filter((h) => h.body.event === 'poll.vote');
    expect(votes).toHaveLength(1);
    expect(votes[0].url).toContain('zelfred.test');
    expect(votes[0].body).toMatchObject({
      pollId: p.id,
      ref: 'lunch-1',
      selected: ['No'],
      counted: true,
      receivedBy: '919800000010',
    });

    // Jr. reacted on Zelfred's poll
    const react = jr.sent.find((c) => c.react)?.react as {
      key: Record<string, unknown>;
    };
    expect(react.key).toMatchObject({
      id: p.id,
      fromMe: false,
      participant: '777888@lid',
    });
    expect(z.sent.some((c) => c.react)).toBe(false);
  });

  it('takes it too when the old account was re-paired with a third number', async () => {
    const { z, jr } = pair();
    const p = await pollFrom(z, GROUP);
    z.sock.user = { id: '919800000077:1@s.whatsapp.net', lid: '424242:1@lid' };
    expect(locatePoll(jr.db, jr.sock as never, p.id)?.db).toBe(z.db);
  });

  it('does not look in a sibling for a poll whose sender was never recorded', async () => {
    const { z, jr } = pair();
    const p = await pollFrom(z, GROUP);
    z.db
      .update(polls)
      .set({ senderJids: null })
      .where(eq(polls.id, p.id))
      .run();
    z.sock.user = undefined;
    expect(locatePoll(jr.db, jr.sock as never, p.id)).toBeNull();
  });
});
