import type { createDatabase } from '../db/client.js';

type Database = ReturnType<typeof createDatabase>;

/**
 * Chats the server keeps nothing of.
 *
 * An extension can name chats whose messages must never be kept by the server: not in the
 * database, not in the queue, not in the in-memory store of recent messages. For such a chat:
 *
 * - a request that sends into it is handled as a private request, asked for or not
 *   (api/private.ts), and is refused if it would have to store something;
 * - the queue and the poll store refuse to write it to disk (the last line of defence);
 * - its messages are not remembered (messages/recent-messages.ts).
 *
 * If a rule cannot tell (it throws), the chat is treated as one of these: the safe side.
 */
export interface NoStoreRule {
  /** A short name for the rule. Sent as X-Private-Reason when it makes a request private. */
  reason: string;
  /** True when any of these JIDs is a chat nothing may be kept of. */
  applies(db: Database, jids: string[]): boolean;
  /** Request paths the rule leaves alone: the extension's own routes that manage such chats. */
  exemptPath?(path: string): boolean;
  /** The extension's own wording for the refusals. */
  messages?: {
    /** A request that has to store data (409 not_available_private) */
    notPrivate?: string;
    /** The queue was asked to store a message for the chat (409) */
    notStored?: string;
    /** A poll for the chat that is not a private request */
    poll?: string;
  };
}

const rules: NoStoreRule[] = [];

export function registerNoStoreRule(rule: NoStoreRule): void {
  if (!rules.includes(rule)) rules.push(rule);
}

/** For tests: forget every rule. */
export function clearNoStoreRules(): void {
  rules.length = 0;
}

/** The first rule that applies to any of these JIDs, or null. A rule that throws applies. */
export function noStoreRuleFor(
  db: Database,
  jids: Array<string | null | undefined>,
  path?: string,
): NoStoreRule | null {
  const wanted = jids.filter((j): j is string => !!j);
  if (!wanted.length) return null;
  for (const rule of rules) {
    if (path !== undefined && rule.exemptPath?.(path)) continue;
    try {
      if (rule.applies(db, wanted)) return rule;
    } catch {
      return rule;
    }
  }
  return null;
}

/** For listeners (extensions too): leave this chat's messages alone. */
export function isNoStoreChat(
  db: Database,
  ...jids: Array<string | null | undefined>
): boolean {
  return !!noStoreRuleFor(db, jids);
}

/** Whether any rule is registered: lets callers skip work when there is none. */
export function hasNoStoreRules(): boolean {
  return rules.length > 0;
}
