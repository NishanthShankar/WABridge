import { createHash, randomBytes } from 'node:crypto';
import type makeWASocket from '@whiskeysockets/baileys';
import { decryptPollVote, type proto } from '@whiskeysockets/baileys';
import { and, desc, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { createDatabase } from '../db/client.js';
import { pollVotes, polls } from '../db/schema.js';
import { jidToPhone, ownJids } from '../webhooks/jid.js';
import { currentSock, deleteReliably, notifyPoll } from './poll-jobs.js';
import { AFTER_ACK } from './stealth-inbox.js';

type Database = ReturnType<typeof createDatabase>;
type WASocket = ReturnType<typeof makeWASocket>;

export const POLL_MODES = [
  'updateEveryTime',
  'lockFirstVote',
  'deleteAfterVote',
] as const;
export type PollMode = (typeof POLL_MODES)[number];

/** What POST /api/reply accepts under `poll`. */
export interface PollInput {
  name: string;
  options: string[];
  multiple?: boolean;
  mode?: PollMode;
  /** Emoji for the reaction after a counted vote, or false for none. Default 👍. Not used by deleteAfterVote. */
  react?: string | false;
  /** Text sent after a counted vote, or false for none. {{option}} and {{poll}} are filled in. */
  confirmText?: string | false;
  /** Privacy: never store what anyone voted. See stealth-inbox.ts. */
  stealth?: boolean;
  /** The client's own id, echoed in poll.vote and accepted by GET /api/polls?ref= */
  ref?: string;
  /** ISO time: delete the poll for everyone then if nobody has voted. At most 48 hours away. */
  deleteAt?: string;
}

/** WhatsApp only deletes for everyone for about two days; stay inside it. */
export const MAX_DELETE_AT_MS = 48 * 60 * 60 * 1000;

export const DEFAULT_REACTION = '👍';
export const DEFAULT_DELETE_CONFIRM = 'You chose {{option}}';

/** What a stored poll will do when a vote comes in. */
export function pollBehaviour(input: PollInput): {
  mode: PollMode;
  react: string | null;
  confirmText: string | null;
} {
  const mode = input.mode ?? 'updateEveryTime';
  const react =
    mode === 'deleteAfterVote' || input.react === false
      ? null
      : (input.react ?? DEFAULT_REACTION);
  const confirmText =
    input.confirmText === false
      ? null
      : (input.confirmText ??
        (mode === 'deleteAfterVote' ? DEFAULT_DELETE_CONFIRM : null));
  return { mode, react, confirmText };
}

/** Send a poll and remember it, so its votes can be read later. Returns the message id. */
export async function sendPoll(
  sock: WASocket,
  db: Database,
  jid: string,
  input: PollInput,
): Promise<string | null> {
  const secret = randomBytes(32);
  const sent = await sock.sendMessage(jid, {
    poll: {
      name: input.name,
      values: input.options,
      // 1 = pick one; 0 = pick any number
      selectableCount: input.multiple ? 0 : 1,
      messageSecret: secret,
    },
  });
  const id = sent?.key?.id ?? null;
  if (!id) return null;
  const b = pollBehaviour(input);
  const deleteAt = input.deleteAt
    ? new Date(
        Math.min(Date.parse(input.deleteAt), Date.now() + MAX_DELETE_AT_MS),
      )
    : null;
  db.insert(polls)
    .values({
      id,
      chatJid: jid,
      name: input.name,
      options: JSON.stringify(input.options),
      selectableCount: input.multiple ? 0 : 1,
      mode: b.mode,
      react: b.react,
      confirmText: b.confirmText,
      secret: secret.toString('base64'),
      stealth: !!input.stealth,
      ref: input.ref ?? null,
      deleteAt,
      deleteReason: deleteAt ? 'expired' : null,
      createdAt: new Date(),
    })
    .run();
  return id;
}

type PollRow = typeof polls.$inferSelect;
type VoteRow = typeof pollVotes.$inferSelect;

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Turn the option hashes in a decrypted vote back into option names. */
export function optionsFromHashes(
  options: string[],
  hashes: Uint8Array[],
): string[] {
  const byHash = new Map(options.map((o) => [sha256Hex(o), o]));
  const picked: string[] = [];
  for (const h of hashes) {
    const name = byHash.get(Buffer.from(h).toString('hex'));
    if (name) picked.push(name);
  }
  return picked;
}

function normalise(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const [user, server] = jid.split('@');
  return `${user.split(':')[0]}@${server}`;
}

/**
 * Decrypt a vote. The voter's phone signs it with the JIDs it used for us and for itself,
 * which may be phone JIDs or LIDs, so every pairing is tried until one authenticates.
 */
export function decryptVote(
  sock: WASocket,
  poll: PollRow,
  update: proto.Message.IPollUpdateMessage,
  voterJids: Array<string | null | undefined>,
): string[] | null {
  const vote = update.vote;
  if (!vote?.encPayload || !vote.encIv) return null;
  const creators = [...ownJids(sock)];
  const voters = [
    ...new Set(voterJids.map(normalise).filter((j): j is string => !!j)),
  ];
  const key = Buffer.from(poll.secret, 'base64');
  for (const pollCreatorJid of creators) {
    for (const voterJid of voters) {
      try {
        const decoded = decryptPollVote(
          { encPayload: vote.encPayload, encIv: vote.encIv },
          { pollCreatorJid, pollMsgId: poll.id, pollEncKey: key, voterJid },
        );
        return optionsFromHashes(
          JSON.parse(poll.options) as string[],
          (decoded.selectedOptions ?? []) as Uint8Array[],
        );
      } catch {
        // wrong pairing: GCM authentication fails, try the next one
      }
    }
  }
  return null;
}

export function getPoll(db: Database, id: string): PollRow | undefined {
  return db.select().from(polls).where(eq(polls.id, id)).get();
}

export function votesFor(db: Database, pollId: string): VoteRow[] {
  return db
    .select()
    .from(pollVotes)
    .where(eq(pollVotes.pollId, pollId))
    .orderBy(pollVotes.at, pollVotes.id)
    .all();
}

/**
 * Decide whether a vote counts under the poll's mode.
 * updateEveryTime: every vote counts (an empty one means they removed their vote).
 * lockFirstVote / deleteAfterVote: only the voter's first non-empty vote counts.
 */
export function judgeVote(
  poll: Pick<PollRow, 'mode' | 'deletedAt'>,
  selected: string[],
  earlier: Array<Pick<VoteRow, 'counted' | 'selected' | 'note'>>,
): { counted: boolean; note: string | null; first: boolean } {
  if (poll.deletedAt)
    return { counted: false, note: 'poll_deleted', first: false };
  const hadCounted = earlier.some(
    (v) =>
      v.counted &&
      v.note !== 'settling' &&
      (v.note === 'hidden' ||
        v.note === 'awaiting_ack' ||
        (JSON.parse(v.selected) as string[]).length > 0),
  );
  if (poll.mode === 'updateEveryTime')
    return { counted: true, note: null, first: !hadCounted };
  if (hadCounted) return { counted: false, note: 'locked', first: false };
  if (selected.length === 0)
    return { counted: false, note: 'empty', first: false };
  return { counted: true, note: null, first: true };
}

export function fillConfirm(
  text: string,
  poll: Pick<PollRow, 'name'>,
  selected: string[],
): string {
  return text
    .replaceAll('{{option}}', selected.join(', ') || 'nothing')
    .replaceAll('{{poll}}', poll.name);
}

/** Delete a poll for everyone in the chat and mark it deleted. */
export async function deletePoll(
  sock: WASocket,
  db: Database,
  poll: PollRow,
): Promise<void> {
  await sock.sendMessage(poll.chatJid, {
    delete: { remoteJid: poll.chatJid, id: poll.id, fromMe: true },
  });
  db.update(polls)
    .set({ deletedAt: new Date(), deleteAt: null })
    .where(eq(polls.id, poll.id))
    .run();
}

function lifecycle(poll: PollRow) {
  return {
    ref: poll.ref,
    votedAt: poll.votedAt?.toISOString() ?? null,
    deleteAt: poll.deleteAt?.toISOString() ?? null,
    deleteFailedAt: poll.deleteFailedAt?.toISOString() ?? null,
  };
}

/** Each voter's latest counted choice, and a tally per option. */
export function summarisePoll(poll: PollRow, votes: VoteRow[]) {
  const options = JSON.parse(poll.options) as string[];
  if (poll.stealth) {
    // Answers were never stored. Only how many people voted, in lock modes.
    return {
      id: poll.id,
      chatId: poll.chatJid,
      name: poll.name,
      options,
      multiple: poll.selectableCount === 0,
      mode: poll.mode,
      react: poll.react,
      confirmText: poll.confirmText,
      ...lifecycle(poll),
      stealth: true,
      createdAt: poll.createdAt.toISOString(),
      deletedAt: poll.deletedAt?.toISOString() ?? null,
      results: null,
      votes: [],
    };
  }
  const latest = new Map<string, VoteRow>();
  for (const v of votes) if (v.counted) latest.set(v.voterJid, v);
  const tally: Record<string, number> = Object.fromEntries(
    options.map((o) => [o, 0]),
  );
  const voters = [...latest.values()]
    .map((v) => ({
      voter: v.voterJid,
      phone: v.voterPhone,
      selected: JSON.parse(v.selected) as string[],
      at: v.at.toISOString(),
    }))
    .filter((v) => v.selected.length > 0);
  for (const v of voters)
    for (const o of v.selected) tally[o] = (tally[o] ?? 0) + 1;
  return {
    id: poll.id,
    chatId: poll.chatJid,
    name: poll.name,
    options,
    multiple: poll.selectableCount === 0,
    mode: poll.mode,
    react: poll.react,
    confirmText: poll.confirmText,
    ...lifecycle(poll),
    stealth: false,
    createdAt: poll.createdAt.toISOString(),
    deletedAt: poll.deletedAt?.toISOString() ?? null,
    results: { tally, voters },
    votes: votes.map((v) => ({
      voter: v.voterJid,
      phone: v.voterPhone,
      selected: JSON.parse(v.selected) as string[],
      counted: v.counted,
      note: v.note,
      at: v.at.toISOString(),
    })),
  };
}

export function listPolls(
  db: Database,
  opts: { chatJid?: string; ref?: string; limit: number },
): PollRow[] {
  const where = [
    opts.chatJid ? eq(polls.chatJid, opts.chatJid) : undefined,
    opts.ref ? eq(polls.ref, opts.ref) : undefined,
  ].filter((w) => w !== undefined);
  return db
    .select()
    .from(polls)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(polls.createdAt))
    .limit(opts.limit)
    .all();
}

