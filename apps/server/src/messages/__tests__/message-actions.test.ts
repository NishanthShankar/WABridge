import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { type AppContext, setContext } from '../../context.js';
import { createDatabase } from '../../db/client.js';
import { contacts, groups, scheduledMessages } from '../../db/schema.js';
import { recordInbound } from '../../webhooks/chat-activity.js';
import { createMessageActionsRouter } from '../message-actions.router.js';
import {
  MAX_PER_SOCKET,
  findMessage,
  rememberMessage,
} from '../recent-messages.js';

const CHAT = '919800000001@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';
const OTHER = '919811111111@s.whatsapp.net';
const nowSec = () => Math.floor(Date.now() / 1000);

function setup() {
  const db = createDatabase(':memory:');
  migrate(db, { migrationsFolder: resolve(__dirname, '../../../drizzle') });
  const sent: Array<{ jid: string; content: Record<string, unknown> }> = [];
  const sock = {
    sendMessage: async (jid: string, content: Record<string, unknown>) => {
      sent.push({ jid, content });
      return {
        key: { remoteJid: jid, id: `NEW${sent.length}`, fromMe: true },
        message: { conversation: 'x' },
      };
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
  app.route('/api/messages', createMessageActionsRouter());
  const post = async (path: string, body: Record<string, unknown>) => {
    const res = await app.request(`/api/messages/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      body: (await res.json()) as Record<string, unknown>,
    };
  };
  const remember = (
    id: string,
    opts: {
      fromMe?: boolean;
      ageSec?: number;
      chat?: string;
      message?: object;
    } = {},
  ) =>
    rememberMessage(sock, {
      key: { remoteJid: opts.chat ?? CHAT, id, fromMe: opts.fromMe ?? true },
      message: opts.message ?? { conversation: 'hello' },
      messageTimestamp: nowSec() - (opts.ageSec ?? 0),
    });
  return { db, sock, sent, post, remember };
}

describe('POST /api/messages/edit', () => {
  it('edits a message this account sent', async () => {
    const t = setup();
    t.remember('M1');
    const r = await t.post('edit', {
      chatId: CHAT,
      messageId: 'M1',
      text: 'fixed',
    });
    expect(r).toMatchObject({
      status: 200,
      body: { edited: true, chatId: CHAT, messageId: 'M1' },
    });
    expect(t.sent[0]).toEqual({
      jid: CHAT,
      content: {
        text: 'fixed',
        edit: { remoteJid: CHAT, id: 'M1', fromMe: true },
      },
    });
  });

  it('accepts a phone number for the chat', async () => {
    const t = setup();
    const r = await t.post('edit', {
      phone: '+91 98000 00001',
      messageId: 'M1',
      text: 'x',
    });
    expect(r.status).toBe(200);
    expect(t.sent[0].jid).toBe(CHAT);
  });

  it("refuses after 15 minutes, someone else's message, and media", async () => {
    const t = setup();
    t.remember('OLD', { ageSec: 16 * 60 });
    t.remember('THEIRS', { fromMe: false });
    t.remember('PIC', { message: { imageMessage: { caption: 'c' } } });
    expect(
      (await t.post('edit', { chatId: CHAT, messageId: 'OLD', text: 'x' })).body
        .error,
    ).toBe('edit_window_closed');
    expect(
      (await t.post('edit', { chatId: CHAT, messageId: 'THEIRS', text: 'x' }))
        .body.error,
    ).toBe('not_own_message');
    expect(
      (await t.post('edit', { chatId: CHAT, messageId: 'PIC', text: 'x' })).body
        .error,
    ).toBe('not_text');
    expect(t.sent).toHaveLength(0);
  });

  it('by scheduledMessageId: finds the chat, and updates the stored content', async () => {
    const t = setup();
    t.db
      .insert(groups)
      .values({
        id: GROUP,
        name: 'G',
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();
    t.db
      .insert(scheduledMessages)
      .values({
        id: 'S1',
        groupId: GROUP,
        content: 'old',
        scheduledAt: new Date(),
        status: 'sent',
        whatsappMessageId: 'W1',
        sentAt: new Date(),
      })
      .run();
    const r = await t.post('edit', { scheduledMessageId: 'S1', text: 'new' });
    expect(r).toMatchObject({
      status: 200,
      body: { chatId: GROUP, messageId: 'W1' },
    });
    expect(
      t.db
        .select()
        .from(scheduledMessages)
        .where(eq(scheduledMessages.id, 'S1'))
        .get()?.content,
    ).toBe('new');
  });

  it("by scheduledMessageId: a contact message goes to the contact's phone; unsent ones are refused", async () => {
    const t = setup();
    t.db.insert(contacts).values({ id: 'C1', phone: '+919800000001' }).run();
    t.db
      .insert(scheduledMessages)
      .values([
        {
          id: 'S1',
          contactId: 'C1',
          content: 'a',
          scheduledAt: new Date(),
          status: 'sent',
          whatsappMessageId: 'W1',
        },
        {
          id: 'S2',
          contactId: 'C1',
          content: 'b',
          scheduledAt: new Date(),
          status: 'pending',
        },
      ])
      .run();
    expect(
      (await t.post('edit', { scheduledMessageId: 'S1', text: 'x' })).body
        .chatId,
    ).toBe(CHAT);
    expect(
      (await t.post('edit', { scheduledMessageId: 'S2', text: 'x' })).body
        .error,
    ).toBe('not_sent');
    expect(
      (await t.post('edit', { scheduledMessageId: 'NOPE', text: 'x' })).status,
    ).toBe(404);
  });

  it('validates the target', async () => {
    const t = setup();
    expect((await t.post('edit', { messageId: 'M1', text: 'x' })).status).toBe(
      400,
    );
    expect(
      (
        await t.post('edit', {
          chatId: CHAT,
          phone: '9190',
          messageId: 'M1',
          text: 'x',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await t.post('edit', {
          scheduledMessageId: 'S1',
          chatId: CHAT,
          text: 'x',
        })
      ).status,
    ).toBe(400);
    expect(
      (await t.post('edit', { chatId: 'nonsense', messageId: 'M1', text: 'x' }))
        .body.error,
    ).toBe('invalid_chat');
  });
});

describe('edit then forward', () => {
  it('forwards the edited text, not the original', async () => {
    const t = setup();
    t.remember('M1');
    await t.post('edit', { chatId: CHAT, messageId: 'M1', text: 'fixed' });
    await t.post('forward', { chatId: CHAT, messageId: 'M1', toChatId: GROUP });
    expect((t.sent[1].content.forward as { message: unknown }).message).toEqual(
      { conversation: 'fixed' },
    );
  });
});

describe('POST /api/messages/delete', () => {
  it('deletes for everyone', async () => {
    const t = setup();
    const r = await t.post('delete', { chatId: CHAT, messageId: 'M1' });
    expect(r).toMatchObject({ status: 200, body: { deleted: true } });
    expect(t.sent[0].content).toEqual({
      delete: {
        remoteJid: CHAT,
        id: 'M1',
        fromMe: true,
        participant: undefined,
      },
    });
  });

  it("as group admin, deletes someone else's message", async () => {
    const t = setup();
    const r = await t.post('delete', {
      chatId: GROUP,
      messageId: 'M1',
      fromMe: false,
      participant: '919811111111',
    });
    expect(r.status).toBe(200);
    expect(t.sent[0].content).toEqual({
      delete: { remoteJid: GROUP, id: 'M1', fromMe: false, participant: OTHER },
    });
  });

  it("refuses someone else's message outside a group or without participant", async () => {
    const t = setup();
    expect(
      (
        await t.post('delete', {
          chatId: CHAT,
          messageId: 'M1',
          fromMe: false,
          participant: '919811111111',
        })
      ).body.error,
    ).toBe('not_group');
    expect(
      (
        await t.post('delete', {
          chatId: GROUP,
          messageId: 'M1',
          fromMe: false,
        })
      ).status,
    ).toBe(400);
  });

  it('refuses a message older than the delete window', async () => {
    const t = setup();
    t.remember('OLD', { ageSec: 61 * 3600 });
    expect(
      (await t.post('delete', { chatId: CHAT, messageId: 'OLD' })).body.error,
    ).toBe('delete_window_closed');
  });
});

describe('POST /api/messages/forward', () => {
  it('forwards a recent message to a group', async () => {
    const t = setup();
    t.remember('IN1', { fromMe: false });
    const r = await t.post('forward', {
      chatId: CHAT,
      messageId: 'IN1',
      toChatId: GROUP,
    });
    expect(r).toMatchObject({
      status: 200,
      body: { forwarded: true, chatId: GROUP, messageId: 'NEW1' },
    });
    expect((t.sent[0].content.forward as { key: { id: string } }).key.id).toBe(
      'IN1',
    );
  });

  it('to a 1:1 chat only inside its reply window', async () => {
    const t = setup();
    t.remember('IN1', { fromMe: false });
    const shut = await t.post('forward', {
      chatId: CHAT,
      messageId: 'IN1',
      toPhone: '919811111111',
    });
    expect(shut).toMatchObject({
      status: 409,
      body: { error: 'outside_reply_window' },
    });
    recordInbound(t.db, OTHER, null);
    expect(
      (
        await t.post('forward', {
          chatId: CHAT,
          messageId: 'IN1',
          toPhone: '919811111111',
        })
      ).status,
    ).toBe(200);
  });

  it('404 for a message the bridge does not hold', async () => {
    const t = setup();
    expect(
      (
        await t.post('forward', {
          chatId: CHAT,
          messageId: 'GONE',
          toChatId: GROUP,
        })
      ).body.error,
    ).toBe('not_found');
  });

  it('caps forwards per destination per minute', async () => {
    const t = setup();
    t.remember('IN1', { fromMe: false });
    for (let i = 0; i < 12; i++)
      await t.post('forward', {
        chatId: CHAT,
        messageId: 'IN1',
        toChatId: GROUP,
      });
    expect(
      (
        await t.post('forward', {
          chatId: CHAT,
          messageId: 'IN1',
          toChatId: GROUP,
        })
      ).status,
    ).toBe(429);
  });
});

describe('recent messages', () => {
  it('skips reactions and edits, keeps a bounded number, and forgets old ones', () => {
    const sock = {};
    rememberMessage(sock, {
      key: { remoteJid: CHAT, id: 'R' },
      message: { reactionMessage: { text: '👍' } },
    });
    rememberMessage(sock, {
      key: { remoteJid: CHAT, id: 'E' },
      message: { protocolMessage: { type: 14 } },
    });
    expect(findMessage(sock, [CHAT], 'R')).toBeNull();
    expect(findMessage(sock, [CHAT], 'E')).toBeNull();

    for (let i = 0; i <= MAX_PER_SOCKET; i++)
      rememberMessage(sock, {
        key: { remoteJid: CHAT, id: `N${i}` },
        message: { conversation: 'x' },
        messageTimestamp: nowSec(),
      });
    expect(findMessage(sock, [CHAT], 'N0')).toBeNull();
    expect(findMessage(sock, [CHAT], `N${MAX_PER_SOCKET}`)).not.toBeNull();

    rememberMessage(sock, {
      key: { remoteJid: CHAT, id: 'OLD' },
      message: { conversation: 'x' },
      messageTimestamp: nowSec() - 73 * 3600,
    });
    expect(findMessage(sock, [CHAT], 'OLD')).toBeNull();
  });
});
