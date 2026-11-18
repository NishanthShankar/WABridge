import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { getContext } from '../context.js';
import {
  DISAPPEARING,
  applyChatActions,
  chatActionsSchema,
  defaultDisappearingSchema,
  phoneNumberSchema,
} from './chat-actions.js';
import { isGroupJid } from '../webhooks/jid.js';
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
 * - PATCH /:id        — pin, archive, mute, mark read/unread, disappearing-messages timer
 * - PUT /disappearing-default — the timer for chats this account starts from now on
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

  router.patch('/:id', zValidator('json', chatActionsSchema), async (c) => {
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
    const result = await applyChatActions(
      sock,
      jid,
      await chatCandidates(sock, jid),
      c.req.valid('json'),
    );
    if (result.applied.length === 0)
      return c.json(
        {
          error: 'not_changed',
          message: 'WhatsApp refused every change',
          chatId: jid,
          ...result,
        },
        502,
      );
    return c.json({ chatId: jid, ...result });
  });

  // Share this account's phone number with a chat, or ask the chat for theirs. For 1:1 chats
  // where WhatsApp hides numbers (the chat shows as a LID or a username).
  router.post(
    '/:id/phone-number',
    zValidator('json', phoneNumberSchema),
    async (c) => {
      const { getSocket } = getContext(c);
      const jid = toJid(c.req.param('id'));
      if (!jid || isGroupJid(jid))
        return c.json(
          {
            error: 'invalid_chat',
            message: 'Give the phone number or JID of a 1:1 chat',
          },
          400,
        );
      const sock = getSocket();
      if (!sock)
        return c.json(
          { error: 'not_connected', message: 'WhatsApp not connected' },
          503,
        );
      const { action } = c.req.valid('json');
      try {
        const sent = await sock.sendMessage(
          jid,
          action === 'share'
            ? { sharePhoneNumber: true }
            : { requestPhoneNumber: true },
        );
        return c.json({
          chatId: jid,
          action,
          messageId: sent?.key?.id ?? null,
        });
      } catch (err) {
        return c.json(
          { error: 'send_failed', message: (err as Error).message },
          502,
        );
      }
    },
  );

  router.put(
    '/disappearing-default',
    zValidator('json', defaultDisappearingSchema),
    async (c) => {
      const { getSocket } = getContext(c);
      const sock = getSocket();
      if (!sock)
        return c.json(
          { error: 'not_connected', message: 'WhatsApp not connected' },
          503,
        );
      const { disappearing } = c.req.valid('json');
      try {
        await sock.updateDefaultDisappearingMode(DISAPPEARING[disappearing]);
      } catch (err) {
        return c.json(
          { error: 'not_changed', message: (err as Error).message },
          502,
        );
      }
      return c.json({ disappearingDefault: disappearing });
    },
  );

  return router;
}
