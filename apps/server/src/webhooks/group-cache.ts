import type makeWASocket from '@whiskeysockets/baileys';
import type { GroupMetadata } from '@whiskeysockets/baileys';
import type { Logger } from 'pino';

type WASocket = ReturnType<typeof makeWASocket>;

const TTL_MS = 5 * 60 * 1000;

export interface GroupCache {
  get(jid: string): Promise<GroupMetadata | null>;
  set(meta: GroupMetadata): void;
  invalidate(jid: string): void;
}

/** Group metadata (name, participants) cached for five minutes, so each message doesn't cost a query. */
export function createGroupCache(sock: WASocket, logger: Logger): GroupCache {
  const cache = new Map<string, { meta: GroupMetadata; at: number }>();
  return {
    async get(jid) {
      const hit = cache.get(jid);
      if (hit && Date.now() - hit.at < TTL_MS) return hit.meta;
      try {
        const meta = await sock.groupMetadata(jid);
        cache.set(jid, { meta, at: Date.now() });
        return meta;
      } catch (err) {
        logger.warn(
          { err: (err as Error).message },
          'Could not load group metadata',
        );
        return hit?.meta ?? null;
      }
    },
    set(meta) {
      cache.set(meta.id, { meta, at: Date.now() });
    },
    invalidate(jid) {
      cache.delete(jid);
    },
  };
}
