import { Queue } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import type { AppConfig } from '../config/schema.js';

/**
 * Build the Valkey/Redis connection config from app config.
 * Shared between Queue (producer) and Worker (consumer).
 */
export function getConnectionConfig(config: AppConfig): ConnectionOptions {
  return {
    host: config.valkey.host,
    port: config.valkey.port,
    password: config.valkey.password,
  };
}

/**
 * Create the BullMQ message queue.
 *
 * Queue name: 'message-send'
 * Default job options include retry with exponential backoff and auto-cleanup.
 */
export function createMessageQueue(config: AppConfig): Queue {
  const connection = getConnectionConfig(config);

  return new Queue('message-send', {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 }, // 5s, 10s, 20s
      removeOnComplete: { age: 86400 },              // Clean completed after 24h
      removeOnFail: { age: 604800 },                 // Keep failed for 7 days
    },
  });
}
