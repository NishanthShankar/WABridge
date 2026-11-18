import { zValidator } from '@hono/zod-validator';
import type { Queue } from 'bullmq';
import { Hono } from 'hono';
import { chatCandidates, replyWindow } from '../chats/chat-state.js';
import { getContext } from '../context.js';
import { sendPoll } from '../polls/polls.js';
import {
  buildMessagePayload,
  pickSendOptions,
  reactionPayload,
  relayOptions,
} from '../scheduler/message-payload.js';
import { sendStored } from '../scheduler/send-stored.js';
import { foldRichContent } from '../scheduler/rich-content.js';
import { errorMessage } from '../net/safe-fetch.js';
import { REPLY_WINDOW_MS } from '../webhooks/chat-activity.js';
import { toJid } from '../webhooks/jid.js';
import { queueOutsideWindow } from './reply-queue.js';
import { replySchema } from './reply.schema.js';

/**
 * At most this much per chat per minute, so a loop in a receiver can't flood a chat.
 * A message (text, media or poll) weighs 1, a reaction 0.25.
 */
const PER_CHAT_PER_MINUTE = 12;
const MESSAGE_WEIGHT = 1;
const REACTION_WEIGHT = 0.25;

/**
 * POST /api/reply: answer a chat that wrote to this account in the last 24 hours.
 *
 * This is the conversational lane. It sends text and media (image, video, audio, document by
 * URL) at once (no queue, no random 2-8 s delay) and
 * does not count toward rate_limit.daily_cap, because the other side started the conversation.
 * A chat that has not written in 24 hours gets 409 outside_reply_window: use POST /api/messages,
 * which is queued and capped, or set dontSkip / forcePoll to have it queued from here.
 *
 * Answers are not stored in scheduled_messages. Message text is never logged.
 */
export function createReplyRouter(queue?: Queue) {
  const router = new Hono();
  const recent = new Map<string, Array<{ t: number; w: number }>>();

  // GET /api/reply/window?chatId=... | ?phone=... : the window without sending anything
  router.get('/window', async (c) => {
    const { db, getSocket } = getContext(c);
    const jid = toJid(c.req.query('chatId') ?? c.req.query('phone') ?? '');
    if (!jid)
      return c.json(
        { error: 'invalid_chat', message: 'chatId or phone is not valid' },
        400,
      );
    const candidates = await chatCandidates(getSocket(), jid);
    return c.json({ chatId: jid, replyWindow: replyWindow(db, candidates) });
  });

  router.post('/', zValidator('json', replySchema), async (c) => {
    const { db, getSocket, tenantId } = getContext(c);
    const input = c.req.valid('json');

    const jid = toJid(input.chatId ?? input.phone ?? '');
    if (!jid)
      return c.json(
        { error: 'invalid_chat', message: 'chatId or phone is not valid' },
        400,
      );

    // A 1:1 chat may have written from its LID or its phone JID; either opens the window.
    const candidates = await chatCandidates(getSocket(), jid);
    const window = replyWindow(db, candidates);
    if (!window.open && (input.dontSkip || input.forcePoll)) {
      const queued = await queueOutsideWindow({
        ctx: getContext(c),
        queue,
        jid,
        input,
        window,
      });
      return c.json(queued.body, queued.status);
    }
    if (!window.open) {
      return c.json(
        {
          error: 'outside_reply_window',
          message:
            'This chat has not written in the last 24 hours. Use POST /api/messages.',
          lastInboundAt: window.lastInboundAt,
          windowHours: REPLY_WINDOW_MS / 3_600_000,
          replyWindow: window,
        },
        409,
      );
    }

    const weight =
      (input.text || input.mediaUrl || input.poll ? MESSAGE_WEIGHT : 0) +
      (foldRichContent(input) ? MESSAGE_WEIGHT : 0) +
      (input.reaction ? REACTION_WEIGHT : 0);
    const bucketKey = `${tenantId}|${jid}`;
    const now = Date.now();
    const used = (recent.get(bucketKey) ?? []).filter(
      (e) => now - e.t < 60_000,
    );
    const total = used.reduce((sum, e) => sum + e.w, 0);
    if (total + weight > PER_CHAT_PER_MINUTE) {
      const oldest = used[0]?.t ?? now;
      return c.json(
        {
          error: 'too_many_replies',
          message: 'Slow down: too many answers to this chat',
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((oldest + 60_000 - now) / 1000),
          ),
          replyWindow: window,
        },
        429,
      );
    }
    used.push({ t: now, w: weight });
    recent.set(bucketKey, used);
    if (recent.size > 5000)
      for (const [k, v] of recent)
        if (now - (v.at(-1)?.t ?? 0) > 60_000) recent.delete(k);

    const sock = getSocket();
    if (!sock)
      return c.json(
        { error: 'not_connected', message: 'WhatsApp not connected' },
        503,
      );

    const result: {
      messageId: string | null;
      reactionId: string | null;
      chatId: string;
      replyWindow: typeof window;
    } = {
      messageId: null,
      reactionId: null,
      chatId: jid,
      replyWindow: window,
    };

    try {
      if (input.reaction) {
        const sent = await sock.sendMessage(
          jid,
          reactionPayload(jid, input.reaction),
        );
        result.reactionId = sent?.key?.id ?? null;
      }

      if (input.poll) {
        result.messageId = await sendPoll(sock, db, jid, input.poll);
      }

      if (input.text || input.mediaUrl) {
        const text = input.text ?? '';
        if (input.typing !== false) {
          await sock.sendPresenceUpdate('composing', jid).catch(() => {});
          const pause = Math.min(2500, 500 + text.length * 15);
          await new Promise((resolve) => setTimeout(resolve, pause));
          await sock.sendPresenceUpdate('paused', jid).catch(() => {});
        }

        const options = pickSendOptions(input) ?? {};
        const sent = await sock.sendMessage(
          jid,
          buildMessagePayload(text, input.mediaUrl, input.mediaType, options),
          relayOptions(jid, options),
        );
        result.messageId = sent?.key?.id ?? null;
      }

      const rich = foldRichContent(input);
      if (rich) result.messageId = await sendStored(sock, db, jid, rich);
    } catch (err) {
      return c.json(
        { error: 'send_failed', message: errorMessage(err), ...result },
        502,
      );
    }

    return c.json(result);
  });

  return router;
}
