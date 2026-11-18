import { zValidator } from '@hono/zod-validator';
import {
  type WAMessageKey,
  normalizeMessageContent,
} from '@whiskeysockets/baileys';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { chatCandidates, replyWindow } from '../chats/chat-state.js';
import { type AppContext, getContext } from '../context.js';
import { contacts, scheduledMessages } from '../db/schema.js';
import { isGroupJid, toJid } from '../webhooks/jid.js';
import {
  deleteSentSchema,
  editSentSchema,
  PIN_SECONDS,
  forwardSchema,
  pinMessageSchema,
  starSchema,
} from './message-actions.schema.js';
import { findMessage, rememberMessage } from './recent-messages.js';

/** WhatsApp lets the sender edit a message for 15 minutes. */
export const EDIT_WINDOW_MS = 15 * 60_000;
/** Delete for everyone works for about two and a half days. */
export const DELETE_WINDOW_MS = 60 * 3_600_000;
/** Forwards per destination chat per minute, so a loop in a client can't flood a chat. */
const FORWARDS_PER_CHAT_PER_MINUTE = 12;

interface Resolved {
  jid: string;
  messageId: string;
  /** Row of POST /api/messages, when the message was named by scheduledMessageId */
  scheduledId: string | null;
  /** When it was sent, if the bridge knows */
  sentAt: number | null;
}

type Fail = { error: string; message: string; status: 400 | 404 | 409 };

/** Turn { chatId | phone, messageId } or { scheduledMessageId } into a chat JID and message id. */
function resolveTarget(
  ctx: AppContext,
  input: {
    chatId?: string;
    phone?: string;
    messageId?: string;
    scheduledMessageId?: string;
  },
): Resolved | Fail {
  if (input.scheduledMessageId) {
    const row = ctx.db
      .select()
      .from(scheduledMessages)
      .where(eq(scheduledMessages.id, input.scheduledMessageId))
      .get();
    if (!row)
      return {
        error: 'not_found',
        message: 'No message with that scheduledMessageId',
        status: 404,
      };
    if (!row.whatsappMessageId)
      return {
        error: 'not_sent',
        message: `This message has not been sent (status: ${row.status})`,
        status: 409,
      };
    let jid: string | null = row.groupId;
    if (!jid && row.contactId) {
      const contact = ctx.db
        .select()
        .from(contacts)
        .where(eq(contacts.id, row.contactId))
        .get();
      jid = contact ? toJid(contact.phone) : null;
    }
    if (!jid)
      return {
        error: 'not_found',
        message: 'The chat of this message no longer exists',
        status: 404,
      };
    return {
      jid,
      messageId: row.whatsappMessageId,
      scheduledId: row.id,
      sentAt: row.sentAt ? row.sentAt.getTime() : null,
    };
  }
  const jid = toJid(input.chatId ?? input.phone ?? '');
  if (!jid)
    return {
      error: 'invalid_chat',
      message: 'chatId or phone is not valid',
      status: 400,
    };
  return {
    jid,
    messageId: input.messageId as string,
    scheduledId: null,
    sentAt: null,
  };
}

const isFail = (r: Resolved | Fail): r is Fail => 'error' in r;

/**
 * Act on messages that were already sent:
 *
 * - POST /api/messages/edit     change the text of a message this account sent (15 minutes)
 * - POST /api/messages/delete   delete a message for everyone (own messages; others' as group admin)
 * - POST /api/messages/forward  forward a recent message to another chat or group
 * - POST /api/messages/star     star or unstar a message on this account
 * - POST /api/messages/pin      pin a message at the top of its chat for everyone, or unpin it
 *
 * Message text is never logged.
 */
