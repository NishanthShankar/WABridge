import { eq, desc } from 'drizzle-orm';
import { templates, contacts } from '../db/schema.js';
import { extractVariables, resolveTemplate } from './renderer.js';
import type { createDatabase } from '../db/client.js';

type Database = ReturnType<typeof createDatabase>;

/**
 * Create a templates service with CRUD and preview operations.
 * Uses factory pattern -- takes the Drizzle db instance.
 */
export function createTemplatesService(db: Database) {
  return {
    /**
     * Create a new template. Auto-extracts variables from body.
     * Returns the template or null if name already exists (conflict).
     */
    create(data: { name: string; body: string }) {
      const id = crypto.randomUUID();
      const variables = extractVariables(data.body);

      try {
        const row = db
          .insert(templates)
          .values({
            id,
            name: data.name,
            body: data.body,
            variables: JSON.stringify(variables),
          })
          .returning()
          .get();

        const template = { ...row, variables };
        return { template, conflict: false };
      } catch (err) {
        if ((err as Error).message?.includes('UNIQUE constraint failed')) {
          return { template: null, conflict: true };
        }
        throw err;
      }
    },

    /**
     * List all templates ordered by createdAt desc.
     */
    list() {
      const data = db
        .select()
        .from(templates)
        .orderBy(desc(templates.createdAt))
        .all();

      // Parse variables JSON for each template
      const parsed = data.map((t) => ({
        ...t,
        variables: t.variables ? JSON.parse(t.variables) : [],
      }));

      return { data: parsed };
    },

    /**
     * Get a single template by ID.
     */
    getById(id: string) {
      const template = db
        .select()
        .from(templates)
        .where(eq(templates.id, id))
        .get();

      if (!template) return null;

      return {
        ...template,
        variables: template.variables ? JSON.parse(template.variables) : [],
      };
    },

    /**
     * Update a template by ID. If body changes, re-extracts variables.
     */
    update(id: string, data: { name?: string; body?: string }) {
      const updateData: Record<string, unknown> = {
        ...data,
        updatedAt: new Date(),
      };

      // Re-extract variables if body was updated
      if (data.body) {
        updateData.variables = JSON.stringify(extractVariables(data.body));
      }

      try {
        const template = db
          .update(templates)
          .set(updateData)
          .where(eq(templates.id, id))
          .returning()
          .get();

        if (!template) return null;

        return {
          ...template,
          variables: template.variables ? JSON.parse(template.variables as string) : [],
        };
      } catch (err) {
        if ((err as Error).message?.includes('UNIQUE constraint failed')) {
          return { conflict: true as const };
        }
        throw err;
      }
    },

    /**
     * Delete a template by ID. Returns deleted template or null if not found.
     */
    delete(id: string) {
      const deleted = db
        .delete(templates)
        .where(eq(templates.id, id))
        .returning()
        .get();

      return deleted ?? null;
    },

    /**
     * Preview a template resolved against a specific contact's data.
     * Returns the original template body, resolved text, variable list,
     * and any unresolved variables.
     */
    preview(templateId: string, contactId: string) {
      const template = db
        .select()
        .from(templates)
        .where(eq(templates.id, templateId))
        .get();

      if (!template) {
        return { error: 'Template not found' as const };
      }

      const contact = db
        .select()
        .from(contacts)
        .where(eq(contacts.id, contactId))
        .get();

      if (!contact) {
        return { error: 'Contact not found' as const };
      }

      // Build variable map from contact fields + custom fields
      const vars: Record<string, string> = {};
      if (contact.name) vars.name = contact.name;
      if (contact.phone) vars.phone = contact.phone;
      if (contact.email) vars.email = contact.email;
      if (contact.notes) vars.notes = contact.notes;

      // Merge custom fields (e.g., from CSV import)
      if (contact.customFields) {
        try {
          const custom = JSON.parse(contact.customFields);
          for (const [key, value] of Object.entries(custom)) {
            if (typeof value === 'string') {
              vars[key] = value;
            }
          }
        } catch {
          // Ignore malformed customFields JSON
        }
      }

      const resolved = resolveTemplate(template.body, vars);
      const templateVariables = extractVariables(template.body);
      const unresolvedVariables = extractVariables(resolved);

      return {
        template: template.body,
        resolved,
        variables: templateVariables,
        unresolvedVariables,
      };
    },
  };
}
