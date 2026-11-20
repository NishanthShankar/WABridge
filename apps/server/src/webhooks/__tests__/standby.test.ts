import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { Hono } from 'hono';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AppContext, setContext } from '../../context.js';
import { createDatabase } from '../../db/client.js';
import { webhooks } from '../../db/schema.js';
import { isStandby } from '../account.js';
import { createStandbyRouter } from '../standby.router.js';
import { setupWebhookListener } from '../webhook.listener.js';

const logger = pino({ level: 'silent' });
const tick = () => new Promise((r) => setTimeout(r, 20));
const hooks: Array<Record<string, unknown>> = [];
beforeEach(() => {
  hooks.length = 0;
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    hooks.push(JSON.parse(init.body));
    return new Response('ok', { status: 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

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
  const sock = {
    ev: new EventEmitter(),
    ws: { isOpen: true },
    user: { id: '919800000010:3@s.whatsapp.net', lid: '999111:3@lid' },
    groupMetadata: async () => ({ subject: 'Team', participants: [] }),
    signalRepository: { lidMapping: { getLIDForPN: async () => null } },
  };
  setupWebhookListener(sock as never, db, logger);
  const app = new Hono();
  app.use('*', async (c, next) => {
    setContext(c, { db } as unknown as AppContext);
    await next();
  });
  app.route('/api/standby', createStandbyRouter());
  let n = 0;
  const arrive = async () => {
    sock.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: {
            remoteJid: '120363000000000001@g.us',
            id: `M${++n}`,
            fromMe: false,
            participant: '555@lid',
          },
          message: { conversation: 'hello' },
        },
      ],
    });
    await tick();
  };
  const put = (standby: boolean) =>
    app.request('/api/standby', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ standby }),
    });
  return { db, app, arrive, put };
}

describe('standby and accountPhone', () => {
  it('every webhook says which number it came from', async () => {
    const t = setup();
    await t.arrive();
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({
      event: 'message.received',
      accountPhone: '919800000010',
    });
  });

  it('a number on standby sends no webhooks until it is made live again', async () => {
    const t = setup();
    expect(await (await t.put(true)).json()).toEqual({
      standby: true,
      accountPhone: '919800000010',
    });
    expect(isStandby(t.db)).toBe(true);
    await t.arrive();
    await t.arrive();
    expect(hooks).toEqual([]);
    expect(await (await t.app.request('/api/standby')).json()).toMatchObject({
      standby: true,
    });

    await t.put(false);
    await t.arrive();
    expect(hooks).toHaveLength(1);
  });
});