/**
 * Multi-choice polls send a new vote on every tap. In lockFirstVote and deleteAfterVote the
 * choice is final only once the voter has stopped changing it for this long.
 */
export const SETTLE_MS = 15_000;
const settling = new Map<string, ReturnType<typeof setTimeout>>();

/** React and send confirmText, as the poll says, after a vote that counts. */
async function acknowledgeInChat(
  sock: WASocket,
  logger: Logger,
  poll: PollRow,
  selected: string[],
): Promise<void> {
  const pollKey = { remoteJid: poll.chatJid, id: poll.id, fromMe: true };
  try {
    if (poll.react) {
      await sock.sendMessage(poll.chatJid, {
        react: { text: selected.length ? poll.react : '', key: pollKey },
      });
    }
    if (poll.confirmText && selected.length) {
      await sock.sendMessage(poll.chatJid, {
        text: fillConfirm(poll.confirmText, poll, selected),
      });
    }
  } catch (err) {
    logger.warn(
      { pollId: poll.id, err: (err as Error).message },
      'Poll vote: response failed',
    );
  }
}

/** React, confirm and (deleteAfterVote) delete. Returns true if the poll was deleted now. */
async function respond(
  sock: WASocket,
  db: Database,
  logger: Logger,
  poll: PollRow,
  selected: string[],
): Promise<boolean> {
  await acknowledgeInChat(sock, logger, poll, selected);
  if (poll.mode !== 'deleteAfterVote') return false;
  // A failed delete is retried by the poll sweeper (poll-jobs.ts)
  return deleteReliably(sock, db, logger, poll, 'voted');
}

