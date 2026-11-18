import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AppContext, setContext } from '../../context.js';
import { createDatabase } from '../../db/client.js';
import { createMessageActionsRouter } from '../../messages/message-actions.router.js';
import { rememberMessage } from '../../messages/recent-messages.js';
import { createChatsRouter } from '../chats.router.js';

const CHAT = '919800000001@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';
const NOW = 1_800_000_000_000;

function setup(opts: { refuse?: string[] } = {}) {
  const db = createDatabase(':memory:');
  migrate(db, { migrationsFolder: resolve(__dirname, '../../../drizzle') });
  const calls: Array<[string, unknown, string]> = [];
  const sock = {
    async chatModify(mod: Record<string, unknown>, jid: string) {
      const kind = Object.keys(mod)[0];
      if (opts.refuse?.includes(kind)) throw new Error('not-allowed');
      calls.push(['modify', mod, jid]);
    },
    async sendMessage(jid: string, content: unknown) {
      calls.push(['send', content, jid]);
    },
    async groupToggleEphemeral(jid: string, seconds: number) {
      calls.push(['ephemeral', seconds, jid]);
    },
    async updateDefaultDisappearingMode(seconds: number) {
      calls.push(['default', seconds, '']);
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
  const call = async (method: string, path: string, body: object) => {
    const res = await app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      body: (await res.json()) as Record<string, unknown>,
    };
  };
  return { sock, calls, call };
}

afterEach(() => vi.useRealTimers());

describe('PATCH /api/chats/:id', () => {
  it('pins, archives with the last message, and mutes for 8 hours', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const t = setup();
    rememberMessage(t.sock, {
      key: { remoteJid: CHAT, id: 'OLD', fromMe: false },
      message: { conversation: 'a' },
      messageTimestamp: NOW / 1000 - 60,
    });
    rememberMessage(t.sock, {
      key: { remoteJid: CHAT, id: 'LAST', fromMe: false },
      message: { conversation: 'b' },
      messageTimestamp: NOW / 1000 - 5,
    });
    const r = await t.call('PATCH', '/api/chats/919800000001', {
      pinned: true,
      archived: true,
      muted: '8h',
    });
    expect(r).toMatchObject({
      status: 200,
      body: {
        chatId: CHAT,
        applied: ['pinned', 'archived', 'muted'],
        failed: [],
      },
    });
    expect(t.calls[0][1]).toEqual({ pin: true });
    expect(
      (t.calls[1][1] as { lastMessages: Array<{ key: { id: string } }> })
        .lastMessages[0].key.id,
    ).toBe('LAST');
    expect(t.calls[2][1]).toEqual({ mute: NOW + 8 * 3_600_000 });
  });

  it('unmute, mute always, mark unread', async () => {
    const t = setup();
    await t.call('PATCH', `/api/chats/${CHAT}`, { muted: false });
    await t.call('PATCH', `/api/chats/${CHAT}`, {
      muted: 'always',
      read: false,
    });
    expect(t.calls.map((c) => c[1])).toEqual([
      { mute: null },
      { mute: -1 },
      { markRead: false, lastMessages: [] },
    ]);
  });

  it('disappearing: a message in a 1:1 chat, a group setting in a group', async () => {
    const t = setup();
    await t.call('PATCH', `/api/chats/${CHAT}`, { disappearing: '7d' });
    await t.call('PATCH', `/api/chats/${CHAT}`, { disappearing: 'off' });
    await t.call('PATCH', `/api/chats/${GROUP}`, { disappearing: '24h' });
    expect(t.calls).toEqual([
      ['send', { disappearingMessagesInChat: 604_800 }, CHAT],
      ['send', { disappearingMessagesInChat: false }, CHAT],
      ['ephemeral', 86_400, GROUP],
    ]);
  });

  it('reports what WhatsApp refused; 502 when everything was', async () => {
    const t = setup({ refuse: ['archive'] });
    const some = await t.call('PATCH', `/api/chats/${CHAT}`, {
      pinned: true,
      archived: true,
    });
    expect(some.body).toMatchObject({
      applied: ['pinned'],
      failed: [{ action: 'archived', error: 'not-allowed' }],
    });
    expect(
      (await t.call('PATCH', `/api/chats/${CHAT}`, { archived: true })).status,
    ).toBe(502);
  });

  it('validates', async () => {
    const t = setup();
    expect((await t.call('PATCH', `/api/chats/${CHAT}`, {})).status).toBe(400);
    expect(
      (await t.call('PATCH', `/api/chats/${CHAT}`, { muted: '2h' })).status,
    ).toBe(400);
    expect(
      (await t.call('PATCH', '/api/chats/nonsense', { pinned: true })).status,
    ).toBe(400);
  });
});

describe('default timer and star', () => {
  it('sets the default disappearing timer for new chats', async () => {
    const t = setup();
    expect(
      await t.call('PUT', '/api/chats/disappearing-default', {
        disappearing: '90d',
      }),
    ).toMatchObject({ status: 200 });
    expect(t.calls).toEqual([['default', 7_776_000, '']]);
  });

  it('stars a message, taking fromMe from what the bridge saw', async () => {
    const t = setup();
    rememberMessage(t.sock, {
      key: { remoteJid: CHAT, id: 'MINE', fromMe: true },
      message: { conversation: 'x' },
      messageTimestamp: Date.now() / 1000,
    });
    expect(
      (
        await t.call('POST', '/api/messages/star', {
          chatId: CHAT,
          messageId: 'MINE',
          star: true,
        })
      ).status,
    ).toBe(200);
    await t.call('POST', '/api/messages/star', {
      chatId: CHAT,
      messageId: 'THEIRS',
      star: false,
    });
    expect(t.calls.map((c) => c[1])).toEqual([
      { star: { messages: [{ id: 'MINE', fromMe: true }], star: true } },
      { star: { messages: [{ id: 'THEIRS', fromMe: false }], star: false } },
    ]);
  });
});
