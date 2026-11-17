import type makeWASocket from '@whiskeysockets/baileys';
import type { Logger } from 'pino';
import type { createDatabase } from '../db/client.js';
import { REPLY_WINDOW_MS, lastInbound } from '../webhooks/chat-activity.js';
import { isGroupJid, jidToPhone, toJid } from '../webhooks/jid.js';
import { fireWebhook, resolvePhone } from '../webhooks/webhook.listener.js';
import { createWebhooksService } from '../webhooks/webhooks.service.js';

type Database = ReturnType<typeof createDatabase>;
type WASocket = ReturnType<typeof makeWASocket>;

// ─── Reply window ────────────────────────────────────────────────────────────

export interface ReplyWindow {
  open: boolean;
  /** When this chat last wrote, voted or reacted; null if never seen */
  lastInboundAt: string | null;
  /** When POST /api/reply stops working for this chat unless they write again */
  closesAt: string | null;
  /** Seconds since lastInboundAt: a small number means they are likely looking at the chat */
  secondsSinceInbound: number | null;
}

/** The JIDs a chat may be recorded under: the chat itself and, for a 1:1 phone JID, its LID. */
export async function chatCandidates(
  sock: WASocket | null | undefined,
  jid: string,
): Promise<string[]> {
  const out = [jid];
  if (sock && !isGroupJid(jid) && jid.endsWith('@s.whatsapp.net')) {
    const lid = await sock.signalRepository.lidMapping
      .getLIDForPN(jid)
      .catch(() => null);
    if (lid) out.push(`${jidToPhone(lid)}@lid`);
  }
  return out;
}

export function replyWindow(
  db: Database,
  candidates: string[],
  now = Date.now(),
): ReplyWindow {
  const last = lastInbound(db, candidates);
  if (!last)
    return {
      open: false,
      lastInboundAt: null,
      closesAt: null,
      secondsSinceInbound: null,
    };
  const closes = last.getTime() + REPLY_WINDOW_MS;
  return {
    open: now < closes,
    lastInboundAt: last.toISOString(),
    closesAt: new Date(closes).toISOString(),
    secondsSinceInbound: Math.max(0, Math.round((now - last.getTime()) / 1000)),
  };
}

// ─── Presence and read receipts (kept in memory, per connection) ─────────────

export interface PresenceInfo {
  /** available | unavailable | composing | recording | paused */
  presence: string;
  /** Last seen (ISO) when WhatsApp gave it; usually only with "unavailable" */
  lastSeen: string | null;
  /** When the bridge received this */
  at: string;
}

export interface ReadInfo {
  messageId: string;
  status: 'read' | 'played';
  /** Who read it (phone or LID digits); in groups, the member */
  by: string;
  at: string;
}

interface ChatState {
  presence: Map<string, PresenceInfo>;
  lastRead: Map<string, ReadInfo>;
  /** When we last asked WhatsApp to send a chat's presence */
  subscribedAt: Map<string, number>;
  /** "messageId|reader": read events already reported */
  seenReads: Set<string>;
}

const states = new WeakMap<object, ChatState>();

function stateFor(sock: object): ChatState {
  let s = states.get(sock);
  if (!s) {
    s = {
      presence: new Map(),
      lastRead: new Map(),
      subscribedAt: new Map(),
      seenReads: new Set(),
    };
    states.set(sock, s);
  }
  return s;
}

function bare(jid: string): string {
  const [user, server] = jid.split('@');
  return `${user.split(':')[0]}@${server}`;
}

/** Ask WhatsApp to send this chat's presence for a while. Renewed at most once a minute. */
export async function watchPresence(
  sock: WASocket,
  jid: string,
): Promise<void> {
  const s = stateFor(sock);
  const last = s.subscribedAt.get(jid) ?? 0;
  if (Date.now() - last < 60_000) return;
  s.subscribedAt.set(jid, Date.now());
  await sock.presenceSubscribe(jid);
}

export function getPresence(
  sock: object,
  candidates: string[],
): PresenceInfo | null {
  const s = stateFor(sock);
  let best: PresenceInfo | null = null;
  for (const j of candidates) {
    const p = s.presence.get(j);
    if (p && (!best || p.at > best.at)) best = p;
  }
  return best;
}

export function getLastRead(
  sock: object,
  candidates: string[],
): ReadInfo | null {
  const s = stateFor(sock);
  let best: ReadInfo | null = null;
  for (const j of candidates) {
    const r = s.lastRead.get(j);
    if (r && (!best || r.at > best.at)) best = r;
  }
  return best;
}

