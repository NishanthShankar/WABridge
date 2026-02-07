import { API_BASE } from './constants';
import type {
  ConnectionHealth,
  Contact,
  ContactCreate,
  ContactUpdate,
  ContactListParams,
  ContactListResult,
  Label,
  LabelCreate,
  LabelUpdate,
  Template,
  TemplateCreate,
  TemplateUpdate,
  TemplatePreview,
  ScheduledMessage,
  ScheduleMessageCreate,
  ScheduleMessageUpdate,
  MessageListParams,
  MessageListResult,
  BulkScheduleItem,
  BulkScheduleResult,
  RecurringRule,
  RecurringRuleCreate,
  RecurringRuleUpdate,
  RecurringRuleListParams,
  RecurringRuleListResult,
  RateLimitStatus,
} from '@/types/api';

class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(err.error || res.statusText, res.status);
  }
  return res.json() as Promise<T>;
}

function toSearchParams(params?: Record<string, unknown>): string {
  if (!params) return '';
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null && v !== '',
  );
  if (entries.length === 0) return '';
  return '?' + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
}

export const api = {
  // ─── Health ─────────────────────────────────────────────────────────────────
  health: () => fetchJSON<ConnectionHealth>('/health'),

  // ─── Contacts ───────────────────────────────────────────────────────────────
  contacts: {
    list: (params?: ContactListParams) =>
      fetchJSON<ContactListResult>(`/contacts${toSearchParams(params as Record<string, unknown>)}`),
    create: (data: ContactCreate) =>
      fetchJSON<Contact>('/contacts', { method: 'POST', body: JSON.stringify(data) }),
    get: (id: string) => fetchJSON<Contact>(`/contacts/${id}`),
    update: (id: string, data: ContactUpdate) =>
      fetchJSON<Contact>(`/contacts/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) => fetchJSON<void>(`/contacts/${id}`, { method: 'DELETE' }),
    import: (file: File) => {
      const formData = new FormData();
      formData.append('file', file);
      return fetch(`${API_BASE}/contacts/import`, {
        method: 'POST',
        body: formData,
        // Do NOT set Content-Type -- browser sets multipart boundary automatically
      }).then(async (res) => {
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          throw new ApiError(err.error || res.statusText, res.status);
        }
        return res.json();
      });
    },
    assignLabel: (contactId: string, labelIds: string[]) =>
      fetchJSON<void>(`/contacts/${contactId}/labels`, {
        method: 'POST',
        body: JSON.stringify({ labelIds }),
      }),
    removeLabel: (contactId: string, labelId: string) =>
      fetchJSON<void>(`/contacts/${contactId}/labels/${labelId}`, { method: 'DELETE' }),
  },

  // ─── Labels ─────────────────────────────────────────────────────────────────
  labels: {
    list: () => fetchJSON<Label[]>('/labels'),
    create: (data: LabelCreate) =>
      fetchJSON<Label>('/labels', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: LabelUpdate) =>
      fetchJSON<Label>(`/labels/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) => fetchJSON<void>(`/labels/${id}`, { method: 'DELETE' }),
  },

  // ─── Templates ──────────────────────────────────────────────────────────────
  templates: {
    list: () => fetchJSON<Template[]>('/templates'),
    get: (id: string) => fetchJSON<Template>(`/templates/${id}`),
    create: (data: TemplateCreate) =>
      fetchJSON<Template>('/templates', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: TemplateUpdate) =>
      fetchJSON<Template>(`/templates/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) => fetchJSON<void>(`/templates/${id}`, { method: 'DELETE' }),
    preview: (id: string, contactId: string) =>
      fetchJSON<TemplatePreview>(`/templates/${id}/preview`, {
        method: 'POST',
        body: JSON.stringify({ contactId }),
      }),
  },

  // ─── Messages ───────────────────────────────────────────────────────────────
  messages: {
    list: (params?: MessageListParams) =>
      fetchJSON<MessageListResult>(`/messages${toSearchParams(params as Record<string, unknown>)}`),
    get: (id: string) => fetchJSON<ScheduledMessage>(`/messages/${id}`),
    schedule: (data: ScheduleMessageCreate) =>
      fetchJSON<ScheduledMessage>('/messages', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: ScheduleMessageUpdate) =>
      fetchJSON<ScheduledMessage>(`/messages/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    cancel: (id: string) =>
      fetchJSON<ScheduledMessage>(`/messages/${id}/cancel`, { method: 'PATCH' }),
    retry: (id: string) =>
      fetchJSON<ScheduledMessage>(`/messages/${id}/retry`, { method: 'POST' }),
    scheduleBulk: (data: { messages: BulkScheduleItem[] }) =>
      fetchJSON<BulkScheduleResult>('/messages/bulk', { method: 'POST', body: JSON.stringify(data) }),

    recurring: {
      list: (params?: RecurringRuleListParams) =>
        fetchJSON<RecurringRuleListResult>(
          `/messages/recurring${toSearchParams(params as Record<string, unknown>)}`,
        ),
      get: (id: string) => fetchJSON<RecurringRule>(`/messages/recurring/${id}`),
      create: (data: RecurringRuleCreate) =>
        fetchJSON<RecurringRule>('/messages/recurring', {
          method: 'POST',
          body: JSON.stringify(data),
        }),
      update: (id: string, data: RecurringRuleUpdate) =>
        fetchJSON<RecurringRule>(`/messages/recurring/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(data),
        }),
      delete: (id: string) =>
        fetchJSON<void>(`/messages/recurring/${id}`, { method: 'DELETE' }),
    },
  },

  // ─── Rate Limit ─────────────────────────────────────────────────────────────
  rateLimit: {
    status: () => fetchJSON<RateLimitStatus>('/rate-limit/status'),
  },
};

export { ApiError };
