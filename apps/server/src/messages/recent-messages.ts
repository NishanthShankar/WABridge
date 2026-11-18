import type makeWASocket from '@whiskeysockets/baileys';
import {
  type WAMessage,
  normalizeMessageContent,
} from '@whiskeysockets/baileys';

type WASocket = ReturnType<typeof makeWASocket>;

/**
 * Recent messages held in memory, so POST /api/messages/forward can pass one on, and edit and
 * delete can tell when a message is too old.
 *
 * WhatsApp forwards a message by sending its content again, which needs the original message
 * (for media: its keys on WhatsApp's servers, so nothing is downloaded or uploaded). The bridge
 * does not store message content in its database, so it keeps the last MAX_PER_SOCKET messages
 * seen on this connection, for at most MAX_AGE_MS, in memory only. Nothing here is logged or
 * written to disk, and it is gone after a restart.
 */
export const MAX_PER_SOCKET = 2000;
export const MAX_AGE_MS = 72 * 3_600_000; // longer than the delete window (60 h)

interface Entry {
  msg: WAMessage;
  at: number;
}

const stores = new WeakMap<object, Map<string, Entry>>();

const keyOf = (chatId: string, messageId: string) => `${chatId}|${messageId}`;

function storeFor(sock: object): Map<string, Entry> {
  let store = stores.get(sock);
  if (!store) {
    store = new Map();
    stores.set(sock, store);
  }
  return store;
}

/** Worth keeping: real content, not edits, deletes, reactions, poll votes or key exchanges. */
function forwardable(msg: WAMessage): boolean {
  const content = normalizeMessageContent(msg.message);
  if (!content || !msg.key?.remoteJid || !msg.key.id) return false;
  return !(
    content.protocolMessage ||
    content.reactionMessage ||
    content.pollUpdateMessage ||
    (!!content.senderKeyDistributionMessage &&
      Object.keys(content).length === 1)
  );
}

/** Seconds since the epoch at which WhatsApp says the message was sent, if known. */
function sentAtMs(msg: WAMessage, fallback: number): number {
  const ts = msg.messageTimestamp;
  const n = typeof ts === 'number' ? ts : ts ? Number(ts) : 0;
  return n > 0 ? n * 1000 : fallback;
}

export function rememberMessage(
  sock: object,
  msg: WAMessage,
  now = Date.now(),
): void {
  if (!forwardable(msg)) return;
  const store = storeFor(sock);
  const k = keyOf(msg.key.remoteJid as string, msg.key.id as string);
  store.delete(k); // re-insert so the newest stays last
  store.set(k, { msg, at: sentAtMs(msg, now) });
  while (store.size > MAX_PER_SOCKET) {
    const oldest = store.keys().next().value as string;
    store.delete(oldest);
  }
}

/** The message, if it was seen on this connection in the last MAX_AGE_MS. */
export function findMessage(
  sock: object,
  chatIds: string[],
  messageId: string,
  now = Date.now(),
): { msg: WAMessage; sentAt: number } | null {
  const store = stores.get(sock);
  if (!store) return null;
  for (const chatId of chatIds) {
    const k = keyOf(chatId, messageId);
    const hit = store.get(k);
    if (!hit) continue;
    if (now - hit.at > MAX_AGE_MS) {
      store.delete(k);
      return null;
    }
    return { msg: hit.msg, sentAt: hit.at };
  }
  return null;
}

/**
 * Remember every message this connection sees: incoming ones and the ones it sends itself
 * (Baileys reports its own sends as 'append'). History sync is skipped.
 */
export function setupRecentMessages(sock: WASocket): void {
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    for (const msg of messages) rememberMessage(sock, msg);
  });
}

/** The newest message held for this chat (any of its JIDs), for archive and mark-read. */
export function lastMessageIn(
  sock: object,
  chatIds: string[],
  now = Date.now(),
): WAMessage | null {
  const store = stores.get(sock);
  if (!store) return null;
  const wanted = new Set(chatIds);
  let best: Entry | null = null;
  for (const entry of store.values()) {
    if (
      !wanted.has(entry.msg.key.remoteJid as string) ||
      now - entry.at > MAX_AGE_MS
    )
      continue;
    if (!best || entry.at >= best.at) best = entry;
  }
  return best?.msg ?? null;
}
