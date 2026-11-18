import { createHash, randomBytes } from 'node:crypto';
import type makeWASocket from '@whiskeysockets/baileys';
import { decryptPollVote, type proto } from '@whiskeysockets/baileys';
import { and, desc, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { createDatabase } from '../db/client.js';
import { pollVotes, polls } from '../db/schema.js';
import { jidToPhone, ownJids } from '../webhooks/jid.js';

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
}

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
      (v.note === 'hidden' || (JSON.parse(v.selected) as string[]).length > 0),
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
    .set({ deletedAt: new Date() })
    .where(eq(polls.id, poll.id))
    .run();
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
  opts: { chatJid?: string; limit: number },
): PollRow[] {
  const q = db.select().from(polls);
  return (opts.chatJid ? q.where(and(eq(polls.chatJid, opts.chatJid))) : q)
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

/** React, confirm and delete, as the poll's mode says, after a vote that counts. */
async function respond(
  sock: WASocket,
  db: Database,
  logger: Logger,
  poll: PollRow,
  selected: string[],
): Promise<boolean> {
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
    if (poll.mode === 'deleteAfterVote') {
      await deletePoll(sock, db, poll);
      return true;
    }
  } catch (err) {
    logger.warn(
      { pollId: poll.id, err: (err as Error).message },
      'Poll vote: response failed',
    );
  }
  return false;
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
  };
}

/**
 * Handle an incoming poll vote: decrypt it, record it, respond as the poll's mode says
 * (reaction, confirmation text, delete), and return the webhook payload fields.
 * Returns null for votes on polls this bridge didn't send (or can't decrypt).
 * onSettled gets a second payload when a multi-choice vote becomes final later.
 */
export async function handlePollVote(params: {
  sock: WASocket;
  db: Database;
  logger: Logger;
  update: proto.Message.IPollUpdateMessage;
  voterJid: string;
  voterAltJid?: string | null;
  voterPhone: string | null;
  onSettled?: (payload: Record<string, unknown>) => void;
  settleMs?: number;
}): Promise<Record<string, unknown> | null> {
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
            if (row)
              db.update(pollVotes)
                .set({ note: null })
                .where(eq(pollVotes.id, row.id))
                .run();
            else recordHidden(db, fresh, voter, voterPhone);
            const deleted = await respond(sock, db, logger, fresh, selected);
            params.onSettled?.(
              votePayload(
                db,
                fresh,
                voter,
                voterPhone,
                selected,
                { counted: true, note: null },
                deleted,
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

  if (poll.stealth) {
    if (verdict.counted) recordHidden(db, poll, voter, voterPhone);
  } else {
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

  const deleted = verdict.counted
    ? await respond(sock, db, logger, poll, selected)
    : false;
  return votePayload(db, poll, voter, voterPhone, selected, verdict, deleted);
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

/** A stealth vote that counts: remember that they voted (for locks), never what. */
function recordHidden(
  db: Database,
  poll: PollRow,
  voter: string,
  voterPhone: string | null,
): void {
  if (poll.mode === 'updateEveryTime') return; // nothing to lock, so nothing to keep
  db.insert(pollVotes)
    .values({
      pollId: poll.id,
      voterJid: voter,
      voterPhone,
      selected: '[]',
      counted: true,
      note: 'hidden',
      at: new Date(),
    })
    .run();
}
