import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';
import { createDatabase } from '../../db/client.js';
import { applyGroupSettings, createGroup, GroupCapError, readGroupSettings, updateParticipants } from '../group-admin.js';

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
    // Group permissions, as WhatsApp keeps them (new groups: members can add, edit info, send)
    state,
    async groupMemberAddMode(_jid: string, mode: string) {
      state.memberAddMode = mode === 'all_member_add';
    },
    async groupSettingUpdate(_jid: string, setting: string) {
      if (failSettingUpdate) throw new Error('not-authorized');
      if (setting === 'locked' || setting === 'unlocked') state.restrict = setting === 'locked';
      else state.announce = setting === 'announcement';
    },
    async groupMetadata() {
      return { ...state };
    },
  } as never;
}

let failSettingUpdate = false;
let state = { memberAddMode: true, restrict: false, announce: false };
function resetState() {
  failSettingUpdate = false;
  state = { memberAddMode: true, restrict: false, announce: false };
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

  it('locks a group down at creation: only admins add members and edit info', async () => {
    resetState();
    const db = freshDb();
    const sock = fakeSock();
    const r = await createGroup(db, sock, 5, {
      name: 'Locked',
      participants: ['919900000001'],
      settings: { membersCanAdd: false, membersCanEditInfo: false },
    });
    expect(r.settings).toEqual({ applied: ['membersCanAdd', 'membersCanEditInfo'], failed: [] });
    expect(await readGroupSettings(sock, r.id)).toEqual({ membersCanAdd: false, membersCanEditInfo: false, adminsOnlyMessages: false, joinApproval: false });
  });

  it('changes only the settings given and reports the ones WhatsApp refused', async () => {
    resetState();
    const sock = fakeSock();
    const jid = '120363000000000001@g.us';
    expect(await applyGroupSettings(sock, jid, { adminsOnlyMessages: true })).toEqual({ applied: ['adminsOnlyMessages'], failed: [] });
    expect(await readGroupSettings(sock, jid)).toEqual({ membersCanAdd: true, membersCanEditInfo: true, adminsOnlyMessages: true, joinApproval: false });

    failSettingUpdate = true;
    const r = await applyGroupSettings(sock, jid, { membersCanAdd: false, membersCanEditInfo: false });
    expect(r.applied).toEqual(['membersCanAdd']);
    expect(r.failed).toEqual([{ setting: 'membersCanEditInfo', error: 'not-authorized' }]);
  });

  it('creates groups without touching settings when none are given', async () => {
    resetState();
    const r = await createGroup(freshDb(), fakeSock(), 5, { name: 'Plain', participants: ['919900000001'] });
    expect(r).not.toHaveProperty('settings');
  });
});
