import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { Hono } from 'hono';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHealthRouter } from '../api/health.js';
import { privateMiddleware } from '../api/private.js';
import { createApp } from '../api/routes.js';
import { configSchema } from '../config/schema.js';
import { type AppContext, setContext } from '../context.js';
import { createDatabase } from '../db/client.js';
import { groups, scheduledMessages, webhooks } from '../db/schema.js';
import { type Extension, installExtension } from '../extensions.js';
import { clearGroupCreateHooks } from '../groups/create-hooks.js';
import { createGroupsRouter } from '../groups/groups.router.js';
import { clearNoStoreRules, isNoStoreChat } from '../messages/no-store.js';
import { findMessage } from '../messages/recent-messages.js';
import type { ServerPlugin } from '../plugin.js';
import { createSchedulingRouter } from '../scheduling/scheduling.router.js';
import { createSchedulingService } from '../scheduling/scheduling.service.js';
import {
  type IncomingMessage,
  type IncomingStub,
  clearIncomingHooks,
} from '../webhooks/incoming.js';
import { setupWebhookListener } from '../webhooks/webhook.listener.js';

/**
 * The hooks an extension can put into the server (extensions.ts), tried with a made-up
 * extension: "quiet" chats, whose messages it takes for itself and of which the server must
 * keep nothing.
 */
const QUIET = '120363000000000077@g.us';
const OTHER = '120363000000000078@g.us';
const WRITER = '555000111@lid';
const CIPHERTEXT = 2;
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

// biome-ignore lint/suspicious/noExplicitAny: webhook payloads of several shapes
type Payload = Record<string, any>;
let bodies: Payload[] = [];
let dir: string;

beforeEach(() => {
  bodies = [];
  dir = mkdtempSync(join(tmpdir(), 'wab-hooks-'));
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return new Response('ok', { status: 200 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
  clearIncomingHooks();
  clearNoStoreRules();
  clearGroupCreateHooks();
});

function setup() {
  // On disk: a private request keeps its own copy in memory beside a real database
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
  const logger = pino({ level: 'silent' });
  let created = 0;
  const sock = {
    ev: new EventEmitter(),
    ws: { isOpen: true },
    user: { id: '919800000009:12@s.whatsapp.net', lid: '000009:12@lid' },
    groupMetadata: async (id: string) => ({
      id,
      subject: 'Group name',
      participants: [],
    }),
    signalRepository: {
      lidMapping: {
        getLIDForPN: async () => null,
        getPNForLID: async () => null,
      },
    },
    sendMessage: async () => ({ key: { id: 'X' } }),
    readMessages: async () => {},
    groupCreate: async (subject: string, participants: string[]) => {
      await tick(20);
      if (subject === 'fails') throw new Error('WhatsApp said no');
      return {
        id: `12036300000000099${++created}@g.us`,
        subject,
        participants: participants.map((id) => ({ id })),
      };
    },
    groupInviteCode: async () => 'Code',
  };
  const queued: Array<Record<string, unknown>> = [];
  const queue = {
    add: async (_n: string, data: Record<string, unknown>) => {
      queued.push(data);
    },
    getJob: async () => null,
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    setContext(c, {
      db,
      getSocket: () => sock,
      getHealth: () => ({ status: 'ok' }),
      broadcast: () => {},
      tenantId: 'main',
      config: configSchema.parse({}),
    } as unknown as AppContext);
    await next();
  });
  app.use('*', privateMiddleware());
  app.route('/api', createHealthRouter());
  app.route('/api/messages', createSchedulingRouter(queue as never));
  app.route('/api/groups', createGroupsRouter());
  setupWebhookListener(sock as never, db, logger);

  let n = 0;
  const arrive = async (
    message: object | null,
    opts: { chat?: string; stub?: number } = {},
  ) => {
    const id = `IN${++n}`;
    sock.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: {
            remoteJid: opts.chat ?? QUIET,
            id,
            fromMe: false,
            participant: WRITER,
          },
          pushName: 'Profile Name',
          messageTimestamp: 1_795_000_000,
          ...(message ? { message } : {}),
          ...(opts.stub ? { messageStubType: opts.stub } : {}),
        },
      ],
    });
    await tick();
    return id;
  };
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { db, app, sock, arrive, post, queued };
}

