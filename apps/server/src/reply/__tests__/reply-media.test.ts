import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { setContext, type AppContext } from '../../context.js';
import { createDatabase } from '../../db/client.js';
import { buildMessagePayload } from '../../scheduler/message-payload.js';
import { recordInbound } from '../../webhooks/chat-activity.js';
import { createReplyRouter } from '../reply.router.js';

const JID = '919812345678@s.whatsapp.net';

function setup() {
  const db = createDatabase(':memory:');
  migrate(db, { migrationsFolder: resolve(__dirname, '../../../drizzle') });
  const sent: Array<{ jid: string; content: Record<string, unknown>; opts: unknown }> = [];
  const sock = {
    sendPresenceUpdate: async () => {},
    sendMessage: async (jid: string, content: Record<string, unknown>, opts: unknown) => {
      sent.push({ jid, content, opts });
      return { key: { id: `MSG${sent.length}` } };
    },
    signalRepository: { lidMapping: { getLIDForPN: async () => null } },
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    setContext(c, { db, getSocket: () => sock, tenantId: 't1' } as unknown as AppContext);
    await next();
  });
  app.route('/api/reply', createReplyRouter());
  const post = (body: unknown) =>
    app.request('/api/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { db, sent, post };
}

describe('POST /api/reply with media', () => {
  it('sends an image with the text as caption, at once', async () => {
    const { db, sent, post } = setup();
    recordInbound(db, JID, null);
    const res = await post({
      chatId: JID,
      text: 'Step 1: tap here',
      mediaUrl: 'https://example.com/guide/step1.png',
      mediaType: 'image',
      typing: false,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ messageId: 'MSG1', chatId: JID });
    expect(sent[0].content).toEqual({
      image: { url: 'https://example.com/guide/step1.png' },
      caption: 'Step 1: tap here',
    });
  });

  it('sends media without text', async () => {
    const { db, sent, post } = setup();
    recordInbound(db, JID, null);
    const res = await post({
      chatId: JID,
      mediaUrl: 'https://example.com/a.pdf',
      mediaType: 'document',
      typing: false,
    });
    expect(res.status).toBe(200);
    expect(sent[0].content).toMatchObject({ document: { url: 'https://example.com/a.pdf' }, fileName: 'a.pdf' });
  });

  it('keeps the 24 hour rule for media', async () => {
    const { sent, post } = setup();
    const res = await post({
      chatId: JID,
      mediaUrl: 'https://example.com/x.png',
      mediaType: 'image',
    });
    expect(res.status).toBe(409);
    expect(sent).toHaveLength(0);
  });

  it('rejects mediaUrl without mediaType and non-http URLs', async () => {
    const { db, post } = setup();
    recordInbound(db, JID, null);
    expect((await post({ chatId: JID, mediaUrl: 'https://example.com/x.png' })).status).toBe(400);
    expect(
      (await post({ chatId: JID, mediaUrl: 'file:///etc/passwd', mediaType: 'image' })).status,
    ).toBe(400);
  });
});

describe('POST /api/reply with a poll', () => {
  it('sends a single-choice poll', async () => {
    const { db, sent, post } = setup();
    recordInbound(db, JID, null);
    const res = await post({
      chatId: JID,
      poll: { name: 'Pick one', options: ['A', 'B', 'C'] },
    });
    expect(res.status).toBe(200);
    expect(sent[0].content).toEqual({
      poll: { name: 'Pick one', values: ['A', 'B', 'C'], selectableCount: 1 },
    });
  });

  it('rejects duplicate options, one option, and a poll with text', async () => {
    const { db, post } = setup();
    recordInbound(db, JID, null);
    expect((await post({ chatId: JID, poll: { name: 'q', options: ['A', 'A'] } })).status).toBe(400);
    expect((await post({ chatId: JID, poll: { name: 'q', options: ['A'] } })).status).toBe(400);
    expect(
      (await post({ chatId: JID, text: 'hi', poll: { name: 'q', options: ['A', 'B'] } })).status,
    ).toBe(400);
  });
});

describe('buildMessagePayload', () => {
  it('builds text, video and audio', () => {
    expect(buildMessagePayload('hi')).toEqual({ text: 'hi' });
    expect(buildMessagePayload('c', 'https://x/v.mp4', 'video')).toEqual({
      video: { url: 'https://x/v.mp4' },
      caption: 'c',
    });
    expect(buildMessagePayload('ignored', 'https://x/a.m4a', 'audio')).toEqual({
      audio: { url: 'https://x/a.m4a' },
      mimetype: 'audio/mp4',
    });
  });
});