function votePayload(
  db: Database,
  poll: PollRow,
  voter: string,
  voterPhone: string | null,
  selected: string[],
  verdict: { counted: boolean; note: string | null },
  deleted: boolean,
) {
  const mine = poll.stealth
    ? undefined
    : votesFor(db, poll.id)
        .filter((v) => v.voterJid === voter && v.counted)
        .at(-1);
  // A stealth poll keeps no answers, so "current" is only known when this vote is the final one.
  const current = poll.stealth
    ? verdict.counted && !verdict.note
      ? selected
      : null
    : mine
      ? (JSON.parse(mine.selected) as string[])
      : [];
  return {
    event: 'poll.vote',
    pollId: poll.id,
    pollName: poll.name,
    ref: poll.ref,
    mode: poll.mode,
    multiple: poll.selectableCount === 0,
    voterPhone: voterPhone ?? jidToPhone(voter),
    selected,
    counted: verdict.counted,
    /** null: final | settling: multi-choice, waiting for them to stop tapping | locked | poll_deleted | empty | superseded */
    note: verdict.note,
    /** What counts for this voter now (their latest counted vote) */
    current,
    pollDeleted: deleted || !!getPoll(db, poll.id)?.deletedAt,
    stealth: poll.stealth,
  } as Record<string | symbol, unknown>;
}

