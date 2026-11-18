import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { type AppContext, setContext } from '../../context.js';
import { createDatabase } from '../../db/client.js';
import { contacts } from '../../db/schema.js';
import { MAX_AUDIENCE, createStatusRouter } from '../status.router.js';

const A = '919800000001@s.whatsapp.net';
const B = '919800000002@s.whatsapp.net';

function setup(tenantId = 't1') {
  const db = createDatabase(':memory:');
  migrate(db, { migrationsFolder: resolve(__dirname, '../../../drizzle') });
  const sent: Array<{
    jid: string;
    content: Record<string, unknown>;
    opts: Record<string, unknown>;
  }> = [];
  const sock = {
    async sendMessage(
      jid: string,
      content: Record<string, unknown>,
      opts: Record<string, unknown>,
    ) {
      sent.push({ jid, content, opts });
      return { key: { id: `ST${sent.length}` } };
    },
  };
  let tenant = tenantId;
  const app = new Hono();
  app.use('*', async (c, next) => {
    setContext(c, {
      db,
      getSocket: () => sock,
      tenantId: tenant,
    } as unknown as AppContext);
    await next();
  });
  app.route('/api/status', createStatusRouter());
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
  const asTenant = (t: string) => {
    tenant = t;
  };
  return { db, sent, call, asTenant };
}

describe('POST /api/status', () => {
  it('posts a text Status to the audience, with a style', async () => {
    const t = setup();
    const r = await t.call('POST', '/api/status', {
      text: 'Open on Sunday',
      audience: ['+91 98000 00001', '919800000002', '919800000001', 'junk'],
      backgroundColor: '25d366',
      font: 2,
    });
    expect(r).toMatchObject({
      status: 201,
      body: { statusId: 'ST1', audienceCount: 2, invalid: ['junk'] },
    });
    expect(t.sent[0]).toEqual({
      jid: 'status@broadcast',
      content: { text: 'Open on Sunday' },
      opts: {
        statusJidList: [A, B],
        broadcast: true,
        backgroundColor: '#25D366',
        font: 2,
      },
    });
  });

  it('an image Status to every contact', async () => {
    const t = setup();
    t.db
      .insert(contacts)
      .values([
        { id: 'c1', phone: '+919800000001' },
        { id: 'c2', phone: '+919800000002' },
      ])
      .run();
    const r = await t.call('POST', '/api/status', {
      text: 'New timings',
      mediaUrl: 'https://x.test/a.jpg',
      mediaType: 'image',
      allContacts: true,
    });
    expect(r.status).toBe(201);
    expect(t.sent[0].content).toEqual({
      image: { url: 'https://x.test/a.jpg' },
      caption: 'New timings',
    });
    expect(t.sent[0].opts).toEqual({ statusJidList: [A, B], broadcast: true });
  });

  it('validates', async () => {
    const t = setup();
    expect((await t.call('POST', '/api/status', { text: 'x' })).status).toBe(
      400,
    ); // no audience
    expect(
      (
        await t.call('POST', '/api/status', {
          text: 'x',
          audience: [A],
          allContacts: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await t.call('POST', '/api/status', {
          mediaUrl: 'https://x.test/a.jpg',
          audience: [A],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await t.call('POST', '/api/status', {
          mediaUrl: 'https://x.test/a.jpg',
          mediaType: 'image',
          font: 1,
          audience: [A],
        })
      ).status,
    ).toBe(400);
    expect(
      (await t.call('POST', '/api/status', { text: 'x', audience: ['junk'] }))
        .body.error,
    ).toBe('no_audience');
    expect(
      (
        await t.call('POST', '/api/status', {
          text: 'x',
          audience: ['120363000000000001@g.us'],
        })
      ).body.error,
    ).toBe('no_audience');
    const many = Array.from(
      { length: MAX_AUDIENCE + 1 },
      (_, i) => `9198${String(i).padStart(8, '0')}`,
    );
    expect(
      (await t.call('POST', '/api/status', { text: 'x', audience: many }))
        .status,
    ).toBe(400);
  });
});

describe('DELETE /api/status/:id', () => {
  it("deletes for the same audience; unknown or another tenant's id is 404", async () => {
    const t = setup();
    await t.call('POST', '/api/status', { text: 'x', audience: [A, B] });
    t.asTenant('t2');
    expect((await t.call('DELETE', '/api/status/ST1')).status).toBe(404);
    t.asTenant('t1');
    expect(await t.call('DELETE', '/api/status/ST1')).toMatchObject({
      status: 200,
      body: { deleted: true },
    });
    expect(t.sent[1]).toEqual({
      jid: 'status@broadcast',
      content: {
        delete: { remoteJid: 'status@broadcast', id: 'ST1', fromMe: true },
      },
      opts: { statusJidList: [A, B], broadcast: true },
    });
    expect((await t.call('DELETE', '/api/status/ST1')).status).toBe(404);
  });
});
