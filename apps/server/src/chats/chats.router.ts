import { Hono } from 'hono';
import { getContext } from '../context.js';
import { toJid } from '../webhooks/jid.js';
import {
  chatCandidates,
  getLastRead,
  getPresence,
  replyWindow,
  waitForPresence,
  watchPresence,
} from './chat-state.js';

/**
 * /api/chats/:id: what the bridge knows about one chat (phone number or JID).
 *
 * - GET /:id          — reply window, last known presence, last read receipt
 * - GET /:id/presence — ask WhatsApp for their presence now (?wait=ms, up to 5000) and return it
 */
export function createChatsRouter() {
  const router = new Hono();

  router.get('/:id', async (c) => {
    const { db, getSocket } = getContext(c);
    const jid = toJid(c.req.param('id'));
    if (!jid)
      return c.json(
        { error: 'invalid_chat', message: 'Not a phone number or JID' },
        400,
      );
    const sock = getSocket();
    const candidates = await chatCandidates(sock, jid);
    return c.json({
      chatId: jid,
      replyWindow: replyWindow(db, candidates),
      presence: sock ? getPresence(sock, candidates) : null,
      lastRead: sock ? getLastRead(sock, candidates) : null,
    });
  });

  router.get('/:id/presence', async (c) => {
    const { getSocket } = getContext(c);
    const jid = toJid(c.req.param('id'));
    if (!jid)
      return c.json(
        { error: 'invalid_chat', message: 'Not a phone number or JID' },
        400,
      );
    const sock = getSocket();
    if (!sock)
      return c.json(
        { error: 'not_connected', message: 'WhatsApp not connected' },
        503,
      );
    const candidates = await chatCandidates(sock, jid);
    const wait = Math.min(Math.max(Number(c.req.query('wait')) || 0, 0), 5000);
    const before = new Date().toISOString();
    try {
      await watchPresence(sock, jid);
    } catch (err) {
      return c.json(
        { error: 'presence_failed', message: (err as Error).message },
        502,
      );
    }
    const presence = wait
      ? await waitForPresence(sock, candidates, before, wait)
      : getPresence(sock, candidates);
    return c.json({
      chatId: jid,
      presence,
      /** false: nothing new arrived while waiting (hidden by their privacy settings, or not sent yet) */
      fresh: !!presence && presence.at > before,
    });
  });

  return router;
}
