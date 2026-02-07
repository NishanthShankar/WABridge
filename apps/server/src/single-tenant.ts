import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { Hono } from 'hono';
import type { Logger } from 'pino';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import type { AppConfig } from './config/schema.js';
import type { AppContext } from './context.js';
import type { ServerPlugin } from './plugin.js';
import { setContext } from './context.js';
import { createDatabase } from './db/client.js';
import { ConnectionManager } from './bridge/socket.js';
import { createRateLimiter } from './rate-limit/rate-limiter.js';
import { createWebSocketHandler } from './api/ws.js';
import { setupDeliveryListener } from './delivery/delivery.listener.js';

/**
 * Create the single-tenant server plugin.
 *
 * This is the built-in mode: one WhatsApp account, one database, no auth.
 * Creates a singleton AppContext that is stamped on every request.
 */
export async function createSingleTenantPlugin(params: {
  config: AppConfig;
  logger: Logger;
  migrationsDir: string;
  encryptionKey: string;
  apiKey: string;
}): Promise<ServerPlugin> {
  const { config, logger, migrationsDir, encryptionKey, apiKey } = params;

  // Initialize database + run migrations
  const dbPath = process.env.OPENWA_DB_PATH || './data/openwa.db';
  const db = createDatabase(dbPath);

  if (existsSync(migrationsDir)) {
    migrate(db, { migrationsFolder: migrationsDir });
    logger.info('Database migrations applied');
  } else {
    logger.warn({ migrationsDir }, 'Migrations directory not found -- skipping');
  }

  // Late-bound broadcast (set after WS handler is created)
  let broadcastFn: (message: object) => void = () => {};

  // Create ConnectionManager
  const connectionManager = new ConnectionManager(
    db as unknown as BetterSQLite3Database,
    config,
    (msg) => broadcastFn(msg),
    logger.child({ module: 'bridge' }),
    encryptionKey,
  );

  // Create rate limiter
  const rateLimiter = createRateLimiter(db, config, (msg) => broadcastFn(msg));
  logger.info(
    { dailyCap: config.rate_limit.daily_cap },
    'Rate limiter created',
  );

  // Build the singleton AppContext
  const singletonContext: AppContext = {
    db,
    config,
    rateLimiter,
    broadcast: (msg) => broadcastFn(msg),
    getSocket: () => connectionManager.getSocket(),
    getHealth: () => connectionManager.getHealth(),
    tenantId: '',
  };

  return {
    // Middleware: authenticate + stamp the singleton context on every request
    apiMiddleware: async (c, next) => {
      const key = c.req.header('x-api-key');
      if (key !== apiKey) {
        return c.json({ error: 'Invalid or missing API key' }, 401);
      }
      setContext(c, singletonContext);
      await next();
    },

    // WS: use the existing simple broadcast handler
    setupWebSocket(app: Hono) {
      const { wsHandler, broadcast, injectWebSocket } =
        createWebSocketHandler(app, () => connectionManager.getHealth(), apiKey);

      // Point the late-bound wrapper to the real broadcast
      broadcastFn = broadcast;

      return { wsHandler, injectWebSocket: injectWebSocket as (server: unknown) => void };
    },

    // No admin routes in single-tenant mode
    adminRoutes: undefined,

    // Worker context: always the singleton
    resolveJobContext(_jobData: Record<string, unknown>) {
      return singletonContext;
    },

    // Start: connect WhatsApp + delivery listener
    async start() {
      connectionManager.onConnected((sock) => {
        setupDeliveryListener(sock, db, broadcastFn);
        logger.info('Delivery status listener attached');
      });

      logger.info('Starting WhatsApp connection...');
      await connectionManager.connect();
    },

    // Graceful shutdown
    destroy() {
      connectionManager.destroy();
    },
  };
}
