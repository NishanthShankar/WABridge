import { zValidator } from '@hono/zod-validator';
import type { WAMessage } from '@whiskeysockets/baileys';
import { Hono } from 'hono';
import { getContext } from '../context.js';
import { sendPoll } from '../polls/polls.js';
import { buildMessagePayload } from '../scheduler/message-payload.js';
import {
  REPLY_WINDOW_MS,
  insideReplyWindow,
  lastInbound,
} from '../webhooks/chat-activity.js';
import { isGroupJid, jidToPhone, toJid } from '../webhooks/jid.js';
import { replySchema } from './reply.schema.js';

/** At most this many answers per chat per minute, so a loop in a receiver can't flood a chat. */
const PER_CHAT_PER_MINUTE = 12;

/**
 * POST /api/reply: answer a chat that wrote to this account in the last 24 hours.
 *
 * This is the conversational lane. It sends text and media (image, video, audio, document by
 * URL) at once (no queue, no random 2-8 s delay) and
 * does not count toward rate_limit.daily_cap, because the other side started the conversation.
 * A chat that has not written in 24 hours gets 409 outside_reply_window: use POST /api/messages,
 * which is queued and capped.
 *
 * Answers are not stored in scheduled_messages. Message text is never logged.
 */
export function createReplyRouter() {
  const router = new Hono();
  const recent = new Map<string, number[]>();

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
    const candidates = [jid];
    if (!isGroupJid(jid) && jid.endsWith('@s.whatsapp.net')) {
      const sock = getSocket();
      const lid = await sock?.signalRepository.lidMapping
        .getLIDForPN(jid)
        .catch(() => null);
      if (lid) candidates.push(`${jidToPhone(lid)}@lid`);
    }
    if (!insideReplyWindow(db, candidates)) {
      const last = lastInbound(db, candidates);
      return c.json(
        {
          error: 'outside_reply_window',
          message:
            'This chat has not written in the last 24 hours. Use POST /api/messages.',
          lastInboundAt: last?.toISOString() ?? null,
          windowHours: REPLY_WINDOW_MS / 3_600_000,
        },
        409,
      );
    }

    const bucketKey = `${tenantId}|${jid}`;
    const now = Date.now();
    const times = (recent.get(bucketKey) ?? []).filter((t) => now - t < 60_000);
    if (times.length >= PER_CHAT_PER_MINUTE) {
      return c.json(
        {
          error: 'too_many_replies',
          message: 'Slow down: too many answers to this chat',
        },
        429,
      );
    }
    times.push(now);
    recent.set(bucketKey, times);
    if (recent.size > 5000)
      for (const [k, v] of recent)
        if (now - (v.at(-1) ?? 0) > 60_000) recent.delete(k);

    const sock = getSocket();
    if (!sock)
      return c.json(
        { error: 'not_connected', message: 'WhatsApp not connected' },
        503,
      );

    const participantJid = (p?: string) =>
      p ? (toJid(p) ?? undefined) : undefined;
    const result: {
      messageId: string | null;
      reactionId: string | null;
      chatId: string;
    } = {
      messageId: null,
      reactionId: null,
      chatId: jid,
    };

    try {
      if (input.reaction) {
        const r = input.reaction;
        const sent = await sock.sendMessage(jid, {
          react: {
            text: r.emoji,
            key: {
              remoteJid: jid,
              id: r.messageId,
              fromMe: !!r.fromMe,
              participant: participantJid(r.participant),
            },
          },
        });
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

        let quoted: WAMessage | undefined;
        if (input.quote) {
          const q = input.quote;
          quoted = {
            key: {
              remoteJid: jid,
              id: q.messageId,
              fromMe: !!q.fromMe,
              participant: participantJid(q.participant),
            },
            message: { conversation: q.text ?? '' },
          };
        }

        const mentions = (input.mentions ?? [])
          .map((m) => toJid(m))
          .filter((m): m is string => !!m);
        const content = buildMessagePayload(
          text,
          input.mediaUrl,
          input.mediaType,
        );
        const sent = await sock.sendMessage(
          jid,
          mentions.length
            ? ({ ...content, mentions } as typeof content)
            : content,
          quoted ? { quoted } : undefined,
        );
        result.messageId = sent?.key?.id ?? null;
      }
    } catch (err) {
      return c.json(
        { error: 'send_failed', message: (err as Error).message, ...result },
        502,
      );
    }

    return c.json(result);
  });

  return router;
}