/** Wait up to ms for a presence newer than `since` to arrive. */
export async function waitForPresence(
  sock: object,
  candidates: string[],
  since: string,
  ms: number,
): Promise<PresenceInfo | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const p = getPresence(sock, candidates);
    if (p && p.at > since) return p;
    await new Promise((r) => setTimeout(r, 200));
  }
  return getPresence(sock, candidates);
}

/**
 * Record presence updates and read receipts, and report them to catch-all webhooks with
 * allEvents as presence.update and message.read. Attach on every connection.
 */
export function setupChatStateListener(
  sock: WASocket,
  db: Database,
  logger: Logger,
): void {
  const s = stateFor(sock);
  const service = createWebhooksService(db);
  const fire = (payload: Record<string, unknown>) => {
    for (const hook of service.getAllEvents())
      fireWebhook(hook, payload, logger);
  };

  sock.ev.on('presence.update', async ({ id, presences }) => {
    try {
      const chatId = bare(id);
      const isGroup = isGroupJid(chatId);
      for (const [participant, data] of Object.entries(presences)) {
        const who = bare(participant);
        const info: PresenceInfo = {
          presence: data.lastKnownPresence,
          lastSeen: data.lastSeen
            ? new Date(data.lastSeen * 1000).toISOString()
            : null,
          at: new Date().toISOString(),
        };
        // 1:1: the chat and the person are the same; remember it under both forms
        s.presence.set(who, info);
        if (!isGroup) s.presence.set(chatId, info);
        const phone = await resolvePhone(who, sock, logger).catch(() =>
          jidToPhone(who),
        );
        if (!isGroup && phone) s.presence.set(`${phone}@s.whatsapp.net`, info);
        fire({
          event: 'presence.update',
          timestamp: info.at,
          chatId,
          isGroup,
          from: phone,
          presence: info.presence,
          lastSeen: info.lastSeen,
        });
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'presence.update failed');
    }
  });

  const recordRead = async (
    chatJid: string,
    readerJid: string,
    messageId: string,
    status: 'read' | 'played',
    atMs: number,
  ) => {
    const key = `${messageId}|${bare(readerJid)}|${status}`;
    if (s.seenReads.has(key)) return;
    s.seenReads.add(key);
    if (s.seenReads.size > 20_000) s.seenReads.clear();
    const chatId = bare(chatJid);
    const isGroup = isGroupJid(chatId);
    const phone = await resolvePhone(bare(readerJid), sock, logger).catch(() =>
      jidToPhone(readerJid),
    );
    const info: ReadInfo = {
      messageId,
      status,
      by: phone,
      at: new Date(atMs).toISOString(),
    };
    s.lastRead.set(chatId, info);
    if (!isGroup && phone) s.lastRead.set(`${phone}@s.whatsapp.net`, info);
    fire({
      event: 'message.read',
      timestamp: new Date().toISOString(),
      chatId,
      isGroup,
      from: phone,
      messageId,
      status,
      readAt: info.at,
    });
  };

  // 1:1 chats: our message's status goes to READ (4) or PLAYED (5, voice notes)
  sock.ev.on('messages.update', async (updates) => {
    for (const { key, update } of updates) {
      try {
        if (!key.fromMe || !key.id || !key.remoteJid) continue;
        if (key.remoteJid === 'status@broadcast' || isGroupJid(key.remoteJid))
          continue;
        if (update.status !== 4 && update.status !== 5) continue;
        await recordRead(
          key.remoteJid,
          key.remoteJid,
          key.id,
          update.status === 5 ? 'played' : 'read',
          Date.now(),
        );
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'read receipt failed');
      }
    }
  });

  // Groups (and some 1:1s): a receipt per reader
  sock.ev.on('message-receipt.update', async (updates) => {
    for (const { key, receipt } of updates) {
      try {
        if (!key.fromMe || !key.id || !key.remoteJid) continue;
        if (key.remoteJid === 'status@broadcast') continue;
        const reader = receipt.userJid;
        if (!reader) continue;
        const played = Number(receipt.playedTimestamp ?? 0);
        const read = Number(receipt.readTimestamp ?? 0);
        if (played)
          await recordRead(
            key.remoteJid,
            reader,
            key.id,
            'played',
            played * 1000,
          );
        else if (read)
          await recordRead(key.remoteJid, reader, key.id, 'read', read * 1000);
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'read receipt failed');
      }
    }
  });
}

export function chatJidFrom(input: string): string | null {
  return toJid(input);
}
