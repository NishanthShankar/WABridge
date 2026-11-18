import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { getContext } from '../context.js';
import { toJid } from '../webhooks/jid.js';
import {
  getList,
  hasSynced,
  isBuiltIn,
  listLists,
  nextListId,
  syncLists,
} from './lists.js';

const chatRefs = z.array(z.string().min(1).max(64)).max(100);

const createSchema = z.object({
  name: z.string().trim().min(1).max(64),
  /** 0-19: WhatsApp's colour palette */
  color: z.number().int().min(0).max(19).optional(),
  /** Phones or JIDs (1:1 or group) to put in the list */
  chats: chatRefs.optional(),
});

const editSchema = z
  .object({
    name: z.string().trim().min(1).max(64).optional(),
    color: z.number().int().min(0).max(19).optional(),
  })
  .refine((v) => v.name !== undefined || v.color !== undefined, {
    message: 'Give name or color',
  });

const chatsSchema = z
  .object({ add: chatRefs.optional(), remove: chatRefs.optional() })
  .refine((v) => v.add?.length || v.remove?.length, {
    message: 'Give add or remove',
  });

const notConnected = {
  error: 'not_connected',
  message: 'WhatsApp not connected',
};
const notFound = { error: 'not_found', message: 'No list with this id' };
const builtIn = {
  error: 'built_in_list',
  message:
    "WhatsApp's own lists (Unread, Favourites, Groups, Communities) can't be changed here",
};

/**
 * /api/lists: the account's chat lists (the filters above the chat list). They are private to
 * this account: nobody in the chats sees them.
 */
export function createListsRouter() {
  const router = new Hono();

  /** GET /api/lists : every list and the chats in it, from the bridge's copy. */
  router.get('/', (c) => {
    const { db } = getContext(c);
    return c.json({ synced: hasSynced(db), lists: listLists(db) });
  });

  /**
   * POST /api/lists/sync : fetch every list again from WhatsApp. Needed once for a number
   * linked before this feature; later changes arrive by themselves.
   */
  router.post('/sync', async (c) => {
    const { db, getSocket } = getContext(c);
    const sock = getSocket();
    if (!sock) return c.json(notConnected, 503);
    try {
      await syncLists(sock, db);
    } catch (err) {
      return c.json(
        { error: 'sync_failed', message: (err as Error).message },
        502,
      );
    }
    return c.json({ synced: true, lists: listLists(db) });
  });

  router.get('/:id', (c) => {
    const list = getList(getContext(c).db, c.req.param('id'));
    return list ? c.json(list) : c.json(notFound, 404);
  });

  /** POST /api/lists {name, color?, chats?} : create a list (syncs first if never synced). */
  router.post('/', zValidator('json', createSchema), async (c) => {
    const { db, getSocket } = getContext(c);
    const input = c.req.valid('json');
    const sock = getSocket();
    if (!sock) return c.json(notConnected, 503);
    if (isBuiltIn(input.name))
      return c.json(
        {
          error: 'reserved_name',
          message: 'That name belongs to a built-in list',
        },
        400,
      );
    try {
      // The new list needs an id no existing list uses
      if (!hasSynced(db)) await syncLists(sock, db);
      if (
        listLists(db).some(
          (l) => l.name?.toLowerCase() === input.name.toLowerCase(),
        )
      )
        return c.json(
          { error: 'name_taken', message: 'A list with this name exists' },
          409,
        );
      const id = nextListId(db);
      await sock.addLabel('', {
        id,
        name: input.name,
        color: input.color ?? 0,
        deleted: false,
      });
      const failed: string[] = [];
      for (const chat of input.chats ?? []) {
        const jid = toJid(chat);
        if (!jid) failed.push(chat);
        else await sock.addChatLabel(jid, id);
      }
      return c.json(
        { ...(getList(db, id) ?? { id, name: input.name }), failed },
        201,
      );
    } catch (err) {
      return c.json(
        { error: 'create_failed', message: (err as Error).message },
        502,
      );
    }
  });

  /** PATCH /api/lists/:id {name?, color?} : rename or recolour. */
  router.patch('/:id', zValidator('json', editSchema), async (c) => {
    const { db, getSocket } = getContext(c);
    const list = getList(db, c.req.param('id'));
    if (!list) return c.json(notFound, 404);
    if (list.builtIn) return c.json(builtIn, 409);
    const input = c.req.valid('json');
    const sock = getSocket();
    if (!sock) return c.json(notConnected, 503);
    try {
      await sock.addLabel('', {
        id: list.id,
        name: input.name ?? list.name ?? '',
        color: input.color ?? list.color ?? 0,
        deleted: false,
      });
    } catch (err) {
      return c.json(
        { error: 'edit_failed', message: (err as Error).message },
        502,
      );
    }
    return c.json(getList(db, list.id));
  });

  /** DELETE /api/lists/:id : delete the list. The chats in it are not touched. */
  router.delete('/:id', async (c) => {
    const { db, getSocket } = getContext(c);
    const list = getList(db, c.req.param('id'));
    if (!list) return c.json(notFound, 404);
    if (list.builtIn) return c.json(builtIn, 409);
    const sock = getSocket();
    if (!sock) return c.json(notConnected, 503);
    try {
      await sock.addLabel('', {
        id: list.id,
        name: list.name ?? '',
        color: list.color ?? 0,
        deleted: true,
      });
    } catch (err) {
      return c.json(
        { error: 'delete_failed', message: (err as Error).message },
        502,
      );
    }
    return c.json({ deleted: true, id: list.id });
  });

  /** POST /api/lists/:id/chats {add?, remove?} : phones or JIDs, 1:1 chats or groups. */
  router.post('/:id/chats', zValidator('json', chatsSchema), async (c) => {
    const { db, getSocket } = getContext(c);
    const list = getList(db, c.req.param('id'));
    if (!list) return c.json(notFound, 404);
    if (list.builtIn) return c.json(builtIn, 409);
    const input = c.req.valid('json');
    const sock = getSocket();
    if (!sock) return c.json(notConnected, 503);
    const results: Array<{
      chat: string;
      action: 'add' | 'remove';
      ok: boolean;
      error?: string;
    }> = [];
    const work = [
      ...(input.add ?? []).map((chat) => ({ chat, action: 'add' as const })),
      ...(input.remove ?? []).map((chat) => ({
        chat,
        action: 'remove' as const,
      })),
    ];
    for (const { chat, action } of work) {
      const jid = toJid(chat);
      if (!jid) {
        results.push({
          chat,
          action,
          ok: false,
          error: 'not a phone number or JID',
        });
        continue;
      }
      try {
        if (action === 'add') await sock.addChatLabel(jid, list.id);
        else await sock.removeChatLabel(jid, list.id);
        results.push({ chat: jid, action, ok: true });
      } catch (err) {
        results.push({
          chat: jid,
          action,
          ok: false,
          error: (err as Error).message,
        });
      }
    }
    return c.json({ results, list: getList(db, list.id) });
  });

  return router;
}
