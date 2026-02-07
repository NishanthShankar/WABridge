import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

/**
 * Create a Drizzle database instance backed by better-sqlite3.
 * Creates the parent directory if it doesn't exist.
 * Enables WAL mode and foreign keys for performance and correctness.
 */
export function createDatabase(dbPath: string) {
  // Ensure parent directory exists
  mkdirSync(dirname(dbPath), { recursive: true });

  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  return drizzle(sqlite, { schema });
}
