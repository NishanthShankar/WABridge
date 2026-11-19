import { and, gte, inArray, sql } from 'drizzle-orm';
import type { AppConfig } from '../config/schema.js';
import type { createDatabase } from '../db/client.js';
import { peekPrivateDb } from '../db/private.js';
import { scheduledMessages } from '../db/schema.js';

type Database = ReturnType<typeof createDatabase>;

/**
 * Get the start of today in IST (UTC+5:30).
 *
 * IST is a fixed offset timezone (no DST), so this is straightforward:
 * take the current UTC time, add 5:30, truncate to midnight, subtract 5:30 back to UTC.
 */
function getTodayIST(): Date {
  const now = new Date();
  // Current time in IST milliseconds
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istMs = now.getTime() + istOffsetMs;
  // Truncate to midnight IST
  const istMidnight = istMs - (istMs % (24 * 60 * 60 * 1000));
  // Convert back to UTC
  return new Date(istMidnight - istOffsetMs);
}

/**
 * Get the next midnight in IST (UTC+5:30).
 */
function getNextMidnightIST(): Date {
  const todayStart = getTodayIST();
  return new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
}

export interface RateLimitStatus {
  sentToday: number;
  dailyCap: number;
  remaining: number;
  resetAt: string;
  warning: boolean;
}

export interface CanSendResult {
  allowed: boolean;
  remaining: number;
  sentToday: number;
  dailyCap: number;
}

export interface RateLimiter {
  getSentTodayCount(): number;
  canSend(): CanSendResult;
  checkAndWarn(): CanSendResult;
  getStatus(): RateLimitStatus;
}

/**
 * Create a rate limiter that tracks daily message sends using SQLite as the source of truth.
 *
 * The rate limiter:
 * - Counts messages sent today (in IST timezone) with status 'sent' or 'delivered'
 * - Enforces a daily cap (configurable, minimum 1, cannot be disabled)
 * - Broadcasts WebSocket warnings at a configurable threshold (default 80%)
 * - Broadcasts rate-limit:reached when cap is hit
 *
 * IST (UTC+5:30) is used for the daily boundary because this is an India-focused product.
 */
export function createRateLimiter(
  db: Database,
  config: AppConfig,
  broadcast: (message: object) => void,
): RateLimiter {
  const dailyCap = config.rate_limit.daily_cap;
  const warnThresholdPct = config.rate_limit.warn_threshold_pct;
  const warnThreshold = Math.floor((dailyCap * warnThresholdPct) / 100);

  return {
    /**
     * Count messages sent today (IST) with status 'sent' or 'delivered'.
     * Uses SQLite as the source of truth.
     */
    getSentTodayCount(): number {
      const todayStart = getTodayIST();
      // sent_at is stored in seconds. Comparing through the column (gte with a Date) converts
      // correctly; a raw millisecond number here once made this count always 0.
      const count = (from: Database) =>
        from
          .select({ count: sql<number>`count(*)` })
          .from(scheduledMessages)
          .where(
            and(
              gte(scheduledMessages.sentAt, todayStart),
              inArray(scheduledMessages.status, ['sent', 'delivered']),
            ),
          )
          .get()?.count ?? 0;
      // Private sends are the same number's sends: they count toward the same cap. They are
      // kept in memory, so a restart forgets today's.
      const priv = peekPrivateDb(db);
      return count(db) + (priv ? count(priv) : 0);
    },

    /**
     * Check if sending is allowed based on the daily cap.
     */
    canSend(): CanSendResult {
      const sentToday = this.getSentTodayCount();
      const remaining = Math.max(0, dailyCap - sentToday);

      return {
        allowed: sentToday < dailyCap,
        remaining,
        sentToday,
        dailyCap,
      };
    },

    /**
     * Check rate limit and broadcast WebSocket warnings if thresholds are met.
     *
     * Broadcasts:
     * - rate-limit:warning when sentToday >= warnThreshold (e.g., 80% of cap)
     * - rate-limit:reached when sentToday >= dailyCap
     */
    checkAndWarn(): CanSendResult {
      const result = this.canSend();

      if (result.sentToday >= dailyCap) {
        broadcast({
          type: 'rate-limit:reached',
          data: {
            sentToday: result.sentToday,
            cap: dailyCap,
            resetAt: getNextMidnightIST().toISOString(),
          },
        });
      } else if (result.sentToday >= warnThreshold) {
        broadcast({
          type: 'rate-limit:warning',
          data: {
            sentToday: result.sentToday,
            cap: dailyCap,
            remaining: result.remaining,
          },
        });
      }

      return result;
    },

    /**
     * Get the full rate limit status for the API endpoint.
     */
    getStatus(): RateLimitStatus {
      const sentToday = this.getSentTodayCount();
      const remaining = Math.max(0, dailyCap - sentToday);

      return {
        sentToday,
        dailyCap,
        remaining,
        resetAt: getNextMidnightIST().toISOString(),
        warning: sentToday >= warnThreshold,
      };
    },
  };
}
