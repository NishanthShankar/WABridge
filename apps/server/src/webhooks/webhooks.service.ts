import { eq, or, isNull } from 'drizzle-orm';
import { webhooks } from '../db/schema.js';
import type { createDatabase } from '../db/client.js';

type Database = ReturnType<typeof createDatabase>;

export function createWebhooksService(db: Database) {
  return {
    create(data: { phone?: string; url: string; secret?: string; allEvents?: boolean }) {
      const id = crypto.randomUUID();
      const webhook = db
        .insert(webhooks)
        .values({
          id,
          phone: data.phone ?? null,
          url: data.url,
          secret: data.secret ?? null,
          allEvents: data.allEvents ?? false,
        })
        .returning()
        .get();
      return webhook;
    },

    list() {
      return db.select().from(webhooks).all();
    },

    getById(id: string) {
      return db.select().from(webhooks).where(eq(webhooks.id, id)).get();
    },

    /** Get all enabled webhooks matching a sender phone number or catch-all (phone=null) */
    getByPhone(phone: string) {
      return db
        .select()
        .from(webhooks)
        .where(or(eq(webhooks.phone, phone), isNull(webhooks.phone)))
        .all()
        .filter((w) => w.enabled);
    },

    /** Enabled catch-all webhooks that opted in to group messages and other events. */
    getAllEvents() {
      return db
        .select()
        .from(webhooks)
        .where(isNull(webhooks.phone))
        .all()
        .filter((w) => w.enabled && w.allEvents);
    },

    update(
      id: string,
      data: { phone?: string; url?: string; enabled?: boolean; secret?: string | null; allEvents?: boolean },
    ) {
      const webhook = db
        .update(webhooks)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(webhooks.id, id))
        .returning()
        .get();
      return webhook ?? null;
    },

    delete(id: string) {
      const result = db.delete(webhooks).where(eq(webhooks.id, id)).returning().get();
      return !!result;
    },
  };
}
