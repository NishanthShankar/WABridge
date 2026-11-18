import { eq } from 'drizzle-orm';
import type makeWASocket from '@whiskeysockets/baileys';
import type { ParticipantAction } from '@whiskeysockets/baileys';
import { groups, sessionMeta } from '../db/schema.js';
import type { createDatabase } from '../db/client.js';
import { safeFetch } from '../net/safe-fetch.js';
import { jidToPhone, toJid } from '../webhooks/jid.js';
import type { GroupSettingsInput } from './groups.schema.js';

type Database = ReturnType<typeof createDatabase>;
type WASocket = ReturnType<typeof makeWASocket>;

/** Start of today in IST, as "YYYY-MM-DD" (the daily caps reset at IST midnight). */
function istDay(now = Date.now()): string {
  return new Date(now + 5.5 * 3_600_000).toISOString().slice(0, 10);
}

/** How many groups this account created today, and bump it. Kept in session_meta. */
function createdToday(db: Database): { key: string; count: number } {
  const key = `groups_created:${istDay()}`;
  const row = db.select().from(sessionMeta).where(eq(sessionMeta.key, key)).get();
  return { key, count: row ? Number(row.value) || 0 : 0 };
}

function bumpCreated(db: Database, key: string, count: number) {
  db.insert(sessionMeta)
    .values({ key, value: String(count) })
    .onConflictDoUpdate({ target: sessionMeta.key, set: { value: String(count) } })
    .run();
}

export interface ParticipantResult {
  input: string;
  jid: string | null;
  phone: string | null;
  /** added | invite_needed (their privacy settings block being added) | invalid | failed | removed | promoted | demoted */
  status: string;
}

function statusFor(code: string | undefined, action: ParticipantAction | 'create'): string {
  const done = { create: 'added', add: 'added', remove: 'removed', promote: 'promoted', demote: 'demoted', modify: 'modified' };
  if (code === '200') return done[action];
  if (code === '403' || code === '408') return 'invite_needed';
  if (code === '409') return action === 'add' ? 'added' : 'failed'; // already in the group
  return 'failed';
}

async function inviteLink(sock: WASocket, jid: string): Promise<string | null> {
  try {
    const code = await sock.groupInviteCode(jid);
    return code ? `https://chat.whatsapp.com/${code}` : null;
  } catch {
    return null;
  }
}

export class GroupCapError extends Error {
  statusCode = 429;
}

/**
 * Create a group with these people; this account becomes its admin. People who can't be added
 * directly (privacy settings) come back as invite_needed, with the invite link to send them.
 */
