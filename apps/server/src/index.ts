import { resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import pino from 'pino';
import { serve } from '@hono/node-server';

import { loadConfig, resolveConfigPath } from './config/loader.js';
import type { AppConfig } from './config/schema.js';
import { generateEncryptionKey, generateApiKey } from './crypto/vault.js';
import { createApp } from './api/routes.js';
import { createMessageQueue } from './scheduler/queue.js';
import { createMessageWorker } from './scheduler/worker.js';
import type { ServerPlugin } from './plugin.js';
import { startTunnel } from './tunnel.js';

/**
 * openWA Server - WhatsApp Bridge
 *
 * Boot sequence:
 * 1. Load configuration (YAML + Zod validation)
 * 2. Initialize logger (pino)
 * 3. Resolve encryption key (env var > config > auto-generate)
 * 4. Load plugin (multi-tenant if available, else single-tenant)
 * 5. Create BullMQ message queue (connects to Valkey)
 * 6. Create Hono app with routes (plugin provides middleware + WS)
 * 7. Create BullMQ message worker (uses plugin.resolveJobContext)
 * 8. Start HTTP server
 * 9. Inject WebSocket into server
 * 10. Start plugin (WhatsApp connection, delivery listener)
 * 11. Handle graceful shutdown (SIGINT, SIGTERM)
 */
async function main(): Promise<void> {
  // 1. Load configuration
  const configPath = resolveConfigPath();
  const config = loadConfig(configPath ?? './config.yaml');

  // 2. Initialize logger
  const logger = pino({
    level: config.log_level,
    transport:
      process.env.NODE_ENV !== 'production'
        ? { target: 'pino/file', options: { destination: 1 } }
        : undefined,
  });

  logger.info({ configPath: configPath ?? '(defaults)' }, 'Configuration loaded');

  // 3. Resolve encryption key
  const encryptionKey = resolveEncryptionKey(config, configPath, logger);

  // 3.5. Resolve API key (single-tenant auth)
  const apiKey = resolveApiKey(config, configPath, logger);

  // 4. Load plugin
  const migrationsDir = resolve(import.meta.dirname, '../drizzle');
  let plugin: ServerPlugin;

  try {
    // Try loading multi-tenant plugin (optional private package)
    // @ts-expect-error -- optional dependency, not installed in single-tenant mode
    const mod = await import('@openwa/multi-tenant');
    plugin = await (mod.default as (params: {
      config: AppConfig;
      logger: pino.Logger;
      migrationsDir: string;
      encryptionKey: string;
    }) => Promise<ServerPlugin>)({ config, logger, migrationsDir, encryptionKey });
    logger.info('Multi-tenant plugin loaded');
  } catch {
    // Fall back to single-tenant mode (built-in)
    const { createSingleTenantPlugin } = await import('./single-tenant.js');
    plugin = await createSingleTenantPlugin({ config, logger, migrationsDir, encryptionKey, apiKey });
    logger.info('Single-tenant mode');
  }

  // 5. Create BullMQ message queue (connects to Valkey)
  const messageQueue = createMessageQueue(config);
  logger.info(
    { host: config.valkey.host, port: config.valkey.port },
    'BullMQ message queue created',
  );

  // 6. Create Hono app with all routes
  const { app, injectWebSocket } = createApp(plugin, messageQueue);

  // 7. Create BullMQ message worker
  const messageWorker = createMessageWorker(
    config,
    (jobData) => plugin.resolveJobContext(jobData),
  );
  logger.info('BullMQ message worker started');

  // 7a. Register message history cleanup scheduler (daily at 3 AM)
  await messageQueue.upsertJobScheduler(
    'message-cleanup',
    { pattern: '0 0 3 * * *' },
    { name: 'cleanup', data: {} },
  );
  logger.info('Message history cleanup scheduled (daily at 3 AM)');

  // 8. Start HTTP server
  const server = serve(
    {
      fetch: app.fetch,
      port: config.port,
      hostname: config.host,
    },
    (info) => {
      logger.info(
        { port: info.port, address: info.address },
        'HTTP server listening',
      );
    },
  );

  // 9. Inject WebSocket into server
  injectWebSocket(server);

  // 9.5. Start ngrok tunnel (if configured)
  const tunnel = await startTunnel(config, logger, config.port);

  // 10. Start plugin (connect WhatsApp, delivery listeners, etc.)
  await plugin.start();

  // 11. Handle graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down...');
    if (tunnel) await tunnel.close();
    await messageWorker.close();
    await messageQueue.close();
    plugin.destroy();
    server.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/**
 * Resolve the encryption key from (in priority order):
 * 1. OPENWA_ENCRYPTION_KEY environment variable
 * 2. encryption_key field in config
 * 3. Auto-generate on first run and write to config.yaml
 */
function resolveEncryptionKey(
  config: AppConfig,
  configPath: string | undefined,
  logger: pino.Logger,
): string {
  // 1. Environment variable (highest priority, recommended for Docker)
  const envKey = process.env.OPENWA_ENCRYPTION_KEY;
  if (envKey && envKey.length >= 16) {
    logger.info('Using encryption key from OPENWA_ENCRYPTION_KEY environment variable');
    return envKey;
  }

  // 2. Config file
  if (config.encryption_key) {
    logger.info('Using encryption key from config file');
    return config.encryption_key;
  }

  // 3. Auto-generate on first run
  const newKey = generateEncryptionKey();
  logger.info(
    'No encryption key found -- auto-generating a new one',
  );

  // Try to write the key to config.yaml so it persists
  const targetPath = configPath ?? './config.yaml';
  try {
    // Ensure data directory exists
    mkdirSync('./data', { recursive: true });

    if (existsSync(targetPath)) {
      // Append to existing config
      const existing = readFileSync(targetPath, 'utf-8');
      if (!existing.includes('encryption_key')) {
        writeFileSync(
          targetPath,
          `${existing}\n# Auto-generated encryption key -- DO NOT change or you will lose your WhatsApp session\nencryption_key: "${newKey}"\n`,
        );
        logger.info(
          { path: targetPath },
          'Encryption key written to config file',
        );
      }
    } else {
      // Create new config with the key
      writeFileSync(
        targetPath,
        [
          '# openWA Configuration',
          '# Auto-generated on first run',
          '',
          'port: 4000',
          'host: 0.0.0.0',
          'log_level: info',
          '',
          '# WARNING: Do not change this key or you will lose your WhatsApp session',
          `encryption_key: "${newKey}"`,
          '',
          'whatsapp:',
          '  browser_name: openWA',
          '  mark_online: false',
          '',
          'reconnect:',
          '  max_retry_minutes: 30',
          '  base_delay_ms: 1000',
          '  max_delay_ms: 60000',
          '',
        ].join('\n'),
      );
      logger.info(
        { path: targetPath },
        'Generated default config with encryption key',
      );
    }
  } catch (err) {
    logger.warn(
      { err },
      'Could not write encryption key to config file -- key is in-memory only for this session',
    );
  }

  return newKey;
}

/**
 * Resolve the API key from (in priority order):
 * 1. OPENWA_API_KEY environment variable
 * 2. api_key field in config
 * 3. Auto-generate on first run and write to config.yaml
 */
function resolveApiKey(
  config: AppConfig,
  configPath: string | undefined,
  logger: pino.Logger,
): string {
  // 1. Environment variable
  const envKey = process.env.OPENWA_API_KEY;
  if (envKey && envKey.length >= 16) {
    logger.info('Using API key from OPENWA_API_KEY environment variable');
    return envKey;
  }

  // 2. Config file
  if (config.api_key) {
    logger.info('Using API key from config file');
    return config.api_key;
  }

  // 3. Auto-generate on first run
  const newKey = generateApiKey();
  logger.info({ apiKey: newKey }, 'Auto-generated API key -- save this for client access');

  const targetPath = configPath ?? './config.yaml';
  try {
    if (existsSync(targetPath)) {
      const existing = readFileSync(targetPath, 'utf-8');
      if (!existing.includes('api_key')) {
        writeFileSync(
          targetPath,
          `${existing}\n# Auto-generated API key for authenticating API requests\napi_key: "${newKey}"\n`,
        );
        logger.info({ path: targetPath }, 'API key written to config file');
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Could not write API key to config file -- key is in-memory only for this session');
  }

  return newKey;
}

// Run
main().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
