import type makeWASocket from '@whiskeysockets/baileys';
import type { Hono } from 'hono';
import type { Logger } from 'pino';
import { registerFeatures } from './api/health.js';
import type { AppConfig } from './config/schema.js';
import type { createDatabase } from './db/client.js';
import { registerPrivateTables } from './db/private.js';
import { type GroupCapRule, registerGroupCapRule } from './groups/cap-rules.js';
import {
  type GroupCreateHook,
  registerGroupCreateHook,
} from './groups/create-hooks.js';
import { type NoStoreRule, registerNoStoreRule } from './messages/no-store.js';
import {
  type PrivatePollFields,
  registerPrivatePollFields,
} from './polls/private-poll.js';
import {
  type IncomingHook,
  registerIncomingHook,
} from './webhooks/incoming.js';

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
   * first: mount before the server's own routes. Needed when the paths sit under a prefix
   * the server also serves, like /api/chats/:id/<something>.
   */
  routes?: Array<{ basePath: string; router: Hono; first?: boolean }>;
  /**
   * Called after every WhatsApp connection and reconnection, for every account (each tenant
   * and each user in multi-tenant mode). Attach sock.ev listeners here.
   */
  onConnected?: (sock: WASocket, ctx: ExtensionConnectionContext) => void;
  /**
   * Tables of this extension that hold what its sending routes store. A private request
   * (see db/private.ts) gets an in-memory copy of each, so the routes work without writing to
   * disk. Tables not listed are read from disk and cannot be written by a private request.
   */
  privateTables?: string[];
  /**
   * Markdown documenting the extension's routes and webhooks. Appended to GET /api/docs
   * under "# Extension: <name>". A function is called on every request.
   */
  docs?: string | (() => string | Promise<string>);
  /** Names added to "features" in GET /api/health, so clients can check for them. */
  features?: string[];
  /**
   * Take a chat's incoming messages before the server handles them: the server then delivers
   * nothing of them itself. See webhooks/incoming.ts.
   */
  incoming?: IncomingHook;
  /**
   * Chats the server must keep nothing of: what is sent into them is always handled as a
   * private request and never stored. See messages/no-store.ts.
   */
  noStore?: NoStoreRule;
  /** A field of the extension's own on POST /api/groups. See groups/create-hooks.ts. */
  groupCreate?: GroupCreateHook;
  /** More group creations a day for groups the extension vouches for. See groups/cap-rules.ts. */
  groupCap?: GroupCapRule;
  /**
   * Fields added to what the client is told when a poll was sent by a private request.
   * See polls/private-poll.ts.
   */
  privatePollFields?: PrivatePollFields;
}

/**
 * Put an extension's hooks in place. loadExtensions does this for every extension it loads;
 * an extension's own tests can call it to run against the server's real code.
 */
export function installExtension(ext: Extension): void {
  if (ext.privateTables) registerPrivateTables(ext.privateTables);
  if (ext.features) registerFeatures(ext.features);
  if (ext.incoming) registerIncomingHook(ext.incoming);
  if (ext.noStore) registerNoStoreRule(ext.noStore);
  if (ext.groupCreate) registerGroupCreateHook(ext.groupCreate);
  if (ext.groupCap) registerGroupCapRule(ext.groupCap);
  if (ext.privatePollFields) registerPrivatePollFields(ext.privatePollFields);
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
      installExtension(ext);
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
