import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  encrypt as vaultEncrypt,
  decrypt as vaultDecrypt,
} from '../crypto/vault.js';
import { authState as authStateTable } from '../db/schema.js';

/**
 * Custom Baileys auth state adapter backed by encrypted SQLite.
 *
 * Replaces the built-in `useMultiFileAuthState` (which is not for production).
 * Stores all credentials and Signal keys in the `auth_state` table, encrypted
 * with AES-256-GCM via the vault module.
 *
 * IMPORTANT implementation notes:
 * - Uses `BufferJSON.replacer/reviver` for all serialization to preserve binary data
 * - Reconstructs `app-state-sync-key` entries with `proto.Message.AppStateSyncKeyData.fromObject()`
 *   because protobuf instances lose their prototype chain on JSON roundtrip
 * - Uses Drizzle transactions in `keys.set()` to prevent partial writes
 */
export async function useSQLiteAuthState(
  db: BetterSQLite3Database,
  masterKey: string,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  // Create bound encrypt/decrypt closures with the master key
  const encryptValue = (data: string): string =>
    vaultEncrypt(data, masterKey);
  const decryptValue = (data: string): string =>
    vaultDecrypt(data, masterKey);

  /**
   * Read credentials from the database, or initialize fresh ones.
   */
  const readCreds = (): AuthenticationCreds => {
    const row = db
      .select()
      .from(authStateTable)
      .where(eq(authStateTable.key, 'creds'))
      .get();

    if (row) {
      const decrypted = decryptValue(row.value);
      return JSON.parse(decrypted, BufferJSON.reviver);
    }

    return initAuthCreds();
  };

  const creds = readCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(
          type: T,
          ids: string[],
        ) => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {};

          for (const id of ids) {
            const row = db
              .select()
              .from(authStateTable)
              .where(eq(authStateTable.key, `${type}-${id}`))
              .get();

            if (row) {
              let value = JSON.parse(
                decryptValue(row.value),
                BufferJSON.reviver,
              );

              // Protobuf instances lose their prototype chain on JSON roundtrip.
              // Reconstruct app-state-sync-key entries as protobuf instances.
              if (type === 'app-state-sync-key' && value) {
                value =
                  proto.Message.AppStateSyncKeyData.fromObject(value);
              }

              data[id] = value;
            }
          }

          return data;
        },

        set: async (data: SignalDataSet) => {
          db.transaction((tx) => {
            for (const category in data) {
              const categoryData =
                data[category as keyof SignalDataTypeMap];
              if (!categoryData) continue;

              for (const id in categoryData) {
                const value =
                  categoryData[id as keyof typeof categoryData];
                const key = `${category}-${id}`;

                if (value) {
                  const encrypted = encryptValue(
                    JSON.stringify(value, BufferJSON.replacer),
                  );
                  tx.insert(authStateTable)
                    .values({
                      key,
                      value: encrypted,
                      updatedAt: new Date(),
                    })
                    .onConflictDoUpdate({
                      target: authStateTable.key,
                      set: {
                        value: encrypted,
                        updatedAt: new Date(),
                      },
                    })
                    .run();
                } else {
                  tx.delete(authStateTable)
                    .where(eq(authStateTable.key, key))
                    .run();
                }
              }
            }
          });
        },
      },
    },

    saveCreds: async () => {
      const encrypted = encryptValue(
        JSON.stringify(creds, BufferJSON.replacer),
      );
      db.insert(authStateTable)
        .values({
          key: 'creds',
          value: encrypted,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: authStateTable.key,
          set: {
            value: encrypted,
            updatedAt: new Date(),
          },
        })
        .run();
    },
  };
}