export function createMessageActionsRouter() {
  const router = new Hono();
  const forwards = new Map<string, number[]>();

  router.post('/edit', zValidator('json', editSentSchema), async (c) => {
    const ctx = getContext(c);
    const input = c.req.valid('json');
    const target = resolveTarget(ctx, input);
    if (isFail(target))
      return c.json(
        { error: target.error, message: target.message },
        target.status,
      );

    const sock = ctx.getSocket();
    if (!sock)
      return c.json(
        { error: 'not_connected', message: 'WhatsApp not connected' },
        503,
      );

    const cached = findMessage(
      sock,
      await chatCandidates(sock, target.jid),
      target.messageId,
    );
    if (cached && !cached.msg.key.fromMe)
      return c.json(
        {
          error: 'not_own_message',
          message: 'Only messages this account sent can be edited',
        },
        409,
      );
    const content = cached ? normalizeMessageContent(cached.msg.message) : null;
    if (content && !content.conversation && !content.extendedTextMessage)
      return c.json(
        {
          error: 'not_text',
          message: 'Only text messages can be edited, not media or polls',
        },
        409,
      );
    const sentAt = target.sentAt ?? cached?.sentAt ?? null;
    if (sentAt && Date.now() - sentAt > EDIT_WINDOW_MS)
      return c.json(
        {
          error: 'edit_window_closed',
          message: 'WhatsApp only allows edits for 15 minutes after sending',
        },
        409,
      );

    const key: WAMessageKey = {
      remoteJid: target.jid,
      id: target.messageId,
      fromMe: true,
    };
    try {
      await sock.sendMessage(target.jid, { text: input.text, edit: key });
    } catch (err) {
      return c.json(
        { error: 'send_failed', message: (err as Error).message },
        502,
      );
    }
    // A later forward should pass on the edited text, not the original.
    if (cached) cached.msg.message = { conversation: input.text };
    if (target.scheduledId)
      ctx.db
        .update(scheduledMessages)
        .set({ content: input.text, updatedAt: new Date() })
        .where(eq(scheduledMessages.id, target.scheduledId))
        .run();
    return c.json({
      edited: true,
      chatId: target.jid,
      messageId: target.messageId,
    });
  });

  router.post('/delete', zValidator('json', deleteSentSchema), async (c) => {
    const ctx = getContext(c);
    const input = c.req.valid('json');
    const target = resolveTarget(ctx, input);
    if (isFail(target))
      return c.json(
        { error: target.error, message: target.message },
        target.status,
      );

    const fromMe = input.fromMe !== false;
    let participant: string | undefined;
    if (!fromMe) {
      if (!isGroupJid(target.jid))
        return c.json(
          {
            error: 'not_group',
            message:
              "Someone else's message can only be deleted in a group, as admin",
          },
          400,
        );
      participant = toJid(input.participant ?? '') ?? undefined;
      if (!participant)
        return c.json(
          { error: 'invalid_participant', message: 'participant is not valid' },
          400,
        );
    }

    const sock = ctx.getSocket();
    if (!sock)
      return c.json(
        { error: 'not_connected', message: 'WhatsApp not connected' },
        503,
      );

    const cached = findMessage(
      sock,
      await chatCandidates(sock, target.jid),
      target.messageId,
    );
    const sentAt = target.sentAt ?? cached?.sentAt ?? null;
    if (fromMe && sentAt && Date.now() - sentAt > DELETE_WINDOW_MS)
      return c.json(
        {
          error: 'delete_window_closed',
          message:
            'WhatsApp only deletes for everyone for about two and a half days after sending',
        },
        409,
      );

    const key: WAMessageKey = {
      remoteJid: target.jid,
      id: target.messageId,
      fromMe,
      participant,
    };
    try {
      await sock.sendMessage(target.jid, { delete: key });
    } catch (err) {
      return c.json(
        { error: 'send_failed', message: (err as Error).message },
        502,
      );
    }
    return c.json({
      deleted: true,
      chatId: target.jid,
      messageId: target.messageId,
    });
  });

  router.post('/forward', zValidator('json', forwardSchema), async (c) => {
    const ctx = getContext(c);
    const input = c.req.valid('json');
    const target = resolveTarget(ctx, input);
    if (isFail(target))
      return c.json(
        { error: target.error, message: target.message },
        target.status,
      );

    const to = toJid(input.toChatId ?? input.toPhone ?? '');
    if (!to)
      return c.json(
        { error: 'invalid_chat', message: 'toChatId or toPhone is not valid' },
        400,
      );

    const sock = ctx.getSocket();
    if (!sock)
      return c.json(
        { error: 'not_connected', message: 'WhatsApp not connected' },
        503,
      );

    const cached = findMessage(
      sock,
      await chatCandidates(sock, target.jid),
      target.messageId,
    );
    if (!cached)
      return c.json(
        {
          error: 'not_found',
          message:
            'This message is not among the recent ones the bridge holds (last 72 hours, since the last restart). Only those can be forwarded.',
        },
        404,
      );

    // A 1:1 chat must have written in the last 24 hours, like POST /api/reply. Groups this
    // account is in can always receive a forward.
    if (!isGroupJid(to)) {
      const window = replyWindow(ctx.db, await chatCandidates(sock, to));
      if (!window.open)
        return c.json(
          {
            error: 'outside_reply_window',
            message:
              'This chat has not written in the last 24 hours, so nothing can be forwarded to it',
            replyWindow: window,
          },
          409,
        );
    }

    const now = Date.now();
    const bucketKey = `${ctx.tenantId}|${to}`;
    const recent = (forwards.get(bucketKey) ?? []).filter(
      (t) => now - t < 60_000,
    );
    if (recent.length >= FORWARDS_PER_CHAT_PER_MINUTE)
      return c.json(
        {
          error: 'too_many_forwards',
          message: 'Slow down: too many forwards to this chat',
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((recent[0] + 60_000 - now) / 1000),
          ),
        },
        429,
      );
    recent.push(now);
    forwards.set(bucketKey, recent);
    if (forwards.size > 5000)
      for (const [k, v] of forwards)
        if (now - (v.at(-1) ?? 0) > 60_000) forwards.delete(k);

    try {
      const sent = await sock.sendMessage(to, { forward: cached.msg });
      if (sent) rememberMessage(sock, sent);
      return c.json({
        forwarded: true,
        chatId: to,
        messageId: sent?.key?.id ?? null,
      });
    } catch (err) {
      return c.json(
        { error: 'send_failed', message: (err as Error).message },
        502,
      );
    }
  });

  router.post('/star', zValidator('json', starSchema), async (c) => {
    const ctx = getContext(c);
    const input = c.req.valid('json');
    const target = resolveTarget(ctx, input);
    if (isFail(target))
      return c.json(
        { error: target.error, message: target.message },
        target.status,
      );
    const sock = ctx.getSocket();
    if (!sock)
      return c.json(
        { error: 'not_connected', message: 'WhatsApp not connected' },
        503,
      );
    const cached = findMessage(
      sock,
      await chatCandidates(sock, target.jid),
      target.messageId,
    );
    const fromMe =
      input.fromMe ?? cached?.msg.key.fromMe ?? !!target.scheduledId;
    try {
      await sock.chatModify(
        {
          star: {
            messages: [{ id: target.messageId, fromMe }],
            star: input.star,
          },
        },
        target.jid,
      );
    } catch (err) {
      return c.json(
        { error: 'not_changed', message: (err as Error).message },
        502,
      );
    }
    return c.json({
      starred: input.star,
      chatId: target.jid,
      messageId: target.messageId,
    });
  });

  router.post('/pin', zValidator('json', pinMessageSchema), async (c) => {
    const ctx = getContext(c);
    const input = c.req.valid('json');
    const target = resolveTarget(ctx, input);
    if (isFail(target))
      return c.json(
        { error: target.error, message: target.message },
        target.status,
      );
    const sock = ctx.getSocket();
    if (!sock)
      return c.json(
        { error: 'not_connected', message: 'WhatsApp not connected' },
        503,
      );
    const cached = findMessage(
      sock,
      await chatCandidates(sock, target.jid),
      target.messageId,
    );
    // The key must name the message exactly as WhatsApp knows it: use the remembered one.
    const key: WAMessageKey = cached?.msg.key ?? {
      remoteJid: target.jid,
      id: target.messageId,
      fromMe: input.fromMe ?? !!target.scheduledId,
      participant: input.participant
        ? (toJid(input.participant) ?? undefined)
        : undefined,
    };
    const duration = input.duration ?? '7d';
    try {
      // 1 = pin for everyone, 2 = unpin for everyone
      await sock.sendMessage(target.jid, {
        pin: key,
        type: input.pinned ? 1 : 2,
        ...(input.pinned ? { time: PIN_SECONDS[duration] } : {}),
      });
    } catch (err) {
      return c.json(
        { error: 'not_changed', message: (err as Error).message },
        502,
      );
    }
    return c.json({
      pinned: input.pinned,
      ...(input.pinned ? { duration } : {}),
      chatId: target.jid,
      messageId: target.messageId,
    });
  });

  return router;
}
