import type makeWASocket from '@whiskeysockets/baileys';
import type { createDatabase } from '../db/client.js';

type Database = ReturnType<typeof createDatabase>;
type WASocket = ReturnType<typeof makeWASocket>;

/**
 * Another WhatsApp number that belongs to the same owner as an account: in multi-tenant mode,
 * the other users of the same multiuser tenant. A vote on a poll one number sent can reach
 * another number (both sit in the group), and that number may be the only one still linked.
 */
export interface PollAccount {
  db: Database;
  /** The account's socket. It carries the linked number (sock.user) even while offline. */
  getSocket: () => WASocket | null;
}

type Resolver = (db: Database) => PollAccount[];

let resolver: Resolver | null = null;

/** Set by the server mode that has sibling accounts (multi-tenant). null = none. */
export function setPollSiblings(fn: Resolver | null): void {
  resolver = fn;
}

/** The other accounts of the same owner as the account with this database. */
export function siblingsOf(db: Database): PollAccount[] {
  if (!resolver) return [];
  try {
    return resolver(db).filter((a) => a.db !== db);
  } catch {
    return [];
  }
}

/** Vote message ids already taken, per poll home, so two numbers never handle the same vote. */
const seen = new WeakMap<object, Set<string>>();
const SEEN_MAX = 5000;

/** True the first time this vote message is offered for this database, false after. */
export function claimVote(home: object, voteMessageId: string): boolean {
  let ids = seen.get(home);
  if (!ids) {
    ids = new Set();
    seen.set(home, ids);
  }
  if (ids.has(voteMessageId)) return false;
  ids.add(voteMessageId);
  if (ids.size > SEEN_MAX) {
    // Sets keep insertion order: drop the oldest
    const oldest = ids.values().next().value;
    if (oldest !== undefined) ids.delete(oldest);
  }
  return true;
}
