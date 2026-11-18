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

// ─── Groups ─────────────────────────────────────────────────────────────────

/** WhatsApp groups the connected account participates in */
export const groups = sqliteTable('groups', {
  id: text('id').primaryKey(),                  // Group JID e.g. 120363123456@g.us
  name: text('name').notNull(),
  description: text('description'),
  participantCount: integer('participant_count'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => [
  index('groups_name_idx').on(table.name),
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
  contactId: text('contact_id')
    .references(() => contacts.id, { onDelete: 'cascade' }),
  groupId: text('group_id')
    .references(() => groups.id, { onDelete: 'cascade' }),
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
  index('sched_msg_group_idx').on(table.groupId),
  index('sched_msg_status_idx').on(table.status),
  index('sched_msg_scheduled_at_idx').on(table.scheduledAt),
  index('sched_msg_wa_msg_id_idx').on(table.whatsappMessageId),
]);

// ─── Webhooks ───────────────────────────────────────────────────────────────

/** Webhooks triggered when a message is received from a specific number */
export const webhooks = sqliteTable('webhooks', {
  id: text('id').primaryKey(),
  phone: text('phone'),                          // E.164 format: sender phone to watch (null = all senders)
  url: text('url').notNull(),                    // URL to POST to
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  secret: text('secret'),                        // Optional HMAC secret for signature verification
  /** Opt-in: also deliver group messages and non-message events (reactions, edits, deletes, group membership). */
  allEvents: integer('all_events', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => [
  index('webhooks_phone_idx').on(table.phone),
]);

/**
 * When each chat last wrote to this account. Gates POST /api/reply: answers inside the 24 hour
 * window after someone wrote skip the queue and the daily cap. One row per chat JID; a 1:1 chat
 * with a LID sender gets a row for the LID JID and one for the phone JID when it resolves.
 */
export const chatActivity = sqliteTable('chat_activity', {
  jid: text('jid').primaryKey(),
  lastInboundAt: integer('last_inbound_at', { mode: 'timestamp_ms' }).notNull(),
});

/**
 * Polls this account sent. Kept so votes can be decrypted (secret) and turned back into
 * option names, and so the bridge knows how to respond to each vote (mode, react, confirmText).
 */
export const polls = sqliteTable(
  'polls',
  {
    /** WhatsApp message id of the poll */
    id: text('id').primaryKey(),
    chatJid: text('chat_jid').notNull(),
    name: text('name').notNull(),
    /** JSON array of option names, in order */
    options: text('options').notNull(),
    /** 1 = pick one, 0 = pick any number */
    selectableCount: integer('selectable_count').notNull(),
    /** updateEveryTime | lockFirstVote | deleteAfterVote */
    mode: text('mode').notNull(),
    /** Emoji to react with on the poll after a counted vote; null = no reaction */
    react: text('react'),
    /** Text sent after a counted vote; {{option}} and {{poll}} are filled in. null = none */
    confirmText: text('confirm_text'),
    /** messageSecret of the poll (base64). Votes are encrypted with it. */
    secret: text('secret').notNull(),
    /**
     * Privacy: votes on this poll are never written with their answer. They are held in
     * memory until the client acknowledges them (or a webhook answers 2xx), at most an hour.
     */
    stealth: integer('stealth', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
    /** The client's own id for this poll, echoed in poll.vote */
    ref: text('ref'),
    /** When someone last cast a counted vote (never what they picked) */
    votedAt: integer('voted_at', { mode: 'timestamp_ms' }),
    /** When the bridge should delete it next: the client's deleteAt, or a retry */
    deleteAt: integer('delete_at', { mode: 'timestamp_ms' }),
    /** expired (deleteAt, only if nobody voted) | voted (deleteAfterVote retry) */
    deleteReason: text('delete_reason'),
    deleteAttempts: integer('delete_attempts').notNull().default(0),
    /** Set when the bridge gave up deleting it */
    deleteFailedAt: integer('delete_failed_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    index('polls_chat_idx').on(table.chatJid),
    index('polls_ref_idx').on(table.ref),
    index('polls_delete_at_idx').on(table.deleteAt),
  ],
);

/** Every vote received on a poll in `polls`, including changes and ignored ones. */
export const pollVotes = sqliteTable(
  'poll_votes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    pollId: text('poll_id').notNull(),
    voterJid: text('voter_jid').notNull(),
    voterPhone: text('voter_phone'),
    /** JSON array of the option names picked (empty when they removed their vote) */
    selected: text('selected').notNull(),
    /** false when the mode ignored this vote (locked, poll already deleted, ...) */
    counted: integer('counted', { mode: 'boolean' }).notNull(),
    /**
     * null = counts and is final. settling (multi-choice, still tapping) | locked | poll_deleted | empty | superseded
     * hidden = a stealth poll's vote: only that they voted is kept (selected is []), so a lock can hold.
     * awaiting_ack = the same, for stealth deleteAfterVote until the client acknowledges the vote.
     */
    note: text('note'),
    at: integer('at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('poll_votes_poll_idx').on(table.pollId)],
);

/**
 * Chat lists (the filters above the chat list: Favorites, custom lists such as "RT", and
 * WhatsApp Business labels). WhatsApp keeps them as labels, synced between the account's
 * devices; this is the bridge's copy, filled from those sync events.
 */
export const chatLists = sqliteTable('chat_lists', {
  /** WhatsApp's label id */
  id: text('id').primaryKey(),
  name: text('name'),
  color: integer('color'),
  predefinedId: text('predefined_id'),
  deleted: integer('deleted', { mode: 'boolean' }).notNull().default(false),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

/** Which chats are in which list */
export const chatListChats = sqliteTable(
  'chat_list_chats',
  {
    listId: text('list_id').notNull(),
    chatJid: text('chat_jid').notNull(),
  },
  (table) => [primaryKey({ columns: [table.listId, table.chatJid] })],
);

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

export const groupsRelations = relations(groups, ({ many }) => ({
  scheduledMessages: many(scheduledMessages),
}));

export const scheduledMessagesRelations = relations(scheduledMessages, ({ one }) => ({
  contact: one(contacts, {
    fields: [scheduledMessages.contactId],
    references: [contacts.id],
  }),
  group: one(groups, {
    fields: [scheduledMessages.groupId],
    references: [groups.id],
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
