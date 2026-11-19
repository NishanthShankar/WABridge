import BetterSqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { AppContext } from '../context.js';
import type { createDatabase } from './client.js';
import * as schema from './schema.js';

type Database = ReturnType<typeof createDatabase>;

/**
 * Private mode: a request the client marked private (X-Private: true, or "private": true in
 * a JSON body) must leave nothing on disk.
 *
 * Instead of teaching every API what not to store, a private request is handed a different
 * database: a second, READ-ONLY connection to the account's database file, on which the
 * tables that hold what was sent are shadowed by TEMP tables of the same name, kept in memory
 * (temp_store = MEMORY). SQLite resolves an unqualified table name to the temp table first,
 * so the same code runs unchanged and:
 *
 * - what a private request writes (the queued message, the poll, the event...) lives only in
 *   this process's memory and is gone on restart;
 * - settings are still read from disk (webhooks, templates, groups, the reply window);
 * - any write that would reach the disk is refused by SQLite itself (SQLITE_READONLY). An
 *   API that has to store something answers 409 instead of quietly storing it.
 *
 * One private database per account, created on first use.
 */

/** Tables a private request gets its own in-memory copy of (empty at first). */
const CORE_TABLES = [
  'scheduled_messages',
  // Sending to a phone number makes a contact row: that is data about the send too
  'contacts',
  'polls',
  'poll_votes',
  'events',
  'event_responses',
];
const extraTables = new Set<string>();

/** Extensions add the tables that hold what their own sending routes store. */
export function registerPrivateTables(names: string[]): void {
  for (const n of names)
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) extraTables.add(n);
}

interface Entry {
  db: Database;
  sqlite: BetterSqlite.Database;
  shadowed: Set<string>;
}

const byDisk = new WeakMap<object, Entry>();
const diskByPrivate = new WeakMap<object, Database>();
const created: Array<(disk: Database, priv: Database) => void> = [];

/** Thrown when this account's database cannot have a private twin (it is not a file). */
export class PrivateUnavailableError extends Error {
  constructor() {
    super('Private mode needs a database file');
    this.name = 'PrivateUnavailableError';
  }
}

function clientOf(db: Database): BetterSqlite.Database {
  return (db as unknown as { $client: BetterSqlite.Database }).$client;
}

/** Copy a table's definition and indexes from disk into the temp schema, empty. */
function shadow(entry: Entry, table: string): void {
  if (entry.shadowed.has(table)) return;
  const rows = entry.sqlite
    .prepare(
      "SELECT type, sql FROM main.sqlite_master WHERE tbl_name = ? AND sql IS NOT NULL AND type IN ('table', 'index') ORDER BY type DESC",
    )
    .all(table) as Array<{ type: string; sql: string }>;
  // Not on disk yet (an extension that has not created its tables): try again next time
  if (!rows.some((r) => r.type === 'table')) return;
  for (const { type, sql } of rows) {
    entry.sqlite.exec(
      type === 'table'
        ? sql.replace(/^CREATE TABLE (IF NOT EXISTS )?/i, 'CREATE TEMP TABLE ')
        : sql.replace(
            /^CREATE (UNIQUE )?INDEX (IF NOT EXISTS )?/i,
            (_m, unique: string | undefined) =>
              `CREATE ${unique ?? ''}INDEX temp.`,
          ),
    );
  }
  entry.shadowed.add(table);
}

/** The private twin of an account's database. Throws PrivateUnavailableError for :memory:. */
export function privateDb(disk: Database): Database {
  if (diskByPrivate.has(disk)) return disk; // already private
  let entry = byDisk.get(disk);
  const isNew = !entry;
  if (!entry) {
    const client = clientOf(disk);
    if (!client?.name || client.memory) throw new PrivateUnavailableError();
    const sqlite = new BetterSqlite(client.name, { readonly: true });
    sqlite.pragma('temp_store = MEMORY');
    // The shadowed tables reference tables that stay on disk (groups): no cross-schema keys
    sqlite.pragma('foreign_keys = OFF');
    entry = { db: drizzle(sqlite, { schema }), sqlite, shadowed: new Set() };
    byDisk.set(disk, entry);
    diskByPrivate.set(entry.db, disk);
  }
  for (const t of CORE_TABLES) shadow(entry, t);
  for (const t of extraTables) shadow(entry, t);
  if (isNew) for (const fn of created) fn(disk, entry.db);
  return entry.db;
}

/** The private twin if one has been created for this database, else null. Never creates it. */
export function peekPrivateDb(disk: Database): Database | null {
  return byDisk.get(disk)?.db ?? null;
}

export function isPrivateDb(db: Database): boolean {
  return diskByPrivate.has(db);
}

/** The on-disk database behind a private one (or the database itself). For reads only. */
export function diskDbOf(db: Database): Database {
  return diskByPrivate.get(db) ?? db;
}

/** Called once for each private database, when it is created. */
export function onPrivateDb(
  fn: (disk: Database, priv: Database) => void,
): void {
  created.push(fn);
}

/**
 * Bring one existing row from disk into the private copy of a shadowed table, so a private
 * request can refer to something that already exists (a saved contact). No-op for a database
 * that is not private, or a row that is not on disk.
 */
export function adoptRow(
  db: Database,
  table: 'contacts',
  column: 'id' | 'phone',
  value: string,
): void {
  const disk = diskByPrivate.get(db);
  if (!disk) return;
  byDisk
    .get(disk)
    ?.sqlite.prepare(
      `INSERT OR IGNORE INTO temp.${table} SELECT * FROM main.${table} WHERE ${column} = ?`,
    )
    .run(value);
}

/** Close the private twin (when the account's database is being closed). */
export function closePrivateDb(disk: Database): void {
  const entry = byDisk.get(disk);
  if (!entry) return;
  byDisk.delete(disk);
  try {
    entry.sqlite.close();
  } catch {
    // Already closed
  }
}

/** The same account, as a private request sees it. Nothing is pushed to the dashboard. */
export function privateContext(ctx: AppContext): AppContext {
  if (ctx.private) return ctx;
  return {
    ...ctx,
    db: privateDb(ctx.db),
    broadcast: () => {},
    private: true,
  };
}

/** True for the error SQLite raises when a private request tries to write to disk. */
export function isDiskWriteRefused(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  return (
    !!e &&
    (String(e.code ?? '').startsWith('SQLITE_READONLY') ||
      /readonly database/i.test(String(e.message ?? '')))
  );
}
