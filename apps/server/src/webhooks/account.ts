import { eq } from 'drizzle-orm';
import type { createDatabase } from '../db/client.js';
import { diskDbOf } from '../db/private.js';
import { sessionMeta } from '../db/schema.js';

type Database = ReturnType<typeof createDatabase>;

/**
 * Per account (database): the WhatsApp number linked to it, so every webhook can say which
 * number it came from, and whether the account is on standby.
 */
const phones = new WeakMap<object, string>();

/** Remember the number linked to this account. Call on every connection. */
export function setAccountPhone(db: Database, phone: string | null): void {
  if (phone) phones.set(diskDbOf(db), phone);
}

/** The number linked to this account, once it has connected in this process. */
export function accountPhoneOf(db: Database): string | null {
  return phones.get(diskDbOf(db)) ?? null;
}

const STANDBY_KEY = 'standby';

/**
 * A standby account stays connected, in its groups, and keeps what it needs (keys, the reply
 * window, its chat list), but sends no webhooks at all. A spare number that sits where the
 * main one sits without every event arriving twice.
 */
export function isStandby(db: Database): boolean {
  const row = db
    .select()
    .from(sessionMeta)
    .where(eq(sessionMeta.key, STANDBY_KEY))
    .get();
  return row?.value === '1';
}

export function setStandby(db: Database, standby: boolean): void {
  const disk = diskDbOf(db);
  if (standby)
    disk
      .insert(sessionMeta)
      .values({ key: STANDBY_KEY, value: '1' })
      .onConflictDoUpdate({ target: sessionMeta.key, set: { value: '1' } })
      .run();
  else disk.delete(sessionMeta).where(eq(sessionMeta.key, STANDBY_KEY)).run();
}
