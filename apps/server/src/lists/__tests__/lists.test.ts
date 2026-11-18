import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { Hono } from 'hono';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AppContext, setContext } from '../../context.js';
import { createDatabase } from '../../db/client.js';
import { webhooks } from '../../db/schema.js';
import { cleanName, setupListListener } from '../lists.js';
import { createListsRouter } from '../lists.router.js';

const logger = pino({ level: 'silent' });
const hooks: Array<Record<string, unknown>> = [];
beforeEach(() => {
  hooks.length = 0;
  vi.stubGlobal('fetch', async (_u: string, init: { body: string }) => {
    hooks.push(JSON.parse(init.body));
    return new Response('ok');
  });
});
afterEach(() => vi.unstubAllGlobals());
const tick = () => new Promise((r) => setTimeout(r, 10));

/** What the phone has: WhatsApp replays it on a full sync. */
const PHONE = [
  { id: '1', name: '‎Unread' },
  { id: '2', name: 'Favourites' },
  { id: '3', name: 'Groups' },
  { id: '7', name: 'RT' },
];

function setup() {
  const db = createDatabase(':memory:');
  migrate(db, { migrationsFolder: resolve(__dirname, '../../../drizzle') });
  db.insert(webhooks)
    .values({ id: 'w', url: 'http://hook', enabled: true, allEvents: true })
    .run();
  const ev = new EventEmitter();
  const calls: string[] = [];
  const sock = {
    ev,
    authState: { keys: { set: async () => calls.push('reset-version') } },
    resyncAppState: async () => {
      calls.push('resync');
      for (const l of PHONE)
        ev.emit('labels.edit', { ...l, color: 0, deleted: false });
      ev.emit('labels.association', {
        type: 'add',
        association: { type: 'label_jid', chatId: '120363@g.us', labelId: '7' },
      });
    },
    addLabel: async (
      _j: string,
      l: { id: string; name: string; color: number; deleted: boolean },
    ) => {
      calls.push(`label ${l.id} ${l.name} ${l.deleted}`);
      ev.emit('labels.edit', l);
    },
    addChatLabel: async (jid: string, id: string) => {
      calls.push(`add ${jid} ${id}`);
      ev.emit('labels.association', {
        type: 'add',
        association: { type: 'label_jid', chatId: jid, labelId: id },
      });
    },
    removeChatLabel: async (jid: string, id: string) => {
      calls.push(`remove ${jid} ${id}`);
      ev.emit('labels.association', {
        type: 'remove',
        association: { type: 'label_jid', chatId: jid, labelId: id },
      });
    },
  };
  setupListListener(sock as never, db, logger);
  const app = new Hono();
  app.use('*', async (c, next) => {
    setContext(c, { db, getSocket: () => sock } as unknown as AppContext);
    await next();
  });
  app.route('/api/lists', createListsRouter());
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api/lists${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: res.status,
      body: (await res.json()) as Record<string, any>,
    };
  };
  return { db, ev, calls, call };
}

describe('chat lists', () => {
  it('create syncs first, picks a free id, adds chats and reports list.updated', async () => {
    const t = setup();
    const r = await t.call('POST', '', {
      name: 'telcurio',
      chats: ['919800000001', '120363999@g.us'],
    });
    expect(r.status).toBe(201);
    expect(t.calls.slice(0, 2)).toEqual(['reset-version', 'resync']);
    expect(r.body).toMatchObject({
      id: '8',
      name: 'telcurio',
      builtIn: false,
      chats: [
        { chatId: '120363999@g.us', phone: null, isGroup: true },
        {
          chatId: '919800000001@s.whatsapp.net',
          phone: '919800000001',
          isGroup: false,
        },
      ],
    });
    await tick();
    // the replayed snapshot is not reported, the new list and its chats are
    expect(hooks.map((h) => `${h.change} ${h.listId}`)).toEqual([
      'created 8',
      'chat_added 8',
      'chat_added 8',
    ]);
  });

  it('lists everything with built-ins marked and names cleaned', async () => {
    const t = setup();
    await t.call('POST', '/sync');
    const { body } = await t.call('GET', '');
    expect(body.synced).toBe(true);
    expect(
      body.lists.map(
        (l: { name: string; builtIn: boolean }) => `${l.name}:${l.builtIn}`,
      ),
    ).toEqual(['Unread:true', 'Favourites:true', 'Groups:true', 'RT:false']);
    expect(body.lists[3].chats).toEqual([
      { chatId: '120363@g.us', phone: null, isGroup: true },
    ]);
    expect(cleanName('‎Groups')).toBe('Groups');
  });

  it("refuses to change WhatsApp's own lists or reuse their names", async () => {
    const t = setup();
    await t.call('POST', '/sync');
    expect(
      (await t.call('POST', '/1/chats', { add: ['919800000001'] })).status,
    ).toBe(409);
    expect((await t.call('DELETE', '/3')).status).toBe(409);
    expect((await t.call('PATCH', '/2', { name: 'x' })).status).toBe(409);
    expect((await t.call('POST', '', { name: 'groups' })).status).toBe(400);
    expect((await t.call('POST', '', { name: 'rt' })).status).toBe(409);
  });

  it('renames, moves chats in and out, deletes; ids are never reused', async () => {
    const t = setup();
    await t.call('POST', '/sync');
    const r = await t.call('PATCH', '/7', { name: 'Real time' });
    expect(r.body).toMatchObject({ id: '7', name: 'Real time' });
    const moved = await t.call('POST', '/7/chats', {
      add: ['919800000001'],
      remove: ['120363@g.us', 'not a jid!'],
    });
    expect(moved.body.results.map((x: { ok: boolean }) => x.ok)).toEqual([
      true,
      true,
      false,
    ]);
    expect(moved.body.list.chats).toEqual([
      {
        chatId: '919800000001@s.whatsapp.net',
        phone: '919800000001',
        isGroup: false,
      },
    ]);
    expect((await t.call('DELETE', '/7')).body).toEqual({
      deleted: true,
      id: '7',
    });
    expect((await t.call('GET', '/7')).status).toBe(404);
    expect((await t.call('POST', '', { name: 'next' })).body.id).toBe('8');
  });

  it('reports changes made on the phone', async () => {
    const t = setup();
    await t.call('POST', '/sync');
    t.ev.emit('labels.edit', {
      id: '9',
      name: 'From phone',
      color: 3,
      deleted: false,
    });
    t.ev.emit('labels.edit', {
      id: '9',
      name: 'From phone',
      color: 3,
      deleted: false,
    }); // unchanged: no event
    await tick();
    expect(hooks).toEqual([
      expect.objectContaining({
        event: 'list.updated',
        change: 'created',
        listId: '9',
        name: 'From phone',
      }),
    ]);
  });
});