export async function createGroup(
  db: Database,
  sock: WASocket,
  cap: number,
  input: {
    name: string;
    participants: string[];
    description?: string;
    settings?: GroupSettingsInput;
    pictureUrl?: string;
  },
) {
  const { key, count } = createdToday(db);
  if (count >= cap) throw new GroupCapError(`Daily group creation cap reached (${count}/${cap})`);

  const wanted = input.participants.map((p) => ({ input: p, jid: toJid(p) }));
  const valid = [...new Set(wanted.filter((w) => w.jid && !w.jid.endsWith('@g.us')).map((w) => w.jid!))];
  if (valid.length === 0) throw Object.assign(new Error('No valid participants'), { statusCode: 400 });

  const meta = await sock.groupCreate(input.name, valid);
  bumpCreated(db, key, count + 1);

  if (input.description) {
    await sock.groupUpdateDescription(meta.id, input.description).catch(() => {});
  }

  // Who actually made it in: compare by phone, since members may come back as LIDs.
  const inGroup = new Set<string>();
  for (const p of meta.participants ?? []) {
    inGroup.add(jidToPhone(p.id));
    if (p.phoneNumber) inGroup.add(jidToPhone(p.phoneNumber));
  }
  const participants: ParticipantResult[] = wanted.map((w) => {
    if (!w.jid) return { input: w.input, jid: null, phone: null, status: 'invalid' };
    const phone = jidToPhone(w.jid);
    return { input: w.input, jid: w.jid, phone, status: inGroup.has(phone) ? 'added' : 'invite_needed' };
  });

  const now = new Date();
  db.insert(groups)
    .values({
      id: meta.id,
      name: meta.subject ?? input.name,
      description: input.description ?? null,
      participantCount: meta.participants?.length ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();

  // Permissions are applied after creating: a failure here doesn't undo the group, it's reported.
  const settings = input.settings ? await applyGroupSettings(sock, meta.id, input.settings) : null;

  // Same for the picture: reported, never fatal.
  let picture: { set: boolean; error?: string } | null = null;
  if (input.pictureUrl) {
    try {
      await setGroupPicture(sock, meta.id, input.pictureUrl);
      picture = { set: true };
    } catch (err) {
      picture = { set: false, error: (err as Error).message };
    }
  }

  return {
    id: meta.id,
    name: meta.subject ?? input.name,
    participants,
    inviteLink: await inviteLink(sock, meta.id),
    ...(settings ? { settings } : {}),
    ...(picture ? { picture } : {}),
  };
}

export interface GroupSettings {
  /** false: only admins can add members */
  membersCanAdd: boolean;
  /** false: only admins can change the group name, photo and description */
  membersCanEditInfo: boolean;
  /** true: only admins can send messages */
  adminsOnlyMessages: boolean;
  /** true: people joining by link wait for an admin to approve them */
  joinApproval: boolean;
}

/** The group's current permissions, as WhatsApp reports them. */
export async function readGroupSettings(sock: WASocket, jid: string): Promise<GroupSettings> {
  const meta = await sock.groupMetadata(jid);
  return {
    membersCanAdd: !!meta.memberAddMode,
    membersCanEditInfo: !meta.restrict,
    adminsOnlyMessages: !!meta.announce,
    joinApproval: !!meta.joinApprovalMode,
  };
}

/**
 * Change the given permissions; each one left out stays as it is. Every change is tried, and
 * the ones WhatsApp refused (usually: this account isn't an admin) come back in failed.
 */
export async function applyGroupSettings(sock: WASocket, jid: string, wanted: GroupSettingsInput) {
  const steps: Array<[keyof GroupSettings, () => Promise<void>]> = [];
  if (wanted.membersCanAdd !== undefined)
    steps.push(['membersCanAdd', () => sock.groupMemberAddMode(jid, wanted.membersCanAdd ? 'all_member_add' : 'admin_add')]);
  if (wanted.membersCanEditInfo !== undefined)
    steps.push(['membersCanEditInfo', () => sock.groupSettingUpdate(jid, wanted.membersCanEditInfo ? 'unlocked' : 'locked')]);
  if (wanted.adminsOnlyMessages !== undefined)
    steps.push(['adminsOnlyMessages', () => sock.groupSettingUpdate(jid, wanted.adminsOnlyMessages ? 'announcement' : 'not_announcement')]);

  if (wanted.joinApproval !== undefined)
    steps.push(['joinApproval', () => sock.groupJoinApprovalMode(jid, wanted.joinApproval ? 'on' : 'off')]);

  const applied: Array<keyof GroupSettings> = [];
  const failed: Array<{ setting: keyof GroupSettings; error: string }> = [];
  for (const [setting, run] of steps) {
    try {
      await run();
      applied.push(setting);
    } catch (err) {
      failed.push({ setting, error: (err as Error).message });
    }
  }
  return { applied, failed };
}

export async function updateParticipants(
  sock: WASocket,
  groupJid: string,
  change: Partial<Record<'add' | 'remove' | 'promote' | 'demote', string[]>>,
) {
  const results: ParticipantResult[] = [];
  for (const action of ['add', 'remove', 'promote', 'demote'] as const) {
    const list = change[action];
    if (!list?.length) continue;
    const mapped = list.map((p) => ({ input: p, jid: toJid(p) }));
    for (const m of mapped.filter((x) => !x.jid)) results.push({ input: m.input, jid: null, phone: null, status: 'invalid' });
    const jids = mapped.filter((x) => x.jid).map((x) => x.jid!);
    if (!jids.length) continue;
    const res = await sock.groupParticipantsUpdate(groupJid, jids, action);
    for (const m of mapped.filter((x) => x.jid)) {
      const phone = jidToPhone(m.jid!);
      const r = res.find((x) => jidToPhone(x.jid ?? '') === phone);
      results.push({ input: m.input, jid: m.jid, phone, status: statusFor(r?.status, action) });
    }
  }
  const needsInvite = results.some((r) => r.status === 'invite_needed');
  return { id: groupJid, participants: results, inviteLink: needsInvite ? await inviteLink(sock, groupJid) : null };
}

export { inviteLink };

/** Rename a group and/or change its description, and keep the local copy in step. */
export async function updateGroupInfo(
  db: Database,
  sock: WASocket,
  jid: string,
  input: { name?: string; description?: string },
) {
  const applied: Array<'name' | 'description'> = [];
  const failed: Array<{ field: 'name' | 'description'; error: string }> = [];
  if (input.name !== undefined) {
    try {
      await sock.groupUpdateSubject(jid, input.name);
      applied.push('name');
    } catch (err) {
      failed.push({ field: 'name', error: (err as Error).message });
    }
  }
  if (input.description !== undefined) {
    try {
      // undefined removes the description in WhatsApp
      await sock.groupUpdateDescription(jid, input.description || undefined);
      applied.push('description');
    } catch (err) {
      failed.push({ field: 'description', error: (err as Error).message });
    }
  }
  const set: Partial<typeof groups.$inferInsert> = { updatedAt: new Date() };
  if (applied.includes('name')) set.name = input.name;
  if (applied.includes('description')) set.description = input.description || null;
  if (applied.length) db.update(groups).set(set).where(eq(groups.id, jid)).run();
  return { applied, failed };
}

const MAX_PICTURE_BYTES = 5 * 1024 * 1024;

/** Download an image (http/https only, at most 5 MB, must be an image). */
export async function fetchImage(url: string, fetchImpl: typeof fetch = safeFetch): Promise<Buffer> {
  if (!/^https?:\/\//i.test(url)) throw Object.assign(new Error('URL must be http or https'), { statusCode: 400 });
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000), redirect: 'follow' });
  if (!res.ok) throw Object.assign(new Error(`Image download failed: HTTP ${res.status}`), { statusCode: 422 });
  const type = res.headers.get('content-type') ?? '';
  if (type && !type.startsWith('image/'))
    throw Object.assign(new Error(`Not an image (content-type ${type})`), { statusCode: 422 });
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_PICTURE_BYTES) throw Object.assign(new Error('Image is larger than 5 MB'), { statusCode: 422 });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_PICTURE_BYTES) throw Object.assign(new Error('Image is larger than 5 MB'), { statusCode: 422 });
  if (buf.length === 0) throw Object.assign(new Error('Image is empty'), { statusCode: 422 });
  return buf;
}

/** Set a group's picture from an image URL. WhatsApp crops it to a square. */
export async function setGroupPicture(
  sock: WASocket,
  jid: string,
  url: string,
  fetchImpl: typeof fetch = safeFetch,
): Promise<void> {
  const image = await fetchImage(url, fetchImpl);
  await sock.updateProfilePicture(jid, image);
}
