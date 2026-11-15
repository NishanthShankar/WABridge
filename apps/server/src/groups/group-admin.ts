import { eq } from 'drizzle-orm';
import type makeWASocket from '@whiskeysockets/baileys';
import type { ParticipantAction } from '@whiskeysockets/baileys';
import { groups, sessionMeta } from '../db/schema.js';
import type { createDatabase } from '../db/client.js';
import { jidToPhone, toJid } from '../webhooks/jid.js';

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
  input: { name: string; participants: string[]; description?: string },
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

  return {
    id: meta.id,
    name: meta.subject ?? input.name,
    participants,
    inviteLink: await inviteLink(sock, meta.id),
  };
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
