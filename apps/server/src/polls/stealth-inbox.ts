import { randomUUID } from 'node:crypto';

/**
 * Votes on stealth polls. Their answers are never written to the database or the logs: each
 * poll.vote payload is held here, in memory only, until the client acknowledges it. A webhook
 * that answers 2xx acknowledges it; otherwise the client fetches it with GET
 * /api/polls/pending and acknowledges with POST /api/polls/pending/ack.
 * Anything not acknowledged is dropped after HOLD_MS, and everything here is gone on restart.
 */
export const HOLD_MS = 60 * 60 * 1000;

/**
 * Symbol key on a payload: what to do when it is acknowledged or expires. Symbol keys are
 * left out of JSON, so they never reach a webhook or an API response.
 */
export const AFTER_ACK = Symbol('afterAck');

export interface AckHandlers {
  onAck?: () => Promise<void> | void;
  onExpire?: () => void;
}

type Payload = Record<string | symbol, unknown>;

interface Held {
  payload: Payload;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  handlers?: AckHandlers;
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

function expire(owner: object, voteId: string): void {
  const box = inboxFor(owner);
  const held = box.get(voteId);
  if (!held) return;
  clearTimeout(held.timer);
  box.delete(voteId);
  try {
    held.handlers?.onExpire?.();
  } catch {
    // releasing a lock must not break the caller
  }
}

/** Hold a stealth vote until acknowledged. Adds voteId and expiresAt to the payload. */
export function holdVote(
  owner: object,
  payload: Payload,
  holdMs = HOLD_MS,
): Payload {
  const box = inboxFor(owner);
  const voteId = randomUUID();
  const expiresAt = Date.now() + holdMs;
  const handlers = payload[AFTER_ACK] as AckHandlers | undefined;
  const held: Payload = {
    ...payload,
    voteId,
    expiresAt: new Date(expiresAt).toISOString(),
  };
  delete held[AFTER_ACK];
  const timer = setTimeout(() => expire(owner, voteId), holdMs);
  timer.unref?.();
  box.set(voteId, { payload: held, expiresAt, timer, handlers });
  return held;
}

/** Forget a held vote and run its onAck. Returns false if it was already gone. */
export function ackVote(owner: object, voteId: string): boolean {
  const box = inboxFor(owner);
  const held = box.get(voteId);
  if (!held) return false;
  clearTimeout(held.timer);
  box.delete(voteId);
  if (held.handlers?.onAck)
    void Promise.resolve()
      .then(() => held.handlers?.onAck?.())
      .catch(() => {});
  return true;
}

/** Held votes, oldest first, optionally for one poll. */
export function pendingVotes(owner: object, pollId?: string): Payload[] {
  const now = Date.now();
  const out: Payload[] = [];
  for (const [id, h] of inboxFor(owner)) {
    if (h.expiresAt <= now) {
      expire(owner, id);
      continue;
    }
    if (!pollId || h.payload.pollId === pollId) out.push(h.payload);
  }
  return out;
}
