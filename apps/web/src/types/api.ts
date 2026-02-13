// ─── Connection ─────────────────────────────────────────────────────────────

export type ConnectionStatus = 'pairing' | 'connecting' | 'connected' | 'disconnected';

export interface ConnectionHealth {
  status: ConnectionStatus;
  uptime: number;
  connectedAt: string | null;
  lastDisconnect: {
    reason: string;
    code: number;
    at: string;
  } | null;
  reconnectAttempts: number;
  account: {
    phoneNumber: string;
    name: string;
  } | null;
}

// ─── Contacts ───────────────────────────────────────────────────────────────

export interface Contact {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  notes: string | null;
  customFields: Record<string, string> | null;
  birthday: string | null;
  birthdayReminderEnabled: boolean;
  labels: Label[];
  createdAt: string;
  updatedAt: string;
}

export interface ContactCreate {
  phone: string;
  name?: string;
  email?: string;
  notes?: string;
  birthday?: string;
  birthdayReminderEnabled?: boolean;
}

export interface ContactUpdate {
  phone?: string;
  name?: string;
  email?: string;
  notes?: string;
  birthday?: string | null;
  birthdayReminderEnabled?: boolean;
}

export interface ContactListParams {
  page?: number;
  limit?: number;
  search?: string;
  label?: string;
}

export interface ContactListResult {
  data: Contact[];
  total: number;
  page: number;
  pageSize: number;
}

// ─── Labels ─────────────────────────────────────────────────────────────────

export interface Label {
  id: string;
  name: string;
  color: string | null;
  createdAt: string;
}

export interface LabelCreate {
  name: string;
  color?: string;
}

export interface LabelUpdate {
  name?: string;
  color?: string | null;
}

// ─── Templates ──────────────────────────────────────────────────────────────

export interface Template {
  id: string;
  name: string;
  body: string;
  variables: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TemplateCreate {
  name: string;
  body: string;
}

export interface TemplateUpdate {
  name?: string;
  body?: string;
}

export interface TemplatePreview {
  rendered: string;
  unresolvedVariables: string[];
}

// ─── Media ─────────────────────────────────────────────────────────────────

export type MediaType = 'image' | 'video' | 'audio' | 'document';

// ─── Scheduled Messages ─────────────────────────────────────────────────────

export type MessageStatus = 'pending' | 'sent' | 'delivered' | 'failed' | 'cancelled';

export interface ScheduledMessage {
  id: string;
  contactId: string;
  contactName: string | null;
  contactPhone: string;
  recurringRuleId: string | null;
  content: string;
  scheduledAt: string;
  status: MessageStatus;
  whatsappMessageId: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  failedAt: string | null;
  failureReason: string | null;
  mediaUrl: string | null;
  mediaType: MediaType | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleMessageCreate {
  contactId?: string;
  phone?: string;
  name?: string;
  content: string;
  scheduledAt?: string;
  mediaUrl?: string;
  mediaType?: MediaType;
}

export interface BulkScheduleItem {
  contactId?: string;
  phone?: string;
  name?: string;
  content: string;
  scheduledAt?: string;
  mediaUrl?: string;
  mediaType?: MediaType;
}

export interface BulkScheduleResult {
  scheduled: ScheduledMessage[];
  failed: { index: number; error: string }[];
  rateLimit?: RateLimitStatus;
}

export interface ScheduleMessageUpdate {
  content?: string;
  scheduledAt?: string;
  mediaUrl?: string | null;
  mediaType?: MediaType | null;
}

export interface MessageListParams {
  status?: MessageStatus;
  contactId?: string;
  phone?: string;
  phoneMode?: 'include' | 'exclude';
  limit?: number;
  offset?: number;
}

export interface MessageListResult {
  data: ScheduledMessage[];
  total: number;
}

// ─── Recurring Rules ────────────────────────────────────────────────────────

export type RecurringType = 'daily' | 'weekly' | 'monthly' | 'yearly' | 'custom' | 'birthday';

export interface RecurringRule {
  id: string;
  contactId: string;
  contactName: string | null;
  contactPhone: string;
  type: RecurringType;
  content: string;
  cronExpression: string;
  intervalDays: number | null;
  startDate: string | null;
  endDate: string | null;
  maxOccurrences: number | null;
  occurrenceCount: number;
  mediaUrl: string | null;
  mediaType: MediaType | null;
  enabled: boolean;
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecurringRuleCreate {
  contactId?: string;
  phone?: string;
  name?: string;
  type: RecurringType;
  content: string;
  sendHour?: number;
  sendMinute?: number;
  dayOfWeek?: number;
  dayOfMonth?: number;
  month?: number;
  intervalDays?: number;
  endDate?: string;
  maxOccurrences?: number;
  mediaUrl?: string;
  mediaType?: MediaType;
}

export interface RecurringRuleUpdate {
  content?: string;
  sendHour?: number;
  sendMinute?: number;
  dayOfWeek?: number;
  dayOfMonth?: number;
  month?: number;
  intervalDays?: number;
  endDate?: string | null;
  maxOccurrences?: number | null;
  enabled?: boolean;
  mediaUrl?: string | null;
  mediaType?: MediaType | null;
}

export interface RecurringRuleListParams {
  contactId?: string;
  type?: RecurringType;
  enabled?: string;
  limit?: number;
  offset?: number;
}

export interface RecurringRuleListResult {
  data: RecurringRule[];
  total: number;
}

// ─── Rate Limit ─────────────────────────────────────────────────────────────

export interface RateLimitStatus {
  sentToday: number;
  dailyCap: number;
  remaining: number;
  resetAt: string;
  warningThreshold: number;
}

// ─── WebSocket Events ───────────────────────────────────────────────────────

export type WebSocketEvent =
  | { type: 'status'; data: ConnectionHealth }
  | { type: 'qr'; data: string }
  | { type: 'message:sent'; data: { messageId: string; contactId: string; sentAt: string } }
  | { type: 'message:failed'; data: { messageId: string; error: string; failedAt: string } }
  | { type: 'message:status'; data: { messageId: string; status: string; at: string } }
  | { type: 'rate-limit:warning'; data: { sentToday: number; cap: number; remaining: number } }
  | { type: 'rate-limit:reached'; data: { sentToday: number; cap: number; resetAt: string } };
