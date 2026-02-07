import { existsSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { type AppConfig, configSchema } from './schema.js';

/**
 * Resolve the path to the config file.
 * Checks in order:
 * 1. OPENWA_CONFIG_PATH environment variable
 * 2. ./config.yaml (current working directory)
 * 3. /app/config.yaml (Docker default)
 *
 * Returns undefined if no config file is found (defaults will be used).
 */
export function resolveConfigPath(): string | undefined {
  const candidates = [
    process.env.OPENWA_CONFIG_PATH,
    './config.yaml',
    '/app/config.yaml',
  ];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

/**
 * Load and validate the config file.
 * If the file does not exist (ENOENT), returns defaults from schema.
 * If validation fails, throws a descriptive error.
 */
export function loadConfig(path: string): AppConfig {
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = yaml.load(raw);
    return configSchema.parse(parsed);
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      // Config file not found -- use defaults
      return configSchema.parse({});
    }
    throw err;
  }
}
