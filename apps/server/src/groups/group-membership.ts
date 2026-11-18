import type makeWASocket from '@whiskeysockets/baileys';
import { eq } from 'drizzle-orm';
import type { createDatabase } from '../db/client.js';
import { sessionMeta } from '../db/schema.js';
import { jidToPhone, toJid } from '../webhooks/jid.js';

type Database = ReturnType<typeof createDatabase>;
type WASocket = ReturnType<typeof makeWASocket>;

/**
 * Joining groups by link, at most this many a day (IST). Joining many groups quickly is what
 * spam accounts do, and WhatsApp bans for it.
 */
export const JOIN_DAILY_CAP = 10;

/** "https://chat.whatsapp.com/AbC123..." or the bare code -> the code; null if neither. */
export function inviteCode(input: string): string | null {
  const trimmed = input.trim();
  const m = trimmed.match(
    /^(?:https?:\/\/)?chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9]{10,40})\/?(?:\?.*)?$/,
  );
  if (m) return m[1];
  return /^[A-Za-z0-9]{10,40}$/.test(trimmed) ? trimmed : null;
}

const istDay = (now = Date.now()) =>
  new Date(now + 5.5 * 3_600_000).toISOString().slice(0, 10);

function joinedToday(db: Database): { key: string; count: number } {
  const key = `groups_joined:${istDay()}`;
  const row = db
    .select()
    .from(sessionMeta)
    .where(eq(sessionMeta.key, key))
    .get();
  return { key, count: row ? Number(row.value) || 0 : 0 };
}

export class JoinCapError extends Error {}

/** What the link leads to, without joining. */
export async function previewInvite(sock: WASocket, code: string) {
  const meta = await sock.groupGetInviteInfo(code);
  return {
    id: meta.id,
    name: meta.subject ?? null,
    description: meta.desc ?? null,
    size: meta.size ?? meta.participants?.length ?? null,
    createdAt: meta.creation
      ? new Date(meta.creation * 1000).toISOString()
      : null,
    /** true: an admin must approve the join request before this account is in */
    joinApprovalRequired: !!meta.joinApprovalMode,
  };
}

/**
 * Join by link. If the group needs approval, WhatsApp files a request instead and the group
 * id comes back only once an admin approves.
 */
export async function joinByInvite(db: Database, sock: WASocket, code: string) {
  const today = joinedToday(db);
  if (today.count >= JOIN_DAILY_CAP)
    throw new JoinCapError(
      `This account already joined ${today.count} groups by link today (cap ${JOIN_DAILY_CAP})`,
    );
  const id = await sock.groupAcceptInvite(code);
  db.insert(sessionMeta)
    .values({ key: today.key, value: String(today.count + 1) })
    .onConflictDoUpdate({
      target: sessionMeta.key,
      set: { value: String(today.count + 1) },
    })
    .run();
  return { id: id ?? null, joined: !!id, pendingApproval: !id };
}

/** Make a new invite link; the old one stops working. */
export async function revokeInvite(
  sock: WASocket,
  jid: string,
): Promise<string | null> {
  const code = await sock.groupRevokeInvite(jid);
  return code ? `https://chat.whatsapp.com/${code}` : null;
}

/** People waiting for an admin to let them in. */
export async function listJoinRequests(sock: WASocket, jid: string) {
  const list = (await sock.groupRequestParticipantsList(jid)) as Array<
    Record<string, string>
  >;
  return list.map((r) => ({
    jid: r.jid,
    phone: r.phone_number
      ? jidToPhone(r.phone_number)
      : r.jid?.endsWith('@s.whatsapp.net')
        ? jidToPhone(r.jid)
        : null,
    method: r.request_method ?? null,
    requestedAt: r.request_time
      ? new Date(Number(r.request_time) * 1000).toISOString()
      : null,
  }));
}

/** Approve or reject waiting requests. people: phones or JIDs (a LID from the list works too). */
export async function answerJoinRequests(
  sock: WASocket,
  jid: string,
  people: string[],
  action: 'approve' | 'reject',
) {
  const mapped = people.map((p) => ({ input: p, jid: toJid(p) }));
  const valid = mapped.filter(
    (m): m is { input: string; jid: string } => !!m.jid,
  );
  const res = valid.length
    ? await sock.groupRequestParticipantsUpdate(
        jid,
        valid.map((m) => m.jid),
        action,
      )
    : [];
  return mapped.map((m) => {
    if (!m.jid) return { input: m.input, jid: null, status: 'invalid' };
    const r = res.find(
      (x) =>
        x.jid === m.jid ||
        jidToPhone(x.jid ?? '') === jidToPhone(m.jid as string),
    );
    return {
      input: m.input,
      jid: m.jid,
      status:
        r?.status === '200'
          ? action === 'approve'
            ? 'approved'
            : 'rejected'
          : r
            ? 'failed'
            : 'not_found',
    };
  });
}
