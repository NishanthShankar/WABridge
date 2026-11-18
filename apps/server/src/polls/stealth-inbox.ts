import { randomUUID } from 'node:crypto';

/**
 * Votes on stealth polls. Their answers are never written to the database or the logs: each
 * poll.vote payload is held here, in memory only, until the client acknowledges it. A webhook
 * that answers 2xx acknowledges it; otherwise the client fetches it with GET
 * /api/polls/pending and acknowledges with POST /api/polls/pending/ack.
 * Anything not acknowledged is dropped after HOLD_MS, and everything here is gone on restart.
 */
export const HOLD_MS = 60 * 60 * 1000;

interface Held {
  payload: Record<string, unknown>;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

/** One inbox per tenant, keyed by the tenant's database handle. */
const inboxes = new WeakMap<object, Map<string, Held>>();

function inboxFor(owner: object): Map<string, Held> {
  let box = inboxes.get(owner);
  if (!box) {
    box = new Map();
    inboxes.set(owner, box);
  }
  return box;
}

/** Hold a stealth vote until acknowledged. Adds voteId and expiresAt to the payload. */
export function holdVote(
  owner: object,
  payload: Record<string, unknown>,
  holdMs = HOLD_MS,
): Record<string, unknown> {
  const box = inboxFor(owner);
  const voteId = randomUUID();
  const expiresAt = Date.now() + holdMs;
  const held = {
    ...payload,
    voteId,
    expiresAt: new Date(expiresAt).toISOString(),
  };
  const timer = setTimeout(() => box.delete(voteId), holdMs);
  timer.unref?.();
  box.set(voteId, { payload: held, expiresAt, timer });
  return held;
}

/** Forget a held vote. Returns false if it was already gone. */
export function ackVote(owner: object, voteId: string): boolean {
  const box = inboxFor(owner);
  const held = box.get(voteId);
  if (!held) return false;
  clearTimeout(held.timer);
  return box.delete(voteId);
}

/** Held votes, oldest first, optionally for one poll. */
export function pendingVotes(
  owner: object,
  pollId?: string,
): Record<string, unknown>[] {
  const now = Date.now();
  const out: Record<string, unknown>[] = [];
  for (const [id, h] of inboxFor(owner)) {
    if (h.expiresAt <= now) {
      ackVote(owner, id);
      continue;
    }
    if (!pollId || h.payload.pollId === pollId) out.push(h.payload);
  }
  return out;
}
