import { z } from 'zod';

export const configSchema = z.object({
  port: z.number().default(4000),
  host: z.string().default('0.0.0.0'),
  encryption_key: z.string().min(16).optional(),
  api_key: z.string().min(16).optional(),
  log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  whatsapp: z
    .object({
      browser_name: z.string().default('openWA'),
      mark_online: z.boolean().default(false),
    })
    .default({}),
  reconnect: z
    .object({
      max_retry_minutes: z.number().default(30),
      base_delay_ms: z.number().default(1000),
      max_delay_ms: z.number().default(60000),
    })
    .default({}),
  rate_limit: z
    .object({
      daily_cap: z.number().min(1).default(30),
      min_delay_ms: z.number().default(2000),
      max_delay_ms: z.number().default(8000),
      warn_threshold_pct: z.number().min(0).max(100).default(80),
    })
    .default({}),
  scheduling: z
    .object({
      default_send_hour: z.number().min(0).max(23).default(9),
      birthday_message: z.string().default('Happy Birthday {{name}}! Wishing you a wonderful day.'),
      retention_days: z.number().min(0).default(90),
    })
    .default({}),
  valkey: z
    .object({
      host: z.string().default('localhost'),
      port: z.number().default(6379),
      password: z.string().optional(),
    })
    .default({}),
  admin: z
    .object({
      api_key: z.string().min(16),
    })
    .optional(),
});

export type AppConfig = z.infer<typeof configSchema>;