function markVoted(db: Database, pollId: string): void {
  db.update(polls)
    .set({ votedAt: new Date() })
    .where(eq(polls.id, pollId))
    .run();
}

/**
 * A vote that counts and is final: record it, respond, and build the payload.
 * Stealth deleteAfterVote holds the response (confirmText and delete) until the client
 * acknowledges the vote; if it never does, the lock is released so the person can vote again.
 */
async function finalVote(
  sock: WASocket,
  db: Database,
  logger: Logger,
  poll: PollRow,
  voter: string,
  voterPhone: string | null,
  selected: string[],
  settlingRowId: number | null,
): Promise<Record<string | symbol, unknown>> {
  if (selected.length) markVoted(db, poll.id);
  const verdict = { counted: true, note: null };
  if (!poll.stealth) {
    if (settlingRowId !== null)
      db.update(pollVotes)
        .set({ note: null })
        .where(eq(pollVotes.id, settlingRowId))
        .run();
    else
      db.insert(pollVotes)
        .values({
          pollId: poll.id,
          voterJid: voter,
          voterPhone,
          selected: JSON.stringify(selected),
          counted: true,
          note: null,
          at: new Date(),
        })
        .run();
    const deleted = await respond(sock, db, logger, poll, selected);
    return votePayload(db, poll, voter, voterPhone, selected, verdict, deleted);
  }
  if (poll.mode !== 'deleteAfterVote') {
    recordHidden(db, poll, voter, voterPhone, 'hidden');
    const deleted = await respond(sock, db, logger, poll, selected);
    return votePayload(db, poll, voter, voterPhone, selected, verdict, deleted);
  }
  const rowId = recordHidden(db, poll, voter, voterPhone, 'awaiting_ack');
  const payload = votePayload(
    db,
    poll,
    voter,
    voterPhone,
    selected,
    verdict,
    false,
  );
  payload.awaitingAck = true;
  payload[AFTER_ACK] = {
    onAck: async () => {
      db.update(pollVotes)
        .set({ note: 'hidden' })
        .where(eq(pollVotes.id, rowId as number))
        .run();
      const fresh = getPoll(db, poll.id);
      if (!fresh || fresh.deletedAt) return;
      const live = currentSock(db) ?? sock;
      await acknowledgeInChat(live, logger, fresh, selected);
      if (await deleteReliably(live, db, logger, fresh, 'voted'))
        notifyPoll(db, logger, getPoll(db, poll.id) ?? fresh, {
          event: 'poll.deleted',
          reason: 'voted',
        });
    },
    onExpire: () => releaseVote(db, poll.id, rowId as number),
  };
  return payload;
}

/** Forget an unacknowledged stealth vote, so the person can vote again. */
export function releaseVote(db: Database, pollId: string, rowId: number): void {
  db.delete(pollVotes)
    .where(and(eq(pollVotes.id, rowId), eq(pollVotes.note, 'awaiting_ack')))
    .run();
  const stillCounted = votesFor(db, pollId).some((v) => v.counted);
  if (!stillCounted)
    db.update(polls).set({ votedAt: null }).where(eq(polls.id, pollId)).run();
}

/**
 * Handle an incoming poll vote: decrypt it, record it, respond as the poll's mode says
 * (reaction, confirmation text, delete), and return the webhook payload fields.
 * Returns null for votes on polls this bridge didn't send (or can't decrypt).
 * onSettled gets a second payload when a multi-choice vote becomes final later.
 * A payload with an AFTER_ACK entry must be held until the client acknowledges it.
 */
