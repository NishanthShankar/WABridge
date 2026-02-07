import { integer, text, sqliteTable, index, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';
import { relations } from 'drizzle-orm';

// ─── Phase 1: WhatsApp Bridge ────────────────────────────────────────────────

/** Auth state storage (credentials + Signal keys) */
export const authState = sqliteTable('auth_state', {
  /** 'creds' or '{type}-{id}' */
  key: text('key').primaryKey(),
  /** Encrypted JSON blob */
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

/** Session metadata (for health/status reporting) */
export const sessionMeta = sqliteTable('session_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

// ─── Phase 2: Contact Management ─────────────────────────────────────────────

/** Contacts table */
export const contacts = sqliteTable('contacts', {
  id: text('id').primaryKey(),                  // crypto.randomUUID()
  phone: text('phone').notNull(),               // E.164 format: +919812345678
  name: text('name'),                           // Display name (optional)
  email: text('email'),
  notes: text('notes'),
  customFields: text('custom_fields'),          // JSON string for flexible fields from CSV
  birthday: text('birthday'),                   // MM-DD format (no year) for birthday reminders
  birthdayReminderEnabled: integer('birthday_reminder_enabled', { mode: 'boolean' })
    .default(true),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => [
  uniqueIndex('contacts_phone_idx').on(table.phone),
  index('contacts_name_idx').on(table.name),
]);

/** Labels table */
export const labels = sqliteTable('labels', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  color: text('color'),                         // Optional hex color for UI (Phase 5)
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => [
  uniqueIndex('labels_name_idx').on(table.name),
]);

/** Junction table for many-to-many contact-label relationship */
export const contactLabels = sqliteTable('contact_labels', {
  contactId: text('contact_id')
    .notNull()
    .references(() => contacts.id, { onDelete: 'cascade' }),
  labelId: text('label_id')
    .notNull()
    .references(() => labels.id, { onDelete: 'cascade' }),
}, (table) => [
  primaryKey({ columns: [table.contactId, table.labelId] }),
]);

/** Message templates table */
export const templates = sqliteTable('templates', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  body: text('body').notNull(),                 // Template text with {{variables}}
  variables: text('variables'),                  // JSON array of extracted variable names
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => [
  uniqueIndex('templates_name_idx').on(table.name),
]);

// ─── Phase 3: Message Scheduling ─────────────────────────────────────────────

/** Recurring rules (daily, weekly, monthly, yearly, birthday) */
export const recurringRules = sqliteTable('recurring_rules', {
  id: text('id').primaryKey(),
  contactId: text('contact_id').notNull()
    .references(() => contacts.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
    // daily | weekly | monthly | yearly | custom | birthday
  content: text('content').notNull(),
  cronExpression: text('cron_expression').notNull(),
  intervalDays: integer('interval_days'),       // For custom: "every N days"
  startDate: integer('start_date', { mode: 'timestamp' }),
  endDate: integer('end_date', { mode: 'timestamp' }),
  maxOccurrences: integer('max_occurrences'),
  occurrenceCount: integer('occurrence_count').notNull().default(0),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  lastFiredAt: integer('last_fired_at', { mode: 'timestamp' }),
  mediaUrl: text('media_url'),
  mediaType: text('media_type'),    // image | video | audio | document
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => [
  index('recurring_contact_idx').on(table.contactId),
  index('recurring_type_idx').on(table.type),
]);

/** Scheduled messages (one-time and instances from recurring rules) */
export const scheduledMessages = sqliteTable('scheduled_messages', {
  id: text('id').primaryKey(),
  contactId: text('contact_id').notNull()
    .references(() => contacts.id, { onDelete: 'cascade' }),
  recurringRuleId: text('recurring_rule_id')
    .references(() => recurringRules.id, { onDelete: 'set null' }),
  content: text('content').notNull(),
  scheduledAt: integer('scheduled_at', { mode: 'timestamp' }).notNull(),
  status: text('status').notNull().default('pending'),
    // pending | sent | delivered | failed | cancelled
  whatsappMessageId: text('whatsapp_message_id'),
  sentAt: integer('sent_at', { mode: 'timestamp' }),
  deliveredAt: integer('delivered_at', { mode: 'timestamp' }),
  failedAt: integer('failed_at', { mode: 'timestamp' }),
  failureReason: text('failure_reason'),
  attempts: integer('attempts').notNull().default(0),
  mediaUrl: text('media_url'),
  mediaType: text('media_type'),    // image | video | audio | document
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => [
  index('sched_msg_contact_idx').on(table.contactId),
  index('sched_msg_status_idx').on(table.status),
  index('sched_msg_scheduled_at_idx').on(table.scheduledAt),
  index('sched_msg_wa_msg_id_idx').on(table.whatsappMessageId),
]);

// ─── Drizzle Relations (for relational query API) ────────────────────────────

export const contactsRelations = relations(contacts, ({ many }) => ({
  contactLabels: many(contactLabels),
  scheduledMessages: many(scheduledMessages),
  recurringRules: many(recurringRules),
}));

export const labelsRelations = relations(labels, ({ many }) => ({
  contactLabels: many(contactLabels),
}));

export const contactLabelsRelations = relations(contactLabels, ({ one }) => ({
  contact: one(contacts, {
    fields: [contactLabels.contactId],
    references: [contacts.id],
  }),
  label: one(labels, {
    fields: [contactLabels.labelId],
    references: [labels.id],
  }),
}));

export const scheduledMessagesRelations = relations(scheduledMessages, ({ one }) => ({
  contact: one(contacts, {
    fields: [scheduledMessages.contactId],
    references: [contacts.id],
  }),
  recurringRule: one(recurringRules, {
    fields: [scheduledMessages.recurringRuleId],
    references: [recurringRules.id],
  }),
}));

export const recurringRulesRelations = relations(recurringRules, ({ one, many }) => ({
  contact: one(contacts, {
    fields: [recurringRules.contactId],
    references: [contacts.id],
  }),
  scheduledMessages: many(scheduledMessages),
}));
