import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  createChannelsRouter,
  describe as describeChannel,
} from '../../channels/channels.router.js';
import { createChatsRouter } from '../../chats/chats.router.js';
import { type AppContext, setContext } from '../../context.js';
import { createDatabase } from '../../db/client.js';
import { createMessageActionsRouter } from '../../messages/message-actions.router.js';
import { scheduleMessageSchema } from '../../scheduling/scheduling.schema.js';
import { foldMessage } from '../../scheduling/scheduling.router.js';
import { buildMessagePayload, relayOptions } from '../message-payload.js';
import { sendStored } from '../send-stored.js';

const CHAT = '919800000001@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';
const CHANNEL = '120363000000000009@newsletter';
const EVENT = {
  name: 'Review call',
  startAt: '2026-11-20T10:00:00+05:30',
  endAt: '2026-11-20T10:30:00+05:30',
  location: { latitude: 12.97, longitude: 77.59, name: 'Office' },
  call: 'video' as const,
};

function setup(opts: { inviteCode?: string | null } = {}) {
  const db = createDatabase(':memory:');
  migrate(db, { migrationsFolder: resolve(__dirname, '../../../drizzle') });
  const sent: Array<{
    jid: string;
    content: Record<string, unknown>;
    opts: unknown;
  }> = [];
  const calls: unknown[][] = [];
  const sock = {
    user: { id: '918500000000:12@s.whatsapp.net' },
    async sendMessage(
      jid: string,
      content: Record<string, unknown>,
      o: unknown,
    ) {
      sent.push({ jid, content, opts: o });
      return { key: { id: `WA${sent.length}`, remoteJid: jid, fromMe: true } };
    },
    async groupInviteCode() {
      if (opts.inviteCode === null) throw new Error('not-authorized');
      return opts.inviteCode ?? 'CODE123';
    },
    async groupMetadata() {
      return { subject: 'Team' };
    },
    async newsletterMetadata(type: string, key: string) {
      calls.push(['meta', type, key]);
      return key === 'missingcode1'
        ? null
        : { id: CHANNEL, name: 'News', invite: 'abcDEF123456', subscribers: 7 };
    },
    async newsletterCreate(name: string, description?: string) {
      calls.push(['create', name, description]);
      return { id: CHANNEL, name };
    },
    async newsletterFollow(jid: string) {
      calls.push(['follow', jid]);
    },
    async newsletterUnfollow(jid: string) {
      calls.push(['unfollow', jid]);
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
  app.route('/api/chats', createChatsRouter());
  app.route('/api/messages', createMessageActionsRouter());
  app.route('/api/channels', createChannelsRouter());
  const call = async (method: string, path: string, body?: object) => {
    const res = await app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: res.status,
      body: (await res.json()) as Record<string, unknown>,
    };
  };
  return { db, sock, sent, calls, call };
}

const parse = (body: object) =>
  scheduleMessageSchema.safeParse({ phone: '919800000001', ...body });

describe('media payloads', () => {
  it('voice note: flagged as one, OGG/Opus by default', () => {
    expect(
      buildMessagePayload('', 'https://x.test/a.ogg', 'voiceNote'),
    ).toEqual({
      audio: { url: 'https://x.test/a.ogg' },
      ptt: true,
      mimetype: 'audio/ogg; codecs=opus',
    });
  });

  it('audio: the type follows the file, not always audio/mp4', () => {
    const mime = (url: string) =>
      (buildMessagePayload('', url, 'audio') as { mimetype: string }).mimetype;
    expect(mime('https://x.test/a.mp3?sig=1')).toBe('audio/mpeg');
    expect(mime('https://x.test/a.m4a')).toBe('audio/mp4');
    expect(mime('https://x.test/download')).toBe('audio/mp4');
  });

  it('gif loops; view once wraps image, video and voice notes', () => {
    expect(
      buildMessagePayload('hi', 'https://x.test/a.mp4', 'gif'),
    ).toMatchObject({
      gifPlayback: true,
      caption: 'hi',
    });
    for (const type of ['image', 'video', 'audio', 'voiceNote'])
      expect(
        buildMessagePayload('', 'https://x.test/a', type, { viewOnce: true }),
      ).toMatchObject({ viewOnce: true });
  });

  it('document: own file name and type, else from the URL', () => {
    expect(
      buildMessagePayload(
        '',
        'https://x.test/files/Report%20Q3.pdf?x=1',
        'document',
      ),
    ).toMatchObject({ fileName: 'Report Q3.pdf', mimetype: 'application/pdf' });
    expect(
      buildMessagePayload('', 'https://x.test/d/123', 'document', {
        fileName: 'Invoice.xlsx',
      }),
    ).toMatchObject({
      fileName: 'Invoice.xlsx',
      mimetype:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    expect(
      buildMessagePayload('', 'https://x.test/d/123', 'document', {
        mimetype: 'text/x-log',
      }),
    ).toMatchObject({ fileName: '123', mimetype: 'text/x-log' });
  });

  it('mentions become JIDs; a quote goes in the send options', () => {
    expect(
      buildMessagePayload('hi @919800000002', null, null, {
        mentions: ['+91 98000 00002'],
      }),
    ).toEqual({
      text: 'hi @919800000002',
      mentions: ['919800000002@s.whatsapp.net'],
    });
    expect(
      relayOptions(GROUP, {
        quote: { messageId: 'M1', participant: '919800000002', text: 'q' },
      }),
    ).toEqual({
      quoted: {
        key: {
          remoteJid: GROUP,
          id: 'M1',
          fromMe: false,
          participant: '919800000002@s.whatsapp.net',
        },
        message: { conversation: 'q' },
      },
    });
    expect(relayOptions(GROUP, {})).toBeUndefined();
  });

  it('event: times, place and call', () => {
    expect(buildMessagePayload(JSON.stringify(EVENT), null, 'event')).toEqual({
      event: {
        name: 'Review call',
        startDate: new Date('2026-11-20T04:30:00Z'),
        endDate: new Date('2026-11-20T05:00:00Z'),
        location: {
          degreesLatitude: 12.97,
          degreesLongitude: 77.59,
          name: 'Office',
        },
        call: 'video',
      },
    });
  });
});

describe('POST /api/messages body', () => {
  it('accepts each new kind', () => {
    for (const body of [
      { event: EVENT },
      { groupInvite: { groupId: GROUP, text: 'Join us' } },
      { reaction: { messageId: 'M1', emoji: '👍' } },
      {
        mediaUrl: 'https://x.test/a.ogg',
        mediaType: 'voiceNote',
        viewOnce: true,
      },
      {
        mediaUrl: 'https://x.test/a.pdf',
        mediaType: 'document',
        fileName: 'A.pdf',
      },
      {
        content: 'hi @919800000002',
        mentions: ['919800000002'],
        quote: { messageId: 'M1' },
      },
      {
        product: {
          productId: '123',
          title: 'Scan',
          currency: 'inr',
          price: 499.5,
          imageUrl: 'https://x.test/p.jpg',
        },
      },
    ])
      expect(parse(body).success, JSON.stringify(body)).toBe(true);
  });

  it('refuses mixes and options on the wrong kind', () => {
    for (const body of [
      { event: EVENT, location: { latitude: 1, longitude: 1 } },
      { event: { ...EVENT, endAt: '2026-11-20T09:00:00+05:30' } },
      { event: { ...EVENT, startAt: '2026-11-20 10:00' } },
      { content: 'x', viewOnce: true },
      {
        mediaUrl: 'https://x.test/a.pdf',
        mediaType: 'document',
        viewOnce: true,
      },
      {
        mediaUrl: 'https://x.test/a.jpg',
        mediaType: 'image',
        fileName: 'a.jpg',
      },
      { event: EVENT, mentions: ['919800000002'] },
      { groupInvite: { groupId: CHAT } },
      {
        mediaUrl: 'https://x.test/a.ogg',
        mediaType: 'voiceNote',
        mimetype: 'nonsense',
      },
    ])
      expect(parse(body).success, JSON.stringify(body)).toBe(false);
  });

  it('is stored as content + mediaType + options', () => {
    const fold = (body: object) => {
      const parsed = parse(body);
      if (!parsed.success) throw new Error('invalid');
      return foldMessage(parsed.data);
    };
    expect(fold({ event: EVENT })).toMatchObject({
      mediaType: 'event',
      options: null,
    });
    expect(fold({ reaction: { messageId: 'M1', emoji: '👍' } })).toEqual({
      content: '{"messageId":"M1","emoji":"👍"}',
      mediaType: 'reaction',
      options: null,
    });
    expect(
      fold({
        content: 'c',
        mediaUrl: 'https://x.test/a.jpg',
        mediaType: 'image',
        viewOnce: true,
      }),
    ).toEqual({
      content: 'c',
      mediaUrl: 'https://x.test/a.jpg',
      mediaType: 'image',
      options: { viewOnce: true },
    });
    expect(fold({ content: 'plain' }).options).toBeNull();
  });
});

describe('sendStored', () => {
  it('uses the stored options: mentions and the quote', async () => {
    const { sock, db, sent } = setup();
    const id = await sendStored(sock as never, db, GROUP, {
      content: 'hi @919800000002',
      options: JSON.stringify({
        mentions: ['919800000002'],
        quote: { messageId: 'M1', fromMe: true },
      }),
    });
    expect(id).toBe('WA1');
    expect(sent[0].content).toEqual({
      text: 'hi @919800000002',
      mentions: ['919800000002@s.whatsapp.net'],
    });
    expect(sent[0].opts).toMatchObject({
      quoted: { key: { id: 'M1', fromMe: true } },
    });
  });

  it('a reaction names the message in this chat', async () => {
    const { sock, db, sent } = setup();
    await sendStored(sock as never, db, CHAT, {
      content: JSON.stringify({ messageId: 'M1', emoji: '🙏' }),
      mediaType: 'reaction',
    });
    expect(sent[0].content).toEqual({
      react: {
        text: '🙏',
        key: {
          remoteJid: CHAT,
          id: 'M1',
          fromMe: false,
          participant: undefined,
        },
      },
    });
  });

  it('a group invite card reads the code and name, valid three days', async () => {
    const { sock, db, sent } = setup();
    await sendStored(sock as never, db, CHAT, {
      content: JSON.stringify({ groupId: GROUP, text: 'Join' }),
      mediaType: 'groupInvite',
    });
    const card = (sent[0].content as { groupInvite: Record<string, unknown> })
      .groupInvite;
    expect(card).toMatchObject({
      inviteCode: 'CODE123',
      jid: GROUP,
      subject: 'Team',
      text: 'Join',
    });
    const days =
      ((card.inviteExpiration as number) - Date.now() / 1000) / 86_400;
    expect(days).toBeGreaterThan(2.9);
    expect(days).toBeLessThan(3.1);
  });

  it('a group invite card fails clearly when this account is not an admin', async () => {
    const { sock, db, sent } = setup({ inviteCode: null });
    await expect(
      sendStored(sock as never, db, CHAT, {
        content: JSON.stringify({ groupId: GROUP }),
        mediaType: 'groupInvite',
      }),
    ).rejects.toThrow(/must be an admin/);
    expect(sent).toHaveLength(0);
  });

  it('a product card names this account as the seller; a private image URL is refused', async () => {
    const { sock, db, sent } = setup();
    const product = {
      productId: '9',
      title: 'Scan',
      currency: 'inr',
      price: 499.5,
      imageUrl: 'https://x.test/p.jpg',
    };
    await sendStored(sock as never, db, CHAT, {
      content: JSON.stringify(product),
      mediaType: 'product',
    });
    expect(sent[0].content).toMatchObject({
      businessOwnerJid: '918500000000@s.whatsapp.net',
      product: {
        productId: '9',
        currencyCode: 'INR',
        priceAmount1000: 499500,
        productImage: { url: 'https://x.test/p.jpg' },
      },
    });
    await expect(
      sendStored(sock as never, db, CHAT, {
        content: JSON.stringify({
          ...product,
          imageUrl: 'http://127.0.0.1/p.jpg',
        }),
        mediaType: 'product',
      }),
    ).rejects.toThrow(/not a public/);
  });
});

describe('message pin, chat privacy, phone number', () => {
  it('pins for a duration and unpins', async () => {
    const { call, sent } = setup();
    const pin = await call('POST', '/api/messages/pin', {
      chatId: GROUP,
      messageId: 'M1',
      participant: '919800000002',
      pinned: true,
      duration: '24h',
    });
    expect(pin).toMatchObject({
      status: 200,
      body: { pinned: true, duration: '24h' },
    });
    expect(sent[0].content).toEqual({
      pin: {
        remoteJid: GROUP,
        id: 'M1',
        fromMe: false,
        participant: '919800000002@s.whatsapp.net',
      },
      type: 1,
      time: 86_400,
    });
    await call('POST', '/api/messages/pin', {
      chatId: GROUP,
      messageId: 'M1',
      pinned: false,
    });
    expect(sent[1].content).toMatchObject({ type: 2 });
    expect(sent[1].content).not.toHaveProperty('time');
    expect(
      (
        await call('POST', '/api/messages/pin', {
          chatId: GROUP,
          messageId: 'M1',
          pinned: true,
          duration: '2d',
        })
      ).status,
    ).toBe(400);
  });

  it('limitSharing and share / request phone number', async () => {
    const { call, sent } = setup();
    expect(
      (await call('PATCH', `/api/chats/${CHAT}`, { limitSharing: true })).body,
    ).toMatchObject({ applied: ['limitSharing'] });
    expect(sent[0].content).toEqual({ limitSharing: true });
    await call('POST', `/api/chats/${CHAT}/phone-number`, { action: 'share' });
    await call('POST', `/api/chats/${CHAT}/phone-number`, {
      action: 'request',
    });
    expect(sent[1].content).toEqual({ sharePhoneNumber: true });
    expect(sent[2].content).toEqual({ requestPhoneNumber: true });
    expect(
      (
        await call('POST', `/api/chats/${GROUP}/phone-number`, {
          action: 'share',
        })
      ).status,
    ).toBe(400);
  });
});

describe('/api/channels', () => {
  it('reads a channel from a link, a code or an id', async () => {
    const { call, calls } = setup();
    const byLink = await call(
      'GET',
      '/api/channels/lookup?invite=https://whatsapp.com/channel/abcDEF123456',
    );
    expect(byLink.body).toMatchObject({
      id: CHANNEL,
      name: 'News',
      followers: 7,
      link: 'https://whatsapp.com/channel/abcDEF123456',
    });
    expect(calls[0]).toEqual(['meta', 'invite', 'abcDEF123456']);
    expect(
      (await call('GET', '/api/channels/lookup?invite=missingcode1')).status,
    ).toBe(404);
    expect(
      (
        await call(
          'GET',
          '/api/channels/lookup?invite=https://evil.test/channel/abcDEF123456',
        )
      ).status,
    ).toBe(400);
    expect((await call('GET', `/api/channels/${CHANNEL}`)).status).toBe(200);
    expect((await call('GET', `/api/channels/${GROUP}`)).status).toBe(400);
  });

  it("reads WhatsApp's raw channel shape: nested text, numbers as strings", () => {
    expect(
      describeChannel({
        id: CHANNEL,
        thread_metadata: {
          name: { text: 'WhatsApp' },
          description: { text: 'Official' },
          invite: 'abcDEF123456',
          subscribers_count: '1200',
          verification: 'VERIFIED',
          creation_time: '1688746895',
          picture: { direct_path: '/v/t61/pic.jpg' },
        },
        viewer_metadata: { mute: 'OFF', role: 'GUEST' },
      } as never),
    ).toEqual({
      id: CHANNEL,
      name: 'WhatsApp',
      description: 'Official',
      link: 'https://whatsapp.com/channel/abcDEF123456',
      followers: 1200,
      verified: true,
      role: 'guest',
      muted: false,
      createdAt: '2023-07-07T16:21:35.000Z',
      pictureUrl: 'https://pps.whatsapp.net/v/t61/pic.jpg',
    });
  });

  it('creates at most two a day', async () => {
    const { call } = setup();
    expect((await call('POST', '/api/channels', { name: 'A' })).status).toBe(
      201,
    );
    expect((await call('POST', '/api/channels', { name: 'B' })).status).toBe(
      201,
    );
    expect(
      (await call('POST', '/api/channels', { name: 'C' })).body,
    ).toMatchObject({ error: 'daily_cap_reached' });
  });

  it('follows, unfollows and posts (text, image; nothing private)', async () => {
    const { call, calls, sent } = setup();
    await call('POST', `/api/channels/${CHANNEL}/follow`);
    await call('DELETE', `/api/channels/${CHANNEL}/follow`);
    expect(calls).toEqual([
      ['follow', CHANNEL],
      ['unfollow', CHANNEL],
    ]);
    expect(
      (
        await call('POST', `/api/channels/${CHANNEL}/messages`, {
          text: 'Hello',
        })
      ).status,
    ).toBe(201);
    expect(sent[0]).toMatchObject({ jid: CHANNEL, content: { text: 'Hello' } });
    await call('POST', `/api/channels/${CHANNEL}/messages`, {
      text: 'cap',
      mediaUrl: 'https://x.test/a.jpg',
      mediaType: 'image',
    });
    expect(sent[1].content).toMatchObject({
      image: { url: 'https://x.test/a.jpg' },
      caption: 'cap',
    });
    expect(
      (
        await call('POST', `/api/channels/${CHANNEL}/messages`, {
          mediaUrl: 'http://127.0.0.1/a.jpg',
          mediaType: 'image',
        })
      ).status,
    ).toBe(502);
    expect(
      (
        await call('POST', `/api/channels/${CHANNEL}/messages`, {
          mediaUrl: 'https://x.test/a.jpg',
        })
      ).status,
    ).toBe(400);
    for (let i = 0; i < 4; i++)
      await call('POST', `/api/channels/${CHANNEL}/messages`, { text: 'x' });
    expect(
      (await call('POST', `/api/channels/${CHANNEL}/messages`, { text: 'x' }))
        .status,
    ).toBe(429);
  });
});
