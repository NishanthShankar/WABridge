import { eq, and, asc } from 'drizzle-orm';
import { labels, contactLabels, contacts } from '../db/schema.js';
import type { createDatabase } from '../db/client.js';

type Database = ReturnType<typeof createDatabase>;

/**
 * Create a labels service with CRUD and assignment operations.
 * Uses factory pattern -- takes the Drizzle db instance.
 */
export function createLabelsService(db: Database) {
  return {
    /**
     * Create a new label. Returns the label or null if name already exists.
     */
    create(data: { name: string; color?: string }) {
      const id = crypto.randomUUID();

      try {
        const label = db
          .insert(labels)
          .values({
            id,
            name: data.name,
            color: data.color ?? null,
          })
          .returning()
          .get();

        return { label, conflict: false };
      } catch (err) {
        // SQLite unique constraint error
        if ((err as Error).message?.includes('UNIQUE constraint failed')) {
          return { label: null, conflict: true };
        }
        throw err;
      }
    },

    /**
     * List all labels ordered by name.
     */
    list() {
      const data = db
        .select()
        .from(labels)
        .orderBy(asc(labels.name))
        .all();

      return { data };
    },

    /**
     * Update a label by ID. Returns the updated label or null if not found.
     */
    update(id: string, data: { name?: string; color?: string | null }) {
      const label = db
        .update(labels)
        .set(data)
        .where(eq(labels.id, id))
        .returning()
        .get();

      return label ?? null;
    },

    /**
     * Delete a label by ID. Cascade removes contact_labels entries.
     * Returns the deleted label or null if not found.
     */
    delete(id: string) {
      const deleted = db
        .delete(labels)
        .where(eq(labels.id, id))
        .returning()
        .get();

      return deleted ?? null;
    },

    /**
     * Assign labels to a contact. Uses onConflictDoNothing so assigning
     * the same label twice is a no-op. Validates contact exists first.
     * Returns the count of newly assigned labels.
     */
    assignToContact(contactId: string, labelIds: string[]) {
      // Check contact exists
      const contact = db
        .select({ id: contacts.id })
        .from(contacts)
        .where(eq(contacts.id, contactId))
        .get();

      if (!contact) {
        return { assigned: 0, contactNotFound: true };
      }

      // Validate which labelIds actually exist
      const existingLabels = db
        .select({ id: labels.id })
        .from(labels)
        .all();
      const existingLabelIds = new Set(existingLabels.map((l) => l.id));
      const validLabelIds = labelIds.filter((id) => existingLabelIds.has(id));

      if (validLabelIds.length === 0) {
        return { assigned: 0, contactNotFound: false };
      }

      db.transaction((tx) => {
        for (const labelId of validLabelIds) {
          tx.insert(contactLabels)
            .values({ contactId, labelId })
            .onConflictDoNothing()
            .run();
        }
      });

      return { assigned: validLabelIds.length, contactNotFound: false };
    },

    /**
     * Remove a label from a contact.
     * Returns whether the association was found and removed.
     */
    removeFromContact(contactId: string, labelId: string) {
      const result = db
        .delete(contactLabels)
        .where(
          and(
            eq(contactLabels.contactId, contactId),
            eq(contactLabels.labelId, labelId),
          ),
        )
        .returning()
        .get();

      return result ? true : false;
    },

    /**
     * Get all labels for a contact via join query.
     */
    getContactLabels(contactId: string) {
      const rows = db
        .select({
          id: labels.id,
          name: labels.name,
          color: labels.color,
          createdAt: labels.createdAt,
        })
        .from(contactLabels)
        .innerJoin(labels, eq(contactLabels.labelId, labels.id))
        .where(eq(contactLabels.contactId, contactId))
        .orderBy(asc(labels.name))
        .all();

      return rows;
    },
  };
}
