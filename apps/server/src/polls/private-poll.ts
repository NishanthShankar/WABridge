import type { polls } from '../db/schema.js';

type PollRow = typeof polls.$inferSelect;

/**
 * A poll sent by a private request lives only in memory. An extension can add fields to what
 * the client is told when such a poll has been sent: the response of POST /api/reply, and
 * the message.status "sent" webhook of a queued poll.
 */
export type PrivatePollFields = (
  poll: PollRow,
) => Record<string, unknown> | null | undefined;

const sources: PrivatePollFields[] = [];

export function registerPrivatePollFields(source: PrivatePollFields): void {
  if (!sources.includes(source)) sources.push(source);
}

/** For tests. */
export function clearPrivatePollFields(): void {
  sources.length = 0;
}

/** Every extension's fields for this poll. One that fails adds nothing. */
export function privatePollFields(poll: PollRow): Record<string, unknown> {
  let fields: Record<string, unknown> = {};
  for (const source of sources) {
    try {
      fields = { ...fields, ...(source(poll) ?? {}) };
    } catch {
      // The poll was sent all the same
    }
  }
  return fields;
}
