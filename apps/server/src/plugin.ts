import type { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono/types';
import type { AppContext } from './context.js';

/**
 * Plugin interface for extending the server with different modes.
 *
 * The server supports two modes via plugins:
 * - Single-tenant (built-in): one WhatsApp account, no auth
 * - Multi-tenant (optional @openwa/multi-tenant package): multiple accounts, API key auth
 *
 * Both modes implement this interface. The server boot sequence doesn't know
 * which mode it's in — it just calls plugin methods uniformly.
 */
export interface ServerPlugin {
  /**
   * Hono middleware that sets AppContext on every API request.
   * Single-tenant: stamps the singleton context.
   * Multi-tenant: resolves tenant from X-API-Key header.
   */
  apiMiddleware: MiddlewareHandler;

  /**
   * Create WebSocket handler. Needs the same Hono app instance for @hono/node-ws.
   * Returns the /ws route handler and the server injection function.
   */
  setupWebSocket(app: Hono): {
    wsHandler: MiddlewareHandler;
    injectWebSocket: (server: unknown) => void;
  };

  /**
   * Optional admin routes (e.g., /admin/tenants in multi-tenant mode).
   */
  adminRoutes?: {
    router: Hono;
    basePath: string;
    middleware?: MiddlewareHandler;
  };

  /**
   * Resolve AppContext for a BullMQ job.
   * Worker calls this per job to get the right db/broadcast/etc.
   * Returns null if the context can't be resolved (e.g., tenant deleted).
   */
  resolveJobContext(jobData: Record<string, unknown>): AppContext | null;

  /**
   * Start the plugin (connect WhatsApp, set up listeners).
   */
  start(): Promise<void>;

  /**
   * Graceful shutdown (disconnect, close DB).
   */
  destroy(): void;
}

/**
 * Factory function type for creating a ServerPlugin.
 * The multi-tenant package exports a default function matching this signature.
 */
export type PluginFactory = (params: {
  config: import('./config/schema.js').AppConfig;
  logger: import('pino').Logger;
  migrationsDir: string;
  encryptionKey: string;
}) => Promise<ServerPlugin>;
