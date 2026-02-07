import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { proto, BufferJSON } from '@whiskeysockets/baileys';
import { sql } from 'drizzle-orm';

import { useSQLiteAuthState } from '../auth-state.js';
import { generateEncryptionKey } from '../../crypto/vault.js';
import { authState as authStateTable } from '../../db/schema.js';

/**
 * Create a fresh in-memory database with the auth_state schema applied.
 */
function createTestDb(): BetterSQLite3Database {
  const sqlite = new Database(':memory:');

  // Apply the schema manually (matches drizzle migration 0000_purple_shaman.sql)
  sqlite.exec(`
    CREATE TABLE auth_state (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE session_meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
  `);

  return drizzle(sqlite);
}

describe('useSQLiteAuthState', () => {
  let db: BetterSQLite3Database;
  let masterKey: string;

  beforeEach(() => {
    db = createTestDb();
    masterKey = generateEncryptionKey();
  });

  it('initializes with fresh credentials when database is empty', async () => {
    const { state } = await useSQLiteAuthState(db, masterKey);

    expect(state.creds).toBeDefined();
    // Verify expected credential fields exist
    expect(state.creds.noiseKey).toBeDefined();
    expect(state.creds.noiseKey.public).toBeInstanceOf(Uint8Array);
    expect(state.creds.noiseKey.private).toBeInstanceOf(Uint8Array);
    expect(state.creds.signedIdentityKey).toBeDefined();
    expect(state.creds.signedPreKey).toBeDefined();
    expect(typeof state.creds.registrationId).toBe('number');
    expect(typeof state.creds.advSecretKey).toBe('string');
    expect(state.creds.registered).toBe(false);
  });

  it('saveCreds persists and restores credentials', async () => {
    const { state: state1, saveCreds: saveCreds1 } =
      await useSQLiteAuthState(db, masterKey);

    // Save the initial credentials
    await saveCreds1();

    // Create a new adapter instance (simulates server restart)
    const { state: state2 } = await useSQLiteAuthState(db, masterKey);

    // Restored creds should match the originals
    expect(state2.creds.registrationId).toBe(state1.creds.registrationId);
    expect(state2.creds.advSecretKey).toBe(state1.creds.advSecretKey);
    expect(state2.creds.registered).toBe(state1.creds.registered);

    // Binary fields should roundtrip correctly via BufferJSON
    expect(Buffer.from(state2.creds.noiseKey.public)).toEqual(
      Buffer.from(state1.creds.noiseKey.public),
    );
    expect(Buffer.from(state2.creds.noiseKey.private)).toEqual(
      Buffer.from(state1.creds.noiseKey.private),
    );
    expect(Buffer.from(state2.creds.signedIdentityKey.public)).toEqual(
      Buffer.from(state1.creds.signedIdentityKey.public),
    );
  });

  it('keys.set and keys.get roundtrip for pre-identity-key', async () => {
    const { state } = await useSQLiteAuthState(db, masterKey);

    const testKey = {
      public: new Uint8Array([1, 2, 3, 4, 5]),
      private: new Uint8Array([6, 7, 8, 9, 10]),
    };

    // Set a pre-key entry
    await state.keys.set({
      'pre-key': {
        'test-id-1': testKey,
      },
    });

    // Get it back
    const result = await state.keys.get('pre-key', ['test-id-1']);

    expect(result['test-id-1']).toBeDefined();
    expect(Buffer.from(result['test-id-1'].public)).toEqual(
      Buffer.from(testKey.public),
    );
    expect(Buffer.from(result['test-id-1'].private)).toEqual(
      Buffer.from(testKey.private),
    );
  });

  it('keys.set with null deletes the entry', async () => {
    const { state } = await useSQLiteAuthState(db, masterKey);

    const testKey = {
      public: new Uint8Array([1, 2, 3]),
      private: new Uint8Array([4, 5, 6]),
    };

    // Set a key
    await state.keys.set({
      'pre-key': {
        'delete-test': testKey,
      },
    });

    // Verify it exists
    const result1 = await state.keys.get('pre-key', ['delete-test']);
    expect(result1['delete-test']).toBeDefined();

    // Delete it by setting to null
    await state.keys.set({
      'pre-key': {
        'delete-test': null as any,
      },
    });

    // Verify it's gone
    const result2 = await state.keys.get('pre-key', ['delete-test']);
    expect(result2['delete-test']).toBeUndefined();
  });

  it('stored values are encrypted (not valid JSON in raw DB)', async () => {
    const { state, saveCreds } = await useSQLiteAuthState(db, masterKey);

    // Save credentials to DB
    await saveCreds();

    // Read the raw value directly from SQLite (bypassing the adapter)
    const rawResult = db
      .select()
      .from(authStateTable)
      .where(sql`key = 'creds'`)
      .get();

    expect(rawResult).toBeDefined();
    const rawValue = rawResult!.value;

    // The raw value should NOT be valid JSON (it's encrypted ciphertext)
    let isValidJson = true;
    try {
      JSON.parse(rawValue);
    } catch {
      isValidJson = false;
    }
    expect(isValidJson).toBe(false);

    // The raw value should be in salt:iv:tag:ciphertext format
    const parts = rawValue.split(':');
    expect(parts).toHaveLength(4);
  });

  it('app-state-sync-key values are reconstructed as protobuf instances', async () => {
    const { state } = await useSQLiteAuthState(db, masterKey);

    // Create a test app-state-sync-key value
    const testKeyData = {
      keyData: new Uint8Array([10, 20, 30, 40, 50]),
      timestamp: BigInt(Date.now()),
      fingerprint: {
        rawId: 1,
        currentIndex: 0,
        deviceIndexes: [0],
      },
    };

    // Set the app-state-sync-key
    await state.keys.set({
      'app-state-sync-key': {
        'sync-key-1': proto.Message.AppStateSyncKeyData.fromObject(testKeyData),
      },
    });

    // Get it back
    const result = await state.keys.get('app-state-sync-key', ['sync-key-1']);

    expect(result['sync-key-1']).toBeDefined();

    // Verify it's a protobuf instance (has encode method)
    const value = result['sync-key-1'];
    expect(typeof proto.Message.AppStateSyncKeyData.encode).toBe('function');
    // Verify it was reconstructed via fromObject (not a plain object)
    expect(value.constructor.name).toBe('AppStateSyncKeyData');
    // Verify the data roundtripped
    expect(Buffer.from(value.keyData!)).toEqual(
      Buffer.from(testKeyData.keyData),
    );
  });

  it('handles multiple key types in a single set call', async () => {
    const { state } = await useSQLiteAuthState(db, masterKey);

    // Set multiple key types at once
    await state.keys.set({
      'pre-key': {
        key1: {
          public: new Uint8Array([1, 2]),
          private: new Uint8Array([3, 4]),
        },
      },
      session: {
        'session-1': new Uint8Array([10, 20, 30]),
      },
    });

    // Get them back
    const preKeys = await state.keys.get('pre-key', ['key1']);
    const sessions = await state.keys.get('session', ['session-1']);

    expect(preKeys['key1']).toBeDefined();
    expect(sessions['session-1']).toBeDefined();
    expect(Buffer.from(sessions['session-1'])).toEqual(
      Buffer.from(new Uint8Array([10, 20, 30])),
    );
  });

  it('returns empty object for non-existent keys', async () => {
    const { state } = await useSQLiteAuthState(db, masterKey);

    const result = await state.keys.get('pre-key', ['nonexistent']);
    expect(result['nonexistent']).toBeUndefined();
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('upserts existing keys on set', async () => {
    const { state } = await useSQLiteAuthState(db, masterKey);

    // Set initial value
    await state.keys.set({
      'pre-key': {
        upsert: {
          public: new Uint8Array([1, 1, 1]),
          private: new Uint8Array([2, 2, 2]),
        },
      },
    });

    // Update with new value
    await state.keys.set({
      'pre-key': {
        upsert: {
          public: new Uint8Array([9, 9, 9]),
          private: new Uint8Array([8, 8, 8]),
        },
      },
    });

    // Get the value - should be the updated one
    const result = await state.keys.get('pre-key', ['upsert']);
    expect(Buffer.from(result['upsert'].public)).toEqual(
      Buffer.from(new Uint8Array([9, 9, 9])),
    );
  });
});
