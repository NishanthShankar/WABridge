import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { ReplyWindow } from '../chats/chat-state.js';
import type { AppContext } from '../context.js';
import { groups } from '../db/schema.js';
import { createSchedulingService } from '../scheduling/scheduling.service.js';
import { isGroupJid, jidToPhone } from '../webhooks/jid.js';
import type { ReplyInput } from './reply.schema.js';
import { foldRichContent } from '../scheduler/rich-content.js';

/** A poll written out as text, for dontSkip to a chat that has never written to this account. */
export function pollAsText(poll: {
  name: string;
  options: string[];
  multiple?: boolean;
}): string {
  const lines = poll.options.map((o, i) => `${i + 1}. ${o}`);
  const ask = poll.multiple
    ? 'Reply with the numbers of your choices.'
    : 'Reply with the number of your choice.';
  return `${poll.name}\n\n${lines.join('\n')}\n\n${ask}`;
}

type Result =
  | { status: 202; body: Record<string, unknown> }
  | { status: 400 | 403 | 409 | 429 | 503; body: Record<string, unknown> };

/**
 * dontSkip / forcePoll: a chat outside the 24 hour window gets this through the queued route
 * (POST /api/messages): random 2-8 s delay, counted toward the daily cap.
 */
export async function queueOutsideWindow(params: {
  ctx: AppContext;
  queue: Queue | undefined;
  jid: string;
  input: ReplyInput;
  window: ReplyWindow;
}): Promise<Result> {
  const { ctx, queue, jid, input, window } = params;
  if (!queue)
    return {
      status: 503,
      body: {
        error: 'queue_unavailable',
        message: 'The message queue is not available',
        replyWindow: window,
      },
    };

  // A queued message carries one thing: a location or contact card wins over text.
  const dropped: string[] = (['reaction', 'quote', 'mentions'] as const).filter(
    (k) => input[k] !== undefined,
  );
  if ((input.location || input.contact) && input.text) dropped.push('text');
  if (!input.text && !input.mediaUrl && !input.poll && !input.location && !input.contact)
    return {
      status: 409,
      body: {
        error: 'outside_reply_window',
        message:
          'A reaction alone cannot be queued: this chat has not written in the last 24 hours.',
        replyWindow: window,
      },
    };

  if (input.poll && input.forcePoll && !window.lastInboundAt)
    return {
      status: 403,
      body: {
        error: 'force_poll_not_allowed',
        message:
          'forcePoll only works for chats that have written to this account before. Use dontSkip to send it as text.',
        replyWindow: window,
      },
    };

  // Where the queue should send it
  let phone: string | undefined;
  let groupId: string | undefined;
  if (isGroupJid(jid)) {
    if (!ctx.db.select().from(groups).where(eq(groups.id, jid)).get())
      return {
        status: 409,
        body: {
          error: 'group_not_synced',
          message:
            'This group is not in the local list yet: call POST /api/groups/sync first.',
          replyWindow: window,
        },
      };
    groupId = jid;
  } else {
    let pn = jid;
    if (jid.endsWith('@lid')) {
      const mapped = await ctx
        .getSocket()
        ?.signalRepository.lidMapping.getPNForLID(jid)
        .catch(() => null);
      if (!mapped)
        return {
          status: 400,
          body: {
            error: 'cannot_queue',
            message:
              'This chat is a LID with no known phone number; the queue needs a phone number.',
            replyWindow: window,
          },
        };
      pn = mapped;
    }
    phone = jidToPhone(pn);
  }

  let content = input.text ?? '';
  let mediaUrl = input.mediaUrl;
  let mediaType: string | undefined = input.mediaType;
  let sentAs: 'text' | 'media' | 'poll' | 'pollAsText' = mediaUrl
    ? 'media'
    : 'text';
  const rich = foldRichContent(input);
  if (rich) {
    content = rich.content;
    mediaType = rich.mediaType;
    mediaUrl = undefined;
    sentAs = 'media';
  }
  if (input.poll) {
    // A chat that has written to this account before gets the real poll, with dontSkip too.
    if (input.forcePoll || window.lastInboundAt) {
      content = JSON.stringify(input.poll);
      mediaType = 'poll';
      mediaUrl = undefined;
      sentAs = 'poll';
    } else {
      content = pollAsText(input.poll);
      sentAs = 'pollAsText';
    }
  }

  const service = createSchedulingService(
    ctx.db,
    queue,
    ctx.config,
    ctx.rateLimiter,
    ctx.tenantId,
  );
  try {
    const msg = await service.scheduleMessage(
      undefined,
      content,
      undefined,
      phone,
      undefined,
      mediaUrl,
      mediaType,
      groupId,
    );
    return {
      status: 202,
      body: {
        queued: true,
        messageId: null,
        scheduledMessageId: msg.id,
        chatId: jid,
        sentAs,
        dropped,
        replyWindow: window,
        rateLimit: msg.rateLimit,
      },
    };
  } catch (err) {
    const e = err as Error & { statusCode?: number };
    if (e.statusCode === 429)
      return {
        status: 429,
        body: {
          error: 'daily_cap_reached',
          message: e.message,
          replyWindow: window,
        },
      };
    return {
      status: 400,
      body: { error: 'cannot_queue', message: e.message, replyWindow: window },
    };
  }
}
