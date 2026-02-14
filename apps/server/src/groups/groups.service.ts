import { eq, sql, like, desc } from 'drizzle-orm';
import { groups } from '../db/schema.js';
import type { createDatabase } from '../db/client.js';
import type makeWASocket from '@whiskeysockets/baileys';

type Database = ReturnType<typeof createDatabase>;
type WASocket = ReturnType<typeof makeWASocket>;

export function createGroupsService(db: Database, getSocket: () => WASocket | null) {
  return {
    /**
     * Fetch all groups from WhatsApp and upsert into the database.
     * Returns the count of synced groups.
     */
    async syncGroups() {
      const sock = getSocket();
      if (!sock) throw new Error('WhatsApp not connected');

      const participating = await sock.groupFetchAllParticipating();
      const now = new Date();
      let count = 0;

      for (const [jid, meta] of Object.entries(participating)) {
        // Skip non-group JIDs
        if (!jid.endsWith('@g.us')) continue;

        const existing = db.select().from(groups).where(eq(groups.id, jid)).get();
        if (existing) {
          db.update(groups)
            .set({
              name: meta.subject ?? existing.name,
              description: meta.desc ?? existing.description,
              participantCount: meta.participants?.length ?? existing.participantCount,
              updatedAt: now,
            })
            .where(eq(groups.id, jid))
            .run();
        } else {
          db.insert(groups)
            .values({
              id: jid,
              name: meta.subject ?? jid,
              description: meta.desc ?? null,
              participantCount: meta.participants?.length ?? null,
              createdAt: now,
              updatedAt: now,
            })
            .run();
        }
        count++;
      }

      return { synced: count };
    },

    /**
     * List groups with optional search and pagination.
     */
    list(filters: { search?: string; limit: number; offset: number }) {
      const where = filters.search
        ? like(groups.name, `%${filters.search}%`)
        : undefined;

      const data = db
        .select()
        .from(groups)
        .where(where)
        .orderBy(desc(groups.updatedAt))
        .limit(filters.limit)
        .offset(filters.offset)
        .all();

      const totalResult = db
        .select({ count: sql<number>`count(*)` })
        .from(groups)
        .where(where)
        .get();

      return {
        data,
        total: totalResult?.count ?? 0,
        limit: filters.limit,
        offset: filters.offset,
      };
    },

    /**
     * Get a single group by ID (JID).
     */
    getById(id: string) {
      return db.select().from(groups).where(eq(groups.id, id)).get() ?? null;
    },
  };
}
