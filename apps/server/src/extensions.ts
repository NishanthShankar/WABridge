import type makeWASocket from '@whiskeysockets/baileys';
import type { Hono } from 'hono';
import type { Logger } from 'pino';
import type { AppConfig } from './config/schema.js';
import type { createDatabase } from './db/client.js';

type Database = ReturnType<typeof createDatabase>;
type WASocket = ReturnType<typeof makeWASocket>;

/** What an extension gets on each WhatsApp connection. */
export interface ExtensionConnectionContext {
  /** The database of this account (the tenant's or user's own in multi-tenant mode). */
  db: Database;
  /** This account's config (tenant overrides applied). */
  config: AppConfig;
  /** This extension's options: config.extensions["<package>"]. */
  options: Record<string, unknown>;
  logger: Logger;
}

/**
 * An optional package that adds features without changing the server.
 *
 * Install it so the server can import it, then list it in config.yaml:
 *
 *   extensions:
 *     "@acme/wabridge-extra": { some_option: 1 }
 *
 * The package's default export is an ExtensionFactory.
 */
export interface Extension {
  name: string;
  /**
   * Routes mounted under /api/<basePath>, behind the same API key auth as every /api route.
   * Handlers reach the account with getContext(c) from "@openwa/server/context".
   */
  routes?: Array<{ basePath: string; router: Hono }>;
  /**
   * Called after every WhatsApp connection and reconnection, for every account (each tenant
   * and each user in multi-tenant mode). Attach sock.ev listeners here.
   */
  onConnected?: (sock: WASocket, ctx: ExtensionConnectionContext) => void;
}

export type ExtensionFactory = (params: {
  config: AppConfig;
  logger: Logger;
}) => Extension | Promise<Extension>;

/**
 * Import every package listed under config.extensions. A package that can't be loaded is
 * logged and skipped, so a missing optional extension never stops the server.
 */
export async function loadExtensions(
  config: AppConfig,
  logger: Logger,
): Promise<Extension[]> {
  const loaded: Extension[] = [];
  for (const name of Object.keys(config.extensions)) {
    try {
      const mod = (await import(name)) as { default?: ExtensionFactory };
      if (typeof mod.default !== 'function')
        throw new Error('default export is not an extension factory');
      const ext = await mod.default({
        config,
        logger: logger.child({ extension: name }),
      });
      loaded.push(ext);
      logger.info(
        {
          extension: name,
          routes: ext.routes?.map((r) => `/api/${r.basePath}`) ?? [],
        },
        'Extension loaded',
      );
    } catch (err) {
      logger.error(
        { extension: name, err: (err as Error).message },
        'Extension could not be loaded -- skipped',
      );
    }
  }
  return loaded;
}

/** Run every extension's onConnected for one connection. One failing extension doesn't stop the others. */
export function attachExtensions(
  extensions: Extension[],
  sock: WASocket,
  ctx: { db: Database; config: AppConfig; logger: Logger },
): void {
  for (const ext of extensions) {
    if (!ext.onConnected) continue;
    try {
      ext.onConnected(sock, {
        db: ctx.db,
        config: ctx.config,
        options: optionsFor(ctx.config, ext.name),
        logger: ctx.logger.child({ extension: ext.name }),
      });
    } catch (err) {
      ctx.logger.error(
        { extension: ext.name, err: (err as Error).message },
        'Extension failed to attach',
      );
    }
  }
}

/** config.extensions["<name>"], or {} when not set. */
export function optionsFor(
  config: AppConfig,
  name: string,
): Record<string, unknown> {
  return (
    (config.extensions?.[name] as Record<string, unknown> | undefined) ?? {}
  );
}
