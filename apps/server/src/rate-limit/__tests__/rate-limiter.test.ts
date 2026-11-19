import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';
import { configSchema } from '../../config/schema.js';
import { createDatabase } from '../../db/client.js';
import { scheduledMessages } from '../../db/schema.js';
import { createRateLimiter } from '../rate-limiter.js';

function setup(dailyCap: number) {
  const db = createDatabase(':memory:');
  migrate(db, { migrationsFolder: resolve(__dirname, '../../../drizzle') });
  const config = configSchema.parse({ rate_limit: { daily_cap: dailyCap } });
  const events: Array<{ type?: string }> = [];
  const limiter = createRateLimiter(db, config, (m) => events.push(m));
  let n = 0;
  const add = (status: string, sentAt: Date | null) =>
    db
      .insert(scheduledMessages)
      .values({
        id: `m${++n}`,
        content: 'x',
        scheduledAt: new Date(),
        status,
        sentAt,
      })
      .run();
  return { limiter, add, events };
}

describe('daily cap', () => {
  it('counts messages sent today, and only those', () => {
    const t = setup(5);
    const now = new Date();
    t.add('sent', now);
    t.add('delivered', now);
    t.add('failed', now);
    t.add('pending', null);
    t.add('sent', new Date(now.getTime() - 2 * 86_400_000)); // two days ago
    expect(t.limiter.getSentTodayCount()).toBe(2);
    expect(t.limiter.canSend()).toMatchObject({ allowed: true, remaining: 3 });
  });

  it('refuses once the cap is reached, and says so', () => {
    const t = setup(2);
    t.add('sent', new Date());
    t.add('sent', new Date());
    expect(t.limiter.canSend()).toMatchObject({
      allowed: false,
      remaining: 0,
      sentToday: 2,
      dailyCap: 2,
    });
    t.limiter.checkAndWarn();
    expect(t.events.map((e) => e.type)).toEqual(['rate-limit:reached']);
  });
});
