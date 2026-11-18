import type makeWASocket from '@whiskeysockets/baileys';
import { and, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { createDatabase } from '../db/client.js';
import { chatListChats, chatLists } from '../db/schema.js';
import { isGroupJid, jidToPhone } from '../webhooks/jid.js';
import { fireWebhook } from '../webhooks/webhook.listener.js';
import { createWebhooksService } from '../webhooks/webhooks.service.js';

type Database = ReturnType<typeof createDatabase>;
type WASocket = ReturnType<typeof makeWASocket>;

/**
 * Chat lists: the filters above the chat list (Unread, Favourites, Groups, custom lists such
 * as "RT"). WhatsApp keeps them as labels synced between the account's own devices, so they
 * are private to this account. Baileys can create labels and put chats in them; the bridge
 * keeps a copy (chat_lists, chat_list_chats) from the sync events.
 */

/** WhatsApp's own lists. They fill themselves, so the API doesn't rename, delete or fill them. */
const BUILT_IN = new Set([
  'unread',
  'favourites',
  'favorites',
  'groups',
  'communities',
]);

/** Names can carry invisible direction marks (e.g. "‎Unread"). */
export function cleanName(name: string | null | undefined): string | null {
  if (name == null) return null;
  return name.replace(/[‎‏‪-‮⁦-⁩]/g, '').trim();
}

export function isBuiltIn(name: string | null | undefined): boolean {
  return BUILT_IN.has((cleanName(name) ?? '').toLowerCase());
}

/** While a full sync runs, changes are recorded but not reported as webhooks. */
const syncing = new WeakSet<object>();

function notify(
  db: Database,
  logger: Logger,
  payload: Record<string, unknown>,
) {
  const hooks = createWebhooksService(db).getAllEvents();
  const body = {
    event: 'list.updated',
    timestamp: new Date().toISOString(),
    ...payload,
  };
  for (const hook of hooks) fireWebhook(hook, body, logger);
}

/** Record a label (list) change. Returns what changed, or null if nothing did. */
export function applyListEdit(
  db: Database,
  label: {
    id: string;
    name?: string | null;
    color?: number | null;
    predefinedId?: string | null;
    deleted?: boolean | null;
  },
): 'created' | 'edited' | 'deleted' | null {
  const before = db
    .select()
    .from(chatLists)
    .where(eq(chatLists.id, label.id))
    .get();
  const next = {
    name: cleanName(label.name) ?? before?.name ?? null,
    color: label.color ?? before?.color ?? null,
    predefinedId: label.predefinedId ?? before?.predefinedId ?? null,
    deleted: !!label.deleted,
  };
  if (
    before &&
    before.name === next.name &&
    before.color === next.color &&
    before.predefinedId === next.predefinedId &&
    before.deleted === next.deleted
  )
    return null;
  db.insert(chatLists)
    .values({ id: label.id, ...next, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: chatLists.id,
      set: { ...next, updatedAt: new Date() },
    })
    .run();
  if (next.deleted) {
    db.delete(chatListChats).where(eq(chatListChats.listId, label.id)).run();
    return 'deleted';
  }
  return before && !before.deleted ? 'edited' : 'created';
}

/** Record a chat joining or leaving a list. Returns true if anything changed. */
export function applyListChat(
  db: Database,
  listId: string,
  chatJid: string,
  add: boolean,
): boolean {
  const where = and(
    eq(chatListChats.listId, listId),
    eq(chatListChats.chatJid, chatJid),
  );
  const exists = !!db.select().from(chatListChats).where(where).get();
  if (add === exists) return false;
  if (add) db.insert(chatListChats).values({ listId, chatJid }).run();
  else db.delete(chatListChats).where(where).run();
  return true;
}

/**
 * Keep the bridge's copy up to date and report changes made anywhere (the phone, WhatsApp
 * Web, this API) as list.updated webhooks to allEvents catch-alls. Attach on every connection.
 */
export function setupListListener(
  sock: WASocket,
  db: Database,
  logger: Logger,
): void {
  sock.ev.on('labels.edit', (label) => {
    try {
      const change = applyListEdit(db, label);
      if (!change || syncing.has(db)) return;
      const row = db
        .select()
        .from(chatLists)
        .where(eq(chatLists.id, label.id))
        .get();
      notify(db, logger, {
        change,
        listId: label.id,
        name: row?.name ?? null,
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'labels.edit failed');
    }
  });

  sock.ev.on('labels.association', ({ type, association }) => {
    try {
      // Message labels (WhatsApp Business) are not lists
      if (!('chatId' in association) || 'messageId' in association) return;
      const add = type === 'add';
      if (
        !applyListChat(db, association.labelId, association.chatId, add) ||
        syncing.has(db)
      )
        return;
      const list = db
        .select()
        .from(chatLists)
        .where(eq(chatLists.id, association.labelId))
        .get();
      notify(db, logger, {
        change: add ? 'chat_added' : 'chat_removed',
        listId: association.labelId,
        name: list?.name ?? null,
        chatId: association.chatId,
        isGroup: isGroupJid(association.chatId),
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'labels.association failed');
    }
  });
}

/**
 * Fetch every list again from WhatsApp. Clearing the saved version of the 'regular'
 * collection makes WhatsApp send the whole collection instead of only recent changes.
 * Read-only on WhatsApp's side; webhooks are not fired for what it replays.
 */
export async function syncLists(sock: WASocket, db: Database): Promise<void> {
  syncing.add(db);
  try {
    await sock.authState.keys.set({
      'app-state-sync-version': { regular: null },
    });
    await sock.resyncAppState(['regular'], true);
  } finally {
    syncing.delete(db);
  }
}

export function hasSynced(db: Database): boolean {
  return !!db.select({ id: chatLists.id }).from(chatLists).limit(1).get();
}

export interface ListView {
  id: string;
  name: string | null;
  color: number | null;
  builtIn: boolean;
  chats: Array<{ chatId: string; phone: string | null; isGroup: boolean }>;
}

function view(
  row: typeof chatLists.$inferSelect,
  chats: Array<typeof chatListChats.$inferSelect>,
): ListView {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    builtIn: isBuiltIn(row.name),
    chats: chats
      .filter((c) => c.listId === row.id)
      .sort((a, b) => a.chatJid.localeCompare(b.chatJid))
      .map((c) => ({
        chatId: c.chatJid,
        phone: c.chatJid.endsWith('@s.whatsapp.net')
          ? jidToPhone(c.chatJid)
          : null,
        isGroup: isGroupJid(c.chatJid),
      })),
  };
}

export function listLists(db: Database): ListView[] {
  const chats = db.select().from(chatListChats).all();
  return db
    .select()
    .from(chatLists)
    .all()
    .filter((l) => !l.deleted)
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((l) => view(l, chats));
}

export function getList(db: Database, id: string): ListView | null {
  const row = db.select().from(chatLists).where(eq(chatLists.id, id)).get();
  if (!row || row.deleted) return null;
  return view(
    row,
    db.select().from(chatListChats).where(eq(chatListChats.listId, id)).all(),
  );
}

/** The next free label id. Deleted lists keep their id, so it is never reused. */
export function nextListId(db: Database): string {
  const ids = db
    .select({ id: chatLists.id })
    .from(chatLists)
    .all()
    .map((r) => Number(r.id))
    .filter((n) => Number.isFinite(n));
  return String(Math.max(0, ...ids) + 1);
}
