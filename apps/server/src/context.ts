import type { Context } from 'hono';
import type makeWASocket from '@whiskeysockets/baileys';
import type { createDatabase } from './db/client.js';
import type { AppConfig } from './config/schema.js';
import type { RateLimiter } from './rate-limit/rate-limiter.js';
import type { ConnectionHealth } from './bridge/types.js';

type Database = ReturnType<typeof createDatabase>;
type WASocket = ReturnType<typeof makeWASocket>;

/**
 * Application context shared between routers, workers, and middleware.
 *
 * In single-tenant mode, this is a singleton stamped by middleware on every request.
 * In multi-tenant mode, the plugin resolves the correct context per tenant.
 *
 * Routers never know which mode they're in — they always call getContext(c).
 */
export interface AppContext {
  db: Database;
  config: AppConfig;
  rateLimiter: RateLimiter;
  broadcast: (message: object) => void;
  getSocket: () => WASocket | null;
  getHealth: () => ConnectionHealth;
  tenantId: string; // empty string in single-tenant
}

/**
 * Extract AppContext from Hono request context.
 * Throws if middleware hasn't set the context yet.
 */
export function getContext(c: Context): AppContext {
  const ctx = (c as unknown as { var: Record<string, unknown> }).var
    .appContext as AppContext | undefined;
  if (!ctx) throw new Error('AppContext not set — is middleware configured?');
  return ctx;
}

/**
 * Set AppContext on Hono request context. Used by middleware only.
 */
export function setContext(c: Context, ctx: AppContext): void {
  (c as unknown as { set(key: string, value: unknown): void }).set(
    'appContext',
    ctx,
  );
}
