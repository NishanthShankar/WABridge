import { Hono } from 'hono';
import { getContext } from '../context.js';
import { toJid } from '../webhooks/jid.js';
import {
  deletePoll,
  getPoll,
  listPolls,
  summarisePoll,
  votesFor,
} from './polls.js';

/**
 * /api/polls: polls this account sent (with POST /api/reply), their votes, and delete.
 */
export function createPollsRouter() {
  const router = new Hono();

  /** GET /api/polls?chatId=&limit= : recent polls, newest first, with results. */
  router.get('/', (c) => {
    const { db } = getContext(c);
    const chat = c.req.query('chatId') ?? c.req.query('phone');
    const chatJid = chat ? (toJid(chat) ?? undefined) : undefined;
    const limit = Math.min(
      Math.max(Number(c.req.query('limit')) || 20, 1),
      100,
    );
    const rows = listPolls(db, { chatJid, limit });
    return c.json({
      polls: rows.map((p) => {
        const { votes: _votes, ...rest } = summarisePoll(p, votesFor(db, p.id));
        return rest;
      }),
    });
  });

  /** GET /api/polls/:id : the poll, its results and every vote received. */
  router.get('/:id', (c) => {
    const { db } = getContext(c);
    const poll = getPoll(db, c.req.param('id'));
    if (!poll)
      return c.json(
        { error: 'not_found', message: 'No poll with this id' },
        404,
      );
    return c.json(summarisePoll(poll, votesFor(db, poll.id)));
  });

  /** DELETE /api/polls/:id : delete the poll for everyone in the chat. */
  router.delete('/:id', async (c) => {
    const { db, getSocket } = getContext(c);
    const poll = getPoll(db, c.req.param('id'));
    if (!poll)
      return c.json(
        { error: 'not_found', message: 'No poll with this id' },
        404,
      );
    if (poll.deletedAt)
      return c.json({ deleted: true, deletedAt: poll.deletedAt.toISOString() });
    const sock = getSocket();
    if (!sock)
      return c.json(
        { error: 'not_connected', message: 'WhatsApp not connected' },
        503,
      );
    try {
      await deletePoll(sock, db, poll);
    } catch (err) {
      return c.json(
        { error: 'delete_failed', message: (err as Error).message },
        502,
      );
    }
    const after = getPoll(db, poll.id);
    return c.json({
      deleted: true,
      deletedAt: after?.deletedAt?.toISOString() ?? null,
    });
  });

  return router;
}
