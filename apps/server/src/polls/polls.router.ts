import type { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { type AppContext, getContext } from '../context.js';
import { polls, scheduledMessages } from '../db/schema.js';
import { createSchedulingService } from '../scheduling/scheduling.service.js';
import { toJid } from '../webhooks/jid.js';
import {
  deletePoll,
  getPoll,
  listPolls,
  summarisePoll,
  votesFor,
} from './polls.js';
import { ackVote, pendingVotes } from './stealth-inbox.js';

type Found =
  | { kind: 'poll'; poll: NonNullable<ReturnType<typeof getPoll>> }
  | { kind: 'queued'; scheduledMessageId: string; status: string }
  | { kind: 'none' };

/**
 * :id may be the poll's WhatsApp id, or the scheduledMessageId a queued poll (dontSkip /
 * forcePoll) returned.
 */
function findPoll(ctx: AppContext, id: string): Found {
  const direct = getPoll(ctx.db, id);
  if (direct) return { kind: 'poll', poll: direct };
  const queued = ctx.db
    .select()
    .from(scheduledMessages)
    .where(
      and(
        eq(scheduledMessages.id, id),
        eq(scheduledMessages.mediaType, 'poll'),
      ),
    )
    .get();
  if (!queued) return { kind: 'none' };
  const sent = queued.whatsappMessageId
    ? getPoll(ctx.db, queued.whatsappMessageId)
    : undefined;
  if (sent) return { kind: 'poll', poll: sent };
  return {
    kind: 'queued',
    scheduledMessageId: queued.id,
    status: queued.status,
  };
}

const notFound = {
  error: 'not_found',
  message: 'No poll with this id or scheduledMessageId',
};

/**
 * /api/polls: polls this account sent (with POST /api/reply), their votes, and delete.
 */
export function createPollsRouter(queue?: Queue) {
  const router = new Hono();

  /** GET /api/polls?chatId=&ref=&limit= : recent polls, newest first, with results. */
  router.get('/', (c) => {
    const { db } = getContext(c);
    const chat = c.req.query('chatId') ?? c.req.query('phone');
    const chatJid = chat ? (toJid(chat) ?? undefined) : undefined;
    const limit = Math.min(
      Math.max(Number(c.req.query('limit')) || 20, 1),
      100,
    );
    const rows = listPolls(db, { chatJid, ref: c.req.query('ref'), limit });
    return c.json({
      polls: rows.map((p) => {
        const { votes: _votes, ...rest } = summarisePoll(p, votesFor(db, p.id));
        return rest;
      }),
    });
  });

  /**
   * GET /api/polls/pending?pollId= : stealth votes not yet acknowledged (memory only, at most
   * an hour). A webhook that answered 2xx already acknowledged its vote.
   */
  router.get('/pending', (c) => {
    const { db } = getContext(c);
    return c.json({ votes: pendingVotes(db, c.req.query('pollId')) });
  });

  /** POST /api/polls/pending/ack {voteIds} : forget these stealth votes now. */
  router.post('/pending/ack', async (c) => {
    const { db } = getContext(c);
    const body = (await c.req.json().catch(() => null)) as {
      voteIds?: unknown;
    } | null;
    const ids = Array.isArray(body?.voteIds)
      ? body.voteIds.filter((v): v is string => typeof v === 'string')
      : [];
    if (!ids.length || ids.length > 500)
      return c.json(
        { error: 'invalid_body', message: 'Give voteIds: 1 to 500 vote ids' },
        400,
      );
    const acked = ids.filter((id) => ackVote(db, id));
    return c.json({ acked: acked.length, unknown: ids.length - acked.length });
  });

  /** GET /api/polls/:id : the poll, its results and every vote received. */
  router.get('/:id', (c) => {
    const ctx = getContext(c);
    const found = findPoll(ctx, c.req.param('id'));
    if (found.kind === 'none') return c.json(notFound, 404);
    if (found.kind === 'queued')
      return c.json(
        {
          error: 'not_sent_yet',
          message: 'This poll is still in the queue (or was never sent)',
          scheduledMessageId: found.scheduledMessageId,
          status: found.status,
        },
        409,
      );
    return c.json(summarisePoll(found.poll, votesFor(ctx.db, found.poll.id)));
  });

  /**
   * DELETE /api/polls/:id : delete the poll for everyone in the chat. A queued poll that has
   * not gone out yet is cancelled instead.
   */
  router.delete('/:id', async (c) => {
    const ctx = getContext(c);
    const found = findPoll(ctx, c.req.param('id'));
    if (found.kind === 'none') return c.json(notFound, 404);
    if (found.kind === 'queued') {
      if (found.status !== 'pending' || !queue)
        return c.json(
          {
            error: 'not_sent',
            message: `This queued poll was not sent (status: ${found.status})`,
            scheduledMessageId: found.scheduledMessageId,
            status: found.status,
          },
          409,
        );
      const service = createSchedulingService(
        ctx.db,
        queue,
        ctx.config,
        ctx.rateLimiter,
        ctx.tenantId,
      );
      const cancelled = await service.cancelMessage(found.scheduledMessageId);
      return c.json({
        deleted: false,
        cancelled: !!cancelled,
        scheduledMessageId: found.scheduledMessageId,
      });
    }
    const { poll } = found;
    if (poll.deletedAt)
      return c.json({
        deleted: true,
        pollId: poll.id,
        deletedAt: poll.deletedAt.toISOString(),
      });
    const sock = ctx.getSocket();
    if (!sock)
      return c.json(
        { error: 'not_connected', message: 'WhatsApp not connected' },
        503,
      );
    try {
      await deletePoll(sock, ctx.db, poll);
    } catch (err) {
      return c.json(
        { error: 'delete_failed', message: (err as Error).message },
        502,
      );
    }
    const after = getPoll(ctx.db, poll.id);
    return c.json({
      deleted: true,
      pollId: poll.id,
      deletedAt: after?.deletedAt?.toISOString() ?? null,
    });
  });

  return router;
}