describe('extension hooks', () => {
  it('incoming: an extension takes a chat’s messages and the server delivers nothing of them', async () => {
    const taken: IncomingMessage[] = [];
    const unreadable: IncomingStub[] = [];
    installExtension({
      name: 'quiet',
      incoming: (chat) =>
        chat.chatJid === QUIET
          ? {
              anonymous: true,
              fields: { quiet: true },
              take: async (m) => {
                taken.push(m);
              },
              unreadable: async (s) => {
                unreadable.push(s);
              },
            }
          : null,
    });
    const t = setup();

    // A message, an edit and a delete go to the extension, and to nobody else
    const id = await t.arrive({ conversation: 'for the extension only' });
    await t.arrive({
      protocolMessage: {
        type: 14, // MESSAGE_EDIT
        key: { id },
        editedMessage: { conversation: 'edited' },
      },
    });
    await t.arrive({ protocolMessage: { type: 0, key: { id } } }); // REVOKE
    expect(taken.map((m) => [m.isEdit, m.isRevoke])).toEqual([
      [false, false],
      [true, false],
      [false, true],
    ]);
    expect(taken[0]).toMatchObject({
      chatJid: QUIET,
      isGroup: true,
      senderLid: WRITER,
      contentType: 'conversation',
    });
    expect(bodies).toEqual([]);

    // Something that could not be decrypted: only the extension is told
    await t.arrive(null, { stub: CIPHERTEXT });
    expect(unreadable).toHaveLength(1);
    expect(bodies).toEqual([]);

    // A reaction is still the server's to deliver: with the extension's fields, and
    // without the profile name and the group's name
    await t.arrive({ reactionMessage: { key: { id }, text: '👍' } });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      event: 'message.reaction',
      chatId: QUIET,
      quiet: true,
    });
    expect(bodies[0]).not.toHaveProperty('pushName');
    expect(bodies[0]).not.toHaveProperty('group');

    // Any other chat is delivered as always
    bodies = [];
    await t.arrive({ conversation: 'hello' }, { chat: OTHER });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      text: 'hello',
      pushName: 'Profile Name',
      group: { id: OTHER, name: 'Group name' },
    });
    expect(bodies[0]).not.toHaveProperty('quiet');
    expect(taken).toHaveLength(3);
  });

  it('incoming: when the extension fails, the message is not delivered at all', async () => {
    let mode: 'throw-on-claim' | 'throw-on-take' = 'throw-on-claim';
    installExtension({
      name: 'quiet',
      incoming: (chat) => {
        if (chat.chatJid !== QUIET) return null;
        if (mode === 'throw-on-claim') throw new Error('cannot read my list');
        return {
          take: async () => {
            throw new Error('could not handle it');
          },
        };
      },
    });
    const t = setup();
    await t.arrive({ conversation: 'must not leak' });
    mode = 'throw-on-take';
    await t.arrive({ conversation: 'must not leak either' });
    expect(bodies).toEqual([]);
    // Without anonymous, what the server still delivers keeps its usual fields
    await t.arrive({ reactionMessage: { key: { id: 'IN1' }, text: '👍' } });
    expect(bodies[0]).toMatchObject({ pushName: 'Profile Name' });
  });

  it('noStore: what is sent into such a chat is private and never stored, flag or no flag', async () => {
    let broken = false;
    installExtension({
      name: 'quiet',
      noStore: {
        reason: 'quiet-chat',
        applies: (_db, jids) => {
          if (broken) throw new Error('cannot read my list');
          return jids.includes(QUIET);
        },
        exemptPath: (path) => path.startsWith('/api/messages/exempt'),
        messages: { notStored: 'quiet chats are never stored' },
      },
    });
    const t = setup();
    t.db.insert(groups).values({ id: QUIET, name: 'Q' }).run();

    const res = await t.post('/api/messages', { groupId: QUIET, content: 'x' });
    expect(res.status).toBe(201);
    expect(res.headers.get('X-Private')).toBe('true');
    expect(res.headers.get('X-Private-Reason')).toBe('quiet-chat');
    // In a bulk request too
    const bulk = await t.post('/api/messages/bulk', {
      messages: [
        { phone: '919812345678', content: 'hello' },
        { groupId: QUIET, content: 'y' },
      ],
    });
    expect(bulk.headers.get('X-Private-Reason')).toBe('quiet-chat');
    expect(t.db.select().from(scheduledMessages).all()).toEqual([]);
    expect(t.queued.every((j) => j.private === true)).toBe(true);

    // The store itself refuses, should a request ever get past that
    const direct = createSchedulingService(
      t.db,
      { add: async () => {} } as never,
      configSchema.parse({}),
    );
    const toQuiet = () =>
      direct.scheduleMessage(
        undefined,
        'x',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        QUIET,
      );
    await expect(toQuiet()).rejects.toThrow('quiet chats are never stored');
    expect(t.db.select().from(scheduledMessages).all()).toEqual([]);

    // Its messages are not remembered in memory
    const quietId = await t.arrive({ conversation: 'not kept' });
    const otherId = await t.arrive({ conversation: 'kept' }, { chat: OTHER });
    expect(findMessage(t.sock as never, [QUIET], quietId)).toBeNull();
    expect(findMessage(t.sock as never, [OTHER], otherId)).not.toBeNull();

    // Any other chat is stored as always
    const plain = await t.post('/api/messages', {
      phone: '919812345678',
      content: 'hello',
    });
    expect(plain.headers.get('X-Private')).toBeNull();
    expect(t.db.select().from(scheduledMessages).all()).toHaveLength(1);

    // A rule that cannot tell counts as yes
    broken = true;
    expect(isNoStoreChat(t.db, OTHER)).toBe(true);
    const unsure = await t.post('/api/messages', {
      phone: '919812345678',
      content: 'hello',
    });
    expect(unsure.headers.get('X-Private-Reason')).toBe('quiet-chat');
    expect(t.db.select().from(scheduledMessages).all()).toHaveLength(1);
  });

  it('groupCreate: an extension reads its own field, can refuse, and hears of the group at once', async () => {
    const calls: string[] = [];
    installExtension({
      name: 'quiet',
      groupCreate: {
        field: 'quiet',
        prepare(_ctx, value) {
          calls.push(`prepare:${JSON.stringify(value)}`);
          if (value === 'bad')
            return { refuse: { status: 400, body: { error: 'bad_quiet' } } };
          return {
            onCreated: (jid) => calls.push(`created:${jid}`),
            respond: (group) => {
              calls.push(`respond:${group.id}`);
              return { quiet: true };
            },
            settled: () => calls.push('settled'),
          };
        },
      },
    });
    const t = setup();
    const create = async (body: object) => {
      const res = await t.post('/api/groups', {
        name: 'G',
        participants: ['919812345678'],
        ...body,
      });
      return { status: res.status, body: (await res.json()) as Payload };
    };

    const ok = await create({ quiet: { level: 1 } });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({
      id: '120363000000000991@g.us',
      quiet: true,
    });
    expect(calls).toEqual([
      'prepare:{"level":1}',
      'created:120363000000000991@g.us',
      'respond:120363000000000991@g.us',
      'settled',
    ]);

    // Refused: no group is created
    calls.length = 0;
    const bad = await create({ quiet: 'bad' });
    expect(bad).toMatchObject({ status: 400, body: { error: 'bad_quiet' } });
    expect(calls).toEqual(['prepare:"bad"']);

    // The creation fails: the extension is still told it is over
    calls.length = 0;
    const failed = await create({ name: 'fails', quiet: 1 });
    expect(failed.status).toBe(502);
    expect(calls).toEqual(['prepare:1', 'settled']);

    // Without the field the extension is not asked
    calls.length = 0;
    const plain = await create({});
    expect(plain.status).toBe(201);
    expect(plain.body).not.toHaveProperty('quiet');
    expect(calls).toEqual([]);
  });

  it('features: an extension’s feature names are listed in GET /api/health', async () => {
    installExtension({
      name: 'quiet',
      features: ['quiet-chats', 'reply-lane'],
    });
    const t = setup();
    const health = (await (await t.app.request('/api/health')).json()) as {
      features: string[];
    };
    expect(health.features).toContain('quiet-chats');
    expect(health.features.filter((f) => f === 'reply-lane')).toHaveLength(1);
  });

  it('routes: an extension route marked first is matched before the server’s own', async () => {
    const router = () => {
      const r = new Hono();
      r.get('/quiet', (c) => c.json({ from: 'extension' }));
      return r;
    };
    const build = (first: boolean) => {
      const ext: Extension = {
        name: 'quiet',
        routes: [{ basePath: 'chats', router: router(), first }],
      };
      const db = createDatabase(':memory:');
      migrate(db, { migrationsFolder: resolve(__dirname, '../../drizzle') });
      // Only what createApp itself uses of a plugin
      const plugin: Pick<ServerPlugin, 'apiMiddleware' | 'setupWebSocket'> = {
        apiMiddleware: async (c, next) => {
          setContext(c, {
            db,
            getSocket: () => null,
            broadcast: () => {},
            config: configSchema.parse({}),
          } as unknown as AppContext);
          await next();
        },
        setupWebSocket: () => ({
          wsHandler: async (_c, next) => next(),
          injectWebSocket: () => {},
        }),
      };
      const queue = { add: async () => {}, getJob: async () => null };
      return createApp(plugin as ServerPlugin, queue as never, [ext]).app;
    };
    // First: /api/chats/quiet is the extension's
    const first = await build(true).request('/api/chats/quiet');
    expect(await first.json()).toEqual({ from: 'extension' });
    // Not first: the server reads "quiet" as a chat id
    const last = await build(false).request('/api/chats/quiet');
    expect(await last.json()).not.toEqual({ from: 'extension' });
  });
});
