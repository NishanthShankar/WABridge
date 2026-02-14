export const queryKeys = {
  connection: {
    health: ['connection', 'health'] as const,
    qr: ['connection', 'qr'] as const,
  },
  contacts: {
    all: ['contacts'] as const,
    list: (params: Record<string, unknown>) => ['contacts', 'list', params] as const,
    detail: (id: string) => ['contacts', 'detail', id] as const,
  },
  groups: {
    all: ['groups'] as const,
    list: (params: Record<string, unknown>) => ['groups', 'list', params] as const,
  },
  messages: {
    all: ['messages'] as const,
    list: (params: Record<string, unknown>) => ['messages', 'list', params] as const,
    detail: (id: string) => ['messages', 'detail', id] as const,
    recurring: {
      all: ['messages', 'recurring'] as const,
      detail: (id: string) => ['messages', 'recurring', id] as const,
    },
  },
  labels: {
    all: ['labels'] as const,
  },
  templates: {
    all: ['templates'] as const,
    detail: (id: string) => ['templates', 'detail', id] as const,
  },
  rateLimit: {
    status: ['rate-limit', 'status'] as const,
  },
  dashboard: {
    all: ['dashboard'] as const,
  },
} as const;
