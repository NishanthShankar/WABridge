import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';
import { createDatabase } from '../../db/client.js';
import { createGroup, GroupCapError, updateParticipants } from '../group-admin.js';

function freshDb() {
  const db = createDatabase(':memory:');
  migrate(db, { migrationsFolder: resolve(__dirname, '../../../drizzle') });
  return db;
}

// A stand-in for the Baileys socket: 919900000002 has privacy settings that block adds.
function fakeSock() {
  const blocked = '919900000002@s.whatsapp.net';
  return {
    async groupCreate(subject: string, participants: string[]) {
      return {
        id: '120363000000000001@g.us',
        subject,
        participants: [{ id: '919000000000@s.whatsapp.net', admin: 'superadmin' }, ...participants.filter((p) => p !== blocked).map((id) => ({ id }))],
      };
    },
    async groupUpdateDescription() {},
    async groupInviteCode() {
      return 'AbCdEf123';
    },
    async groupParticipantsUpdate(_jid: string, jids: string[]) {
      return jids.map((jid) => ({ jid, status: jid === blocked ? '403' : '200' }));
    },
  } as never;
}

describe('group admin', () => {
  it('creates a group and reports who needs an invite', async () => {
    const db = freshDb();
    const r = await createGroup(db, fakeSock(), 5, { name: 'Flat 4B', participants: ['+91 99000 00001', '919900000002', 'nope'] });
    expect(r.id).toBe('120363000000000001@g.us');
    expect(r.inviteLink).toBe('https://chat.whatsapp.com/AbCdEf123');
    expect(r.participants.map((p) => p.status)).toEqual(['added', 'invite_needed', 'invalid']);
  });

  it('stops at the daily cap', async () => {
    const db = freshDb();
    await createGroup(db, fakeSock(), 1, { name: 'One', participants: ['919900000001'] });
    await expect(createGroup(db, fakeSock(), 1, { name: 'Two', participants: ['919900000001'] })).rejects.toBeInstanceOf(GroupCapError);
  });

  it('adds members and returns the invite link for blocked ones', async () => {
    const r = await updateParticipants(fakeSock(), '120363000000000001@g.us', { add: ['919900000001', '919900000002'] });
    expect(r.participants.map((p) => p.status)).toEqual(['added', 'invite_needed']);
    expect(r.inviteLink).toBe('https://chat.whatsapp.com/AbCdEf123');
  });
});
