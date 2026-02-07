import { eq, like, desc, sql, and } from 'drizzle-orm';
import { contacts, contactLabels, labels } from '../db/schema.js';
import { normalizeIndianPhone } from './phone.js';
import type { createDatabase } from '../db/client.js';

type Database = ReturnType<typeof createDatabase>;

// Column alias mapping for flexible CSV/Excel import
const PHONE_ALIASES = ['phone', 'phone number', 'mobile', 'mobile no', 'mobile number', 'contact', 'whatsapp', 'number'];
const NAME_ALIASES = ['name', 'contact name', 'full name', 'customer name', 'customer'];
const EMAIL_ALIASES = ['email', 'email address', 'e-mail'];
const NOTES_ALIASES = ['notes', 'note', 'remarks', 'comment', 'comments'];

function findColumn(headers: string[], aliases: string[]): string | undefined {
  const normalized = headers.map((h) => h.toLowerCase().trim());
  for (const alias of aliases) {
    const idx = normalized.indexOf(alias);
    if (idx >= 0) return headers[idx];
  }
  return undefined;
}

/**
 * Create a contacts service with CRUD and import operations.
 * Uses factory pattern -- takes the Drizzle db instance.
 */
export function createContactsService(db: Database) {
  return {
    /**
     * Create or upsert a contact. If phone already exists, updates name/email/notes.
     * If birthday is provided, returns it for the caller to sync birthday reminder.
     */
    create(data: {
      phone: string;
      name?: string;
      email?: string;
      notes?: string;
      birthday?: string;
      birthdayReminderEnabled?: boolean;
    }) {
      const phone = normalizeIndianPhone(data.phone);
      const id = crypto.randomUUID();

      const contact = db
        .insert(contacts)
        .values({
          id,
          phone,
          name: data.name ?? null,
          email: data.email ?? null,
          notes: data.notes ?? null,
          birthday: data.birthday ?? null,
          birthdayReminderEnabled: data.birthdayReminderEnabled ?? true,
        })
        .onConflictDoUpdate({
          target: contacts.phone,
          set: {
            name: data.name ?? null,
            email: data.email ?? null,
            notes: data.notes ?? null,
            birthday: data.birthday ?? null,
            birthdayReminderEnabled: data.birthdayReminderEnabled ?? true,
            updatedAt: new Date(),
          },
        })
        .returning()
        .get();

      return contact;
    },

    /**
     * List contacts with pagination, optional search (by name), and optional label filter.
     */
    list(opts: { page: number; limit: number; search?: string; label?: string }) {
      const offset = (opts.page - 1) * opts.limit;

      if (opts.label) {
        // Filter by label: join through junction table
        const conditions = [eq(labels.name, opts.label)];
        if (opts.search) {
          conditions.push(like(contacts.name, `%${opts.search}%`));
        }

        const data = db
          .select({
            id: contacts.id,
            phone: contacts.phone,
            name: contacts.name,
            email: contacts.email,
            notes: contacts.notes,
            customFields: contacts.customFields,
            createdAt: contacts.createdAt,
            updatedAt: contacts.updatedAt,
          })
          .from(contacts)
          .innerJoin(contactLabels, eq(contacts.id, contactLabels.contactId))
          .innerJoin(labels, eq(contactLabels.labelId, labels.id))
          .where(and(...conditions))
          .orderBy(desc(contacts.createdAt))
          .limit(opts.limit)
          .offset(offset)
          .all();

        const totalResult = db
          .select({ count: sql<number>`count(*)` })
          .from(contacts)
          .innerJoin(contactLabels, eq(contacts.id, contactLabels.contactId))
          .innerJoin(labels, eq(contactLabels.labelId, labels.id))
          .where(and(...conditions))
          .get();

        return { data, page: opts.page, limit: opts.limit, total: totalResult?.count ?? 0 };
      }

      // Standard listing with optional search
      const where = opts.search ? like(contacts.name, `%${opts.search}%`) : undefined;

      const data = db
        .select()
        .from(contacts)
        .where(where)
        .orderBy(desc(contacts.createdAt))
        .limit(opts.limit)
        .offset(offset)
        .all();

      const totalResult = db
        .select({ count: sql<number>`count(*)` })
        .from(contacts)
        .where(where)
        .get();

      return { data, page: opts.page, limit: opts.limit, total: totalResult?.count ?? 0 };
    },

    /**
     * Get a single contact by ID, including associated labels.
     * Uses .sync() because db.query relational API returns a query builder
     * that must be explicitly executed with better-sqlite3 (synchronous driver).
     */
    getById(id: string) {
      const contact = db.query.contacts.findFirst({
        where: eq(contacts.id, id),
        with: {
          contactLabels: {
            with: {
              label: true,
            },
          },
        },
      }).sync();

      return contact ?? null;
    },

    /**
     * Update a contact by ID. Returns the updated contact or null if not found.
     * If birthday or birthdayReminderEnabled changed, returns the contact
     * for the caller to sync birthday reminder.
     */
    update(id: string, data: {
      phone?: string;
      name?: string;
      email?: string;
      notes?: string;
      birthday?: string | null;
      birthdayReminderEnabled?: boolean;
    }) {
      if (data.phone) {
        data.phone = normalizeIndianPhone(data.phone);
      }

      const contact = db
        .update(contacts)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(contacts.id, id))
        .returning()
        .get();

      return contact ?? null;
    },

    /**
     * Delete a contact by ID. Returns the deleted contact or null if not found.
     * Cascade deletes clean up contact_labels automatically.
     */
    delete(id: string) {
      const deleted = db
        .delete(contacts)
        .where(eq(contacts.id, id))
        .returning()
        .get();

      return deleted ?? null;
    },

    /**
     * Import contacts from parsed CSV/Excel rows.
     * Uses column alias mapping for flexible header names.
     * Upserts on phone (duplicate phones update existing contacts).
     * Wraps entire import in a single transaction for performance.
     */
    importContacts(rows: Record<string, string>[]) {
      if (rows.length === 0) {
        return { imported: 0, skipped: 0, errors: [] as string[] };
      }

      // Determine column mapping from first row's keys
      const headers = Object.keys(rows[0]);
      const phoneCol = findColumn(headers, PHONE_ALIASES);
      const nameCol = findColumn(headers, NAME_ALIASES);
      const emailCol = findColumn(headers, EMAIL_ALIASES);
      const notesCol = findColumn(headers, NOTES_ALIASES);

      if (!phoneCol) {
        return {
          imported: 0,
          skipped: rows.length,
          errors: [`No phone column found. Expected one of: ${PHONE_ALIASES.join(', ')}`],
        };
      }

      // Determine which columns are "known" (mapped) vs extra (custom)
      const knownCols = new Set(
        [phoneCol, nameCol, emailCol, notesCol].filter(Boolean) as string[],
      );
      const extraCols = headers.filter((h) => !knownCols.has(h));

      let imported = 0;
      let skipped = 0;
      const errors: string[] = [];

      db.transaction((tx) => {
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const rawPhone = row[phoneCol]?.trim();

          if (!rawPhone) {
            skipped++;
            errors.push(`Row ${i + 1}: empty phone number`);
            continue;
          }

          let phone: string;
          try {
            phone = normalizeIndianPhone(rawPhone);
          } catch (err) {
            skipped++;
            errors.push(`Row ${i + 1}: ${(err as Error).message}`);
            continue;
          }

          const name = nameCol ? row[nameCol]?.trim() || null : null;
          const email = emailCol ? row[emailCol]?.trim() || null : null;
          const notes = notesCol ? row[notesCol]?.trim() || null : null;

          // Collect extra columns into customFields JSON
          let customFields: string | null = null;
          if (extraCols.length > 0) {
            const extra: Record<string, string> = {};
            for (const col of extraCols) {
              const val = row[col]?.trim();
              if (val) extra[col] = val;
            }
            if (Object.keys(extra).length > 0) {
              customFields = JSON.stringify(extra);
            }
          }

          const id = crypto.randomUUID();

          tx.insert(contacts)
            .values({ id, phone, name, email, notes, customFields })
            .onConflictDoUpdate({
              target: contacts.phone,
              set: {
                name,
                email,
                notes,
                customFields,
                updatedAt: new Date(),
              },
            })
            .run();

          imported++;
        }
      });

      return { imported, skipped, errors };
    },
  };
}
