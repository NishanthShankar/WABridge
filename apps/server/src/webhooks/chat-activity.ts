import { inArray, sql } from 'drizzle-orm';
import type { createDatabase } from '../db/client.js';
import { chatActivity } from '../db/schema.js';

type Database = ReturnType<typeof createDatabase>;

/** How long after someone writes the account may answer outside the queue and the daily cap. */
export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Stamp "this chat just wrote to us". altJid is the phone form of a LID sender, when known. */
export function recordInbound(
  db: Database,
  jid: string,
  altJid: string | null,
  at = new Date(),
): void {
  for (const j of altJid && altJid !== jid ? [jid, altJid] : [jid]) {
    db.insert(chatActivity)
      .values({ jid: j, lastInboundAt: at })
      .onConflictDoUpdate({
        target: chatActivity.jid,
        set: { lastInboundAt: at },
      })
      .run();
  }
}

/** When any of these JIDs last wrote, or null if never. */
export function lastInbound(db: Database, jids: string[]): Date | null {
  if (jids.length === 0) return null;
  const row = db
    .select({ at: sql<number>`max(${chatActivity.lastInboundAt})` })
    .from(chatActivity)
    .where(inArray(chatActivity.jid, jids))
    .get();
  return row?.at ? new Date(row.at) : null;
}

export function insideReplyWindow(
  db: Database,
  jids: string[],
  now = Date.now(),
): boolean {
  const at = lastInbound(db, jids);
  return !!at && now - at.getTime() < REPLY_WINDOW_MS;
}