export async function handlePollVote(params: {
  sock: WASocket;
  db: Database;
  logger: Logger;
  update: proto.Message.IPollUpdateMessage;
  voterJid: string;
  voterAltJid?: string | null;
  voterPhone: string | null;
  onSettled?: (payload: Record<string | symbol, unknown>) => void;
  settleMs?: number;
}): Promise<Record<string | symbol, unknown> | null> {
  const { sock, db, logger, update, voterJid, voterAltJid, voterPhone } =
    params;
  const pollId = update.pollCreationMessageKey?.id;
  if (!pollId) return null;
  const poll = getPoll(db, pollId);
  if (!poll) return null;

  const selected = decryptVote(sock, poll, update, [voterJid, voterAltJid]);
  if (!selected) {
    logger.warn({ pollId }, 'Poll vote could not be decrypted');
    return null;
  }

  const voter = normalise(voterJid) ?? voterJid;
  const earlier = votesFor(db, pollId).filter((v) => v.voterJid === voter);
  const verdict = judgeVote(poll, selected, earlier);
  const waits =
    poll.selectableCount === 0 &&
    poll.mode !== 'updateEveryTime' &&
    verdict.note !== 'locked' &&
    verdict.note !== 'poll_deleted';

  if (waits) {
    // Anything still settling is replaced by this tap.
    const key = `${pollId}|${voter}`;
    clearTimeout(settling.get(key));
    settling.delete(key);
    const note = selected.length ? 'settling' : 'empty';
    // Stealth: nothing is written while they tap; the timer below holds the choice in memory.
    const row = poll.stealth
      ? null
      : settleRows(db, pollId, voter, voterPhone, selected, note);
    if (selected.length) {
      settling.set(
        key,
        setTimeout(() => {
          settling.delete(key);
          void (async () => {
            const fresh = getPoll(db, pollId);
            if (!fresh || fresh.deletedAt) return;
            params.onSettled?.(
              await finalVote(
                sock,
                db,
                logger,
                fresh,
                voter,
                voterPhone,
                selected,
                row?.id ?? null,
              ),
            );
          })().catch((err) =>
            logger.warn(
              { pollId, err: (err as Error).message },
              'Poll vote: settle failed',
            ),
          );
        }, params.settleMs ?? SETTLE_MS),
      );
    }
    return votePayload(
      db,
      poll,
      voter,
      voterPhone,
      selected,
      { counted: selected.length > 0, note },
      false,
    );
  }

  if (verdict.counted && !verdict.note)
    return finalVote(sock, db, logger, poll, voter, voterPhone, selected, null);

  if (!poll.stealth) {
    db.insert(pollVotes)
      .values({
        pollId,
        voterJid: voter,
        voterPhone,
        selected: JSON.stringify(selected),
        counted: verdict.counted,
        note: verdict.note,
        at: new Date(),
      })
      .run();
  }
  return votePayload(db, poll, voter, voterPhone, selected, verdict, false);
}

/** Supersede a voter's settling rows and add this tap as the new settling row. */
function settleRows(
  db: Database,
  pollId: string,
  voter: string,
  voterPhone: string | null,
  selected: string[],
  note: string,
): { id: number } {
  db.update(pollVotes)
    .set({ counted: false, note: 'superseded' })
    .where(
      and(
        eq(pollVotes.pollId, pollId),
        eq(pollVotes.voterJid, voter),
        eq(pollVotes.note, 'settling'),
      ),
    )
    .run();
  return db
    .insert(pollVotes)
    .values({
      pollId,
      voterJid: voter,
      voterPhone,
      selected: JSON.stringify(selected),
      counted: selected.length > 0,
      note,
      at: new Date(),
    })
    .returning({ id: pollVotes.id })
    .get();
}

/**
 * A stealth vote that counts: remember that they voted (for locks), never what.
 * Returns the row id, or null when nothing needs keeping (updateEveryTime).
 */
function recordHidden(
  db: Database,
  poll: PollRow,
  voter: string,
  voterPhone: string | null,
  note: 'hidden' | 'awaiting_ack',
): number | null {
  if (poll.mode === 'updateEveryTime') return null; // nothing to lock, so nothing to keep
  return db
    .insert(pollVotes)
    .values({
      pollId: poll.id,
      voterJid: voter,
      voterPhone,
      selected: '[]',
      counted: true,
      note,
      at: new Date(),
    })
    .returning({ id: pollVotes.id })
    .get().id;
}
