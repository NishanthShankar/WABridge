import type makeWASocket from '@whiskeysockets/baileys';
import { and, eq, isNull, lte } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { createDatabase } from '../db/client.js';
import { onPrivateDb, peekPrivateDb } from '../db/private.js';
import { pollVotes, polls } from '../db/schema.js';
import { isGroupJid, jidToPhone, ownJids } from '../webhooks/jid.js';
import { fireWebhook } from '../webhooks/webhook.listener.js';
import { createWebhooksService } from '../webhooks/webhooks.service.js';
import { siblingsOf } from './poll-accounts.js';
import {
  PollNotOursError,
  deletePoll,
  getPoll,
  sentByThisNumber,
} from './polls.js';

type Database = ReturnType<typeof createDatabase>;
type WASocket = ReturnType<typeof makeWASocket>;
type PollRow = typeof polls.$inferSelect;

/** Waits before each retry of a failed delete; after the last one the bridge gives up. */
export const DELETE_RETRY_MS = [
  10_000,
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
];
/** How often due deletes (deleteAt, retries) are checked. */
export const SWEEP_MS = 10_000;

interface Tenant {
  sock: WASocket;
  logger: Logger;
}
const tenants = new WeakMap<object, Tenant>();

/**
 * Start the poll sweeper for this tenant (once), and point it at the newest socket.
 * Call on every connection. The first call after a start releases stealth votes that were
 * waiting for an acknowledgment: those were held in memory and are gone.
 */
export function attachPollJobs(
  sock: WASocket,
  db: Database,
  logger: Logger,
): void {
  stampSender(sock, db);
  // Polls sent by private requests are swept too, from the account's private database
  const priv = peekPrivateDb(db);
  if (priv) attachPollJobs(sock, priv, logger);
  const known = tenants.get(db);
  if (known) {
    known.sock = sock;
    known.logger = logger;
    return;
  }
  tenants.set(db, { sock, logger });
  releaseAllAwaiting(db);
  const timer = setInterval(() => {
    sweepPolls(db).catch((err) =>
      tenants
        .get(db)
        ?.logger.warn({ err: (err as Error).message }, 'Poll sweep failed'),
    );
  }, SWEEP_MS);
  timer.unref?.();
}

/**
 * Polls sent before the sender was recorded get the number linked now. Runs on every
 * connection, so in practice on the first one after the upgrade, while that is still the
 * number that sent them.
 */
function stampSender(sock: WASocket, db: Database): void {
  const own = [...ownJids(sock)];
  if (!own.length) return;
  db.update(polls)
    .set({ senderJids: JSON.stringify(own) })
    .where(isNull(polls.senderJids))
    .run();
}

// A private database created after the account connected joins the sweep straight away
onPrivateDb((disk, priv) => {
  const account = tenants.get(disk);
  if (account) attachPollJobs(account.sock, priv, account.logger);
});

export function currentSock(db: object): WASocket | null {
  return tenants.get(db)?.sock ?? null;
}

function isOpen(sock: WASocket): boolean {
  return (
    (sock as unknown as { ws?: { isOpen?: boolean } }).ws?.isOpen !== false
  );
}

/** Stealth deleteAfterVote votes still waiting for an ack when the server stopped. */
export function releaseAllAwaiting(db: Database): void {
  const rows = db
    .select({ pollId: pollVotes.pollId })
    .from(pollVotes)
    .where(eq(pollVotes.note, 'awaiting_ack'))
    .all();
  if (!rows.length) return;
  db.delete(pollVotes).where(eq(pollVotes.note, 'awaiting_ack')).run();
  for (const pollId of new Set(rows.map((r) => r.pollId))) {
    const counted = db
      .select({ id: pollVotes.id })
      .from(pollVotes)
      .where(and(eq(pollVotes.pollId, pollId), eq(pollVotes.counted, true)))
      .get();
    if (!counted)
      db.update(polls).set({ votedAt: null }).where(eq(polls.id, pollId)).run();
  }
}

