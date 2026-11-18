import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { type AppContext, setContext } from '../../context.js';
import { createDatabase } from '../../db/client.js';
import { applyGroupSettings, readGroupSettings } from '../group-admin.js';
import { JOIN_DAILY_CAP, inviteCode } from '../group-membership.js';
import { createGroupsRouter } from '../groups.router.js';

const GROUP = '120363000000000001@g.us';
const CODE = 'AbCdEf1234567890XyZ';

function setup() {
  const db = createDatabase(':memory:');
  migrate(db, { migrationsFolder: resolve(__dirname, '../../../drizzle') });
  const calls: Array<[string, ...unknown[]]> = [];
  const sock = {
    joinApprovalMode: false,
    async groupGetInviteInfo(code: string) {
      calls.push(['info', code]);
      if (code !== CODE) throw new Error('not-found');
      return {
        id: GROUP,
        subject: 'Clinic staff',
        desc: 'Shifts',
        size: 12,
        creation: 1_700_000_000,
        joinApprovalMode: true,
      };
    },
    async groupAcceptInvite(code: string) {
      calls.push(['accept', code]);
      return GROUP;
    },
    async groupLeave(id: string) {
      calls.push(['leave', id]);
    },
    async groupRevokeInvite(id: string) {
      calls.push(['revoke', id]);
      return 'NewCode1234567';
    },
    async groupRequestParticipantsList(id: string) {
      calls.push(['requests', id]);
      return [
        {
          jid: '919811111111@s.whatsapp.net',
          request_method: 'invite_link',
          request_time: '1700000000',
        },
        {
          jid: '12345@lid',
          phone_number: '919822222222@s.whatsapp.net',
          request_method: 'invite_link',
          request_time: '1700000100',
        },
      ];
    },
    async groupRequestParticipantsUpdate(
      id: string,
      jids: string[],
      action: string,
    ) {
      calls.push(['answer', id, jids, action]);
      return jids.map((jid) => ({
        jid,
        status: jid.startsWith('9198') ? '200' : '404',
      }));
    },
    async groupMetadata() {
      return {
        memberAddMode: true,
        restrict: false,
        announce: false,
        joinApprovalMode: sock.joinApprovalMode,
      };
    },
    async groupJoinApprovalMode(_id: string, mode: string) {
      sock.joinApprovalMode = mode === 'on';
    },
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    setContext(c, {
      db,
      getSocket: () => sock,
      tenantId: 't1',
      config: { groups: { create_daily_cap: 5 } },
    } as unknown as AppContext);
    await next();
  });
  app.route('/api/groups', createGroupsRouter());
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
  return { db, sock, calls, call };
}

describe('invite links', () => {
  it('reads a code from a link or a bare code', () => {
    expect(inviteCode(`https://chat.whatsapp.com/${CODE}`)).toBe(CODE);
    expect(inviteCode(`chat.whatsapp.com/invite/${CODE}?x=1`)).toBe(CODE);
    expect(inviteCode(CODE)).toBe(CODE);
    expect(inviteCode('https://evil.test/AbCdEf1234567890')).toBeNull();
    expect(inviteCode('short')).toBeNull();
  });

  it('previews without joining', async () => {
    const t = setup();
    const r = await t.call(
      'GET',
      `/api/groups/join?link=${encodeURIComponent(`https://chat.whatsapp.com/${CODE}`)}`,
    );
    expect(r).toMatchObject({
      status: 200,
      body: {
        id: GROUP,
        name: 'Clinic staff',
        size: 12,
        joinApprovalRequired: true,
      },
    });
    expect(t.calls.map((c) => c[0])).toEqual(['info']);
  });

  it('a bad or revoked link', async () => {
    const t = setup();
    expect((await t.call('GET', '/api/groups/join?link=nope')).status).toBe(
      400,
    );
    expect(
      (await t.call('GET', '/api/groups/join?link=ZZZZZZZZZZZZZZ')).status,
    ).toBe(404);
  });

  it('joins, up to the daily cap', async () => {
    const t = setup();
    for (let i = 0; i < JOIN_DAILY_CAP; i++)
      expect(
        await t.call('POST', '/api/groups/join', { link: CODE }),
      ).toMatchObject({ status: 200, body: { id: GROUP, joined: true } });
    expect(
      (await t.call('POST', '/api/groups/join', { link: CODE })).status,
    ).toBe(429);
  });

  it('revokes the link and returns the new one', async () => {
    const t = setup();
    expect(await t.call('DELETE', `/api/groups/${GROUP}/invite`)).toMatchObject(
      {
        status: 200,
        body: {
          revoked: true,
          inviteLink: 'https://chat.whatsapp.com/NewCode1234567',
        },
      },
    );
  });
});

describe('leave', () => {
  it('leaves a group, refuses a non-group id', async () => {
    const t = setup();
    expect(await t.call('POST', `/api/groups/${GROUP}/leave`)).toMatchObject({
      status: 200,
      body: { left: true },
    });
    expect(
      (await t.call('POST', '/api/groups/919811111111@s.whatsapp.net/leave'))
        .status,
    ).toBe(400);
    expect(t.calls).toEqual([['leave', GROUP]]);
  });
});

describe('join requests', () => {
  it('lists them with phone numbers where known', async () => {
    const t = setup();
    const r = await t.call('GET', `/api/groups/${GROUP}/requests`);
    expect(r.body.requests).toEqual([
      {
        jid: '919811111111@s.whatsapp.net',
        phone: '919811111111',
        method: 'invite_link',
        requestedAt: '2023-11-14T22:13:20.000Z',
      },
      {
        jid: '12345@lid',
        phone: '919822222222',
        method: 'invite_link',
        requestedAt: '2023-11-14T22:15:00.000Z',
      },
    ]);
  });

  it('approves and rejects, reporting each', async () => {
    const t = setup();
    const r = await t.call('POST', `/api/groups/${GROUP}/requests`, {
      approve: ['+91 98111 11111', 'garbage'],
      reject: ['12345@lid'],
    });
    expect(r.body.results).toEqual([
      {
        input: '+91 98111 11111',
        jid: '919811111111@s.whatsapp.net',
        status: 'approved',
      },
      { input: 'garbage', jid: null, status: 'invalid' },
      { input: '12345@lid', jid: '12345@lid', status: 'failed' },
    ]);
    expect(
      (await t.call('POST', `/api/groups/${GROUP}/requests`, {})).status,
    ).toBe(400);
  });

  it('join approval is a group setting', async () => {
    const t = setup();
    expect(
      await applyGroupSettings(t.sock as never, GROUP, { joinApproval: true }),
    ).toEqual({ applied: ['joinApproval'], failed: [] });
    expect((await readGroupSettings(t.sock as never, GROUP)).joinApproval).toBe(
      true,
    );
  });
});
