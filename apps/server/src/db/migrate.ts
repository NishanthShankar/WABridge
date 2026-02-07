import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createDatabase } from './client.js';

const DB_PATH = process.env.OPENWA_DB_PATH || './data/openwa.db';
const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../drizzle');

/**
 * Run database migrations.
 * Can be run standalone via `tsx src/db/migrate.ts` or imported by the app entry point.
 */
export function runMigrations(dbPath: string = DB_PATH) {
  const db = createDatabase(dbPath);
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  console.log('Migrations applied successfully.');
  return db;
}

// Run standalone if executed directly
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('migrate.ts');

if (isMain) {
  runMigrations();
}