/** Send a poll lifecycle event to the webhooks that get this chat's votes. */
export function notifyPoll(
  db: Database,
  logger: Logger,
  poll: PollRow,
  fields: Record<string, unknown>,
): void {
  const service = createWebhooksService(db);
  const isGroup = isGroupJid(poll.chatJid);
  const hooks = isGroup
    ? service.getAllEvents()
    : service.getByPhone(jidToPhone(poll.chatJid));
  const payload = {
    timestamp: new Date().toISOString(),
    chatId: poll.chatJid,
    isGroup,
    pollId: poll.id,
    pollName: poll.name,
    ref: poll.ref,
    ...fields,
  };
  for (const hook of hooks) fireWebhook(hook, payload, logger);
}

/** Record a failed delete: schedule the next try, or give up and tell the client. */
function retryLater(
  db: Database,
  logger: Logger,
  poll: PollRow,
  reason: string,
  err: Error,
): void {
  const attempts = poll.deleteAttempts + 1;
  // A poll this number cannot delete stays that way: no point retrying
  if (err instanceof PollNotOursError || attempts > DELETE_RETRY_MS.length) {
    db.update(polls)
      .set({
        deleteAt: null,
        deleteAttempts: attempts,
        deleteFailedAt: new Date(),
      })
      .where(eq(polls.id, poll.id))
      .run();
    logger.warn({ pollId: poll.id, attempts }, 'Poll delete: gave up');
    notifyPoll(db, logger, poll, {
      event: 'poll.delete_failed',
      reason,
      attempts,
      error: err.message,
    });
    return;
  }
  db.update(polls)
    .set({
      deleteAt: new Date(Date.now() + DELETE_RETRY_MS[attempts - 1]),
      deleteReason: reason,
      deleteAttempts: attempts,
    })
    .where(eq(polls.id, poll.id))
    .run();
  logger.warn(
    { pollId: poll.id, attempts, err: err.message },
    'Poll delete failed, will retry',
  );
}

/** Delete now; if that fails, the sweeper retries. Returns true if it was deleted now. */
export async function deleteReliably(
  sock: WASocket,
  db: Database,
  logger: Logger,
  poll: PollRow,
  reason: 'voted' | 'expired',
): Promise<boolean> {
  try {
    await deletePoll(sock, db, poll);
    return true;
  } catch (err) {
    retryLater(db, logger, poll, reason, err as Error);
    return false;
  }
}

/**
 * Which socket should delete this poll: the sending number's while it is still linked here or
 * on a sibling, otherwise any connected number of the tenant (that one can only delete as a
 * group admin; deletePoll checks). null = wait: the one that should do it is offline.
 */
function sockToDelete(
  db: Database,
  own: WASocket,
  poll: PollRow,
): WASocket | null {
  const candidates = [own, ...siblingsOf(db).map((s) => s.getSocket())].filter(
    (s): s is WASocket => !!s,
  );
  const sender = candidates.find((s) => sentByThisNumber(s, poll));
  if (sender) return isOpen(sender) ? sender : null;
  return candidates.find((s) => !!s.user && isOpen(s)) ?? null;
}

/**
 * Delete what is due: polls past their deleteAt that nobody voted on, and failed deletes
 * whose retry time has come. Each success is reported as poll.deleted.
 */
export async function sweepPolls(
  db: Database,
  now = Date.now(),
): Promise<void> {
  const tenant = tenants.get(db);
  if (!tenant) return;
  const due = db
    .select()
    .from(polls)
    .where(
      and(
        isNull(polls.deletedAt),
        isNull(polls.deleteFailedAt),
        lte(polls.deleteAt, new Date(now)),
      ),
    )
    .all();
  for (const poll of due) {
    if (poll.deleteReason === 'expired' && poll.votedAt) {
      // Someone answered: deleteAt only removes unanswered polls
      db.update(polls)
        .set({ deleteAt: null, deleteReason: null })
        .where(eq(polls.id, poll.id))
        .run();
      continue;
    }
    const reason = poll.deleteReason === 'expired' ? 'expired' : 'voted';
    const sock = sockToDelete(db, tenant.sock, poll);
    if (!sock) continue; // wait for the connection; not counted as a failure
    try {
      await deletePoll(sock, db, poll);
      notifyPoll(db, tenant.logger, getPoll(db, poll.id) ?? poll, {
        event: 'poll.deleted',
        reason,
        attempts: poll.deleteAttempts + 1,
      });
    } catch (err) {
      retryLater(db, tenant.logger, poll, reason, err as Error);
    }
  }
}
