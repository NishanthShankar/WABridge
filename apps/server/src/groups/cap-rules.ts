import type makeWASocket from '@whiskeysockets/baileys';
import type { AppConfig } from '../config/schema.js';
import type { createDatabase } from '../db/client.js';

type Database = ReturnType<typeof createDatabase>;
type WASocket = ReturnType<typeof makeWASocket>;

/**
 * Lets an extension allow more group creations a day for groups it vouches for.
 *
 * groups.create_daily_cap still limits groups in general. A group the rule says qualifies
 * does not count against it: such groups can go on until the day's total reaches the rule's
 * own, higher cap. Without a rule, or when the rule cannot tell, the plain cap applies.
 */
export interface GroupCapRule {
  /** Named in the response's cap.kind for a group that counted against the higher cap */
  kind: string;
  /** The higher cap on the day's total, for this account. Not above the plain cap: not used. */
  cap(config: AppConfig): number;
  /** Whether a group of these members (their JIDs, this account included or not) qualifies */
  qualifies(
    ctx: { db: Database; sock: WASocket },
    memberJids: string[],
  ): boolean | Promise<boolean>;
  /** Added to the 429 when the plain cap is reached: which groups can still be created */
  hint?: string;
}

let rule: GroupCapRule | null = null;

/** One rule at a time: the first extension to register one. */
export function registerGroupCapRule(r: GroupCapRule): void {
  rule ??= r;
}

/** For tests. */
export function clearGroupCapRule(): void {
  rule = null;
}

export function groupCapRule(): GroupCapRule | null {
  return rule;
}
