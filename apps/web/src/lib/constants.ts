/** Route paths */
export const ROUTES = {
  DASHBOARD: '/',
  CONTACTS: '/contacts',
  MESSAGES: '/messages',
  SETTINGS: '/settings',
  CONNECT: '/connect',
} as const;

/** Responsive breakpoints (matches Tailwind defaults) */
export const BREAKPOINTS = {
  SM: 640,
  MD: 768,
  LG: 1024,
  XL: 1280,
} as const;

/** API base URL (relative -- Vite proxy handles routing in dev) */
export const API_BASE = '/api';

/** WebSocket reconnection settings */
export const WS_RECONNECT_BASE_MS = 2000;
export const WS_RECONNECT_MAX_MS = 30000;
